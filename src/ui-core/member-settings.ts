// 成员模型设置弹窗（stage-8 Round D）：纯函数渲染 + 独立文案命名空间。
// 纪律：
//  - 文案全部进 MEMBER_SETTINGS_DICT（zh/en 键集一致），**绝不触碰 25 键 DICT**（F08 零容忍）；
//  - 只读边界升级为「受控变更」：唯一动作是应用模型选择（经 main.ts → team_panel_call
//    setMemberModel → backend.setMemberModel，Round C 通路复用）；
//  - **零凭据输入**：弹窗只有 select 与 button，不渲染任何 input/textarea（apiKey/baseURL
//    由宿主 ZCode 设置页管理；高级模式只给引导文案 + 刷新）。
import type { CatalogModel, CatalogProvider, ModelCatalog } from "../provider/model-catalog.js";
import { DEFAULT_REASONING_LEVEL } from "../provider/model-selection.js";
import { esc } from "./escape.js";
import type { Lang } from "./dict.js";

/** 档位未知时的常用档（E-1b：注册表未给 variants 的模型仍可手选；默认 max）。 */
export const COMMON_REASONING_LEVELS = ["low", "medium", "high", "max"] as const;

/** 当前生效模型的来源（展示审计口径，非生效机制）。 */
export type ModelSource = "explicit" | "inherited" | "observed" | "cli-default";

/** 成员当前生效模型（panel-call modelOptions 的 current 字段）。 */
export interface MemberModelCurrent {
  model?: string;
  providerId?: string;
  reasoningLevel?: string;
  source: ModelSource;
}

/** 弹窗草稿（provider → model → thoughtLevel 三段联动）。 */
export interface ModelDraft {
  providerId?: string;
  modelId?: string;
  reasoningLevel?: string;
}

export type MemberSettingsState =
  | { kind: "closed" }
  | { kind: "loading"; memberId: string; name: string }
  | { kind: "error"; memberId: string; name: string; message: string }
  | {
      kind: "ready";
      memberId: string;
      name: string;
      catalog: ModelCatalog;
      current?: MemberModelCurrent;
      draft: ModelDraft;
      notice?: "now" | "next-turn";
    }
  | {
      kind: "saving";
      memberId: string;
      name: string;
      catalog: ModelCatalog;
      current?: MemberModelCurrent;
      draft: ModelDraft;
      notice?: "now" | "next-turn";
    };

export const MEMBER_SETTINGS_DICT = {
  zh: {
    "settings.open": "成员设置",
    "settings.title": "成员设置",
    "settings.close": "关闭",
    "settings.current": "当前生效",
    "settings.noModel": "未记录",
    "settings.source.explicit": "手动指定",
    "settings.source.inherited": "继承自 Lead",
    "settings.source.observed": "运行时观测",
    "settings.source.cli-default": "CLI 默认",
    "settings.provider": "Provider",
    "settings.model": "模型",
    "settings.thoughtLevel": "思考强度",
    "settings.levelDefault": "模型默认",
    // 保留：Registry 目前只暴露 variants 或「未知」，尚无「明确不支持档位」标记；
    // 未来若注册表给出该能力位，用它渲染禁用态（E-1b 起未知档位改走常用档）。
    "settings.noReasoning": "该模型不支持思考强度",
    "settings.groupEnabled": "已启用",
    "settings.groupDisabled": "不可用",
    "settings.disabledBecause": "（{reason}）",
    "settings.advanced": "高级模式",
    "settings.advancedHint": "需要新增模型或 Provider？在 ZCode 设置 → 模型服务 中添加后，回到此处点击刷新",
    "settings.refresh": "刷新",
    "settings.cancel": "取消",
    "settings.apply": "应用",
    "settings.saving": "正在应用…",
    "settings.applied": "已应用",
    "settings.nextTurn": "已保存，下一轮生效",
    "settings.loading": "正在加载模型…",
    "settings.error": "模型设置不可用：{message}",
    "settings.emptyCatalog": "模型目录为空（可在高级模式刷新）",
    "settings.noSelection": "请先选择 Provider 与模型",
  },
  en: {
    "settings.open": "Member settings",
    "settings.title": "Member settings",
    "settings.close": "Close",
    "settings.current": "Currently in effect",
    "settings.noModel": "Not recorded",
    "settings.source.explicit": "Set explicitly",
    "settings.source.inherited": "Inherited from Lead",
    "settings.source.observed": "Observed at runtime",
    "settings.source.cli-default": "CLI default",
    "settings.provider": "Provider",
    "settings.model": "Model",
    "settings.thoughtLevel": "Reasoning level",
    "settings.levelDefault": "Model default",
    // 保留（同上）：显式「不支持档位」能力位尚未由注册表提供。
    "settings.noReasoning": "This model has no reasoning levels",
    "settings.groupEnabled": "Enabled",
    "settings.groupDisabled": "Unavailable",
    "settings.disabledBecause": " ({reason})",
    "settings.advanced": "Advanced",
    "settings.advancedHint":
      "Need another model or provider? Add it in ZCode Settings → Model services, then come back and refresh.",
    "settings.refresh": "Refresh",
    "settings.cancel": "Cancel",
    "settings.apply": "Apply",
    "settings.saving": "Applying…",
    "settings.applied": "Applied",
    "settings.nextTurn": "Saved; applies on the next turn",
    "settings.loading": "Loading models…",
    "settings.error": "Model settings unavailable: {message}",
    "settings.emptyCatalog": "Model catalog is empty (use Refresh in Advanced)",
    "settings.noSelection": "Select a provider and model first",
  },
} as const;

