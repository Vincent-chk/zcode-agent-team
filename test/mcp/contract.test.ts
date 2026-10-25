// stage-3 T3.5b · 工具面行为契约测试（MockProvider + 真实协调层装配，数据根 os.tmpdir()）。
// 覆盖验收标准 F02/F03/F04/F05/F06 + 工具层语义：默认值、no-active-peer 捷径、MEMBER_VIEW
// target 改名、紧凑 JSON（单 text 块无缩进）、错误 {code,message} 透传、fail-loud 警告行。
// _meta 身份三分支见 identity.test.ts；27 码抽样见 f07-codes.test.ts；保活 progress 见
// wait-keepalive.test.ts。
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TeamToolBackend } from "../../src/mcp/backend.js";
import { callTeamTool } from "../../src/mcp/registry.js";
import type { CallToolResult } from "../../src/mcp/results.js";
import { upsertSessionEntry } from "../../src/mcp/identity.js";
import { MockProvider } from "../../src/provider/mock-provider.js";
import { NO_PROGRESS_MESSAGE } from "../../src/mcp/policy.js";
import type { TeamLimits } from "../../src/domain/config.js";

const DEFAULT_LIMITS: TeamLimits = {
  maxMembers: 8,
  maxTasks: 256,
  maxMessageBytes: 65536,
  disposalTimeoutMs: 5000,
};

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-s3-contract-"));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

interface Rig {
  backend: TeamToolBackend;
  provider: MockProvider;
  dataRoot: string;
}

const liveRigs: Rig[] = [];

function makeRig(opts: { limits?: Partial<TeamLimits>; team?: string } = {}): Rig {
  const dataRoot = fs.mkdtempSync(path.join(root, "team-"));
  const provider = new MockProvider();
  const backend = new TeamToolBackend({
    dataRoot,
    limits: { ...DEFAULT_LIMITS, ...opts.limits },
    provider,
  });
  const rig = { backend, provider, dataRoot };
  liveRigs.push(rig);
  return rig;
}

afterEach(async () => {
  // 关闭后端（journal checkpoint + 锁释放）；fd/句柄不跨用例泄漏
  for (const rig of liveRigs.splice(0)) {
    await rig.backend.close().catch(() => undefined);
  }
});

interface CallOpts {
  meta?: Record<string, unknown>;
  /** 缺省 true（生产常态：SessionStart hook 已注册本会话）；fail-loud 测试显式传 false。 */
  hookRegistered?: boolean;
  sessionId?: string;
}

async function call(rig: Rig, tool: string, args: Record<string, unknown>, opts: CallOpts = {}): Promise<CallToolResult> {
  const sessionId = opts.sessionId ?? "sess_lead_a";
  if (opts.hookRegistered !== false) {
    upsertSessionEntry(rig.dataRoot, sessionId, { firstSeen: new Date().toISOString(), hookRegistered: true });
  }
  return callTeamTool({
    backend: rig.backend,
    dataRoot: rig.dataRoot,
    bootTimeMs: Date.now(),
    name: tool,
    args,
    meta: opts.meta !== undefined ? opts.meta : { session_id: sessionId },
  });
}

/** 成功结果解析：单 text 块 + 紧凑 JSON（F02 断言内嵌）。 */
function okJson(result: CallToolResult): unknown {
  expect(result.isError).toBeUndefined();
  expect(result.content).toHaveLength(1); // hook 已注册（常态）→ 无 fail-loud 警告块
  const block = result.content[0] as { type: string; text: string };
  expect(block.type).toBe("text");
  // F02：单行紧凑（无缩进无换行）；对象 ^{.*}$ / 数组 ^\[.*\]$
  expect(block.text).not.toContain("\n");
  expect(block.text).toMatch(/^\{.*\}$|^\[.*\]$/);
  return JSON.parse(block.text);
}

function errJson(result: CallToolResult): { code?: string; message: string } {
  expect(result.isError).toBe(true);
  expect(result.content).toHaveLength(1); // hook 已注册（常态）
  const block = result.content[0] as { type: string; text: string };
  expect(block.text).not.toContain("\n");
  const parsed = JSON.parse(block.text) as { error: { code?: string; message: string } };
  expect(Object.keys(parsed)).toEqual(["error"]);
  return parsed.error;
}

