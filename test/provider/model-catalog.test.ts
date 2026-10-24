// 模型目录 v2（stage-8 E-1b）：主源 = 运行时 Provider Registry（provider_config.json），
// 回退 = config.json 投影；**脱敏红线**（access/apiKey/api/baseUrl 永不出现）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REASONING_LEVEL,
  applyReasoningDefault,
  createModelCatalogReader,
  defaultReasoningLevel,
  enabledProvidersOffering,
  findCatalogModel,
  findCatalogProvider,
  readModelCatalog,
  readModelCatalogDetailed,
} from "../../src/provider/model-catalog.js";

/** 占位符：验证脱敏，不是可用凭据。 */
const PLACEHOLDER_KEY = "placeholder-not-a-real-credential";
const PLACEHOLDER_URL = "https://placeholder.invalid/v1";

/** 夹具只允许写这两个固定文件（文件名白名单 + 根目录边界校验）。 */
const REGISTRY_REL = ".zcode/v2/provider_config.json";
const CONFIG_REL = ".zcode/v2/config.json";
const FIXTURE_FILES: readonly string[] = [REGISTRY_REL, CONFIG_REL];

let home: string;

function writeJson(rel: typeof REGISTRY_REL | typeof CONFIG_REL, doc: unknown): void {
  if (!FIXTURE_FILES.includes(rel)) throw new Error(`unexpected fixture path: ${rel}`);
  const root = path.resolve(home);
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep)) throw new Error(`fixture path escapes root: ${rel}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof doc === "string" ? doc : JSON.stringify(doc));
}

/** provider_config.json 夹具：3 个注册 provider + 1 个不在 providerOrder 的规则 + 凭据字段。 */
const PROVIDER_CONFIG = {
  schemaVersion: 1,
  config: {
    providerOrder: ["prov-a", "prov-b", "prov-empty"],
    providerConfigRules: {
      providerRules: [
        {
          providerId: "prov-a",
          providerName: "Provider A",
          config: {
            group: "standard-personal",
            access: { type: "api-key", apiKey: PLACEHOLDER_KEY },
            api: { type: "openai-responses", baseUrl: PLACEHOLDER_URL },
            personalModelIds: ["m-a1"],
            modelOrder: ["m-a1", "m-a2"],
          },
        },
        {
          // 无 providerName → 回退 providerId；无 api → kind unknown
          providerId: "prov-b",
          config: { modelOrder: ["m-b1"] },
        },
        { providerId: "prov-empty", providerName: "Provider Empty", config: { modelOrder: [] } },
        // 不在 providerOrder：必须被排除（E-1 实测的坑：account 形态注册不了）
        {
          providerId: "account:unavailable-plan",
          config: { modelOrder: ["GLM-5.3"], access: { apiKey: PLACEHOLDER_KEY } },
        },
      ],
    },
    modelConfigRules: {
      providerModelRules: [
        { providerId: "prov-a", modelId: "m-a1", config: { enabled: false } },
        {
          providerId: "prov-a",
          modelId: "m-a2",
          config: { enabled: true, optionSpecs: { reasoningLevel: { values: ["low", "xhigh", "max"] } } },
        },
        {
          providerId: "prov-b",
          modelId: "m-b1",
          config: { optionSpecs: { reasoningLevel: { values: ["disabled", "high"] } } },
        },
      ],
      manualProviderModelRules: [],
    },
  },
};

/** config.json 夹具：只用于 reasoning 合并（prov-a$m-a1 有 reasoning/defaultVariant）。 */
const CONFIG = {
  provider: {
    "prov-a": {
      name: "Ignored Name",
      kind: "anthropic",
      options: { apiKey: PLACEHOLDER_KEY, baseURL: PLACEHOLDER_URL },
      models: {
        "m-a1": { reasoning: { enabled: true, variants: ["low", "high", "max"], defaultVariant: "high" } },
      },
    },
  },
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-catalog2-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("目录源 v2 · provider_config（注册表）", () => {
  it("providers = providerOrder 顺序；name/api.type/models 白名单投影", () => {
    writeJson(REGISTRY_REL, PROVIDER_CONFIG);
    writeJson(CONFIG_REL, CONFIG);
    const result = readModelCatalogDetailed(home);
    expect(result.source).toBe("provider-config");
    expect(result.error).toBeUndefined();
    expect(result.warning).toBeUndefined();
    expect(result.catalog.providers.map((p) => p.providerId)).toEqual(["prov-a", "prov-b", "prov-empty"]);
    const a = result.catalog.providers[0]!;
    expect(a).toMatchObject({ name: "Provider A", kind: "openai-responses", enabled: true });
    expect(a.models.map((m) => m.id)).toEqual(["m-a1", "m-a2"]);
    // providerName 缺失 → providerId；api 缺失 → kind unknown
    expect(result.catalog.providers[1]).toMatchObject({ providerId: "prov-b", name: "prov-b", kind: "unknown" });
    expect(result.catalog.providers[2]!.models).toEqual([]);
  });

  it("model enabled 取 providerModelRules（无规则=true；enabled:false=false）", () => {
    writeJson(REGISTRY_REL, PROVIDER_CONFIG);
    writeJson(CONFIG_REL, CONFIG);
    const catalog = readModelCatalog(home);
    expect(catalog.providers[0]!.models).toEqual([
      // prov-a$m-a1：config.json 有 reasoning（defaultVariant high），规则 enabled:false
      { id: "m-a1", enabled: false, reasoning: { variants: ["low", "high", "max"], defaultVariant: "high" } },
      // prov-a$m-a2：无 config.json 条目 → optionSpecs variants
      { id: "m-a2", enabled: true, reasoning: { variants: ["low", "xhigh", "max"] } },
    ]);
    expect(catalog.providers[1]!.models).toEqual([
      { id: "m-b1", enabled: true, reasoning: { variants: ["disabled", "high"] } },
    ]);
  });

  it("providerOrder 之外的 provider 不出现（account/builtin 形态被注册表排除）", () => {
    writeJson(REGISTRY_REL, PROVIDER_CONFIG);
    writeJson(CONFIG_REL, CONFIG);
    const catalog = readModelCatalog(home);
    expect(catalog.providers.map((p) => p.providerId)).not.toContain("account:unavailable-plan");
  });

  it("脱敏：输出不含 access/api/apiKey/baseUrl/options 与占位凭据值", () => {
    writeJson(REGISTRY_REL, PROVIDER_CONFIG);
    writeJson(CONFIG_REL, CONFIG);
    const text = JSON.stringify(readModelCatalog(home));
    expect(text).not.toContain(PLACEHOLDER_KEY);
    expect(text).not.toContain(PLACEHOLDER_URL);
    expect(text).not.toContain("apiKey");
    expect(text).not.toContain("baseUrl");
    expect(text).not.toContain('"access"');
    expect(text).not.toContain('"api"');
    expect(text).not.toContain("options");
  });

  it("config.json 不可读时仍给注册表目录（reasoning 缺省=未知）", () => {
    writeJson(REGISTRY_REL, PROVIDER_CONFIG);
    const catalog = readModelCatalog(home);
    expect(catalog.providers[0]!.models[0]).toEqual({ id: "m-a1", enabled: false });
  });

  it("providerModelRules 缺失 → 全部模型 enabled=true", () => {
    writeJson(REGISTRY_REL, {
      config: {
        providerOrder: ["p1"],
        providerConfigRules: { providerRules: [{ providerId: "p1", config: { modelOrder: ["m1"] } }] },
      },
    });
    expect(readModelCatalog(home).providers[0]!.models).toEqual([{ id: "m1", enabled: true }]);
  });

  it("reasoning 容错：optionSpecs 非法/空 → 不输出 reasoning", () => {
    writeJson(REGISTRY_REL, {
      config: {
        providerOrder: ["p1"],
        providerConfigRules: { providerRules: [{ providerId: "p1", config: { modelOrder: ["a", "b", "c"] } }] },
        modelConfigRules: {
          providerModelRules: [
            { providerId: "p1", modelId: "a", config: { optionSpecs: { reasoningLevel: { values: [] } } } },
            { providerId: "p1", modelId: "b", config: { optionSpecs: "garbage" } },
            {
              providerId: "p1",
              modelId: "c",
              config: { optionSpecs: { reasoningLevel: { values: ["high", "high"] } } },
            },
          ],
        },
      },
    });
    expect(readModelCatalog(home).providers[0]!.models).toEqual([
      { id: "a", enabled: true },
      { id: "b", enabled: true },
      { id: "c", enabled: true, reasoning: { variants: ["high"] } },
    ]);
  });
});

describe("目录源 v2 · 回退 config.json", () => {
  it("provider_config 缺失 → config.json 投影（模型 enabled=true，provider 保留 enabled/disabledReason）", () => {
    writeJson(CONFIG_REL, {
      provider: {
        "legacy-on": {
          name: "Legacy On",
          kind: "anthropic",
          models: { m1: { reasoning: { variants: ["low", "max"], defaultVariant: "max" } } },
        },
        "legacy-off": {
          name: "Legacy Off",
          kind: "openai",
          enabled: false,
          systemDisabledReason: "oauth_provider_inactive",
          models: { m2: {} },
        },
      },
    });
    const result = readModelCatalogDetailed(home);
    expect(result.source).toBe("config-json");
    expect(result.warning).toBeUndefined(); // 文件缺失属兼容路径，不算异常
    expect(result.catalog.providers).toEqual([
      {
        providerId: "legacy-on",
        name: "Legacy On",
        kind: "anthropic",
        enabled: true,
        models: [{ id: "m1", enabled: true, reasoning: { variants: ["low", "max"], defaultVariant: "max" } }],
      },
      {
        providerId: "legacy-off",
        name: "Legacy Off",
        kind: "openai",
        enabled: false,
        disabledReason: "oauth_provider_inactive",
        models: [{ id: "m2", enabled: true }],
      },
    ]);
  });

  it("provider_config 损坏 → 回退 + warning；两者都坏 → error", () => {
    writeJson(REGISTRY_REL, "{not json");
    writeJson(CONFIG_REL, CONFIG);
    const fallback = readModelCatalogDetailed(home);
    expect(fallback.source).toBe("config-json");
    expect(fallback.warning).toContain("provider registry unavailable");
    expect(fallback.catalog.providers.map((p) => p.providerId)).toEqual(["prov-a"]);

    writeJson(CONFIG_REL, "{also bad");
    const both = readModelCatalogDetailed(home);
    expect(both.error).toContain("provider registry unavailable");
    expect(both.error).toContain("model catalog unavailable");
    expect(both.catalog.providers).toEqual([]);
  });

  it("provider_config 结构不符（providerOrder 非数组）→ 回退", () => {
    writeJson(REGISTRY_REL, { config: { providerOrder: "prov-a" } });
    writeJson(CONFIG_REL, CONFIG);
    const result = readModelCatalogDetailed(home);
    expect(result.source).toBe("config-json");
    expect(result.warning).toContain("providerOrder/providerRules is not an array");
  });
});

describe("目录查询与档位缺省链", () => {
  it("findCatalogProvider/findCatalogModel/enabledProvidersOffering（disabled 模型不算）", () => {
    writeJson(REGISTRY_REL, PROVIDER_CONFIG);
    writeJson(CONFIG_REL, CONFIG);
    const catalog = readModelCatalog(home);
    expect(findCatalogProvider(catalog, "prov-a")?.name).toBe("Provider A");
    expect(findCatalogProvider(catalog, "nope")).toBeUndefined();
    expect(findCatalogModel(catalog, "prov-a", "m-a1")).toMatchObject({ id: "m-a1", enabled: false });
    expect(findCatalogModel(catalog, "prov-a", "nope")).toBeUndefined();
    // m-a1 被停用 → 裸 id 消歧不提供
    expect(enabledProvidersOffering(catalog, "m-a1")).toEqual([]);
    expect(enabledProvidersOffering(catalog, "m-a2")).toEqual(["prov-a"]);
    expect(enabledProvidersOffering(catalog, "m-b1")).toEqual(["prov-b"]);
  });

  it("defaultReasoningLevel：defaultVariant → max（已知集合内）→ 首档；未知 → max", () => {
    writeJson(REGISTRY_REL, PROVIDER_CONFIG);
    writeJson(CONFIG_REL, CONFIG);
    const catalog = readModelCatalog(home);
    // m-a1 有 defaultVariant high
    expect(defaultReasoningLevel(catalog, "prov-a", "m-a1")).toBe("high");
    // m-a2 variants [low,xhigh,max] 无 defaultVariant → 含 max → max
    expect(defaultReasoningLevel(catalog, "prov-a", "m-a2")).toBe("max");
    // m-b1 variants [disabled,high] 无 max → 首档
    expect(defaultReasoningLevel(catalog, "prov-b", "m-b1")).toBe("disabled");
    // 未知模型 → max
    expect(defaultReasoningLevel(catalog, "prov-x", "m-x")).toBe(DEFAULT_REASONING_LEVEL);
  });

  it("applyReasoningDefault：已有档位不覆盖；缺省补链", () => {
    writeJson(REGISTRY_REL, PROVIDER_CONFIG);
    writeJson(CONFIG_REL, CONFIG);
    const catalog = readModelCatalog(home);
    const kept = { providerId: "prov-a", modelId: "m-a1", reasoningLevel: "low" };
    expect(applyReasoningDefault(catalog, kept)).toBe(kept);
    expect(applyReasoningDefault(catalog, { providerId: "prov-a", modelId: "m-a1" })).toEqual({
      providerId: "prov-a",
      modelId: "m-a1",
      reasoningLevel: "high",
    });
    expect(applyReasoningDefault(catalog, { providerId: "unknown", modelId: "m" })).toEqual({
      providerId: "unknown",
      modelId: "m",
      reasoningLevel: "max",
    });
  });
});

describe("容错分支（漂移形态不炸、不污染输出）", () => {
  it("provider_config：config 非对象 → 回退", () => {
    writeJson(REGISTRY_REL, { config: [] });
    writeJson(CONFIG_REL, CONFIG);
    const result = readModelCatalogDetailed(home);
    expect(result.source).toBe("config-json");
    expect(result.warning).toContain("config is not an object");
  });

  it("provider_config：规则里的坏条目/重复 id/空 id 被跳过或去重", () => {
    writeJson(REGISTRY_REL, {
      config: {
        providerOrder: ["p1", "p1", "", 42, "p-missing-rule"],
        providerConfigRules: {
          providerRules: [
            null,
            "junk",
            [],
            { providerId: "", config: { modelOrder: ["x"] } },
            { providerId: "p1", providerName: "  ", config: { modelOrder: ["m1", "m1", "", 7] } },
            { providerId: "p1", providerName: "Later Duplicate", config: { modelOrder: ["m2"] } },
            { providerId: "p-unused", config: { modelOrder: ["mu"] } },
          ],
        },
        modelConfigRules: {
          providerModelRules: [
            null,
            "junk",
            { providerId: "", modelId: "m1", config: {} },
            { providerId: "p1", modelId: "", config: {} },
            { providerId: "p1", modelId: "m1", config: "bad" },
          ],
        },
      },
    });
    const catalog = readModelCatalog(home);
    // 重复/空/非字符串 order 去重或跳过；p-missing-rule 无规则 → 空模型列表
    expect(catalog.providers.map((p) => p.providerId)).toEqual(["p1", "p-missing-rule"]);
    // 同 providerId 的重复规则：后写覆盖（Map 语义，病态形态取最后一条）；api 缺失 → kind unknown
    expect(catalog.providers[0]).toMatchObject({ name: "Later Duplicate", kind: "unknown" });
    // 模型列表来自生效规则（m2）；m1 的模型规则存在但不在 modelOrder → 不出现
    expect(catalog.providers[0]!.models).toEqual([{ id: "m2", enabled: true }]);
    expect(catalog.providers[1]!.models).toEqual([]);
  });

  it("config.json 回退：config.provider 非对象 → 空目录 + error", () => {
    writeJson(CONFIG_REL, { provider: [] });
    expect(readModelCatalogDetailed(home)).toMatchObject({
      source: "config-json",
      catalog: { providers: [] },
      error: "model catalog unavailable: config.provider is not an object",
    });
  });

  it("config.json 回退：坏 provider 值/空键跳过；数组形态 models 与空 id 处理；reasoning enabled=false 不输出", () => {
    writeJson(CONFIG_REL, {
      provider: {
        "": { name: "empty-key" },
        bad: "x",
        nil: null,
        good: {
          name: "Good",
          kind: "k",
          models: [
            { id: "arr-1", reasoning: { enabled: false, variants: ["high"] } },
            { id: "" },
            "junk",
            { id: "arr-2", reasoning: { variants: "not-array" } },
          ],
        },
        shapes: { models: { "dict-1": "junk", "dict-2": { reasoning: { variants: ["low", "low", " "] } } } },
      },
    });
    const result = readModelCatalogDetailed(home);
    expect(result.catalog.providers.map((p) => p.providerId)).toEqual(["good", "shapes"]);
    expect(result.catalog.providers[0]!.models).toEqual([
      { id: "arr-1", enabled: true },
      { id: "arr-2", enabled: true },
    ]);
    // 去重 + 空白项过滤
    expect(result.catalog.providers[1]!.models).toEqual([
      { id: "dict-1", enabled: true },
      { id: "dict-2", enabled: true, reasoning: { variants: ["low"] } },
    ]);
  });

  it("reader：两个源都坏 → error（lastError 命中）", () => {
    writeJson(REGISTRY_REL, "{bad");
    writeJson(CONFIG_REL, "{bad");
    const errors: string[] = [];
    const reader = createModelCatalogReader(home, (m) => errors.push(m));
    expect(reader().providers).toEqual([]);
    expect(reader.lastError()).toContain("provider registry unavailable");
    expect(errors.some((e) => e.includes("model catalog unavailable"))).toBe(true);
  });
});

describe("createModelCatalogReader · 双源 mtime 缓存", () => {
  it("首读缓存；provider_config 变化 → 重读；provider_config 损坏 → 回退并上报 warning", () => {
    writeJson(REGISTRY_REL, PROVIDER_CONFIG);
    writeJson(CONFIG_REL, CONFIG);
    const warnings: string[] = [];
    const reader = createModelCatalogReader(home, (m) => warnings.push(m));
    expect(reader().providers.map((p) => p.providerId)).toEqual(["prov-a", "prov-b", "prov-empty"]);
    expect(reader()).toBe(reader()); // 未变 → 同一对象
    expect(reader.lastError()).toBeUndefined();

    writeJson(REGISTRY_REL, {
      config: {
        providerOrder: ["only"],
        providerConfigRules: { providerRules: [{ providerId: "only", config: { modelOrder: ["m"] } }] },
      },
    });
    expect(reader().providers.map((p) => p.providerId)).toEqual(["only"]);

    writeJson(REGISTRY_REL, "{broken");
    expect(reader().providers.map((p) => p.providerId)).toEqual(["prov-a"]); // 回退 config.json
    expect(reader.lastError()).toBeUndefined(); // 回退成功 → 无 error
    expect(warnings.some((w) => w.includes("provider registry unavailable"))).toBe(true);
  });
});
