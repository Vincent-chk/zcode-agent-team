// Hook 收件箱（T4.3）：pending 派生（重放−回执）、三通道模板逐字、Stop 预算 ≤3/run、
// 角色解析与 teammate 认领；入口级（dist 形态 bundle）三通道输出 + 回执落盘。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseSpawnIdentity,
  resolveHookRole,
  pendingForLead,
  buildStopReason,
  buildInboxContext,
  budgetAllows,
  nextBudget,
  runKeyFor,
} from "../../src/hooks/inbox.js";
import { memberPaths, receiptMessageIds, readStopBudget } from "../../src/provider/member-files.js";
import { teamPaths } from "../../src/coord/paths.js";

const TEAM = "sess_s4_hook_lead";

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-s4-hk-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeEvents(lines: Array<Record<string, unknown>>): void {
  const { teamDir } = teamPaths(path.join(root, "data"), TEAM);
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(
    path.join(teamDir, "events.jsonl"),
    lines.map((l, i) => JSON.stringify({ seq: i + 1, ts: "2026-10-17T00:00:00.000Z", writer: "test", ...l })).join("\n") + "\n",
  );
}

function msgEvent(id: string, senderName: string, text: string, targetId = TEAM): Record<string, unknown> {
  return {
    event: {
      type: "team/message/queued",
      version: 2,
      teamId: TEAM,
      message: { id, senderId: "sess-beta", senderName, targetId, content: [{ type: "text", text }] },
    },
  };
}

describe("resolveHookRole / parseSpawnIdentity", () => {
  it("session-map teammate 映射优先", () => {
    const role = resolveHookRole({
      registryEntry: { role: "teammate", teamId: TEAM, name: "alpha", memberId: "m-1" },
      spawnIdentityEnv: undefined,
      sessionId: "sess_t1",
    });
    expect(role).toEqual({ role: "teammate", teamId: TEAM, name: "alpha", memberId: "m-1" });
  });

  it("TEAM_SPAWN_IDENTITY 提示（首轮 hook 早于 daemon 认领）", () => {
    const role = resolveHookRole({
      registryEntry: undefined,
      spawnIdentityEnv: JSON.stringify({ teamId: TEAM, memberId: "m-2", name: "beta" }),
      sessionId: "sess_t2",
    });
    expect(role.role).toBe("teammate");
    expect(role.hint?.memberId).toBe("m-2");
  });

  it("无映射无提示 → Lead（teamId = 自身会话 id）", () => {
    expect(resolveHookRole({ registryEntry: undefined, spawnIdentityEnv: undefined, sessionId: "sess_L" })).toEqual({
      role: "lead",
      teamId: "sess_L",
      name: "lead",
    });
  });

  it("损坏提示忽略（不炸 hook）", () => {
    expect(parseSpawnIdentity("{bad json")).toBeUndefined();
    expect(parseSpawnIdentity(JSON.stringify({ teamId: "t" }))).toBeUndefined(); // 缺字段
  });
});

describe("pendingForLead（重放派生 − 已回执）", () => {
  it("queued−delivered−receipts；框架头渲染逐字（D1 无消息 id）", async () => {
    writeEvents([
      msgEvent("m1", "alpha", "第一封"),
      { event: { type: "team/message/queued", version: 2, teamId: TEAM, message: { id: "m2", senderId: "s", senderName: "beta", targetId: TEAM, content: [{ type: "text", text: "第二封" }] } } },
      { event: { type: "team/message/delivered", version: 2, teamId: TEAM, messageId: "m2", targetId: TEAM } },
    ]);
    const { teamDir } = teamPaths(path.join(root, "data"), TEAM);
    const pending = await pendingForLead(teamDir, TEAM);
    expect(pending.map((p) => p.messageId)).toEqual(["m1"]);
    expect(pending[0].text).toBe("Team message from alpha:\n第一封");
    // 回执在场的消息不再注入
    const paths = memberPaths(teamDir, TEAM);
    fs.mkdirSync(path.dirname(paths.receiptsFile), { recursive: true });
    fs.writeFileSync(paths.receiptsFile, JSON.stringify({ messageId: "m1", channel: "stop", ts: "t" }) + "\n");
    expect(await pendingForLead(teamDir, TEAM)).toEqual([]);
  });

  it("无 events.jsonl（非团队会话）→ 空", async () => {
    const { teamDir } = teamPaths(path.join(root, "data"), "sess_other");
    expect(await pendingForLead(teamDir, "sess_other")).toEqual([]);
  });
});

