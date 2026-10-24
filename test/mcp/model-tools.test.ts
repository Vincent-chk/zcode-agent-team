// 对话通道模型工具（stage-8 Round C）：spawn 的 model/thoughtLevel 解析（目录消歧三态）+
// member_set_model 转发与错误面。夹具 = MockProvider + 注入的固定模型目录。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TeamToolBackend } from "../../src/mcp/backend.js";
import { callTeamTool } from "../../src/mcp/registry.js";
import type { CallToolResult } from "../../src/mcp/results.js";
import { upsertSessionEntry } from "../../src/mcp/identity.js";
import { MockProvider } from "../../src/provider/mock-provider.js";
import type { ModelCatalog } from "../../src/provider/model-catalog.js";
import type { TeamLimits } from "../../src/domain/config.js";

const LIMITS: TeamLimits = {
  maxMembers: 8,
  maxTasks: 256,
  maxMessageBytes: 65536,
  disposalTimeoutMs: 5000,
};

/** 固定目录：model-a 在两个 enabled provider 上都有（歧义）；solo 唯一；off 上只有 solo（不算）。 */
const CATALOG: ModelCatalog = {
  providers: [
    {
      providerId: "prov-a",
      name: "Provider A",
      kind: "anthropic",
      enabled: true,
      models: [{ id: "model-a", reasoning: { variants: ["low", "high"], defaultVariant: "high" } }],
    },
    {
      providerId: "prov-b",
      name: "Provider B",
      kind: "openai",
      enabled: true,
      models: [{ id: "model-a" }, { id: "solo" }, { id: "m-off", enabled: false }],
    },
    {
      providerId: "prov-lead",
      name: "Provider Lead",
      kind: "anthropic",
      enabled: true,
      models: [{ id: "model-a" }],
    },
    {
      providerId: "prov-off",
      name: "Provider Off",
      kind: "k",
      enabled: false,
      disabledReason: "oauth_provider_inactive",
      models: [{ id: "solo" }],
    },
  ],
};

let root: string;
let dataRoot: string;
let provider: MockProvider;
let backend: TeamToolBackend;
let catalog: ModelCatalog;

const TEAM = "sess_lead_models";

function call(tool: string, args: Record<string, unknown>, sessionId = TEAM): Promise<CallToolResult> {
  upsertSessionEntry(dataRoot, sessionId, { firstSeen: new Date().toISOString(), hookRegistered: true });
  return callTeamTool({
    backend,
    dataRoot,
    bootTimeMs: Date.now(),
    name: tool,
    args,
    meta: { session_id: sessionId },
  });
}

function body(result: CallToolResult): unknown {
  expect(result.isError).toBeUndefined();
  const block = result.content[0] as { text: string };
  return JSON.parse(block.text);
}

function error(result: CallToolResult): { code?: string; message: string } {
  expect(result.isError).toBe(true);
  const block = result.content[0] as { text: string };
  const parsed = JSON.parse(block.text) as { error: { code?: string; message: string } };
  return parsed.error;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-model-tools-"));
  dataRoot = fs.mkdtempSync(path.join(root, "team-"));
  provider = new MockProvider();
  catalog = CATALOG;
  backend = new TeamToolBackend({
    dataRoot,
    limits: LIMITS,
    provider,
    modelCatalog: () => catalog,
  });
});