describe("F02/F03 · spawn_teammate 契约", () => {
  let rig: Rig;
  beforeEach(() => {
    rig = makeRig();
  });

  it("成功 = 单 text 块紧凑 JSON {member:MEMBER_VIEW}；id→target 改名；字段集与 §9.4 一致", async () => {
    const result = await call(rig, "spawn_teammate", {
      name: "reviewer",
      description: "Reviews diffs",
      prompt: "Review the latest diff.",
    });
    const body = okJson(result) as { member: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(["member"]);
    const member = body.member;
    // MEMBER_VIEW（§9.4）：必 target/role/status/diagnostics；可选缺省不出现（model 无 → 不出现）
    expect(member.target).toBe("reviewer"); // id→target 改名（值 = name）
    expect(member.role).toBe("teammate");
    expect(member.status).toBe("running"); // MockProvider availability（存活即 running）
    expect(member.description).toBe("Reviews diffs");
    expect(member.provider).toBe("spawn"); // freshProvider 缺省（02 §4 工具插件 config）
    expect(member.context).toBe("fresh"); // context 缺省 fresh（§9.3）
    expect(member.diagnostics).toEqual([]);
    expect(member.id).toBeUndefined(); // 永不暴露成员 Session ID / 内部 id
    expect(member.model).toBeUndefined(); // 可选缺省不出现
    expect(Object.keys(member).sort()).toEqual(
      ["context", "description", "diagnostics", "provider", "role", "status", "target"].sort(),
    );
  });

  it("F03（〔对齐轮〕0.2.1）：MockProvider 捕获首轮 prompt = 任务原文（身份前缀块已删除，改由运行时上下文承载）", async () => {
    await call(rig, "spawn_teammate", {
      name: "worker",
      description: "d",
      prompt: "Do the task.\nSecond line.",
    });
    const child = [...rig.provider.teamChildren.values()][0];
    expect(child).toBeDefined();
    // 冻结包 06 §3.2：spawn 只发送调用方给定内容（sends the initial task unchanged）
    expect(child!.firstPrompt).toBe("Do the task.\nSecond line.");
    expect(child!.firstPrompt).not.toContain("system-reminder"); // 旧前缀块不复存在
  });

  it("name 原样进成员行（02 §5.1；前缀已删，不再有 trim 替换面）", async () => {
    await call(rig, "spawn_teammate", { name: "w1", description: "d", prompt: "p" });
    const child = [...rig.provider.teamChildren.values()][0];
    expect(child!.name).toBe("w1");
  });

  it("context=fork → forkProvider（member.provider='fork'）；context 非法 → TEAM_INVALID_ARGUMENT", async () => {
    const result = await call(rig, "spawn_teammate", {
      name: "forked",
      description: "d",
      prompt: "p",
      context: "fork",
    });
    const body = okJson(result) as { member: { provider: string; context: string } };
    expect(body.member.provider).toBe("fork");
    expect(body.member.context).toBe("fork");

    const bad = await call(rig, "spawn_teammate", {
      name: "bad-ctx",
      description: "d",
      prompt: "p",
      context: "hot",
    });
    expect(errJson(bad)).toEqual({
      code: "TEAM_INVALID_ARGUMENT",
      message: 'member.spawn param "context" must be one of fresh, fork',
    });
  });

  it("F13 · 结果契约不被 surface 提示破坏（提示挂定义侧 _meta.ui；结果 JSON 无 _meta 字段）", async () => {
    const result = await call(rig, "spawn_teammate", { name: "w2", description: "d", prompt: "p" });
    const body = okJson(result) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["member"]);
    expect(JSON.stringify(body)).not.toContain("_meta");
    expect(JSON.stringify(body)).not.toContain("surface");
  });

  it("模型预检失败（0.4.1）→ 全链路透出错误；成员未登记（list_agents 不含）；名字未占用", async () => {
    rig.provider.programWith({
      preflightError: Object.assign(
        new Error(
          "Lead 当前使用官方套餐模型（account:x/GLM-5.3），成员无法继承（CLI 进程拿不到订阅套餐凭据）。请在 ZCode 中切换到自配的第三方模型后重试。",
        ),
        { name: "ModelInheritanceError" },
      ),
    });
    const result = await call(rig, "spawn_teammate", { name: "blocked", description: "d", prompt: "p" });
    // 非 TeamError → 不贴假 code；message 原样透出（用户可读的可操作建议）
    const error = errJson(result);
    expect(error.code).toBeUndefined();
    expect(error.message).toContain("官方套餐模型");
    expect(error.message).toContain("请在 ZCode 中切换到自配的第三方模型");
    // 成员未登记：list_agents 只有 Lead 伪行
    const listed = await call(rig, "list_agents", {});
    const rows = okJson(listed) as Array<{ target: string }>;
    expect(rows.map((r) => r.target)).toEqual(["lead"]);
    // 名字未占用：修正后原名可建
    rig.provider.programWith({});
    const retry = await call(rig, "spawn_teammate", { name: "blocked", description: "d", prompt: "p" });
    const body = okJson(retry) as { member: { target: string } };
    expect(body.member.target).toBe("blocked");
  });
});

