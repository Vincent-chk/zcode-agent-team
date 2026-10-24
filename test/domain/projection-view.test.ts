// F06：视图缓存（mailbox-only 不发新视图）+ §3.3 客户端投影视图形状。
import { describe, expect, it } from "vitest";
import {
  applyCurrentTeamEvent,
  emptyTeamState,
  teamProjectionView,
  TEAM_PROJECTION_KEY,
  TEAM_PROJECTION_STATE_VERSION,
} from "../../src/domain/projection.js";
import { deliveredEvent, memberEvent, queuedEvent, taskEvent, TEAM_ID } from "./helpers.js";

describe("projection · 视图缓存引用语义（F06）", () => {
  it("mailbox-only（queued/delivered）变化：视图引用不变（不发帧）", () => {
    // F06
    let state = emptyTeamState(TEAM_ID);
    state = applyCurrentTeamEvent(state, memberEvent({ id: "a1", name: "worker", phase: "provisioning" }));
    const view1 = teamProjectionView(state);

    const afterQueued = applyCurrentTeamEvent(state, queuedEvent({ id: "m1", targetId: "a1" }));
    expect(afterQueued.messages).not.toBe(state.messages); // mailbox 确实更新了
    expect(afterQueued.members).toBe(state.members); // members/tasks 引用不变
    expect(afterQueued.tasks).toBe(state.tasks);
    expect(teamProjectionView(afterQueued)).toBe(view1); // 关键断言：同一视图对象

    const afterDelivered = applyCurrentTeamEvent(afterQueued, deliveredEvent("m1", "a1"));
    expect(teamProjectionView(afterDelivered)).toBe(view1);
  });

  it("members 变化才产生新视图对象（引用级缓存键）", () => {
    // F06
    let state = emptyTeamState(TEAM_ID);
    state = applyCurrentTeamEvent(state, memberEvent({ id: "a1", name: "worker", phase: "provisioning" }));
    const view1 = teamProjectionView(state);
    state = applyCurrentTeamEvent(state, memberEvent({ id: "a1", name: "worker", phase: "active" }));
    const view2 = teamProjectionView(state);
    expect(view2).not.toBe(view1);
    expect(view2.members).not.toBe(view1.members);
    // 缓存键未变的复核：同一状态重复取视图，引用稳定
    expect(teamProjectionView(state)).toBe(view2);
  });

  it("tasks 变化产生新视图；同状态重复取引用稳定", () => {
    // F06
    let state = emptyTeamState(TEAM_ID);
    state = applyCurrentTeamEvent(state, memberEvent({ id: "a1", name: "worker", phase: "provisioning" }));
    const view1 = teamProjectionView(state);
    state = applyCurrentTeamEvent(state, taskEvent({ id: "task-1", revision: 1 }));
    const view2 = teamProjectionView(state);
    expect(view2).not.toBe(view1);
    expect(view2.tasks).toHaveLength(1);
    expect(teamProjectionView(state)).toBe(view2);
  });

  it("健康视图无 failure 键", () => {
    // F06 / §3.3
    const state = emptyTeamState(TEAM_ID);
    const view = teamProjectionView(state);
    expect(Object.keys(view).sort()).toEqual(["members", "tasks"]);
  });
});

describe("projection · §3.3 视图形状", () => {
  it("Lead 伪行恒为首行：{ id: teamId, name: \"lead\", role: \"lead\", phase: \"active\" }；成员按创建序", () => {
    // F06 / §3.3
    let state = emptyTeamState(TEAM_ID);
    state = applyCurrentTeamEvent(state, memberEvent({ id: "a1", name: "first", phase: "provisioning" }));
    state = applyCurrentTeamEvent(state, memberEvent({ id: "a1", name: "first", phase: "active" }));
    state = applyCurrentTeamEvent(state, memberEvent({ id: "a2", name: "second", phase: "provisioning" }));
    state = applyCurrentTeamEvent(state, memberEvent({ id: "a2", name: "second", phase: "failed", error: "boom" }));
    const view = teamProjectionView(state);
    expect(view.members).toHaveLength(3);
    expect(view.members[0]).toEqual({ id: TEAM_ID, name: "lead", role: "lead", phase: "active" });
    expect(view.members[1]).toEqual({ id: "a1", name: "first", role: "teammate", phase: "active" });
    expect(view.members[2]).toEqual({ id: "a2", name: "second", role: "teammate", phase: "failed", error: "boom" });
  });

  it("tasks = 非 deleted 任务的视图；deleted 墓碑不进视图", () => {
    // F06 / §3.3
    let state = emptyTeamState(TEAM_ID);
    state = applyCurrentTeamEvent(state, taskEvent({ id: "task-1", revision: 1 }));
    state = applyCurrentTeamEvent(state, taskEvent({ id: "task-2", revision: 1 }));
    state = applyCurrentTeamEvent(state, taskEvent({ id: "task-2", revision: 2, status: "deleted" }));
    const view = teamProjectionView(state);
    expect(view.tasks).toHaveLength(1);
    expect(view.tasks[0].id).toBe("task-1");
  });

  it("投影键与状态版本常量（wire 标识）", () => {
    expect(TEAM_PROJECTION_KEY).toBe("agentTeam");
    expect(TEAM_PROJECTION_STATE_VERSION).toBe(4);
  });
});
