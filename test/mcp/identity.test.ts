// F12 · _meta 身份解析三分支（stage-3 T3.5b）。
// ① _meta.session_id 在场 → 主通道（首调持久化 session-map；同一 daemon 双会话身份不串）；
// ② _meta 缺失 → hook env overlay 映射兜底（启动窗内恰一个 hook 注册候选）；
// ③ 两路都缺 → fail-closed TEAM_NOT_MEMBER（错误 JSON 到达模型侧）。
// 另：runtime_scope=subagent 且无 teammate 映射 → TEAM_NOT_MEMBER（T3.4 遮蔽语义）；
// teammate 映射（role/memberId）→ 域 callerId = memberId。
import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TeamToolBackend } from "../../src/mcp/backend.js";
import { callTeamTool } from "../../src/mcp/registry.js";
import {
  resolveIdentity,
  readSessionRegistry,
  upsertSessionEntry,
  sessionMapPath,
  safeSessionKey,
} from "../../src/mcp/identity.js";
import { MockProvider } from "../../src/provider/mock-provider.js";
import type { CallToolResult } from "../../src/mcp/results.js";
import type { TeamLimits } from "../../src/domain/config.js";

const LIMITS: TeamLimits = {
  maxMembers: 8,
  maxTasks: 256,
  maxMessageBytes: 65536,
  disposalTimeoutMs: 5000,
};

let root: string;
const liveBackends: TeamToolBackend[] = [];

beforeAll(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-s3-identity-"));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

afterEach(async () => {
  for (const b of liveBackends.splice(0)) await b.close().catch(() => undefined);
});

function makeBackend(): { backend: TeamToolBackend; dataRoot: string } {
  const dataRoot = fs.mkdtempSync(path.join(root, "d-"));
  const backend = new TeamToolBackend({ dataRoot, limits: LIMITS, provider: new MockProvider() });
  liveBackends.push(backend);
  return { backend, dataRoot };
}

async function callTool(
  backend: TeamToolBackend,
  dataRoot: string,
  tool: string,
  args: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  return callTeamTool({ backend, dataRoot, bootTimeMs: Date.now(), name: tool, args, meta });
}

function firstText(result: CallToolResult): string {
  return (result.content[0] as { text: string }).text;
}

describe("分支① · _meta.session_id 主通道", () => {
  it("首调即持久化 session-map（firstSeen/lastSeen/session_id）；后续调用直读", () => {
    const { dataRoot } = makeBackend();
    const boot = Date.now();
    const id1 = resolveIdentity({ dataRoot, meta: { session_id: "sess_alpha" }, bootTimeMs: boot });
    expect(id1).toMatchObject({
      sessionId: "sess_alpha",
      teamId: "sess_alpha", // 隐式 Lead：teamId = 自身（02 §2）
      role: "lead",
      name: "lead",
      agentId: "sess_alpha",
      source: "meta",
      hookRegistered: false,
    });
    const registry = readSessionRegistry(dataRoot);
    const entry = registry[safeSessionKey("sess_alpha")]!;
    expect(entry.session_id).toBe("sess_alpha");
    expect(typeof entry.firstSeen).toBe("string");
    expect(typeof entry.lastSeen).toBe("string");
    // 第二调用命中已存条目
    const id2 = resolveIdentity({ dataRoot, meta: { session_id: "sess_alpha" }, bootTimeMs: boot });
    expect(id2.sessionId).toBe("sess_alpha");
  });

  it("同一 daemon 双会话身份不串（H11 workspace 隔离若生效场景；F12 断言）", async () => {
    const { backend, dataRoot } = makeBackend();
    // 会话 A 建任务
    const a = await callTool(backend, dataRoot, "team_task_create", { subject: "by-A", description: "d" }, {
      session_id: "sess_A",
    });
    expect(a.isError).toBeUndefined();
    // 会话 B 是另一个隐式 Lead（自己的 teamId）——看不到 A 的任务板
    const bList = await callTool(backend, dataRoot, "team_task_list", {}, { session_id: "sess_B" });
    expect(JSON.parse(firstText(bList))).toEqual({ tasks: [] });
    // A 自己的列表可见
    const aList = await callTool(backend, dataRoot, "team_task_list", {}, { session_id: "sess_A" });
    expect((JSON.parse(firstText(aList)) as { tasks: Array<{ subject: string }> }).tasks.map((t) => t.subject)).toEqual([
      "by-A",
    ]);
    // 两团队目录彼此独立
    expect(fs.existsSync(path.join(dataRoot, "teams", "sess_A"))).toBe(true);
    expect(fs.existsSync(path.join(dataRoot, "teams", "sess_B"))).toBe(true);
  });
});

describe("分支② · hook env overlay 映射兜底", () => {
  it("_meta 缺失 + 启动窗内恰一个 hook 注册候选 → 采用该会话身份", () => {
    const { dataRoot } = makeBackend();
    const boot = Date.now();
    // 模拟 SessionStart hook 注册（hooks.ts 落盘形态）
    upsertSessionEntry(dataRoot, "sess_from_hook", {
      firstSeen: new Date(boot - 1000).toISOString(),
      hookRegistered: true,
    });
    const id = resolveIdentity({ dataRoot, meta: undefined, bootTimeMs: boot });
    expect(id).toMatchObject({
      sessionId: "sess_from_hook",
      role: "lead",
      source: "hook-map",
      hookRegistered: true,
    });
  });

  it("窗内多个候选 → 不猜测，fail-closed；窗外候选 → 同样 fail-closed", () => {
    const { dataRoot } = makeBackend();
    const boot = Date.now();
    upsertSessionEntry(dataRoot, "sess_one", { firstSeen: new Date(boot).toISOString(), hookRegistered: true });
    upsertSessionEntry(dataRoot, "sess_two", { firstSeen: new Date(boot + 500).toISOString(), hookRegistered: true });
    expect(() => resolveIdentity({ dataRoot, meta: {}, bootTimeMs: boot })).toThrowError(
      'agent "<unknown>" is not a member of an active Agent Team',
    );
    // 清空后：仅一个远处（窗外）候选
    fs.rmSync(sessionMapPath(dataRoot));
    upsertSessionEntry(dataRoot, "sess_old", {
      firstSeen: new Date(boot - 10 * 60_000).toISOString(),
      hookRegistered: true,
    });
    expect(() => resolveIdentity({ dataRoot, meta: {}, bootTimeMs: boot })).toThrowError(
      "is not a member of an active Agent Team",
    );
  });

  it("工具面观察：_meta 缺失 + hook 兜底 → 正常服务（list_agents 成功）", async () => {
    const { backend, dataRoot } = makeBackend();
    const boot = Date.now();
    upsertSessionEntry(dataRoot, "sess_hook_b", {
      firstSeen: new Date(boot).toISOString(),
      hookRegistered: true,
    });
    const result = await callTool(backend, dataRoot, "list_agents", {}, undefined);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(firstText(result))).toEqual([
      { target: "lead", role: "lead", status: "running", diagnostics: [] },
    ]);
  });
});

