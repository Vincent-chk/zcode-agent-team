// MockProvider 模型呈现扩展（stage-8 Round B）：结构化选择记录 + Lead 行模型桩。
import { describe, expect, it } from "vitest";
import { MockProvider } from "../../src/provider/mock-provider.js";

const SPAWN = {
  teamId: "t",
  memberId: "m",
  name: "n",
  description: "d",
  firstPrompt: "p",
  context: "fresh" as const,
};

describe("MockProvider · 模型呈现扩展", () => {
  it("startContinuable 记录 modelSelection；modelOf 优先结构化选择", async () => {
    const provider = new MockProvider();
    await provider.startContinuable({
      ...SPAWN,
      modelSelection: { providerId: "p", modelId: "m-sel", reasoningLevel: "high" },
    });
    expect(provider.teamChildren.get("m")?.modelSelection).toEqual({
      providerId: "p",
      modelId: "m-sel",
      reasoningLevel: "high",
    });
    expect(provider.modelOf("m")).toBe("m-sel");
    expect(provider.modelOf("absent")).toBeUndefined();
  });

  it("显式 model 字符串仍可用；leadModelOf 可编程", async () => {
    const provider = new MockProvider();
    await provider.startContinuable({ ...SPAWN, memberId: "m2", model: "m-str" });
    expect(provider.modelOf("m2")).toBe("m-str");
    expect(provider.leadModelOf()).toBeUndefined();
    provider.programWith({ leadModel: "m-lead" });
    expect(provider.leadModelOf()).toBe("m-lead");
  });
});