describe("F02 · list_agents 契约（MEMBER_VIEW[] + Lead 伪行）", () => {
  it("Lead 伪行第一（target='lead'）；teammate 按创建序；数组输出单行紧凑", async () => {
    const rig = makeRig();
    await call(rig, "spawn_teammate", { name: "w1", description: "d1", prompt: "p" });
    await call(rig, "spawn_teammate", { name: "w2", description: "d2", prompt: "p" });
    const result = await call(rig, "list_agents", {});
    expect(result.isError).toBeUndefined();
    const block = result.content[0] as { type: string; text: string };
    expect(block.text).not.toContain("\n");
    expect(block.text).toMatch(/^\[.*\]$/);
    const rows = JSON.parse(block.text) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ target: "lead", role: "lead", status: "running", diagnostics: [] });
    expect(rows[1]!.target).toBe("w1");
    expect(rows[2]!.target).toBe("w2");
    expect(rows[1]!.description).toBe("d1");
    expect(rows[1]!.provider).toBe("spawn");
    expect(rows[1]!.context).toBe("fresh");
  });
});

describe("F04 · wait_agent 契约（默认值/捷径/非法值）", () => {
  it("no-active-peer 捷径：除己外无 running|provisioning → 立即返回 noProgress 常量（逐字）", async () => {
    const rig = makeRig();
    const started = Date.now();
    const result = await call(rig, "wait_agent", {});
    const body = okJson(result) as { timedOut: boolean; noProgress: { reason: string; message: string } };
    expect(Date.now() - started).toBeLessThan(2000); // 立即返回（未注册等待）
    expect(body.timedOut).toBe(false);
    expect(body.noProgress.reason).toBe("no-active-peer");
    // 02 §8 逐字消息
    expect(body.noProgress.message).toBe(
      "No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake each required inactive teammate before waiting again.",
    );
    expect(body.noProgress.message).toBe(NO_PROGRESS_MESSAGE);
  });

  it("非法值绕过捷径直进域：无同伴（捷径本会命中）也报 TEAM_INVALID_TIMEOUT（逐字）", async () => {
    const rig = makeRig();
    for (const bad of [9999, 3_600_001, 10000.5, 1e20]) {
      const result = await call(rig, "wait_agent", { timeout_ms: bad });
      expect(errJson(result)).toEqual({
        code: "TEAM_INVALID_TIMEOUT",
        message: "timeoutMs must be an integer from 10000 through 3600000",
      });
    }
    // 非数值型同样逐字（工具面守卫；登记于开发记录）
    const result = await call(rig, "wait_agent", { timeout_ms: "20000" });
    expect(errJson(result)).toEqual({
      code: "TEAM_INVALID_TIMEOUT",
      message: "timeoutMs must be an integer from 10000 through 3600000",
    });
  });

  it("默认 30000：缺省 timeout_ms + 有同伴 → 注册等待并被提交唤醒（timedOut:false）", async () => {
    const rig = makeRig();
    await call(rig, "spawn_teammate", { name: "w1", description: "d", prompt: "p" });
    const waiting = call(rig, "wait_agent", {});
    await new Promise((r) => setTimeout(r, 80));
    // 唤醒边：Team 日志提交（task.create）
    await call(rig, "team_task_create", { subject: "wake", description: "d" });
    const body = okJson(await waiting) as { timedOut: boolean; noProgress?: unknown };
    expect(body).toEqual({ timedOut: false }); // 不携带变化内容（02 §8）
    expect(body.noProgress).toBeUndefined();
  }, 15_000);

  it("合法 timeout_ms=10000 无活动 → timedOut:true（无错误码）", async () => {
    const rig = makeRig();
    await call(rig, "spawn_teammate", { name: "w1", description: "d", prompt: "p" });
    // 让 MockProvider 子进程状态转为非 running 不现实（存活即 running）——直接用
    // 10s 等待验证超时路径（真实计时；时序敏感 → retry 由套件纪律承担）
    const started = Date.now();
    const result = await call(rig, "wait_agent", { timeout_ms: 10_000 });
    const elapsed = Date.now() - started;
    const body = okJson(result) as { timedOut: boolean };
    expect(body.timedOut).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(9_500);
    expect(elapsed).toBeLessThan(13_000);
  }, 20_000);
});

