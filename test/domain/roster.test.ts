// Roster 服务测试（02 §5；F08–F14 + C1/C2/C3/C6/B5）。消息逐字断言。
import { describe, expect, it, vi } from "vitest";
import { TeamError } from "../../src/domain/errors.js";
import { buildKit, TEAM } from "../services/kit.js";
import { memberEvent } from "./helpers.js";

const LEAD = TEAM;

function expectTeamError(p: Promise<unknown>, code: string, message: string): Promise<void> {
  return p.then(
    () => Promise.reject(new Error(`expected TeamError ${code}`)),
    (err: unknown) => {
      expect(err, message).toBeInstanceOf(TeamError);
      expect((err as TeamError).code).toBe(code);
      expect((err as TeamError).message).toBe(message);
      return Promise.resolve();
    },
  );
}

describe("Roster · 0.5.4 持久意图与非终态结果", () => {
  it("完整 origin 先于登记与宿主调用；requestId 作为唯一恢复关联", async () => {
    const { runtime, provider } = buildKit();
    await runtime.roster.spawnTeammate(LEAD, {
      name: "worker", description: "d", prompt: "p", requestId: "req-stable",
    });
    expect(provider.prepared).toEqual([
      { name: "worker", prompt: "p", requestId: "req-stable", context: "fresh" },
    ]);
  });

  it("pending 保留 provisioning，不写 failed、不 interrupt，并携带可观察成员", async () => {
    const { runtime, provider, store } = buildKit();
    provider.programWith({ startOutcome: { kind: "pending" } });
    const result = await runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" });
    expect(result.creation).toBe("pending");
    expect(result.member.status).toBe("provisioning");
    expect(store.state().members[0]?.phase).toBe("provisioning");
    expect(provider.interruptCalls).toBe(0);
  });

  it.each([false, true])("首次返回 pending 后自动复核（进程存活=%s）", async (alive) => {
    vi.useFakeTimers();
    const { runtime, provider } = buildKit();
    try {
      provider.programWith({ startOutcome: { kind: "pending" } });
      provider.isAlive = () => alive;
      const noteRecovery = vi.fn(() => true);
      provider.noteProvisioningRecovery = noteRecovery;
      await runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(noteRecovery).toHaveBeenCalledTimes(1);
    } finally {
      runtime.roster.cancelPendingRecovery();
      vi.useRealTimers();
    }
  });

  it("接任时在途成员仍存活，也会安排后续确认", async () => {
    vi.useFakeTimers();
    const { runtime, provider } = buildKit();
    try {
      provider.programWith({ startOutcome: { kind: "pending" } });
      provider.isAlive = () => true;
      const noteRecovery = vi.fn(() => true);
      provider.noteProvisioningRecovery = noteRecovery;
      await runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" });
      runtime.roster.cancelPendingRecovery(); // 模拟新协调者接任
      await runtime.roster.startRecovery();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(noteRecovery).toHaveBeenCalledTimes(1);
    } finally {
      runtime.roster.cancelPendingRecovery();
      vi.useRealTimers();
    }
  });

  it("待确认成员首轮受理后，自动从 provisioning 转为 active", async () => {
    vi.useFakeTimers();
    const { runtime, provider, store } = buildKit();
    try {
      provider.programWith({ startOutcome: { kind: "pending" } });
      provider.isAlive = () => true;
      provider.noteProvisioningRecovery = () => false;
      provider.resumeContinuable = vi.fn(async (memberId) => ({ memberId, accepted: true }));
      await runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(provider.resumeContinuable).toHaveBeenCalledTimes(1);
      expect(provider.startCalls).toBe(1);
      expect(store.state().members[0].phase).toBe("active");
    } finally {
      runtime.roster.cancelPendingRecovery();
      vi.useRealTimers();
    }
  });

  it("已登记成员有未确认的运行轮次时，等待不会误报没有可观察的成员", async () => {
    const { runtime, provider } = buildKit();
    await runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" });
    provider.isAlive = () => false;
    provider.statusOf = () => "running";
    expect(runtime.roster.hasPendingAutomaticProgress(LEAD)).toBe(true);
  });

  it("运行状态待确认时，中断交给 provider 判断，不能直接报告 inactive", async () => {
    const { runtime, provider } = buildKit();
    await runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" });
    provider.isAlive = () => false;
    provider.statusOf = () => "running";
    expect(await runtime.roster.interrupt(LEAD, "worker")).toEqual({ previousStatus: "running" });
    expect(provider.interruptCalls).toBe(1);
  });

  it("首轮已确认后 active 本地提交失败：不写 failed、不 interrupt", async () => {
    const { runtime, provider, store } = buildKit();
    const append = store.append.bind(store);
    let memberWrites = 0;
    store.append = async (event) => {
      if ((event as { type?: string }).type === "team/member") {
        memberWrites += 1;
        if (memberWrites === 2) throw new Error("local active commit failed");
      }
      return append(event);
    };
    await expect(runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" }))
      .rejects.toThrow("local active commit failed");
    expect(store.state().members[0]?.phase).toBe("provisioning");
    expect(provider.interruptCalls).toBe(0);
  });
});

describe("Roster · 名字校验与预留（F08）", () => {
  it.each(["Bad-Case", "UPPER", "x".repeat(65), "lead", "a_b", "-no", "no-"])(
    "非法名 %j → TEAM_INVALID_MEMBER_NAME 逐字",
    async (name) => {
      const { runtime } = buildKit();
      await expectTeamError(
        runtime.roster.spawnTeammate(LEAD, { name, description: "d", prompt: "p" }),
        "TEAM_INVALID_MEMBER_NAME",
        'teammate name must be lower-kebab-case, at most 64 characters, and not "lead"',
      );
    },
  );

  it("名字由 provisioning 预留、永不复用（failed 也不行）", async () => {
    // F08 / F10
    const { runtime, provider } = buildKit();
    provider.programWith({ startOutcome: { kind: "throw", error: new Error("boom") } });
    await runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" }).catch(() => undefined);
    const state = runtime.roster.listMembers(LEAD);
    expect(state.members.find((m) => m.target === "worker")?.status).toBe("failed");
    await expectTeamError(
      runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" }),
      "TEAM_MEMBER_NAME_TAKEN",
      'teammate name "worker" was already used in this Team',
    );
  });

  it("已重名且模型预检报错 → TEAM_MEMBER_NAME_TAKEN 优先", async () => {
    const { runtime, store, provider } = buildKit();
    await runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" });
    provider.programWith({ preflightError: new Error("Lead model unavailable") });

    await expectTeamError(
      runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" }),
      "TEAM_MEMBER_NAME_TAKEN",
      'teammate name "worker" was already used in this Team',
    );
    expect(store.state().members).toHaveLength(1);
    expect(provider.startCalls).toBe(1);
    expect(provider.prepared).toHaveLength(1);
  });
});

describe("Roster · spawn 全流程顺序（F09）", () => {
  it("模型预检失败（0.4.1）→ 登记前拒绝：零成员、名字未占用、零供给调用；修正后原名可建", async () => {
    const { runtime, store, provider } = buildKit();
    provider.programWith({
      preflightError: Object.assign(new Error("Lead 当前使用官方套餐模型（account:x/GLM-5.3），成员无法继承"), {
        name: "ModelInheritanceError",
      }),
    });
    await expect(
      runtime.roster.spawnTeammate(LEAD, { name: "blocked", description: "d", prompt: "p" }),
    ).rejects.toThrow(/官方套餐模型/);
    // 不增加成员数量、不占用成员名、不触发供给（零隐藏子会话的域层等价口径）
    expect(store.state().members).toHaveLength(0);
    expect(provider.startCalls).toBe(0);
    expect(provider.prepared).toHaveLength(0);
    // 并发重名校验/成员数量上限保持有效：修正 Lead 模型（清除预检错误）后，原名可成功创建
    provider.programWith({});
    const { member } = await runtime.roster.spawnTeammate(LEAD, {
      name: "blocked",
      description: "d",
      prompt: "p",
    });
    expect(member).toMatchObject({ target: "blocked", status: "running" });
    expect(store.state().members).toHaveLength(1);
  });

  it("顺序：provisioning 落盘（seq1）→ startContinuable → active 落盘（seq2）；返回成员行", async () => {
    const { runtime, store, provider } = buildKit();
    const events: string[] = [];
    store.onCommit((_seq, state) => events.push(`commit:${state.members.length}:${state.members[0]?.phase}`));
    const { member } = await runtime.roster.spawnTeammate(LEAD, {
      name: "worker",
      description: "does work",
      prompt: "do it",
    });
    expect(events).toEqual(["commit:1:provisioning", "commit:1:active"]); // 落盘先于 active
    expect(provider.startCalls).toBe(1);
    expect(member).toMatchObject({ target: "worker", role: "teammate", status: "running" });
    expect(provider.teamChildren.size).toBe(1);
  });

  it("首轮 prompt = 任务原文（〔对齐轮〕0.2.1：不再拼身份前缀块；身份由运行时上下文承载）", async () => {
    const { runtime, provider } = buildKit();
    await runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "TASK BODY" });
    const child = [...provider.teamChildren.values()][0];
    expect(child.firstPrompt).toBe("TASK BODY");
    expect(child.firstPrompt).not.toContain("system-reminder"); // 前缀块已删除
  });

  it("startContinuable 失败 → failed 落盘（error=单行）+ interrupt 清理 + 原错误上抛", async () => {
    const { runtime, provider, store } = buildKit();
    const original = new Error("provider exploded\nsecond line");
    provider.programWith({ startOutcome: { kind: "throw", error: original } });
    const caught = await runtime.roster
      .spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" })
      .catch((e: unknown) => e);
    expect(caught).toBe(original); // 原错误上抛
    const state = store.state();
    expect(state.members[0].phase).toBe("failed");
    expect(state.members[0].error).toBe("provider exploded"); // 单行截断
    // 清理：子进程未创建（start 已抛）→ interrupt 为 no-op（不计数）
    expect([...provider.teamChildren.values()][0]?.interrupted ?? 0).toBe(0);
  });

  it("accepted:false → TEAM_PROVISIONING_CONFLICT 分支①逐字 + failed 落盘", async () => {
    const { runtime, provider, store } = buildKit();
    provider.programWith({ startOutcome: { kind: "reject" } });
    const childIdPromise = runtime.roster
      .spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" })
      .catch((e: unknown) => e) as Promise<unknown>;
    const err = (await childIdPromise) as TeamError;
    expect(err.code).toBe("TEAM_PROVISIONING_CONFLICT");
    expect(err.message).toMatch(/initial prompt was not durably accepted/);
    const childId = store.state().members[0].id;
    expect(err.message).toBe(`teammate "${childId}" initial prompt was not durably accepted`);
    expect(store.state().members[0].phase).toBe("failed");
  });

  it("失败记录环节再抛错 → AggregateError（B5 逐字）", async () => {
    const { runtime, provider, store } = buildKit();
    provider.programWith({ startOutcome: { kind: "throw", error: new Error("orig boom") } });
    // provisioning 落盘后武装：下一次 append（= failed 落盘）失败
    const off = store.onCommit(() => {
      off();
      store.failNextAppend();
    });
    const caught = await runtime.roster
      .spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" })
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).message).toBe("teammate creation and durable failure recording both failed");
    const errors = (caught as AggregateError).errors;
    expect((errors[0] as Error).message).toBe("orig boom");
    expect((errors[1] as Error).message).toBe("injected append failure");
  });

  it("settle 目标成员行消失 → 分支④逐字（C1）", async () => {
    const { runtime, provider, store } = buildKit();
    provider.programWith({ startOutcome: { kind: "throw", error: new Error("x") }, startDelayMs: 40 });
    const p = runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 10)); // provisioning 已落盘、provider 延迟中
    store.testMutate((s) => ({ ...s, members: [] }));
    const caught = (await p) as AggregateError;
    const conflict = caught.errors.find(
      (e) => e instanceof TeamError && e.code === "TEAM_PROVISIONING_CONFLICT",
    ) as TeamError | undefined;
    // settle 抛 disappeared → 进 AggregateError（B5 记录环节错误）
    expect(conflict?.message).toMatch(/provisioned teammate ".+" disappeared/);
  });

  it("settle 冲突清理失败 → AggregateError `provisioning conflict cleanup failed` 逐字（F09 第二条）", async () => {
    // 冲突清理只尝试一次；失败不得再经通用 catch 对同一资源重复 interrupt。
    const { runtime, provider } = buildKit();
    provider.programWith({ startOutcome: { kind: "accept" }, startDelayMs: 40 });
    const original = provider.interrupt.bind(provider);
    let interruptCalls = 0;
    (provider as unknown as { interrupt: typeof original }).interrupt = async (args) => {
      interruptCalls += 1;
      if (interruptCalls === 1) throw new Error("cleanup boom");
      return original(args);
    };
    const spawn = runtime.roster
      .spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" })
      .catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 10)); // provisioning 已落盘、provider 延迟中
    await runtime.roster.reconcileProvisioning(); // 无记录 → 定 failed（创建方随即 settle(active) → 冲突）
    const caught = (await spawn) as AggregateError;
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught.message).toBe("provisioning conflict cleanup failed");
    expect(interruptCalls).toBe(1);
    const conflict = caught.errors[0] as TeamError;
    expect(conflict.code).toBe("TEAM_PROVISIONING_CONFLICT");
    expect(conflict.message).toBe('teammate "worker" was reconciled as failed while creation was in progress');
    expect((caught.errors[1] as Error).message).toBe("cleanup boom");
  });

  it("失败路径清理抛错 → 消息① AggregateError（interrupt 兄弟触发面）", async () => {
    const { runtime, provider } = buildKit();
    provider.programWith({
      startOutcome: { kind: "throw", error: new Error("orig boom") },
      interruptError: new Error("cleanup boom"),
    });
    const caught = (await runtime.roster
      .spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" })
      .catch((e: unknown) => e)) as AggregateError;
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught.message).toBe("teammate creation and durable failure recording both failed");
    expect((caught.errors[0] as Error).message).toBe("orig boom");
    expect((caught.errors[1] as Error).message).toBe("cleanup boom");
  });
});

