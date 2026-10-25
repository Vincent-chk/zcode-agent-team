// mid-life 改模型（stage-8 Round C）：ResumePerTurnProvider.setMemberModel 三态 + pending 兜底。
// 夹具 = fake-zcode 真子进程 + 可编程培育器桩（createChild/applyModelSelection 记录调用）。
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProviderKit, framedText, waitFor, withFakeEnv, type ProviderKit } from "./kit.js";
import { memberPaths, readOrigin } from "../../src/provider/member-files.js";
import type { MemberModelSelection } from "../../src/provider/model-selection.js";
import type { SessionBreederLike } from "../../src/provider/resume-provider.js";

const CHILD = "sess_child_setmodel";

interface ApplyCall {
  sessionId: string;
  workspacePath: string;
  selection: MemberModelSelection;
}

function fakeBreeder(result: { applied: boolean; reason?: string } = { applied: true }): SessionBreederLike & {
  applyCalls: ApplyCall[];
} {
  const applyCalls: ApplyCall[] = [];
  return {
    applyCalls,
    async createChild(input) {
      return {
        anchorSessionId: "sess_anchor_setmodel",
        childSessionId: CHILD,
        elapsedMs: 1,
        workspacePath: input.workspacePath,
        // 首轮 setModel 视为成功（E-1 后 origin 只记实际生效者，缺了它会丢失继承记录）
        ...(input.modelSelection !== undefined ? { appliedModel: input.modelSelection } : {}),
      };
    },
    async applyModelSelection(input) {
      applyCalls.push({
        sessionId: input.sessionId,
        workspacePath: input.workspacePath,
        selection: input.selection,
      });
      return result;
    },
  };
}

let kit: ProviderKit | null = null;
/** 可变的培育器结果（同一 provider 实例内切换成功/失败，验证清除语义）。 */
let breederVerdict: { applied: boolean; reason?: string };
const restoreFns: Array<() => void> = [];
let breeder: ReturnType<typeof fakeBreeder>;

/** 档位元数据夹具：m-base 有 defaultVariant=low；m-default 有 defaultVariant=medium。 */
const TEST_CATALOG = {
  providers: [
    {
      providerId: "p-base",
      name: "Base",
      kind: "k",
      enabled: true,
      models: [
        { id: "m-base", enabled: true, reasoning: { variants: ["low", "high"], defaultVariant: "low" } },
      ],
    },
    {
      providerId: "p-default",
      name: "Default",
      kind: "k",
      enabled: true,
      models: [
        {
          id: "m-default",
          enabled: true,
          reasoning: { variants: ["low", "medium", "max"], defaultVariant: "medium" },
        },
      ],
    },
  ],
};

beforeEach(() => {
  breeder = fakeBreeder();
  kit = buildProviderKit({ sessionIsolation: "child", breeder, modelCatalog: () => TEST_CATALOG });
});

afterEach(async () => {
  for (const restore of restoreFns.splice(0).reverse()) restore();
  await kit?.cleanup();
  kit = null;
});

const SPAWN = {
  memberId: "m-model",
  name: "alpha",
  description: "d",
  firstPrompt: "做一件事",
  context: "fresh" as const,
};

async function spawnMember(
  extra: { modelSelection?: MemberModelSelection; thoughtLevel?: string } = {},
): Promise<void> {
  const result = await kit!.provider.startContinuable({
    teamId: kit!.teamId,
    ...SPAWN,
    ...extra,
  });
  expect(result.accepted).toBe(true);
  await waitFor(() => !kit!.provider.isAlive(SPAWN.memberId), 8_000);
}

/** 换掉培育器桩（先关掉当前 kit，避免临时目录/数据库句柄泄漏）。 */
async function replaceBreeder(result: { applied: boolean; reason?: string }): Promise<void> {
  await kit!.cleanup();
  breeder = fakeBreeder(result);
  kit = buildProviderKit({
    sessionIsolation: "child",
    breeder,
    modelCatalog: () => TEST_CATALOG,
  });
}

