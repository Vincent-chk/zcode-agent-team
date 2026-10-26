// 会话隔离接线（stage-6）：child 模式下首轮以 `--resume <隐藏子会话>` 驱动，
// origin 记录隔离字段；培育失败 → 直接抛错（不静默回退为可见会话）。
// 0.4.0 模型继承重写：成员唯一路线 = 跟随 Lead 最新**已确认**选择（三源判定：提交快照 /
// 选模条目 / main_turn 调用取最新）；解析不出 / 官方套餐 / 目录外 / 应用失败 = 抛错，
// 绝不静默回退宿主缺省。显式参数通道、usage 兜底档、分类跳过、pending 全部注销。
// 0.4.1 修复轮：一致性判断以宿主实际状态（session_entry/main_turn usage）优先于 origin；
// 统一失败记录（kind/attempts/nextAttemptAt/leadSignature/messageIds）驱动重试闸——
// 确定性拒绝暂停相同选择自动重试、临时故障退避（注入短序列）、Lead 换模/新消息解锁；
// 验证成功（宿主实际状态一致）即清旧失败记录；createChild 已定模的首轮不重复应用。
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  buildProviderKit,
  insertModelUsage,
  insertSessionEntry,
  insertSubmissionMessage,
} from "./kit.js";
import {
  listTurns,
  memberPaths,
  readModelFailed,
  readOrigin,
} from "../../src/provider/member-files.js";
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

/** 培育器桩：记录 createChild/applyModelSelection 调用；behavior 模拟 setModel 成败。
 *  dbPath 注入时模拟宿主 setModel 落库形态（session_entry UPSERT 单行——0.4.1 一致性
 *  判断以宿主实际状态优先，测试必须能表达「setModel 成功 → 宿主记录更新」）。
 *  applyBehavior 可编程序列（重试矩阵用；缺省沿用 behavior.apply）。 */
function fakeBreeder(
  result:
    | { anchorSessionId: string; childSessionId: string; elapsedMs: number; workspacePath?: string }
    | Error,
  behavior: {
    primary?: "ok" | "fail";
    apply?: "ok" | "fail";
    dbPath?: string;
    applyReason?: string;
  } = {},
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
      if (input.modelSelection !== undefined && behavior.dbPath !== undefined) {
        recordHostSelection(behavior.dbPath, childSessionIdOf(result), input.modelSelection);
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
        return { applied: false, reason: behavior.applyReason ?? "fake apply failure" };
      }
      if (behavior.dbPath !== undefined) {
        recordHostSelection(behavior.dbPath, input.sessionId, input.selection);
      }
      return { applied: true };
    },
  };
}

function childSessionIdOf(
  result: { childSessionId: string } | Error,
): string {
  return result instanceof Error ? "" : result.childSessionId;
}

/** 宿主 setModel 落库形态（UPSERT 单行，canonical id；time_updated 刷新）。 */
function recordHostSelection(
  dbPath: string,
  sessionId: string,
  selection: MemberModelSelection,
): void {
  insertSessionEntry(dbPath, {
    sessionId,
    timeCreated: Date.now(),
    data: {
      modelSelection: {
        providerId: selection.providerId,
        modelId: selection.modelId,
        ...(selection.reasoningLevel !== undefined
          ? { options: { reasoningLevel: selection.reasoningLevel } }
          : {}),
      },
    },
  });
}