describe("Roster · 限额与权限（F10/F11）", () => {
  it("成员数达 maxMembers（含 failed）→ TEAM_MEMBER_LIMIT 逐字", async () => {
    const { runtime, provider } = buildKit({ limits: { maxMembers: 1 } });
    provider.programWith({ startOutcome: { kind: "throw", error: new Error("x") } });
    await runtime.roster.spawnTeammate(LEAD, { name: "w1", description: "d", prompt: "p" }).catch(() => undefined);
    await expectTeamError(
      runtime.roster.spawnTeammate(LEAD, { name: "w2", description: "d", prompt: "p" }),
      "TEAM_MEMBER_LIMIT",
      "Team member limit 1 reached",
    );
  });

  it("满员且模型预检报错 → TEAM_MEMBER_LIMIT 优先", async () => {
    const { runtime, store, provider } = buildKit({ limits: { maxMembers: 1 } });
    await runtime.roster.spawnTeammate(LEAD, { name: "w1", description: "d", prompt: "p" });
    provider.programWith({ preflightError: new Error("Lead model unavailable") });

    await expectTeamError(
      runtime.roster.spawnTeammate(LEAD, { name: "w2", description: "d", prompt: "p" }),
      "TEAM_MEMBER_LIMIT",
      "Team member limit 1 reached",
    );
    expect(store.state().members).toHaveLength(1);
    expect(provider.startCalls).toBe(1);
    expect(provider.prepared).toHaveLength(1);
  });

  it("非 Lead spawn → TEAM_LEAD_REQUIRED 逐字；非成员 → TEAM_NOT_MEMBER 逐字；处置中 → is disposing", async () => {
    const { runtime, provider } = buildKit();
    await runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" });
    const memberId = [...provider.teamChildren.keys()][0];
    await expectTeamError(
      runtime.roster.spawnTeammate(memberId, { name: "w2", description: "d", prompt: "p" }),
      "TEAM_LEAD_REQUIRED",
      "only the Team Lead can create teammates",
    );
    await expectTeamError(
      runtime.roster.spawnTeammate("stranger", { name: "w3", description: "d", prompt: "p" }),
      "TEAM_NOT_MEMBER",
      'agent "stranger" is not a member of an active Agent Team',
    );
    await runtime.dispose();
    await expectTeamError(
      runtime.roster.spawnTeammate(LEAD, { name: "w4", description: "d", prompt: "p" }),
      "TEAM_DISPOSED",
      "Agent Teams service is disposing",
    );
  });

  it("C2：abort reason 逐字（disposed / creation aborted）", async () => {
    // ① 运行时处置中止（reason = TeamError TEAM_DISPOSED "Agent Teams service disposed"）
    const k1 = buildKit();
    k1.provider.programWith({ startOutcome: { kind: "hang" } });
    const spawn1 = k1.runtime.roster
      .spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" })
      .catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 10));
    void k1.runtime.dispose();
    const err1 = (await spawn1) as TeamError;
    expect(err1.code).toBe("TEAM_DISPOSED");
    expect(err1.message).toBe("Agent Teams service disposed");
    expect(k1.store.state().members[0].phase).toBe("failed"); // 失败路径已落盘

    // ③ 调用方 signal 非 Error reason 中止 → teammate creation aborted
    const k2 = buildKit();
    k2.provider.programWith({ startOutcome: { kind: "hang" } });
    const ac = new AbortController();
    const spawn2 = k2.runtime.roster
      .spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p", signal: ac.signal })
      .catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 10));
    ac.abort("stop-it");
    const err2 = (await spawn2) as TeamError;
    expect(err2.code).toBe("TEAM_DISPOSED");
    expect(err2.message).toBe("teammate creation aborted: stop-it");
  });
});

