// TaskBoard 共享任务板（02 规格 §7；F22–F27）。
// 一切校验消息逐字；CAS 状态机；依赖校验复用 round-1 task-graph（dependencies）；追加经 store
// （journal 适配时自动跑全图不变量）。墓碑不占限额、不进 list/视图、get 可读；无自动释放。

import { TeamError } from "./errors.js";
import type { TeamLimits } from "./config.js";
import { requiredText, writeScopes as normalizeWriteScopes } from "./validation.js";
import { assertTaskGraphCandidate, dependencies } from "./task-graph.js";
import { projectTaskView } from "./task-view.js";
import type { TeamTaskView } from "./task-view.js";
import type { TeamTaskSnapshot, TeamTaskStatus } from "./events.js";
import type { TeamState } from "./projection.js";
import { requireMembership } from "./projection.js";
import type { TeamStore } from "./ports.js";
import type { LifecyclePort } from "./lifecycle.js";

export type TaskAction =
  | "claim"
  | "release"
  | "edit"
  | "set_dependencies"
  | "complete"
  | "reopen"
  | "reassign"
  | "delete";

export interface TaskBoardDeps {
  teamId: string;
  store: TeamStore;
  limits: TeamLimits;
  lifecycle: LifecyclePort;
}

export class TeamTaskBoard {
  constructor(private readonly deps: TaskBoardDeps) {}

  // ---------------------------------------------------------------- create（§7.2）

  async create(
    callerId: string,
    args: {
      subject: string;
      description: string;
      blockedBy?: string[];
      writeScopes?: string[];
    },
  ): Promise<{ task: TeamTaskView }> {
    this.requireMember(callerId);
    this.deps.lifecycle.requireOpen();
    const subject = requiredText("subject", args.subject, 200);
    const description = requiredText("description", args.description, 16384);
    const scopes = normalizeWriteScopes(args.writeScopes ?? []);
    return this.deps.store.transact(async () => {
      const state = this.loadState();
      const id = `task-${state.nextTaskNumber}`;
      if (
        state.nextTaskNumber > Number.MAX_SAFE_INTEGER ||
        state.tasks.some((t) => t.id === id)
      ) {
        throw new TeamError("TEAM_TASK_LIMIT", "Team task id space exhausted");
      }
      const liveCount = state.tasks.filter((t) => t.status !== "deleted").length;
      if (liveCount >= this.deps.limits.maxTasks) {
        throw new TeamError("TEAM_TASK_LIMIT", `Team task limit ${this.deps.limits.maxTasks} reached`);
      }
      dependencies(state.tasks, id, args.blockedBy ?? []); // 逐字错误（task-graph round-1）
      const task: TeamTaskSnapshot = {
        id,
        revision: 1,
        subject,
        description,
        status: "pending",
        blockedBy: [...(args.blockedBy ?? [])],
        writeScopes: scopes,
      };
      assertTaskGraphCandidate(state.tasks, task); // 全图校验（append 前；错误码映射见 task-graph）
      const { state: next } = await this.deps.store.append({
        type: "team/task",
        version: 2,
        teamId: this.deps.teamId,
        task,
      });
      return { task: projectTaskView(next, next.tasks.find((t) => t.id === id) as TeamTaskSnapshot) };
    });
  }

  // ---------------------------------------------------------------- update（§7.3）

  async update(
    callerId: string,
    args: {
      taskId: string;
      expectedRevision: number;
      action: TaskAction;
      subject?: string;
      description?: string;
      blockedBy?: string[];
      writeScopes?: string[];
      owner?: string;
    },
  ): Promise<{ task: TeamTaskView }> {
    this.requireMember(callerId);
    this.deps.lifecycle.requireOpen();
    return this.deps.store.transact(async () => {
      const state = this.loadState();
      const current = state.tasks.find((t) => t.id === args.taskId);
      if (current === undefined) {
        throw new TeamError("TEAM_TASK_NOT_FOUND", `team task "${args.taskId}" not found`);
      }
      if (current.revision !== args.expectedRevision) {
        throw new TeamError(
          "TEAM_TASK_STALE_REVISION",
          `stale team task "${args.taskId}" revision ${args.expectedRevision}; current revision is ${current.revision}`,
        );
      }
      if (current.status === "deleted") {
        throw new TeamError("TEAM_TASK_DELETED", `team task "${args.taskId}" is deleted`);
      }
      const isLead = callerId === state.id;
      const isOwner = current.ownerId === callerId;
      const next = this.applyAction(state, current, callerId, isLead, isOwner, args);
      assertTaskGraphCandidate(state.tasks, next); // CAS 候选全图校验（含间接环的错误码映射）
      const { state: nextState } = await this.deps.store.append({
        type: "team/task",
        version: 2,
        teamId: this.deps.teamId,
        task: next,
      });
      return {
        task: projectTaskView(nextState, nextState.tasks.find((t) => t.id === args.taskId) as TeamTaskSnapshot),
      };
    });
  }

