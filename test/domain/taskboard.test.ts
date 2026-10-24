// TaskBoard 服务测试（02 §7；F22–F27）。八 action 全分支 + CAS + 墓碑 + list 分页；消息逐字。
import { describe, expect, it } from "vitest";
import { TeamError } from "../../src/domain/errors.js";
import { buildKit, TEAM } from "../services/kit.js";

const LEAD = TEAM;

function expectTeamError(p: Promise<unknown> | (() => unknown), code: string, message: string): Promise<void> {
  const promise = typeof p === "function" ? Promise.resolve().then(p) : (p as Promise<unknown>);
  return promise.then(
    () => Promise.reject(new Error(`expected TeamError ${code}`)),
    (err: unknown) => {
      expect(err).toBeInstanceOf(TeamError);
      expect((err as TeamError).code).toBe(code);
      expect((err as TeamError).message).toBe(message);
      return Promise.resolve();
    },
  );
}

async function setup() {
  const kit = buildKit();
  const { member } = await kit.runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" });
  void member;
  const worker = [...kit.provider.teamChildren.keys()][0] as string;
  return { kit, worker };
}

async function createTask(kit: ReturnType<typeof buildKit>, subject = "s", extra: { blockedBy?: string[]; writeScopes?: string[] } = {}) {
  const r = await kit.runtime.taskboard.create(LEAD, { subject, description: "d", ...extra });
  return r.task;
}

describe("TaskBoard · create（F22）", () => {
  it("id 递增 task-<n>；subject/description 逐字校验；writeScopes 归一+去重", async () => {
    const { kit } = await setup();
    const t1 = await createTask(kit, "第一");
    const t2 = await createTask(kit, "第二", { writeScopes: ["src\\lib", "./src", "src/", "docs"] });
    expect(t1.id).toBe("task-1");
    expect(t2.id).toBe("task-2");
    expect(t2.writeScopes).toEqual(["src/lib", "src", "docs"]); // 归一 + 去重
    await expectTeamError(
      kit.runtime.taskboard.create(LEAD, { subject: "  ", description: "d" }),
      "TEAM_INVALID_ARGUMENT",
      "subject must be non-empty",
    );
    await expectTeamError(
      kit.runtime.taskboard.create(LEAD, { subject: "s", description: "x".repeat(16385) }),
      "TEAM_INVALID_ARGUMENT",
      "description exceeds 16384 characters",
    );
    await expectTeamError(
      kit.runtime.taskboard.create(LEAD, { subject: "s", description: "d", writeScopes: ["/abs"] }),
      "TEAM_INVALID_WRITE_SCOPE",
      'invalid workspace-relative write scope "/abs"',
    );
    await expectTeamError(
      kit.runtime.taskboard.create(LEAD, { subject: "s", description: "d", blockedBy: ["task-404"] }),
      "TEAM_TASK_NOT_FOUND",
      'blocker task "task-404" not found',
    );
    await expectTeamError(
      kit.runtime.taskboard.create(LEAD, { subject: "s", description: "d", blockedBy: ["task-1", "task-1"] }),
      "TEAM_INVALID_ARGUMENT",
      'duplicate blocker "task-1"',
    );
    await expectTeamError(
      kit.runtime.taskboard.create(LEAD, { subject: "s", description: "d", blockedBy: ["task-3"] }),
      "TEAM_TASK_DEPENDENCY_CYCLE",
      "a team task cannot block itself",
    );
  });

  it("maxTasks 与 id 空间耗尽 → TEAM_TASK_LIMIT 两条逐字（F22）", async () => {
    const kit = buildKit({ limits: { maxTasks: 1 } });
    await kit.runtime.taskboard.create(LEAD, { subject: "s", description: "d" });
    await expectTeamError(
      kit.runtime.taskboard.create(LEAD, { subject: "s2", description: "d" }),
      "TEAM_TASK_LIMIT",
      "Team task limit 1 reached",
    );
    // id 空间耗尽：删完再把 nextTaskNumber 拨回已占用的 id（重放会随事件推进，须事后构造）
    await kit.runtime.taskboard.update(LEAD, { taskId: "task-1", expectedRevision: 1, action: "delete" });
    kit.store.testMutate((s) => ({ ...s, nextTaskNumber: 1 }));
    await expectTeamError(
      kit.runtime.taskboard.create(LEAD, { subject: "s3", description: "d" }),
      "TEAM_TASK_LIMIT",
      "Team task id space exhausted",
    );
  });
});

