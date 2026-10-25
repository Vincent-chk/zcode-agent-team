// 会话隔离接线（stage-6）：child 模式下首轮以 `--resume <隐藏子会话>` 驱动，
// origin 记录隔离字段；培育失败 → 直接抛错（不静默回退为可见会话）。
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildProviderKit, insertModelUsage, insertSessionEntry } from "./kit.js";
import { listTurns, memberPaths, readOrigin } from "../../src/provider/member-files.js";
import type { MemberModelSelection } from "../../src/provider/model-selection.js";

const CHILD = "sess_child_hidden";

/** 0.3.2 测试目录：仅 first-prov/first-model、second-prov/second-model 为受支持组合。 */
const SUPPORTED_CATALOG = {
  providers: [
    {
      providerId: "first-prov",
      name: "First",
      kind: "k",
      enabled: true,
      models: [{ id: "first-model", enabled: true, reasoning: { variants: ["low", "high", "max"] } }],
    },
    {
      providerId: "second-prov",
      name: "Second",
      kind: "k",
      enabled: true,
      models: [{ id: "second-model", enabled: true, reasoning: { variants: ["low", "high"] } }],
    },
  ],
};


/** 培育器桩：记录 primary/fallback；按 behavior 模拟 setModel 三态并回报 appliedModel。 */
function fakeBreeder(
  result:
    | { anchorSessionId: string; childSessionId: string; elapsedMs: number; workspacePath?: string }
    | Error,
  behavior: { primary?: "ok" | "fail"; fallback?: "ok" | "fail" } = {},
) {
  return {
    calls: [] as Array<{
      teamId: string;
      workspacePath: string;
      modelSelection?: MemberModelSelection;
      modelFallback?: MemberModelSelection;
    }>,
    async createChild(input: {
      teamId: string;
      workspacePath: string;
      modelSelection?: MemberModelSelection;
      modelFallback?: MemberModelSelection;
    }) {
      this.calls.push({
        teamId: input.teamId,
        workspacePath: input.workspacePath,
        ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
        ...(input.modelFallback !== undefined ? { modelFallback: input.modelFallback } : {}),
      });
      if (result instanceof Error) throw result;
      const applied =
        input.modelSelection === undefined
          ? undefined
          : (behavior.primary ?? "ok") === "ok"
            ? input.modelSelection
            : input.modelFallback !== undefined && (behavior.fallback ?? "ok") === "ok"
              ? input.modelFallback
              : undefined;
      return {
        ...result,
        workspacePath: result.workspacePath ?? input.workspacePath,
        ...(applied !== undefined ? { appliedModel: applied } : {}),
      };
    },
  };
}

describe("ResumePerTurnProvider · sessionIsolation=child", () => {
  it("首轮 argv 含 --resume <child>；origin 记录隔离字段", async () => {
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_x", childSessionId: CHILD, elapsedMs: 12 });
    const kit = buildProviderKit({ sessionIsolation: "child", breeder });
    try {
      const result = await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-iso",
        name: "alpha",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
      });
      expect(result.accepted).toBe(true);
      expect(breeder.calls).toEqual([{ teamId: kit.teamId, workspacePath: kit.cwd }]);

      const paths = memberPaths(kit.provider.teamDir, "m-iso");
      const origin = readOrigin(paths);
      expect(origin).toMatchObject({
        sessionId: CHILD,
        sessionIsolation: "child",
        anchorSessionId: "sess_anchor_x",
        logicalParentSessionId: kit.teamId,
        sessionKind: "selection_side_chat",
        initialUserMessageAccepted: true,
      });
      const turn = listTurns(paths.runDir)[0]!;
      expect(turn.argv).toContain("--resume");
      expect(turn.argv[turn.argv.indexOf("--resume") + 1]).toBe(CHILD);
      expect(turn.argv[turn.argv.indexOf("--cwd") + 1]).toBe(kit.cwd);
    } finally {
      await kit.cleanup();
    }
  });

  it("培育失败 → startContinuable 抛错（不静默回退）", async () => {
    const breeder = fakeBreeder(new Error("createSelectionSideSession rejected: unsupported"));
    const kit = buildProviderKit({ sessionIsolation: "child", breeder });
    try {
      await expect(
        kit.provider.startContinuable({
          teamId: kit.teamId,
          memberId: "m-iso-fail",
          name: "beta",
          description: "d",
          firstPrompt: "做一件事",
          context: "fresh",
        }),
      ).rejects.toThrow(/unsupported/);
      // 没有落 origin（失败发生在落盘前）
      const paths = memberPaths(kit.provider.teamDir, "m-iso-fail");
      expect(fs.existsSync(paths.originFile)).toBe(false);
      expect(fs.existsSync(path.join(paths.runDir))).toBe(false);
    } finally {
      await kit.cleanup();
    }
  });
});

