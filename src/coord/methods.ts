// 协调者 RPC 方法表（stage-2 第四轮；接口草案 §2 终版接线）。
// 逐方法对域层签名冻结参数与结果——本表只做参数解包与身份口径，业务语义全部在
// domain 五服务（roster/mailbox/taskboard/activity/lifecycle），27 码错误逐字透传（〔对齐轮〕0.2.1：28→27）。
//
// 身份口径（冻结）：写入类/需调用方身份的方法参数必带 `session_id`（显式、可测、无连接态
// 依赖；缺失 → TEAM_INVALID_ARGUMENT "session_id is required"）。coordinator.hello 的
// session_id 仅声明/诊断用途；board.read 可不带（排障视角，见 team-ctl call）。
//
// wait.agent 超时口径（冻结）：域层上限 3600s，服务端按方法豁免（timeoutMs = 入参 + 5s
// 裕量），不得先于 wait 上限触发；客户端 call timeout 可配置。

import { TeamError } from "../domain/errors.js";
import { projectionFailureError, requireMembership, teamProjectionView } from "../domain/projection.js";
import type { TeamState } from "../domain/projection.js";
import type { TeamRuntime } from "../domain/runtime.js";
import type { JournalTeamStore } from "./store-adapter.js";
import type { RpcServer } from "./rpc.js";
import type { ContentBlock, TeamTaskStatus } from "../domain/events.js";
import type { TaskAction } from "../domain/taskboard.js";
import type { TeammateProvider } from "../provider/teammate-provider.js";
import { parseModelSelection, type MemberModelSelection } from "../provider/model-selection.js";

const TASK_ACTIONS: readonly TaskAction[] = [
  "claim",
  "release",
  "edit",
  "set_dependencies",
  "complete",
  "reopen",
  "reassign",
  "delete",
];

/** wait.agent 服务端豁免裕量（ms）：域层校验 10000..3600000 → 豁免 = 入参 + 5s。 */
export const WAIT_AGENT_GRACE_MS = 5_000;

/** 慢方法的客户端超时映射（代理模式必须与服务端 per-method timeout 同值）。 */
export const METHOD_TIMEOUT_OVERRIDES: Readonly<Record<string, number>> = {
  "member.spawn": 180_000,
  "message.send": 30_000,
  // mid-life setModel = 临时 app-server ready(≤20s)+resume+setModel（各 20s）+ 关停，留裕量。
  "member.set_model": 60_000,
};

export function methodTimeoutMs(method: string): number | undefined {
  return METHOD_TIMEOUT_OVERRIDES[method];
}

export interface TeamMethodHandler {
  (params: unknown, ctx?: { signal?: AbortSignal }): Promise<unknown> | unknown;
  /** 服务端按方法超时（缺省 = RpcServer 全局 callTimeoutMs）。 */
  timeoutMs?: number;
}

export interface MethodTableDeps {
  teamId: string;
  runtime: TeamRuntime;
  store: JournalTeamStore;
  coordinatorBootId: string;
  /** stage-8 Round C：mid-life 模型修改（host 传入同一 provider 实例）。 */
  provider?: TeammateProvider;
}

