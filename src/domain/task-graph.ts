// 任务依赖图校验（02 规格 §7.4；F03 图校验 / F26 前置）。
// 两套口径：
//  - validateTaskGraph：重放/候选替换后的**全图**校验，非法抛 Error（消息逐字），由投影捕获为 failure 终态；
//  - dependencies：create/set_dependencies 的**入参**校验，非法抛 TeamError（code 映射见 §7.4）。

import { TeamError } from "./errors.js";
import type { TeamTaskSnapshot } from "./events.js";

/**
 * 全图校验（对「现有任务 + 候选替换」整体执行）。检查顺序（规格 §7.4）：自依赖 → 重复 → 缺失/已删 → DFS 环。
 * 消息逐字：
 *  - `team task "<id>" cannot block itself`
 *  - `team task "<id>" repeats blocker "<bid>"`
 *  - `blocker task "<bid>" for "<id>" is missing or deleted`
 *  - `task dependency cycle includes "<id>"`
 */
export function validateTaskGraph(tasks: readonly TeamTaskSnapshot[]): void {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const live = tasks.filter((t) => t.status !== "deleted");

  for (const task of live) {
    for (const bid of task.blockedBy) {
      if (bid === task.id) {
        throw new Error(`team task "${task.id}" cannot block itself`);
      }
    }
  }
  for (const task of live) {
    const seen = new Set<string>();
    for (const bid of task.blockedBy) {
      if (seen.has(bid)) {
        throw new Error(`team task "${task.id}" repeats blocker "${bid}"`);
      }
      seen.add(bid);
    }
  }
  for (const task of live) {
    for (const bid of task.blockedBy) {
      const blocker = byId.get(bid);
      if (blocker === undefined || blocker.status === "deleted") {
        throw new Error(`blocker task "${bid}" for "${task.id}" is missing or deleted`);
      }
    }
  }

  detectCycle(live, byId);
}

/** DFS 检环（仅 non-deleted 参与邻接；deleted blocker 已被 missing 检查拦截）。命中灰色邻点即报该点。 */
function detectCycle(live: readonly TeamTaskSnapshot[], byId: ReadonlyMap<string, TeamTaskSnapshot>): void {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const visit = (task: TeamTaskSnapshot): void => {
    color.set(task.id, GRAY);
    for (const bid of task.blockedBy) {
      const blocker = byId.get(bid);
      if (blocker === undefined || blocker.status === "deleted") continue;
      const c = color.get(bid) ?? WHITE;
      if (c === GRAY) {
        throw new Error(`task dependency cycle includes "${bid}"`);
      }
      if (c === WHITE) visit(blocker);
    }
    color.set(task.id, BLACK);
  };
  for (const task of live) {
    if ((color.get(task.id) ?? WHITE) === WHITE) visit(task);
  }
}

/**
 * 候选全图校验（create/update 的 append 前路径）：把全图校验的普通 Error 映射为 27 码，
 * 保证间接依赖环也以 `TEAM_TASK_DEPENDENCY_CYCLE` 返回，而不是 journal violation。
 */
export function assertTaskGraphCandidate(
  existing: readonly TeamTaskSnapshot[],
  candidate: TeamTaskSnapshot,
): void {
  const tasks = existing.some((t) => t.id === candidate.id)
    ? existing.map((t) => (t.id === candidate.id ? candidate : t))
    : [...existing, candidate];
  try {
    validateTaskGraph(tasks);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("cannot block itself") || message.includes("task dependency cycle")) {
      throw new TeamError("TEAM_TASK_DEPENDENCY_CYCLE", message);
    }
    if (message.includes("repeats blocker")) {
      throw new TeamError("TEAM_INVALID_ARGUMENT", message);
    }
    if (message.includes("missing or deleted")) {
      throw new TeamError("TEAM_TASK_NOT_FOUND", message);
    }
    throw err;
  }
}

/**
 * create/set_dependencies 的入参校验（02 §7.4 `dependencies()`）：
 *  - 自阻塞 → TEAM_TASK_DEPENDENCY_CYCLE `a team task cannot block itself`
 *  - 重复 → TEAM_INVALID_ARGUMENT `duplicate blocker "<id>"`
 *  - 不存在/已删 → TEAM_TASK_NOT_FOUND `blocker task "<id>" not found`
 */
export function dependencies(
  existingTasks: readonly TeamTaskSnapshot[],
  taskId: string,
  blockedBy: readonly string[],
): void {
  const seen = new Set<string>();
  for (const bid of blockedBy) {
    if (bid === taskId) {
      throw new TeamError("TEAM_TASK_DEPENDENCY_CYCLE", "a team task cannot block itself", {
        cause: { taskId, blocker: bid },
      });
    }
    if (seen.has(bid)) {
      throw new TeamError("TEAM_INVALID_ARGUMENT", `duplicate blocker "${bid}"`, {
        cause: { taskId, blocker: bid },
      });
    }
    seen.add(bid);
    const blocker = existingTasks.find((t) => t.id === bid);
    if (blocker === undefined || blocker.status === "deleted") {
      throw new TeamError("TEAM_TASK_NOT_FOUND", `blocker task "${bid}" not found`, {
        cause: { taskId, blocker: bid },
      });
    }
  }
}
