// 会话隔离接线（stage-6）：child 模式下首轮以 `--resume <隐藏子会话>` 驱动，
// origin 记录隔离字段；培育失败 → 直接抛错（不静默回退为可见会话）。
// 0.4.0 模型继承重写：成员唯一路线 = 跟随 Lead 最新**已确认**选择（三源判定：提交快照 /
// 选模条目 / main_turn 调用取最新）；解析不出 / 官方套餐 / 目录外 / 应用失败 = 抛错，
// 绝不静默回退宿主缺省。显式参数通道、usage 兜底档、分类跳过、pending 全部注销。
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildProviderKit,
  insertModelUsage,
  insertSessionEntry,
  insertSubmissionMessage,
} from "./kit.js";
import { listTurns, memberPaths, readOrigin } from "../../src/provider/member-files.js";
import type { MemberModelSelection } from "../../src/provider/model-selection.js";

const CHILD = "sess_child_hidden";

/** 0.4.0 测试目录：仅 first-prov/first-model、lead-prov/lead-model、usage-prov/usage-model 等注入组合受支持。 */
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

function catalogFor(selections: Array<{ providerId: string; modelId: string }>) {
  const byProvider = new Map<string, string[]>();
  for (const s of selections) {
    const list = byProvider.get(s.providerId) ?? [];
    list.push(s.modelId);
    byProvider.set(s.providerId, list);
  }
  return {
    providers: [...byProvider.entries()].map(([providerId, models]) => ({
      providerId,
      name: providerId,
      kind: "k",
      enabled: true,
      models: models.map((id) => ({ id, enabled: true })),
    })),
  };
}

/** 培育器桩：记录 createChild/applyModelSelection 调用；behavior 模拟 setModel 成败。 */
function fakeBreeder(
  result:
    | { anchorSessionId: string; childSessionId: string; elapsedMs: number; workspacePath?: string }
    | Error,
  behavior: { primary?: "ok" | "fail"; apply?: "ok" | "fail" } = {},
) {
  return {
    calls: [] as Array<{
      teamId: string;
      workspacePath: string;
      modelSelection?: MemberModelSelection;
    }>,
    applyCalls: [] as Array<{ sessionId: string; selection: MemberModelSelection }>,
    async createChild(input: {
      teamId: string;
      workspacePath: string;
      modelSelection?: MemberModelSelection;
    }) {
      this.calls.push({
        teamId: input.teamId,
        workspacePath: input.workspacePath,
        ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      });
      if (result instanceof Error) throw result;
      // 0.4.0：应用失败 = 抛（与真实 breeder 一致，绝不静默返回成功）
      if (input.modelSelection !== undefined && behavior.primary === "fail") {
        throw Object.assign(
          new Error(
            `member could not use the inherited model ${input.modelSelection.providerId}/${input.modelSelection.modelId}: fake setModel failure`,
          ),
          { code: "model-rejected", name: "BreedError" },
        );
      }
      return {
        ...result,
        workspacePath: result.workspacePath ?? input.workspacePath,
        ...(input.modelSelection !== undefined ? { appliedModel: input.modelSelection } : {}),
      };
    },
    async applyModelSelection(input: {
      sessionId: string;
      workspacePath: string;
      selection: MemberModelSelection;
    }) {
      this.applyCalls.push({ sessionId: input.sessionId, selection: input.selection });
      if (behavior.apply === "fail") {
        return { applied: false, reason: "fake apply failure" };
      }
      return { applied: true };
    },
  };
}

describe("ResumePerTurnProvider · sessionIsolation=child", () => {
  it("首轮 argv 含 --resume <child>；origin 记录隔离字段", async () => {
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_x", childSessionId: CHILD, elapsedMs: 12 });
    const kit = buildProviderKit({
      sessionIsolation: "child",
      breeder,
      modelCatalog: () => catalogFor([{ providerId: "lead-prov", modelId: "lead-model" }]),
    });
    try {
      insertSubmissionMessage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "lead-prov",
        modelId: "lead-model",
        timeCreated: 1_700_000_000_000,
      });
      const result = await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-iso",
        name: "alpha",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
      });
      expect(result.accepted).toBe(true);
      expect(breeder.calls).toEqual([
        {
          teamId: kit.teamId,
          workspacePath: kit.cwd,
          modelSelection: { providerId: "lead-prov", modelId: "lead-model", reasoningLevel: "max" },
        },
      ]);

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
    const kit = buildProviderKit({
      sessionIsolation: "child",
      breeder,
      modelCatalog: () => catalogFor([{ providerId: "lead-prov", modelId: "lead-model" }]),
    });
    try {
      insertSubmissionMessage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "lead-prov",
        modelId: "lead-model",
        timeCreated: 1_700_000_000_000,
      });
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

