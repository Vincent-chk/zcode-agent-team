// F03：task 重放（revision 连续 / nextTaskNumber 推进与封顶 / 候选全图校验 4 类，消息逐字）。
import { describe, expect, it } from "vitest";
import { applyCurrentTeamEvent, buildTeamProjection, emptyTeamState } from "../../src/domain/projection.js";
import { taskEvent, memberEvent, TEAM_ID } from "./helpers.js";

describe("projection · task revision 连续性（F03）", () => {
  it("新任务 revision 必须 1 起步", () => {
    // F03
    const state = emptyTeamState(TEAM_ID);
    const next = applyCurrentTeamEvent(state, taskEvent({ id: "task-1", revision: 2 }));
    expect(next.failure).toBe('team task "task-1" must begin at revision 1');
  });

  it("既有任务必须 prior.revision + 1 严格连续", () => {
    // F03
    let state = emptyTeamState(TEAM_ID);
    state = applyCurrentTeamEvent(state, taskEvent({ id: "task-1", revision: 1 }));
    expect(state.failure).toBeUndefined();
    const skip = applyCurrentTeamEvent(state, taskEvent({ id: "task-1", revision: 3 }));
    expect(skip.failure).toBe('team task "task-1" revision is not contiguous');
    const repeat = applyCurrentTeamEvent(state, taskEvent({ id: "task-1", revision: 1 }));
    expect(repeat.failure).toBe('team task "task-1" revision is not contiguous');
    const ok = applyCurrentTeamEvent(state, taskEvent({ id: "task-1", revision: 2, status: "in_progress" }));
    expect(ok.failure).toBeUndefined();
    expect(ok.tasks[0].revision).toBe(2);
  });
});