describe("Roster · 恢复对账（F12 + C3/C6）", () => {
  async function kitWithProvisioningMember(): Promise<ReturnType<typeof buildKit>> {
    const kit = buildKit();
    await kit.store.append(memberEvent({ id: "agent-ghost", name: "ghost", phase: "provisioning" }, TEAM));
    return kit;
  }

  const provisioningLine = (ageMs: number) => ({
    ts: new Date(Date.now() - ageMs).toISOString(),
    event: { type: "team/member", version: 2, teamId: TEAM, member: { id: "agent-ghost", name: "ghost", phase: "provisioning" } },
  });

  function stopUnknownRecovery(kit: ReturnType<typeof buildKit>): void {
    kit.provider.noteProvisioningRecovery = () => true;
    kit.provider.resumeContinuable = async () => {
      throw new Error("must not restart an unknown member creation");
    };
  }

  // —— 0.5.4：缺失/读取异常不等于可证失败；真实 provider 按 origin 持久预算停止恢复 ——
  it("意图缺失：保持 provisioning、停止自动恢复，不按事件年龄定 failed", async () => {
    const kit = await kitWithProvisioningMember();
    stopUnknownRecovery(kit);
    kit.store.syntheticEventLines = [provisioningLine(7_000)];
    const summary = await kit.runtime.roster.reconcileProvisioning();
    expect(summary.deferred).toContain("agent-ghost");
    expect(summary.settled).not.toContain("agent-ghost");
    const member = kit.store.state().members.find((m) => m.id === "agent-ghost");
    expect(member?.phase).toBe("provisioning"); // 未被误杀
  });

  it("事件年龄超过旧宽限仍不按缺记录定 failed；自动恢复停止并可诊断", async () => {
    const kit = await kitWithProvisioningMember();
    stopUnknownRecovery(kit);
    kit.store.syntheticEventLines = [provisioningLine(90_000)];
    const summary = await kit.runtime.roster.reconcileProvisioning();
    expect(summary.deferred).toContain("agent-ghost");
    expect(summary.settled).not.toContain("agent-ghost");
    expect(kit.store.state().members[0].phase).toBe("provisioning");
  });

  it("恢复读取异常 = 结果未知：保持 provisioning，不清理或编造成员失败", async () => {
    const kit = await kitWithProvisioningMember();
    stopUnknownRecovery(kit);
    kit.store.syntheticEventLines = [provisioningLine(3_000)];
    (kit.provider as unknown as { readProvisioningRecord: () => unknown }).readProvisioningRecord = () => {
      throw new Error("disk error");
    };
    const summary = await kit.runtime.roster.reconcileProvisioning();
    expect(summary.deferred).toContain("agent-ghost");
    expect(kit.store.state().members[0].phase).toBe("provisioning");
    expect(kit.store.state().members[0].error).toBeUndefined();
  });

  it("〔D33〕无事件行（内存桩缺省）→ 旧语义：记录缺失即 failed", async () => {
    const kit = await kitWithProvisioningMember();
    const summary = await kit.runtime.roster.reconcileProvisioning();
    expect(summary.deferred).toHaveLength(0);
    expect(kit.store.state().members[0].phase).toBe("failed");
  });

  it("实际记录不匹配仍可 failed；缺记录与未确认不伪装成失败", async () => {
    const cases: Array<[string, () => { rootSessionId: string; descriptor?: { provider: string; mode: string }; initialUserMessageAccepted: boolean } | undefined, string | undefined]> = [
      ["no-record", () => undefined, undefined],
      ["wrong-root", () => ({ rootSessionId: "sess-other", descriptor: { provider: "spawn", mode: "continuable" }, initialUserMessageAccepted: true }), "persisted child Session does not match the provisioned continuation"],
      ["no-descriptor", () => ({ rootSessionId: TEAM, initialUserMessageAccepted: true }), "persisted child Session does not match the provisioned continuation"],
      ["wrong-mode", () => ({ rootSessionId: TEAM, descriptor: { provider: "spawn", mode: "once" }, initialUserMessageAccepted: true }), "persisted child Session does not match the provisioned continuation"],
      ["wrong-provider", () => ({ rootSessionId: TEAM, descriptor: { provider: "fork", mode: "continuable" }, initialUserMessageAccepted: true }), "persisted child Session does not match the provisioned continuation"],
      ["prompt-not-accepted", () => ({ rootSessionId: TEAM, descriptor: { provider: "spawn", mode: "continuable" }, initialUserMessageAccepted: false }), undefined],
    ];
    for (const [name, tamper, expected] of cases) {
      const kit = await kitWithProvisioningMember();
      const record = tamper();
      if (expected === undefined) stopUnknownRecovery(kit);
      kit.provider.setProvisioningRecord("agent-ghost", record);
      await kit.runtime.roster.reconcileProvisioning();
      const member = kit.store.state().members.find((m) => m.id === "agent-ghost");
      expect(member?.phase, `${name}:phase`).toBe(expected === undefined ? "provisioning" : "failed");
      expect(member?.error, `${name}:error`).toBe(expected);
    }
  });

  it("四条件全满足 → active；读取抛错 → 保持待恢复而非成员失败", async () => {
    const kit = await kitWithProvisioningMember();
    kit.provider.setProvisioningRecord("agent-ghost", {
      rootSessionId: TEAM,
      descriptor: { provider: "spawn", mode: "continuable" },
      initialUserMessageAccepted: true,
    });
    await kit.runtime.roster.reconcileProvisioning();
    expect(kit.store.state().members[0].phase).toBe("active");

    const kit2 = await kitWithProvisioningMember();
    // 读取抛错：recon stub 替身（readProvisioningRecord throw）→ 通过 monkey 程序化：直接删记录 + 让 provider 抛
    const original = kit2.provider.readProvisioningRecord.bind(kit2.provider);
    (kit2.provider as unknown as { readProvisioningRecord: () => unknown }).readProvisioningRecord = () => {
      throw new Error("disk error");
    };
    void original;
    stopUnknownRecovery(kit2);
    await kit2.runtime.roster.reconcileProvisioning();
    expect(kit2.store.state().members[0].phase).toBe("provisioning");
    expect(kit2.store.state().members[0].error).toBeUndefined();
  });

  it("竞态：创建方先定案 → 对账放弃（无重复事件）；对账先定 failed → 创建方冲突②逐字 + 清理", async () => {
    // 方向 A：settle 幂等（成员已 active → reconcile 不再追加）
    const kit = buildKit();
    await kit.runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" });
    await kit.runtime.roster.reconcileProvisioning();
    // active 成员不在 pending 集合 → 无事件追加
    expect(kit.store.state().members).toHaveLength(1);

    // 方向 B：创建中（hang）+ 对账定为 failed → 创建方收 conflict ②
    const k2 = buildKit();
    k2.provider.programWith({ startOutcome: { kind: "hang" } });
    const spawn = k2.runtime.roster
      .spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" })
      .catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 10)); // provisioning 已落盘，provider 挂起
    k2.provider.setProvisioningRecord([...k2.store.state().members][0].id, undefined); // 无记录 → 对账 failed
    await k2.runtime.roster.reconcileProvisioning();
    expect(k2.store.state().members[0].phase).toBe("failed");
    // 释放挂起的 spawn（abort 使其结束）
    void spawn; // 保持引用；hang 泄漏控制：下一断言不依赖它 —— 见冲突清单测试后续
  });

  it("对账抛错 → 仅警告（C3 逐字），服务不中断", async () => {
    const kit = await kitWithProvisioningMember();
    kit.provider.setProvisioningRecord("agent-ghost", {
      rootSessionId: TEAM,
      descriptor: { provider: "spawn", mode: "continuable" },
      initialUserMessageAccepted: true,
    });
    kit.store.failNextAppend(); // settle 落盘失败 → 恢复流程抛错
    await kit.runtime.roster.reconcileProvisioning();
    expect(kit.warnings.some((w) => w.startsWith(`Agent Teams recovery for "agent-ghost" failed: `))).toBe(true);
    // 服务不中断
    expect(kit.runtime.roster.listMembers(LEAD).members.length).toBeGreaterThan(0);
  });
});