/** 真方法表（host 装配 + 进程内直执行共用一份）。键序即接口草案 §2 终版方法表。 */
export function buildTeamMethodTable(deps: MethodTableDeps): Map<string, TeamMethodHandler> {
  const { runtime, store } = deps;

  const table = new Map<string, TeamMethodHandler>();

  table.set("coordinator.hello", (raw) => {
    const p = asParams(raw, "coordinator.hello");
    // daemonBootId / session_id 仅声明/诊断；teamId 若给出必须匹配（传输级路由自检）
    assertTeamTarget(p, "coordinator.hello", deps);
    return {
      coordinatorBootId: deps.coordinatorBootId,
      stateRevision: store.committedSeq,
    };
  });

  table.set("member.claim", (raw) => {
    const p = asParams(raw, "member.claim");
    assertTeamTarget(p, "member.claim", deps);
    const sessionId = requireSessionId(p, "member.claim");
    const membership = requireMembership(membershipStateLoader(store), sessionId);
    return { role: membership.role };
  });

  const memberSpawn: TeamMethodHandler = async (raw) => {
    const p = asParams(raw, "member.spawn");
    assertTeamTarget(p, "member.spawn", deps);
    const sessionId = requireSessionId(p, "member.spawn");
    const context = optionalString(p, "context", "member.spawn", { enum: ["fresh", "fork"] }) as
      | "fresh"
      | "fork"
      | undefined;
    const model = optionalString(p, "model", "member.spawn");
    const thoughtLevel = optionalString(p, "thoughtLevel", "member.spawn");
    const modelSelection = optionalModelSelection(p, "modelSelection", "member.spawn");
    return runtime.roster.spawnTeammate(sessionId, {
      // 空串下沉到域层：name → TEAM_INVALID_MEMBER_NAME；description → <field> must be non-empty。
      name: requireString(p, "name", "member.spawn", { allowEmpty: true }),
      description: requireString(p, "description", "member.spawn", { allowEmpty: true }),
      prompt: requireString(p, "prompt", "member.spawn", { allowEmpty: true }),
      ...(context !== undefined ? { context } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(modelSelection !== undefined ? { modelSelection } : {}),
      ...(thoughtLevel !== undefined ? { thoughtLevel } : {}),
    });
  };
  // 首轮持久接收等待最长 120s；服务端/客户端都必须给足裕量（不得先于域层超时）。
  memberSpawn.timeoutMs = 180_000;
  table.set("member.spawn", memberSpawn);

  /**
   * stage-8 Round C · mid-life 改模型（对话通道）：Lead-only（工具描述即此口径）→ 目标成员
   * 必须 active → provider.setMemberModel（立即/pending 由 provider 决定）。
   * member_id 接受成员 id 或 target 名（backend 传工具面的 target 名）。
   */
  const memberSetModel: TeamMethodHandler = async (raw) => {
    const p = asParams(raw, "member.set_model");
    assertTeamTarget(p, "member.set_model", deps);
    const sessionId = requireSessionId(p, "member.set_model");
    if (sessionId !== deps.teamId) {
      throw new TeamError("TEAM_LEAD_REQUIRED", "only the Team Lead can change teammate models");
    }
    const target = requireString(p, "member_id", "member.set_model", { allowEmpty: true });
    const modelSelection = optionalModelSelection(p, "modelSelection", "member.set_model");
    const thoughtLevel = optionalString(p, "thoughtLevel", "member.set_model");
    if (modelSelection === undefined && thoughtLevel === undefined) {
      throw new TeamError(
        "TEAM_INVALID_ARGUMENT",
        'member.set_model requires "modelSelection" or "thoughtLevel"',
      );
    }
    const state = membershipStateLoader(store)();
    const member = state.members.find((m) => m.id === target || m.name === target);
    if (member === undefined || member.phase !== "active") {
      throw new TeamError("TEAM_MEMBER_NOT_FOUND", `active teammate "${target}" not found`);
    }
    const provider = deps.provider;
    if (provider?.setMemberModel === undefined) {
      throw new TeamError("TEAM_INVALID_ARGUMENT", "this provider does not support changing member models");
    }
    return provider.setMemberModel({
      memberId: member.id,
      ...(modelSelection !== undefined ? { modelSelection } : {}),
      ...(thoughtLevel !== undefined ? { thoughtLevel } : {}),
    });
  };
  memberSetModel.timeoutMs = 60_000;
  table.set("member.set_model", memberSetModel);

  // 目标为名字（02 §5.6；冻结参数名 `name`）
  table.set("member.interrupt", async (raw) => {
    const p = asParams(raw, "member.interrupt");
    assertTeamTarget(p, "member.interrupt", deps);
    const sessionId = requireSessionId(p, "member.interrupt");
    const name = requireString(p, "name", "member.interrupt", { allowEmpty: true });
    return runtime.roster.interrupt(sessionId, name);
  });

  const messageSend: TeamMethodHandler = async (raw) => {
    const p = asParams(raw, "message.send");
    assertTeamTarget(p, "message.send", deps);
    const sessionId = requireSessionId(p, "message.send");
    const targetName = requireString(p, "targetName", "message.send", { allowEmpty: true });
    if (!Array.isArray(p.content)) {
      throw new TeamError("TEAM_INVALID_ARGUMENT", "message.send param \"content\" must be an array of content blocks");
    }
    return runtime.mailbox.send(sessionId, { target: targetName, content: p.content as ContentBlock[] });
  };
  // deliver 确认最长 15s；给 2 倍裕量，避免服务端 10s 默认先截断。
  messageSend.timeoutMs = 30_000;
  table.set("message.send", messageSend);

  // stage-4（T4.3）：hook 回执加速通道——注入成功后 hook 落回执文件（权威）并调本方法折叠
  // delivered 事件（mailbox.observeDelivery = containsMessage(回执) → markDelivered）。
  // targetId 缺省 = session_id（Lead ack 自己的收件箱）；ack 他人收件箱必须显式给 targetId。
  table.set("mailbox.ack", async (raw) => {
    const p = asParams(raw, "mailbox.ack");
    assertTeamTarget(p, "mailbox.ack", deps);
    const sessionId = requireSessionId(p, "mailbox.ack");
    if (!Array.isArray(p.messageIds) || p.messageIds.some((id) => typeof id !== "string")) {
      throw new TeamError("TEAM_INVALID_ARGUMENT", "mailbox.ack param \"messageIds\" must be an array of strings");
    }
    const messageIds = p.messageIds as string[];
    const targetId =
      typeof p.targetId === "string" && p.targetId.length > 0 ? p.targetId : sessionId;
    for (const messageId of messageIds) {
      await runtime.mailbox.observeDelivery(targetId, messageId);
    }
    return { acknowledged: messageIds.length };
  });

  table.set("task.create", async (raw) => {
    const p = asParams(raw, "task.create");
    assertTeamTarget(p, "task.create", deps);
    const sessionId = requireSessionId(p, "task.create");
    const blockedBy = optionalStringArray(p, "blockedBy", "task.create");
    const writeScopes = optionalStringArray(p, "writeScopes", "task.create");
    return runtime.taskboard.create(sessionId, {
      subject: requireString(p, "subject", "task.create", { allowEmpty: true }),
      description: requireString(p, "description", "task.create", { allowEmpty: true }),
      ...(blockedBy !== undefined ? { blockedBy } : {}),
      ...(writeScopes !== undefined ? { writeScopes } : {}),
    });
  });

  table.set("task.update", async (raw) => {
    const p = asParams(raw, "task.update");
    assertTeamTarget(p, "task.update", deps);
    const sessionId = requireSessionId(p, "task.update");
    const action = requireString(p, "action", "task.update");
    if (!(TASK_ACTIONS as readonly string[]).includes(action)) {
      throw new TeamError(
        "TEAM_INVALID_ARGUMENT",
        `task.update param "action" must be one of ${TASK_ACTIONS.join(", ")}`,
      );
    }
    const expectedRevision = p.expectedRevision;
    if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision)) {
      throw new TeamError("TEAM_INVALID_ARGUMENT", "task.update param \"expectedRevision\" must be a safe integer");
    }
    const subject = optionalString(p, "subject", "task.update", { allowEmpty: true });
    const description = optionalString(p, "description", "task.update", { allowEmpty: true });
    const blockedBy = optionalStringArray(p, "blockedBy", "task.update");
    const writeScopes = optionalStringArray(p, "writeScopes", "task.update");
    // reassign 的空/空白 owner = 去指派（规格 §7.3）；空串必须在方法层放行到域层 trim 分支。
    const owner = optionalString(p, "owner", "task.update", { allowEmpty: true });
    return runtime.taskboard.update(sessionId, {
      taskId: requireString(p, "taskId", "task.update", { allowEmpty: true }),
      expectedRevision,
      action: action as TaskAction,
      ...(subject !== undefined ? { subject } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(blockedBy !== undefined ? { blockedBy } : {}),
      ...(writeScopes !== undefined ? { writeScopes } : {}),
      ...(owner !== undefined ? { owner } : {}),
    });
  });

  table.set("task.list", (raw) => {
    const p = asParams(raw, "task.list");
    assertTeamTarget(p, "task.list", deps);
    const sessionId = requireSessionId(p, "task.list");
    const status = optionalString(p, "status", "task.list") as TeamTaskStatus | undefined;
    const owner = optionalString(p, "owner", "task.list");
    return runtime.taskboard.list(sessionId, {
      ...(status !== undefined ? { status } : {}),
      ...(owner !== undefined ? { owner } : {}),
      ...(typeof p.ready === "boolean" ? { ready: p.ready } : {}),
      ...(typeof p.cursor === "number" ? { cursor: p.cursor } : {}),
      ...(typeof p.limit === "number" ? { limit: p.limit } : {}),
    });
  });

  table.set("task.get", (raw) => {
    const p = asParams(raw, "task.get");
    assertTeamTarget(p, "task.get", deps);
    const sessionId = requireSessionId(p, "task.get");
    return runtime.taskboard.get(sessionId, requireString(p, "taskId", "task.get", { allowEmpty: true }));
  });

  // 全量视图帧；带 session_id → 成员校验（C5 fail-closed → TEAM_NOT_MEMBER），
  // 不带 → 排障视角（team-ctl call / U03 退化检查；failure 视图原样可见）。
  table.set("board.read", (raw) => {
    const p = asParams(raw, "board.read");
    assertTeamTarget(p, "board.read", deps);
    const sessionId = typeof p.session_id === "string" ? p.session_id : undefined;
    if (sessionId !== undefined) {
      requireMembership(membershipStateLoader(store), sessionId);
    }
    return { revision: store.committedSeq, view: teamProjectionView(store.state()) };
  });

  const waitAgent: TeamMethodHandler = async (raw, ctx) => {
    const p = asParams(raw, "wait.agent");
    assertTeamTarget(p, "wait.agent", deps);
    const sessionId = requireSessionId(p, "wait.agent");
    const timeoutMs = typeof p.timeoutMs === "number" ? p.timeoutMs : 30_000;
    return runtime.activity.waitForChange(sessionId, timeoutMs, ctx?.signal);
  };
  waitAgent.timeoutMs = 3_600_000 + WAIT_AGENT_GRACE_MS; // 豁免上限：域层允许的最大等待 + 裕量
  table.set("wait.agent", waitAgent);

  table.set("admin.reconcile", (raw) => {
    const p = asParams(raw, "admin.reconcile");
    assertTeamTarget(p, "admin.reconcile", deps);
    return runtime.roster.reconcileProvisioning();
  });

  return table;
}

