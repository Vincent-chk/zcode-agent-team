// 投影状态机（02 规格 §3.2/§3.3；F02–F06、F05b/C5）。
// 拒绝/失败消息逐字对齐规格原文；failure 为终态（后续事件不再应用、不再产生新视图）；
// members/tasks 数组不可变更新，视图缓存以集合引用为键（WeakMap 语义），mailbox-only 变化不发新视图。

import { TeamError } from "./errors.js";
import {
  selectTeamEvent,
  taskNumberFromId,
  type TeamEvent,
  type TeamMemberSnapshot,
  type TeamMessageSnapshot,
  type TeamTaskSnapshot,
} from "./events.js";
import { validateTaskGraph } from "./task-graph.js";
import { projectTaskView, type TeamTaskView } from "./task-view.js";

export const TEAM_PROJECTION_KEY = "agentTeam";
export const TEAM_PROJECTION_STATE_VERSION = 4;

export interface TeamState {
  id: string;
  members: TeamMemberSnapshot[];
  tasks: TeamTaskSnapshot[];
  messages: TeamMessageSnapshot[];
  /** 已送达的 messageId（与 DSH TeamState 同形；目标由 messages 回查）。 */
  delivered: string[];
  nextTaskNumber: number;
  failure?: string;
}

export function emptyTeamState(rootId: string): TeamState {
  return {
    id: rootId,
    members: [],
    tasks: [],
    messages: [],
    delivered: [],
    nextTaskNumber: 1,
  };
}

function failed(state: TeamState, failure: string): TeamState {
  return { ...state, failure };
}

/**
 * 顶层 apply（02 §3.2 顺序）：非 team/* 或 teamId 不符 → 原样忽略；version≠2 → failure；
 * strict 解码失败 → failure（C9 消息）；failure 已存在 → 终态，原样返回。
 */
export function applyProjectionEvent(state: TeamState, raw: unknown): TeamState {
  if (state.failure !== undefined) return state;
  const selected = selectTeamEvent(raw, state.id);
  switch (selected.kind) {
    case "ignored":
      return state;
    case "unsupported-version":
      return failed(state, `unsupported Agent Teams event version ${String(selected.version)}`);
    case "invalid-payload":
      return failed(state, `persisted Agent Teams ${selected.type} payload is invalid`);
    case "event":
      return applyCurrentTeamEvent(state, selected.event);
  }
}

/** 当前版本（version 2）事件的应用规则（消息逐字，规格 §3.2）。 */
export function applyCurrentTeamEvent(state: TeamState, event: TeamEvent): TeamState {
  if (state.failure !== undefined) return state;
  switch (event.type) {
    case "team/member":
      return applyMember(state, event.member);
    case "team/task":
      return applyTask(state, event.task);
    case "team/message/queued":
      return applyMessageQueued(state, event.message);
    case "team/message/delivered":
      return applyMessageDelivered(state, event.messageId, event.targetId);
  }
}

function applyMember(state: TeamState, member: TeamMemberSnapshot): TeamState {
  const prior = state.members.find((m) => m.id === member.id);
  if (prior === undefined) {
    if (member.phase !== "provisioning") {
      return failed(state, `teammate "${member.name}" must begin provisioning`);
    }
    if (state.members.some((m) => m.name === member.name)) {
      return failed(state, `teammate name "${member.name}" is reused by another member`);
    }
    return { ...state, members: [...state.members, member] };
  }
  if (
    prior.name !== member.name ||
    prior.provider !== member.provider ||
    prior.context !== member.context
  ) {
    return failed(state, `teammate "${prior.id}" changed immutable identity fields`);
  }
  if (
    prior.phase !== "provisioning" ||
    (member.phase !== "active" && member.phase !== "failed")
  ) {
    return failed(
      state,
      `teammate "${member.name}" has an invalid ${prior.phase} -> ${member.phase} transition`,
    );
  }
  return { ...state, members: state.members.map((m) => (m.id === member.id ? member : m)) };
}

function applyTask(state: TeamState, task: TeamTaskSnapshot): TeamState {
  const prior = state.tasks.find((t) => t.id === task.id);
  const expectedRevision = prior === undefined ? 1 : prior.revision + 1;
  if (task.revision !== expectedRevision) {
    return failed(
      state,
      prior === undefined
        ? `team task "${task.id}" must begin at revision 1`
        : `team task "${task.id}" revision is not contiguous`,
    );
  }
  const tasks =
    prior === undefined ? [...state.tasks, task] : state.tasks.map((t) => (t.id === task.id ? task : t));
  try {
    validateTaskGraph(tasks);
  } catch (err) {
    return failed(state, err instanceof Error ? err.message : String(err));
  }
  let nextTaskNumber = state.nextTaskNumber;
  const n = taskNumberFromId(task.id);
  if (n !== undefined) {
    nextTaskNumber = Math.max(state.nextTaskNumber, Math.min(n + 1, Number.MAX_SAFE_INTEGER));
  }
  return { ...state, tasks, nextTaskNumber };
}

function applyMessageQueued(state: TeamState, message: TeamMessageSnapshot): TeamState {
  if (state.messages.some((m) => m.id === message.id)) {
    return failed(state, `team message "${message.id}" was queued twice`);
  }
  return { ...state, messages: [...state.messages, message] };
}