describe("F05 · team_task_list 过滤/分页契约", () => {
  it("status/owner('unowned')/ready 过滤 + nextCursor 出现条件 + 越界消息逐字", async () => {
    const rig = makeRig();
    await call(rig, "spawn_teammate", { name: "w1", description: "d", prompt: "p" });
    await call(rig, "team_task_create", { subject: "t1", description: "d" });
    await call(rig, "team_task_create", { subject: "t2", description: "d", blocked_by: ["task-1"] });
    await call(rig, "team_task_update", { task_id: "task-1", expected_revision: 1, action: "claim" });

    // status 精确过滤
    const inProgress = okJson(await call(rig, "team_task_list", { status: "in_progress" })) as {
      tasks: Array<{ id: string; ownerName?: string; ready: boolean }>;
      nextCursor?: number;
    };
    expect(inProgress.tasks.map((t) => t.id)).toEqual(["task-1"]);
    expect(inProgress.tasks[0]!.ownerName).toBe("lead"); // claim 者 = lead（callerId=teamId → "lead"）
    expect(inProgress.tasks[0]!.ready).toBe(false); // ready 仅 pending 且 blocker 全 completed
    expect(inProgress.nextCursor).toBeUndefined(); // 无下一页 → 不出现

    // owner 过滤（名字 / "unowned"）
    const owned = okJson(await call(rig, "team_task_list", { owner: "lead" })) as { tasks: Array<{ id: string }> };
    expect(owned.tasks.map((t) => t.id)).toEqual(["task-1"]);
    const unowned = okJson(await call(rig, "team_task_list", { owner: "unowned" })) as { tasks: Array<{ id: string }> };
    expect(unowned.tasks.map((t) => t.id)).toEqual(["task-2"]);

    // ready 过滤（被阻塞的 pending = not ready）
    const notReady = okJson(await call(rig, "team_task_list", { ready: false })) as { tasks: Array<{ id: string }> };
    expect(notReady.tasks.map((t) => t.id)).toEqual(["task-1", "task-2"]);

    // 分页：limit=1 → nextCursor=1；cursor=1 → 第二页无 nextCursor
    const page1 = okJson(await call(rig, "team_task_list", { limit: 1 })) as {
      tasks: Array<{ id: string }>;
      nextCursor?: number;
    };
    expect(page1.tasks.map((t) => t.id)).toEqual(["task-1"]);
    expect(page1.nextCursor).toBe(1);
    const page2 = okJson(await call(rig, "team_task_list", { cursor: 1, limit: 1 })) as {
      tasks: Array<{ id: string }>;
      nextCursor?: number;
    };
    expect(page2.tasks.map((t) => t.id)).toEqual(["task-2"]);
    expect(page2.nextCursor).toBeUndefined();

    // 越界消息逐字（02 §7.6）
    expect(errJson(await call(rig, "team_task_list", { cursor: -1 }))).toEqual({
      code: "TEAM_INVALID_ARGUMENT",
      message: "cursor must be a non-negative safe integer",
    });
    expect(errJson(await call(rig, "team_task_list", { limit: 0 }))).toEqual({
      code: "TEAM_INVALID_ARGUMENT",
      message: "limit must be an integer from 1 through 100",
    });
    expect(errJson(await call(rig, "team_task_list", { limit: 101 }))).toEqual({
      code: "TEAM_INVALID_ARGUMENT",
      message: "limit must be an integer from 1 through 100",
    });
  });

  it("TASK_VIEW 字段集与 §9.4 一致（ownerName 可选缺省不出现）", async () => {
    const rig = makeRig();
    const created = okJson(await call(rig, "team_task_create", {
      subject: "s",
      description: "d",
      write_scopes: ["src/a"],
    })) as Record<string, unknown>;
    expect(Object.keys(created).sort()).toEqual(
      ["id", "revision", "subject", "description", "status", "blockedBy", "writeScopes", "ready", "writeScopeWarnings"].sort(),
    );
    expect(created.ownerName).toBeUndefined(); // 无 owner → 字段不出现
    expect(created).toMatchObject({ id: "task-1", revision: 1, status: "pending", ready: true });

    const got = okJson(await call(rig, "team_task_get", { task_id: "task-1" })) as Record<string, unknown>;
    expect(got).toEqual(created);
  });
});