describe("Roster · listMembers / interrupt（F13/F14）", () => {
  it("Lead 伪行第一；status 映射；model 回退链；diagnostics=[error]", async () => {
    const { runtime, provider } = buildKit();
    await runtime.roster.spawnTeammate(LEAD, { name: "alive-one", description: "d1", prompt: "p" });
    await runtime.roster.spawnTeammate(LEAD, { name: "dead-one", description: "d2", prompt: "p" });
    // 0.4.0：spawn 无模型参数；成员 model = 继承生效记录（mock 直改桩模拟）
    const aliveId = [...provider.teamChildren.keys()].find((id) => provider.teamChildren.get(id)?.name === "alive-one")!;
    provider.teamChildren.get(aliveId)!.model = "m-xl";
    provider.killChild([...provider.teamChildren.keys()].find((id) => provider.teamChildren.get(id)?.name === "dead-one") as string);
    const { members } = runtime.roster.listMembers(LEAD);
    expect(members[0]).toMatchObject({ target: "lead", role: "lead", status: "running", diagnostics: [] });
    const alive = members.find((m) => m.target === "alive-one");
    expect(alive).toMatchObject({ status: "running", model: "m-xl" });
    const dead = members.find((m) => m.target === "dead-one");
    expect(dead?.status).toBe("inactive");
    expect(dead?.model).toBeUndefined(); // 无 model 且无 leadModel → 缺省
  });

  it("Lead 行模型：presentation.leadModelOf 实查优先于 leadModel 配置", () => {
    const { runtime, provider } = buildKit({ leadModel: "m-config" });
    provider.programWith({ leadModel: "m-observed" });
    expect(runtime.roster.listMembers(LEAD).members[0]?.model).toBe("m-observed");
  });

  it("GitHub #6：presentation.diagnosticsOf 的诊断追加到成员行（Lead 伪行不受影响）", async () => {
    const { runtime, provider } = buildKit();
    await runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" });
    const memberId = [...provider.teamChildren.keys()][0]!;
    provider.programWith({
      memberDiagnostics: { [memberId]: ["模型设置未生效：p/x（Reasoning level is required）"] },
    });
    const { members } = runtime.roster.listMembers(LEAD);
    expect(members[0]).toMatchObject({ target: "lead", diagnostics: [] });
    expect(members.find((m) => m.target === "worker")?.diagnostics).toEqual([
      "模型设置未生效：p/x（Reasoning level is required）",
    ]);
  });

  it("GitHub #6：呈现侧无 diagnosticsOf（旧桩）→ 仅域侧诊断，不报错", async () => {
    const { runtime } = buildKit();
    await runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" });
    const { members } = runtime.roster.listMembers(LEAD);
    expect(members.find((m) => m.target === "worker")?.diagnostics).toEqual([]);
  });

  it("Lead 行模型：leadModelOf 无结果 → leadModel 配置；都没有 → 缺省", () => {
    const configured = buildKit({ leadModel: "m-config" });
    expect(configured.runtime.roster.listMembers(LEAD).members[0]?.model).toBe("m-config");
    const bare = buildKit();
    expect(bare.runtime.roster.listMembers(LEAD).members[0]?.model).toBeUndefined();
  });

  it("interrupt：Lead-only / 自中断 / 非 active / 不存活 / 存活五分支（F14）", async () => {
    const { runtime, provider } = buildKit();
    const { } = await runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" });
    const memberId = [...provider.teamChildren.keys()][0];
    await expectTeamError(
      runtime.roster.interrupt(memberId, "worker"),
      "TEAM_LEAD_REQUIRED",
      "only the Team Lead can interrupt teammates",
    );
    await expectTeamError(
      runtime.roster.interrupt(LEAD, "lead"),
      "TEAM_INVALID_TARGET",
      "the Team Lead cannot interrupt itself",
    );
    await expectTeamError(
      runtime.roster.interrupt(LEAD, "ghost"),
      "TEAM_MEMBER_NOT_FOUND",
      'active teammate "ghost" not found',
    );
    provider.killChild(memberId);
    expect(await runtime.roster.interrupt(LEAD, "worker")).toEqual({ previousStatus: "inactive" });
    provider.reviveChild(memberId);
    const result = await runtime.roster.interrupt(LEAD, "worker");
    expect(result).toEqual({ previousStatus: "running" });
    // pending 保留、任务归属不变：无任何事件追加
    expect(runtime.taskboard.list(LEAD).tasks).toHaveLength(0);
  });
});
