// F26 前置：ownerName lead 特例 / ready 判定 / write-scope 前缀重叠三形态警告（不阻断）。
import { describe, expect, it } from "vitest";
import { projectTaskView, taskReady, writeScopeWarnings } from "../../src/domain/task-view.js";
import { applyCurrentTeamEvent, emptyTeamState, type TeamState } from "../../src/domain/projection.js";
import { memberEvent, taskEvent, TEAM_ID } from "./helpers.js";

function stateWith() {
  let state = emptyTeamState(TEAM_ID);
  state = applyCurrentTeamEvent(state, memberEvent({ id: "a1", name: "worker", phase: "provisioning" }));
  state = applyCurrentTeamEvent(state, memberEvent({ id: "a1", name: "worker", phase: "active" }));
  state = applyCurrentTeamEvent(state, taskEvent({ id: "task-1", revision: 1 }));
  state = applyCurrentTeamEvent(state, taskEvent({ id: "task-2", revision: 1 }));
  return state;
}

describe("task-view · projectTaskView（F26 前置）", () => {
  it("ownerName：ownerId===teamId → \"lead\"；成员 → 成员名；无 owner → 缺省", () => {
    // F26
    const state = stateWith();
    const leadOwned = projectTaskView(
      state,
      { ...state.tasks[0], ownerId: TEAM_ID },
    );
    expect(leadOwned.ownerName).toBe("lead");
    const memberOwned = projectTaskView(state, { ...state.tasks[0], ownerId: "a1" });
    expect(memberOwned.ownerName).toBe("worker");
    const unowned = projectTaskView(state, state.tasks[0]);
    expect(unowned.ownerName).toBeUndefined();
    expect("ownerName" in unowned).toBe(false);
  });

  it("TASK_VIEW 逐字段（§9.4）：id/revision/subject/description/status/blockedBy/writeScopes/ready/writeScopeWarnings", () => {
    // F26
    const state = stateWith();
    const task = { ...state.tasks[0], subject: "s", description: "d", blockedBy: ["task-2"], writeScopes: ["src"] };
    const view = projectTaskView(state, task);
    expect(view).toMatchObject({
      id: "task-1",
      revision: 1,
      subject: "s",
      description: "d",
      status: "pending",
      blockedBy: ["task-2"],
      writeScopes: ["src"],
      ready: false, // task-2 未 completed
      writeScopeWarnings: [],
    });
    // blockedBy/writeScopes 是复制，不共享内部引用
    expect(view.blockedBy).not.toBe(task.blockedBy);
    expect(view.writeScopes).not.toBe(task.writeScopes);
  });

  it("ready：仅 pending ∧ 全部 blocker completed 才 true", () => {
    // F26
    let state = emptyTeamState(TEAM_ID);
    state = applyCurrentTeamEvent(state, taskEvent({ id: "task-1", revision: 1 }));
    state = applyCurrentTeamEvent(state, taskEvent({ id: "task-1", revision: 2, status: "completed" }));
    state = applyCurrentTeamEvent(state, taskEvent({ id: "task-2", revision: 1 }));
    state = applyCurrentTeamEvent(state, taskEvent({ id: "task-2", revision: 2, status: "completed" }));
    state = applyCurrentTeamEvent(
      state,
      taskEvent({ id: "task-3", revision: 1, blockedBy: ["task-1", "task-2"] }),
    );
    const t3 = state.tasks.find((t) => t.id === "task-3")!;
    expect(taskReady(state, t3)).toBe(true);
    expect(projectTaskView(state, t3).ready).toBe(true);

    // blocker 未完成
    state = applyCurrentTeamEvent(state, taskEvent({ id: "task-2", revision: 3, status: "pending" }));
    const t3b = state.tasks.find((t) => t.id === "task-3")!;
    expect(taskReady(state, t3b)).toBe(false);
    // 非 pending（in_progress）即使 ready 也不报 ready
    state = applyCurrentTeamEvent(
      state,
      taskEvent({ id: "task-3", revision: 2, status: "in_progress", blockedBy: ["task-1"] }),
    );
    const t3c = state.tasks.find((t) => t.id === "task-3")!;
    expect(projectTaskView(state, t3c).ready).toBe(false);
    // blocker 缺失 → not ready
    const ghost = { ...t3c, blockedBy: ["task-404"], status: "pending" as const };
    expect(taskReady(state, ghost)).toBe(false);
  });
});