describe("ResumePerTurnProvider · 模型继承（0.4.0：唯一路线 = 跟随 Lead）", () => {
  it("三源之一（选模条目）→ 继承传给培育器；origin 记 inherited", async () => {
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_i", childSessionId: CHILD, elapsedMs: 1 });
    const kit = buildProviderKit({
      sessionIsolation: "child",
      breeder,
      modelCatalog: () => catalogFor([{ providerId: "lead-prov", modelId: "lead-model" }]),
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

  it("提交快照比陈旧条目新 → 继承提交选择（issue #7 场景：输入框切换未刷条目也能跟上）", async () => {
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_sub", childSessionId: CHILD, elapsedMs: 1 });
    const kit = buildProviderKit({
      sessionIsolation: "child",
      breeder,
      modelCatalog: () => catalogFor([
        { providerId: "old-prov", modelId: "old-model" },
        { providerId: "new-prov", modelId: "new-model" },
      ]),
    });
    try {
      insertSessionEntry(kit.dbPath, {
        sessionId: kit.teamId,
        timeCreated: 1_700_000_000_000,
        data: { modelSelection: { providerId: "old-prov", modelId: "old-model", options: { reasoningLevel: "low" } } },
      });
      // 更新的一次提交（宿主在保存用户消息时写 modelSelection 快照）
      insertSubmissionMessage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "new-prov",
        modelId: "new-model",
        reasoningLevel: "high",
        timeCreated: 1_700_000_100_000,
      });
      await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-stale-entry",
        name: "st",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
      });
      expect(breeder.calls[0]?.modelSelection).toEqual({
        providerId: "new-prov",
        modelId: "new-model",
        reasoningLevel: "high",
      });
    } finally {
      await kit.cleanup();
    }
  });

  it("/model 修改比提交新 → 继承条目选择（时间戳取最新，不固定优先级）", async () => {
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_mod", childSessionId: CHILD, elapsedMs: 1 });
    const kit = buildProviderKit({
      sessionIsolation: "child",
      breeder,
      modelCatalog: () => catalogFor([
        { providerId: "sub-prov", modelId: "sub-model" },
        { providerId: "mid-prov", modelId: "mid-model" },
      ]),
    });
    try {
      insertSubmissionMessage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "sub-prov",
        modelId: "sub-model",
        timeCreated: 1_700_000_000_000,
      });
      insertSessionEntry(kit.dbPath, {
        sessionId: kit.teamId,
        timeCreated: 1_700_000_200_000,
        data: { modelSelection: { providerId: "mid-prov", modelId: "mid-model", options: { reasoningLevel: "max" } } },
      });
      await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-model-cmd",
        name: "mc",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
      });
      expect(breeder.calls[0]?.modelSelection).toEqual({
        providerId: "mid-prov",
        modelId: "mid-model",
        reasoningLevel: "max",
      });
    } finally {
      await kit.cleanup();
    }
  });

  it("仅 main_turn 调用记录 → 继承（variant 进档位）；辅助调用（compact/标题）绝不当作 Lead 模型", async () => {
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_u", childSessionId: CHILD, elapsedMs: 1 });
    const kit = buildProviderKit({
      sessionIsolation: "child",
      breeder,
      modelCatalog: () => catalogFor([{ providerId: "usage-prov", modelId: "usage-model" }]),
    });
    try {
      // 干扰行：更晚的 compact 调用（辅助模型，必须被 query_source 过滤）
      insertModelUsage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "account:helper-plan",
        modelId: "title-model",
        startedAt: 1_700_000_900_000,
        querySource: "session_title",
      });
      insertModelUsage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "usage-prov",
        modelId: "usage-model",
        variant: "low",
        startedAt: 1_700_000_800_000,
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

  it("官方套餐（account:/builtin:）→ spawn 抛错（套餐口径可操作）；零 setModel 尝试；无成员落盘", async () => {
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_plan", childSessionId: CHILD, elapsedMs: 1 });
    const kit = buildProviderKit({
      sessionIsolation: "child",
      breeder,
      modelCatalog: () => SUPPORTED_CATALOG,
    });
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
        startedAt: 1,
      });
      await expect(
        kit.provider.startContinuable({
          teamId: kit.teamId,
          memberId: "m-plan",
          name: "pl",
          description: "d",
          firstPrompt: "做一件事",
          context: "fresh",
        }),
      ).rejects.toThrow(/官方套餐模型/);
      // fail-fast：培育未发生（零 setModel 尝试的等价口径 = createChild 未被调用）
      expect(breeder.calls).toHaveLength(0);
      const paths = memberPaths(kit.provider.teamDir, "m-plan");
      expect(fs.existsSync(paths.originFile)).toBe(false); // 没有产生成员
      const message = await kit.provider
        .startContinuable({
          teamId: kit.teamId,
          memberId: "m-plan2",
          name: "pl2",
          description: "d",
          firstPrompt: "做一件事",
          context: "fresh",
        })
        .catch((e: unknown) => String((e as Error).message));
      expect(message).toContain("account:bigmodel-start-plan/GLM-5.3");
      expect(message).toContain("请在 ZCode 中切换到自配的第三方模型");
    } finally {
      await kit.cleanup();
    }
  });

  it("目录外陈旧 provider → spawn 抛错（目录外口径）", async () => {
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_stale", childSessionId: CHILD, elapsedMs: 1 });
    const kit = buildProviderKit({
      sessionIsolation: "child",
      breeder,
      modelCatalog: () => SUPPORTED_CATALOG,
    });
    try {
      insertSessionEntry(kit.dbPath, {
        sessionId: kit.teamId,
        data: { modelSelection: { providerId: "deleted-uuid", modelId: "old-model" } },
      });
      await expect(
        kit.provider.startContinuable({
          teamId: kit.teamId,
          memberId: "m-stale",
          name: "st",
          description: "d",
          firstPrompt: "做一件事",
          context: "fresh",
        }),
      ).rejects.toThrow(/不在可用模型目录/);
      expect(breeder.calls).toHaveLength(0);
    } finally {
      await kit.cleanup();
    }
  });

  it("三源全空 → spawn 抛错（无法确定 Lead 当前模型）", async () => {
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_n", childSessionId: CHILD, elapsedMs: 1 });
    const kit = buildProviderKit({ sessionIsolation: "child", breeder });
    try {
      await expect(
        kit.provider.startContinuable({
          teamId: kit.teamId,
          memberId: "m-default",
          name: "delta",
          description: "d",
          firstPrompt: "做一件事",
          context: "fresh",
        }),
      ).rejects.toThrow(/无法确定 Lead 当前模型/);
      expect(breeder.calls).toHaveLength(0);
    } finally {
      await kit.cleanup();
    }
  });

  it("空目录守卫：目录不可读 = 无法分类 → 不过滤，照旧尝试（宿主终审）", async () => {
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_empty", childSessionId: CHILD, elapsedMs: 1 });
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
      expect(breeder.calls[0]?.modelSelection).toMatchObject({
        providerId: "entry-prov",
        modelId: "entry-model",
      });
    } finally {
      await kit.cleanup();
    }
  });

  it("档位缺省链：继承选择无档位 → 目录 defaultVariant 补档", async () => {
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

  it("继承应用失败 → spawn 抛错 + model-failed 留痕（成员卡诊断兜底）", async () => {
    const breeder = fakeBreeder(
      { anchorSessionId: "sess_anchor_exf", childSessionId: CHILD, elapsedMs: 1 },
      { primary: "fail" },
    );
    const kit = buildProviderKit({
      sessionIsolation: "child",
      breeder,
      modelCatalog: () => catalogFor([{ providerId: "bad-prov", modelId: "bad-model" }]),
    });
    try {
      insertSessionEntry(kit.dbPath, {
        sessionId: kit.teamId,
        data: { modelSelection: { providerId: "bad-prov", modelId: "bad-model" } },
      });
      await expect(
        kit.provider.startContinuable({
          teamId: kit.teamId,
          memberId: "m-apply-fail",
          name: "exf",
          description: "d",
          firstPrompt: "做一件事",
          context: "fresh",
        }),
      ).rejects.toThrow(/inherited model/);
      // 成员卡诊断兜底 = 继承失败记录（reason 截断 ≤80，断言关键前缀）
      const [diagnostic] = kit.provider.diagnosticsOf("m-apply-fail");
      expect(diagnostic).toContain("成员模型继承失败：bad-prov/bad-model");
      expect(diagnostic).toContain("成员模型无法继承");
      expect(fs.existsSync(memberPaths(kit.provider.teamDir, "m-apply-fail").modelFailedFile)).toBe(true);
    } finally {
      await kit.cleanup();
    }
  });

  it("legacy 模式不应用继承（无子会话）；origin 不记录模型选择", async () => {
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
      });
      const origin = readOrigin(memberPaths(kit.provider.teamDir, "m-legacy-model"));
      expect(origin?.modelSelection).toBeUndefined();
      expect(origin?.modelSource).toBeUndefined();
    } finally {
      await kit.cleanup();
    }
  });
});

