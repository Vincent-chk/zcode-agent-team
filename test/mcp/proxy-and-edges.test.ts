// 工具面代理模式与边角路径（stage-3 T3.5b 覆盖率补充）。
// ① 代理模式：两个 backend 同团队——A 持锁协调者，B 代理（socket 转发/本地重放）；
//    list_agents 走 memberRowsFromState 保守派生（active → inactive，无存活注册表）；
//    wait/task/send 经 socket 语义等价（结果与错误一致）。
// ② results.normalizeError 的 AggregateError 分支（B5 聚合错误透传形状）。
// ③ registry progress 门控边角（progressToken 类型非法 → 不发）。
// ④ handlers 类型错转 undefined → 方法表冻结消息。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TeamToolBackend, memberRowsFromState } from "../../src/mcp/backend.js";
import { callTeamTool } from "../../src/mcp/registry.js";
import { normalizeError } from "../../src/mcp/results.js";
import { upsertSessionEntry } from "../../src/mcp/identity.js";
import { MockProvider } from "../../src/provider/mock-provider.js";
import { TeamError } from "../../src/domain/errors.js";
import type { CallToolResult } from "../../src/mcp/results.js";
import type { TeamLimits } from "../../src/domain/config.js";

const LIMITS: TeamLimits = {
  maxMembers: 8,
  maxTasks: 256,
  maxMessageBytes: 65536,
  disposalTimeoutMs: 5000,
};

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-s3-proxy-"));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

function text(result: CallToolResult): string {
  return (result.content[0] as { text: string }).text;
}

describe("代理模式（B 无锁 → socket 转发 / 本地重放）", () => {
  it("A 协调者建态；B 代理 list/task/send 语义等价 + MEMBER_VIEW 保守派生", async () => {
    const dataRoot = fs.mkdtempSync(path.join(root, "shared-"));
    const team = "sess_proxy_lead";
    upsertSessionEntry(dataRoot, team, { firstSeen: new Date().toISOString(), hookRegistered: true });

    const providerA = new MockProvider();
    const backendA = new TeamToolBackend({ dataRoot, limits: LIMITS, provider: providerA });
    const callA = (tool: string, args: Record<string, unknown>) =>
      callTeamTool({
        backend: backendA,
        dataRoot,
        bootTimeMs: Date.now(),
        name: tool,
        args,
        meta: { session_id: team },
      });
    // A 建态：1 成员 + 1 任务（A 成为协调者）
    await callA("spawn_teammate", { name: "w1", description: "d", prompt: "p" });
    await callA("team_task_create", { subject: "t1", description: "d" });
    expect(backendA.modeOf(team)).toBe("coordinator");

    // B：同团队第二个 backend（锁被 A 持有 → 代理模式）
    const backendB = new TeamToolBackend({ dataRoot, limits: LIMITS, provider: new MockProvider() });
    const callB = (tool: string, args: Record<string, unknown>) =>
      callTeamTool({
        backend: backendB,
        dataRoot,
        bootTimeMs: Date.now(),
        name: tool,
        args,
        meta: { session_id: team },
      });

    // B 的 task.list 经 socket → 与 A 视图一致
    const listB = await callB("team_task_list", {});
    expect(listB.isError).toBeUndefined();
    const tasks = (JSON.parse(text(listB)) as { tasks: Array<{ id: string; subject: string }> }).tasks;
    expect(tasks.map((t) => t.subject)).toEqual(["t1"]);

    // B 的 list_agents：代理本地重放派生（A 的 MockProvider 存活子进程对 B 不可见 →
    // active 成员保守呈 inactive；lead 行 = caller 自身 → running）
    const agentsB = await callB("list_agents", {});
    expect(agentsB.isError).toBeUndefined();
    const rows = JSON.parse(text(agentsB)) as Array<{ target: string; status: string }>;
    expect(rows.map((r) => r.target)).toEqual(["lead", "w1"]);
    expect(rows[0]!.status).toBe("running");
    expect(rows[1]!.status).toBe("inactive"); // 保守派生（登记于开发记录；stage-4 全保真）

    // B 的写入经 socket（协调者 A 串行执行）：claim 成功且状态连续
    const claimB = await callB("team_task_update", { task_id: "task-1", expected_revision: 1, action: "claim" });
    expect(claimB.isError).toBeUndefined();
    const viewA = JSON.parse(text(await callA("team_task_get", { task_id: "task-1" }))) as { status: string };
    expect(viewA.status).toBe("in_progress");

    // B 的错误路径同样透传（stale revision）
    const staleB = await callB("team_task_update", { task_id: "task-1", expected_revision: 1, action: "release" });
    expect(staleB.isError).toBe(true);
    expect((JSON.parse(text(staleB)) as { error: { code: string } }).error.code).toBe("TEAM_TASK_STALE_REVISION");

    // B 的 wait_agent：代理模式（跳过捷径）经 socket 注册等待 → A 的提交边唤醒
    expect(backendB.modeOf(team)).toBe("proxy");
    const waiting = callB("wait_agent", { timeout_ms: 15_000 });
    await new Promise((r) => setTimeout(r, 200));
    await callA("team_task_create", { subject: "wake-b", description: "d" });
    const woke = await waiting;
    expect(woke.isError).toBeUndefined();
    expect(JSON.parse(text(woke))).toEqual({ timedOut: false });

    await backendB.close();
    await backendA.close();
  }, 30_000);

  it("memberRowsFromState 派生矩阵（failed/provisioning/active + error → diagnostics）", () => {
    const rows = memberRowsFromState(
      "sess_t",
      [
        { id: "m1", name: "a", description: "d", provider: "spawn", context: "fresh", phase: "failed", error: "boom" },
        { id: "m2", name: "b", description: "d", provider: "spawn", context: "fork", phase: "provisioning" },
        { id: "m3", name: "c", description: "d", provider: "spawn", context: "fresh", phase: "active" },
      ],
      "someone-else",
    );
    expect(rows[0]).toEqual({ target: "lead", role: "lead", status: "inactive", diagnostics: [] }); // 非本人 → lead 行 inactive
    expect(rows[1]).toMatchObject({ target: "a", status: "failed", diagnostics: ["boom"] });
    expect(rows[2]).toMatchObject({ target: "b", status: "provisioning", context: "fork" });
    expect(rows[3]).toMatchObject({ target: "c", status: "inactive", provider: "spawn" });
  });
});

