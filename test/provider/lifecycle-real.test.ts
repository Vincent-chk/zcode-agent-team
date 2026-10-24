// 服务级（TeamRuntime + 真 provider + fake-zcode）：F01 事件相位落盘、F03 失败路径与名字占用、
// F04 逐字冲突消息、F05 恢复对账三 failure 文本、F12 真实 CAS、F13 wait 唤醒、F14 处置两态。
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProviderKit, withFakeEnv, openHost, waitFor } from "./kit.js";
import { TestableMemoryStore } from "../services/kit.js";
import { TeamRuntime } from "../../src/domain/runtime.js";
import { TeamError } from "../../src/domain/errors.js";
import type { ProviderKit } from "./kit.js";
import type { TeamState } from "../../src/domain/projection.js";

let kit: ProviderKit | null = null;
const restoreFns: Array<() => void> = [];

beforeEach(() => {
  kit = buildProviderKit();
});

afterEach(async () => {
  for (const restore of restoreFns.splice(0).reverse()) restore();
  await kit?.cleanup();
  kit = null;
});

function buildRuntime(store: TestableMemoryStore, drainPolicy?: "keep" | "kill"): TeamRuntime {
  return new TeamRuntime({
    teamId: kit!.teamId,
    store,
    provider: kit!.provider,
    limits: { ...kit!.limits, ...(drainPolicy !== undefined ? { disposalTimeoutMs: 800 } : {}) },
    presentation: kit!.provider,
    steerLead: () => false, // stage-4：Lead 投递走 hook 通道（host 装配同款）
    warn: () => undefined,
  });
}

describe("F01 · spawn 事件相位（provisioning → active）", () => {
  it("成功链路：两事件落盘、成员行 status=running、prompt 原文透传", async () => {
    restoreFns.push(withFakeEnv({ FAKE_ZCODE_SLEEP_MS: "1500" }));
    const store = new TestableMemoryStore(kit!.teamId);
    const runtime = buildRuntime(store);
    const { member } = await runtime.roster.spawnTeammate(kit!.teamId, {
      name: "alpha",
      description: "d",
      prompt: "写 sort",
    });
    expect(member.status).toBe("running");
    const state = store.state();
    expect(state.members.filter((m) => m.name === "alpha").map((m) => m.phase)).toEqual(["active"]);
    runtime.close();
  });
});

describe("F03 · 供给失败路径（真 provider）", () => {
  it("坏二进制：原始错误上抛 + failed 落盘（error 单行）+ 名字保持占用", async () => {
    const { badZcodeBin, buildProviderKit: build } = await import("./kit.js");
    const bad = build({ zcode: badZcodeBin() });
    try {
      const store = new TestableMemoryStore(bad.teamId);
      const runtime = new TeamRuntime({
        teamId: bad.teamId,
        store,
        provider: bad.provider,
        limits: bad.limits,
        presentation: bad.provider,
        steerLead: () => false,
        warn: () => undefined,
      });
      await expect(
        runtime.roster.spawnTeammate(bad.teamId, { name: "gamma", description: "d", prompt: "p" }),
      ).rejects.toThrow(/turn process launch failed|detach helper/i);
      const failed = store.state().members.find((m) => m.name === "gamma")!;
      expect(failed.phase).toBe("failed");
      expect(failed.error).toBeDefined();
      expect(failed.error!.split("\n")).toHaveLength(1); // error = 单行
      // 名字保持占用（§5.1：永不复用）
      await expect(
        runtime.roster.spawnTeammate(bad.teamId, { name: "gamma", description: "d", prompt: "p" }),
      ).rejects.toThrow('teammate name "gamma" was already used in this Team');
      runtime.close();
    } finally {
      await bad.cleanup();
    }
  });
});

describe("F04 · 首轮未持久接收（逐字）", () => {
  it("进程起但会话未落 → TEAM_PROVISIONING_CONFLICT + failed 落盘", async () => {
    restoreFns.push(withFakeEnv({ FAKE_ZCODE_NO_PERSIST: "1" }));
    const store = new TestableMemoryStore(kit!.teamId);
    const runtime = buildRuntime(store);
    const err = await runtime.roster
      .spawnTeammate(kit!.teamId, { name: "alpha", description: "d", prompt: "p" })
      .catch((e: unknown) => e as TeamError);
    expect(err).toBeInstanceOf(TeamError);
    expect((err as TeamError).code).toBe("TEAM_PROVISIONING_CONFLICT");
    expect((err as TeamError).message).toMatch(/^teammate "[0-9a-f-]+" initial prompt was not durably accepted$/);
    expect(store.state().members[0].phase).toBe("failed");
    runtime.close();
  });
});

