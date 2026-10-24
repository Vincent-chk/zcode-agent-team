// team_panel_call 处理器（面板唯一 server 调用通道；口径冻结于《接口草案》§5）：
//   {label?}                                   → 心跳/回环计数（stage-1 基线不回归，H12 载体）
//   {action:"refresh"}                         → 全量视图帧（断线重连/手动刷新）
//   {action:"detail", target, cursor?, limit?} → 成员会话查看视图（T5.7 detail 契约）
//   {action:"modelOptions", memberId?}         → 模型目录（+成员当前生效值与来源；stage-8 Round D）
//   {action:"setMemberModel", memberId, model?, thoughtLevel?} → 受控成员模型变更（stage-8 Round D）
//
// 〔stage-8 Round D 规格例外登记〕本通道历史上零变更能力（F07/F14）。Round D 经批准开一个
// **受控**变更动作 setMemberModel：仅 Lead 身份、仅 active teammate、复用 backend.setMemberModel
// （member.set_model 方法表通路，含目录消歧/校验/立即-or-pending 语义）；面板不新增任何
// 凭据输入。02 规格 §10.1/§10.6 的修订留 Round E 文档轮统一回写（TODO 登记）。
// 失败返回 {error:{code,message}}（可读原因，面板呈现可重试错误态，不静默）。
// daemon 接线：tools/call name==="team_panel_call" → handlePanelCall（本文件）。

import { TeamError } from "../domain/errors.js";
import { teamPaths } from "../coord/paths.js";
import { load } from "../coord/replay.js";
import { TranscriptReader } from "../provider/transcript.js";
import { resolveIdentity, type CallMeta, type ResolvedIdentity } from "../mcp/identity.js";
import { requireMembership } from "../domain/projection.js";
import { readModelCatalog } from "../provider/model-catalog.js";
import { memberPaths, readOrigin } from "../provider/member-files.js";
import type { ModelCatalog } from "../provider/model-catalog.js";
import type { TeamToolBackend } from "../mcp/backend.js";
import type { TeamState } from "../domain/projection.js";
import type { MemberModelCurrent, ModelSource } from "../ui-core/member-settings.js";
import { PanelViewService, resolveMemberSession } from "./view-service.js";
import { buildDetail, renderDetailText, SessionNotSettledError, type DetailResult } from "./detail.js";
import type { ViewFrame } from "../ui-core/view.js";

export type PanelCallArgs = {
  label?: unknown;
  action?: unknown;
  target?: unknown;
  cursor?: unknown;
  limit?: unknown;
  /** stage-8 D：成员设置（模型目录/变更）。 */
  memberId?: unknown;
  model?: unknown;
  thoughtLevel?: unknown;
};

export type PanelCallResult =
  | { kind: "heartbeat"; counter: number; ts: string; label: string | null }
  | { kind: "view"; frame: ViewFrame }
  | { kind: "detail"; detail: DetailResult }
  | { kind: "modelOptions"; memberId?: string; memberName?: string; catalog: ModelCatalog; current?: MemberModelCurrent }
  | { kind: "modelSet"; applied: "now" | "next-turn"; memberId: string }
  | { kind: "error"; code: string; message: string; reason?: string };

