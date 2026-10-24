// 任务视图派生（02 规格 §7.5 / §9.4 TASK_VIEW；F26 前置）。

import type { TeamState } from "./projection.js";
import type { TeamTaskSnapshot, TeamTaskStatus } from "./events.js";

/** TASK_VIEW（02 §9.4 逐字段；ownerName 可缺省，ready/writeScopeWarnings 必填）。 */
export interface TeamTaskView {
  id: string;
  revision: number;
  subject: string;
  description: string;
  status: TeamTaskStatus;
  ownerName?: string;
  blockedBy: string[];
  writeScopes: string[];
  ready: boolean;
  writeScopeWarnings: string[];
}

/** taskReady：所有 blocker 均 completed（缺失 blocker 视为未完成）。 */
export function taskReady(state: TeamState, task: TeamTaskSnapshot): boolean {
  return task.blockedBy.every((bid) => {
    const blocker = state.tasks.find((t) => t.id === bid);
    return blocker !== undefined && blocker.status === "completed";
  });
}

/**
 * projectTaskView（02 §7.5）：
 *  - ownerName：ownerId === teamId → "lead"，否则查成员名，查不到则缺省；
 *  - ready：仅 pending 且全部 blocker completed 时 true；
 *  - blockedBy/writeScopes 复制（不共享内部数组引用）。
 */
export function projectTaskView(state: TeamState, task: TeamTaskSnapshot): TeamTaskView {
  const view: TeamTaskView = {
    id: task.id,
    revision: task.revision,
    subject: task.subject,
    description: task.description,
    status: task.status,
    blockedBy: [...task.blockedBy],
    writeScopes: [...task.writeScopes],
    ready: task.status === "pending" && taskReady(state, task),
    writeScopeWarnings: writeScopeWarnings(state, task),
  };
  if (task.ownerId !== undefined) {
    const ownerName =
      task.ownerId === state.id
        ? "lead"
        : state.members.find((m) => m.id === task.ownerId)?.name;
    if (ownerName !== undefined) view.ownerName = ownerName;
  }
  return view;
}

/**
 * 写域警告（02 §7.5）：仅当主体任务自身 in_progress 时生成——对每个**其他** in_progress 任务，
 * 双方 writeScopes 任一对前缀重叠（left===right || left.startsWith(right+"/") ||
 * right.startsWith(left+"/")）→ 一条 `write scopes overlap with <otherId>`（Set 去重）。
 * 双方均为 in_progress 故告警天然对称成对；警告永不阻断操作。
 */
export function writeScopeWarnings(state: TeamState, task: TeamTaskSnapshot): string[] {
  if (task.status !== "in_progress") return [];
  const warnings = new Set<string>();
  for (const other of state.tasks) {
    if (other.id === task.id || other.status !== "in_progress") continue;
    if (scopesOverlap(task.writeScopes, other.writeScopes)) {
      warnings.add(`write scopes overlap with ${other.id}`);
    }
  }
  return [...warnings];
}

function scopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  for (const l of left) {
    for (const r of right) {
      if (l === r || l.startsWith(r + "/") || r.startsWith(l + "/")) return true;
    }
  }
  return false;
}
