// F07 · 错误透传抽样（stage-3 T3.5b）：27 错误码中 ≥10 个经工具面触发（〔对齐轮〕0.2.1 删 TEAM_MAILBOX_FULL），
// code/message 完整到达模型侧结果（单 text 块紧凑 JSON {"error":{code,message}}）。
// 触发的错误全部由域层/方法表产生（工具面不复制业务校验）——本测试同时证明
// 「工具面只接线」：同一消息逐字从域层透传到 MCP 结果。
import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TeamToolBackend } from "../../src/mcp/backend.js";
import { callTeamTool } from "../../src/mcp/registry.js";
import { upsertSessionEntry } from "../../src/mcp/identity.js";
import { MockProvider } from "../../src/provider/mock-provider.js";
import type { CallToolResult } from "../../src/mcp/results.js";
import type { TeamLimits } from "../../src/domain/config.js";

const LIMITS: TeamLimits = {
  maxMembers: 2, // 便于触发 TEAM_MEMBER_LIMIT（含 Lead 之外 2 teammate 即满）
  maxTasks: 2,
  maxMessageBytes: 512,
  disposalTimeoutMs: 5000,
};

let root: string;
const live: TeamToolBackend[] = [];

beforeAll(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-s3-f07-"));
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});
afterEach(async () => {
  for (const b of live.splice(0)) await b.close().catch(() => undefined);
});

interface Rig {
  backend: TeamToolBackend;
  provider: MockProvider;
  dataRoot: string;
  lead: string;
}

function makeRig(opts: { register?: boolean } = {}): Rig {
  const dataRoot = fs.mkdtempSync(path.join(root, "t-"));
  const provider = new MockProvider();
  const backend = new TeamToolBackend({ dataRoot, limits: LIMITS, provider });
  live.push(backend);
  const lead = `sess_lead_${Math.random().toString(36).slice(2, 8)}`;
  if (opts.register !== false) {
    upsertSessionEntry(dataRoot, lead, { firstSeen: new Date().toISOString(), hookRegistered: true });
  }
  return { backend, provider, dataRoot, lead };
}

function call(rig: Rig, tool: string, args: Record<string, unknown>, sessionId?: string): Promise<CallToolResult> {
  const sid = sessionId ?? rig.lead;
  return callTeamTool({
    backend: rig.backend,
    dataRoot: rig.dataRoot,
    bootTimeMs: Date.now(),
    name: tool,
    args,
    meta: { session_id: sid },
  });
}

function errOf(result: CallToolResult): { code: string; message: string } {
  expect(result.isError).toBe(true);
  const parsed = JSON.parse((result.content[0] as { text: string }).text) as {
    error: { code: string; message: string };
  };
  expect(parsed.error.code).toMatch(/^TEAM_/);
  return parsed.error;
}

