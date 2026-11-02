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
import { DEGRADED_SOLO_NOTE, SOLO_RETRACT_NOTE } from "../../src/mcp/policy.js";
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

function runHook(input: Record<string, unknown>, env: Record<string, string>): Promise<{ out: string; code: number }> {
  return new Promise((resolve) => {
    // 净化继承环境：本进程可能身处 teammate 会话（TEAM_SPAWN_IDENTITY/TEAM_LEAD_MODE 会改判角色）。
    const base = { ...process.env };
    delete base.TEAM_SPAWN_IDENTITY;
    delete base.TEAM_LEAD_MODE;
    const child = execFile(
      process.execPath,
      ["--", hookBundle],
      { env: { ...base, ...env }, maxBuffer: 4 * 1024 * 1024 },
      () => undefined,
    );
    let out = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (c: string) => (out += c));
    child.on("close", (code) => resolve({ out, code: code ?? -1 }));
    child.stdin!.write(JSON.stringify(input));
    child.stdin!.end();
  });
}

/** 零输出断言必须同时确认进程正常退出（否则崩溃 = 空 stdout 也算「无输出」）。 */
async function runHookOk(input: Record<string, unknown>, env: Record<string, string>): Promise<string> {
  const r = await runHook(input, env);
  expect(r.code).toBe(0);
  return r.out;
}