  private applyAction(
    state: TeamState,
    current: TeamTaskSnapshot,
    callerId: string,
    isLead: boolean,
    isOwner: boolean,
    args: Parameters<TeamTaskBoard["update"]>[1],
  ): TeamTaskSnapshot {
    const authorizeOwner = (): void => {
      if (!(isLead || isOwner)) {
        throw new TeamError("TEAM_TASK_UNAUTHORIZED", "task mutation requires its owner or Team Lead");
      }
    };
    const ready = projectTaskView(state, current).ready;
    const bump = (patch: Partial<TeamTaskSnapshot>): TeamTaskSnapshot => ({
      ...current,
      ...patch,
      revision: current.revision + 1,
    });

    switch (args.action) {
      case "claim": {
        if (current.ownerId !== undefined && current.ownerId !== callerId) {
          throw new TeamError(
            "TEAM_TASK_ALREADY_CLAIMED",
            `team task "${current.id}" is owned by another member`,
          );
        }
        if (current.status !== "pending" || !ready) {
          throw new TeamError("TEAM_TASK_BLOCKED", `team task "${current.id}" is not ready to claim`);
        }
        return bump({ status: "in_progress", ownerId: callerId });
      }
      case "release": {
        authorizeOwner();
        if (current.status !== "in_progress") {
          throw new TeamError("TEAM_TASK_INVALID_TRANSITION", "only an in-progress task can be released");
        }
        return stripOwner(bump({ status: "pending" })); // pending 且去 owner
      }
      case "edit": {
        authorizeOwner();
        const hasAny =
          args.subject !== undefined || args.description !== undefined || args.writeScopes !== undefined;
        if (!hasAny) {
          throw new TeamError(
            "TEAM_INVALID_ARGUMENT",
            "task edit requires subject, description, or write_scopes",
          );
        }
        return bump({
          ...(args.subject !== undefined ? { subject: requiredText("subject", args.subject, 200) } : {}),
          ...(args.description !== undefined
            ? { description: requiredText("description", args.description, 16384) }
            : {}),
          ...(args.writeScopes !== undefined
            ? { writeScopes: normalizeWriteScopes(args.writeScopes) }
            : {}),
        });
      }
      case "set_dependencies": {
        authorizeOwner();
        if (args.blockedBy === undefined) {
          throw new TeamError("TEAM_INVALID_ARGUMENT", "set_dependencies requires blocked_by");
        }
        dependencies(state.tasks, current.id, args.blockedBy);
        return bump({ blockedBy: [...args.blockedBy] });
      }
      case "complete": {
        authorizeOwner();
        if (current.status !== "in_progress") {
          throw new TeamError("TEAM_TASK_INVALID_TRANSITION", "only an in-progress task can complete");
        }
        return bump({ status: "completed" }); // owner 保留
      }
      case "reopen": {
        authorizeOwner();
        if (current.status !== "completed") {
          throw new TeamError("TEAM_TASK_INVALID_TRANSITION", "only a completed task can reopen");
        }
        // D27：reopen 携带的具体问题（concrete findings）合并进 description（与 edit 同校验；
        // 2026-10-24 修复——此前参数被透传但丢弃，"reopen with concrete findings" 语义落空）。
        return stripOwner(
          bump({
            status: "pending",
            ...(args.description !== undefined
              ? { description: requiredText("description", args.description, 16384) }
              : {}),
          }),
        ); // pending 且去 owner
      }
      case "reassign": {
        if (!isLead) {
          // 消息文本 02 §7.3 未给出——按既立句式推断，见交付「新冲突清单」待裁决
          throw new TeamError("TEAM_LEAD_REQUIRED", "only the Team Lead can reassign tasks");
        }
        if (current.status !== "pending" && current.status !== "in_progress") {
          throw new TeamError(
            "TEAM_TASK_INVALID_TRANSITION",
            "only a pending or in-progress task can be reassigned",
          );
        }
        const rawOwner = (args.owner ?? "").trim();
        if (rawOwner.length === 0) {
          return stripOwner(bump({ status: "pending" })); // 空/空白 → 去 owner 且 pending
        }
        if (!ready) {
          throw new TeamError("TEAM_TASK_BLOCKED", `team task "${current.id}" is blocked`);
        }
        const target =
          rawOwner === "lead"
            ? { id: state.id, name: "lead" }
            : state.members.find((m) => m.name === rawOwner && m.phase === "active");
        if (target === undefined) {
          throw new TeamError("TEAM_MEMBER_NOT_FOUND", `active teammate "${rawOwner}" not found`);
        }
        return bump({ status: "in_progress", ownerId: target.id });
      }
      case "delete": {
        authorizeOwner();
        const dependent = state.tasks.find(
          (t) => t.id !== current.id && t.status !== "deleted" && t.blockedBy.includes(current.id),
        );
        if (dependent !== undefined) {
          throw new TeamError(
            "TEAM_TASK_HAS_DEPENDENTS",
            `team task "${current.id}" still blocks "${dependent.id}"`,
          );
        }
        return bump({ status: "deleted" });
      }
      default:
        throw new TeamError("TEAM_INVALID_ARGUMENT", `unsupported task action ${String(args.action)}`);
    }
  }  // ---------------------------------------------------------------- list / get（§7.6）

