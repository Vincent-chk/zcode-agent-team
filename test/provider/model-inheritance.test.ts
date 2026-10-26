// model-inheritance 单测（0.4.1）：错误类型、指纹、失败分类（含真实进程退出形态）。
import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  ModelInheritanceError,
  ModelSyncSuppressedError,
  classifyApplyFailure,
  classifySelectionFailure,
  providerHasModelPreflight,
  selectionSignature,
} from "../../src/provider/model-inheritance.js";

describe("ModelInheritanceError / ModelSyncSuppressedError", () => {
  it("name/selection 承载；suppressed 是 inheritance 的子类（instanceof 兼容）", () => {
    const err = new ModelInheritanceError("boom", { providerId: "p", modelId: "m" });
    expect(err.name).toBe("ModelInheritanceError");
    expect(err.message).toBe("boom");
    expect(err.selection).toEqual({ providerId: "p", modelId: "m" });
    const noSel = new ModelInheritanceError("no selection");
    expect(noSel.selection).toBeUndefined();
    const suppressed = new ModelSyncSuppressedError("wait", { providerId: "p", modelId: "m" });
    expect(suppressed.name).toBe("ModelSyncSuppressedError");
    expect(suppressed).toBeInstanceOf(ModelInheritanceError);
    expect(suppressed.selection).toEqual({ providerId: "p", modelId: "m" });
  });
});

describe("selectionSignature（相同选择判定键）", () => {
  it("三元组全参与；档位缺省与空串等价；任一字段不同 → 指纹不同", () => {
    expect(selectionSignature({ providerId: "p", modelId: "m" })).toBe("p$m$");
    expect(selectionSignature({ providerId: "p", modelId: "m", reasoningLevel: "" })).toBe("p$m$");
    expect(selectionSignature({ providerId: "p", modelId: "m", reasoningLevel: "max" })).toBe("p$m$max");
    expect(selectionSignature({ providerId: "p", modelId: "m", reasoningLevel: "low" })).not.toBe(
      selectionSignature({ providerId: "p", modelId: "m", reasoningLevel: "max" }),
    );
    expect(selectionSignature({ providerId: "p", modelId: "m2" })).not.toBe(
      selectionSignature({ providerId: "p", modelId: "m" }),
    );
  });
});

describe("classifyApplyFailure（宿主应用失败分类）", () => {
  it("app-server 客户端透传的真实非零进程退出错误 → transient", async () => {
    const reason = await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, ["-e", "process.exit(1)"], (err) => {
        if (err === null) reject(new Error("expected the child process to exit nonzero"));
        else resolve(err.message);
      });
    });
    expect(reason).toMatch(/^Command failed:/);
    expect(classifyApplyFailure(reason)).toBe("transient");
  });

  it("基础设施/时序类 → transient", () => {
    for (const reason of [
      "app-server rpc timeout: session/setModel",
      "app-server did not become ready within 20000ms",
      "request timed out",
      "app-server spawn failed: ENOENT",
      "app-server exited",
      "EACCES: permission denied",
      "ECONNREFUSED 127.0.0.1:1",
      "EPIPE",
      "socket hang up",
      "app-server client is closed",
      "app-server client closed",
    ]) {
      expect(classifyApplyFailure(reason), reason).toBe("transient");
    }
  });

  it("宿主明确拒绝该模型 → deterministic", () => {
    for (const reason of [
      "Provider Registry 中不存在 Model: prov-b/model-b",
      "model was rejected by the host",
      "invalid model selection",
      "breeder does not support model application",
    ]) {
      expect(classifyApplyFailure(reason), reason).toBe("deterministic");
    }
  });
});

describe("classifySelectionFailure（解析失败分类）", () => {
  it("三源全空 → transient（Lead 一提交即可解）；套餐/目录外 → deterministic", () => {
    expect(classifySelectionFailure("无法确定 Lead 当前模型（会话库中没有提交快照、选模记录或主轮调用），成员无法继承。")).toBe("transient");
    expect(classifySelectionFailure("Lead 当前使用官方套餐模型（account:x/GLM-5.3），成员无法继承")).toBe("deterministic");
    expect(classifySelectionFailure("Lead 模型 p/m 不在可用模型目录（Provider 已删除/禁用，或模型不存在），成员无法继承。")).toBe("deterministic");
  });
});

describe("providerHasModelPreflight（能力探测）", () => {
  it("有 preflightMemberModel 方法 → true；无 → false（MockProvider 等跳过预检）", () => {
    expect(providerHasModelPreflight({ preflightMemberModel: () => undefined })).toBe(true);
    expect(providerHasModelPreflight({})).toBe(false);
    expect(providerHasModelPreflight({ preflightMemberModel: "not-a-function" })).toBe(false);
  });
});