describe("setMemberModel · 三态", () => {
  it("会话未落定（无 origin）→ 抛错 member session not settled", async () => {
    await expect(
      kit!.provider.setMemberModel({
        memberId: "m-ghost",
        modelSelection: { providerId: "p", modelId: "m" },
      }),
    ).rejects.toThrow(/member session not settled/);
  });

  it("空闲 → 立即应用（applied:now）；origin 记录 explicit", async () => {
    await spawnMember();
    const selection: MemberModelSelection = { providerId: "p-new", modelId: "m-new", reasoningLevel: "max" };
    await expect(kit!.provider.setMemberModel({ memberId: SPAWN.memberId, modelSelection: selection })).resolves.toEqual({
      applied: "now",
    });
    expect(breeder.applyCalls).toEqual([
      { sessionId: CHILD, workspacePath: kit!.cwd, selection },
    ]);
    const origin = readOrigin(memberPaths(kit!.provider.teamDir, SPAWN.memberId))!;
    expect(origin).toMatchObject({ modelSelection: selection, modelSource: "explicit" });
    expect(fs.existsSync(memberPaths(kit!.provider.teamDir, SPAWN.memberId).modelPendingFile)).toBe(false);
  });

  it("运行中 → 落 pending（applied:next-turn）且不即时应用", async () => {
    restoreFns.push(withFakeEnv({ FAKE_ZCODE_SLEEP_MS: "4000" }));
    const started = await kit!.provider.startContinuable({ teamId: kit!.teamId, ...SPAWN });
    expect(started.accepted).toBe(true);
    const selection: MemberModelSelection = { providerId: "p-run", modelId: "m-run" };
    await expect(kit!.provider.setMemberModel({ memberId: SPAWN.memberId, modelSelection: selection })).resolves.toEqual({
      applied: "next-turn",
    });
    expect(breeder.applyCalls).toEqual([]);
    const pendingFile = memberPaths(kit!.provider.teamDir, SPAWN.memberId).modelPendingFile;
    expect(JSON.parse(fs.readFileSync(pendingFile, "utf8"))).toMatchObject({ modelSelection: selection });
    restoreFns.push(withFakeEnv({ FAKE_ZCODE_SLEEP_MS: undefined }));
    await waitFor(() => !kit!.provider.isAlive(SPAWN.memberId), 8_000);
  });

  it("GitHub #6：空闲即时失败 → applied:failed + reason，不写 pending，落 model-failed", async () => {
    await replaceBreeder({ applied: false, reason: "Reasoning level is required" });
    await spawnMember();
    const selection: MemberModelSelection = { providerId: "p-fail", modelId: "m-fail", reasoningLevel: "max" };
    await expect(
      kit!.provider.setMemberModel({ memberId: SPAWN.memberId, modelSelection: selection }),
    ).resolves.toEqual({ applied: "failed", reason: "Reasoning level is required" });
    const paths = memberPaths(kit!.provider.teamDir, SPAWN.memberId);
    // 不排队：pending 不存在（旧行为的无限重试源头）
    expect(fs.existsSync(paths.modelPendingFile)).toBe(false);
    // 失败记录落盘，成员行诊断立即可见
    expect(JSON.parse(fs.readFileSync(paths.modelFailedFile, "utf8"))).toMatchObject({
      modelSelection: selection,
      reason: "Reasoning level is required",
    });
    expect(kit!.provider.diagnosticsOf(SPAWN.memberId)).toEqual([
      "模型设置未生效：p-fail/m-fail（Reasoning level is required）",
    ]);
    // origin 未改（未生效就不记）
    expect(readOrigin(paths)?.modelSelection).toBeUndefined();
  });

  it("GitHub #6：失败后成功一次即清除 model-failed（不留陈旧告警）", async () => {
    breederVerdict = { applied: false, reason: "rejected once" };
    await replaceBreeder(breederVerdict);
    await spawnMember();
    const selection: MemberModelSelection = { providerId: "p-ok", modelId: "m-ok" };
    await expect(
      kit!.provider.setMemberModel({ memberId: SPAWN.memberId, modelSelection: selection }),
    ).resolves.toMatchObject({ applied: "failed" });
    const paths = memberPaths(kit!.provider.teamDir, SPAWN.memberId);
    expect(fs.existsSync(paths.modelFailedFile)).toBe(true);

    // 第二次尝试成功（同一 provider 实例；培育器结果对象可变 → 直接翻转 verdict）
    breederVerdict.applied = true;
    delete breederVerdict.reason;
    await expect(
      kit!.provider.setMemberModel({ memberId: SPAWN.memberId, modelSelection: selection }),
    ).resolves.toEqual({ applied: "now" });
    expect(fs.existsSync(paths.modelFailedFile)).toBe(false);
    expect(kit!.provider.diagnosticsOf(SPAWN.memberId)).toEqual([]);
  });

  it("GitHub #6：无失败记录 → diagnosticsOf 空；损坏记录 → 空（不阻断 list_agents）", async () => {
    await spawnMember();
    const paths = memberPaths(kit!.provider.teamDir, SPAWN.memberId);
    expect(kit!.provider.diagnosticsOf(SPAWN.memberId)).toEqual([]);
    fs.writeFileSync(paths.modelFailedFile, "{broken");
    expect(kit!.provider.diagnosticsOf(SPAWN.memberId)).toEqual([]);
    fs.writeFileSync(paths.modelFailedFile, JSON.stringify({ modelSelection: { modelId: "only" }, reason: "x" }));
    expect(kit!.provider.diagnosticsOf(SPAWN.memberId)).toEqual([]);
  });

  it("GitHub #6：宿主未给原因 → 落默认原因（诊断仍可读，不留空括号）", async () => {
    breederVerdict = { applied: false };
    await replaceBreeder(breederVerdict);
    await spawnMember();
    await expect(
      kit!.provider.setMemberModel({
        memberId: SPAWN.memberId,
        modelSelection: { providerId: "p-silent", modelId: "m-silent" },
      }),
    ).resolves.toEqual({ applied: "failed", reason: "model was rejected by the host" });
    expect(kit!.provider.diagnosticsOf(SPAWN.memberId)).toEqual([
      "模型设置未生效：p-silent/m-silent（model was rejected by the host）",
    ]);
  });

  it("GitHub #6：失败记录 reason 为空 → 诊断不带空括号", async () => {
    await spawnMember();
    const paths = memberPaths(kit!.provider.teamDir, SPAWN.memberId);
    fs.mkdirSync(path.dirname(paths.modelFailedFile), { recursive: true });
    fs.writeFileSync(
      paths.modelFailedFile,
      JSON.stringify({
        modelSelection: { providerId: "p-empty", modelId: "m-empty" },
        reason: "",
        failedAt: new Date().toISOString(),
      }),
    );
    expect(kit!.provider.diagnosticsOf(SPAWN.memberId)).toEqual(["模型设置未生效：p-empty/m-empty"]);
  });

  it("GitHub #6：reason 精简（首句 + ≤80 字符）", async () => {
    const longReason = `${"x".repeat(120)}. second sentence`;
    await replaceBreeder({ applied: false, reason: longReason });
    await spawnMember();
    await kit!.provider.setMemberModel({
      memberId: SPAWN.memberId,
      modelSelection: { providerId: "p-long", modelId: "m-long" },
    });
    const [diagnostic] = kit!.provider.diagnosticsOf(SPAWN.memberId);
    expect(diagnostic).toBe(`模型设置未生效：p-long/m-long（${"x".repeat(79)}…）`);
    expect(diagnostic.length).toBeLessThan(120);
  });

  it("thoughtLevel-only：以成员现有选择为基底（origin 记录 → 合并强度）", async () => {
    const base: MemberModelSelection = { providerId: "p-base", modelId: "m-base", reasoningLevel: "low" };
    await spawnMember({ modelSelection: base });
    await expect(kit!.provider.setMemberModel({ memberId: SPAWN.memberId, thoughtLevel: "max" })).resolves.toEqual({
      applied: "now",
    });
    expect(breeder.applyCalls[0]?.selection).toEqual({
      providerId: "p-base",
      modelId: "m-base",
      reasoningLevel: "max",
    });
  });

  it("thoughtLevel-only 且成员模型未知 → 抛错（要求显式 model）", async () => {
    await spawnMember();
    await expect(
      kit!.provider.setMemberModel({ memberId: SPAWN.memberId, thoughtLevel: "max" }),
    ).rejects.toThrow(/member model is unknown/);
  });

  it("E-1b：只给 model（无档位）→ 用目录 defaultVariant 补齐后再应用", async () => {
    await spawnMember();
    await expect(
      kit!.provider.setMemberModel({
        memberId: SPAWN.memberId,
        modelSelection: { providerId: "p-default", modelId: "m-default" },
      }),
    ).resolves.toEqual({ applied: "now" });
    expect(breeder.applyCalls[0]?.selection).toEqual({
      providerId: "p-default",
      modelId: "m-default",
      reasoningLevel: "medium",
    });
    expect(readOrigin(memberPaths(kit!.provider.teamDir, SPAWN.memberId))).toMatchObject({
      modelSelection: { providerId: "p-default", modelId: "m-default", reasoningLevel: "medium" },
      modelSource: "explicit",
    });
  });
});