function applyMessageDelivered(state: TeamState, messageId: string, targetId: string): TeamState {
  const queued = state.messages.find((m) => m.id === messageId);
  if (queued === undefined) {
    return failed(state, `team message "${messageId}" was delivered before queueing`);
  }
  if (queued.targetId !== targetId) {
    return failed(state, `team message "${messageId}" target changed`);
  }
  if (state.delivered.includes(messageId)) {
    return failed(state, `team message "${messageId}" was delivered twice`);
  }
  return { ...state, delivered: [...state.delivered, messageId] };
}

/** 全量重放（冷启动常态路径）：事件数组按序折叠到 emptyTeamState(teamId)。 */
export function buildTeamProjection(events: readonly unknown[], teamId: string): TeamState {
  let state = emptyTeamState(teamId);
  for (const raw of events) {
    state = applyProjectionEvent(state, raw);
  }
  return state;
}

// ---------------------------------------------------------------- 客户端投影视图（§3.3）

export interface TeamMemberViewRow {
  id: string;
  name: string;
  role: "lead" | "teammate";
  phase: "active" | TeamMemberSnapshot["phase"];
  error?: string;
}

export interface TeamProjectionView {
  members: TeamMemberViewRow[];
  tasks: TeamTaskView[];
  failure?: string;
}

interface ViewCacheEntry {
  /** 健康视图（无 failure 字段）。 */
  healthy: TeamProjectionView;
  /** failure 终态视图（懒建；终态后 members/tasks 引用不再变化，至多一份）。 */
  failed?: TeamProjectionView;
}

const viewCache = new WeakMap<readonly TeamMemberSnapshot[], WeakMap<readonly TeamTaskSnapshot[], ViewCacheEntry>>();

/**
 * 视图构建（带结构共享缓存）：以 (members 引用, tasks 引用) 双层 WeakMap 为键；
 * mailbox-only（queued/delivered）变化不产生新视图对象（不发帧）；members/tasks 变化才产生新视图。
 * failure 存在时视图 = 最后有效状态 + failure（同一缓存条目下的稳定引用）。
 */
export function teamProjectionView(state: TeamState): TeamProjectionView {
  let byTasks = viewCache.get(state.members);
  if (byTasks === undefined) {
    byTasks = new WeakMap();
    viewCache.set(state.members, byTasks);
  }
  let entry = byTasks.get(state.tasks);
  if (entry === undefined) {
    const members: TeamMemberViewRow[] = [
      { id: state.id, name: "lead", role: "lead", phase: "active" },
      ...state.members.map((m) => ({ id: m.id, name: m.name, role: "teammate" as const, phase: m.phase, ...(m.error !== undefined ? { error: m.error } : {}) })),
    ];
    const tasks = state.tasks
      .filter((t) => t.status !== "deleted")
      .map((t) => projectTaskView(state, t));
    entry = { healthy: { members, tasks } };
    byTasks.set(state.tasks, entry);
  }
  if (state.failure === undefined) return entry.healthy;
  if (entry.failed === undefined) {
    entry.failed = { ...entry.healthy, failure: state.failure };
  }
  return entry.failed;
}

// ---------------------------------------------------------------- 成员资格（§5.2 等价路径 + C5 fail-closed）

export interface Membership {
  rootId: string;
  role: "lead" | "teammate";
  name: string;
}

/**
 * tryMembership 等价路径（纯域核心口径）：loadState 代表 journal.state()——
 * 投影未注册（抛 `Agent Teams projection is not registered`）或 failure 终态（抛 failure 文本）
 * 时**静默返回 undefined（非成员）**（规格 §3.2 C5 fail-closed）。
 * 完整的 parentSession/descriptor 解析归服务轮次；此处覆盖状态可判定的部分。
 */
export function tryMembership(loadState: () => TeamState, agentId: string): Membership | undefined {
  let state: TeamState;
  try {
    state = loadState();
  } catch {
    return undefined;
  }
  if (agentId === state.id) {
    return { rootId: state.id, role: "lead", name: "lead" };
  }
  const member = state.members.find((m) => m.id === agentId);
  if (member !== undefined && (member.phase === "active" || member.phase === "provisioning")) {
    return { rootId: state.id, role: "teammate", name: member.name };
  }
  return undefined;
}

/** 服务调用的成员资格前置：非成员（含 C5 退化）→ TEAM_NOT_MEMBER（消息逐字）。 */
export function requireMembership(loadState: () => TeamState, agentId: string): Membership {
  const membership = tryMembership(loadState, agentId);
  if (membership === undefined) {
    throw new TeamError(
      "TEAM_NOT_MEMBER",
      `agent "${agentId}" is not a member of an active Agent Team`,
    );
  }
  return membership;
}

/** journal.state() 的两种抛错形态（供服务轮次构造 loadState 时使用；逐字）。 */
export function projectionNotRegisteredError(): Error {
  return new Error("Agent Teams projection is not registered");
}

/** 投影 failure 终态时 journal.state() 直接 throw failure 文本（C5）。 */
export function projectionFailureError(failure: string): Error {
  return new Error(failure);
}