  list(
    callerId: string,
    args: { status?: TeamTaskStatus; owner?: string; ready?: boolean; cursor?: number; limit?: number } = {},
  ): { tasks: TeamTaskView[]; nextCursor?: number } {
    this.requireMember(callerId);
    const state = this.loadState();
    const cursor = args.cursor ?? 0;
    const limit = args.limit ?? 50;
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new TeamError("TEAM_INVALID_ARGUMENT", "cursor must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TeamError("TEAM_INVALID_ARGUMENT", "limit must be an integer from 1 through 100");
    }
    const views = state.tasks
      .filter((t) => t.status !== "deleted")
      .map((t) => projectTaskView(state, t));
    const filtered = views.filter((view) => {
      if (args.status !== undefined && view.status !== args.status) return false;
      if (args.owner !== undefined) {
        if (args.owner === "unowned" && view.ownerName !== undefined) return false;
        if (args.owner !== "unowned" && view.ownerName !== args.owner) return false;
      }
      if (args.ready !== undefined && view.ready !== args.ready) return false;
      return true;
    });
    const page = filtered.slice(cursor, cursor + limit);
    const hasNext = cursor + limit < filtered.length;
    return hasNext ? { tasks: page, nextCursor: cursor + limit } : { tasks: page };
  }

  get(callerId: string, taskId: string): { task: TeamTaskView } {
    this.requireMember(callerId);
    const state = this.loadState();
    const task = state.tasks.find((t) => t.id === taskId);
    if (task === undefined) {
      throw new TeamError("TEAM_TASK_NOT_FOUND", `team task "${taskId}" not found`);
    }
    return { task: projectTaskView(state, task) }; // 含 deleted 墓碑
  }

  // ---------------------------------------------------------------- 内部

  private requireMember(callerId: string): void {
    requireMembership(() => this.loadState(), callerId);
  }

  private loadState(): TeamState {
    const state = this.deps.store.state();
    if (state.failure !== undefined) throw new Error(state.failure);
    return state;
  }
}

/** 去 owner（release/reopen/reassign 空 owner 路径）。 */
function stripOwner(task: TeamTaskSnapshot): TeamTaskSnapshot {
  if (task.ownerId === undefined) return task;
  const clone = { ...task };
  delete clone.ownerId;
  return clone;
}
