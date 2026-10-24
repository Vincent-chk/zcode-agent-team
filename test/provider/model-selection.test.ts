// 模型选择纯函数（stage-8 Round B）：字符串规格解析 + 结构化三元组形状校验。
import { describe, expect, it } from "vitest";
import { parseModelSelection, parseModelSpec } from "../../src/provider/model-selection.js";

describe("parseModelSpec", () => {
  it("providerId$modelId → 显式三元组（两端 trim）", () => {
    expect(parseModelSpec(" prov-a $ model-a ")).toEqual({ providerId: "prov-a", modelId: "model-a" });
  });

  it("裸 modelId → 只带 modelId（provider 由目录消歧）", () => {
    expect(parseModelSpec("deepseek-flash")).toEqual({ modelId: "deepseek-flash" });
  });

  it("首个 $ 切分：model 段可再含 $", () => {
    expect(parseModelSpec("p$m$suffix")).toEqual({ providerId: "p", modelId: "m$suffix" });
  });

  it("空串 → 抛错", () => {
    expect(() => parseModelSpec("   ")).toThrow(/empty/);
  });

  it.each(["$m", "p$", "$"])("缺 provider/model 的 %j → 抛错", (spec) => {
    expect(() => parseModelSpec(spec)).toThrow(/providerId and modelId are both required/);
  });
});

describe("parseModelSelection（形状校验）", () => {
  it("完整三元组：options.reasoningLevel 转 reasoningLevel（字段 trim）", () => {
    expect(
      parseModelSelection({
        providerId: " p ",
        modelId: " m ",
        options: { reasoningLevel: " high " },
      }),
    ).toEqual({ providerId: "p", modelId: "m", reasoningLevel: "high" });
  });

  it("无 options → 不带 reasoningLevel 键", () => {
    expect(parseModelSelection({ providerId: "p", modelId: "m" })).toEqual({ providerId: "p", modelId: "m" });
  });

  it("未知/非法形状 → undefined（只读探针不因脏行抛错）", () => {
    expect(parseModelSelection(undefined)).toBeUndefined();
    expect(parseModelSelection(null)).toBeUndefined();
    expect(parseModelSelection("p$m")).toBeUndefined();
    expect(parseModelSelection([])).toBeUndefined();
    expect(parseModelSelection({ providerId: "p" })).toBeUndefined();
    expect(parseModelSelection({ providerId: "", modelId: "m" })).toBeUndefined();
    expect(parseModelSelection({ providerId: "p", modelId: " " })).toBeUndefined();
    expect(parseModelSelection({ providerId: "p", modelId: "m", options: "x" })).toBeUndefined();
    expect(parseModelSelection({ providerId: "p", modelId: "m", options: [] })).toBeUndefined();
    expect(
      parseModelSelection({ providerId: "p", modelId: "m", options: { reasoningLevel: "" } }),
    ).toBeUndefined();
  });
});