/** 抽样矩阵：≥10 码（验收标准 F07）。每码断言 code + message 逐字（规格模板）。 */
describe("F07 · 27 码抽样经工具面（code/message 完整到达）", () => {
  it("12 码抽样矩阵", async () => {
    const rig = makeRig();

    // 1. TEAM_NOT_MEMBER（无身份调用；用未注册 rig 保证走 fail-closed 而非 hook 兜底）
    const bareRig = makeRig({ register: false });
    const notMember = await callTeamTool({
      backend: bareRig.backend,
      dataRoot: bareRig.dataRoot,
      bootTimeMs: Date.now(),
      name: "list_agents",
      args: {},
      meta: undefined,
    });
    expect(errOf(notMember)).toEqual({
      code: "TEAM_NOT_MEMBER",
      message: 'agent "<unknown>" is not a member of an active Agent Team',
    });

    // 2. TEAM_INVALID_MEMBER_NAME（§5.1 逐字）
    const badName = await call(rig, "spawn_teammate", { name: "Bad Name", description: "d", prompt: "p" });
    expect(errOf(badName)).toEqual({
      code: "TEAM_INVALID_MEMBER_NAME",
      message: 'teammate name must be lower-kebab-case, at most 64 characters, and not "lead"',
    });

    // 3. TEAM_MEMBER_LIMIT（限额 2：建满后再建）
    await call(rig, "spawn_teammate", { name: "w1", description: "d", prompt: "p" });
    await call(rig, "spawn_teammate", { name: "w2", description: "d", prompt: "p" });
    const limit = await call(rig, "spawn_teammate", { name: "w3", description: "d", prompt: "p" });
    expect(errOf(limit)).toEqual({ code: "TEAM_MEMBER_LIMIT", message: "Team member limit 2 reached" });

    // 4. TEAM_MEMBER_NAME_TAKEN（含 failed 成员名字不复用——同名 active）
    const taken = await call(rig, "spawn_teammate", { name: "w1", description: "d", prompt: "p" });
    expect(errOf(taken)).toEqual({
      code: "TEAM_MEMBER_NAME_TAKEN",
      message: 'teammate name "w1" was already used in this Team',
    });

    // 5. TEAM_INVALID_ARGUMENT（任务 description 超长；§7.2 逐字）
    const tooLong = await call(rig, "team_task_create", { subject: "s", description: "x".repeat(16385) });
    expect(errOf(tooLong)).toEqual({
      code: "TEAM_INVALID_ARGUMENT",
      message: "description exceeds 16384 characters",
    });

    // 6. TEAM_TASK_LIMIT（maxTasks=2）
    await call(rig, "team_task_create", { subject: "t1", description: "d" });
    await call(rig, "team_task_create", { subject: "t2", description: "d" });
    const taskLimit = await call(rig, "team_task_create", { subject: "t3", description: "d" });
    expect(errOf(taskLimit)).toEqual({ code: "TEAM_TASK_LIMIT", message: "Team task limit 2 reached" });

    // 7. TEAM_TASK_NOT_FOUND
    const notFound = await call(rig, "team_task_get", { task_id: "task-404" });
    expect(errOf(notFound)).toEqual({ code: "TEAM_TASK_NOT_FOUND", message: 'team task "task-404" not found' });

    // 8. TEAM_INVALID_WRITE_SCOPE（§7.5 逐字，<json> = JSON 编码）
    const badScope = await call(rig, "team_task_create", {
      subject: "ws",
      description: "d",
      write_scopes: ["/abs/path"],
    });
    expect(errOf(badScope)).toEqual({
      code: "TEAM_INVALID_WRITE_SCOPE",
      message: 'invalid workspace-relative write scope "/abs/path"',
    });

    // 9. TEAM_TASK_DEPENDENCY_CYCLE（自阻塞；§7.4 dependencies() 入参校验逐字。
    //    经 set_dependencies 触发——create 路径此时已被限额占满（限额检查先于依赖校验））
    const cycle = await call(rig, "team_task_update", {
      task_id: "task-1",
      expected_revision: 1,
      action: "set_dependencies",
      blocked_by: ["task-1"],
    });
    expect(errOf(cycle)).toEqual({
      code: "TEAM_TASK_DEPENDENCY_CYCLE",
      message: "a team task cannot block itself",
    });

    // 10. TEAM_TASK_INVALID_TRANSITION（pending 直接 complete）
    const transition = await call(rig, "team_task_update", {
      task_id: "task-1",
      expected_revision: 1,
      action: "complete",
    });
    expect(errOf(transition)).toEqual({
      code: "TEAM_TASK_INVALID_TRANSITION",
      message: "only an in-progress task can complete",
    });

    // 11. TEAM_TASK_STALE_REVISION（CAS 失败；消息含期望/当前两值）
    await call(rig, "team_task_update", { task_id: "task-1", expected_revision: 1, action: "claim" });
    const stale = await call(rig, "team_task_update", {
      task_id: "task-1",
      expected_revision: 1,
      action: "release",
    });
    expect(errOf(stale)).toEqual({
      code: "TEAM_TASK_STALE_REVISION",
      message: 'stale team task "task-1" revision 1; current revision is 2',
    });

    // 12. TEAM_SELF_MESSAGE（lead → lead）
    const selfMsg = await call(rig, "send_message", { target: "lead", message: "to myself" });
    expect(errOf(selfMsg)).toEqual({
      code: "TEAM_SELF_MESSAGE",
      message: "a Team member cannot message itself",
    });

    // 13. TEAM_MEMBER_NOT_FOUND（send 目标不存在）
    const noTarget = await call(rig, "send_message", { target: "ghost", message: "hi" });
    expect(errOf(noTarget)).toEqual({ code: "TEAM_MEMBER_NOT_FOUND", message: 'active teammate "ghost" not found' });

    // 14. TEAM_INVALID_TIMEOUT（wait 非法值）
    const badTimeout = await call(rig, "wait_agent", { timeout_ms: 5 });
    expect(errOf(badTimeout)).toEqual({
      code: "TEAM_INVALID_TIMEOUT",
      message: "timeoutMs must be an integer from 10000 through 3600000",
    });

    // 15. TEAM_INVALID_TARGET（interrupt lead 自身）
    const selfInterrupt = await call(rig, "interrupt_agent", { target: "lead" });
    expect(errOf(selfInterrupt)).toEqual({
      code: "TEAM_INVALID_TARGET",
      message: "the Team Lead cannot interrupt itself",
    });
  });

  it("TEAM_MESSAGE_TOO_LARGE（限额语义经工具面；〔对齐轮〕0.2.1 删 pending 上限）", async () => {
    const rig = makeRig();
    await call(rig, "spawn_teammate", { name: "w1", description: "d", prompt: "p" });
    // 太长的消息（框架化后 > 512B 限额）
    const tooLarge = await call(rig, "send_message", { target: "w1", message: "m".repeat(600) });
    expect(errOf(tooLarge)).toEqual({ code: "TEAM_MESSAGE_TOO_LARGE", message: "team message exceeds 512 bytes" });

    // 〔对齐轮〕无 pending 上限：滞留多条不再有 full 拒绝（结果一律 {sent:true}）
    rig.provider.programWith({ deliverResults: ["queued", "queued", "queued", "queued"] });
    const q1 = await call(rig, "send_message", { target: "w1", message: "q1" });
    const q2 = await call(rig, "send_message", { target: "w1", message: "q2" });
    const q3 = await call(rig, "send_message", { target: "w1", message: "q3" });
    for (const r of [q1, q2, q3]) {
      expect(r.isError).toBeUndefined();
      expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ sent: true });
    }
  });

  it("TEAM_TASK_ALREADY_CLAIMED / TEAM_TASK_UNAUTHORIZED / TEAM_TASK_BLOCKED（任务板权限与状态语义）", async () => {
    const rig = makeRig();
    await call(rig, "spawn_teammate", { name: "w1", description: "d", prompt: "p" });
    const memberId = [...rig.provider.teamChildren.keys()][0]!;
    const teammateSession = "sess_tm_f07";
    upsertSessionEntry(rig.dataRoot, teammateSession, {
      firstSeen: new Date().toISOString(),
      hookRegistered: true,
      teamId: rig.lead,
      role: "teammate",
      name: "w1",
      memberId,
    });
    // lead 建两任务：task-2 被 task-1 阻塞
    await call(rig, "team_task_create", { subject: "t1", description: "d" });
    await call(rig, "team_task_create", { subject: "t2", description: "d", blocked_by: ["task-1"] });
    // lead claim task-1 → teammate 再 claim → ALREADY_CLAIMED
    await call(rig, "team_task_update", { task_id: "task-1", expected_revision: 1, action: "claim" });
    const claimed = await call(
      rig,
      "team_task_update",
      { task_id: "task-1", expected_revision: 2, action: "claim" },
      teammateSession,
    );
    expect(errOf(claimed)).toEqual({
      code: "TEAM_TASK_ALREADY_CLAIMED",
      message: 'team task "task-1" is owned by another member',
    });
    // teammate claim 被阻塞任务 → BLOCKED（not ready to claim）
    const blocked = await call(
      rig,
      "team_task_update",
      { task_id: "task-2", expected_revision: 1, action: "claim" },
      teammateSession,
    );
    expect(errOf(blocked)).toEqual({
      code: "TEAM_TASK_BLOCKED",
      message: 'team task "task-2" is not ready to claim',
    });
    // teammate（非 owner 非 Lead）edit task-1 → UNAUTHORIZED
    const unauthorized = await call(
      rig,
      "team_task_update",
      { task_id: "task-1", expected_revision: 2, action: "edit", subject: "hijack" },
      teammateSession,
    );
    expect(errOf(unauthorized)).toEqual({
      code: "TEAM_TASK_UNAUTHORIZED",
      message: "task mutation requires its owner or Team Lead",
    });
  });

  it("TEAM_TASK_HAS_DEPENDENTS / TEAM_TASK_DELETED（delete 墓碑语义）", async () => {
    const rig = makeRig();
    await call(rig, "team_task_create", { subject: "t1", description: "d" });
    await call(rig, "team_task_create", { subject: "t2", description: "d", blocked_by: ["task-1"] });
    // delete 仍被依赖 → HAS_DEPENDENTS
    const hasDep = await call(rig, "team_task_update", {
      task_id: "task-1",
      expected_revision: 1,
      action: "delete",
    });
    expect(errOf(hasDep)).toEqual({
      code: "TEAM_TASK_HAS_DEPENDENTS",
      message: 'team task "task-1" still blocks "task-2"',
    });
    // 解除依赖后 delete 成功 → 墓碑；再变更 → TEAM_TASK_DELETED
    await call(rig, "team_task_update", { task_id: "task-2", expected_revision: 1, action: "set_dependencies", blocked_by: [] });
    const deleted = await call(rig, "team_task_update", {
      task_id: "task-1",
      expected_revision: 1,
      action: "delete",
    });
    expect(deleted.isError).toBeUndefined();
    const afterDelete = await call(rig, "team_task_update", {
      task_id: "task-1",
      expected_revision: 2,
      action: "claim",
    });
    expect(errOf(afterDelete)).toEqual({ code: "TEAM_TASK_DELETED", message: 'team task "task-1" is deleted' });
    // get 仍可读墓碑（§7.1）
    const tombstone = await call(rig, "team_task_get", { task_id: "task-1" });
    expect(tombstone.isError).toBeUndefined();
    expect((JSON.parse((tombstone.content[0] as { text: string }).text) as { status: string }).status).toBe("deleted");
  });
});