function ctxOf(stdout: string): string {
  return (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
}

describe("〔D29〕订阅套餐降级注入", () => {
  it("SessionStart（套餐）→ 注入 DEGRADED_SOLO_NOTE 并写 soloNotifiedAt 锚", async () => {
    const dataRoot = path.join(dir, "ss-data");
    const out = await runHookOk(
      { hook_event_name: "SessionStart", session_id: "sess_d29_ss", source: "startup", cwd: dir },
      { TEAM_PLUGIN_DATA: dataRoot, ZCODE_SESSION_ID: "sess_d29_ss", TEAM_DB_PATH: dbPlan },
    );
    expect(ctxOf(out)).toContain(DEGRADED_SOLO_NOTE);
    const state = readLeadState(teamPaths(dataRoot, "sess_d29_ss").teamDir);
    expect(state?.soloNotifiedAt).toBeDefined();
  });

  it("SessionStart 第二次（同会话）→ 不再注入（去重）", async () => {
    const out = await runHookOk(
      { hook_event_name: "SessionStart", session_id: "sess_d29_ss", source: "resume", cwd: dir },
      { TEAM_PLUGIN_DATA: path.join(dir, "ss-data"), ZCODE_SESSION_ID: "sess_d29_ss", TEAM_DB_PATH: dbPlan },
    );
    expect(ctxOf(out)).not.toContain(DEGRADED_SOLO_NOTE);
  });

  it("UserPromptSubmit 首次（套餐，无 pending）→ 单发注入 + 写锚；第二次 → 完全不输出", async () => {
    const dataRoot = path.join(dir, "ups-data");
    const out1 = await runHookOk(
      { hook_event_name: "UserPromptSubmit", session_id: "sess_d29_ups", prompt: "hi", cwd: dir },
      { TEAM_PLUGIN_DATA: dataRoot, ZCODE_SESSION_ID: "sess_d29_ups", TEAM_DB_PATH: dbPlan },
    );
    expect(ctxOf(out1)).toContain(DEGRADED_SOLO_NOTE);
    expect(readLeadState(teamPaths(dataRoot, "sess_d29_ups").teamDir)?.soloNotifiedAt).toBeDefined();

    const out2 = await runHookOk(
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
    const out = await runHookOk(
      { hook_event_name: "UserPromptSubmit", session_id: sid, prompt: "hi", cwd: dir },
      { TEAM_PLUGIN_DATA: dataRoot, ZCODE_SESSION_ID: sid, TEAM_DB_PATH: dbPlan },
    );
    const ctx = ctxOf(out);
    expect(ctx).toContain(DEGRADED_SOLO_NOTE);
    expect(ctx).toContain("[agent-team inbox]");
    expect(ctx.indexOf(DEGRADED_SOLO_NOTE)).toBeLessThan(ctx.indexOf("[agent-team inbox]")); // 降级行在前
  });

  it("第三方模型 → 不注入", async () => {
    const out = await runHookOk(
      { hook_event_name: "SessionStart", session_id: "sess_d29_third", source: "startup", cwd: dir },
      { TEAM_PLUGIN_DATA: path.join(dir, "third-data"), ZCODE_SESSION_ID: "sess_d29_third", TEAM_DB_PATH: dbThird },
    );
    expect(ctxOf(out)).not.toContain(DEGRADED_SOLO_NOTE);
  });

  it("off 档（套餐）→ 整体无输出（降级行同停）", async () => {
    const out = await runHookOk(
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
    const out = await runHookOk(
      { hook_event_name: "SessionStart", session_id: "sess_d29_nobody", source: "startup", cwd: dir },
      { TEAM_PLUGIN_DATA: path.join(dir, "nobody-data"), ZCODE_SESSION_ID: "sess_d29_nobody", TEAM_DB_PATH: dbThird },
    );
    expect(ctxOf(out)).not.toContain(DEGRADED_SOLO_NOTE);
  });

  // ——〔D30〕startup hint 路径 + 对账/撤回 ——
  const HINT_PLAN = `${PLAN}/GLM-5.3`;

  it("〔D30〕startup+model 提示（套餐）+ 三源空库 → 注入并写锚（via=hint，缺口闭环）", async () => {
    const sid = "sess_d30_hintstart";
    const dataRoot = path.join(dir, "hintstart-data");
    const out = await runHookOk(
      { hook_event_name: "SessionStart", session_id: sid, source: "startup", cwd: dir, model: HINT_PLAN },
      { TEAM_PLUGIN_DATA: dataRoot, ZCODE_SESSION_ID: sid, TEAM_DB_PATH: dbThird }, // dbThird 对该会话无记录
    );
    expect(ctxOf(out)).toContain(DEGRADED_SOLO_NOTE);
    const state = readLeadState(teamPaths(dataRoot, sid).teamDir);
    expect(state?.soloNotifiedAt).toBeDefined();
    expect(state?.soloNotifiedVia).toBe("hint");
    expect(state?.soloRetractedAt).toBeUndefined();
  });

  it("〔D30〕hint 误报（startup 套餐 → 首条消息前切第三方）→ UPS 对账一次性撤回", async () => {
    const sid = "sess_d30_retract";
    const dataRoot = path.join(dir, "retract-data");
    const ss = await runHookOk(
      { hook_event_name: "SessionStart", session_id: sid, source: "startup", cwd: dir, model: HINT_PLAN },
      { TEAM_PLUGIN_DATA: dataRoot, ZCODE_SESSION_ID: sid, TEAM_DB_PATH: dbPlan }, // dbPlan 对该会话无记录
    );
    expect(ctxOf(ss)).toContain(DEGRADED_SOLO_NOTE);
    insertSubmissionMessage(dbPlan, { sessionId: sid, providerId: "custom:98331807", modelId: "deepseek-flash", timeCreated: 3_000 });
    const ups1 = await runHookOk(
      { hook_event_name: "UserPromptSubmit", session_id: sid, prompt: "hi", cwd: dir },
      { TEAM_PLUGIN_DATA: dataRoot, ZCODE_SESSION_ID: sid, TEAM_DB_PATH: dbPlan },
    );
    const ctx = ctxOf(ups1);
    expect(ctx).toContain(SOLO_RETRACT_NOTE);
    expect(ctx).not.toContain(DEGRADED_SOLO_NOTE);
    const state = readLeadState(teamPaths(dataRoot, sid).teamDir);
    expect(state?.soloRetractedAt).toBeDefined();
    expect(state?.soloNotifiedAt).toBeDefined(); // 撤回不清除通知锚
    const ups2 = await runHookOk(
      { hook_event_name: "UserPromptSubmit", session_id: sid, prompt: "again", cwd: dir },
      { TEAM_PLUGIN_DATA: dataRoot, ZCODE_SESSION_ID: sid, TEAM_DB_PATH: dbPlan },
    );
    expect(ups2.trim()).toBe(""); // 撤回恰一次
  });

  it("〔D30〕hint 正确（db 后续确认套餐）→ UPS 对账不撤回、零输出", async () => {
    const sid = "sess_d30_confirm";
    const dataRoot = path.join(dir, "confirm-data");
    await runHookOk(
      { hook_event_name: "SessionStart", session_id: sid, source: "startup", cwd: dir, model: HINT_PLAN },
      { TEAM_PLUGIN_DATA: dataRoot, ZCODE_SESSION_ID: sid, TEAM_DB_PATH: dbPlan },
    );
    insertSubmissionMessage(dbPlan, { sessionId: sid, providerId: PLAN, modelId: "GLM-5.3", timeCreated: 3_000 });
    const ups = await runHookOk(
      { hook_event_name: "UserPromptSubmit", session_id: sid, prompt: "hi", cwd: dir },
      { TEAM_PLUGIN_DATA: dataRoot, ZCODE_SESSION_ID: sid, TEAM_DB_PATH: dbPlan },
    );
    expect(ups.trim()).toBe("");
    const state = readLeadState(teamPaths(dataRoot, sid).teamDir);
    expect(state?.soloRetractedAt).toBeUndefined();
  });

  it("〔D30〕已通知未撤回 + 三源仍空 → 不撤回不输出（evidence=none 等待下一轮）", async () => {
    const sid = "sess_d30_wait";
    const dataRoot = path.join(dir, "wait-data");
    await runHookOk(
      { hook_event_name: "SessionStart", session_id: sid, source: "startup", cwd: dir, model: HINT_PLAN },
      { TEAM_PLUGIN_DATA: dataRoot, ZCODE_SESSION_ID: sid, TEAM_DB_PATH: dbPlan },
    );
    const ups = await runHookOk(
      { hook_event_name: "UserPromptSubmit", session_id: sid, prompt: "hi", cwd: dir },
      { TEAM_PLUGIN_DATA: dataRoot, ZCODE_SESSION_ID: sid, TEAM_DB_PATH: dbPlan }, // 该会话仍无记录
    );
    expect(ups.trim()).toBe("");
    expect(readLeadState(teamPaths(dataRoot, sid).teamDir)?.soloRetractedAt).toBeUndefined();
  });

  it("〔D30〕已通知未撤回 + resume 载荷 hint 已切第三方 → SessionStart 即撤回（且不重复注入兜底行）", async () => {
    const sid = "sess_d30_ssretract";
    const dataRoot = path.join(dir, "ssretract-data");
    await runHookOk(
      { hook_event_name: "SessionStart", session_id: sid, source: "startup", cwd: dir, model: HINT_PLAN },
      { TEAM_PLUGIN_DATA: dataRoot, ZCODE_SESSION_ID: sid, TEAM_DB_PATH: dbPlan },
    );
    const resume = await runHookOk(
      { hook_event_name: "SessionStart", session_id: sid, source: "resume", cwd: dir, model: "custom:98331807/deepseek-flash" },
      { TEAM_PLUGIN_DATA: dataRoot, ZCODE_SESSION_ID: sid, TEAM_DB_PATH: dbPlan },
    );
    const ctx = ctxOf(resume);
    expect(ctx).toContain(SOLO_RETRACT_NOTE);
    expect(ctx).not.toContain(DEGRADED_SOLO_NOTE); // 同一次输出不得出现矛盾两行
    expect(readLeadState(teamPaths(dataRoot, sid).teamDir)?.soloRetractedAt).toBeDefined();
    // 撤回后再 resume → 不再撤回（at most once）
    const again = await runHookOk(
      { hook_event_name: "SessionStart", session_id: sid, source: "resume", cwd: dir, model: "custom:98331807/deepseek-flash" },
      { TEAM_PLUGIN_DATA: dataRoot, ZCODE_SESSION_ID: sid, TEAM_DB_PATH: dbPlan },
    );
    expect(ctxOf(again)).not.toContain(SOLO_RETRACT_NOTE);
  });

  it("〔D30〕老宿主（无 model 字段）resume：db 已切第三方 → 同样撤回（不依赖 hint）", async () => {
    const sid = "sess_d30_oldhost";
    const dataRoot = path.join(dir, "oldhost-data");
    // startup 用 hint 造出已通知状态，随后模拟老宿主：后续 SessionStart 不带 model
    await runHookOk(
      { hook_event_name: "SessionStart", session_id: sid, source: "startup", cwd: dir, model: HINT_PLAN },
      { TEAM_PLUGIN_DATA: dataRoot, ZCODE_SESSION_ID: sid, TEAM_DB_PATH: dbPlan },
    );
    insertSubmissionMessage(dbPlan, { sessionId: sid, providerId: "custom:98331807", modelId: "deepseek-flash", timeCreated: 4_000 });
    const resume = await runHookOk(
      { hook_event_name: "SessionStart", session_id: sid, source: "resume", cwd: dir },
      { TEAM_PLUGIN_DATA: dataRoot, ZCODE_SESSION_ID: sid, TEAM_DB_PATH: dbPlan },
    );
    expect(ctxOf(resume)).toContain(SOLO_RETRACT_NOTE);
    expect(readLeadState(teamPaths(dataRoot, sid).teamDir)?.soloRetractedAt).toBeDefined();
  });

  it("〔D30〕旧状态只有 soloNotifiedAt（无 via）：第三方 hint → 撤回恰一次；套餐 hint → 不重注不撤回", async () => {
    const legacy = (sid: string, providerId: string, modelId: string): string => {
      const dataRoot = path.join(dir, `legacy-${sid}`);
      const teamDir = teamPaths(dataRoot, sid).teamDir;
      fs.mkdirSync(path.join(teamDir, "lead"), { recursive: true });
      fs.writeFileSync(
        path.join(teamDir, "lead", "state.json"),
        JSON.stringify({ active: false, updatedAt: "2026-11-02T00:00:00.000Z", soloNotifiedAt: "2026-11-02T00:00:00.000Z" }),
      );
      return dataRoot;
    };
    const thirdRoot = legacy("sess_d30_legacy_third", "custom:x", "y");
    const third = await runHookOk(
      { hook_event_name: "SessionStart", session_id: "sess_d30_legacy_third", source: "resume", cwd: dir, model: "custom:98331807/deepseek-flash" },
      { TEAM_PLUGIN_DATA: thirdRoot, ZCODE_SESSION_ID: "sess_d30_legacy_third", TEAM_DB_PATH: dbPlan },
    );
    expect(ctxOf(third)).toContain(SOLO_RETRACT_NOTE);
    expect(readLeadState(teamPaths(thirdRoot, "sess_d30_legacy_third").teamDir)?.soloRetractedAt).toBeDefined();

    const planRoot = legacy("sess_d30_legacy_plan", PLAN, "GLM-5.3");
    const plan = await runHookOk(
      { hook_event_name: "SessionStart", session_id: "sess_d30_legacy_plan", source: "resume", cwd: dir, model: HINT_PLAN },
      { TEAM_PLUGIN_DATA: planRoot, ZCODE_SESSION_ID: "sess_d30_legacy_plan", TEAM_DB_PATH: dbPlan },
    );
    expect(ctxOf(plan)).not.toContain(DEGRADED_SOLO_NOTE);
    expect(ctxOf(plan)).not.toContain(SOLO_RETRACT_NOTE);
    expect(readLeadState(teamPaths(planRoot, "sess_d30_legacy_plan").teamDir)?.soloRetractedAt).toBeUndefined();
  });

  it("〔D30〕首轮 UPS evidence=none → 后续 UPS 三源就位 → 补注（不因首轮空而永久漏注）", async () => {
    const sid = "sess_d30_recover";
    const dataRoot = path.join(dir, "recover-data");
    const first = await runHookOk(
      { hook_event_name: "UserPromptSubmit", session_id: sid, prompt: "首轮", cwd: dir },
      { TEAM_PLUGIN_DATA: dataRoot, ZCODE_SESSION_ID: sid, TEAM_DB_PATH: dbPlan },
    );
    expect(first.trim()).toBe(""); // 首轮三源空 → 不注（乐观）
    insertSubmissionMessage(dbPlan, { sessionId: sid, providerId: PLAN, modelId: "GLM-5.3", timeCreated: 5_000 });
    const second = await runHookOk(
      { hook_event_name: "UserPromptSubmit", session_id: sid, prompt: "次轮", cwd: dir },
      { TEAM_PLUGIN_DATA: dataRoot, ZCODE_SESSION_ID: sid, TEAM_DB_PATH: dbPlan },
    );
    expect(ctxOf(second)).toContain(DEGRADED_SOLO_NOTE);
    expect(readLeadState(teamPaths(dataRoot, sid).teamDir)?.soloNotifiedVia).toBe("db");
  });

  it("〔D30〕off 档 UPS（已通知 + 第三方 db）→ 零输出、不撤回、轮次事件仍记录", async () => {
    const sid = "sess_d30_offups";
    const dataRoot = path.join(dir, "offups-data");
    await runHookOk(
      { hook_event_name: "SessionStart", session_id: sid, source: "startup", cwd: dir, model: HINT_PLAN },
      { TEAM_PLUGIN_DATA: dataRoot, ZCODE_SESSION_ID: sid, TEAM_DB_PATH: dbPlan },
    );
    insertSubmissionMessage(dbPlan, { sessionId: sid, providerId: "custom:98331807", modelId: "deepseek-flash", timeCreated: 6_000 });
    const off = await runHookOk(
      { hook_event_name: "UserPromptSubmit", session_id: sid, prompt: "hi", cwd: dir },
      { TEAM_PLUGIN_DATA: dataRoot, ZCODE_SESSION_ID: sid, TEAM_DB_PATH: dbPlan, TEAM_LEAD_MODE: "off" },
    );
    expect(off.trim()).toBe("");
    const state = readLeadState(teamPaths(dataRoot, sid).teamDir);
    expect(state?.soloRetractedAt).toBeUndefined();
    expect(state?.active).toBe(true); // recordLeadTurnEvent("start") 生效 = 轮次记录未被 off 停掉
  });
});

// 〔D30〕hooks.jsonl 的 model 分类日志：把「宿主是否下发 model」从源码推断变成运行可证。
describe("〔D30〕hooks.jsonl model_category", () => {
  function readLogs(dataRoot: string): Array<Record<string, unknown>> {
    const file = path.join(dataRoot, "logs", "hooks.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("套餐/第三方/未下发 → account / custom / null（只记分类不记 model 明细）", async () => {
    const thirdHint = "98331807-541d-4961-b55f-f2e4a0c4f870/deepseek-flash";
    const cases: Array<[string, Record<string, unknown>, string | null]> = [
      ["cat_plan", { model: `${PLAN}/GLM-5.3` }, "account"],
      ["cat_third", { model: thirdHint }, "custom"],
      ["cat_none", {}, null],
    ];
    for (const [sid, payload, expected] of cases) {
      const dataRoot = path.join(dir, `cat-${sid}`);
      await runHookOk(
        { hook_event_name: "SessionStart", session_id: sid, source: "startup", cwd: dir, ...payload },
        { TEAM_PLUGIN_DATA: dataRoot, ZCODE_SESSION_ID: sid, TEAM_DB_PATH: dbThird },
      );
      const line = readLogs(dataRoot).find((entry) => entry.event === "sessionstart");
      expect(line).toBeDefined();
      expect(line?.model_category).toBe(expected);
      // 不落 model 明细：日志行不应包含完整 modelId
      expect(JSON.stringify(line)).not.toContain("GLM-5.3");
      expect(JSON.stringify(line)).not.toContain("deepseek-flash");
    }
  });
});
