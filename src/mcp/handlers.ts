// 工具面 MCP 胶水层（stage-3 T3.1/T3.2）：callTool → 身份解析 → 后端操作 → 结果整形。
// 输出纪律（冻结）：
//  - 成功 = 单 text 块紧凑 JSON（JSON.stringify 无缩进；F02）；
//  - 失败 = isError:true + 单 text 块 {"error":{"code","message"}}（TeamError code 透传，
//    供模型自恢复；F07）；非 TeamError 不贴假 code；
//  - fail-loud（D10）：本会话 hook 未注册 → 结果追加一个独立 text 警告行（不改 JSON schema）。
//
// 身份三分支（F12）由 identity.resolveIdentity 承担；TEAM_NOT_MEMBER 走错误透传路径。
// 本层只做 snake_case → 域参数的**改名直传**（T3.2「分页/CAS 逐字」）：不做类型 coercion——
// 一切参数守卫在方法表（src/coord/methods.ts requireString/optionalStringArray 冻结消息）与
// 域五件套（不重复、不放宽、不静默吞掉类型错）。

import { TeamError } from "../domain/errors.js";
import type { CallToolResult } from "./results.js";
import { errorResult, successResult, withFailLoud } from "./results.js";
import { resolveIdentity, type CallMeta, type ResolvedIdentity } from "./identity.js";
import type { ProgressSink, TeamToolBackend } from "./backend.js";
import { TEAM_TOOL_NAMES } from "./tools.js";

export interface HandleToolOptions {
  backend: TeamToolBackend;
  dataRoot: string;
  bootTimeMs: number;
  /** 调用方 _meta（callTool params._meta 原样）。 */
  meta: CallMeta | undefined;
  /** 工具参数（callTool params.arguments 原样；守卫在方法表/域层）。 */
  args: Record<string, unknown>;
  /** progress 发射口（wait_agent 保活；宿主 progressToken 在场时由 server 层提供）。 */
  emitProgress?: ProgressSink;
  /** MCP 请求取消信号（wait_agent 透传；宿主取消时中止等待）。 */
  signal?: AbortSignal;
  now?: () => number;
}