describe("分支③ · fail-closed", () => {
  it("两路都缺 → TEAM_NOT_MEMBER 错误 JSON 到达模型侧（isError + {error:{code,message}}）", async () => {
    const { backend, dataRoot } = makeBackend();
    const result = await callTool(backend, dataRoot, "list_agents", {}, undefined);
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(firstText(result)) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("TEAM_NOT_MEMBER");
    expect(parsed.error.message).toBe('agent "<unknown>" is not a member of an active Agent Team');
    // 全部 9 工具同口径（抽样 3）
    for (const [tool, args] of [
      ["team_task_list", {}],
      ["send_message", { target: "lead", message: "x" }],
      ["wait_agent", {}],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await callTool(backend, dataRoot, tool, args, {});
      expect(r.isError).toBe(true);
      expect((JSON.parse(firstText(r)) as { error: { code: string } }).error.code).toBe("TEAM_NOT_MEMBER");
    }
  });
});

describe("T3.4 · 遮蔽与非成员语义", () => {
  it("runtime_scope=subagent 且无 teammate 映射 → TEAM_NOT_MEMBER（一次性子代理拒绝执行）", () => {
    const { dataRoot } = makeBackend();
    expect(() =>
      resolveIdentity({
        dataRoot,
        meta: { session_id: "sess_sub", runtime_scope: "subagent" },
        bootTimeMs: Date.now(),
      }),
    ).toThrowError('agent "sess_sub" is not a member of an active Agent Team');
  });

  it("teammate 映射（session-map role/memberId）→ agentId=域侧成员 id；无映射的 subagent 会话 id 进域 → TEAM_NOT_MEMBER", async () => {
    const { backend, dataRoot } = makeBackend();
    // Lead 建成员
    const spawn = await callTool(
      backend,
      dataRoot,
      "spawn_teammate",
      { name: "w1", description: "d", prompt: "p" },
      { session_id: "sess_lead_z" },
    );
    expect(spawn.isError).toBeUndefined();
    const memberRows = await callTool(backend, dataRoot, "list_agents", {}, { session_id: "sess_lead_z" });
    const rows = JSON.parse(firstText(memberRows)) as Array<{ target: string }>;
    expect(rows.map((r) => r.target)).toEqual(["lead", "w1"]);

    // teammate 会话（真实会话 id ≠ 域侧成员 id）；provider 落映射（stage-4 接线，此处直注）。
    // 域侧成员 id 从事件日志取（roster childId）
    const realMemberId = fs
      .readFileSync(path.join(dataRoot, "teams", "sess_lead_z", "events.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { event: { member?: { id: string; name: string } } })
      .find((x) => x.event.member?.name === "w1")!.event.member!.id;
    upsertSessionEntry(dataRoot, "sess_teammate_real", {
      firstSeen: new Date().toISOString(),
      hookRegistered: true,
      teamId: "sess_lead_z",
      role: "teammate",
      name: "w1",
      memberId: realMemberId,
    });
    // teammate 视角 list_agents 成功（callerId=memberId；域成员表命中）
    const tList = await callTool(backend, dataRoot, "list_agents", {}, { session_id: "sess_teammate_real" });
    expect(tList.isError).toBeUndefined();
    expect((JSON.parse(firstText(tList)) as Array<{ target: string }>).map((r) => r.target)).toEqual(["lead", "w1"]);

    // teammate 映射的 memberId 在域成员表查无 → requireMembership → TEAM_NOT_MEMBER（fail-closed）
    upsertSessionEntry(dataRoot, "sess_ghost", {
      firstSeen: new Date().toISOString(),
      teamId: "sess_lead_z",
      role: "teammate",
      name: "ghost",
      memberId: "ghost-member-id",
    });
    const ghost = await callTool(backend, dataRoot, "list_agents", {}, { session_id: "sess_ghost" });
    expect(ghost.isError).toBe(true);
    expect((JSON.parse(firstText(ghost)) as { error: { code: string; message: string } }).error).toEqual({
      code: "TEAM_NOT_MEMBER",
      message: 'agent "ghost-member-id" is not a member of an active Agent Team',
    });
  });

  it("投影 failure 终态 → 全员 TEAM_NOT_MEMBER（stage-2 G1/G2 终态口径；工具面同构）", async () => {
    const { backend, dataRoot } = makeBackend();
    // 健康建态后关闭
    await callTool(backend, dataRoot, "team_task_create", { subject: "s", description: "d" }, { session_id: "sess_fail_l" });
    await backend.close();
    liveBackends.length = 0;
    // 注入非法事件（等价 team-ctl inject-event）
    const eventsFile = path.join(dataRoot, "teams", "sess_fail_l", "events.jsonl");
    const lines = fs.readFileSync(eventsFile, "utf8").split("\n").filter((l) => l.length > 0);
    fs.appendFileSync(
      eventsFile,
      JSON.stringify({
        seq: lines.length + 1,
        ts: new Date().toISOString(),
        writer: "test:inject",
        event: {
          type: "team/member",
          version: 2,
          teamId: "sess_fail_l",
          member: { id: "ghost", name: "ghost", description: "inj", provider: "spawn", context: "fresh", phase: "active" },
        },
      }) + "\n",
    );
    // 新后端冷启动 = 降级协调者（G2）；成员域调用一律 TEAM_NOT_MEMBER（C5/G1）
    const backend2 = new TeamToolBackend({ dataRoot, limits: LIMITS, provider: new MockProvider() });
    liveBackends.push(backend2);
    for (const [tool, args] of [
      ["list_agents", {}],
      ["team_task_list", {}],
      ["team_task_create", { subject: "x", description: "d" }],
      ["send_message", { target: "lead", message: "x" }],
      ["wait_agent", { timeout_ms: 10_000 }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await callTool(backend2, dataRoot, tool, args, { session_id: "sess_fail_l" });
      expect(r.isError, tool).toBe(true);
      const err = (JSON.parse(firstText(r)) as { error: { code: string; message: string } }).error;
      expect(err.code, tool).toBe("TEAM_NOT_MEMBER");
      expect(err.message, tool).toBe('agent "sess_fail_l" is not a member of an active Agent Team');
    }
  });
});