describe("pending 兜底 · 下一轮拉起前应用", () => {
  it("pending 落盘 → 轮次退出后 deliver 时应用、删标记并同步 origin", async () => {
    restoreFns.push(withFakeEnv({ FAKE_ZCODE_SLEEP_MS: "2500" }));
    const started = await kit!.provider.startContinuable({ teamId: kit!.teamId, ...SPAWN });
    expect(started.accepted).toBe(true);
    const selection: MemberModelSelection = { providerId: "p-pending", modelId: "m-pending", reasoningLevel: "high" };
    await expect(kit!.provider.setMemberModel({ memberId: SPAWN.memberId, modelSelection: selection })).resolves.toEqual({
      applied: "next-turn",
    });
    restoreFns.push(withFakeEnv({ FAKE_ZCODE_SLEEP_MS: undefined }));
    await waitFor(() => !kit!.provider.isAlive(SPAWN.memberId), 8_000);

    const msg = framedText("lead", "next-turn-body");
    await expect(
      kit!.provider.deliver({ memberId: SPAWN.memberId, framedMessage: msg.framedJson, messageId: msg.messageId }),
    ).resolves.toBe("accepted");
    // fake breeder 在 launchTurn 顶部收到 pending 应用
    expect(breeder.applyCalls).toEqual([{ sessionId: CHILD, workspacePath: kit!.cwd, selection }]);
    const paths = memberPaths(kit!.provider.teamDir, SPAWN.memberId);
    expect(fs.existsSync(paths.modelPendingFile)).toBe(false);
    expect(readOrigin(paths)).toMatchObject({ modelSelection: selection, modelSource: "explicit" });
    expect(kit!.logs.some((r) => r.kind === "model-pending-applied")).toBe(true);
  });

  it("GitHub #6：pending 前置应用失败 → 终态（删标记 + 落 model-failed），轮次照常拉起", async () => {
    await replaceBreeder({ applied: false, reason: "Provider Registry 中不存在 Model" });
    await spawnMember();
    const paths = memberPaths(kit!.provider.teamDir, SPAWN.memberId);
    const selection: MemberModelSelection = { providerId: "p-retry", modelId: "m-retry" };
    // 直接落 pending（模拟上一轮运行中写入）
    fs.writeFileSync(
      paths.modelPendingFile,
      JSON.stringify({ modelSelection: selection, requestedAt: new Date().toISOString() }),
    );
    const msg = framedText("lead", "retry-body");
    await expect(
      kit!.provider.deliver({ memberId: SPAWN.memberId, framedMessage: msg.framedJson, messageId: msg.messageId }),
    ).resolves.toBe("accepted");
    expect(breeder.applyCalls).toHaveLength(1); // 单次尝试
    // 终态：标记删除（不再每轮重试）+ 失败记录落盘 + 诊断可见
    expect(fs.existsSync(paths.modelPendingFile)).toBe(false);
    expect(fs.existsSync(paths.modelFailedFile)).toBe(true);
    expect(kit!.provider.diagnosticsOf(SPAWN.memberId)).toEqual([
      "模型设置未生效：p-retry/m-retry（Provider Registry 中不存在 Model）",
    ]);
    expect(readOrigin(paths)?.modelSelection).toBeUndefined();
  });

  it("GitHub #6：pending 前置应用成功 → 清 pending + 清 model-failed + 更新 origin", async () => {
    await spawnMember();
    const paths = memberPaths(kit!.provider.teamDir, SPAWN.memberId);
    fs.writeFileSync(paths.modelFailedFile, JSON.stringify({
      modelSelection: { providerId: "p-old", modelId: "m-old" },
      reason: "old failure",
      failedAt: new Date().toISOString(),
    }));
    const selection: MemberModelSelection = { providerId: "p-fine", modelId: "m-fine" };
    fs.writeFileSync(
      paths.modelPendingFile,
      JSON.stringify({ modelSelection: selection, requestedAt: new Date().toISOString() }),
    );
    const msg = framedText("lead", "ok-body");
    await expect(
      kit!.provider.deliver({ memberId: SPAWN.memberId, framedMessage: msg.framedJson, messageId: msg.messageId }),
    ).resolves.toBe("accepted");
    expect(fs.existsSync(paths.modelPendingFile)).toBe(false);
    expect(fs.existsSync(paths.modelFailedFile)).toBe(false);
    expect(kit!.provider.diagnosticsOf(SPAWN.memberId)).toEqual([]);
    expect(readOrigin(paths)).toMatchObject({ modelSelection: selection, modelSource: "explicit" });
  });

  it("损坏的 pending 标记 → 记日志并跳过（不阻塞轮次）", async () => {
    await spawnMember();
    const paths = memberPaths(kit!.provider.teamDir, SPAWN.memberId);
    fs.writeFileSync(paths.modelPendingFile, JSON.stringify({ modelSelection: { modelId: "only-model" } }));
    const msg = framedText("lead", "invalid-pending-body");
    await expect(
      kit!.provider.deliver({ memberId: SPAWN.memberId, framedMessage: msg.framedJson, messageId: msg.messageId }),
    ).resolves.toBe("accepted");
    expect(breeder.applyCalls).toEqual([]);
    expect(kit!.logs.some((r) => r.kind === "model-pending-invalid")).toBe(true);
    expect(fs.existsSync(paths.modelPendingFile)).toBe(true);
  });
});