describe("ResumePerTurnProvider · 模型继承（Round B）", () => {
  it("显式 modelSelection → 传给培育器；origin 记 explicit", async () => {
    const selection: MemberModelSelection = {
      providerId: "prov-explicit",
      modelId: "model-explicit",
      reasoningLevel: "high",
    };
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_e", childSessionId: CHILD, elapsedMs: 1 });
    const kit = buildProviderKit({ sessionIsolation: "child", breeder });
    try {
      const result = await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-explicit",
        name: "alpha",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
        modelSelection: selection,
      });
      expect(result.accepted).toBe(true);
      expect(breeder.calls[0]?.modelSelection).toEqual(selection);
      const origin = readOrigin(memberPaths(kit.provider.teamDir, "m-explicit"));
      expect(origin).toMatchObject({ modelSelection: selection, modelSource: "explicit" });
    } finally {
      await kit.cleanup();
    }
  });

  it("无显式 → 继承 Lead 的 session_entry 条目（含 reasoningLevel）；origin 记 inherited", async () => {
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_i", childSessionId: CHILD, elapsedMs: 1 });
    const kit = buildProviderKit({
      sessionIsolation: "child",
      breeder,
      modelCatalog: () => ({
        providers: [{ providerId: "lead-prov", name: "Lead", kind: "k", enabled: true, models: [{ id: "lead-model", enabled: true }] }],
      }),
    });
    try {
      insertSessionEntry(kit.dbPath, {
        sessionId: kit.teamId,
        data: {
          modelSelection: { providerId: "lead-prov", modelId: "lead-model", options: { reasoningLevel: "max" } },
        },
      });
      await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-inherit",
        name: "beta",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
      });
      expect(breeder.calls[0]?.modelSelection).toEqual({
        providerId: "lead-prov",
        modelId: "lead-model",
        reasoningLevel: "max",
      });
      const origin = readOrigin(memberPaths(kit.provider.teamDir, "m-inherit"));
      expect(origin).toMatchObject({
        modelSelection: { providerId: "lead-prov", modelId: "lead-model", reasoningLevel: "max" },
        modelSource: "inherited",
      });
    } finally {
      await kit.cleanup();
    }
  });

  it("session_entry 缺失 → model_usage 最新调用兜底（variant → reasoningLevel）", async () => {
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_u", childSessionId: CHILD, elapsedMs: 1 });
    const kit = buildProviderKit({
      sessionIsolation: "child",
      breeder,
      modelCatalog: () => ({
        providers: [{ providerId: "usage-prov", name: "Usage", kind: "k", enabled: true, models: [{ id: "usage-model", enabled: true }] }],
      }),
    });
    try {
      insertModelUsage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "usage-prov",
        modelId: "usage-model",
        variant: "low",
        startedAt: 1,
      });
      await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-usage",
        name: "gamma",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
      });
      expect(breeder.calls[0]?.modelSelection).toEqual({
        providerId: "usage-prov",
        modelId: "usage-model",
        reasoningLevel: "low",
      });
      expect(readOrigin(memberPaths(kit.provider.teamDir, "m-usage"))).toMatchObject({
        modelSource: "inherited",
      });
    } finally {
      await kit.cleanup();
    }
  });

  it("Lead 无任何模型记录 → 不传 modelSelection（不调 setModel），origin 无选择字段", async () => {
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_n", childSessionId: CHILD, elapsedMs: 1 });
    const kit = buildProviderKit({ sessionIsolation: "child", breeder });
    try {
      await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-default",
        name: "delta",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
      });
      expect(breeder.calls[0]?.modelSelection).toBeUndefined();
      const origin = readOrigin(memberPaths(kit.provider.teamDir, "m-default"));
      expect(origin?.modelSelection).toBeUndefined();
      expect(origin?.modelSource).toBeUndefined();
    } finally {
      await kit.cleanup();
    }
  });

  it("0.3.2：entry=官方套餐 + usage=目录内 → 直接继承 usage（零套餐尝试，无 fallback）", async () => {
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_mix", childSessionId: CHILD, elapsedMs: 1 });
    const kit = buildProviderKit({ sessionIsolation: "child", breeder, modelCatalog: () => SUPPORTED_CATALOG });
    try {
      insertSessionEntry(kit.dbPath, {
        sessionId: kit.teamId,
        data: {
          modelSelection: { providerId: "account:unavailable-plan", modelId: "GLM-5.3", options: { reasoningLevel: "max" } },
        },
      });
      insertModelUsage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "first-prov",
        modelId: "first-model",
        variant: "max",
        startedAt: 1,
      });
      await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-mixed",
        name: "mx",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
      });
      // 套餐被分类过滤：breeder 只收到 usage 一档（且不是 fallback）
      expect(breeder.calls[0]?.modelSelection).toEqual({
        providerId: "first-prov",
        modelId: "first-model",
        reasoningLevel: "max",
      });
      expect(breeder.calls[0]?.modelFallback).toBeUndefined();
      const origin = readOrigin(memberPaths(kit.provider.teamDir, "m-mixed"));
      expect(origin).toMatchObject({
        modelSelection: { providerId: "first-prov", modelId: "first-model", reasoningLevel: "max" },
        modelSource: "inherited",
      });
      expect(kit.provider.diagnosticsOf("m-mixed")).toEqual([]);
    } finally {
      await kit.cleanup();
    }
  });

  it("0.3.2：entry+usage 均为官方套餐 → 零 setModel 尝试 + 套餐口径诊断", async () => {
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_plan", childSessionId: CHILD, elapsedMs: 1 });
    const kit = buildProviderKit({ sessionIsolation: "child", breeder, modelCatalog: () => SUPPORTED_CATALOG });
    try {
      insertSessionEntry(kit.dbPath, {
        sessionId: kit.teamId,
        data: {
          modelSelection: { providerId: "account:bigmodel-start-plan", modelId: "GLM-5.3", options: { reasoningLevel: "max" } },
        },
      });
      insertModelUsage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "builtin:bigmodel",
        modelId: "GLM-5.3",
        variant: "max",
        startedAt: 1,
      });
      await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-plan",
        name: "pl",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
      });
      // 分类跳过：createChild 不带任何模型参数 → provider 侧零 setModel
      expect(breeder.calls[0]?.modelSelection).toBeUndefined();
      expect(breeder.calls[0]?.modelFallback).toBeUndefined();
      // origin 不谎报
      const origin = readOrigin(memberPaths(kit.provider.teamDir, "m-plan"));
      expect(origin?.modelSelection).toBeUndefined();
      expect(origin?.modelSource).toBeUndefined();
      // 套餐口径诊断（可操作建议；reason 仅长度截断 ≤80，断言首尾关键文案）
      const [diagnostic] = kit.provider.diagnosticsOf("m-plan");
      expect(diagnostic).toContain("模型设置未生效：account:bigmodel-start-plan/GLM-5.3");
      expect(diagnostic).toContain("Lead 当前使用官方套餐模型");
      expect(diagnostic).toContain("成员无法继承，已回退宿主缺省");
      expect(diagnostic).toContain("可在 spawn 时指"); // 80 字符截断点在句中
      expect(diagnostic).not.toContain("registry 不识别"); // 不再是「尝试后失败」文案
      expect(fs.existsSync(memberPaths(kit.provider.teamDir, "m-plan").modelFailedFile)).toBe(true);
    } finally {
      await kit.cleanup();
    }
  });

  it("0.3.2：entry+usage 均为目录外陈旧自有 provider → 零尝试 + 目录外文案", async () => {
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_stale", childSessionId: CHILD, elapsedMs: 1 });
    const kit = buildProviderKit({ sessionIsolation: "child", breeder, modelCatalog: () => SUPPORTED_CATALOG });
    try {
      insertSessionEntry(kit.dbPath, {
        sessionId: kit.teamId,
        data: { modelSelection: { providerId: "deleted-uuid", modelId: "old-model" } },
      });
      insertModelUsage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "another-gone-uuid",
        modelId: "old-model-2",
        startedAt: 1,
      });
      await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-stale",
        name: "st",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
      });
      expect(breeder.calls[0]?.modelSelection).toBeUndefined();
      expect(breeder.calls[0]?.modelFallback).toBeUndefined();
      expect(kit.provider.diagnosticsOf("m-stale")).toEqual([
        "模型设置未生效：deleted-uuid/old-model（Lead 模型 deleted-uuid/old-model 不在可用目录，已回退宿主缺省）",
      ]);
    } finally {
      await kit.cleanup();
    }
  });

  it("0.3.2：注入空目录 → 空目录守卫：不过滤，仍尝试 entry（旧行为）", async () => {
    const breeder = fakeBreeder(
      { anchorSessionId: "sess_anchor_empty", childSessionId: CHILD, elapsedMs: 1 },
      { primary: "fail", fallback: "fail" },
    );
    const kit = buildProviderKit({ sessionIsolation: "child", breeder, modelCatalog: () => ({ providers: [] }) });
    try {
      insertSessionEntry(kit.dbPath, {
        sessionId: kit.teamId,
        data: { modelSelection: { providerId: "entry-prov", modelId: "entry-model" } },
      });
      await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-empty-cat",
        name: "ec",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
      });
      // 空目录不过滤 → 仍向 breeder 传选择并尝试（尝试失败文案，非套餐文案）
      expect(breeder.calls[0]?.modelSelection).toMatchObject({
        providerId: "entry-prov",
        modelId: "entry-model",
      });
      const [diagnostic] = kit.provider.diagnosticsOf("m-empty-cat");
      expect(diagnostic).toContain("Lead 模型不可用于成员（registry 不识别）");
    } finally {
      await kit.cleanup();
    }
  });

  it("E-1：条目与 usage 相同 → 去重后不传 modelFallback", async () => {
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_dd", childSessionId: CHILD, elapsedMs: 1 });
    const kit = buildProviderKit({
      sessionIsolation: "child",
      breeder,
      modelCatalog: () => ({
        providers: [{ providerId: "same-prov", name: "Same", kind: "k", enabled: true, models: [{ id: "same-model", enabled: true }] }],
      }),
    });
    try {
      insertSessionEntry(kit.dbPath, {
        sessionId: kit.teamId,
        data: {
          modelSelection: { providerId: "same-prov", modelId: "same-model", options: { reasoningLevel: "high" } },
        },
      });
      insertModelUsage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "same-prov",
        modelId: "same-model",
        variant: "high",
        startedAt: 1,
      });
      await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-dedupe",
        name: "dd",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
      });
      expect(breeder.calls[0]?.modelSelection).toEqual({
        providerId: "same-prov",
        modelId: "same-model",
        reasoningLevel: "high",
      });
      expect(breeder.calls[0]?.modelFallback).toBeUndefined();
    } finally {
      await kit.cleanup();
    }
  });

  it("E-1：显式指定不设兜底（即使 Lead 有 usage 记录）", async () => {
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_ex", childSessionId: CHILD, elapsedMs: 1 });
    const kit = buildProviderKit({ sessionIsolation: "child", breeder });
    try {
      insertModelUsage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "usage-prov",
        modelId: "usage-model",
        startedAt: 1,
      });
      await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-explicit-no-fb",
        name: "ex",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
        modelSelection: { providerId: "user-prov", modelId: "user-model" },
      });
      expect(breeder.calls[0]?.modelSelection).toEqual({
        providerId: "user-prov",
        modelId: "user-model",
        // E-1b 档位缺省链：显式模型无档位 → provider 层补 max（deepseek-flash 等必须带档位）
        reasoningLevel: "max",
      });
      expect(breeder.calls[0]?.modelFallback).toBeUndefined();
    } finally {
      await kit.cleanup();
    }
  });

  it("E-1b：继承选择无档位 → 目录 defaultVariant 补档（provider 层统一落点）", async () => {
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_rl", childSessionId: CHILD, elapsedMs: 1 });
    const kit = buildProviderKit({
      sessionIsolation: "child",
      breeder,
      modelCatalog: () => ({
        providers: [
          {
            providerId: "usage-prov",
            name: "Usage",
            kind: "k",
            enabled: true,
            models: [
              { id: "usage-model", enabled: true, reasoning: { variants: ["low", "high", "max"], defaultVariant: "high" } },
            ],
          },
        ],
      }),
    });
    try {
      insertModelUsage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "usage-prov",
        modelId: "usage-model",
        startedAt: 1,
      });
      await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-default-level",
        name: "rl",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
      });
      expect(breeder.calls[0]?.modelSelection).toEqual({
        providerId: "usage-prov",
        modelId: "usage-model",
        reasoningLevel: "high",
      });
      expect(readOrigin(memberPaths(kit.provider.teamDir, "m-default-level"))).toMatchObject({
        modelSelection: { providerId: "usage-prov", modelId: "usage-model", reasoningLevel: "high" },
        modelSource: "inherited",
      });
    } finally {
      await kit.cleanup();
    }
  });

  it("GitHub #6：显式指定失败 → 也落 model-failed（用户意图未被满足不能静默）", async () => {
    const breeder = fakeBreeder(
      { anchorSessionId: "sess_anchor_exf", childSessionId: CHILD, elapsedMs: 1 },
      { primary: "fail" },
    );
    const kit = buildProviderKit({ sessionIsolation: "child", breeder });
    try {
      await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-explicit-fail",
        name: "exf",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
        modelSelection: { providerId: "bad-prov", modelId: "bad-model" },
      });
      expect(kit.provider.diagnosticsOf("m-explicit-fail")).toEqual([
        "模型设置未生效：bad-prov/bad-model（指定的模型不可用于成员（registry 不识别））",
      ]);
      expect(readOrigin(memberPaths(kit.provider.teamDir, "m-explicit-fail"))?.modelSelection).toBeUndefined();
    } finally {
      await kit.cleanup();
    }
  });

  it("legacy 模式不应用继承/显式（无子会话）；origin 不记录模型选择", async () => {
    const kit = buildProviderKit();
    try {
      insertSessionEntry(kit.dbPath, {
        sessionId: kit.teamId,
        data: { modelSelection: { providerId: "lead-prov", modelId: "lead-model" } },
      });
      await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-legacy-model",
        name: "epsilon",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
        modelSelection: { providerId: "ignored", modelId: "ignored" },
      });
      const origin = readOrigin(memberPaths(kit.provider.teamDir, "m-legacy-model"));
      expect(origin?.modelSelection).toBeUndefined();
      expect(origin?.modelSource).toBeUndefined();
    } finally {
      await kit.cleanup();
    }
  });
});

describe("ResumePerTurnProvider · sessionIsolation=legacy（回滚路径）", () => {
  it("保持旧行为：首轮不带 --resume，origin 标记 legacy", async () => {
    const kit = buildProviderKit();
    try {
      const result = await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-legacy",
        name: "gamma",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
      });
      expect(result.accepted).toBe(true);
      const paths = memberPaths(kit.provider.teamDir, "m-legacy");
      const origin = readOrigin(paths);
      expect(origin).toMatchObject({ sessionIsolation: "legacy", sessionKind: "interactive" });
      expect(origin?.anchorSessionId).toBeUndefined();
      expect(listTurns(paths.runDir)[0]!.argv).not.toContain("--resume");
    } finally {
      await kit.cleanup();
    }
  });
});