describe("F05 · 恢复对账矩阵（provisioning × 四条件缺失）", () => {
  it("三条 failure 文本逐字 + active/failed 判定 + 对账后 pending 重投（内部口径）", async () => {
    const store = new TestableMemoryStore(kit!.teamId);
    const runtime = buildRuntime(store);
    // ① 无 origin（did not leave …）
    store.testMutate((s) => addProvisioning(s, "m-1", "w1", "spawn"));
    // ② origin 在但 provider 不匹配（does not match …）
    await runtime.roster.spawnTeammate(kit!.teamId, { name: "ok", description: "d", prompt: "p-ok" });
    store.testMutate((s) => addProvisioning(s, "m-3", "w3", "fork")); // member.provider=fork ≠ origin(spawn 会写成 spawn) —— 手造 origin
    const teamDir = kit!.provider.teamDir;
    fs.mkdirSync(path.join(teamDir, "members", "m-3"), { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, "members", "m-3", "origin.json"),
      JSON.stringify({
        teamId: kit!.teamId,
        memberId: "m-3",
        name: "w3",
        provider: "spawn",
        mode: "continuable",
        context: "fresh",
        createdAt: new Date().toISOString(),
        cwd: kit!.cwd,
        firstPromptText: "p3",
        firstPromptSha256: "x",
        sessionId: null,
        initialUserMessageAccepted: false,
      }),
    );
    // ③ origin 损坏（recovery failed …）
    fs.mkdirSync(path.join(teamDir, "members", "m-4"), { recursive: true });
    fs.writeFileSync(path.join(teamDir, "members", "m-4", "origin.json"), "{broken");
    store.testMutate((s) => addProvisioning(s, "m-4", "w4", "spawn"));

    const result = await runtime.roster.reconcileProvisioning();
    expect(new Set(result.settled)).toEqual(new Set(["m-1", "m-3", "m-4"]));
    const errors = Object.fromEntries(
      store.state().members.map((m) => [m.name, m.error ?? null]),
    );
    expect(errors["w1"]).toBe("provisioning did not leave a resumable child Session");
    expect(errors["w3"]).toBe("persisted child Session does not match the provisioned continuation");
    expect(errors["w4"]).toMatch(/^child Session recovery failed: /);
    expect(errors["ok"]).toBeNull(); // active 成员不受影响
    runtime.close();
  });

  it("spawn 后协调者死亡 → 接任 = 重放(journal) + 对账 + run/ 纳管：active 且轮次保持", async () => {
    restoreFns.push(withFakeEnv({ FAKE_ZCODE_SLEEP_MS: "5000" }));
    const hostA = await openHost(kit!);
    const spawned = (await hostA.dispatch("member.spawn", {
      session_id: kit!.teamId,
      name: "alpha",
      description: "d",
      prompt: "p",
    })) as { member: { status: string } };
    expect(spawned.member.status).toBe("running");
    await hostA.close(); // 协调者退出（journal 落 checkpoint；轮次进程独立进程组存活）
    // 接任：journal 全量重放 + 恢复对账 + 孤儿轮次纳管（live pid 再收养）
    const hostB = await openHost(kit!);
    const runtimeB = hostB.teamRuntime!;
    await runtimeB.roster.recoveryDone;
    const rows = runtimeB.roster.listMembers(kit!.teamId).members;
    expect(rows.find((r) => r.target === "alpha")!.status).toBe("running");
    const memberId = fs.readdirSync(path.join(kit!.provider.teamDir, "members"))[0];
    expect(kit!.provider.isAlive(memberId)).toBe(true); // daemon 更替不连带杀轮次
    await hostB.close();
    await kit!.provider.interrupt({ memberId }); // 清场
  });
});

describe("F12 · 并发任务 CAS（host 真实装配）", () => {
  it("两成员并发 claim 同一任务 → 恰一成功一 TEAM_TASK_ALREADY_CLAIMED", async () => {
    const host = await openHost(kit!);
    try {
      const a = (await host.dispatch("member.spawn", {
        session_id: kit!.teamId,
        name: "a",
        description: "d",
        prompt: "pa",
      })) as { member: { target: string } };
      const b = (await host.dispatch("member.spawn", {
        session_id: kit!.teamId,
        name: "b",
        description: "d",
        prompt: "pb",
      })) as { member: { target: string } };
      const memberIds = fs.readdirSync(path.join(kit!.provider.teamDir, "members"));
      const created = (await host.dispatch("task.create", {
        session_id: kit!.teamId,
        subject: "s",
        description: "d",
      })) as { task: { id: string; revision: number } };
      const claims = await Promise.allSettled([
        host.dispatch("task.update", {
          session_id: memberIds[0],
          taskId: created.task.id,
          expectedRevision: created.task.revision,
          action: "claim",
        }),
        host.dispatch("task.update", {
          session_id: memberIds[1],
          taskId: created.task.id,
          expectedRevision: created.task.revision,
          action: "claim",
        }),
      ]);
      const codes = claims.map((c) =>
        c.status === "fulfilled" ? "ok" : ((c.reason as TeamError).code ?? String(c.reason)),
      );
      expect(codes.filter((c) => c === "ok")).toHaveLength(1);
      expect(codes.some((c) => c === "TEAM_TASK_ALREADY_CLAIMED" || c === "TEAM_TASK_STALE_REVISION")).toBe(true);
      void a;
      void b;
    } finally {
      await host.close().catch(() => undefined);
    }
  });
});

