// 10 工具注册表（stage-3 T3.1；stage-8 Round C 追加 member_set_model）。
// tools/list = TEAM_TOOL_DEFINITIONS 原样（F01 快照同源；顺序冻结）；
// tools/call = 身份解析 → 后端操作 → 结果整形（handlers/results）。
// progress 保活：宿主 _meta.progressToken 在场且工具为 wait_agent 时，提供 emitProgress
// （经 notifier 发 notifications/progress 携带 progressToken；宿主 resetTimeoutOnProgress:true
// 重置计时——stage-1 已证实 + 2026-10-16 bundle 现场核实）。
//
// 冷启动即服务：registry 不预热；backend 按 teamId 惰性 open（首调即开）。

import type { CallToolResult } from "./results.js";
import { teamToolDefinitions } from "./tools.js";
import { handleTeamToolCall, isTeamTool } from "./handlers.js";
import type { CallMeta } from "./identity.js";
import type { ProgressSink, TeamToolBackend } from "./backend.js";

/** progress 发射通道（daemon 从 MCP extra.sendNotification 适配；结构型最小面）。 */
export interface ProgressNotifier {
  sendNotification(notification: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; message?: string };
  }): Promise<void>;
}

/** tools/list 条目（10 工具；〔对齐轮〕interrupt=false 时 9 工具；与快照生成器同源同序列化器）。 */
export function listTeamTools(options: { interrupt?: boolean } = {}): readonly Record<string, unknown>[] {
  return teamToolDefinitions(options).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t._meta !== undefined ? { _meta: t._meta } : {}),
  }));
}

export interface CallTeamToolInput {
  backend: TeamToolBackend;
  dataRoot: string;
  bootTimeMs: number;
  name: string;
  args: Record<string, unknown>;
  meta: CallMeta | undefined;
  signal?: AbortSignal;
  now?: () => number;
}

/** tools/call 分派（仅 10 工具；team_ping/panel 由 daemon 自处理，不走本函数）。 */
export async function callTeamTool(
  input: CallTeamToolInput,
  notifier?: ProgressNotifier,
): Promise<CallToolResult> {
  const emitProgress = buildProgressSink(input, notifier);
  return handleTeamToolCall(
    {
      backend: input.backend,
      dataRoot: input.dataRoot,
      bootTimeMs: input.bootTimeMs,
      meta: input.meta,
      args: input.args,
      ...(emitProgress !== undefined ? { emitProgress } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.now !== undefined ? { now: input.now } : {}),
    },
    input.name,
  );
}

/**
 * wait_agent 保活 progress 发射口：宿主 progressToken 在场才发（否则宿主不接收 progress）。
 * 返回 undefined = 不发（非 wait_agent / 无 progressToken / 无 notifier）。
 */
function buildProgressSink(
  input: CallTeamToolInput,
  notifier?: ProgressNotifier,
): ProgressSink | undefined {
  if (input.name !== "wait_agent") return undefined;
  const token = input.meta?.progressToken;
  if (notifier === undefined || token === undefined) return undefined;
  if (typeof token !== "string" && typeof token !== "number") return undefined;
  return async (progress: number, message?: string) => {
    try {
      await notifier.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress,
          ...(message !== undefined ? { message } : {}),
        },
      });
    } catch {
      /* progress 发射失败不影响等待本体（保活是尽力而为） */
    }
  };
}

export { isTeamTool };