describe("边角路径", () => {
  it("normalizeError：AggregateError（首 TeamError 的 code + 聚合消息）；纯 AggregateError；普通 Error；非 Error", () => {
    const teamErr = new TeamError("TEAM_PROVISIONING_CONFLICT", 'teammate "w" became active while its creator reported failure');
    const agg = new AggregateError([teamErr, new Error("cleanup boom")], "teammate creation and durable failure recording both failed");
    expect(normalizeError(agg)).toEqual({
      code: "TEAM_PROVISIONING_CONFLICT",
      message:
        "teammate creation and durable failure recording both failed: teammate \"w\" became active while its creator reported failure",
    });
    const plainAgg = new AggregateError([new Error("e1")], "agg-msg");
    expect(normalizeError(plainAgg)).toEqual({ message: "agg-msg: e1" });
    expect(normalizeError(new Error("plain"))).toEqual({ message: "plain" });
    expect(normalizeError("str-error")).toEqual({ message: "str-error" });
    expect(normalizeError(teamErr)).toEqual({
      code: "TEAM_PROVISIONING_CONFLICT",
      message: 'teammate "w" became active while its creator reported failure',
    });
  });

  it("registry：progressToken 非法类型（object）→ 不建 sink（不发 progress，等待正常）", async () => {
    const dataRoot = fs.mkdtempSync(path.join(root, "tok-"));
    const team = "sess_token_lead";
    upsertSessionEntry(dataRoot, team, { firstSeen: new Date().toISOString(), hookRegistered: true });
    const provider = new MockProvider();
    const backend = new TeamToolBackend({ dataRoot, limits: LIMITS, provider });
    await callTeamTool({
      backend,
      dataRoot,
      bootTimeMs: Date.now(),
      name: "spawn_teammate",
      args: { name: "w1", description: "d", prompt: "p" },
      meta: { session_id: team },
    });
    const notifications: unknown[] = [];
    // 无同伴 → 捷径命中（不等）；progressToken 非法类型不炸
    const res = await callTeamTool(
      {
        backend,
        dataRoot,
        bootTimeMs: Date.now(),
        name: "wait_agent",
        args: {},
        meta: { session_id: "sess_other_lead", progressToken: { bad: true } },
      },
      { sendNotification: async (n: Record<string, unknown>) => { notifications.push(n); } } as never,
    );
    // sess_other_lead 是另一个隐式 Lead（空团队）→ noProgress 捷径
    expect(res.isError).toBeUndefined();
    expect((JSON.parse(text(res)) as { noProgress?: { reason: string } }).noProgress?.reason).toBe("no-active-peer");
    expect(notifications).toHaveLength(0);
    await backend.close();
  });

  it("handlers：参数类型错 → 方法表冻结消息（TEAM_INVALID_ARGUMENT；工具面不另立消息）", async () => {
    const dataRoot = fs.mkdtempSync(path.join(root, "args-"));
    const team = "sess_args_lead";
    upsertSessionEntry(dataRoot, team, { firstSeen: new Date().toISOString(), hookRegistered: true });
    const backend = new TeamToolBackend({ dataRoot, limits: LIMITS, provider: new MockProvider() });
    const call = (tool: string, args: Record<string, unknown>) =>
      callTeamTool({ backend, dataRoot, bootTimeMs: Date.now(), name: tool, args, meta: { session_id: team } });

    // 缺参/非字符串 → requireString 冻结消息
    const missing = await call("spawn_teammate", { name: "w", description: "d" });
    expect(JSON.parse(text(missing))).toEqual({
      error: { code: "TEAM_INVALID_ARGUMENT", message: 'member.spawn param "prompt" must be a string' },
    });
    const wrongType = await call("send_message", { target: 42, message: "x" });
    expect(JSON.parse(text(wrongType))).toEqual({
      error: { code: "TEAM_INVALID_ARGUMENT", message: 'message.send param "targetName" must be a string' },
    });
    // blocked_by 非数组 → optionalStringArray 冻结消息
    const badArray = await call("team_task_create", { subject: "s", description: "d", blocked_by: "task-1" });
    expect(JSON.parse(text(badArray))).toEqual({
      error: { code: "TEAM_INVALID_ARGUMENT", message: 'task.create param "blockedBy" must be an array of strings' },
    });
    // expected_revision 非整数 → methods.ts 冻结消息
    const badRev = await call("team_task_update", { task_id: "task-1", expected_revision: 1.5, action: "claim" });
    expect(JSON.parse(text(badRev))).toEqual({
      error: { code: "TEAM_INVALID_ARGUMENT", message: 'task.update param "expectedRevision" must be a safe integer' },
    });
    // action 非法枚举 → 冻结消息
    const badAction = await call("team_task_update", { task_id: "task-1", expected_revision: 1, action: "explode" });
    expect(JSON.parse(text(badAction))).toEqual({
      error: {
        code: "TEAM_INVALID_ARGUMENT",
        message: 'task.update param "action" must be one of claim, release, edit, set_dependencies, complete, reopen, reassign, delete',
      },
    });
    // 工具面守卫（下游无守卫字段）：message 非字符串 / ready 非布尔 / cursor、limit 非整数 / status 非枚举
    const badMessage = await call("send_message", { target: "lead", message: 42 });
    expect(JSON.parse(text(badMessage))).toEqual({
      error: { code: "TEAM_INVALID_ARGUMENT", message: 'param "message" must be a non-empty string' },
    });
    const badReady = await call("team_task_list", { ready: "yes" });
    expect(JSON.parse(text(badReady))).toEqual({
      error: { code: "TEAM_INVALID_ARGUMENT", message: 'param "ready" must be a boolean' },
    });
    const badCursor = await call("team_task_list", { cursor: "0" });
    expect(JSON.parse(text(badCursor))).toEqual({
      error: { code: "TEAM_INVALID_ARGUMENT", message: 'param "cursor" must be a safe integer' },
    });
    const badLimit = await call("team_task_list", { limit: 1.5 });
    expect(JSON.parse(text(badLimit))).toEqual({
      error: { code: "TEAM_INVALID_ARGUMENT", message: 'param "limit" must be a safe integer' },
    });
    const badStatus = await call("team_task_list", { status: "done" });
    expect(JSON.parse(text(badStatus))).toEqual({
      error: {
        code: "TEAM_INVALID_ARGUMENT",
        message: 'param "status" must be one of pending, in_progress, completed',
      },
    });
    // 未知工具（防御性 default 分支；daemon 层 isTeamTool 已挡在门外）
    const unknown = await callTeamTool({
      backend,
      dataRoot,
      bootTimeMs: Date.now(),
      name: "not_a_tool",
      args: {},
      meta: { session_id: team },
    });
    expect(unknown.isError).toBe(true);
    expect((JSON.parse(text(unknown)) as { error: { message: string } }).error.message).toBe(
      "unsupported team tool: not_a_tool",
    );
    await backend.close();
  });

  it("〔对齐轮 D3〕interrupt=false：interrupt_agent 调用按未注册拒绝；其余 8 工具正常", async () => {
    const dataRoot = fs.mkdtempSync(path.join(root, "noint-"));
    const team = "sess_noint_lead";
    upsertSessionEntry(dataRoot, team, { firstSeen: new Date().toISOString(), hookRegistered: true });
    const provider = new MockProvider();
    const backend = new TeamToolBackend({ dataRoot, limits: LIMITS, provider, interrupt: false });
    expect(backend.interruptEnabled).toBe(false);
    const call = (tool: string, args: Record<string, unknown>) =>
      callTeamTool({ backend, dataRoot, bootTimeMs: Date.now(), name: tool, args, meta: { session_id: team } });

    await call("spawn_teammate", { name: "w1", description: "d", prompt: "p" });
    const rejected = await call("interrupt_agent", { target: "w1" });
    expect(rejected.isError).toBe(true);
    const err = JSON.parse(text(rejected)) as { error: { code?: string; message: string } };
    expect(err.error.message).toBe("unsupported team tool: interrupt_agent");
    expect(err.error.code).toBeUndefined(); // 不贴假 code（未注册 ≠ 域错误）
    // 其余工具不受开关影响
    const list = await call("list_agents", {});
    expect(list.isError).toBeUndefined();
    await backend.close();
  });
});