afterEach(async () => {
  await backend.close().catch(() => undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

const SPAWN_BASE = { name: "worker", description: "d", prompt: "p" };

function child(memberId = "worker") {
  return [...provider.teamChildren.values()].find((c) => c.name === memberId);
}

describe("spawn_teammate · model/thoughtLevel 解析", () => {
  it("全称规格直接用；thoughtLevel 并入选择（目录 variants 命中）", async () => {
    const result = await call("spawn_teammate", {
      ...SPAWN_BASE,
      model: "prov-a$model-a",
      thoughtLevel: "high",
    });
    expect(body(result)).toMatchObject({ member: { target: "worker" } });
    expect(child()?.modelSelection).toEqual({
      providerId: "prov-a",
      modelId: "model-a",
      reasoningLevel: "high",
    });
  });

  it("裸 id 唯一命中 → 该 enabled provider", async () => {
    await call("spawn_teammate", { ...SPAWN_BASE, model: "solo" });
    expect(child()?.modelSelection).toEqual({ providerId: "prov-b", modelId: "solo" });
  });

  it("裸 id 多处命中 → 优先 Lead 当前 provider", async () => {
    provider.programWith({ leadModelSelection: { providerId: "prov-lead", modelId: "model-a" } });
    await call("spawn_teammate", { ...SPAWN_BASE, model: "model-a" });
    expect(child()?.modelSelection).toEqual({ providerId: "prov-lead", modelId: "model-a" });
  });

  it("裸 id 多处命中且无 Lead provider → 报错列候选", async () => {
    const result = await call("spawn_teammate", { ...SPAWN_BASE, model: "model-a" });
    const err = error(result);
    expect(err.code).toBe("TEAM_INVALID_ARGUMENT");
    expect(err.message).toContain('model "model-a" is ambiguous');
    expect(err.message).toContain("prov-a");
    expect(err.message).toContain("prov-b");
    expect(err.message).toContain("providerId$modelId");
  });

  it("裸 id 不在任何 enabled provider → 报错", async () => {
    const err = error(await call("spawn_teammate", { ...SPAWN_BASE, model: "nope" }));
    expect(err.code).toBe("TEAM_INVALID_ARGUMENT");
    expect(err.message).toBe('model "nope" not found in any enabled provider');
  });

  it("目录不可用 + 裸 id → 提示改用全称；全称仍可用", async () => {
    catalog = { providers: [] };
    const bare = error(await call("spawn_teammate", { ...SPAWN_BASE, model: "solo" }));
    expect(bare.message).toContain("model catalog unavailable: use \"providerId$modelId\"");
    const full = await call("spawn_teammate", { ...SPAWN_BASE, name: "w2", model: "prov-x$model-x" });
    expect(body(full)).toMatchObject({ member: { target: "w2" } });
    expect(child("w2")?.modelSelection).toEqual({ providerId: "prov-x", modelId: "model-x" });
  });

  it("thoughtLevel 与目录 variants 不符 → 报错列 variants", async () => {
    const err = error(
      await call("spawn_teammate", { ...SPAWN_BASE, model: "prov-a$model-a", thoughtLevel: "max" }),
    );
    expect(err.code).toBe("TEAM_INVALID_ARGUMENT");
    expect(err.message).toBe(
      'thoughtLevel "max" is not supported by model model-a (variants: low, high)',
    );
  });

  it("模型在目录但 variants 未知（provider_config 源无 reasoning 元数据）→ thoughtLevel 原样透传（宿主裁判）", async () => {
    // E-1 实测：deepseek-flash 这类模型目录无 variants，但宿主 setModel 反而强制要求档位——
    // 预先拒绝会把可用组合挡在门外（如 deepseek-flash+max），改由宿主最终裁判。
    const res = await call("spawn_teammate", { ...SPAWN_BASE, model: "prov-b$solo", thoughtLevel: "high" });
    expect(child()?.modelSelection).toEqual({ providerId: "prov-b", modelId: "solo", reasoningLevel: "high" });
  });

  it("thoughtLevel-only（不指定 model）→ 透传强度，不构造选择（继承链在 provider 侧）", async () => {
    await call("spawn_teammate", { ...SPAWN_BASE, thoughtLevel: "high" });
    expect(child()?.thoughtLevel).toBe("high");
    expect(child()?.modelSelection).toBeUndefined();
  });

  it("非法 model 规格 → TEAM_INVALID_ARGUMENT", async () => {
    const err = error(await call("spawn_teammate", { ...SPAWN_BASE, model: "prov$" }));
    expect(err.code).toBe("TEAM_INVALID_ARGUMENT");
    expect(err.message).toContain("providerId and modelId are both required");
  });

  it("E-1：全称规格 + 目录含该 provider 但 model 打错 → 报错列该 provider 可用模型", async () => {
    const err = error(await call("spawn_teammate", { ...SPAWN_BASE, model: "prov-a$typo-model" }));
    expect(err.code).toBe("TEAM_INVALID_ARGUMENT");
    expect(err.message).toBe(
      'model "typo-model" not found in provider "prov-a" (available: model-a)',
    );
    // 不落成员（校验在 spawn 之前）
    expect(child()).toBeUndefined();
  });

  it("E-1：全称规格 + provider 无模型 → available: none", async () => {
    catalog = {
      providers: [
        { providerId: "empty-prov", name: "Empty", kind: "k", enabled: true, models: [] },
      ],
    };
    const err = error(await call("spawn_teammate", { ...SPAWN_BASE, model: "empty-prov$any" }));
    expect(err.message).toBe('model "any" not found in provider "empty-prov" (available: none)');
  });

  it("E-1b：全称规格指向 Registry 停用模型 → 拒绝（同属 pending 死循环防线）", async () => {
    const err = error(await call("spawn_teammate", { ...SPAWN_BASE, model: "prov-b$m-off" }));
    expect(err.code).toBe("TEAM_INVALID_ARGUMENT");
    expect(err.message).toBe('model "m-off" is disabled in provider "prov-b"');
  });

  it("E-1b：裸 id 命中停用模型 → 视为不可用（不参与消歧）", async () => {
    const err = error(await call("spawn_teammate", { ...SPAWN_BASE, model: "m-off" }));
    expect(err.message).toBe('model "m-off" not found in any enabled provider');
  });

  it("E-1：全称规格 + 目录没有该 provider（account: 形态）→ 原样透传", async () => {
    await call("spawn_teammate", {
      ...SPAWN_BASE,
      model: "account:external-plan$GLM-5.3",
      thoughtLevel: "max",
    });
    expect(child()?.modelSelection).toEqual({
      providerId: "account:external-plan",
      modelId: "GLM-5.3",
      reasoningLevel: "max",
    });
  });

  it("E-1：member_set_model 同样受全称目录校验（防 pending 无限重试）", async () => {
    await call("spawn_teammate", SPAWN_BASE);
    const err = error(
      await call("member_set_model", { target: "worker", model: "prov-a$typo-model" }),
    );
    expect(err.code).toBe("TEAM_INVALID_ARGUMENT");
    expect(err.message).toBe(
      'model "typo-model" not found in provider "prov-a" (available: model-a)',
    );
    expect(provider.modelSetCalls).toEqual([]); // 校验失败不进 provider/pending
  });

  it("model 非字符串 → TEAM_INVALID_ARGUMENT", async () => {
    const err = error(await call("spawn_teammate", { ...SPAWN_BASE, model: 42 }));
    expect(err.code).toBe("TEAM_INVALID_ARGUMENT");
    expect(err.message).toBe('param "model" must be a string');
  });
});

describe("member_set_model", () => {
  async function spawnWorker(): Promise<void> {
    await call("spawn_teammate", SPAWN_BASE);
  }

  it("空闲成员：应用 now；规格解析后经方法表下发（mock 记录）", async () => {
    await spawnWorker();
    const result = await call("member_set_model", {
      target: "worker",
      model: "prov-a$model-a",
      thoughtLevel: "high",
    });
    expect(body(result)).toEqual({ applied: "now" });
    expect(provider.modelSetCalls).toEqual([
      { memberId: child()!.memberId, modelSelection: { providerId: "prov-a", modelId: "model-a", reasoningLevel: "high" } },
    ]);
  });

  it("thoughtLevel-only → 只下发强度（模型基底由 provider 合并）", async () => {
    await spawnWorker();
    const result = await call("member_set_model", { target: "worker", thoughtLevel: "low" });
    expect(body(result)).toEqual({ applied: "now" });
    expect(provider.modelSetCalls).toEqual([{ memberId: child()!.memberId, thoughtLevel: "low" }]);
  });

  it("next-turn 结果原样返回（运行中/即时失败由 provider 决定）", async () => {
    await spawnWorker();
    provider.programWith({ modelSetResults: ["next-turn"] });
    const result = await call("member_set_model", { target: "worker", model: "prov-b$solo" });
    expect(body(result)).toEqual({ applied: "next-turn" });
  });

  it("model / thoughtLevel 都缺 → 工具面 TEAM_INVALID_ARGUMENT", async () => {
    const err = error(await call("member_set_model", { target: "worker" }));
    expect(err.code).toBe("TEAM_INVALID_ARGUMENT");
    expect(err.message).toBe('param "model" or "thoughtLevel" is required');
  });

  it("目标不存在 → TEAM_MEMBER_NOT_FOUND", async () => {
    const err = error(await call("member_set_model", { target: "ghost", model: "solo" }));
    expect(err.code).toBe("TEAM_MEMBER_NOT_FOUND");
    expect(err.message).toBe('active teammate "ghost" not found');
  });

  it("target=lead → TEAM_INVALID_TARGET", async () => {
    const err = error(await call("member_set_model", { target: "lead", model: "solo" }));
    expect(err.code).toBe("TEAM_INVALID_TARGET");
    expect(err.message).toBe("target must be a teammate; the Lead model is session-scoped");
  });
});