/** 方法表挂到 RpcServer（socket 载体）。 */
export function registerTeamMethods(server: RpcServer, table: Map<string, TeamMethodHandler>): RpcServer {
  for (const [method, handler] of table) {
    server.register(
      method,
      (params, ctx) => handler(params, ctx),
      handler.timeoutMs !== undefined ? { timeoutMs: handler.timeoutMs } : {},
    );
  }
  return server;
}

/** 方法表直执行（host 协调者模式进程内路径；错误原样抛出 = 与 socket 路径同语义）。 */
export async function invokeTeamMethod(
  table: Map<string, TeamMethodHandler>,
  method: string,
  params: unknown,
  ctx?: { signal?: AbortSignal },
): Promise<unknown> {
  const handler = table.get(method);
  if (handler === undefined) {
    throw new Error(`unknown rpc method: ${method}`);
  }
  return handler(params, ctx);
}

/** 方法名清单（文档一致性测试 / §2 对照用）。 */
export function teamMethodNames(table: ReadonlyMap<string, TeamMethodHandler>): string[] {
  return [...table.keys()];
}

// ---------------------------------------------------------------- 参数解包（身份口径 + 轻量形状守卫）

/**
 * C5 口径（T2.1）：投影 failure 终态时 journal.state() 直接 throw failure 文本——
 * 方法表内直读 store.state() 的成员资格校验必须走同一口径（对齐域五件套各自的 loadState 守卫：
 * tryMembership 遇 loadState 抛错 → 静默非成员 → requireMembership → TEAM_NOT_MEMBER）。
 */
