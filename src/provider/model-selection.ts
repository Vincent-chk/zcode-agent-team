// 模型选择（stage-8 Round B）：单一结构化三元组 + 字符串规格解析/形状校验。
// 生效机制是会话库 session_entry(type='runtime/model_selection')（Round A PoC 实证：setModel 落
// UPSERT 单行，headless --resume 每轮恢复）。本模块只做纯数据校验，不读配置、不碰协议。

/** 成员模型选择（provider + model + 可选思考强度）。 */
export interface MemberModelSelection {
  providerId: string;
  modelId: string;
  /** 思考强度（宿主 reasoningLevel；缺省 = 模型默认档）。 */
  reasoningLevel?: string;
}

/** 档位缺省链终点（模型未知档位且无 defaultVariant 时使用；E-1 实测 deepseek-flash 必带档位）。
 *  放在纯类型模块里：ui-core（浏览器 bundle）也要用，不能把 node:fs 依赖带进前端。 */
export const DEFAULT_REASONING_LEVEL = "max";

/** `providerId$modelId` 的解析结果；裸 modelId 的 provider 由调用方按模型目录消歧（Round C）。 */
export type ModelSpec = { providerId: string; modelId: string } | { modelId: string };

/** 解析字符串规格：首个 `$` 切分；裸 id 返回 `{ modelId }` 交给目录消歧。 */
export function parseModelSpec(spec: string): ModelSpec {
  const trimmed = spec.trim();
  if (trimmed.length === 0) throw new Error("model spec is empty");
  const cut = trimmed.indexOf("$");
  if (cut < 0) return { modelId: trimmed };
  const providerId = trimmed.slice(0, cut).trim();
  const modelId = trimmed.slice(cut + 1).trim();
  if (providerId.length === 0 || modelId.length === 0) {
    throw new Error(`invalid model spec "${trimmed}": providerId and modelId are both required`);
  }
  return { providerId, modelId };
}

/**
 * 协议/落库三元组的形状校验：providerId/modelId 必填，options.reasoningLevel 可选。
 * 未知形状返回 undefined（只读探针不因脏行抛错；写入口由调用方决定是否 fail-fast）。
 */
export function parseModelSelection(value: unknown): MemberModelSelection | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const providerId = nonEmptyString(record.providerId);
  const modelId = nonEmptyString(record.modelId);
  if (providerId === undefined || modelId === undefined) return undefined;
  const options = record.options;
  if (options !== undefined && (typeof options !== "object" || options === null || Array.isArray(options))) {
    return undefined;
  }
  let reasoningLevel: string | undefined;
  // 线形状 = options.reasoningLevel；平铺 reasoningLevel 是内部 pending 文件/便捷入参的容错形态。
  const rawLevel =
    options !== undefined
      ? (options as Record<string, unknown>).reasoningLevel
      : record.reasoningLevel;
  if (rawLevel !== undefined) {
    reasoningLevel = nonEmptyString(rawLevel);
    if (reasoningLevel === undefined) return undefined;
  }
  return { providerId, modelId, ...(reasoningLevel !== undefined ? { reasoningLevel } : {}) };
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