describe("ResumePerTurnProvider · sessionIsolation=child", () => {
  it.each(["custom", "official"] as const)(
    "培育期间 Lead 切到 %s 模型，首轮启动前重新核对最新选择",
    async (target) => {
      const behavior = { dbPath: "" };
      const breeder = fakeBreeder(
        { anchorSessionId: "sess_anchor_switch", childSessionId: CHILD, elapsedMs: 1 },
        behavior,
      );
      const kit = buildProviderKit({ sessionIsolation: "child", breeder, modelCatalog: () => SUPPORTED_CATALOG });
      behavior.dbPath = kit.dbPath;
      const createChild = breeder.createChild.bind(breeder);
      breeder.createChild = async (input) => {
        const result = await createChild(input);
        insertSubmissionMessage(kit.dbPath, {
          sessionId: kit.teamId,
          providerId: target === "official" ? "account:plan" : "second-prov",
          modelId: target === "official" ? "official-model" : "second-model",
          reasoningLevel: "high",
          timeCreated: 1_700_000_100_000,
        });
        return result;
      };
      try {
        insertSubmissionMessage(kit.dbPath, {
          sessionId: kit.teamId, providerId: "first-prov", modelId: "first-model",
          reasoningLevel: "low", timeCreated: 1_700_000_000_000,
        });
        const started = kit.provider.startContinuable({
          teamId: kit.teamId, memberId: "m-switch", name: "switch", description: "d",
          firstPrompt: "做一件事", context: "fresh",
        });
        if (target === "official") {
          await expect(started).rejects.toThrow(/官方套餐模型/);
          expect(listTurns(memberPaths(kit.provider.teamDir, "m-switch").runDir)).toEqual([]);
        } else {
          expect((await started).accepted).toBe(true);
          expect(breeder.applyCalls).toEqual([
            { sessionId: CHILD, selection: { providerId: "second-prov", modelId: "second-model", reasoningLevel: "high" } },
          ]);
          expect(readOrigin(memberPaths(kit.provider.teamDir, "m-switch"))?.modelSelection).toEqual({
            providerId: "second-prov", modelId: "second-model", reasoningLevel: "high",
          });
        }
      } finally {
        await kit.cleanup();
      }
    },
  );

  it("一次继承判定使用同一目录快照校验模型并补默认档位", async () => {
    let reads = 0;
    const kit = buildProviderKit({
      sessionIsolation: "child",
      modelCatalog: () => ({ providers: [{
        providerId: "p", name: "p", kind: "k", enabled: true,
        models: [{ id: "m", enabled: true, reasoning: {
          variants: ["low", "high"], defaultVariant: reads++ === 0 ? "low" : "high",
        } }],
      }] }),
    });
    try {
      insertSubmissionMessage(kit.dbPath, {
        sessionId: kit.teamId, providerId: "p", modelId: "m", timeCreated: 1_700_000_000_000,
      });
      expect(kit.provider.leadModelSelectionOf()).toEqual({ providerId: "p", modelId: "m", reasoningLevel: "low" });
    } finally {
      await kit.cleanup();
    }
  });

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
    const behavior = { dbPath: "" };
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_sync", childSessionId: CHILD, elapsedMs: 1 }, behavior);
    const kit = buildProviderKit({
      sessionIsolation: "child",
      breeder,
      modelCatalog: () => catalogFor([
        { providerId: "prov-a", modelId: "model-a" },
        { providerId: "prov-b", modelId: "model-b" },
      ]),
    });
    behavior.dbPath = kit.dbPath;
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
      expect(breeder.applyCalls).toHaveLength(0); // 首轮 createChild 已定模：不重复应用（0.4.1）

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

  it("Lead 未变 + 宿主实际状态一致 → 零同步（不打扰宿主）", async () => {
    const behavior = { dbPath: "" };
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_idem", childSessionId: CHILD, elapsedMs: 1 }, behavior);
    const kit = buildProviderKit({
      sessionIsolation: "child",
      breeder,
      modelCatalog: () => catalogFor([{ providerId: "prov-a", modelId: "model-a" }]),
    });
    behavior.dbPath = kit.dbPath;
    try {
      insertSubmissionMessage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "prov-a",
        modelId: "model-a",
        timeCreated: 1_700_000_000_000,
      });
      await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-idem",
        name: "id",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
      });
      const outcome = await kit.provider.deliver({
        memberId: "m-idem",
        framedMessage: JSON.stringify([{ type: "text", text: "Team message from lead:" }, { type: "text", text: "继续" }]),
        messageId: "team-message-idem",
      });
      expect(outcome).toBe("accepted");
      expect(breeder.applyCalls).toHaveLength(0); // observed(entry)=lead → 零 RPC
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

describe("ResumePerTurnProvider · 0.4.1 一致性判断（宿主实际状态优先）", () => {
  /** 便捷装配：child 隔离 + 目录（prov-a/model-a、prov-b/model-b）+ 提交快照定 Lead 模型。 */
  async function setupSyncKit(opts: {
    apply?: "ok" | "fail";
    applyReason?: string;
    leadModel?: { providerId: string; modelId: string; reasoningLevel?: string };
    backoffMs?: number[];
  } = {}) {
    const behavior: {
      primary?: "ok" | "fail";
      apply?: "ok" | "fail";
      dbPath: string;
      applyReason?: string;
    } = {
      dbPath: "",
      ...(opts.apply !== undefined ? { apply: opts.apply } : {}),
      ...(opts.applyReason !== undefined ? { applyReason: opts.applyReason } : {}),
    };
    const breeder = fakeBreeder(
      { anchorSessionId: "sess_anchor_f1", childSessionId: CHILD, elapsedMs: 1 },
      behavior,
    );
    const kit = buildProviderKit({
      sessionIsolation: "child",
      breeder,
      modelCatalog: () => catalogFor([
        { providerId: "prov-a", modelId: "model-a" },
        { providerId: "prov-b", modelId: "model-b" },
      ]),
      ...(opts.backoffMs !== undefined ? { modelRetryBackoffMs: opts.backoffMs } : {}),
    });
    behavior.dbPath = kit.dbPath;
    const lead = opts.leadModel ?? { providerId: "prov-a", modelId: "model-a" };
    insertSubmissionMessage(kit.dbPath, {
      sessionId: kit.teamId,
      providerId: lead.providerId,
      modelId: lead.modelId,
      ...(lead.reasoningLevel !== undefined ? { reasoningLevel: lead.reasoningLevel } : {}),
      timeCreated: 1_700_000_000_000,
    });
    await kit.provider.startContinuable({
      teamId: kit.teamId,
      memberId: "m-f1",
      name: "f1",
      description: "d",
      firstPrompt: "做一件事",
      context: "fresh",
    });
    return { kit, breeder };
  }

  async function deliverOnce(kit: ReturnType<typeof buildProviderKit>, id: string): Promise<"accepted" | "queued"> {
    return kit.provider.deliver({
      memberId: "m-f1",
      framedMessage: JSON.stringify([
        { type: "text", text: "Team message from lead:" },
        { type: "text", text: `继续 ${id}` },
      ]),
      messageId: id,
    });
  }

  it("origin=A、宿主实际=B、Lead=A → 先同步为 A 再启动（origin 相同不放行）", async () => {
    const { kit, breeder } = await setupSyncKit();
    try {
      // 外部漂移：宿主子会话被改到 model-b（entry 更新），而 origin 仍是 model-a、Lead 也是 model-a。
      insertSessionEntry(kit.dbPath, {
        sessionId: CHILD,
        timeCreated: 1_700_000_900_000,
        data: { modelSelection: { providerId: "prov-b", modelId: "model-b" } },
      });
      const outcome = await deliverOnce(kit, "team-message-drift");
      expect(outcome).toBe("accepted");
      // 0.4.0 旧逻辑（origin 优先）会判「一致」跳过；0.4.1 必须以宿主实际状态为准 → 应用一次
      expect(breeder.applyCalls).toEqual([
        { sessionId: CHILD, selection: { providerId: "prov-a", modelId: "model-a", reasoningLevel: "max" } },
      ]);
    } finally {
      await kit.cleanup();
    }
  });

  it("setModel 成功后、origin 更新前崩溃 → 恢复后按宿主实际状态判断（一致即零 RPC + origin 修复）", async () => {
    const { kit, breeder } = await setupSyncKit();
    try {
      // Lead 切 B 并提交 → 同步成功（breeder 桩写宿主 entry=prov-b）
      insertSubmissionMessage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "prov-b",
        modelId: "model-b",
        timeCreated: 1_700_000_500_000,
      });
      await deliverOnce(kit, "team-message-b1");
      expect(breeder.applyCalls).toHaveLength(1);
      // 模拟崩溃窗口：origin 的 modelSelection 回写丢失（仍是 A）
      const paths = memberPaths(kit.provider.teamDir, "m-f1");
      const origin = readOrigin(paths)!;
      expect(origin.modelSelection).toMatchObject({ modelId: "model-b" });
      const { writeOrigin } = await import("../../src/provider/member-files.js");
      writeOrigin(paths, {
        ...origin,
        modelSelection: { providerId: "prov-a", modelId: "model-a", reasoningLevel: "max" },
      });
      // 恢复后续跑：宿主 entry=B=Lead → 零 RPC；origin 辅助记录被修复为 B
      const outcome = await deliverOnce(kit, "team-message-b2");
      expect(outcome).toBe("accepted");
      expect(breeder.applyCalls).toHaveLength(1); // 未新增
      expect(readOrigin(paths)!.modelSelection).toMatchObject({ modelId: "model-b" });
    } finally {
      await kit.cleanup();
    }
  });

  it("仅思考强度变化 → 同样识别并同步", async () => {
    const { kit, breeder } = await setupSyncKit();
    try {
      // Lead 同 provider/model，但档位从缺省 max 变为 low
      insertSubmissionMessage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "prov-a",
        modelId: "model-a",
        reasoningLevel: "low",
        timeCreated: 1_700_000_500_000,
      });
      const outcome = await deliverOnce(kit, "team-message-level");
      expect(outcome).toBe("accepted");
      expect(breeder.applyCalls).toEqual([
        { sessionId: CHILD, selection: { providerId: "prov-a", modelId: "model-a", reasoningLevel: "low" } },
      ]);
    } finally {
      await kit.cleanup();
    }
  });

  it.each(["missing", "invalid"] as const)(
    "宿主选模条目 %s、历史 usage=A=Lead → 重新应用后再续跑",
    async (entryState) => {
      const { kit, breeder } = await setupSyncKit();
      try {
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(kit.dbPath);
        try {
          if (entryState === "missing") {
            db.prepare("DELETE FROM session_entry WHERE session_id = ?").run(CHILD);
          } else {
            db.prepare("UPDATE session_entry SET data = ? WHERE session_id = ?").run(
              JSON.stringify({ modelSelection: {} }), CHILD,
            );
          }
        } finally {
          db.close();
        }
        insertModelUsage(kit.dbPath, {
          sessionId: CHILD,
          providerId: "prov-a",
          modelId: "model-a",
          variant: "max",
          startedAt: 1_700_000_000_000,
        });

        expect(await deliverOnce(kit, `team-message-${entryState}-entry`)).toBe("accepted");
        expect(breeder.applyCalls).toEqual([
          { sessionId: CHILD, selection: { providerId: "prov-a", modelId: "model-a", reasoningLevel: "max" } },
        ]);
        const { TranscriptReader } = await import("../../src/provider/transcript.js");
        const reader = new TranscriptReader({ dbPath: kit.dbPath });
        try {
          expect(reader.latestModelSelection(CHILD)).toEqual({
            providerId: "prov-a", modelId: "model-a", reasoningLevel: "max",
          });
        } finally {
          reader.close();
        }
      } finally {
        await kit.cleanup();
      }
    },
  );

  it("宿主实际状态无法确认（entry/usage 皆无）且 origin=A=Lead → 重新应用（不凭 origin 放行）", async () => {
    const { kit, breeder } = await setupSyncKit();
    try {
      // 抹掉宿主子会话的模型痕迹（模拟恢复后记录缺失）：换 child 会话为新 id 不可行
      // （origin.sessionId 固定），改为删掉 entry 行。
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(kit.dbPath);
      db.prepare("DELETE FROM session_entry WHERE session_id = ?").run(CHILD);
      db.close();
      const outcome = await deliverOnce(kit, "team-message-unconfirmed");
      expect(outcome).toBe("accepted");
      expect(breeder.applyCalls).toEqual([
        { sessionId: CHILD, selection: { providerId: "prov-a", modelId: "model-a", reasoningLevel: "max" } },
      ]);
    } finally {
      await kit.cleanup();
    }
  });
});