describe("F06 · 权限执行层（Lead-only 不放宽 + 错误 code 可达模型侧）", () => {
  it("teammate 调 spawn/interrupt → TEAM_LEAD_REQUIRED；非 Lead reassign → TEAM_LEAD_REQUIRED", async () => {
    const rig = makeRig();
    const spawnRes = okJson(await call(rig, "spawn_teammate", { name: "w1", description: "d", prompt: "p" })) as {
      member: Record<string, unknown>;
    };
    void spawnRes;
    // teammate 身份注入（session-map：role=teammate + teamId + memberId=域侧成员 id）
    const board = JSON.parse(
      (
        (await call(rig, "list_agents", {})).content[0] as { text: string }
      ).text,
    ) as Array<{ target: string }>;
    void board;
    // 取域侧成员 id：MockProvider teamChildren 的 key
    const memberId = [...rig.provider.teamChildren.keys()][0]!;
    const teammateSession = "sess_teammate_x";
    upsertSessionEntry(rig.dataRoot, teammateSession, {
      firstSeen: new Date().toISOString(),
      hookRegistered: true,
      teamId: "sess_lead_a",
      role: "teammate",
      name: "w1",
      memberId,
    });

    const spawnByTeammate = await call(
      rig,
      "spawn_teammate",
      { name: "w2", description: "d", prompt: "p" },
      { sessionId: teammateSession, meta: { session_id: teammateSession } },
    );
    expect(errJson(spawnByTeammate)).toEqual({
      code: "TEAM_LEAD_REQUIRED",
      message: "only the Team Lead can create teammates",
    });

    const interruptByTeammate = await call(
      rig,
      "interrupt_agent",
      { target: "w1" },
      { sessionId: teammateSession, meta: { session_id: teammateSession } },
    );
    expect(errJson(interruptByTeammate)).toEqual({
      code: "TEAM_LEAD_REQUIRED",
      message: "only the Team Lead can interrupt teammates",
    });

    // reassign 非 Lead → TEAM_LEAD_REQUIRED（02 §7.3）
    await call(rig, "team_task_create", { subject: "t", description: "d" });
    const reassignByTeammate = await call(
      rig,
      "team_task_update",
      { task_id: "task-1", expected_revision: 1, action: "reassign", owner: "lead" },
      { sessionId: teammateSession, meta: { session_id: teammateSession } },
    );
    expect(errJson(reassignByTeammate).code).toBe("TEAM_LEAD_REQUIRED");

    // teammate 可用面：task claim/list/get 正常（权限谓词 = owner/Lead 之外 claim 任意成员）
    const claim = okJson(
      await call(
        rig,
        "team_task_update",
        { task_id: "task-1", expected_revision: 1, action: "claim" },
        { sessionId: teammateSession, meta: { session_id: teammateSession } },
      ),
    ) as { ownerName: string; status: string };
    expect(claim.ownerName).toBe("w1"); // ownerId=caller(memberId) → 成员名
    expect(claim.status).toBe("in_progress");
  });

  it("interrupt Lead 自身 → TEAM_INVALID_TARGET；非 active 目标 → TEAM_MEMBER_NOT_FOUND（逐字）", async () => {
    const rig = makeRig();
    expect(errJson(await call(rig, "interrupt_agent", { target: "lead" }))).toEqual({
      code: "TEAM_INVALID_TARGET",
      message: "the Team Lead cannot interrupt itself",
    });
    expect(errJson(await call(rig, "interrupt_agent", { target: "ghost" }))).toEqual({
      code: "TEAM_MEMBER_NOT_FOUND",
      message: 'active teammate "ghost" not found',
    });
  });
});

