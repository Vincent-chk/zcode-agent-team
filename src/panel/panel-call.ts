// team_panel_call 处理器（面板唯一 server 调用通道；口径冻结于《接口草案》§5）：
//   {label?}                                   → 心跳/回环计数（stage-1 基线不回归，H12 载体）
//   {action:"refresh"}                         → 全量视图帧（断线重连/手动刷新）
//   {action:"detail", target, cursor?, limit?} → 成员会话查看视图（T5.7 detail 契约）
// 只读口径：本通道零变更能力（F07/F14）；失败返回 {error:{code,message}}（可读原因，
// 面板呈现加载态并可重试，不静默）。
// daemon 接线：tools/call name==="team_panel_call" → handlePanelCall（本文件）。

import { TeamError } from "../domain/errors.js";
import { teamPaths } from "../coord/paths.js";
import { load } from "../coord/replay.js";
import { TranscriptReader } from "../provider/transcript.js";
import { resolveIdentity, type CallMeta } from "../mcp/identity.js";
import { requireMembership } from "../domain/projection.js";
import { PanelViewService, resolveMemberSession } from "./view-service.js";
import { buildDetail, renderDetailText, SessionNotSettledError, type DetailResult } from "./detail.js";
import type { ViewFrame } from "../ui-core/view.js";

export type PanelCallArgs = {
  label?: unknown;
  action?: unknown;
  target?: unknown;
  cursor?: unknown;
  limit?: unknown;
};

export type PanelCallResult =
  | { kind: "heartbeat"; counter: number; ts: string; label: string | null }
  | { kind: "view"; frame: ViewFrame }
  | { kind: "detail"; detail: DetailResult }
  | { kind: "error"; code: string; message: string; reason?: string };

export interface PanelCallDeps {
  view: PanelViewService;
  dataRoot: string;
  bootTimeMs: number;
  /** db 探针（缺省 = 生产 db.sqlite；测试注入夹具库）。 */
  reader?: TranscriptReader;
  /** 心跳计数递增（daemon 侧 view.counter 同源，stage-1 语义保持）。 */
  bumpCounter: () => number;
  now?: () => string;
  warn?: (message: string) => void;
}

export async function handlePanelCall(
  deps: PanelCallDeps,
  args: PanelCallArgs,
  meta: CallMeta | undefined,
): Promise<PanelCallResult> {
  const action = typeof args.action === "string" ? args.action : undefined;
  const label = typeof args.label === "string" ? args.label : null;

  // 无 action（stage-1 心跳/回环基线）：计数 + 应答（H12 心跳载体语义不变）
  if (action === undefined || action === "heartbeat") {
    return { kind: "heartbeat", counter: deps.bumpCounter(), ts: now(deps), label };
  }

  try {
    if (action === "refresh") {
      const frame = await deps.view.buildFrame(meta);
      return { kind: "view", frame };
    }
    if (action === "detail") {
      if (typeof args.target !== "string" || args.target.length === 0) {
        throw new TeamError("TEAM_INVALID_ARGUMENT", 'param "target" must be a non-empty string');
      }
      return { kind: "detail", detail: await buildDetailCall(deps, args, meta) };
    }
    throw new TeamError("TEAM_INVALID_ARGUMENT", `unknown panel action "${String(action)}"`);
  } catch (err) {
    if (err instanceof TeamError) {
      // reason = 面板可读态细分（session-not-settled → detail.noSession 文案；契约错误码
      // 子集与逐字消息不变，reason 为附加诊断字段）
      const reason = err instanceof SessionNotSettledError ? "session-not-settled" : undefined;
      return { kind: "error", code: err.code, message: err.message, ...(reason !== undefined ? { reason } : {}) };
    }
    const message = err instanceof Error ? err.message : String(err);
    deps.warn?.(`panel call failed: ${message}`);
    // 非 TeamError 不贴假 code（stage-3 纪律）：code 缺省，message 可读
    return { kind: "error", code: "", message };
  }
}

/** detail 全链：身份解析 → 重放态（framed 回填源）→ 合成（db 只读 + 徽标回填）。 */
async function buildDetailCall(
  deps: PanelCallDeps,
  args: PanelCallArgs,
  meta: CallMeta | undefined,
): Promise<DetailResult> {
  const identity = resolveIdentity({
    dataRoot: deps.dataRoot,
    meta,
    bootTimeMs: deps.bootTimeMs,
  });
  const paths = teamPaths(deps.dataRoot, identity.teamId);
  const loaded = await load(paths.teamDir, identity.teamId);
  // detail 读取成员 transcript：调用者必须是本团队成员（C5 fail-closed 口径）。
  requireMembership(() => {
    if (loaded.state.failure !== undefined) throw new Error(loaded.state.failure);
    return loaded.state;
  }, identity.agentId);
  const reader = deps.reader ?? new TranscriptReader();
  const cursor = typeof args.cursor === "number" ? args.cursor : undefined;
  const limit = typeof args.limit === "number" ? args.limit : undefined;
  return buildDetail(
    { teamDir: paths.teamDir, teamId: identity.teamId, state: loaded.state, reader },
    {
      target: args.target as string,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    },
    (memberId) => resolveMemberSession(paths.teamDir, deps.dataRoot, memberId),
  );
}

function now(deps: PanelCallDeps): string {
  return deps.now !== undefined ? deps.now() : new Date().toISOString();
}

/** team-ctl transcript 的 CLI 渲染出口（F12；与面板 detail 同一合成函数）。 */
export function detailToText(detail: DetailResult, memberName: string): string {
  return renderDetailText(detail, memberName);
}