describe("ResumePerTurnProvider · 0.4.1 失败可见性与重试控制", () => {
  /** 装配：Lead=A 建员成功后 Lead 切到 B（可选套餐 C）。 */
  async function setupFailKit(opts: { applyReason?: string; backoffMs?: number[] } = {}) {
    const behavior: { apply: "ok" | "fail"; dbPath: string; applyReason?: string } = {
      apply: "fail",
      dbPath: "",
      ...(opts.applyReason !== undefined ? { applyReason: opts.applyReason } : {}),
    };
    const breeder = fakeBreeder(
      { anchorSessionId: "sess_anchor_f2", childSessionId: CHILD, elapsedMs: 1 },
      behavior,
    );
    const kit = buildProviderKit({
      sessionIsolation: "child",
      breeder,
      modelCatalog: () => catalogFor([
        { providerId: "prov-a", modelId: "model-a" },
        { providerId: "prov-b", modelId: "model-b" },
      ]),
      modelRetryBackoffMs: opts.backoffMs ?? [60, 120, 240],
    });
    behavior.dbPath = kit.dbPath;
    insertSubmissionMessage(kit.dbPath, {
      sessionId: kit.teamId,
      providerId: "prov-a",
      modelId: "model-a",
      timeCreated: 1_700_000_000_000,
    });
    await kit.provider.startContinuable({
      teamId: kit.teamId,
      memberId: "m-f2",
      name: "f2",
      description: "d",
      firstPrompt: "做一件事",
      context: "fresh",
    });
    const deliver = async (id: string) =>
      kit.provider.deliver({
        memberId: "m-f2",
        framedMessage: JSON.stringify([
          { type: "text", text: "Team message from lead:" },
          { type: "text", text: `继续 ${id}` },
        ]),
        messageId: id,
      });
    const switchLeadToB = () =>
      insertSubmissionMessage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "prov-b",
        modelId: "model-b",
        timeCreated: 1_700_000_500_000,
      });
    return { kit, breeder, behavior, deliver, switchLeadToB };
  }

  it("同步失败（首次）→ deliver 抛错透出 + 失败记录含 kind/attempts/leadSignature/messageIds", async () => {
    const { kit, deliver, switchLeadToB } = await setupFailKit({
      applyReason: "Provider Registry 中不存在 Model: prov-b/model-b",
    });
    try {
      switchLeadToB();
      await expect(deliver("team-message-fail-1")).rejects.toThrow(/无法同步 Lead 模型/);
      const record = readModelFailed(memberPaths(kit.provider.teamDir, "m-f2"))!;
      expect(record.kind).toBe("deterministic"); // 宿主明确拒绝 = 确定性
      expect(record.attempts).toBe(1);
      expect(record.leadSignature).toBe("prov-b$model-b$max");
      expect(record.messageIds).toEqual(["team-message-fail-1"]);
      expect(record.nextAttemptAt).toBeUndefined();
      const [diagnostic] = kit.provider.diagnosticsOf("m-f2");
      expect(diagnostic).toContain("成员模型继承失败：prov-b/model-b");
    } finally {
      await kit.cleanup();
    }
  });

  it("确定性拒绝后 → 同消息 6 秒内仅 1 次 setModel（闸拦截 = queued，不再重复应用）", async () => {
    const { kit, breeder, deliver, switchLeadToB } = await setupFailKit({
      applyReason: "model prov-b/model-b is not available",
    });
    try {
      switchLeadToB();
      await expect(deliver("team-message-det")).rejects.toThrow(/无法同步/);
      expect(breeder.applyCalls).toHaveLength(1);
      // 后台 sweep 的重复投递（同消息）：闸拦截 → queued，且零新增 setModel
      for (let i = 0; i < 3; i += 1) {
        const outcome = await deliver("team-message-det");
        expect(outcome).toBe("queued");
      }
      expect(breeder.applyCalls).toHaveLength(1); // 6 秒内只尝试一次（原缺陷 = 4 次）
      const suppressed = kit.logs.filter((l) => l.kind === "model-sync-suppressed");
      expect(suppressed).toEqual([]);
      expect(kit.logs.filter((l) => l.kind === "model-sync-failed")).toHaveLength(1);
    } finally {
      await kit.cleanup();
    }
  });

  it("RPC 期间已排队的消息纳入同次失败，后续同批重投不解锁", async () => {
    const { kit, breeder, deliver, switchLeadToB } = await setupFailKit({
      applyReason: "model prov-b/model-b is not available",
    });
    const pending = [{
      messageId: "team-message-batch-first",
      framedJson: JSON.stringify([{ type: "text", text: "Team message from lead:" }, { type: "text", text: "先到消息" }]),
    }];
    kit.provider.bind({ onBoundary: () => undefined, pendingLookup: () => pending });
    let markApplyStarted!: () => void;
    let releaseApply!: () => void;
    const applyStarted = new Promise<void>((resolve) => { markApplyStarted = resolve; });
    const applyReleased = new Promise<void>((resolve) => { releaseApply = resolve; });
    const originalApply = breeder.applyModelSelection.bind(breeder);
    breeder.applyModelSelection = async (input) => {
      const result = await originalApply(input);
      markApplyStarted();
      await applyReleased;
      return result;
    };
    try {
      switchLeadToB();
      const failed = expect(deliver("team-message-batch-first")).rejects.toThrow(/无法同步/);
      await applyStarted;
      pending.push({
        messageId: "team-message-batch-during-rpc",
        framedJson: JSON.stringify([{ type: "text", text: "Team message from lead:" }, { type: "text", text: "RPC 等待中到达" }]),
      });
      releaseApply();
      await failed;

      expect(readModelFailed(memberPaths(kit.provider.teamDir, "m-f2"))!.messageIds).toEqual([
        "team-message-batch-first",
        "team-message-batch-during-rpc",
      ]);
      expect(await deliver("team-message-batch-first")).toBe("queued");
      expect(breeder.applyCalls).toHaveLength(1);
    } finally {
      releaseApply();
      await kit.cleanup();
    }
  });

  it("临时故障 → 按退避重试（到期放行、未到期拦截），耗尽后停止自动尝试", async () => {
    const { kit, breeder, behavior, deliver, switchLeadToB } = await setupFailKit({
      applyReason: "app-server rpc timeout: session/setModel",
      backoffMs: [80, 120],
    });
    try {
      switchLeadToB();
      // 第 1 次尝试失败 → transient，nextAttemptAt = +80ms
      await expect(deliver("team-message-t1")).rejects.toThrow(/无法同步/);
      const r1 = readModelFailed(memberPaths(kit.provider.teamDir, "m-f2"))!;
      expect(r1.kind).toBe("transient");
      expect(r1.attempts).toBe(1);
      expect(r1.nextAttemptAt).toBeGreaterThan(Date.now() - 5_000);
      // 未到期 → 拦截（queued，零新增尝试）
      expect(await deliver("team-message-t1")).toBe("queued");
      expect(breeder.applyCalls).toHaveLength(1);
      // 到期后 → 放行第 2 次尝试（仍失败 → attempts=2；实际尝试失败仍抛错透出）
      await new Promise((r) => setTimeout(r, 100));
      await expect(deliver("team-message-t1")).rejects.toThrow(/无法同步/);
      expect(breeder.applyCalls).toHaveLength(2);
      expect(readModelFailed(memberPaths(kit.provider.teamDir, "m-f2"))!.attempts).toBe(2);
      // 再到期 → 第 3 次尝试（attempts=3；退避序列 [80,120] 耗尽 → 无 nextAttemptAt）
      await new Promise((r) => setTimeout(r, 150));
      await expect(deliver("team-message-t1")).rejects.toThrow(/无法同步/);
      expect(breeder.applyCalls).toHaveLength(3);
      expect(readModelFailed(memberPaths(kit.provider.teamDir, "m-f2"))!.attempts).toBe(3);
      // 耗尽：等待远超全部退避后仍拦截（停止自动尝试）
      await new Promise((r) => setTimeout(r, 300));
      expect(await deliver("team-message-t1")).toBe("queued");
      expect(breeder.applyCalls).toHaveLength(3);
      void behavior;
    } finally {
      await kit.cleanup();
    }
  });

  it("Lead 换回可用模型（换选择）→ 闸解锁，原有消息继续交付且不重复执行", async () => {
    const { kit, breeder, behavior, deliver, switchLeadToB } = await setupFailKit({
      applyReason: "not available",
    });
    try {
      switchLeadToB();
      await expect(deliver("team-message-back")).rejects.toThrow(/无法同步/);
      // 修复应用通道 + Lead 换回 A（新提交快照更新，指纹变化 = 解锁）
      behavior.apply = "ok";
      behavior.applyReason = undefined;
      insertSubmissionMessage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "prov-a",
        modelId: "model-a",
        timeCreated: 1_700_000_900_000,
      });
      const outcome = await deliver("team-message-back");
      expect(outcome).toBe("accepted"); // 原消息交付成功
      // 恢复后失败记录已清（验证成功），成员诊断为空
      expect(readModelFailed(memberPaths(kit.provider.teamDir, "m-f2"))).toBeUndefined();
      expect(kit.provider.diagnosticsOf("m-f2")).toEqual([]);
      // 不重复执行：再投同消息 → containsMessage 去重（accepted，无新轮次）
      const turnsBefore = listTurns(memberPaths(kit.provider.teamDir, "m-f2").runDir).length;
      const again = await deliver("team-message-back");
      expect(again).toBe("accepted");
      expect(listTurns(memberPaths(kit.provider.teamDir, "m-f2").runDir)).toHaveLength(turnsBefore);
      void breeder;
    } finally {
      await kit.cleanup();
    }
  });

  it("用户再次明确发送新消息 → 确定性闸也解锁（显式意图）", async () => {
    const { kit, breeder, behavior, deliver, switchLeadToB } = await setupFailKit({
      applyReason: "rejected",
    });
    try {
      switchLeadToB();
      await expect(deliver("team-message-m1")).rejects.toThrow(/无法同步/);
      expect(breeder.applyCalls).toHaveLength(1);
      // 同消息 → 拦截
      expect(await deliver("team-message-m1")).toBe("queued");
      expect(breeder.applyCalls).toHaveLength(1);
      // 新消息（用户再次明确发送）→ 放行尝试（应用仍失败 → 抛错透出，但确实试了）
      await expect(deliver("team-message-m2")).rejects.toThrow(/无法同步/);
      expect(breeder.applyCalls).toHaveLength(2);
      const record = readModelFailed(memberPaths(kit.provider.teamDir, "m-f2"))!;
      expect(record.messageIds).toEqual(["team-message-m1", "team-message-m2"]);
      void behavior;
    } finally {
      await kit.cleanup();
    }
  });

  it("Lead 切官方套餐 → 本轮结束后成员有明确失败原因，待处理消息仍在（不丢不误标）", async () => {
    const { kit, deliver } = await setupFailKit();
    try {
      // Lead 提交切到官方套餐（不可继承）
      insertSubmissionMessage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "account:bigmodel-start-plan",
        modelId: "GLM-5.3",
        timeCreated: 1_700_000_500_000,
      });
      await expect(deliver("team-message-plan")).rejects.toThrow(/官方套餐模型/);
      const record = readModelFailed(memberPaths(kit.provider.teamDir, "m-f2"))!;
      expect(record.kind).toBe("deterministic");
      expect(record.reason).toContain("官方套餐模型");
      expect(record.modelSelection).toMatchObject({ providerId: "account:bigmodel-start-plan" });
      // 消息未 delivered：turn 记录不含该消息的 landed（本轮根本没启动）
      const turns = listTurns(memberPaths(kit.provider.teamDir, "m-f2").runDir);
      expect(turns.some((t) => t.messageIds.includes("team-message-plan"))).toBe(false);
      // 后台重复投递同消息 → 闸拦截（不再反复抛套餐错误给 mailbox）
      expect(await deliver("team-message-plan")).toBe("queued");
    } finally {
      await kit.cleanup();
    }
  });
});