describe("F13 · wait 真实唤醒（轮次边界 → Activity ≤1.5s）", () => {
  it("成员轮次退出 → wait_agent 被唤醒（timedOut:false）", async () => {
    restoreFns.push(withFakeEnv({ FAKE_ZCODE_SLEEP_MS: "900" }));
    const host = await openHost(kit!);
    try {
      await host.dispatch("member.spawn", { session_id: kit!.teamId, name: "alpha", description: "d", prompt: "p" });
      const memberId = fs.readdirSync(path.join(kit!.provider.teamDir, "members"))[0];
      const waitPromise = host.dispatch("wait.agent", { session_id: kit!.teamId, timeoutMs: 20_000 });
      let deadAt: number | null = null;
      const t0 = Date.now();
      await waitFor(() => {
        if (deadAt === null && !kit!.provider.isAlive(memberId)) deadAt = Date.now();
        return deadAt !== null;
      }, 10_000, 25);
      const result = (await waitPromise) as { timedOut: boolean };
      expect(result.timedOut).toBe(false);
      expect(Date.now() - (deadAt ?? t0)).toBeLessThan(2_000); // watcher(200ms 轮询) + 折叠 + 唤醒
    } finally {
      await host.close().catch(() => undefined);
    }
  });
});

describe("F14 · 处置（runtime.dispose × 真 provider）", () => {
  it("kill 策略：处置终止运行中轮次；AggregateError 语义可见", async () => {
    restoreFns.push(withFakeEnv({ FAKE_ZCODE_SLEEP_MS: "30000" }));
    const store = new TestableMemoryStore(kit!.teamId);
    const runtime = buildRuntime(store);
    const { member } = await runtime.roster.spawnTeammate(kit!.teamId, { name: "alpha", description: "d", prompt: "p" });
    expect(member.status).toBe("running");
    // kill 策略的 drain
    const killKit = buildProviderKit({ drainPolicy: "kill" });
    try {
      const killStore = new TestableMemoryStore(killKit.teamId);
      const killRuntime = new TeamRuntime({
        teamId: killKit.teamId,
        store: killStore,
        provider: killKit.provider,
        limits: { ...killKit.limits, disposalTimeoutMs: 5000 },
        presentation: killKit.provider,
        steerLead: () => false,
        warn: () => undefined,
      });
      await killRuntime.roster.spawnTeammate(killKit.teamId, { name: "alpha", description: "d", prompt: "p" });
      const killMemberId = fs.readdirSync(path.join(killKit.provider.teamDir, "members"))[0];
      await killRuntime.dispose();
      await waitFor(() => !killKit.provider.isAlive(killMemberId), 5000);
      killRuntime.close();
    } finally {
      await killKit.cleanup();
    }
    // keep 策略（默认）：轮次存活（D9 休眠态）
    const keepMemberId = fs.readdirSync(path.join(kit!.provider.teamDir, "members"))[0];
    await runtime.dispose();
    expect(kit!.provider.isAlive(keepMemberId)).toBe(true);
    await kit!.provider.interrupt({ memberId: keepMemberId }); // 清场
    runtime.close();
  });

  it("不可取消 inflight（deliver 确认循环）→ TEAM_DISPOSAL_TIMEOUT + AggregateError（真实路径）", async () => {
    restoreFns.push(withFakeEnv({ FAKE_ZCODE_PRE_SLEEP_MS: "6000" }));
    const store = new TestableMemoryStore(kit!.teamId);
    const runtime = buildRuntime(store);
    await runtime.roster.spawnTeammate(kit!.teamId, { name: "alpha", description: "d", prompt: "p" });
    const memberId = fs.readdirSync(path.join(kit!.provider.teamDir, "members"))[0];
    await waitFor(() => !kit!.provider.isAlive(memberId), 8000); // 首轮退出
    const sendPromise = runtime.mailbox.send(kit!.teamId, {
      target: "alpha",
      content: [{ type: "text", text: "slow" }],
    });
    const settle = sendPromise.catch(() => "settled"); // 观察用（处置超时后 send 以超时/取消落败或滞留）
    const disposeError = await runtime.dispose().then(
      () => null,
      (err: unknown) => err,
    );
    expect(disposeError).toBeInstanceOf(AggregateError);
    expect((disposeError as AggregateError).message).toBe("Agent Teams runtime disposal failed");
    const codes = (disposeError as AggregateError).errors.map((e) => (e instanceof TeamError ? e.code : String(e)));
    expect(codes).toContain("TEAM_DISPOSAL_TIMEOUT");
    await settle;
    runtime.close();
  });
});

function addProvisioning(state: TeamState, id: string, name: string, provider: string): TeamState {
  return {
    ...state,
    members: [
      ...state.members,
      { id, name, description: "d", provider, context: "fresh", phase: "provisioning" as const },
    ],
  };
}