export type MemberSettingsDictKey = keyof (typeof MEMBER_SETTINGS_DICT)["zh"];

/** tms()：成员设置文案 + {message}/{reason} 插值。 */
export function tms(lang: Lang, key: MemberSettingsDictKey, vars?: Record<string, string | number>): string {
  const template: string = MEMBER_SETTINGS_DICT[lang][key];
  if (vars === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

// ---------------------------------------------------------------- 联动纯函数（main.ts 复用）

/** provider 条目（不存在 → undefined）。 */
export function catalogProvider(catalog: ModelCatalog, providerId: string | undefined): CatalogProvider | undefined {
  return providerId === undefined ? undefined : catalog.providers.find((p) => p.providerId === providerId);
}

export function catalogModelOf(
  catalog: ModelCatalog,
  providerId: string | undefined,
  modelId: string | undefined,
): CatalogModel | undefined {
  if (modelId === undefined) return undefined;
  return catalogProvider(catalog, providerId)?.models.find((m) => m.id === modelId);
}

/** 可用思考强度档位（未知 → 常用档；调用方据此渲染下拉）。 */
export function draftVariants(catalog: ModelCatalog, draft: ModelDraft): string[] {
  return catalogModelOf(catalog, draft.providerId, draft.modelId)?.reasoning?.variants ?? [...COMMON_REASONING_LEVELS];
}

/** 默认档位：目录 defaultVariant（命中 variants）→ 首档；档位未知 → 常用档终点 max。 */
function defaultLevel(model: CatalogModel | undefined): string {
  const variants = model?.reasoning?.variants;
  const preferred = model?.reasoning?.defaultVariant;
  if (variants === undefined) return preferred ?? DEFAULT_REASONING_LEVEL;
  if (variants.length === 0) return DEFAULT_REASONING_LEVEL;
  return preferred !== undefined && variants.includes(preferred) ? preferred : variants[0]!;
}

/** 由当前生效值构造草稿：当前 provider/model 在目录中则沿用，否则回退第一个 enabled provider。 */
export function draftFromCurrent(catalog: ModelCatalog, current?: MemberModelCurrent): ModelDraft {
  if (current !== undefined) {
    const direct =
      current.providerId !== undefined
        ? catalogModelOf(catalog, current.providerId, current.model)
        : undefined;
    if (direct !== undefined) {
      // 档位已知时当前值必须在 variants 内；档位未知（注册表未给）→ 保留成员当前档，不臆改。
      const known = direct.reasoning?.variants;
      const level =
        current.reasoningLevel !== undefined && (known === undefined || known.includes(current.reasoningLevel))
          ? current.reasoningLevel
          : defaultLevel(direct);
      return { providerId: current.providerId, modelId: direct.id, reasoningLevel: level };
    }
    // 只有模型名（observed/CLI 默认）：在 enabled provider 里找唯一命中
    if (current.model !== undefined) {
      const hits = catalog.providers.filter((p) => p.enabled && p.models.some((m) => m.id === current.model));
      if (hits.length === 1) {
        const model = hits[0]!.models.find((m) => m.id === current.model)!;
        return { providerId: hits[0]!.providerId, modelId: model.id, reasoningLevel: defaultLevel(model) };
      }
    }
  }
  return draftFromProvider(catalog, undefined);
}

/** 切换 provider：模型重置为该 provider 首模型（enabled 优先；无模型 → 空）。 */
export function draftFromProvider(catalog: ModelCatalog, providerId: string | undefined): ModelDraft {
  const provider =
    catalogProvider(catalog, providerId) ??
    catalog.providers.find((p) => p.enabled && p.models.length > 0);
  const model = provider?.models[0];
  return {
    ...(provider !== undefined ? { providerId: provider.providerId } : {}),
    ...(model !== undefined ? { modelId: model.id, reasoningLevel: defaultLevel(model) } : {}),
  };
}

/** 切换 provider（保留可见选择语义：同 provider → 原草稿不变）。 */
export function selectProvider(catalog: ModelCatalog, draft: ModelDraft, providerId: string): ModelDraft {
  if (draft.providerId === providerId) return draft;
  return draftFromProvider(catalog, providerId);
}

/** 切换模型：强度重置为该模型默认档（档位未知 → 常用档终点 max）。 */
export function selectModel(catalog: ModelCatalog, draft: ModelDraft, modelId: string): ModelDraft {
  const model = catalogModelOf(catalog, draft.providerId, modelId);
  return {
    ...(draft.providerId !== undefined ? { providerId: draft.providerId } : {}),
    modelId,
    reasoningLevel: defaultLevel(model),
  };
}

/** 切换思考强度（空串 = 模型默认 → 不传 thoughtLevel）。 */
export function selectLevel(draft: ModelDraft, level: string): ModelDraft {
  return level.length === 0
    ? { ...(draft.providerId !== undefined ? { providerId: draft.providerId } : {}), ...(draft.modelId !== undefined ? { modelId: draft.modelId } : {}) }
    : { ...draft, reasoningLevel: level };
}

/** 草稿 → 工具面参数（model = providerId$modelId 全称；无 provider/model → undefined）。 */
export function draftSelection(draft: ModelDraft): { model: string; thoughtLevel?: string } | undefined {
  if (draft.providerId === undefined || draft.modelId === undefined) return undefined;
  return {
    model: `${draft.providerId}$${draft.modelId}`,
    ...(draft.reasoningLevel !== undefined ? { thoughtLevel: draft.reasoningLevel } : {}),
  };
}

// ---------------------------------------------------------------- 渲染

/** 弹窗（state closed → 空串）。 */
export function renderMemberSettingsModal(st: MemberSettingsState, lang: Lang): string {
  if (st.kind === "closed") return "";
  const title = `${tms(lang, "settings.title")} · ${st.name}`;
  const close = `<button class="settings-close" data-settings-close aria-label="${esc(tms(lang, "settings.close"))}" title="${esc(tms(lang, "settings.close"))}">×</button>`;
  const head = `<div class="settings-head"><span class="settings-title">${esc(title)}</span>${close}</div>`;

  let body: string;
  if (st.kind === "loading") {
    body = `<div class="settings-state"><span class="dot ongoing"></span>${esc(tms(lang, "settings.loading"))}</div>`;
  } else if (st.kind === "error") {
    body =
      `<div class="settings-state error"><span class="dot error"></span><span>${esc(
        tms(lang, "settings.error", { message: st.message }),
      )}</span></div>` +
      `<div class="settings-foot"><button class="settings-btn" data-settings-refresh>${esc(tms(lang, "settings.refresh"))}</button></div>`;
  } else {
    body = renderReadyBody(st, lang);
  }
  return (
    `<div class="settings-overlay" data-settings-overlay>` +
    `<div class="settings-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">` +
    head +
    body +
    `</div></div>`
  );
}

function renderReadyBody(
  st: Extract<MemberSettingsState, { kind: "ready" | "saving" }>,
  lang: Lang,
): string {
  const { catalog, current, draft } = st;
  const saving = st.kind === "saving";
  const available = catalog.providers.length > 0;

  const currentModel = current?.model;
  const currentParts: string[] = [];
  currentParts.push(esc(currentModel ?? tms(lang, "settings.noModel")));
  if (current?.reasoningLevel !== undefined) currentParts.push(`· ${esc(current.reasoningLevel)}`);
  const source = current?.source ?? "cli-default";
  const currentLine =
    `<div class="settings-current"><span class="settings-label">${esc(tms(lang, "settings.current"))}</span>` +
    `<span class="settings-current-model">${currentParts.join(" ")}</span>` +
    `<span class="source-badge ${esc(source)}">${esc(tms(lang, `settings.source.${source}` as MemberSettingsDictKey))}</span>` +
    `</div>`;

  const notice =
    st.notice !== undefined
      ? `<div class="settings-notice" role="status">${esc(
          tms(lang, st.notice === "now" ? "settings.applied" : "settings.nextTurn"),
        )}</div>`
      : "";

  if (!available) {
    return (
      currentLine +
      `<div class="settings-state">${esc(tms(lang, "settings.emptyCatalog"))}</div>` +
      notice +
      renderFoot(lang, true) +
      renderAdvanced(lang)
    );
  }

  const provider = catalogProvider(catalog, draft.providerId);
  const model = catalogModelOf(catalog, draft.providerId, draft.modelId);
  const variants = model?.reasoning?.variants;

  const providerSelect =
    `<label class="settings-field"><span class="settings-label">${esc(tms(lang, "settings.provider"))}</span>` +
    `<select class="modal-select" data-settings-provider${saving ? " disabled" : ""}>` +
    renderProviderOptions(catalog, draft.providerId, lang) +
    `</select></label>`;

  const modelSelect =
    `<label class="settings-field"><span class="settings-label">${esc(tms(lang, "settings.model"))}</span>` +
    `<select class="modal-select" data-settings-model${saving ? " disabled" : ""}>` +
    (provider !== undefined
      ? `<optgroup label="${esc(provider.name)}">` +
        provider.models
          .map(
            (m) =>
              `<option value="${esc(m.id)}"${m.id === draft.modelId ? " selected" : ""}` +
              `${m.enabled === false ? " disabled" : ""}>${esc(m.id)}</option>`,
          )
          .join("") +
        `</optgroup>`
      : "") +
    `</select></label>`;

  // 档位下拉：variants 已知用真实集合；注册表未给元数据 → 常用档（E-1b：不再显示禁用态，
  // 因为该模型仍需档位——deepseek-flash 之类缺档位会被服务端直接拒）。
  const levelOptions = variants ?? [...COMMON_REASONING_LEVELS];
  const levelSelect =
    `<label class="settings-field"><span class="settings-label">${esc(tms(lang, "settings.thoughtLevel"))}</span>` +
    `<select class="modal-select" data-settings-level${saving ? " disabled" : ""}>` +
    `<option value=""${draft.reasoningLevel === undefined ? " selected" : ""}>${esc(tms(lang, "settings.levelDefault"))}</option>` +
    levelOptions
      .map(
        (v) => `<option value="${esc(v)}"${v === draft.reasoningLevel ? " selected" : ""}>${esc(v)}</option>`,
      )
      .join("") +
    `</select></label>`;

  return currentLine + providerSelect + modelSelect + levelSelect + notice + renderFoot(lang, saving) + renderAdvanced(lang);
}

function renderProviderOptions(catalog: ModelCatalog, selected: string | undefined, lang: Lang): string {
  const enabled = catalog.providers.filter((p) => p.enabled);
  const disabled = catalog.providers.filter((p) => !p.enabled);
  const option = (p: CatalogProvider, isDisabled: boolean): string =>
    `<option value="${esc(p.providerId)}"${p.providerId === selected ? " selected" : ""}${isDisabled ? " disabled" : ""}>` +
    esc(p.name) +
    (isDisabled && p.disabledReason !== undefined
      ? esc(tms(lang, "settings.disabledBecause", { reason: p.disabledReason }))
      : "") +
    `</option>`;
  const group = (label: string, items: CatalogProvider[]): string =>
    items.length === 0 ? "" : `<optgroup label="${esc(label)}">${items.map((p) => option(p, !p.enabled)).join("")}</optgroup>`;
  return group(tms(lang, "settings.groupEnabled"), enabled) + group(tms(lang, "settings.groupDisabled"), disabled);
}

function renderFoot(lang: Lang, saving: boolean): string {
  const selectionDisabled = saving ? " disabled" : "";
  return (
    `<div class="settings-foot">` +
    `<button class="settings-btn" data-settings-cancel${saving ? " disabled" : ""}>${esc(tms(lang, "settings.cancel"))}</button>` +
    `<button class="settings-btn primary" data-settings-apply${selectionDisabled}>${esc(
      saving ? tms(lang, "settings.saving") : tms(lang, "settings.apply"),
    )}</button>` +
    `</div>`
  );
}

/** 高级模式（引导文案 + 刷新；无凭据输入 = 安全红线）。 */
function renderAdvanced(lang: Lang): string {
  return (
    `<div class="settings-advanced">` +
    `<div class="settings-advanced-title">${esc(tms(lang, "settings.advanced"))}</div>` +
    `<div class="settings-advanced-hint">${esc(tms(lang, "settings.advancedHint"))}</div>` +
    `<button class="settings-btn" data-settings-refresh>${esc(tms(lang, "settings.refresh"))}</button>` +
    `</div>`
  );
}
