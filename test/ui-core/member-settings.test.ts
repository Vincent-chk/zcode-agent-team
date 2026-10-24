// 成员模型设置弹窗（stage-8 Round D）：纯函数渲染 + 独立文案命名空间 + 联动纯函数。
// 安全红线：弹窗零 input/textarea（无凭据收集面）；目录/当前值只读展示。
import { describe, expect, it } from "vitest";
import {
  MEMBER_SETTINGS_DICT,
  catalogModelOf,
  catalogProvider,
  draftFromCurrent,
  draftFromProvider,
  draftSelection,
  draftVariants,
  renderMemberSettingsModal,
  selectLevel,
  selectModel,
  selectProvider,
  tms,
  type MemberSettingsState,
  type ModelSource,
} from "../../src/ui-core/member-settings.js";
import type { ModelCatalog } from "../../src/provider/model-catalog.js";
import { DICT, DICT_KEYS } from "../../src/ui-core/dict.js";

const CATALOG: ModelCatalog = {
  providers: [
    {
      providerId: "prov-a",
      name: "Provider A",
      kind: "anthropic",
      enabled: true,
      models: [
        { id: "model-a", reasoning: { variants: ["low", "high", "max"], defaultVariant: "high" } },
        { id: "model-plain" },
      ],
    },
    {
      providerId: "prov-b",
      name: "Provider B",
      kind: "openai",
      enabled: true,
      models: [{ id: "model-b", reasoning: { variants: ["max"], defaultVariant: "max" } }],
    },
    {
      providerId: "prov-off",
      name: "Provider Off",
      kind: "k",
      enabled: false,
      disabledReason: "oauth_provider_inactive",
      models: [{ id: "model-a" }],
    },
  ],
};

function ready(partial: Partial<Extract<MemberSettingsState, { kind: "ready" }>> = {}): MemberSettingsState {
  return {
    kind: "ready",
    memberId: "m_alice",
    name: "alice",
    catalog: CATALOG,
    current: { model: "model-a", providerId: "prov-a", reasoningLevel: "high", source: "explicit" },
    draft: { providerId: "prov-a", modelId: "model-a", reasoningLevel: "high" },
    ...partial,
  };
}

const NO_CREDENTIAL_INPUT = /<input|<textarea/i;

describe("MEMBER_SETTINGS_DICT（独立命名空间）", () => {
  it("zh/en 键集一致且值非空", () => {
    const zh = Object.keys(MEMBER_SETTINGS_DICT.zh).sort();
    const en = Object.keys(MEMBER_SETTINGS_DICT.en).sort();
    expect(zh).toEqual(en);
    for (const key of zh) {
      expect(
        MEMBER_SETTINGS_DICT.zh[key as keyof typeof MEMBER_SETTINGS_DICT.zh].length,
        key,
      ).toBeGreaterThan(0);
    }
  });

  it("25 键 DICT 未被污染（键数/键集不变）", () => {
    expect(DICT_KEYS).toHaveLength(25);
    expect(Object.keys(DICT.zh)).toHaveLength(25);
    for (const key of Object.keys(MEMBER_SETTINGS_DICT.zh)) {
      expect(key.startsWith("settings.")).toBe(true);
      expect(key in DICT.zh).toBe(false);
    }
  });

  it("tms 插值 {reason}/{message}", () => {
    expect(tms("zh", "settings.disabledBecause", { reason: "oauth_provider_inactive" })).toBe(
      "（oauth_provider_inactive）",
    );
    expect(tms("en", "settings.error", { message: "boom" })).toBe("Model settings unavailable: boom");
  });
});

