// F03（图校验 4 类，直接对全图函数断言）+ §7.4 dependencies() 入参校验（TeamError 映射）。
import { describe, expect, it } from "vitest";
import { dependencies, validateTaskGraph } from "../../src/domain/task-graph.js";
import { TeamError } from "../../src/domain/errors.js";
import { taskSnapshot } from "./helpers.js";

describe("task-graph · validateTaskGraph 全图 4 类（F03）", () => {
  it("空图与无依赖图通过", () => {
    expect(() => validateTaskGraph([])).not.toThrow();
    expect(() =>
      validateTaskGraph([taskSnapshot({ id: "task-1" }), taskSnapshot({ id: "task-2" })]),
    ).not.toThrow();
  });

  it("自依赖 → `team task \"<id>\" cannot block itself`", () => {
    // F03
    expect(() =>
      validateTaskGraph([taskSnapshot({ id: "task-1", blockedBy: ["task-1"] })]),
    ).toThrowError('team task "task-1" cannot block itself');
  });

  it("重复依赖 → `team task \"<id>\" repeats blocker \"<bid>\"`", () => {
    // F03
    expect(() =>
      validateTaskGraph([
        taskSnapshot({ id: "task-1" }),
        taskSnapshot({ id: "task-3", blockedBy: ["task-1", "task-1"] }),
      ]),
    ).toThrowError('team task "task-3" repeats blocker "task-1"');
  });

  it("缺失依赖 → `blocker task \"<bid>\" for \"<id>\" is missing or deleted`", () => {
    // F03
    expect(() =>
      validateTaskGraph([taskSnapshot({ id: "task-2", blockedBy: ["task-404"] })]),
    ).toThrowError('blocker task "task-404" for "task-2" is missing or deleted');
  });

  it("已删依赖按 missing or deleted 拒绝（deleted 墓碑不作 blocker）", () => {
    // F03
    expect(() =>
      validateTaskGraph([
        taskSnapshot({ id: "task-1", status: "deleted" }),
        taskSnapshot({ id: "task-2", blockedBy: ["task-1"] }),
      ]),
    ).toThrowError('blocker task "task-1" for "task-2" is missing or deleted');
  });

  it("deleted 任务自身的 blockedBy 不参与校验（墓碑可携带旧依赖）", () => {
    expect(() =>
      validateTaskGraph([
        taskSnapshot({ id: "task-1", status: "deleted", blockedBy: ["task-404"] }),
      ]),
    ).not.toThrow();
  });

  it("两节点环 / 三节点环 → `task dependency cycle includes \"<id>\"`", () => {
    // F03
    expect(() =>
      validateTaskGraph([
        taskSnapshot({ id: "task-1", blockedBy: ["task-2"] }),
        taskSnapshot({ id: "task-2", blockedBy: ["task-1"] }),
      ]),
    ).toThrowError('task dependency cycle includes "task-1"');

    expect(() =>
      validateTaskGraph([
        taskSnapshot({ id: "task-1", blockedBy: ["task-2"] }),
        taskSnapshot({ id: "task-2", blockedBy: ["task-3"] }),
        taskSnapshot({ id: "task-3", blockedBy: ["task-1"] }),
      ]),
    ).toThrowError('task dependency cycle includes "task-1"');
  });

  it("completed blocker 与 DAG 通过", () => {
    expect(() =>
      validateTaskGraph([
        taskSnapshot({ id: "task-1", status: "completed" }),
        taskSnapshot({ id: "task-2", blockedBy: ["task-1"] }),
        taskSnapshot({ id: "task-3", blockedBy: ["task-1", "task-2"] }),
      ]),
    ).not.toThrow();
  });
});

describe("task-graph · dependencies 入参校验（§7.4，TeamError 映射）", () => {
  const existing = [
    taskSnapshot({ id: "task-1", status: "completed" }),
    taskSnapshot({ id: "task-2" }),
    taskSnapshot({ id: "task-9", status: "deleted" }),
  ];

  it("合法依赖通过（含 completed blocker）", () => {
    expect(() => dependencies(existing, "task-3", ["task-1", "task-2"])).not.toThrow();
    expect(() => dependencies(existing, "task-3", [])).not.toThrow();
  });

  it("自阻塞 → TEAM_TASK_DEPENDENCY_CYCLE `a team task cannot block itself`", () => {
    // F03 / F26 前置
    expect(() => dependencies(existing, "task-3", ["task-3"])).toThrowError(TeamError);
    try {
      dependencies(existing, "task-3", ["task-3"]);
    } catch (err) {
      expect((err as TeamError).code).toBe("TEAM_TASK_DEPENDENCY_CYCLE");
      expect((err as TeamError).message).toBe("a team task cannot block itself");
    }
  });

  it("重复 → TEAM_INVALID_ARGUMENT `duplicate blocker \"<id>\"`", () => {
    expect(() => dependencies(existing, "task-3", ["task-1", "task-1"])).toThrowError(
      'duplicate blocker "task-1"',
    );
  });

  it("不存在/已删 → TEAM_TASK_NOT_FOUND `blocker task \"<id>\" not found`", () => {
    expect(() => dependencies(existing, "task-3", ["task-404"])).toThrowError(
      'blocker task "task-404" not found',
    );
    expect(() => dependencies(existing, "task-3", ["task-9"])).toThrowError(
      'blocker task "task-9" not found',
    );
  });
});
