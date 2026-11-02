// 〔issue #5 / D29〕订阅套餐降级注入（hook 入口级，bundle 真进程）：
// 套餐 Lead → SessionStart 与首次 UserPromptSubmit 注入 DEGRADED_SOLO_NOTE（每会话一次，
// lead state soloNotifiedAt 锚去重）；第三方/空库 → 不注；off 档 → 整体无输出；
// UPS 与收件箱合并为一次 additionalContext。db 夹具 = kit.createTestDb + 提交快照。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { DEGRADED_SOLO_NOTE } from "../../src/mcp/policy.js";
import { teamPaths } from "../../src/coord/paths.js";
import { readLeadState } from "../../src/provider/lead-wake.js";
import { createTestDb, insertSubmissionMessage } from "../provider/kit.js";

const PLAN = "account:bigmodel-individual-coding-plan";

let dir: string;
let dbPlan: string;
let dbThird: string;
let hookBundle: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-d29-hook-"));
  dbPlan = path.join(dir, "plan.sqlite");
  dbThird = path.join(dir, "third.sqlite");
  createTestDb(dbPlan);
  createTestDb(dbThird);
  insertSubmissionMessage(dbPlan, { sessionId: "sess_d29_ss", providerId: PLAN, modelId: "GLM-5.3", timeCreated: 1_000 });
  insertSubmissionMessage(dbPlan, { sessionId: "sess_d29_ups", providerId: PLAN, modelId: "GLM-5.3", timeCreated: 1_000 });
  insertSubmissionMessage(dbThird, { sessionId: "sess_d29_third", providerId: "deepseek", modelId: "flash", timeCreated: 1_000 });
  hookBundle = path.join(dir, "team-hooks.mjs");
  await build({
    entryPoints: [path.resolve(import.meta.dirname, "../../src/hooks.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: hookBundle,
    logLevel: "silent",
  });
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function runHook(input: Record<string, unknown>, env: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["--", hookBundle],
      { env: { ...process.env, ...env }, maxBuffer: 4 * 1024 * 1024 },
      () => undefined,
    );
    let out = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (c: string) => (out += c));
    child.on("close", () => resolve(out));
    child.stdin!.write(JSON.stringify(input));
    child.stdin!.end();
  });
}