export interface PanelCallDeps {
  view: PanelViewService;
  dataRoot: string;
  bootTimeMs: number;
  /** db 探针（缺省 = 生产 db.sqlite；测试注入夹具库）。 */
  reader?: TranscriptReader;
  /** 心跳计数递增（daemon 侧 view.counter 同源，stage-1 语义保持）。 */
  bumpCounter: () => number;
  /** 模型变更通路（stage-8 D：daemon 注入同一 backend 实例）。 */
  backend?: TeamToolBackend;
  /** 模型目录（缺省 readModelCatalog；daemon 注入 mtime 缓存读器）。 */
  catalog?: () => ModelCatalog;
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
    if (action === "modelOptions") {
      return await buildModelOptions(deps, args, meta);
    }
    if (action === "setMemberModel") {
      return await applyMemberModel(deps, args, meta);
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

// ---------------------------------------------------------------- stage-8 D：模型设置

interface PanelMemberContext {
  identity: ResolvedIdentity;
  state: TeamState;
  teamDir: string;
}

/** 面板调用上下文：身份解析 → 重放态 → 成员资格（C5 fail-closed，与 detail 同口径）。 */
async function loadPanelMemberContext(deps: PanelCallDeps, meta: CallMeta | undefined): Promise<PanelMemberContext> {
  const identity = resolveIdentity({
    dataRoot: deps.dataRoot,
    meta,
    bootTimeMs: deps.bootTimeMs,
  });
  const paths = teamPaths(deps.dataRoot, identity.teamId);
  const loaded = await load(paths.teamDir, identity.teamId);
  requireMembership(() => {
    if (loaded.state.failure !== undefined) throw new Error(loaded.state.failure);
    return loaded.state;
  }, identity.agentId);
  return { identity, state: loaded.state, teamDir: paths.teamDir };
}

/** 成员 id → active teammate（不存在/failed/provisioning → TEAM_MEMBER_NOT_FOUND）。 */
function requireActiveMember(state: TeamState, memberId: string): { id: string; name: string } {
  const member = state.members.find((m) => m.id === memberId);
  if (member === undefined || member.phase !== "active") {
    throw new TeamError("TEAM_MEMBER_NOT_FOUND", `active teammate "${memberId}" not found`);
  }
  return { id: member.id, name: member.name };
}

/**
 * 当前生效模型 + 来源：origin 配置（explicit/inherited 权威）→ 会话库 setModel 条目
 * （observed：非本插件写入）→ 消息实测模型（observed）→ cli-default（无记录）。
 */
function currentModelOf(
  deps: PanelCallDeps,
  teamDir: string,
  dataRoot: string,
  memberId: string,
): MemberModelCurrent {
  const origin = readOrigin(memberPaths(teamDir, memberId));
  const sessionId = resolveMemberSession(teamDir, dataRoot, memberId);
  const reader = deps.reader ?? new TranscriptReader();
  if (origin?.modelSelection !== undefined) {
    const selection = origin.modelSelection;
    const source: ModelSource =
      origin.modelSource === "inherited" ? "inherited" : origin.modelSource === "explicit" ? "explicit" : "explicit";
    return {
      model: selection.modelId,
      providerId: selection.providerId,
      ...(selection.reasoningLevel !== undefined ? { reasoningLevel: selection.reasoningLevel } : {}),
      source,
    };
  }
  if (sessionId !== undefined) {
    const entry = reader.latestModelSelection(sessionId);
    if (entry !== undefined) {
      return {
        model: entry.modelId,
        providerId: entry.providerId,
        ...(entry.reasoningLevel !== undefined ? { reasoningLevel: entry.reasoningLevel } : {}),
        source: "observed",
      };
    }
    const observed = reader.latestModel(sessionId);
    if (observed !== undefined) return { model: observed, source: "observed" };
  }
  return { source: "cli-default" };
}

/** modelOptions：memberId 缺省 → 仅目录（面板全局刷新）；给定 → 目录 + 该成员当前值与来源。 */
async function buildModelOptions(
  deps: PanelCallDeps,
  args: PanelCallArgs,
  meta: CallMeta | undefined,
): Promise<Extract<PanelCallResult, { kind: "modelOptions" }>> {
  const catalog = (deps.catalog ?? (() => readModelCatalog()))();
  if (args.memberId === undefined) return { kind: "modelOptions", catalog };
  if (typeof args.memberId !== "string" || args.memberId.length === 0) {
    throw new TeamError("TEAM_INVALID_ARGUMENT", 'param "memberId" must be a non-empty string');
  }
  const ctx = await loadPanelMemberContext(deps, meta);
  const member = requireActiveMember(ctx.state, args.memberId);
  return {
    kind: "modelOptions",
    memberId: member.id,
    memberName: member.name,
    catalog,
    current: currentModelOf(deps, ctx.teamDir, deps.dataRoot, member.id),
  };
}

/** setMemberModel：受控变更（只有 Lead 身份；active teammate；复用 backend 通路）。 */
async function applyMemberModel(
  deps: PanelCallDeps,
  args: PanelCallArgs,
  meta: CallMeta | undefined,
): Promise<Extract<PanelCallResult, { kind: "modelSet" }>> {
  if (typeof args.memberId !== "string" || args.memberId.length === 0) {
    throw new TeamError("TEAM_INVALID_ARGUMENT", 'param "memberId" must be a non-empty string');
  }
  const hasModel = typeof args.model === "string" && args.model.length > 0;
  const hasLevel = typeof args.thoughtLevel === "string" && args.thoughtLevel.length > 0;
  if (args.model !== undefined && !hasModel) {
    throw new TeamError("TEAM_INVALID_ARGUMENT", 'param "model" must be a non-empty string');
  }
  if (args.thoughtLevel !== undefined && !hasLevel) {
    throw new TeamError("TEAM_INVALID_ARGUMENT", 'param "thoughtLevel" must be a non-empty string');
  }
  if (!hasModel && !hasLevel) {
    throw new TeamError("TEAM_INVALID_ARGUMENT", 'param "model" or "thoughtLevel" is required');
  }
  const backend = deps.backend;
  if (backend === undefined) {
    throw new TeamError("TEAM_INVALID_ARGUMENT", "model changes are unavailable in this panel session");
  }
  const ctx = await loadPanelMemberContext(deps, meta);
  const member = requireActiveMember(ctx.state, args.memberId);
  const applied = await backend.setMemberModel(ctx.identity, {
    target: member.name,
    ...(hasModel ? { model: args.model } : {}),
    ...(hasLevel ? { thoughtLevel: args.thoughtLevel } : {}),
  });
  return { kind: "modelSet", applied: applied.applied, memberId: member.id };
}

/** team-ctl transcript 的 CLI 渲染出口（F12；与面板 detail 同一合成函数）。 */
export function detailToText(detail: DetailResult, memberName: string): string {
  return renderDetailText(detail, memberName);
}
