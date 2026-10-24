// TeamError 与 27 个错误码目录（02 规格 §11；〔对齐轮修订〕0.2.1-alpha.5：删 TEAM_MAILBOX_FULL，28→27）。
// code 字符串逐字；消息模板按规格各节逐字登记（占位符 <id>/<name>/<n> 等按规格原样保留）。
// implemented = 本轮（stage-2 第一轮）已有产生该消息的代码路径；其余模板供后续服务轮次使用。

export const TEAM_ERROR_CODES = [
  "TEAM_INVALID_CONFIG",
  "TEAM_DISPOSED",
  "TEAM_DISPOSAL_TIMEOUT",
  "TEAM_NOT_MEMBER",
  "TEAM_LEAD_REQUIRED",
  "TEAM_INVALID_MEMBER_NAME",
  "TEAM_MEMBER_NAME_TAKEN",
  "TEAM_MEMBER_LIMIT",
  "TEAM_PROVISIONING_CONFLICT",
  "TEAM_MEMBER_NOT_FOUND",
  "TEAM_INVALID_TARGET",
  "TEAM_SELF_MESSAGE",
  "TEAM_MESSAGE_TOO_LARGE",
  "TEAM_INVALID_TIMEOUT",
  "TEAM_WAIT_ABORTED",
  "TEAM_INVALID_ARGUMENT",
  "TEAM_INVALID_WRITE_SCOPE",
  "TEAM_TASK_LIMIT",
  "TEAM_TASK_NOT_FOUND",
  "TEAM_TASK_STALE_REVISION",
  "TEAM_TASK_DELETED",
  "TEAM_TASK_UNAUTHORIZED",
  "TEAM_TASK_ALREADY_CLAIMED",
  "TEAM_TASK_BLOCKED",
  "TEAM_TASK_INVALID_TRANSITION",
  "TEAM_TASK_HAS_DEPENDENTS",
  "TEAM_TASK_DEPENDENCY_CYCLE",
] as const;

export type TeamErrorCode = (typeof TEAM_ERROR_CODES)[number];

/** 可 JSON 序列化的错误形状（cause 链保留）。 */
export interface SerializedTeamError {
  name: "TeamError";
  code: TeamErrorCode;
  message: string;
  cause?: SerializedCause;
}

export interface SerializedPlainError {
  name?: string;
  message: string;
  cause?: SerializedCause;
}

export type SerializedCause = SerializedTeamError | SerializedPlainError;

export class TeamError extends Error {
  readonly code: TeamErrorCode;

  constructor(code: TeamErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TeamError";
    this.code = code;
  }

  toJSON(): SerializedTeamError {
    return serializeTeamError(this);
  }
}

/** cause 链序列化（WeakSet 防环，环处截断）。非 TeamError 的 cause 保留 name/message。 */
export function serializeTeamError(err: TeamError): SerializedTeamError {
  const out: SerializedTeamError = { name: "TeamError", code: err.code, message: err.message };
  const seen = new WeakSet<object>([err]);
  const cause = err.cause as unknown;
  if (cause !== undefined && cause !== null) out.cause = serializeCause(cause, seen);
  return out;
}

function serializeCause(cause: unknown, seen: WeakSet<object>): SerializedCause {
  if (!(cause instanceof Error)) return { message: String(cause) };
  if (seen.has(cause)) return { name: cause.name, message: "[circular cause]" };
  seen.add(cause);
  if (cause instanceof TeamError) {
    const serialized: SerializedTeamError = {
      name: "TeamError",
      code: cause.code,
      message: cause.message,
    };
    const inner = cause.cause as unknown;
    if (inner !== undefined && inner !== null) serialized.cause = serializeCause(inner, seen);
    return serialized;
  }
  const plain: SerializedPlainError = { name: cause.name, message: cause.message };
  const inner = cause.cause as unknown;
  if (inner !== undefined && inner !== null) plain.cause = serializeCause(inner, seen);
  return plain;
}

export function isTeamError(x: unknown): x is TeamError {
  return x instanceof TeamError;
}

export interface CatalogEntry {
  /** 规格/出处（02 规格章节 + 本工程实现文件）。 */
  spec: string;
  /** 已知逐字消息模板（多消息分支全列）。 */
  messages: readonly string[];
  /** 本轮是否已有产生该消息的代码路径。 */
  implemented: boolean;
}