function ctxOf(stdout: string): string {
  return (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
}

describe("〔D29〕订阅套餐降级注入", () => {
  it("SessionStart（套餐）→ 注入 DEGRADED_SOLO_NOTE 并写 soloNotifiedAt 锚", async () => {
    const dataRoot = path.join(dir, "ss-data");
    const out = await runHook(
      { hook_event_name: "SessionStart", session_id: "sess_d29_ss", source: "startup", cwd: dir },
      { TEAM_PLUGIN_DATA: dataRoot, ZCODE_SESSION_ID: "sess_d29_ss", TEAM_DB_PATH: dbPlan },
    );
    expect(ctxOf(out)).toContain(DEGRADED_SOLO_NOTE);
    const state = readLeadState(teamPaths(dataRoot, "sess_d29_ss").teamDir);
    expect(state?.soloNotifiedAt).toBeDefined();
  });

  it("SessionStart 第二次（同会话）→ 不再注入（去重）", async () => {
    const out = await runHook(
      { hook_event_name: "SessionStart", session_id: "sess_d29_ss", source: "resume", cwd: dir },
      { TEAM_PLUGIN_DATA: path.join(dir, "ss-data"), ZCODE_SESSION_ID: "sess_d29_ss", TEAM_DB_PATH: dbPlan },
    );
    expect(ctxOf(out)).not.toContain("Teammates unavailable");
  });

  it("UserPromptSubmit 首次（套餐，无 pending）→ 单发注入 + 写锚；第二次 → 完全不输出", async () => {
    const dataRoot = path.join(dir, "ups-data");
    const out1 = await runHook(
      { hook_event_name: "UserPromptSubmit", session_id: "sess_d29_ups", prompt: "hi", cwd: dir },
      { TEAM_PLUGIN_DATA: dataRoot, ZCODE_SESSION_ID: "sess_d29_ups", TEAM_DB_PATH: dbPlan },
    );
    expect(ctxOf(out1)).toContain(DEGRADED_SOLO_NOTE);
    expect(readLeadState(teamPaths(dataRoot, "sess_d29_ups").teamDir)?.soloNotifiedAt).toBeDefined();

    const out2 = await runHook(
      { hook_event_name: "UserPromptSubmit", session_id: "sess_d29_ups", prompt: "again", cwd: dir },
      { TEAM_PLUGIN_DATA: dataRoot, ZCODE_SESSION_ID: "sess_d29_ups", TEAM_DB_PATH: dbPlan },
    );
    expect(out2.trim()).toBe(""); // 无 pending 且已通知 → 不输出任何 hook JSON
  });

  it("UserPromptSubmit（套餐 + 待收消息）→ 与收件箱合并为一次 additionalContext", async () => {
    const sid = "sess_d29_mix";
    insertSubmissionMessage(dbPlan, { sessionId: sid, providerId: PLAN, modelId: "GLM-5.3", timeCreated: 2_000 });
    const dataRoot = path.join(dir, "mix-data");
    const teamDir = teamPaths(dataRoot, sid).teamDir;
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, "events.jsonl"),
      JSON.stringify({
        seq: 1,
        ts: "2026-11-02T00:00:00.000Z",
        writer: "test",
        event: {
          type: "team/message/queued",
          version: 2,
          teamId: sid,
          message: { id: "m1", senderId: "sess-beta", senderName: "alpha", targetId: sid, content: [{ type: "text", text: "mix-body" }] },
        },
      }) + "\n",
    );
    const out = await runHook(
      { hook_event_name: "UserPromptSubmit", session_id: sid, prompt: "hi", cwd: dir },
      { TEAM_PLUGIN_DATA: dataRoot, ZCODE_SESSION_ID: sid, TEAM_DB_PATH: dbPlan },
    );
    const ctx = ctxOf(out);
    expect(ctx).toContain(DEGRADED_SOLO_NOTE);
    expect(ctx).toContain("[agent-team inbox]");
    expect(ctx.indexOf(DEGRADED_SOLO_NOTE)).toBeLessThan(ctx.indexOf("[agent-team inbox]")); // 降级行在前
  });

  it("第三方模型 → 不注入", async () => {
    const out = await runHook(
      { hook_event_name: "SessionStart", session_id: "sess_d29_third", source: "startup", cwd: dir },
      { TEAM_PLUGIN_DATA: path.join(dir, "third-data"), ZCODE_SESSION_ID: "sess_d29_third", TEAM_DB_PATH: dbThird },
    );
    expect(ctxOf(out)).not.toContain("Teammates unavailable");
  });

  it("off 档（套餐）→ 整体无输出（降级行同停）", async () => {
    const out = await runHook(
      { hook_event_name: "SessionStart", session_id: "sess_d29_ss", source: "startup", cwd: dir },
      {
        TEAM_PLUGIN_DATA: path.join(dir, "off-data"),
        ZCODE_SESSION_ID: "sess_d29_ss",
        TEAM_DB_PATH: dbPlan,
        TEAM_LEAD_MODE: "off",
      },
    );
    expect(out.trim()).toBe("");
  });

  it("db 不存在的会话（三源全空）→ 乐观不注（回归保护：不影响既有定版断言）", async () => {
    const out = await runHook(
      { hook_event_name: "SessionStart", session_id: "sess_d29_nobody", source: "startup", cwd: dir },
      { TEAM_PLUGIN_DATA: path.join(dir, "nobody-data"), ZCODE_SESSION_ID: "sess_d29_nobody", TEAM_DB_PATH: dbThird },
    );
    expect(ctxOf(out)).not.toContain("Teammates unavailable");
  });
});