describe("ResumePerTurnProvider · 0.4.1 旧失败提示清除（验证成功为前提）", () => {
  it("同步 B 失败 → Lead 切回 A（宿主实际=A 已一致）→ 续跑成功且旧失败记录/诊断消失，零额外 setModel", async () => {
    const behavior: { apply?: "ok" | "fail"; dbPath: string; applyReason?: string } = {
      dbPath: "",
      apply: "fail",
      applyReason: "registry rejected prov-b/model-b",
    };
    const breeder = fakeBreeder(
      { anchorSessionId: "sess_anchor_f4", childSessionId: CHILD, elapsedMs: 1 },
      behavior,
    );
    const kit = buildProviderKit({
      sessionIsolation: "child",
      breeder,
      modelCatalog: () => catalogFor([
        { providerId: "prov-a", modelId: "model-a" },
        { providerId: "prov-b", modelId: "model-b" },
      ]),
    });
    behavior.dbPath = kit.dbPath;
    try {
      insertSubmissionMessage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "prov-a",
        modelId: "model-a",
        timeCreated: 1_700_000_000_000,
      });
      await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-f4",
        name: "f4",
        description: "d",
        firstPrompt: "做一件事",
        context: "fresh",
      });
      // Lead 切 B（应用失败）→ 失败记录在场
      insertSubmissionMessage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "prov-b",
        modelId: "model-b",
        timeCreated: 1_700_000_500_000,
      });
      const fail1 = await kit.provider
        .deliver({
          memberId: "m-f4",
          framedMessage: JSON.stringify([{ type: "text", text: "Team message from lead:" }, { type: "text", text: "x1" }]),
          messageId: "team-message-f4-1",
        })
        .catch((e: unknown) => (e as Error).message);
      expect(fail1).toContain("无法同步");
      expect(fs.existsSync(memberPaths(kit.provider.teamDir, "m-f4").modelFailedFile)).toBe(true);
      // Lead 切回 A（提交快照更新；成员宿主实际状态本来就是 A=一致）
      insertSubmissionMessage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "prov-a",
        modelId: "model-a",
        timeCreated: 1_700_000_900_000,
      });
      const applyCallsBefore = breeder.applyCalls.length;
      const outcome = await kit.provider.deliver({
        memberId: "m-f4",
        framedMessage: JSON.stringify([{ type: "text", text: "Team message from lead:" }, { type: "text", text: "x2" }]),
        messageId: "team-message-f4-2",
      });
      expect(outcome).toBe("accepted"); // 续跑成功
      expect(breeder.applyCalls).toHaveLength(applyCallsBefore); // 不需要为清除提示额外 setModel
      // 旧失败文件与诊断消失
      expect(fs.existsSync(memberPaths(kit.provider.teamDir, "m-f4").modelFailedFile)).toBe(false);
      expect(kit.provider.diagnosticsOf("m-f4")).toEqual([]);
    } finally {
      await kit.cleanup();
    }
  });

  it("未恢复成功（仍不一致且被闸拦截）→ 错误提示继续保留", async () => {
    const behavior = { dbPath: "", apply: "fail" as const, applyReason: "hard reject" };
    const breeder = fakeBreeder(
      { anchorSessionId: "sess_anchor_f4b", childSessionId: CHILD, elapsedMs: 1 },
      behavior,
    );
    const kit = buildProviderKit({
      sessionIsolation: "child",
      breeder,
      modelCatalog: () => catalogFor([
        { providerId: "prov-a", modelId: "model-a" },
        { providerId: "prov-b", modelId: "model-b" },
      ]),
    });
    behavior.dbPath = kit.dbPath;
    try {
      insertSubmissionMessage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "prov-a",
        modelId: "model-a",
        timeCreated: 1_700_000_000_000,
      });
      await kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-f4b",
        name: "fb",
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
      await kit.provider
        .deliver({
          memberId: "m-f4b",
          framedMessage: JSON.stringify([{ type: "text", text: "Team message from lead:" }, { type: "text", text: "y" }]),
          messageId: "team-message-f4b",
        })
        .catch(() => undefined);
      // 同消息重复投递（闸拦截，未恢复成功）→ 失败记录仍在，诊断仍可见
      const outcome = await kit.provider.deliver({
        memberId: "m-f4b",
        framedMessage: JSON.stringify([{ type: "text", text: "Team message from lead:" }, { type: "text", text: "y" }]),
        messageId: "team-message-f4b",
      });
      expect(outcome).toBe("queued");
      expect(fs.existsSync(memberPaths(kit.provider.teamDir, "m-f4b").modelFailedFile)).toBe(true);
      expect(kit.provider.diagnosticsOf("m-f4b")).toHaveLength(1);
    } finally {
      await kit.cleanup();
    }
  });
});