describe("三通道模板（接口草案 §4 冻结）", () => {
  it("Stop reason / Inbox context 前缀逐字", () => {
    expect(buildStopReason(["Team message from alpha:\nA"])).toBe(
      "[agent-team inbox] 新消息到达，本轮结束后需处理：\nTeam message from alpha:\nA",
    );
    expect(buildInboxContext(["Team message from alpha:\nA", "Team message from beta:\nB"])).toBe(
      "[agent-team inbox] 待收消息 2 条：\nTeam message from alpha:\nA\n\nTeam message from beta:\nB",
    );
  });
});

describe("Stop 预算（≤3 次/run）", () => {
  it("fresh 复位 / continuation 延续 / 第 4 次拒绝", () => {
    expect(runKeyFor(false)).toBe("fresh-run");
    expect(runKeyFor(true)).toBe("continuation");
    expect(runKeyFor(null)).toBe("fresh-run");
    let state = nextBudget(undefined, "fresh-run");
    state = nextBudget(state, "continuation"); // fresh→continuation：同 run 计数延续
    state = nextBudget(state, "continuation");
    expect(state).toEqual({ runKey: "continuation", blocks: 3 });
    expect(budgetAllows(state, "continuation")).toBe(false); // 第 4 次 block 拒绝
    expect(budgetAllows(state, "fresh-run")).toBe(true); // 新 run 复位
    expect(budgetAllows(undefined, "continuation")).toBe(true);
  });
});

// ---------------------------------------------------------------- 入口级（bundle 后真进程）

let hookBundle: string | undefined;

async function bundleHooks(): Promise<string> {
  if (hookBundle !== undefined) return hookBundle;
  const out = path.join(fs.realpathSync(os.tmpdir()), `at-team-hooks-${process.pid}.mjs`);
  await build({
    entryPoints: [path.resolve(import.meta.dirname, "../../src/hooks.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: out,
    logLevel: "silent",
  });
  hookBundle = out;
  return out;
}

interface HookRun {
  code: number;
  stdout: string;
}

function runHook(input: Record<string, unknown>, env: Record<string, string>): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ["--", hookBundle!],
      { env: { ...process.env, ...env }, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        void err;
        resolve({ code: child.exitCode ?? (err ? 1 : 0), stdout });
      },
    );
    child.stdin!.write(JSON.stringify(input));
    child.stdin!.end();
  });
}

