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
import { MAX_RPC_BUFFER_BYTES, type RpcServer } from "./rpc.js";
import type { ContentBlock, TeamTaskStatus } from "../domain/events.js";
import type { TaskAction } from "../domain/taskboard.js";
import type { TeammateProvider } from "../provider/teammate-provider.js";
import { parseModelSelection, type MemberModelSelection } from "../provider/model-selection.js";
import { isValidTimeout, noProgressResult } from "../domain/activity.js";
import { pendingLeadMessages, writeReceipts } from "../hooks/inbox.js";
import { teamPaths } from "./paths.js";

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
  dataRoot: string;
  warn?: (message: string) => void;
  teamId: string;
  runtime: TeamRuntime;
  store: JournalTeamStore;
  coordinatorBootId: string;
}

/** 真方法表（host 装配 + 进程内直执行共用一份）。键序即接口草案 §2 终版方法表。 */
export function buildTeamMethodTable(deps: MethodTableDeps): Map<string, TeamMethodHandler> {
  const { runtime, store } = deps;
  const { teamDir } = teamPaths(deps.dataRoot, deps.teamId);

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

  const memberSpawn: TeamMethodHandler = async (raw, ctx) => {
    const p = asParams(raw, "member.spawn");
    assertTeamTarget(p, "member.spawn", deps);
    const sessionId = requireSessionId(p, "member.spawn");
    const context = optionalString(p, "context", "member.spawn", { enum: ["fresh", "fork"] }) as
      | "fresh"
      | "fork"
      | undefined;
    // 0.4.0：成员模型没有独立配置通道（model/modelSelection/thoughtLevel 参数注销；
    // provider 在孵化前自动继承 Lead 最新已确认选择，不可继承 = 抛错）。
    return runtime.roster.spawnTeammate(sessionId, {
      // 空串下沉到域层：name → TEAM_INVALID_MEMBER_NAME；description → <field> must be non-empty。
      name: requireString(p, "name", "member.spawn", { allowEmpty: true }),
      description: requireString(p, "description", "member.spawn", { allowEmpty: true }),
      prompt: requireString(p, "prompt", "member.spawn", { allowEmpty: true }),
      ...(typeof p.requestId === "string" && p.requestId.length > 0 ? { requestId: p.requestId } : {}),
      ...(ctx?.signal !== undefined ? { signal: ctx.signal, ownershipSignal: ctx.signal } : {}),
      ...(context !== undefined ? { context } : {}),
    });
  };
  // 首轮持久接收等待最长 120s；服务端/客户端都必须给足裕量（不得先于域层超时）。
  memberSpawn.timeoutMs = 180_000;
  table.set("member.spawn", memberSpawn);

  // 0.4.0 注销 member.set_model（成员模型唯一路线 = 跟随 Lead；stage-8 原文见 traceability §18）。

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
    // 保持域层的参数/取消/关闭顺序；这些路径不得消费收件箱。
    if (!isValidTimeout(timeoutMs) || runtime.lifecycle.status !== "open") {
      return runtime.activity.waitForChange(sessionId, timeoutMs, ctx?.signal);
    }
    ctx?.signal?.throwIfAborted();
    runtime.lifecycle.runtimeSignal().throwIfAborted();
    const membership = requireMembership(membershipStateLoader(store), sessionId);
    const receiveMessages = (): { messages: string[]; receiptWarning?: string } => {
      ctx?.signal?.throwIfAborted();
      runtime.lifecycle.runtimeSignal().throwIfAborted();
      if (sessionId !== deps.teamId) return { messages: [] };
      const pending = pendingLeadMessages(teamDir, store.state());
      const messages: string[] = [];
      const messageIds: string[] = [];
      const receiptWarning = "收件回执持久化失败；本批正文已返回，未确认消息可能重复。";
      // 按 JSON 转义后的实际字节数分批；预留 RPC 外壳及回执异常提示，代理响应不得超限。
      let bytes = Buffer.byteLength(JSON.stringify({
        id: Number.MAX_SAFE_INTEGER, ok: true, result: { timedOut: false, messages: [], receiptWarning },
      })) + 1;
      for (const message of pending) {
        const size = Buffer.byteLength(JSON.stringify(message.text)) + (messages.length > 0 ? 1 : 0);
        if (bytes + size > MAX_RPC_BUFFER_BYTES) {
          if (messages.length === 0) throw new Error("单条成员消息超过收件箱响应上限，消息保持待收；请查看成员会话获取完整结果。");
          break;
        }
        bytes += size;
        messages.push(message.text);
        messageIds.push(message.messageId);
      }
      // 与 hook 共用持久回执；同步领取，协调者/代理的并发 wait 不会重复返回同一封。
      try {
        writeReceipts(deps.dataRoot, deps.teamId, messageIds, "wait_agent");
      } catch (err) {
        // 部分 append 已成功时不能丢弃正文改报纯 error，也不能截断多写者共享回执。
        try {
          deps.warn?.(`agent-team inbox receipt failed: ${err instanceof Error ? err.message : String(err)}`);
        } catch { /* 诊断文件也不可写时仍保留正文 */ }
        return { messages, receiptWarning };
      }
      return { messages };
    };
    const inbox = receiveMessages();
    if (inbox.messages.length > 0) return { timedOut: false, ...inbox };

    // 捷径在权威协调者评估，先交付消息，再判断成员是否还能产生进展。
    const rows = runtime.roster.listMembers(sessionId).members;
    if (!runtime.roster.hasPendingAutomaticProgress(sessionId)) {
      const stopped = rows.find((row) => row.status === "provisioning");
      if (stopped !== undefined) {
        const message = `成员 ${stopped.target} 已停止自动确认，需要 Lead 接管；旧 turn 仍可能执行，不得重复启动。`;
        return { ...noProgressResult(), noProgress: { reason: "no-active-peer", message }, content: [{ type: "text", text: message }] };
      }
      return noProgressResult();
    }
    const self = membership.role === "lead" ? "lead" : membership.name;
    if (!rows.some((row) => row.target !== self && (row.status === "running" || row.status === "provisioning"))) {
      return noProgressResult();
    }
    // 上面的读取、判断与此处登记等待全程同步，消息不会落在检查/登记的空隙。
    const result = await runtime.activity.waitForChange(sessionId, timeoutMs, ctx?.signal);
    if (runtime.lifecycle.status !== "open") return result;
    const received = receiveMessages();
    return received.messages.length > 0 ? { timedOut: false, ...received } : result;
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