describe("host 装配 · 0.4.1 后台补投失败与定时扫描抑制（全路径）", () => {
  it("运行中排队 → 轮次结束后台补投失败（原因可见、消息保留）→ 扫描抑制（不重复应用）→ Lead 换回后恢复交付且旧错误消失", async () => {
    const { openHost, waitFor, withFakeEnv } = await import("./kit.js");
    const restore = withFakeEnv({ FAKE_ZCODE_SLEEP_MS: "700" });
    const behavior: { apply: "ok" | "fail"; dbPath: string; applyReason?: string } = {
      apply: "fail",
      dbPath: "",
      applyReason: "Provider Registry 中不存在 Model: prov-b/model-b",
    };
    const breeder = fakeBreeder(
      { anchorSessionId: "sess_anchor_host", childSessionId: CHILD, elapsedMs: 1 },
      behavior,
    );
    const kit = buildProviderKit({
      sessionIsolation: "child",
      breeder,
      modelCatalog: () => catalogFor([
        { providerId: "prov-a", modelId: "model-a" },
        { providerId: "prov-b", modelId: "model-b" },
      ]),
      modelRetryBackoffMs: [100, 200],
    });
    behavior.dbPath = kit.dbPath;
    let host: Awaited<ReturnType<typeof openHost>> | null = null;
    try {
      insertSubmissionMessage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "prov-a",
        modelId: "model-a",
        timeCreated: 1_700_000_000_000,
      });
      host = await openHost(kit);
      // 预检通过（Lead=A 可继承）→ 成员登记 + 首轮运行中（fake-zcode 睡 700ms）
      const spawned = (await host.dispatch("member.spawn", {
        session_id: kit.teamId,
        name: "alpha",
        description: "d",
        prompt: "写一个 sort 函数",
      })) as { member: { target: string } };
      expect(spawned.member.target).toBe("alpha");
      const memberId = fs.readdirSync(path.join(kit.provider.teamDir, "members"))[0]!;

      // 运行中：Lead 切到不可继承组合并提交 → 消息排队（本轮不打断）
      insertSubmissionMessage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "prov-b",
        modelId: "model-b",
        timeCreated: 1_700_000_500_000,
      });
      const sent = (await host.dispatch("message.send", {
        session_id: kit.teamId,
        targetName: "alpha",
        content: [{ type: "text", text: "amber-host-01" }],
      })) as { messageId: string; status: string };
      expect(sent.status).toBe("pending"); // 运行中一律 queued → pending（内部适配层口径）

      // 轮次结束 → 边界 recoverFor 后台补投 → 同步失败：明确原因落失败记录 + 成员行诊断可见
      await waitFor(
        () => fs.existsSync(memberPaths(kit.provider.teamDir, memberId).modelFailedFile),
        10_000,
        100,
      );
      const record = readModelFailed(memberPaths(kit.provider.teamDir, memberId))!;
      expect(record.kind).toBe("deterministic");
      expect(record.reason).toContain("不存在 Model");
      expect(record.messageIds).toEqual([sent.messageId]);
      const rows0 = host.teamRuntime!.roster.listMembers(kit.teamId).members;
      const alphaRow0 = rows0.find((r) => r.target === "alpha")!;
      expect(alphaRow0.diagnostics.join("|")).toContain("成员模型继承失败：prov-b/model-b");
      // 消息保留、不误标 delivered
      let board = await host.readBoard();
      expect(board.state.delivered).toHaveLength(0);
      expect(board.state.messages.some((m) => m.id === sent.messageId)).toBe(true);

      // 定时扫描（2s 周期）×2：闸抑制——零新增 setModel 应用（原缺陷 = 每次扫描都打一次）
      const applyAfterFirst = breeder.applyCalls.length;
      expect(applyAfterFirst).toBe(1);
      await new Promise((r) => setTimeout(r, 2_600));
      await new Promise((r) => setTimeout(r, 2_200));
      expect(breeder.applyCalls).toHaveLength(applyAfterFirst);
      expect(kit.logs.filter((l) => l.kind === "model-sync-suppressed")).toEqual([]);

      // Lead 换回可用模型（A；成员宿主实际状态本来就是 A）→ 下一次扫描恢复交付：
      // 验证一致 = 零额外 setModel、失败记录/诊断清除、消息 delivered、恰一次执行
      behavior.apply = "ok";
      behavior.applyReason = undefined;
      insertSubmissionMessage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "prov-a",
        modelId: "model-a",
        timeCreated: 1_700_000_900_000,
      });
      await waitFor(
        async () => (await host!.readBoard()).state.delivered.length === 1,
        15_000,
        200,
      );
      board = await host.readBoard();
      expect(board.state.delivered[0]).toBe(sent.messageId);
      expect(breeder.applyCalls).toHaveLength(applyAfterFirst); // 换回后无需 setModel（宿主实际状态一致）
      expect(fs.existsSync(memberPaths(kit.provider.teamDir, memberId).modelFailedFile)).toBe(false);
      const rows1 = host.teamRuntime!.roster.listMembers(kit.teamId).members;
      expect(rows1.find((r) => r.target === "alpha")!.diagnostics).toEqual([]);
      // 恰一次：消息文本只落目标会话一次
      const turns = listTurns(memberPaths(kit.provider.teamDir, memberId).runDir);
      const deliverTurns = turns.filter((t) => t.messageIds.includes(sent.messageId));
      expect(deliverTurns).toHaveLength(1);
      expect(deliverTurns[0]!.landed).toBe(true);
    } finally {
      await host?.close().catch(() => undefined);
      restore();
      await kit.cleanup();
    }
  });
});