describe("hook 入口（dist 形态真进程）", () => {
  it("UserPromptSubmit：pending → additionalContext 注入 + 回执落盘（F07 冷路径）", async () => {
    await bundleHooks();
    writeEvents([msgEvent("m1", "alpha", "ups-body")]);
    const dataRoot = path.join(root, "data");
    const result = await runHook(
      { hook_event_name: "UserPromptSubmit", session_id: TEAM, cwd: root },
      { TEAM_PLUGIN_DATA: dataRoot },
    );
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(payload.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(payload.hookSpecificOutput.additionalContext).toBe(
      "[agent-team inbox] 待收消息 1 条：\nTeam message from alpha:\nups-body",
    );
    expect([...receiptMessageIds(memberPaths(teamPaths(dataRoot, TEAM).teamDir, TEAM))]).toEqual(["m1"]);
  });

  it("Stop：pending → decision:block + reason + 回执；第 4 次（预算耗尽）不再 block", async () => {
    await bundleHooks();
    writeEvents([msgEvent("m1", "alpha", "stop-body")]);
    const dataRoot = path.join(root, "data");
    const env = { TEAM_PLUGIN_DATA: dataRoot };
    const paths = memberPaths(teamPaths(dataRoot, TEAM).teamDir, TEAM);
    const block = await runHook({ hook_event_name: "Stop", session_id: TEAM, stop_hook_active: false }, env);
    const blockPayload = JSON.parse(block.stdout) as { decision: string; reason: string };
    expect(blockPayload.decision).toBe("block");
    expect(blockPayload.reason).toBe("[agent-team inbox] 新消息到达，本轮结束后需处理：\nTeam message from alpha:\nstop-body");
    // 已回执 → pending 空 → 不再干预
    const after = await runHook({ hook_event_name: "Stop", session_id: TEAM, stop_hook_active: true }, env);
    expect(after.stdout).toBe("");
  });

  it("Stop 预算耗尽：3 次续跑后第 4 条消息不 block（滞留 pending 交 UPS/SessionStart）", async () => {
    await bundleHooks();
    const dataRoot = path.join(root, "data");
    const env = { TEAM_PLUGIN_DATA: dataRoot };
    const paths = memberPaths(teamPaths(dataRoot, TEAM).teamDir, TEAM);
    const decisionOf = async (payload: Record<string, unknown>) => {
      const r = await runHook({ hook_event_name: "Stop", session_id: TEAM, ...payload }, env);
      return r.stdout === "" ? null : ((JSON.parse(r.stdout) as { decision?: string }).decision ?? null);
    };
    const inject = (id: string) => {
      writeEvents([msgEvent(id, "alpha", `body-${id}`)]);
    };
    inject("b1");
    expect(await decisionOf({ stop_hook_active: false })).toBe("block"); // block #1
    inject("b2");
    expect(await decisionOf({ stop_hook_active: true })).toBe("block"); // block #2
    inject("b3");
    expect(await decisionOf({ stop_hook_active: true })).toBe("block"); // block #3
    inject("b4");
    expect(await decisionOf({ stop_hook_active: true })).toBe(null); // 超限 → 不 block
    expect(readStopBudget(paths)).toEqual({ runKey: "continuation", blocks: 3 });
    // b4 滞留 pending：UPS 兜底注入
    const ups = await runHook({ hook_event_name: "UserPromptSubmit", session_id: TEAM }, env);
    const upsPayload = JSON.parse(ups.stdout) as { hookSpecificOutput: { additionalContext: string } };
    expect(upsPayload.hookSpecificOutput.additionalContext).toContain("body-b4");
  });

  it("SessionStart(startup)：teammate 认领（TEAM_SPAWN_IDENTITY）+ teammate 分支身份 + 不注入收件箱", async () => {
    await bundleHooks();
    const dataRoot = path.join(root, "data");
    // lead 有 pending，但本会话是 teammate（env 提示）→ 不注入 lead 的收件箱
    writeEvents([msgEvent("m1", "alpha", "not-for-teammate")]);
    const result = await runHook(
      { hook_event_name: "SessionStart", source: "startup", session_id: "sess_teammate_x" },
      {
        TEAM_PLUGIN_DATA: dataRoot,
        TEAM_SPAWN_IDENTITY: JSON.stringify({ teamId: TEAM, memberId: "m-tt", name: "gamma" }),
      },
    );
    const payload = JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } };
    expect(payload.hookSpecificOutput.additionalContext).toContain('You are teammate "gamma".');
    expect(payload.hookSpecificOutput.additionalContext).not.toContain("not-for-teammate");
    // session-map 认领落盘（daemon 身份解析据此走 teammate 分支）
    const map = JSON.parse(fs.readFileSync(path.join(dataRoot, "session-map.json"), "utf8")) as Record<string, unknown>;
    const entry = Object.values(map).find((e) => (e as { memberId?: string }).memberId === "m-tt") as {
      role: string;
      teamId: string;
      name: string;
      hookRegistered: boolean;
    };
    expect(entry).toMatchObject({ role: "teammate", teamId: TEAM, name: "gamma", hookRegistered: true });
  });

  it("SessionStart(resume)：Lead 收件箱附加段 + 策略/身份/暗号齐备", async () => {
    await bundleHooks();
    writeEvents([msgEvent("m1", "beta", "resume-body")]);
    const dataRoot = path.join(root, "data");
    const result = await runHook(
      { hook_event_name: "SessionStart", source: "resume", session_id: TEAM },
      { TEAM_PLUGIN_DATA: dataRoot },
    );
    const payload = JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } };
    const ctx = payload.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("Agent Teams is available in this session"); // 策略（D5 首段）
    expect(ctx).toContain('You are the Team Lead named "lead".'); // 身份 Lead 分支
    expect(ctx).not.toContain("quartz-ember-73"); // 生产默认无探针
    expect(ctx).toContain("[agent-team inbox] 待收消息 1 条：\nTeam message from beta:\nresume-body"); // 收件箱附加段
    expect([...receiptMessageIds(memberPaths(teamPaths(dataRoot, TEAM).teamDir, TEAM))]).toEqual(["m1"]);
  });

  it("teammate 的 Stop/UPS：不注入（进程即边界）", async () => {
    await bundleHooks();
    writeEvents([msgEvent("m1", "alpha", "body")]);
    const dataRoot = path.join(root, "data");
    const env = {
      TEAM_PLUGIN_DATA: dataRoot,
      TEAM_SPAWN_IDENTITY: JSON.stringify({ teamId: TEAM, memberId: "m-tt", name: "gamma" }),
    };
    const stop = await runHook({ hook_event_name: "Stop", session_id: "sess_t", stop_hook_active: false }, env);
    const ups = await runHook({ hook_event_name: "UserPromptSubmit", session_id: "sess_t" }, env);
    expect(stop.stdout).toBe("");
    expect(ups.stdout).toBe("");
  });
});