describe("F02 · 紧凑 JSON 与错误透传（全工具面）", () => {
  it("send_message 成功 = 单 text 块 {sent:true}（〔对齐轮〕0.2.1 工具层不暴露 messageId）", async () => {
    const rig = makeRig();
    await call(rig, "spawn_teammate", { name: "w1", description: "d", prompt: "p" });
    const result = await call(rig, "send_message", { target: "w1", message: "hello there" });
    const body = okJson(result) as { sent: boolean };
    expect(Object.keys(body)).toEqual(["sent"]);
    expect(body.sent).toBe(true); // MockProvider 存活子进程 → 收件接受
    // 框架化投递内容（冻结包 06 §3.4 逐字框架头：无消息 id）
    const child = [...rig.provider.teamChildren.values()][0]!;
    expect([...child.deliverCount.keys()]).toHaveLength(1);
    expect(child.received.size).toBe(1);
    const deliveredKey = [...child.deliverCount.keys()][0]!;
    expect(deliveredKey).toMatch(/^team-message-/); // 内部适配层仍以 messageId 去重
  });

  it("team_task_update CAS 过期 → TEAM_TASK_STALE_REVISION（消息含期望/当前两值，逐字）", async () => {
    const rig = makeRig();
    await call(rig, "team_task_create", { subject: "t", description: "d" });
    await call(rig, "team_task_update", { task_id: "task-1", expected_revision: 1, action: "claim" });
    expect(
      errJson(await call(rig, "team_task_update", { task_id: "task-1", expected_revision: 1, action: "complete" })),
    ).toEqual({
      code: "TEAM_TASK_STALE_REVISION",
      message: 'stale team task "task-1" revision 1; current revision is 2',
    });
    // 重 get 后重试成功（U04 语义的工具面基础）
    const got = okJson(await call(rig, "team_task_get", { task_id: "task-1" })) as { revision: number };
    const done = okJson(
      await call(rig, "team_task_update", {
        task_id: "task-1",
        expected_revision: got.revision,
        action: "complete",
      }),
    ) as { status: string; ownerName: string };
    expect(done.status).toBe("completed");
    expect(done.ownerName).toBe("lead"); // complete 保留 owner（02 §7.3）
  });

  it("fail-loud（D10）：hook 未注册会话 → 结果追加警告 text 块（JSON 本体不变）；已注册 → 单块", async () => {
    const rig = makeRig();
    // 未注册（hookRegistered:false → session-map 无标记）
    const bare = await call(
      rig,
      "team_task_create",
      { subject: "s", description: "d" },
      { sessionId: "sess_no_hook", hookRegistered: false },
    );
    expect(bare.content).toHaveLength(2);
    const json0 = okJson({ ...bare, content: [bare.content[0]!] }) as { id: string };
    expect(json0.id).toBe("task-1");
    const warn = bare.content[1] as { type: string; text: string };
    expect(warn.type).toBe("text");
    expect(warn.text).toContain("[agent-team] 警告：未检测到本会话的策略注入");
    // 已注册（缺省）→ 单块
    const registered = await call(rig, "team_task_create", { subject: "s2", description: "d" });
    expect(registered.content).toHaveLength(1);
    // 错误结果同样附警告（未注册时）——不改 error JSON
    const errBare = await call(
      rig,
      "team_task_get",
      { task_id: "task-404" },
      { sessionId: "sess_no_hook", hookRegistered: false },
    );
    expect(errBare.content).toHaveLength(2);
    expect(errJson({ ...errBare, content: [errBare.content[0]!] }).code).toBe("TEAM_TASK_NOT_FOUND");
  });
});
