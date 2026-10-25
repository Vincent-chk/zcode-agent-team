// 会话隔离接线（stage-6）：child 模式下首轮以 `--resume <隐藏子会话>` 驱动，
// origin 记录隔离字段；培育失败 → 直接抛错（不静默回退为可见会话）。
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildProviderKit, insertModelUsage, insertSessionEntry } from "./kit.js";
import { listTurns, memberPaths, readOrigin } from "../../src/provider/member-files.js";
import type { MemberModelSelection } from "../../src/provider/model-selection.js";

const CHILD = "sess_child_hidden";

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
    const kit = buildProviderKit({ sessionIsolation: "child", breeder });
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
    const kit = buildProviderKit({ sessionIsolation: "child", breeder });
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

  it("E-1：Lead 条目失败 → model_usage 兜底生效；origin 只记实际生效者（usage）", async () => {
    const breeder = fakeBreeder(
      { anchorSessionId: "sess_anchor_fb", childSessionId: CHILD, elapsedMs: 1 },
      { primary: "fail", fallback: "ok" },
    );
    const kit = buildProviderKit({ sessionIsolation: "child", breeder });
    try {
      insertSessionEntry(kit.dbPath, {
        sessionId: kit.teamId,
        data: {
          modelSelection: { providerId: "account:unavailable-plan", modelId: "GLM-5.3", options: { reasoningLevel: "max" } },
        },
      });
      insertModelUsage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "usage-prov",
        modelId: "usage-model",
        variant: "max",
        startedAt: 1,
      });
      await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-fallback",
        name: "fb",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
      });
      // 两档按序传入：primary = 条目选择，fallback = usage 选择
      expect(breeder.calls[0]?.modelSelection).toEqual({
        providerId: "account:unavailable-plan",
        modelId: "GLM-5.3",
        reasoningLevel: "max",
      });
      expect(breeder.calls[0]?.modelFallback).toEqual({
        providerId: "usage-prov",
        modelId: "usage-model",
        reasoningLevel: "max",
      });
      // origin 不谎报：记的是实际生效的兜底选择，来源仍是 inherited
      const origin = readOrigin(memberPaths(kit.provider.teamDir, "m-fallback"));
      expect(origin).toMatchObject({
        modelSelection: { providerId: "usage-prov", modelId: "usage-model", reasoningLevel: "max" },
        modelSource: "inherited",
      });
      // 兜底生效 = 成功路径 → 不产生失败诊断
      expect(kit.provider.diagnosticsOf("m-fallback")).toEqual([]);
      expect(fs.existsSync(memberPaths(kit.provider.teamDir, "m-fallback").modelFailedFile)).toBe(false);
    } finally {
      await kit.cleanup();
    }
  });

  it("E-1：两档都失败 → 不传 appliedModel，origin 不记 modelSelection/modelSource", async () => {
    const breeder = fakeBreeder(
      { anchorSessionId: "sess_anchor_bf", childSessionId: CHILD, elapsedMs: 1 },
      { primary: "fail", fallback: "fail" },
    );
    const kit = buildProviderKit({ sessionIsolation: "child", breeder });
    try {
      insertSessionEntry(kit.dbPath, {
        sessionId: kit.teamId,
        data: { modelSelection: { providerId: "entry-prov", modelId: "entry-model" } },
      });
      insertModelUsage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "usage-prov",
        modelId: "usage-model",
        startedAt: 1,
      });
      await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-both-fail",
        name: "bf",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
      });
      const origin = readOrigin(memberPaths(kit.provider.teamDir, "m-both-fail"));
      expect(origin?.modelSelection).toBeUndefined();
      expect(origin?.modelSource).toBeUndefined();
      // GitHub #6：spawn 继承降级也必须可见（成员行诊断 + model-failed 落盘）
      expect(kit.provider.diagnosticsOf("m-both-fail")).toEqual([
        "模型设置未生效：entry-prov/entry-model（Lead 模型不可用于成员（registry 不识别））",
      ]);
      expect(fs.existsSync(memberPaths(kit.provider.teamDir, "m-both-fail").modelFailedFile)).toBe(true);
    } finally {
      await kit.cleanup();
    }
  });

  it("E-1：条目与 usage 相同 → 去重后不传 modelFallback", async () => {
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_dd", childSessionId: CHILD, elapsedMs: 1 });
    const kit = buildProviderKit({ sessionIsolation: "child", breeder });
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