describe("弹窗渲染 · ready", () => {
  it("标题含成员名；当前生效行（模型 + 强度 + 来源 badge 文案）", () => {
    const html = renderMemberSettingsModal(ready(), "zh");
    expect(html).toContain("成员设置 · alice");
    expect(html).toContain("当前生效");
    expect(html).toContain("model-a");
    expect(html).toContain("· high");
    expect(html).toContain("手动指定");
    expect(html).toContain('class="source-badge explicit"');
  });

  it("来源文案四态（explicit/inherited/observed/cli-default）", () => {
    const cases: Array<[ModelSource, string]> = [
      ["explicit", "手动指定"],
      ["inherited", "继承自 Lead"],
      ["observed", "运行时观测"],
      ["cli-default", "CLI 默认"],
    ];
    for (const [source, label] of cases) {
      const html = renderMemberSettingsModal(
        ready({
          current: { source, ...(source === "cli-default" ? {} : { model: "model-a", providerId: "prov-a" }) },
        }),
        "zh",
      );
      expect(html, source).toContain(label);
      expect(html, source).toContain(`source-badge ${source}`);
    }
  });

  it("provider select：enabled/disabled 两组 optgroup；禁用 provider 带原因且 disabled", () => {
    const html = renderMemberSettingsModal(ready(), "zh");
    expect(html).toContain('<optgroup label="已启用">');
    expect(html).toContain('<optgroup label="不可用">');
    expect(html).toContain("Provider Off（oauth_provider_inactive）");
    expect(html).toMatch(/<option value="prov-off"[^>]*disabled/);
    expect(html).toContain('value="prov-a" selected');
  });

  it("model select 按 provider 名 optgroup + 当前模型 selected；level select 含默认档与 variants", () => {
    const html = renderMemberSettingsModal(ready(), "zh");
    expect(html).toContain('<optgroup label="Provider A">');
    expect(html).toContain('<option value="model-a" selected>model-a</option>');
    expect(html).toMatch(/<option value=""[^>]*>模型默认<\/option>/);
    expect(html).toMatch(/<option value="max"[^>]*>max<\/option>/);
    expect(html).toContain("思考强度");
  });

  it("E-1b：档位未知 → 显示常用档 [low,medium,high,max]（不再禁用）", () => {
    const html = renderMemberSettingsModal(
      ready({
        current: undefined,
        draft: { providerId: "prov-a", modelId: "model-plain", reasoningLevel: "max" },
      }),
      "zh",
    );
    expect(html).not.toContain("该模型不支持思考强度");
    expect(html).not.toMatch(/data-settings-level disabled/);
    for (const level of ["low", "medium", "high", "max"]) {
      expect(html).toContain(`<option value="${level}"`);
    }
    expect(html).toMatch(/<option value="max" selected>max<\/option>/);
    // 常用档不含 none/xhigh 之类非常用值
    expect(html).not.toContain('<option value="xhigh"');
    expect(html).not.toContain('<option value="none"');
  });

  it("高级模式：引导文案 + 刷新按钮", () => {
    const html = renderMemberSettingsModal(ready(), "zh");
    expect(html).toContain("高级模式");
    expect(html).toContain("需要新增模型或 Provider？在 ZCode 设置 → 模型服务 中添加后，回到此处点击刷新");
    expect(html).toContain("data-settings-refresh");
  });

  it("零凭据输入面：无 input/textarea，且不含凭据字段名", () => {
    const html = renderMemberSettingsModal(ready(), "zh");
    expect(html).not.toMatch(NO_CREDENTIAL_INPUT);
    expect(html).not.toContain("apiKey");
    expect(html).not.toContain("baseURL");
    expect(html).not.toContain("password");
    expect(html).toContain("data-settings-apply");
    expect(html).toContain("data-settings-cancel");
  });

  it("notice：applied / next-turn 文案", () => {
    expect(renderMemberSettingsModal(ready({ notice: "now" }), "zh")).toContain("已应用");
    expect(renderMemberSettingsModal(ready({ notice: "next-turn" }), "zh")).toContain("已保存，下一轮生效");
    expect(renderMemberSettingsModal(ready({ notice: "next-turn" }), "en")).toContain("applies on the next turn");
  });

  it("空目录 → 提示 + 高级模式；不渲染 provider/model select", () => {
    const html = renderMemberSettingsModal(ready({ catalog: { providers: [] }, current: undefined, draft: {} }), "zh");
    expect(html).toContain("模型目录为空（可在高级模式刷新）");
    expect(html).not.toContain("data-settings-provider");
    expect(html).toContain("data-settings-refresh");
    expect(html).not.toMatch(NO_CREDENTIAL_INPUT);
  });

  it("saving：按钮禁用 + 文案", () => {
    const html = renderMemberSettingsModal({ ...(ready() as Extract<MemberSettingsState, { kind: "ready" }>), kind: "saving" }, "zh");
    expect(html).toContain("正在应用…");
    expect(html).toMatch(/data-settings-apply disabled/);
  });
});

describe("弹窗渲染 · loading/error/closed", () => {
  it("closed → 空串", () => {
    expect(renderMemberSettingsModal({ kind: "closed" }, "zh")).toBe("");
  });

  it("loading → 加载文案", () => {
    expect(renderMemberSettingsModal({ kind: "loading", memberId: "m", name: "alice" }, "zh")).toContain(
      "正在加载模型…",
    );
  });

  it("error → 可读原因 + 刷新按钮；无凭据输入面", () => {
    const html = renderMemberSettingsModal(
      { kind: "error", memberId: "m", name: "alice", message: "boom" },
      "zh",
    );
    expect(html).toContain("模型设置不可用：boom");
    expect(html).toContain("data-settings-refresh");
    expect(html).not.toMatch(NO_CREDENTIAL_INPUT);
  });
});