describe("ResumePerTurnProvider · preflightMemberModel（0.4.1 登记前预检）", () => {
  it("child 模式：套餐 Lead → 抛错（零 createChild）；可继承 → 通过；legacy → 恒通过", async () => {
    const breeder = fakeBreeder({ anchorSessionId: "sess_anchor_pf", childSessionId: CHILD, elapsedMs: 1 });
    const kit = buildProviderKit({
      sessionIsolation: "child",
      breeder,
      modelCatalog: () => catalogFor([{ providerId: "prov-a", modelId: "model-a" }]),
    });
    try {
      // 三源全空 → 抛（无法确定）
      expect(() => kit.provider.preflightMemberModel()).toThrow(/无法确定 Lead 当前模型/);
      // 套餐 → 抛（可操作口径）
      insertSessionEntry(kit.dbPath, {
        sessionId: kit.teamId,
        data: { modelSelection: { providerId: "account:plan", modelId: "GLM-5.3" } },
      });
      expect(() => kit.provider.preflightMemberModel()).toThrow(/官方套餐模型/);
      expect(breeder.calls).toHaveLength(0); // 预检绝不建隐藏子会话
      // 可继承 → 通过（返回 undefined，不抛）
      insertSubmissionMessage(kit.dbPath, {
        sessionId: kit.teamId,
        providerId: "prov-a",
        modelId: "model-a",
        timeCreated: Date.now() + 10_000,
      });
      expect(kit.provider.preflightMemberModel()).toBeUndefined();
    } finally {
      await kit.cleanup();
    }
    // legacy 隔离：无继承语义 → 恒通过（即使套餐 Lead）
    const legacy = buildProviderKit({ sessionIsolation: "legacy" });
    try {
      insertSessionEntry(legacy.dbPath, {
        sessionId: legacy.teamId,
        data: { modelSelection: { providerId: "account:plan", modelId: "GLM-5.3" } },
      });
      expect(legacy.provider.preflightMemberModel()).toBeUndefined();
    } finally {
      await legacy.cleanup();
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
