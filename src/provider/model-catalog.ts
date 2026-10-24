// 模型目录（stage-8 Round C；E-1b 目录源 v2）：主源 = 运行时 Provider Registry
// （`~/.zcode/v2/provider_config.json`），回退 = `~/.zcode/v2/config.json` 白名单投影。
//
// 为什么换源（E-1 实测）：`session/setModel` 只认 Registry 的 `providerOrder`；config.json 里
// builtin:*/计划型 provider 一律被服务端拒（"Provider Registry 中不存在 Model"），account: 形态
// 也不在 providerOrder。目录若与注册表不同源，弹窗与裸 id 消歧会把**必然失败**的组合推给用户。
//
// 安全红线：provider_config.json 含明文 apiKey —— 本模块按字段白名单构造输出（providerId /
// providerName / api.type / modelOrder / model enabled / reasoning 档位），`access`、`api.baseUrl`
// 等连接凭据**结构上不可能**进入输出；新增未知字段天然不会泄漏。
//
// 容错（配置漂移）：provider_config 不可读/结构不符 → 回退 config.json 投影（兼容无该文件环境）；
// 两者都不可用 → 空目录 + error（daemon 记 warn；backend 降级为「目录不可用」）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MemberModelSelection } from "./model-selection.js";
import { DEFAULT_REASONING_LEVEL } from "./model-selection.js";

export { DEFAULT_REASONING_LEVEL };

export interface CatalogModel {
  id: string;
  /** 该 provider+model 是否启用（Registry 规则；缺省视为启用）。 */
  enabled?: boolean;
  reasoning?: { variants: string[]; defaultVariant?: string };
}

export interface CatalogProvider {
  providerId: string;
  name: string;
  kind: string;
  enabled: boolean;
  /** 仅 enabled=false 时出现（宿主 disabledReason 或 "disabled"）。 */
  disabledReason?: string;
  models: CatalogModel[];
}

export interface ModelCatalog {
  providers: CatalogProvider[];
}

export interface ModelCatalogResult {
  catalog: ModelCatalog;
  /** 实际使用的目录源（provider-config = 注册表；config-json = 回退）。 */
  source: "provider-config" | "config-json";
  /** 两个源都不可用时的原因。 */
  error?: string;
  /** 主源不可用但回退成功时的诊断（daemon 记 warn；不影响目录可用性）。 */
  warning?: string;
}

/** 档位缺省链终点见 model-selection.ts（纯模块，ui-core 共用；此处仅 re-export）。 */

export function defaultModelConfigPath(homedir: string = os.homedir()): string {
  return path.join(homedir, ".zcode", "v2", "config.json");
}

/** 运行时 Provider Registry（setModel 的真正权威源）。 */
export function defaultProviderConfigPath(homedir: string = os.homedir()): string {
  return path.join(homedir, ".zcode", "v2", "provider_config.json");
}

/** 目录 + 读取诊断（daemon 资源读用它落 warn；业务侧用 readModelCatalog）。 */
export function readModelCatalogDetailed(homedir: string = os.homedir()): ModelCatalogResult {
  const registry = readRegistryCatalog(homedir);
  if ("catalog" in registry) {
    return { catalog: registry.catalog, source: "provider-config" };
  }
  const registryError = "error" in registry ? registry.error : undefined;
  const legacy = readLegacyCatalog(homedir);
  return {
    ...legacy,
    source: "config-json",
    ...(legacy.error !== undefined
      ? { error: registryError !== undefined ? `${registryError}; ${legacy.error}` : legacy.error }
      : registryError !== undefined
        ? { warning: registryError }
        : {}),
  };
}

export function readModelCatalog(homedir: string = os.homedir()): ModelCatalog {
  return readModelCatalogDetailed(homedir).catalog;
}

export interface ModelCatalogReader {
  (): ModelCatalog;
  /** 最近一次读取错误（成功读取后清空；诊断用）。 */
  lastError(): string | undefined;
}

/**
 * mtime 缓存读器（daemon 的 team://models 资源用）：两个源文件的 mtime+size 未变 → 返回缓存；
 * 变化/缺失 → 重读。读取错误经 onError 上报（daemon 记 warn），不抛。
 */