describe("projection · nextTaskNumber 推进与封顶（F03）", () => {
  it("task-<n> 事件推进 nextTaskNumber = max(cur, n+1)", () => {
    // F03
    let state = emptyTeamState(TEAM_ID);
    state = applyCurrentTeamEvent(state, taskEvent({ id: "task-7", revision: 1 }));
    expect(state.nextTaskNumber).toBe(8);
    // 乱序低号不回退
    state = applyCurrentTeamEvent(state, taskEvent({ id: "task-2", revision: 1 }));
    expect(state.nextTaskNumber).toBe(8);
    // revision 2 的同任务不重复推进（n 相同）
    state = applyCurrentTeamEvent(state, taskEvent({ id: "task-2", revision: 2 }));
    expect(state.nextTaskNumber).toBe(8);
  });

  it("非常规 id（不匹配 task-<n>）不推进 nextTaskNumber，但可重放（B4 宽松口径）", () => {
    // F03 / F07b
    let state = emptyTeamState(TEAM_ID);
    state = applyCurrentTeamEvent(state, taskEvent({ id: "sprint-3-final", revision: 1 }));
    expect(state.failure).toBeUndefined();
    expect(state.tasks).toHaveLength(1);
    expect(state.nextTaskNumber).toBe(1);
  });

  it("MAX_SAFE_INTEGER 封顶（task-9007199254740991 后不再 +1 溢出）", () => {
    // F03
    const state = emptyTeamState(TEAM_ID);
    const next = applyCurrentTeamEvent(
      state,
      taskEvent({ id: `task-${Number.MAX_SAFE_INTEGER}`, revision: 1 }),
    );
    expect(next.failure).toBeUndefined();
    expect(next.nextTaskNumber).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("projection · 候选全图校验 4 类（F03，消息逐字）", () => {
  it("自依赖 → `team task \"<id>\" cannot block itself`", () => {
    // F03
    const next = applyCurrentTeamEvent(
      emptyTeamState(TEAM_ID),
      taskEvent({ id: "task-1", revision: 1, blockedBy: ["task-1"] }),
    );
    expect(next.failure).toBe('team task "task-1" cannot block itself');
  });

  it("重复依赖 → `team task \"<id>\" repeats blocker \"<bid>\"`", () => {
    // F03
    const next = applyCurrentTeamEvent(
      emptyTeamState(TEAM_ID),
      taskEvent({ id: "task-3", revision: 1, blockedBy: ["task-1", "task-1"] }),
    );
    expect(next.failure).toBe('team task "task-3" repeats blocker "task-1"');
  });

  it("缺失依赖 → `blocker task \"<bid>\" for \"<id>\" is missing or deleted`", () => {
    // F03
    const next = applyCurrentTeamEvent(
      emptyTeamState(TEAM_ID),
      taskEvent({ id: "task-2", revision: 1, blockedBy: ["task-999"] }),
    );
    expect(next.failure).toBe('blocker task "task-999" for "task-2" is missing or deleted');
  });

  it("已删依赖同样按 missing/deleted 拒绝", () => {
    // F03
    let state = emptyTeamState(TEAM_ID);
    state = applyCurrentTeamEvent(state, taskEvent({ id: "task-1", revision: 1 }));
    state = applyCurrentTeamEvent(state, taskEvent({ id: "task-1", revision: 2, status: "deleted" }));
    expect(state.failure).toBeUndefined();
    const next = applyCurrentTeamEvent(
      state,
      taskEvent({ id: "task-2", revision: 1, blockedBy: ["task-1"] }),
    );
    expect(next.failure).toBe('blocker task "task-1" for "task-2" is missing or deleted');
  });

  it("两节点环 → `task dependency cycle includes \"<id>\"`", () => {
    // F03
    let state = emptyTeamState(TEAM_ID);
    state = applyCurrentTeamEvent(state, taskEvent({ id: "task-1", revision: 1 }));
    state = applyCurrentTeamEvent(state, taskEvent({ id: "task-2", revision: 1, blockedBy: ["task-1"] }));
    expect(state.failure).toBeUndefined();
    const next = applyCurrentTeamEvent(
      state,
      taskEvent({ id: "task-1", revision: 2, blockedBy: ["task-2"] }),
    );
    expect(next.failure).toBe('task dependency cycle includes "task-1"');
  });

  it("三节点环与自环升级（revision 2 自依赖）同样拒绝", () => {
    // F03
    let state = emptyTeamState(TEAM_ID);
    state = applyCurrentTeamEvent(state, taskEvent({ id: "task-1", revision: 1 }));
    state = applyCurrentTeamEvent(state, taskEvent({ id: "task-2", revision: 1, blockedBy: ["task-1"] }));
    state = applyCurrentTeamEvent(state, taskEvent({ id: "task-3", revision: 1, blockedBy: ["task-2"] }));
    const next = applyCurrentTeamEvent(
      state,
      taskEvent({ id: "task-1", revision: 2, blockedBy: ["task-3"] }),
    );
    expect(next.failure).toBe('task dependency cycle includes "task-1"');
  });

  it("合法依赖链与 completed blocker 正常推进", () => {
    // F03
    let state = emptyTeamState(TEAM_ID);
    state = applyCurrentTeamEvent(state, taskEvent({ id: "task-1", revision: 1 }));
    state = applyCurrentTeamEvent(state, taskEvent({ id: "task-1", revision: 2, status: "completed" }));
    state = applyCurrentTeamEvent(
      state,
      taskEvent({ id: "task-2", revision: 1, blockedBy: ["task-1"] }),
    );
    expect(state.failure).toBeUndefined();
    expect(state.tasks).toHaveLength(2);
    expect(state.nextTaskNumber).toBe(3);
  });
});

describe("projection · buildTeamProjection 全量重放（F03 综合）", () => {
  it("成员 + 任务 + 依赖完整剧本重放一致且确定", () => {
    // F03
    const events = [
      memberEvent({ id: "a1", name: "worker", phase: "provisioning" }),
      memberEvent({ id: "a1", name: "worker", phase: "active" }),
      taskEvent({ id: "task-1", revision: 1, ownerId: "a1" }),
      taskEvent({ id: "task-2", revision: 1, blockedBy: ["task-1"] }),
      taskEvent({ id: "task-1", revision: 2, status: "completed", ownerId: "a1" }),
    ];
    const once = buildTeamProjection(events, TEAM_ID);
    const twice = buildTeamProjection(events, TEAM_ID);
    expect(once).toEqual(twice);
    expect(once.failure).toBeUndefined();
    expect(once.members).toHaveLength(1);
    expect(once.tasks).toHaveLength(2);
    expect(once.tasks[0].status).toBe("completed");
    expect(once.nextTaskNumber).toBe(3);
  });
});
