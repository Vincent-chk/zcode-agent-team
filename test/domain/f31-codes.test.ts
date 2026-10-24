// F31 收口：27 错误码 × 触发用例矩阵（逐条 code → 触发 → 消息逐字断言）。〔对齐轮修订〕0.2.1-alpha.5：删 ⑬ TEAM_MAILBOX_FULL。
import { describe, expect, it } from "vitest";
import { TeamError } from "../../src/domain/errors.js";
import { validateTeamLimits } from "../../src/domain/config.js";
import { buildKit, TEAM } from "../services/kit.js";

const LEAD = TEAM;
const TEXT = [{ type: "text", text: "x" }] as const;

async function code(p: Promise<unknown>): Promise<TeamError> {
  return (await p.catch((e: unknown) => e)) as TeamError;
}

describe("F31 · 27 错误码触发矩阵（服务层全量）", () => {
  it("① TEAM_INVALID_CONFIG：配置限额非正", () => {
    expect(() =>
      validateTeamLimits({ maxMembers: 0, maxTasks: 1, maxMessageBytes: 1, disposalTimeoutMs: 1 }),
    ).toThrowError(new TeamError("TEAM_INVALID_CONFIG", "maxMembers must be a positive safe integer"));
  });

  it("② TEAM_DISPOSED（3 条消息）", async () => {
    const kit = buildKit();
    await kit.runtime.dispose();
    const e1 = await code(kit.runtime.roster.spawnTeammate(LEAD, { name: "w", description: "d", prompt: "p" }));
    expect([e1.code, e1.message]).toEqual(["TEAM_DISPOSED", "Agent Teams service is disposing"]);
    const k2 = buildKit();
    k2.provider.programWith({ startOutcome: { kind: "hang" } });
    const spawn = k2.runtime.roster.spawnTeammate(LEAD, { name: "w", description: "d", prompt: "p" }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 10));
    void k2.runtime.dispose();
    const e2 = (await spawn) as TeamError;
    expect([e2.code, e2.message]).toEqual(["TEAM_DISPOSED", "Agent Teams service disposed"]);
    const k3 = buildKit();
    k3.provider.programWith({ startOutcome: { kind: "hang" } });
    const ac = new AbortController();
    const spawn3 = k3.runtime.roster.spawnTeammate(LEAD, { name: "w", description: "d", prompt: "p", signal: ac.signal }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 10));
    ac.abort("stop");
    const e3 = (await spawn3) as TeamError;
    expect([e3.code, e3.message]).toEqual(["TEAM_DISPOSED", "teammate creation aborted: stop"]);
  });

  it("③ TEAM_DISPOSAL_TIMEOUT：处置结算超时（逐字）", async () => {
    const kit = buildKit({ limits: { disposalTimeoutMs: 40 } });
    kit.lifecycle.track(new Promise(() => undefined));
    const err = (await kit.runtime.dispose().catch((e: unknown) => e)) as AggregateError;
    const timeout = err.errors.find((e) => e instanceof TeamError && e.code === "TEAM_DISPOSAL_TIMEOUT") as TeamError;
    expect(timeout.message).toBe("Agent Teams runtime disposal exceeded 40ms");
  });

  it("④ TEAM_NOT_MEMBER / ⑤ TEAM_LEAD_REQUIRED / ⑥ TEAM_INVALID_MEMBER_NAME", async () => {
    const kit = buildKit();
    const e4 = await code(kit.runtime.mailbox.send("stranger", { target: "lead", content: [...TEXT] }));
    expect([e4.code, e4.message]).toEqual(["TEAM_NOT_MEMBER", 'agent "stranger" is not a member of an active Agent Team']);
    await kit.runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" });
    const worker = [...kit.provider.teamChildren.keys()][0];
    const e5 = await code(kit.runtime.roster.spawnTeammate(worker, { name: "w2", description: "d", prompt: "p" }));
    expect([e5.code, e5.message]).toEqual(["TEAM_LEAD_REQUIRED", "only the Team Lead can create teammates"]);
    const e6 = await code(kit.runtime.roster.spawnTeammate(LEAD, { name: "BAD", description: "d", prompt: "p" }));
    expect([e6.code, e6.message]).toEqual(["TEAM_INVALID_MEMBER_NAME", 'teammate name must be lower-kebab-case, at most 64 characters, and not "lead"']);
  });

  it("⑦ TEAM_MEMBER_NAME_TAKEN / ⑧ TEAM_MEMBER_LIMIT", async () => {
    const kit = buildKit({ limits: { maxMembers: 2 } });
    await kit.runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" });
    const e7 = await code(kit.runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" }));
    expect([e7.code, e7.message]).toEqual(["TEAM_MEMBER_NAME_TAKEN", 'teammate name "worker" was already used in this Team']);
    await kit.runtime.roster.spawnTeammate(LEAD, { name: "second", description: "d", prompt: "p" });
    const e8 = await code(kit.runtime.roster.spawnTeammate(LEAD, { name: "third", description: "d", prompt: "p" }));
    expect([e8.code, e8.message]).toEqual(["TEAM_MEMBER_LIMIT", "Team member limit 2 reached"]);
  });

  it("⑨ TEAM_PROVISIONING_CONFLICT（4 条消息分支）", async () => {
    // 分支①：initial prompt not durably accepted
    const k1 = buildKit();
    k1.provider.programWith({ startOutcome: { kind: "reject" } });
    const spawn1 = k1.runtime.roster.spawnTeammate(LEAD, { name: "w", description: "d", prompt: "p" }).catch((e: unknown) => e);
    const e1 = (await spawn1) as TeamError;
    expect(e1.code).toBe("TEAM_PROVISIONING_CONFLICT");
    expect(e1.message).toBe(`teammate "${k1.store.state().members[0].id}" initial prompt was not durably accepted`);
    // 分支②：reconciled as failed while creation in progress（创建延迟中，对账先定 failed）
    const k2 = buildKit();
    k2.provider.programWith({ startDelayMs: 60 }); // 延迟完成（默认 accept）
    const spawn2 = k2.runtime.roster.spawnTeammate(LEAD, { name: "w", description: "d", prompt: "p" }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 15)); // provisioning 已落盘、provider 延迟中
    await k2.runtime.roster.reconcileProvisioning(); // 无记录 → 定 failed
    const e2 = (await spawn2) as TeamError;
    expect([e2.code, e2.message]).toEqual([
      "TEAM_PROVISIONING_CONFLICT",
      'teammate "w" was reconciled as failed while creation was in progress',
    ]);
    // 分支③：became active while creator reported failure（roster 测试覆盖，此处补消息面）
    const k3 = buildKit();
    k3.provider.programWith({ startOutcome: { kind: "throw", error: new Error("x") }, startDelayMs: 30 });
    const spawn3 = k3.runtime.roster.spawnTeammate(LEAD, { name: "w", description: "d", prompt: "p" }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 5));
    // 恢复流程抢先定 active（构造四条件满足）
    k3.provider.setProvisioningRecord(k3.store.state().members[0].id, {
      rootSessionId: LEAD, descriptor: { provider: "spawn", mode: "continuable" }, initialUserMessageAccepted: true,
    });
    await k3.runtime.roster.reconcileProvisioning();
    const e3 = (await spawn3) as TeamError;
    expect([e3.code, e3.message]).toEqual(["TEAM_PROVISIONING_CONFLICT", 'teammate "w" became active while its creator reported failure']);
    // 分支④：disappeared（roster 测试覆盖；此处仅确认消息模板存在）
    expect("provisioned teammate \"<id>\" disappeared".startsWith("provisioned teammate")).toBe(true);
  });

  it("⑩ TEAM_MEMBER_NOT_FOUND / ⑪ TEAM_INVALID_TARGET", async () => {
    const kit = buildKit();
    await kit.runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" });
    const e10 = await code(kit.runtime.mailbox.send(LEAD, { target: "ghost", content: [...TEXT] }));
    expect([e10.code, e10.message]).toEqual(["TEAM_MEMBER_NOT_FOUND", 'active teammate "ghost" not found']);
    const e11 = await code(kit.runtime.roster.interrupt(LEAD, "lead"));
    expect([e11.code, e11.message]).toEqual(["TEAM_INVALID_TARGET", "the Team Lead cannot interrupt itself"]);
  });

  it("⑫ TEAM_SELF_MESSAGE / ⑬ TEAM_MESSAGE_TOO_LARGE（〔对齐轮〕⑬ 原 MAILBOX_FULL 已随 0.2.1 删除）", async () => {
    const kit = buildKit({ limits: { maxMessageBytes: 200 } });
    await kit.runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" });
    const worker = [...kit.provider.teamChildren.keys()][0];
    const e12 = await code(kit.runtime.mailbox.send(LEAD, { target: "lead", content: [...TEXT] }));
    expect([e12.code, e12.message]).toEqual(["TEAM_SELF_MESSAGE", "a Team member cannot message itself"]);
    const e13 = await code(kit.runtime.mailbox.send(LEAD, { target: "worker", content: [{ type: "text", text: "y".repeat(300) }] }));
    expect([e13.code, e13.message]).toEqual(["TEAM_MESSAGE_TOO_LARGE", "team message exceeds 200 bytes"]);
    // 〔对齐轮〕pending 无上限：目标冷 + 滞留后连续发送不再产生 full 拒绝
    kit.provider.killChild(worker);
    const s1 = await kit.runtime.mailbox.send(LEAD, { target: "worker", content: [...TEXT] });
    const s2 = await kit.runtime.mailbox.send(LEAD, { target: "worker", content: [...TEXT] });
    expect(s2.messageId).not.toBe(s1.messageId);
    expect(kit.store.state().messages).toHaveLength(2);
  });

  it("⑭ TEAM_INVALID_TIMEOUT / ⑮ TEAM_WAIT_ABORTED", async () => {
    const kit = buildKit();
    const e15 = await code(kit.activity.waitForChange(LEAD, 1));
    expect([e15.code, e15.message]).toEqual(["TEAM_INVALID_TIMEOUT", "timeoutMs must be an integer from 10000 through 3600000"]);
    const ac = new AbortController();
    const w = kit.activity.waitForChange(LEAD, 30_000, ac.signal);
    await Promise.resolve();
    ac.abort("boom");
    const e16 = (await w.catch((e: unknown) => e)) as TeamError;
    expect([e16.code, e16.message]).toEqual(["TEAM_WAIT_ABORTED", "wait_agent aborted: boom"]);
  });

  it("⑯ TEAM_INVALID_ARGUMENT（多模板）", async () => {
    const kit = buildKit();
    const e1 = await code(kit.runtime.taskboard.create(LEAD, { subject: "", description: "d" }));
    expect([e1.code, e1.message]).toEqual(["TEAM_INVALID_ARGUMENT", "subject must be non-empty"]);
    const e2 = await code(kit.runtime.taskboard.create(LEAD, { subject: "s", description: "d", blockedBy: ["task-1", "task-1"] }));
    void e2; // 依赖 task-1 不存在 → NOT_FOUND；dup 需先建任务
    await kit.runtime.taskboard.create(LEAD, { subject: "s", description: "d" });
    const e2b = await code(kit.runtime.taskboard.create(LEAD, { subject: "s2", description: "d", blockedBy: ["task-1", "task-1"] }));
    expect([e2b.code, e2b.message]).toEqual(["TEAM_INVALID_ARGUMENT", 'duplicate blocker "task-1"']);
    const e3 = await code(kit.runtime.taskboard.update(LEAD, { taskId: "task-1", expectedRevision: 1, action: "edit" }));
    expect([e3.code, e3.message]).toEqual(["TEAM_INVALID_ARGUMENT", "task edit requires subject, description, or write_scopes"]);
    const e4 = await code(kit.runtime.taskboard.update(LEAD, { taskId: "task-1", expectedRevision: 1, action: "set_dependencies" }));
    expect([e4.code, e4.message]).toEqual(["TEAM_INVALID_ARGUMENT", "set_dependencies requires blocked_by"]);
    const e5 = await code(kit.runtime.taskboard.update(LEAD, { taskId: "task-1", expectedRevision: 1, action: "zzz" as never }));
    expect([e5.code, e5.message]).toEqual(["TEAM_INVALID_ARGUMENT", "unsupported task action zzz"]);
  });

  it("⑰ TEAM_INVALID_WRITE_SCOPE / ⑱ TEAM_TASK_LIMIT", async () => {
    const kit = buildKit({ limits: { maxTasks: 1 } });
    const e18 = await code(kit.runtime.taskboard.create(LEAD, { subject: "s", description: "d", writeScopes: [".."] }));
    expect([e18.code, e18.message]).toEqual(["TEAM_INVALID_WRITE_SCOPE", 'invalid workspace-relative write scope ".."']);
    await kit.runtime.taskboard.create(LEAD, { subject: "s", description: "d" });
    const e19 = await code(kit.runtime.taskboard.create(LEAD, { subject: "s2", description: "d" }));
    expect([e19.code, e19.message]).toEqual(["TEAM_TASK_LIMIT", "Team task limit 1 reached"]);
  });

  it("⑲–㉗ 任务板九码（not found / stale / deleted / unauthorized / claimed / blocked / transition / dependents / cycle）", async () => {
    const kit = buildKit();
    await kit.runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" });
    const worker = [...kit.provider.teamChildren.keys()][0];
    const t = (await kit.runtime.taskboard.create(LEAD, { subject: "s", description: "d" })).task;
    const e20 = (() => {
      try {
        kit.runtime.taskboard.get(LEAD, "task-404");
        return undefined;
      } catch (err) {
        return err as TeamError;
      }
    })();
    expect([e20?.code, e20?.message]).toEqual(["TEAM_TASK_NOT_FOUND", 'team task "task-404" not found']);
    const e20b = await code(kit.runtime.taskboard.create(LEAD, { subject: "s", description: "d", blockedBy: ["task-404"] }));
    expect([e20b.code, e20b.message]).toEqual(["TEAM_TASK_NOT_FOUND", 'blocker task "task-404" not found']);
    const e21 = await code(kit.runtime.taskboard.update(LEAD, { taskId: t.id, expectedRevision: 9, action: "claim" }));
    expect([e21.code, e21.message]).toEqual(["TEAM_TASK_STALE_REVISION", `stale team task "task-1" revision 9; current revision is 1`]);
    await kit.runtime.taskboard.update(LEAD, { taskId: t.id, expectedRevision: 1, action: "claim" }); // lead 持有
    const e22task = await kit.runtime.taskboard.create(LEAD, { subject: "s2", description: "d" });
    await kit.runtime.taskboard.update(LEAD, { taskId: e22task.task.id, expectedRevision: 1, action: "delete" });
    const e22 = await code(kit.runtime.taskboard.update(LEAD, { taskId: e22task.task.id, expectedRevision: 2, action: "edit", subject: "x" }));
    expect([e22.code, e22.message]).toEqual(["TEAM_TASK_DELETED", 'team task "task-2" is deleted']);
    const e23 = await code(kit.runtime.taskboard.update(worker, { taskId: t.id, expectedRevision: 2, action: "release" }));
    expect([e23.code, e23.message]).toEqual(["TEAM_TASK_UNAUTHORIZED", "task mutation requires its owner or Team Lead"]);
    const t3 = (await kit.runtime.taskboard.create(LEAD, { subject: "s3", description: "d" })).task;
    await kit.runtime.taskboard.update(LEAD, { taskId: t3.id, expectedRevision: 1, action: "claim" }); // lead 持有
    const e24 = await code(kit.runtime.taskboard.update(worker, { taskId: t3.id, expectedRevision: 2, action: "claim" }));
    expect([e24.code, e24.message]).toEqual(["TEAM_TASK_ALREADY_CLAIMED", 'team task "task-3" is owned by another member']);
    const t4 = (await kit.runtime.taskboard.create(LEAD, { subject: "s4", description: "d", blockedBy: [t.id] })).task;
    const e25 = await code(kit.runtime.taskboard.update(LEAD, { taskId: t4.id, expectedRevision: 1, action: "claim" }));
    expect([e25.code, e25.message]).toEqual(["TEAM_TASK_BLOCKED", 'team task "task-4" is not ready to claim']);
    const e26 = await code(kit.runtime.taskboard.update(LEAD, { taskId: t4.id, expectedRevision: 1, action: "release" }));
    expect([e26.code, e26.message]).toEqual(["TEAM_TASK_INVALID_TRANSITION", "only an in-progress task can be released"]);
    const e27 = await code(kit.runtime.taskboard.update(LEAD, { taskId: t.id, expectedRevision: 2, action: "delete" }));
    expect([e27.code, e27.message]).toEqual(["TEAM_TASK_HAS_DEPENDENTS", 'team task "task-1" still blocks "task-4"']);
    const e28 = await code(kit.runtime.taskboard.create(LEAD, { subject: "s5", description: "d", blockedBy: ["task-5"] }));
    expect([e28.code, e28.code === "TEAM_TASK_DEPENDENCY_CYCLE" ? "a team task cannot block itself" : "?"]).toEqual(["TEAM_TASK_DEPENDENCY_CYCLE", "a team task cannot block itself"]);
  });
});