describe("TaskBoard · update 前置与八 action（F23/F24）", () => {
  it("统一前置：not found / CAS 双值 / deleted / 未授权 逐字", async () => {
    const { kit, worker } = await setup();
    const task = await createTask(kit);
    await expectTeamError(
      kit.runtime.taskboard.update(LEAD, { taskId: "task-9", expectedRevision: 1, action: "claim" }),
      "TEAM_TASK_NOT_FOUND",
      'team task "task-9" not found',
    );
    await expectTeamError(
      kit.runtime.taskboard.update(LEAD, { taskId: task.id, expectedRevision: 7, action: "claim" }),
      "TEAM_TASK_STALE_REVISION",
      `stale team task "task-1" revision 7; current revision is 1`,
    );
    await kit.runtime.taskboard.update(LEAD, { taskId: task.id, expectedRevision: 1, action: "delete" });
    await expectTeamError(
      kit.runtime.taskboard.update(LEAD, { taskId: task.id, expectedRevision: 2, action: "edit", subject: "x" }),
      "TEAM_TASK_DELETED",
      'team task "task-1" is deleted',
    );
    const t2 = await createTask(kit, "t2");
    await kit.runtime.taskboard.update(LEAD, { taskId: t2.id, expectedRevision: 1, action: "claim" });
    await expectTeamError(
      kit.runtime.taskboard.update(worker, { taskId: t2.id, expectedRevision: 2, action: "edit", subject: "x" }),
      "TEAM_TASK_UNAUTHORIZED",
      "task mutation requires its owner or Team Lead",
    );
    await expectTeamError(
      kit.runtime.taskboard.update(LEAD, { taskId: t2.id, expectedRevision: 2, action: "nope" as never }),
      "TEAM_INVALID_ARGUMENT",
      "unsupported task action nope",
    );
  });

  it("claim：任意成员；他人已持 → ALREADY_CLAIMED 逐字；非 pending/not ready → BLOCKED 逐字", async () => {
    const { kit, worker } = await setup();
    const a = await createTask(kit, "a");
    const claimed = await kit.runtime.taskboard.update(worker, { taskId: a.id, expectedRevision: 1, action: "claim" });
    expect(claimed.task).toMatchObject({ status: "in_progress", ownerName: "worker", revision: 2 });
    await expectTeamError(
      kit.runtime.taskboard.update(LEAD, { taskId: a.id, expectedRevision: 2, action: "claim" }),
      "TEAM_TASK_ALREADY_CLAIMED",
      'team task "task-1" is owned by another member',
    );
    const blocked = await createTask(kit, "b", { blockedBy: [a.id] });
    await expectTeamError(
      kit.runtime.taskboard.update(worker, { taskId: blocked.id, expectedRevision: 1, action: "claim" }),
      "TEAM_TASK_BLOCKED",
      'team task "task-2" is not ready to claim',
    );
  });

  it("release/edit/set_dependencies/complete/reopen：前置、结果快照、专有错误逐字；complete 保留 owner、release/reopen 去 owner", async () => {
    const { kit, worker } = await setup();
    const t = await createTask(kit);
    // release 前置
    await expectTeamError(
      kit.runtime.taskboard.update(LEAD, { taskId: t.id, expectedRevision: 1, action: "release" }),
      "TEAM_TASK_INVALID_TRANSITION",
      "only an in-progress task can be released",
    );
    // edit 三者全缺
    await expectTeamError(
      kit.runtime.taskboard.update(LEAD, { taskId: t.id, expectedRevision: 1, action: "edit" }),
      "TEAM_INVALID_ARGUMENT",
      "task edit requires subject, description, or write_scopes",
    );
    const edited = await kit.runtime.taskboard.update(LEAD, {
      taskId: t.id, expectedRevision: 1, action: "edit", subject: "s2", writeScopes: ["src"],
    });
    expect(edited.task).toMatchObject({ subject: "s2", writeScopes: ["src"], revision: 2, status: "pending" });
    // set_dependencies 缺参 / 成功
    await expectTeamError(
      kit.runtime.taskboard.update(LEAD, { taskId: t.id, expectedRevision: 2, action: "set_dependencies" }),
      "TEAM_INVALID_ARGUMENT",
      "set_dependencies requires blocked_by",
    );
    // complete 前置
    await expectTeamError(
      kit.runtime.taskboard.update(LEAD, { taskId: t.id, expectedRevision: 2, action: "complete" }),
      "TEAM_TASK_INVALID_TRANSITION",
      "only an in-progress task can complete",
    );
    // worker claim → complete（owner 保留）
    await kit.runtime.taskboard.update(worker, { taskId: t.id, expectedRevision: 2, action: "claim" });
    const done = await kit.runtime.taskboard.update(worker, { taskId: t.id, expectedRevision: 3, action: "complete" });
    expect(done.task).toMatchObject({ status: "completed", ownerName: "worker", revision: 4 });
    // reopen 前置（非 completed）→ 用新 pending 任务
    const t2 = await createTask(kit, "t2");
    await expectTeamError(
      kit.runtime.taskboard.update(LEAD, { taskId: t2.id, expectedRevision: 1, action: "reopen" }),
      "TEAM_TASK_INVALID_TRANSITION",
      "only a completed task can reopen",
    );
    const reopened = await kit.runtime.taskboard.update(worker, { taskId: t.id, expectedRevision: 4, action: "reopen" });
    expect(reopened.task).toMatchObject({ status: "pending", revision: 5 });
    expect("ownerName" in reopened.task).toBe(false); // 去 owner
    // release 去 owner
    await kit.runtime.taskboard.update(worker, { taskId: t2.id, expectedRevision: 1, action: "claim" });
    const released = await kit.runtime.taskboard.update(worker, { taskId: t2.id, expectedRevision: 2, action: "release" });
    expect(released.task).toMatchObject({ status: "pending" });
    expect("ownerName" in released.task).toBe(false);
  });

  it("reassign：Lead-only（推断文案）/ 状态前置 / 空 owner 去指派 / blocked / 目标无效 逐字", async () => {
    const { kit, worker } = await setup();
    const t = await createTask(kit);
    await expectTeamError(
      kit.runtime.taskboard.update(worker, { taskId: t.id, expectedRevision: 1, action: "reassign", owner: "worker" }),
      "TEAM_LEAD_REQUIRED",
      "only the Team Lead can reassign tasks",
    );
    await kit.runtime.taskboard.update(worker, { taskId: t.id, expectedRevision: 1, action: "claim" });
    await kit.runtime.taskboard.update(worker, { taskId: t.id, expectedRevision: 2, action: "complete" });
    await expectTeamError(
      kit.runtime.taskboard.update(LEAD, { taskId: t.id, expectedRevision: 3, action: "reassign", owner: "worker" }),
      "TEAM_TASK_INVALID_TRANSITION",
      "only a pending or in-progress task can be reassigned",
    );
    const t2 = await createTask(kit, "t2");
    const unassigned = await kit.runtime.taskboard.update(LEAD, {
      taskId: t2.id, expectedRevision: 1, action: "reassign", owner: "  ",
    });
    expect(unassigned.task).toMatchObject({ status: "pending" });
    expect("ownerName" in unassigned.task).toBe(false);
    const blocker = await createTask(kit, "t3");
    await kit.runtime.taskboard.update(LEAD, { taskId: blocker.id, expectedRevision: 1, action: "claim" });
    const blockedTask = await createTask(kit, "t4", { blockedBy: [blocker.id] });
    await expectTeamError(
      kit.runtime.taskboard.update(LEAD, { taskId: blockedTask.id, expectedRevision: 1, action: "reassign", owner: "worker" }),
      "TEAM_TASK_BLOCKED",
      'team task "task-4" is blocked',
    );
    await expectTeamError(
      kit.runtime.taskboard.update(LEAD, { taskId: t2.id, expectedRevision: 2, action: "reassign", owner: "ghost" }),
      "TEAM_MEMBER_NOT_FOUND",
      'active teammate "ghost" not found',
    );
    const assigned = await kit.runtime.taskboard.update(LEAD, {
      taskId: t2.id, expectedRevision: 2, action: "reassign", owner: "worker",
    });
    expect(assigned.task).toMatchObject({ status: "in_progress", ownerName: "worker" });
  });

  it("delete 墓碑：不占限额、不进 list/视图、get 可读；有依赖者 → HAS_DEPENDENTS 逐字（F25）", async () => {
    const { kit } = await setup();
    const t1 = await createTask(kit, "t1");
    await createTask(kit, "t2", { blockedBy: [t1.id] });
    await expectTeamError(
      kit.runtime.taskboard.update(LEAD, { taskId: t1.id, expectedRevision: 1, action: "delete" }),
      "TEAM_TASK_HAS_DEPENDENTS",
      'team task "task-1" still blocks "task-2"',
    );
    await kit.runtime.taskboard.update(LEAD, { taskId: "task-2", expectedRevision: 1, action: "delete" });
    await kit.runtime.taskboard.update(LEAD, { taskId: t1.id, expectedRevision: 1, action: "delete" });
    expect(kit.runtime.taskboard.list(LEAD).tasks).toHaveLength(0); // 墓碑不进 list
    const got = kit.runtime.taskboard.get(LEAD, t1.id); // get 可读
    expect(got.task.status).toBe("deleted");
    const recreated = await createTask(kit, "t3");
    expect(recreated.id).toBe("task-3"); // 墓碑不占 id 序
  });

  it("视图派生（F26）：ownerName lead 特例 / ready / 警告三形态且不阻断", async () => {
    const { kit } = await setup();
    const a = await kit.runtime.taskboard.create(LEAD, {
      subject: "a", description: "d", writeScopes: ["src"],
    });
    await kit.runtime.taskboard.update(LEAD, { taskId: a.task.id, expectedRevision: 1, action: "claim" });
    expect(a.task.writeScopeWarnings).toEqual([]);
    // lead 持有 → ownerName "lead"
    const leadOwned = kit.runtime.taskboard.get(LEAD, a.task.id);
    expect(leadOwned.task.ownerName).toBe("lead");
    // 三形态警告：相等 / 左含右 / 右含左
    const b = await kit.runtime.taskboard.create(LEAD, {
      subject: "b", description: "d", writeScopes: ["src"],
    });
    const c = await kit.runtime.taskboard.create(LEAD, {
      subject: "c", description: "d", writeScopes: ["src/lib/deep"],
    });
    const d = await kit.runtime.taskboard.create(LEAD, {
      subject: "d", description: "d", writeScopes: ["docs"],
    });
    await kit.runtime.taskboard.update(LEAD, { taskId: b.task.id, expectedRevision: 1, action: "claim" });
    await kit.runtime.taskboard.update(LEAD, { taskId: c.task.id, expectedRevision: 1, action: "claim" });
    await kit.runtime.taskboard.update(LEAD, { taskId: d.task.id, expectedRevision: 1, action: "claim" });
    const viewA = kit.runtime.taskboard.get(LEAD, a.task.id).task;
    expect(viewA.writeScopeWarnings).toEqual(
      expect.arrayContaining([
        "write scopes overlap with task-2",
        "write scopes overlap with task-3",
      ]),
    );
    expect(viewA.writeScopeWarnings).toHaveLength(2); // docs 不重叠；警告不阻断（claim 已成功）
    // ready：pending ∧ 全 blocker completed
    const e = await kit.runtime.taskboard.create(LEAD, {
      subject: "e", description: "d", blockedBy: [a.task.id],
    });
    expect(e.task.ready).toBe(false);
    await kit.runtime.taskboard.update(LEAD, { taskId: a.task.id, expectedRevision: 2, action: "complete" });
    const eAfter = kit.runtime.taskboard.get(LEAD, e.task.id).task;
    expect(eAfter.ready).toBe(true);
  });

  it("list 过滤/分页（F27）：status/owner/unowned/ready；cursor/limit 逐字；nextCursor 仅在有下一页", async () => {
    const { kit, worker } = await setup();
    for (const subject of ["a", "b", "c", "d", "e"]) {
      await createTask(kit, subject);
    }
    await kit.runtime.taskboard.update(worker, { taskId: "task-1", expectedRevision: 1, action: "claim" });
    await kit.runtime.taskboard.update(worker, { taskId: "task-2", expectedRevision: 1, action: "claim" });
    await kit.runtime.taskboard.update(worker, { taskId: "task-2", expectedRevision: 2, action: "complete" });
    const all = kit.runtime.taskboard.list(LEAD, {});
    expect(all.tasks).toHaveLength(5);
    expect(all.nextCursor).toBeUndefined();
    const page1 = kit.runtime.taskboard.list(LEAD, { cursor: 0, limit: 2 });
    expect(page1.tasks.map((t) => t.id)).toEqual(["task-1", "task-2"]);
    expect(page1.nextCursor).toBe(2);
    const page3 = kit.runtime.taskboard.list(LEAD, { cursor: 4, limit: 2 });
    expect(page3.tasks.map((t) => t.id)).toEqual(["task-5"]);
    expect(page3.nextCursor).toBeUndefined();
    expect(kit.runtime.taskboard.list(LEAD, { status: "in_progress" }).tasks).toHaveLength(1);
    expect(kit.runtime.taskboard.list(LEAD, { owner: "worker" }).tasks).toHaveLength(2);
    expect(kit.runtime.taskboard.list(LEAD, { owner: "unowned" }).tasks).toHaveLength(3);
    expect(kit.runtime.taskboard.list(LEAD, { ready: true }).tasks.map((t) => t.id)).toEqual(["task-3", "task-4", "task-5"]);
    try {
      kit.runtime.taskboard.list(LEAD, { cursor: -1 });
      expect.unreachable();
    } catch (err) {
      expect((err as TeamError).message).toBe("cursor must be a non-negative safe integer");
    }
    try {
      kit.runtime.taskboard.list(LEAD, { limit: 101 });
      expect.unreachable();
    } catch (err) {
      expect((err as TeamError).message).toBe("limit must be an integer from 1 through 100");
    }
  });

  it("F23：并发 CAS 双客户端同 revision → 恰一成一败", async () => {
    const { kit, worker } = await setup();
    const t = await createTask(kit);
    const results = await Promise.allSettled([
      kit.runtime.taskboard.update(LEAD, { taskId: t.id, expectedRevision: 1, action: "claim" }),
      kit.runtime.taskboard.update(worker, { taskId: t.id, expectedRevision: 1, action: "claim" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "TEAM_TASK_STALE_REVISION" });
    expect(kit.runtime.taskboard.get(LEAD, t.id).task.revision).toBe(2);
  });
});

// 〔stage-6.5 R1 修复，2026-10-24〕reopen 合并 description（D27 "reopen with concrete findings" 落地）。
describe("TaskBoard · reopen 携带 findings（R1）", () => {
  async function setupTwo() {
    const kit = buildKit();
    await kit.runtime.roster.spawnTeammate(LEAD, { name: "worker-a", description: "d", prompt: "p" });
    await kit.runtime.roster.spawnTeammate(LEAD, { name: "worker-b", description: "d", prompt: "p" });
    const ids = [...kit.provider.teamChildren.keys()];
    return { kit, workerA: ids[0] as string, workerB: ids[1] as string };
  }

  it("Lead（非 owner）reopen 带 findings：description 合并、revision+1、owner 清除", async () => {
    const { kit, workerA } = await setupTwo();
    const t = await createTask(kit, "验收任务", {});
    await kit.runtime.taskboard.update(workerA, { taskId: t.id, expectedRevision: 1, action: "claim" });
    await kit.runtime.taskboard.update(workerA, { taskId: t.id, expectedRevision: 2, action: "complete" });
    // Lead 不是 owner，但 authorizeOwner 允许 Lead —— 带具体问题打回
    const reopened = await kit.runtime.taskboard.update(LEAD, {
      taskId: t.id,
      expectedRevision: 3,
      action: "reopen",
      description: "REOPEN: node --test 1 failed; missing // audit-ok header in string-util.js",
    });
    expect(reopened.task).toMatchObject({
      status: "pending",
      revision: 4,
      description: "REOPEN: node --test 1 failed; missing // audit-ok header in string-util.js",
    });
    expect("ownerName" in reopened.task).toBe(false);
  });

  it("reopen 不带 description：描述保持不变（向后兼容）", async () => {
    const { kit, workerA } = await setupTwo();
    const t = await createTask(kit, "保持描述");
    await kit.runtime.taskboard.update(workerA, { taskId: t.id, expectedRevision: 1, action: "claim" });
    await kit.runtime.taskboard.update(workerA, { taskId: t.id, expectedRevision: 2, action: "complete" });
    const reopened = await kit.runtime.taskboard.update(workerA, { taskId: t.id, expectedRevision: 3, action: "reopen" });
    expect(reopened.task.description).toBe("d");
    expect(reopened.task.revision).toBe(4);
  });

  it("reopen 非法 description（空串/超限）→ TEAM_INVALID_ARGUMENT 逐字", async () => {
    const { kit, workerA } = await setupTwo();
    const t = await createTask(kit, "非法参数");
    await kit.runtime.taskboard.update(workerA, { taskId: t.id, expectedRevision: 1, action: "claim" });
    await kit.runtime.taskboard.update(workerA, { taskId: t.id, expectedRevision: 2, action: "complete" });
    await expectTeamError(
      kit.runtime.taskboard.update(LEAD, { taskId: t.id, expectedRevision: 3, action: "reopen", description: "  " }),
      "TEAM_INVALID_ARGUMENT",
      "description must be non-empty",
    );
    await expectTeamError(
      kit.runtime.taskboard.update(LEAD, { taskId: t.id, expectedRevision: 3, action: "reopen", description: "x".repeat(16385) }),
      "TEAM_INVALID_ARGUMENT",
      "description exceeds 16384 characters",
    );
  });

  it("确定性验收链路：完成 → Lead 打回带 findings → 改派 → 再完成（description 全程保留 findings）", async () => {
    const { kit, workerA, workerB } = await setupTwo();
    const t = await createTask(kit, "链路任务", {});
    // 事件序采集（onCommit 逐提交采状态；create 的 pending 在监听注册前，不采集）
    const statusesBySeq: string[] = [];
    const off = kit.store.onCommit((_seq, state) => {
      const snap = state.tasks.find((x) => x.id === t.id);
      if (snap) statusesBySeq.push(snap.status);
    });
    // A 认领并完成（首次提交）
    await kit.runtime.taskboard.update(workerA, { taskId: t.id, expectedRevision: 1, action: "claim" });
    await kit.runtime.taskboard.update(workerA, { taskId: t.id, expectedRevision: 2, action: "complete" });
    // Lead 复核打回（带问题；Lead 非 owner 但 authorizeOwner 放行）
    const reopened = await kit.runtime.taskboard.update(LEAD, {
      taskId: t.id,
      expectedRevision: 3,
      action: "reopen",
      description: "REOPEN: audit-ok header missing",
    });
    expect(reopened.task.status).toBe("pending");
    expect("ownerName" in reopened.task).toBe(false);
    // Lead 改派给 B
    const reassigned = await kit.runtime.taskboard.update(LEAD, {
      taskId: t.id,
      expectedRevision: 4,
      action: "reassign",
      owner: "worker-b",
    });
    expect(reassigned.task).toMatchObject({ status: "in_progress", ownerName: "worker-b" });
    expect(reassigned.task.description).toBe("REOPEN: audit-ok header missing");
    // B 修复后再次完成
    const redone = await kit.runtime.taskboard.update(workerB, { taskId: t.id, expectedRevision: 5, action: "complete" });
    expect(redone.task).toMatchObject({
      status: "completed",
      ownerName: "worker-b",
      revision: 6,
      description: "REOPEN: audit-ok header missing",
    });
    off();
    // 事件序断言：in_progress → completed → pending(打回) → in_progress → completed
    expect(statusesBySeq).toEqual(["in_progress", "completed", "pending", "in_progress", "completed"]);
  });
});
