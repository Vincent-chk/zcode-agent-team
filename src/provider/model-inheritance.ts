// 成员模型继承错误（0.4.0）：成员模型唯一路线 = 跟随 Lead 最新已确认选择。
// provider 层在解析/继承失败时抛出本类型；backend 捕获后转 TEAM_INVALID_ARGUMENT——
// message 原样透出给用户（Lead 会转述），绝不包装成「成功但降级」。
// 与「未持久接收」（TEAM_PROVISIONING_CONFLICT）区分：本错误 = 明确不可继承的原因。
// 0.4.1：可判出具体选择的失败（官方套餐/目录外/应用被拒）附带 selection——统一失败
// 记录路径（model-failed.json）用它做「相同选择暂停自动重试」的判定键；解析不出
// （三源全空）时无选择可记，仅抛错透出。

import type { MemberModelSelection } from "./model-selection.js";

/** Lead 模型选择不可继承（官方套餐 / 目录外 / 解析不出 / setModel 被拒）。 */
export class ModelInheritanceError extends Error {
  constructor(
    message: string,
    /** 失败指向的具体选择（可判出才有；失败记录/重试抑制的判定键）。 */
    readonly selection?: MemberModelSelection,
  ) {
    super(message);
    this.name = "ModelInheritanceError";
  }
}

/**
 * 重试闸拦截（0.4.1）：同一 Lead 选择的失败已有记录且未到重试时机/已耗尽退避——本次
 * **不发起** setModel。deliver 捕获后按 "queued" 静默滞留（消息保留，等解锁）；
 * 与首次失败的 ModelInheritanceError 区分（首次必须透出给调用方）。
 */
export class ModelSyncSuppressedError extends ModelInheritanceError {
  constructor(message: string, selection?: MemberModelSelection) {
    super(message, selection);
    this.name = "ModelSyncSuppressedError";
  }
}

/** spawn 前置校验能力（0.4.1；roster 在成员登记**之前**调用，配置错误不占成员名/不建隐藏会话）。 */
export interface ModelPreflight {
  /** Lead 模型不可继承（解析不出/官方套餐/目录外）→ 抛 ModelInheritanceError（message 原样透出）。 */
  preflightMemberModel(): void;
}

/** spawn 前置校验能力探测（roster/host 接线用；MockProvider 等无此能力 = 跳过预检）。 */
export function providerHasModelPreflight(provider: object): provider is ModelPreflight {
  return typeof (provider as { preflightMemberModel?: unknown }).preflightMemberModel === "function";
}

/** Lead 选择指纹（失败记录的「相同选择」判定键；档位参与——仅档位变化也算换选择）。 */
export function selectionSignature(selection: MemberModelSelection): string {
  return `${selection.providerId}$${selection.modelId}$${selection.reasoningLevel ?? ""}`;
}

/**
 * 应用失败分类（0.4.1 重试控制）：基础设施/时序类 = transient（退避重试）；
 * 其余（宿主明确拒绝该模型、注册表不存在等）= deterministic（相同选择暂停自动重试）。
 * 判据来自 app-server 客户端与 breeder 的已知错误文本形态（timeout/ready/spawn/exited/
 * ENOENT/EACCES/closed/socket）。
 */
export function classifyApplyFailure(reason: string): "deterministic" | "transient" {
  return /timeout|did not become ready|timed out|spawn|exited|ENOENT|EACCES|ECONNREFUSED|EPIPE|socket hang up|client (is )?closed/i.test(
    reason,
  )
    ? "transient"
    : "deterministic";
}

/** 解析失败分类：三源全空（无法确定 Lead 模型）= transient（Lead 提交后自然可解）；套餐/目录外 = deterministic。 */
export function classifySelectionFailure(message: string): "deterministic" | "transient" {
  return /无法确定 Lead 当前模型/.test(message) ? "transient" : "deterministic";
}