function membershipStateLoader(store: JournalTeamStore): () => TeamState {
  return () => {
    const state = store.state();
    if (state.failure !== undefined) throw projectionFailureError(state.failure);
    return state;
  };
}

function asParams(raw: unknown, method: string): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new TeamError("TEAM_INVALID_ARGUMENT", `${method} params must be an object`);
  }
  return raw as Record<string, unknown>;
}

function assertTeamTarget(p: Record<string, unknown>, method: string, deps: MethodTableDeps): void {
  if (p.teamId !== undefined && p.teamId !== deps.teamId) {
    // 传输级路由自检（socket 已按 teamDir 寻址；错队 = 调用方 bug，不占域错误码）
    throw new Error(
      `rpc method ${method} targets team ${JSON.stringify(p.teamId)} but this coordinator serves ${JSON.stringify(deps.teamId)}`,
    );
  }
}

function requireSessionId(p: Record<string, unknown>, method: string): string {
  const v = p.session_id;
  if (typeof v !== "string" || v.length === 0) {
    throw new TeamError("TEAM_INVALID_ARGUMENT", `${method} param "session_id" is required`);
  }
  return v;
}

function requireString(
  p: Record<string, unknown>,
  key: string,
  method: string,
  opts: { allowEmpty?: boolean } = {},
): string {
  const v = p[key];
  if (typeof v !== "string" || (!opts.allowEmpty && v.length === 0)) {
    throw new TeamError(
      "TEAM_INVALID_ARGUMENT",
      `${method} param "${key}" must be a${opts.allowEmpty ? " string" : " non-empty string"}`,
    );
  }
  return v;
}