/** 工具分发（10 工具；未知工具 → 可读错误，不贴假 code）。 */
export async function handleTeamToolCall(
  opts: HandleToolOptions,
  tool: string,
): Promise<CallToolResult> {
  let identity: ResolvedIdentity;
  try {
    identity = resolveIdentity({
      dataRoot: opts.dataRoot,
      meta: opts.meta,
      bootTimeMs: opts.bootTimeMs,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
  } catch (err) {
    return errorResult(err); // fail-closed：TEAM_NOT_MEMBER（identity 层抛）
  }
  try {
    const result = await dispatch(opts, identity, tool);
    return withFailLoud(successResult(result), identity);
  } catch (err) {
    return withFailLoud(errorResult(err), identity);
  }
}

/**
 * 逐工具改名直传（02 §9.3–§9.12 snake_case → 接口草案 §2 方法参数）。args 原值透传：
 * 缺参/类型错/枚举错 → 方法表冻结消息（TEAM_INVALID_ARGUMENT）；域校验（名字/限额/CAS/
 * 依赖图/超时域）→ 域层逐字错误。
 * 两处例外（登记于开发记录）：
 *  - wait_agent 的 timeout_ms：非数值需工具面守卫（否则方法表缺省化 30000），报
 *    TEAM_INVALID_TIMEOUT 逐字（backend.waitAgent 承担）；
 *  - 下游方法表**无守卫**的可选过滤字段（message/ready/cursor/limit/status）：工具面
 *    类型守卫（消息 = 工具面冻结口径 `param "<k>" must be …`），防止静默吞类型错。
 */
async function dispatch(
  opts: HandleToolOptions,
  identity: ResolvedIdentity,
  tool: string,
): Promise<unknown> {
  const { backend, args } = opts;
  switch (tool) {
    case "spawn_teammate":
      // 输出 = {member:MEMBER_VIEW}（02 §9.3；方法表结果原样即此形，target 改名在域层）
      return backend.spawnTeammate(identity, {
        name: args.name,
        description: args.description,
        prompt: args.prompt,
        ...(args.context !== undefined ? { context: args.context } : {}),
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.thoughtLevel !== undefined ? { thoughtLevel: args.thoughtLevel } : {}),
      });
    case "send_message":
      guardNonEmptyString(args.message, "message");
      return backend.sendMessage(identity, { target: args.target, message: args.message });
    case "list_agents":
      return backend.listAgents(identity);
    case "interrupt_agent":
      // 〔对齐轮〕0.2.1 D3：interrupt=false 时工具未注册 → 按未知工具拒绝（不静默、不贴假 code）
      if (!backend.interruptEnabled) throw new TypeError("unsupported team tool: interrupt_agent");
      return backend.interruptAgent(identity, { target: args.target });
    case "member_set_model":
      // 02 §9.13：model / thoughtLevel 至少一项（JSON Schema 无法表达 oneOf 必填 → 工具面守卫）
      if (args.model === undefined && args.thoughtLevel === undefined) {
        throw invalidArg('param "model" or "thoughtLevel" is required');
      }
      return backend.setMemberModel(identity, {
        target: args.target,
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.thoughtLevel !== undefined ? { thoughtLevel: args.thoughtLevel } : {}),
      });
    case "wait_agent":
      return backend.waitAgent(
        identity,
        { ...(args.timeout_ms !== undefined ? { timeout_ms: args.timeout_ms } : {}), },
        opts.emitProgress,
        opts.signal,
      );
    case "team_task_create":
      return backend.taskCreate(identity, {
        subject: args.subject,
        description: args.description,
        ...(args.blocked_by !== undefined ? { blocked_by: args.blocked_by } : {}),
        ...(args.write_scopes !== undefined ? { write_scopes: args.write_scopes } : {}),
      });
    case "team_task_list":
      if (args.ready !== undefined && typeof args.ready !== "boolean") {
        throw invalidArg('param "ready" must be a boolean');
      }
      if (args.cursor !== undefined) guardSafeInteger(args.cursor, "cursor");
      if (args.limit !== undefined) guardSafeInteger(args.limit, "limit");
      if (
        args.status !== undefined &&
        args.status !== "pending" &&
        args.status !== "in_progress" &&
        args.status !== "completed"
      ) {
        throw invalidArg('param "status" must be one of pending, in_progress, completed');
      }
      return backend.taskList(identity, {
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.owner !== undefined ? { owner: args.owner } : {}),
        ...(args.ready !== undefined ? { ready: args.ready } : {}),
        ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
    case "team_task_get":
      return backend.taskGet(identity, { task_id: args.task_id });
    case "team_task_update":
      return backend.taskUpdate(identity, {
        task_id: args.task_id,
        expected_revision: args.expected_revision,
        action: args.action,
        ...(args.subject !== undefined ? { subject: args.subject } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.blocked_by !== undefined ? { blocked_by: args.blocked_by } : {}),
        ...(args.write_scopes !== undefined ? { write_scopes: args.write_scopes } : {}),
        ...(args.owner !== undefined ? { owner: args.owner } : {}),
      });
    default:
      throw new TypeError(`unsupported team tool: ${tool}`);
  }
}

// ---------------------------------------------------------------- 工具面类型守卫（下游无守卫的字段）

function invalidArg(message: string): TeamError {
  return new TeamError("TEAM_INVALID_ARGUMENT", message);
}

function guardNonEmptyString(v: unknown, key: string): void {
  if (typeof v !== "string" || v.length === 0) {
    throw invalidArg(`param "${key}" must be a non-empty string`);
  }
}

function guardSafeInteger(v: unknown, key: string): void {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) {
    throw invalidArg(`param "${key}" must be a safe integer`);
  }
}

/** 工具名判定（daemon 分派用）。 */
export function isTeamTool(name: string): boolean {
  return TEAM_TOOL_NAMES.has(name);
}