/** code → 目录条目。键集与 TEAM_ERROR_CODES 完全一致（类型强制 + 运行时测试双保险）。 */
export const TEAM_ERROR_CATALOG: Record<TeamErrorCode, CatalogEntry> = {
  TEAM_INVALID_CONFIG: {
    spec: "02 §4 / F31",
    messages: ["<name> must be a positive safe integer"],
    implemented: true,
  },
  TEAM_DISPOSED: {
    spec: "02 §11 C2 / §12",
    messages: [
      "Agent Teams service disposed",
      "Agent Teams service is disposing",
      "teammate creation aborted: <errorMessage(reason)>",
    ],
    implemented: false,
  },
  TEAM_DISPOSAL_TIMEOUT: {
    spec: "02 §11 C2 / §12",
    messages: ["Agent Teams runtime disposal exceeded <n>ms"],
    implemented: false,
  },
  TEAM_NOT_MEMBER: {
    spec: "02 §5.2 / F05b",
    messages: ['agent "<id>" is not a member of an active Agent Team'],
    implemented: true,
  },
  TEAM_LEAD_REQUIRED: {
    spec: "02 §5.3 / §7.3",
    messages: ["only the Team Lead can create teammates"],
    implemented: false,
  },
  TEAM_INVALID_MEMBER_NAME: {
    spec: "02 §5.1",
    messages: ['teammate name must be lower-kebab-case, at most 64 characters, and not "lead"'],
    implemented: false,
  },
  TEAM_MEMBER_NAME_TAKEN: {
    spec: "02 §5.3",
    messages: ['teammate name "<name>" was already used in this Team'],
    implemented: false,
  },
  TEAM_MEMBER_LIMIT: {
    spec: "02 §5.3",
    messages: ["Team member limit <n> reached"],
    implemented: false,
  },
  TEAM_PROVISIONING_CONFLICT: {
    spec: "02 §5.3/§5.4（4 条消息分支）",
    messages: [
      'teammate "<childId>" initial prompt was not durably accepted',
      'teammate "<name>" was reconciled as failed while creation was in progress',
      'teammate "<name>" became active while its creator reported failure',
      'provisioned teammate "<id>" disappeared',
    ],
    implemented: false,
  },
  TEAM_MEMBER_NOT_FOUND: {
    spec: "02 §7.3 reassign / §5.6",
    messages: ['active teammate "<name>" not found'],
    implemented: true,
  },
  TEAM_INVALID_TARGET: {
    spec: "02 §5.6",
    messages: ["the Team Lead cannot interrupt itself"],
    implemented: true,
  },
  TEAM_SELF_MESSAGE: {
    spec: "02 §6.2",
    messages: ["a Team member cannot message itself"],
    implemented: true,
  },
  TEAM_MESSAGE_TOO_LARGE: {
    spec: "02 §6.2 / F21",
    messages: ["team message exceeds <n> bytes"],
    implemented: true,
  },
  TEAM_INVALID_TIMEOUT: {
    spec: "02 §8",
    messages: ["timeoutMs must be an integer from 10000 through 3600000"],
    implemented: false,
  },
  TEAM_WAIT_ABORTED: {
    spec: "02 §8",
    messages: ["wait_agent aborted: <errorMessage(reason)>"],
    implemented: false,
  },
  TEAM_INVALID_ARGUMENT: {
    spec: "02 §7.2/§7.3/§7.6",
    messages: [
      "<field> must be non-empty",
      "<field> exceeds <n> characters",
      'duplicate blocker "<id>"',
      "task edit requires subject, description, or write_scopes",
      "set_dependencies requires blocked_by",
      "unsupported task action <a>",
      "cursor must be a non-negative safe integer",
      "limit must be an integer from 1 through 100",
    ],
    implemented: true,
  },
  TEAM_INVALID_WRITE_SCOPE: {
    spec: "02 §7.5",
    messages: ['invalid workspace-relative write scope "<json>"'],
    implemented: true,
  },
  TEAM_TASK_LIMIT: {
    spec: "02 §7.1",
    messages: ["Team task limit <n> reached", "Team task id space exhausted"],
    implemented: false,
  },
  TEAM_TASK_NOT_FOUND: {
    spec: "02 §7.3/§7.4",
    messages: ['team task "<id>" not found', 'blocker task "<id>" not found'],
    implemented: true,
  },
  TEAM_TASK_STALE_REVISION: {
    spec: "02 §7.3",
    messages: ['stale team task "<id>" revision <expected>; current revision is <current>'],
    implemented: false,
  },
  TEAM_TASK_DELETED: {
    spec: "02 §7.3",
    messages: ['team task "<id>" is deleted'],
    implemented: false,
  },
  TEAM_TASK_UNAUTHORIZED: {
    spec: "02 §7.3",
    messages: ["task mutation requires its owner or Team Lead"],
    implemented: false,
  },
  TEAM_TASK_ALREADY_CLAIMED: {
    spec: "02 §7.3",
    messages: ['team task "<id>" is owned by another member'],
    implemented: false,
  },
  TEAM_TASK_BLOCKED: {
    spec: "02 §7.3",
    messages: ['team task "<id>" is not ready to claim', 'team task "<id>" is blocked'],
    implemented: false,
  },
  TEAM_TASK_INVALID_TRANSITION: {
    spec: "02 §7.3",
    messages: [
      "only an in-progress task can be released",
      "only an in-progress task can complete",
      "only a completed task can reopen",
      "only a pending or in-progress task can be reassigned",
    ],
    implemented: false,
  },
  TEAM_TASK_HAS_DEPENDENTS: {
    spec: "02 §7.3 delete",
    messages: ['team task "<id>" still blocks "<dependentId>"'],
    implemented: false,
  },
  TEAM_TASK_DEPENDENCY_CYCLE: {
    spec: "02 §7.4",
    messages: ["a team task cannot block itself"],
    implemented: true,
  },
};