function optionalString(
  p: Record<string, unknown>,
  key: string,
  method: string,
  opts: { allowEmpty?: boolean; enum?: readonly string[] } = {},
): string | undefined {
  const v = p[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || (!opts.allowEmpty && v.length === 0)) {
    throw new TeamError(
      "TEAM_INVALID_ARGUMENT",
      `${method} param "${key}" must be a${opts.allowEmpty ? " string" : " non-empty string"}`,
    );
  }
  if (opts.enum !== undefined && !opts.enum.includes(v)) {
    throw new TeamError("TEAM_INVALID_ARGUMENT", `${method} param "${key}" must be one of ${opts.enum.join(", ")}`);
  }
  return v;
}

function optionalStringArray(p: Record<string, unknown>, key: string, method: string): string[] | undefined {
  const v = p[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((item) => typeof item !== "string")) {
    throw new TeamError("TEAM_INVALID_ARGUMENT", `${method} param "${key}" must be an array of strings`);
  }
  return v as string[];
}

/** 结构化模型选择（{providerId, modelId, options?: {reasoningLevel?}}）——形状由共享校验器冻结。 */
function optionalModelSelection(
  p: Record<string, unknown>,
  key: string,
  method: string,
): MemberModelSelection | undefined {
  const v = p[key];
  if (v === undefined) return undefined;
  const selection = parseModelSelection(v);
  if (selection === undefined) {
    throw new TeamError(
      "TEAM_INVALID_ARGUMENT",
      `${method} param "${key}" must be an object with providerId and modelId`,
    );
  }
  return selection;
}