export function createModelCatalogReader(
  homedir: string = os.homedir(),
  onError?: (message: string) => void,
): ModelCatalogReader {
  const watched = [defaultProviderConfigPath(homedir), defaultModelConfigPath(homedir)];
  let key: string | null = null;
  let cached: ModelCatalog = { providers: [] };
  let error: string | undefined;
  const reader = (() => {
    const parts = watched.map((file) => {
      try {
        const stat = fs.statSync(file);
        return `${file}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return `${file}:missing`;
      }
    });
    const nextKey = parts.join("|");
    if (nextKey === key) return cached;
    const result = readModelCatalogDetailed(homedir);
    error = result.error;
    const diagnose = result.error ?? result.warning;
    if (diagnose !== undefined) onError?.(diagnose);
    key = nextKey;
    cached = result.catalog;
    return cached;
  }) as ModelCatalogReader;
  reader.lastError = () => error;
  return reader;
}

/** 目录中某 provider（不存在 → undefined）。 */
export function findCatalogProvider(catalog: ModelCatalog, providerId: string): CatalogProvider | undefined {
  return catalog.providers.find((p) => p.providerId === providerId);
}

/** 目录中某 provider 的模型（不存在 → undefined）。 */
export function findCatalogModel(
  catalog: ModelCatalog,
  providerId: string,
  modelId: string,
): CatalogModel | undefined {
  return findCatalogProvider(catalog, providerId)?.models.find((m) => m.id === modelId);
}

/** 提供该 modelId 的 **enabled** providerId 列表（裸 id 消歧用；disabled 模型不算）。 */
export function enabledProvidersOffering(catalog: ModelCatalog, modelId: string): string[] {
  return catalog.providers
    .filter((p) => p.enabled && p.models.some((m) => m.id === modelId && m.enabled !== false))
    .map((p) => p.providerId);
}

/** 模型可用思考强度档位（无 reasoning 元数据 → undefined = 未知）。 */
export function reasoningVariantsOf(model: CatalogModel | undefined): string[] | undefined {
  return model?.reasoning?.variants;
}

/**
 * 档位缺省链（E-1b）：`defaultVariant`（目录有则用）→ "max"（已知 variants 里没有 max 时取首档）
 * → 未知档位直接 "max"。统一在 provider 层应用（resume-provider），backend 只做校验。
 */
export function defaultReasoningLevel(
  catalog: ModelCatalog,
  providerId: string,
  modelId: string,
): string {
  const model = findCatalogModel(catalog, providerId, modelId);
  const variants = model?.reasoning?.variants;
  const preferred = model?.reasoning?.defaultVariant;
  if (preferred !== undefined && (variants === undefined || variants.includes(preferred))) return preferred;
  if (variants === undefined) return DEFAULT_REASONING_LEVEL;
  return variants.includes(DEFAULT_REASONING_LEVEL)
    ? DEFAULT_REASONING_LEVEL
    : (variants[0] ?? DEFAULT_REASONING_LEVEL);
}

/** 应用档位缺省（已有 reasoningLevel 时原样保留）。 */
export function applyReasoningDefault(
  catalog: ModelCatalog,
  selection: MemberModelSelection,
): MemberModelSelection {
  if (selection.reasoningLevel !== undefined) return selection;
  return {
    ...selection,
    reasoningLevel: defaultReasoningLevel(catalog, selection.providerId, selection.modelId),
  };
}

// ---------------------------------------------------------------- 主源：Provider Registry

interface RegistryModelRule {
  enabled?: unknown;
  optionSpecs?: unknown;
}

type RegistryRead =
  | { catalog: ModelCatalog }
  | { missing: true }
  | { error: string };

function readRegistryCatalog(homedir: string): RegistryRead {
  const file = defaultProviderConfigPath(homedir);
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { missing: true };
    return { error: `provider registry unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
  const config = (doc as { config?: unknown } | null)?.config;
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return { error: "provider registry unavailable: config is not an object" };
  }
  const cfg = config as Record<string, unknown>;
  const order = cfg.providerOrder;
  const rules = (cfg.providerConfigRules as { providerRules?: unknown } | undefined)?.providerRules;
  if (!Array.isArray(order) || !Array.isArray(rules)) {
    return { error: "provider registry unavailable: providerOrder/providerRules is not an array" };
  }
  const ruleById = new Map<string, Record<string, unknown>>();
  for (const raw of rules) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const rule = raw as Record<string, unknown>;
    const providerId = nonEmpty(rule.providerId);
    if (providerId !== undefined) ruleById.set(providerId, rule);
  }
  const modelRules = registryModelRules(cfg);
  const legacyReasoning = readLegacyReasoning(homedir);

  const providers: CatalogProvider[] = [];
  const seen = new Set<string>();
  for (const rawId of order) {
    const providerId = nonEmpty(rawId);
    if (providerId === undefined || seen.has(providerId)) continue;
    seen.add(providerId);
    const rule = ruleById.get(providerId);
    const ruleConfig = recordOf(rule?.config);
    const models: CatalogModel[] = [];
    const modelSeen = new Set<string>();
    for (const rawModel of arrayOf(ruleConfig?.modelOrder)) {
      const id = nonEmpty(rawModel);
      if (id === undefined || modelSeen.has(id)) continue;
      modelSeen.add(id);
      const ruleConfigForModel = modelRules.get(modelKey(providerId, id));
      const enabled = ruleConfigForModel?.enabled !== false;
      const reasoning =
        legacyReasoning.get(modelKey(providerId, id)) ?? registryReasoning(ruleConfigForModel);
      models.push({
        id,
        enabled,
        ...(reasoning !== undefined ? { reasoning } : {}),
      });
    }
    providers.push({
      providerId,
      name: nonEmpty(rule?.providerName) ?? providerId,
      // api.type 是协议族（anthropic/openai-responses…）——只取该字符串，绝不带 baseUrl。
      kind: nonEmpty(recordOf(ruleConfig?.api)?.type) ?? "unknown",
      enabled: true,
      models,
    });
  }
  return { catalog: { providers } };
}

function registryModelRules(cfg: Record<string, unknown>): Map<string, RegistryModelRule> {
  const rules = (cfg.modelConfigRules as { providerModelRules?: unknown } | undefined)?.providerModelRules;
  const out = new Map<string, RegistryModelRule>();
  for (const raw of arrayOf(rules)) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const rule = raw as Record<string, unknown>;
    const providerId = nonEmpty(rule.providerId);
    const modelId = nonEmpty(rule.modelId);
    if (providerId === undefined || modelId === undefined) continue;
    out.set(modelKey(providerId, modelId), recordOf(rule.config) ?? {});
  }
  return out;
}

/** Registry 的档位元数据：optionSpecs.reasoningLevel.values（仅 variants，无 defaultVariant）。 */
function registryReasoning(rule: RegistryModelRule | undefined): CatalogModel["reasoning"] | undefined {
  const specs = recordOf(rule?.optionSpecs);
  const level = recordOf(specs?.reasoningLevel);
  return catalogReasoning({ variants: level?.values });
}

// ---------------------------------------------------------------- 回退源：config.json 投影

function readLegacyCatalog(homedir: string): { catalog: ModelCatalog; error?: string } {
  const file = defaultModelConfigPath(homedir);
  const doc = readJsonOrUndefined(file);
  if ("error" in doc) {
    return { catalog: { providers: [] }, error: `model catalog unavailable: ${doc.error}` };
  }
  const rawProviders = (doc.value as { provider?: unknown } | null)?.provider;
  if (rawProviders === null || typeof rawProviders !== "object" || Array.isArray(rawProviders)) {
    return { catalog: { providers: [] }, error: "model catalog unavailable: config.provider is not an object" };
  }
  const providers: CatalogProvider[] = [];
  for (const [providerId, raw] of Object.entries(rawProviders as Record<string, unknown>)) {
    if (providerId.length === 0 || raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const enabled = record.enabled !== false;
    const disabledReason = enabled ? undefined : nonEmpty(record.systemDisabledReason) ?? "disabled";
    providers.push({
      providerId,
      name: nonEmpty(record.name) ?? providerId,
      kind: nonEmpty(record.kind) ?? "unknown",
      enabled,
      ...(disabledReason !== undefined ? { disabledReason } : {}),
      models: legacyModels(record.models),
    });
  }
  return { catalog: { providers } };
}

function legacyModels(raw: unknown): CatalogModel[] {
  const models: CatalogModel[] = [];
  // 宿主形态 = {modelId: {...}}；数组形态是容错兜底（漂移时不至于整个目录为空）。
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
      const model = legacyModel(id, value);
      if (model !== undefined) models.push(model);
    }
    return models;
  }
  if (Array.isArray(raw)) {
    for (const value of raw) {
      const id = nonEmpty((value as { id?: unknown } | null)?.id);
      const model = legacyModel(id ?? "", value);
      if (model !== undefined) models.push(model);
    }
  }
  return models;
}

function legacyModel(id: string, raw: unknown): CatalogModel | undefined {
  if (id.length === 0) return undefined;
  const record = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const reasoning = catalogReasoning(record.reasoning);
  return { id, enabled: true, ...(reasoning !== undefined ? { reasoning } : {}) };
}

/** config.json 的档位元数据索引（Registry 目录的 reasoning 回退来源）。 */
function readLegacyReasoning(homedir: string): Map<string, CatalogModel["reasoning"]> {
  const out = new Map<string, CatalogModel["reasoning"]>();
  const doc = readJsonOrUndefined(defaultModelConfigPath(homedir));
  if ("error" in doc) return out;
  const rawProviders = (doc.value as { provider?: unknown } | null)?.provider;
  if (rawProviders === null || typeof rawProviders !== "object" || Array.isArray(rawProviders)) return out;
  for (const [providerId, raw] of Object.entries(rawProviders as Record<string, unknown>)) {
    const record = recordOf(raw);
    const models = recordOf(record?.models);
    if (models === undefined) continue;
    for (const [modelId, modelRaw] of Object.entries(models)) {
      const reasoning = catalogReasoning(recordOf(modelRaw)?.reasoning);
      if (reasoning !== undefined) out.set(modelKey(providerId, modelId), reasoning);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 内部（字段白名单）

function catalogReasoning(raw: unknown): CatalogModel["reasoning"] | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.enabled === false) return undefined;
  if (!Array.isArray(record.variants)) return undefined;
  const variants = [...new Set(record.variants.map(nonEmpty).filter((v): v is string => v !== undefined))];
  if (variants.length === 0) return undefined;
  const defaultVariant = nonEmpty(record.defaultVariant);
  return {
    variants,
    ...(defaultVariant !== undefined && variants.includes(defaultVariant) ? { defaultVariant } : {}),
  };
}

function modelKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readJsonOrUndefined(file: string): { value: unknown } | { error: string } {
  try {
    return { value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