describe("ResumePerTurnProvider · 每轮执行前同步（0.4.0）", () => {
  it("Lead 提交新模型后成员续跑 → 轮前 setModel 同步 + origin 更新（不谎报）", async () => {
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_sync", childSessionId: CHILD, elapsedMs: 1 });
    const kit = buildProviderKit({
      sessionIsolation: "child",
      breeder,
      modelCatalog: () => catalogFor([
        { providerId: "prov-a", modelId: "model-a" },
        { providerId: "prov-b", modelId: "model-b" },
      ]),
    });
    try {
      insertSubmissionMessage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "prov-a",
        modelId: "model-a",
        reasoningLevel: "high",
        timeCreated: 1_700_000_000_000,
      });
      await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-sync",
        name: "sy",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
      });
      expect(breeder.calls[0]?.modelSelection).toEqual({ providerId: "prov-a", modelId: "model-a", reasoningLevel: "high" });
      expect(breeder.applyCalls).toHaveLength(0); // 首轮同值：不重复应用

      // Lead 切模型并提交（新快照更新）
      insertSubmissionMessage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "prov-b",
        modelId: "model-b",
        reasoningLevel: "low",
        timeCreated: 1_700_000_500_000,
      });
      const outcome = await kit.provider.deliver({
        memberId: "m-sync",
        framedMessage: JSON.stringify([{ type: "text", text: "Team message from lead:" }, { type: "text", text: "继续" }]),
        messageId: `team-message-sync-${Date.now()}`,
      });
      expect(outcome).toBe("accepted");
      expect(breeder.applyCalls).toEqual([
        { sessionId: CHILD, selection: { providerId: "prov-b", modelId: "model-b", reasoningLevel: "low" } },
      ]);
      expect(readOrigin(memberPaths(kit.provider.teamDir, "m-sync"))).toMatchObject({
        modelSelection: { providerId: "prov-b", modelId: "model-b", reasoningLevel: "low" },
        modelSource: "inherited",
      });
    } finally {
      await kit.cleanup();
    }
  });

  it("同步失败 → 阻止本轮（launchTurn 抛错；绝不用旧模型悄悄开跑）", async () => {
    const breeder = fakeBreeder(
      { anchorSessionId: "sess_anchor_syncf", childSessionId: CHILD, elapsedMs: 1 },
      { apply: "fail" },
    );
    const kit = buildProviderKit({
      sessionIsolation: "child",
      breeder,
      modelCatalog: () => catalogFor([
        { providerId: "prov-a", modelId: "model-a" },
        { providerId: "prov-b", modelId: "model-b" },
      ]),
    });
    try {
      insertSubmissionMessage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "prov-a",
        modelId: "model-a",
        timeCreated: 1_700_000_000_000,
      });
      await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-sync-fail",
        name: "sf",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
      });
      insertSubmissionMessage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "prov-b",
        modelId: "model-b",
        timeCreated: 1_700_000_500_000,
      });
      await expect(
        kit.provider.deliver({
          memberId: "m-sync-fail",
          framedMessage: JSON.stringify([{ type: "text", text: "Team message from lead:" }, { type: "text", text: "继续" }]),
          messageId: "team-message-syncfail",
        }),
      ).rejects.toThrow(/无法同步 Lead 模型/);
      // 旧选择未生效、新选择被拒 = 失败留痕（成员卡可诊断）
      expect(fs.existsSync(memberPaths(kit.provider.teamDir, "m-sync-fail").modelFailedFile)).toBe(true);
    } finally {
      await kit.cleanup();
    }
  });

  it("Lead 切到官方套餐后续跑 → 阻止本轮并报套餐口径（旧第三方模型不冒充新选择）", async () => {
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_pl", childSessionId: CHILD, elapsedMs: 1 });
    const kit = buildProviderKit({
      sessionIsolation: "child",
      breeder,
      modelCatalog: () => catalogFor([{ providerId: "prov-a", modelId: "model-a" }]),
    });
    try {
      insertSubmissionMessage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "prov-a",
        modelId: "model-a",
        timeCreated: 1_700_000_000_000,
      });
      await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-plan-switch",
        name: "ps",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
      });
      // Lead 提交切到官方套餐
      insertSubmissionMessage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "account:bigmodel-start-plan",
        modelId: "GLM-5.3",
        timeCreated: 1_700_000_500_000,
      });
      await expect(
        kit.provider.deliver({
          memberId: "m-plan-switch",
          framedMessage: JSON.stringify([{ type: "text", text: "Team message from lead:" }, { type: "text", text: "继续" }]),
          messageId: "team-message-planswitch",
        }),
      ).rejects.toThrow(/官方套餐模型/);
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