describe("task-view · writeScopeWarnings（F26）", () => {
  function inProgressState(scopesByTask: Record<string, string[]>): TeamState {
    let state = emptyTeamState(TEAM_ID);
    for (const id of Object.keys(scopesByTask)) {
      state = applyCurrentTeamEvent(
        state,
        taskEvent({ id, revision: 1, status: "in_progress", writeScopes: scopesByTask[id] }),
      );
    }
    return state;
  }

  it("前缀重叠三形态：相等 / 左含右 / 右含左 → `write scopes overlap with <otherId>`", () => {
    // F26
    const state = inProgressState({
      "task-1": ["src"],
      "task-2": ["src"], // 相等
      "task-3": ["src/lib/deep"], // 右含左（src/lib/deep 以 task-1 的 src/ 开头）
      "task-4": ["docs"],
    });
    const task = state.tasks.find((t) => t.id === "task-1")!;
    const warnings = writeScopeWarnings(state, task);
    expect(warnings).toContain("write scopes overlap with task-2");
    expect(warnings).toContain("write scopes overlap with task-3");
    expect(warnings).not.toContain("write scopes overlap with task-4");
    expect(warnings).toHaveLength(2);
  });

  it("仅对 in_progress 的他任务告警；pending/completed/deleted 他任务不告警；自身不计", () => {
    // F26
    let state = emptyTeamState(TEAM_ID);
    state = applyCurrentTeamEvent(state, taskEvent({ id: "task-1", revision: 1, status: "in_progress", writeScopes: ["src"] }));
    state = applyCurrentTeamEvent(state, taskEvent({ id: "task-2", revision: 1, status: "pending", writeScopes: ["src"] }));
    state = applyCurrentTeamEvent(state, taskEvent({ id: "task-3", revision: 1, status: "completed", writeScopes: ["src"] }));
    const t1 = state.tasks.find((t) => t.id === "task-1")!;
    expect(writeScopeWarnings(state, t1)).toEqual([]);
    // 自身 id 永不出现在自己的警告里
    expect(writeScopeWarnings(state, t1).some((w) => w.includes("task-1"))).toBe(false);
  });

  it("主体非 in_progress（completed/pending）→ 不告警（即使与他任务写域重叠）", () => {
    // 0.1.3 UX 修订：警告仅挂双方 in_progress 的任务对
    for (const status of ["completed", "pending"] as const) {
      let state = emptyTeamState(TEAM_ID);
      state = applyCurrentTeamEvent(
        state,
        taskEvent({ id: "task-1", revision: 1, status, writeScopes: ["src"] }),
      );
      state = applyCurrentTeamEvent(
        state,
        taskEvent({ id: "task-2", revision: 1, status: "in_progress", writeScopes: ["src"] }),
      );
      const t1 = state.tasks.find((t) => t.id === "task-1")!;
      expect(writeScopeWarnings(state, t1)).toEqual([]);
    }
  });

  it("双方均 in_progress 且重叠 → 两张视图对称互相告警", () => {
    const state = inProgressState({ "task-1": ["src"], "task-2": ["src/lib"] });
    const t1 = state.tasks.find((t) => t.id === "task-1")!;
    const t2 = state.tasks.find((t) => t.id === "task-2")!;
    expect(projectTaskView(state, t1).writeScopeWarnings).toEqual(["write scopes overlap with task-2"]);
    expect(projectTaskView(state, t2).writeScopeWarnings).toEqual(["write scopes overlap with task-1"]);
  });

  it("多 scope 对同一任务重叠只告警一次（Set 去重）；警告不阻断 projectTaskView", () => {
    // F26
    const state = inProgressState({
      "task-1": ["src", "src/lib", "docs"],
      "task-2": ["src/a", "docs/api", "other"],
    });
    const t1 = state.tasks.find((t) => t.id === "task-1")!;
    const view = projectTaskView(state, t1);
    expect(view.writeScopeWarnings).toEqual(["write scopes overlap with task-2"]);
    expect(view.id).toBe("task-1"); // 视图照常产出
  });
});