describe("联动纯函数", () => {
  it("catalogProvider / catalogModelOf", () => {
    expect(catalogProvider(CATALOG, "prov-a")?.name).toBe("Provider A");
    expect(catalogProvider(CATALOG, "nope")).toBeUndefined();
    expect(catalogProvider(CATALOG, undefined)).toBeUndefined();
    expect(catalogModelOf(CATALOG, "prov-a", "model-a")?.id).toBe("model-a");
    expect(catalogModelOf(CATALOG, "prov-a", "model-b")).toBeUndefined();
    expect(draftVariants(CATALOG, { providerId: "prov-a", modelId: "model-a" })).toEqual(["low", "high", "max"]);
    // E-1b：档位未知 → 常用档（不再返回 undefined）
    expect(draftVariants(CATALOG, { providerId: "prov-a", modelId: "model-plain" })).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  it("draftFromCurrent：explicit 命中目录 → 沿用（非法强度回落默认档）", () => {
    expect(
      draftFromCurrent(CATALOG, { providerId: "prov-a", model: "model-a", reasoningLevel: "low", source: "explicit" }),
    ).toEqual({ providerId: "prov-a", modelId: "model-a", reasoningLevel: "low" });
    expect(
      draftFromCurrent(CATALOG, { providerId: "prov-a", model: "model-a", reasoningLevel: "bogus", source: "explicit" }),
    ).toEqual({ providerId: "prov-a", modelId: "model-a", reasoningLevel: "high" });
  });

  it("draftFromCurrent：只有模型名 → enabled 唯一命中；无命中 → 首个 enabled provider 首模型", () => {
    // model-b 仅在 prov-b
    expect(draftFromCurrent(CATALOG, { model: "model-b", source: "observed" })).toEqual({
      providerId: "prov-b",
      modelId: "model-b",
      reasoningLevel: "max",
    });
    // model-a 同时在 prov-a/prov-off → 仅 prov-a 是 enabled → 唯一
    expect(draftFromCurrent(CATALOG, { model: "model-a", source: "observed" })).toEqual({
      providerId: "prov-a",
      modelId: "model-a",
      reasoningLevel: "high",
    });
    expect(draftFromCurrent(CATALOG, { model: "ghost", source: "observed" })).toEqual({
      providerId: "prov-a",
      modelId: "model-a",
      reasoningLevel: "high",
    });
    expect(draftFromCurrent(CATALOG, undefined)).toEqual({
      providerId: "prov-a",
      modelId: "model-a",
      reasoningLevel: "high",
    });
    expect(draftFromCurrent({ providers: [] }, undefined)).toEqual({});
  });

  it("draftFromProvider / selectProvider：切 provider 重置为该 provider 首模型", () => {
    expect(draftFromProvider(CATALOG, "prov-b")).toEqual({
      providerId: "prov-b",
      modelId: "model-b",
      reasoningLevel: "max",
    });
    const draft = { providerId: "prov-a", modelId: "model-a", reasoningLevel: "low" };
    expect(selectProvider(CATALOG, draft, "prov-a")).toBe(draft); // 同 provider → 原对象
    expect(selectProvider(CATALOG, draft, "prov-b")).toEqual({
      providerId: "prov-b",
      modelId: "model-b",
      reasoningLevel: "max",
    });
  });

  it("selectModel：强度重置；档位未知 → 常用档终点 max；selectLevel 空串清空", () => {
    const draft = { providerId: "prov-a", modelId: "model-a", reasoningLevel: "low" };
    expect(selectModel(CATALOG, draft, "model-plain")).toEqual({
      providerId: "prov-a",
      modelId: "model-plain",
      reasoningLevel: "max",
    });
    expect(selectLevel(draft, "max")).toEqual({ providerId: "prov-a", modelId: "model-a", reasoningLevel: "max" });
    expect(selectLevel(draft, "")).toEqual({ providerId: "prov-a", modelId: "model-a" });
  });

  it("draftSelection：providerId$modelId 全称；缺 provider/model → undefined", () => {
    expect(draftSelection({ providerId: "prov-a", modelId: "model-a", reasoningLevel: "high" })).toEqual({
      model: "prov-a$model-a",
      thoughtLevel: "high",
    });
    expect(draftSelection({ providerId: "prov-a", modelId: "model-a" })).toEqual({ model: "prov-a$model-a" });
    expect(draftSelection({ providerId: "prov-a" })).toBeUndefined();
    expect(draftSelection({})).toBeUndefined();
  });
});
