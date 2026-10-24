// 4 种 team/* 事件（version 2）与持久状态的 zod schema（02 规格 §3.1/§3.2 C9；F01/F07b/B4）。
// 域层事件对象 = 02 §3.1 平铺形状（type/version/teamId + 载荷字段）；JSONL 行的 seq/ts 为
// 传输层元数据，由 journal 轮在进入本模块前剥离（快照不重复携带排序/时间，规格 §3.1 原文）。
//
// ContentBlock 口径（F01）：本地校验只覆盖 text/reasoning/image/tool-call 四型；未知 type 与
// 任何未声明字段（含自有 __proto__ 键）原样保留——校验不做拷贝、不丢引用；已废弃的
// tool-result 包装在 schema 层直接拒绝（V4 准入，进入邮箱状态之前拦截）。

import { z } from "zod";
import type { ZodType } from "zod";

// ---------------------------------------------------------------- ContentBlock

export type ContentBlock = { type: string } & Record<string, unknown>;

const IMAGE_MEDIA_TYPES = ["png", "jpeg", "webp", "gif"] as const;

/**
 * 校验单个内容块（原地校验、返回原引用，保证未知字段/未知 type/自有 __proto__ 键原样保留）。
 * 非法抛 Error；具体消息为内部诊断文本，在重放路径上映射为
 * `persisted Agent Teams <type> payload is invalid`（C9）。
 */
export function validateContentBlock(block: unknown): ContentBlock {
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    throw new Error("content block must be a JSON object");
  }
  const b = block as Record<string, unknown>;
  switch (b.type) {
    case "text":
    case "reasoning":
      if (typeof b.text !== "string") throw new Error(`${String(b.type)} block requires string text`);
      return block as ContentBlock;
    case "image": {
      const a = b.attachment;
      if (typeof a !== "object" || a === null || Array.isArray(a)) {
        throw new Error("image block requires object attachment");
      }
      const att = a as Record<string, unknown>;
      if (typeof att.attachmentId !== "string") throw new Error("image attachment requires string attachmentId");
      if (typeof att.mediaType !== "string" || !(IMAGE_MEDIA_TYPES as readonly string[]).includes(att.mediaType)) {
        throw new Error(`image attachment mediaType must be one of ${IMAGE_MEDIA_TYPES.join("/")}`);
      }
      if (typeof att.bytes !== "number") throw new Error("image attachment requires number bytes");
      if (typeof att.width !== "number") throw new Error("image attachment requires number width");
      if (typeof att.height !== "number") throw new Error("image attachment requires number height");
      if (att.name !== undefined && typeof att.name !== "string") {
        throw new Error("image attachment name must be a string when present");
      }
      return block as ContentBlock;
    }
    case "tool-call": {
      if (typeof b.id !== "string") throw new Error("tool-call block requires string id");
      if (typeof b.name !== "string") throw new Error("tool-call block requires string name");
      if (!("arguments" in b)) throw new Error("tool-call block requires arguments");
      return block as ContentBlock;
    }
    case "tool-result":
      // 已废弃的 tool-result 包装：进入邮箱状态之前拒绝（规格 §3.1 V4 准入）
      throw new Error("retired tool-result wrapper is not accepted as Team message content");
    default:
      // 未知 type（含缺省 type）：宽松保留，不做本地字段校验
      return block as ContentBlock;
  }
}

export function validateContentBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) throw new Error("content must be an array");
  return content.map((block) => validateContentBlock(block));
}

const contentBlocksSchema = z
  .array(z.unknown())
  .superRefine((blocks, ctx) => {
    for (let i = 0; i < blocks.length; i++) {
      try {
        validateContentBlock(blocks[i]);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i],
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }) as z.ZodType<ContentBlock[], z.ZodTypeDef, unknown>;

// ---------------------------------------------------------------- id 宽松口径（B4）

const TASK_ID_PATTERN = /^task-(\d+)$/;

/** task/message id：非空字符串即可；仅当匹配 task-<n> 时要求数字后缀为 safe integer（禁止更严的正则）。 */
export function isLooseIdValid(id: string): boolean {
  if (id.length === 0) return false;
  const m = id.match(TASK_ID_PATTERN);
  if (m && !Number.isSafeInteger(Number(m[1]))) return false;
  return true;
}

/** 提取 task-<n> 的 n（不匹配返回 undefined）；数字超界时返回非 safe integer，由调用方封顶处理。 */
export function taskNumberFromId(id: string): number | undefined {
  const m = id.match(TASK_ID_PATTERN);
  return m ? Number(m[1]) : undefined;
}

const looseIdSchema = z.string().refine(isLooseIdValid, { message: "invalid loose id" });

// ---------------------------------------------------------------- 快照 schema（strict）

export type TeamMemberPhase = "provisioning" | "active" | "failed";
export type TeamTaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export const memberSnapshotSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  provider: z.string(),
  context: z.enum(["fresh", "fork"]),
  phase: z.enum(["provisioning", "active", "failed"]),
  error: z.string().optional(),
});
export type TeamMemberSnapshot = z.infer<typeof memberSnapshotSchema>;

export const taskSnapshotSchema = z.strictObject({
  id: looseIdSchema,
  revision: z.number().refine((n) => Number.isSafeInteger(n) && n >= 1, {
    message: "revision must be a positive safe integer",
  }),
  subject: z.string(),
  description: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "deleted"]),
  ownerId: z.string().optional(),
  blockedBy: z.array(z.string()),
  writeScopes: z.array(z.string()),
});
export type TeamTaskSnapshot = z.infer<typeof taskSnapshotSchema>;

export const messageSnapshotSchema = z.strictObject({
  id: looseIdSchema,
  senderId: z.string(),
  senderName: z.string(),
  targetId: z.string(),
  content: contentBlocksSchema,
});
export type TeamMessageSnapshot = z.infer<typeof messageSnapshotSchema>;

// ---------------------------------------------------------------- 事件 schema（strict）

export const TEAM_EVENT_VERSION = 2;

export const TEAM_EVENT_TYPES = [
  "team/member",
  "team/task",
  "team/message/queued",
  "team/message/delivered",
] as const;
export type TeamEventType = (typeof TEAM_EVENT_TYPES)[number];

export interface TeamMemberEvent {
  type: "team/member";
  version: 2;
  teamId: string;
  member: TeamMemberSnapshot;
}
export interface TeamTaskEvent {
  type: "team/task";
  version: 2;
  teamId: string;
  task: TeamTaskSnapshot;
}
export interface TeamMessageQueuedEvent {
  type: "team/message/queued";
  version: 2;
  teamId: string;
  message: TeamMessageSnapshot;
}
export interface TeamMessageDeliveredEvent {
  type: "team/message/delivered";
  version: 2;
  teamId: string;
  messageId: string;
  targetId: string;
}
export type TeamEvent =
  | TeamMemberEvent
  | TeamTaskEvent
  | TeamMessageQueuedEvent
  | TeamMessageDeliveredEvent;

export const memberEventSchema = z.strictObject({
  type: z.literal("team/member"),
  version: z.literal(TEAM_EVENT_VERSION),
  teamId: z.string(),
  member: memberSnapshotSchema,
});
export const taskEventSchema = z.strictObject({
  type: z.literal("team/task"),
  version: z.literal(TEAM_EVENT_VERSION),
  teamId: z.string(),
  task: taskSnapshotSchema,
});
export const messageQueuedEventSchema = z.strictObject({
  type: z.literal("team/message/queued"),
  version: z.literal(TEAM_EVENT_VERSION),
  teamId: z.string(),
  message: messageSnapshotSchema,
});
export const messageDeliveredEventSchema = z.strictObject({
  type: z.literal("team/message/delivered"),
  version: z.literal(TEAM_EVENT_VERSION),
  teamId: z.string(),
  messageId: z.string(),
  targetId: z.string(),
});

export const TEAM_EVENT_SCHEMAS: Record<TeamEventType, ZodType<TeamEvent>> = {
  "team/member": memberEventSchema as unknown as ZodType<TeamEvent>,
  "team/task": taskEventSchema as unknown as ZodType<TeamEvent>,
  "team/message/queued": messageQueuedEventSchema as unknown as ZodType<TeamEvent>,
  "team/message/delivered": messageDeliveredEventSchema as unknown as ZodType<TeamEvent>,
};

/** 旧版本地日志的排队事件名（0.2.1 对齐前）；读取时归一化为 team/message/queued。 */
export const LEGACY_EVENT_TYPE_ALIASES: Readonly<Record<string, TeamEventType>> = {
  "team/message": "team/message/queued",
};

// ---------------------------------------------------------------- 两段 selector（C9）

export type SelectedTeamEvent =
  | { kind: "event"; event: TeamEvent }
  | { kind: "ignored" }
  | { kind: "unsupported-version"; version: unknown }
  | { kind: "invalid-payload"; type: TeamEventType };

/**
 * 两段校验：先 loose（选 type/teamId/version），匹配后才进 strict 事件 schema（规格 §3.1 C9）。
 * teamId 检查先于 version 检查（§3.2 口径：非本 team 或 teamId 不符 → 忽略，其余才谈版本）。
 */
export function selectTeamEvent(raw: unknown, teamId: string): SelectedTeamEvent {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { kind: "ignored" };
  const candidate = raw as Record<string, unknown>;
  const rawType = candidate.type;
  if (typeof rawType !== "string") return { kind: "ignored" };
  const eventType = (TEAM_EVENT_TYPES as readonly string[]).includes(rawType)
    ? (rawType as TeamEventType)
    : LEGACY_EVENT_TYPE_ALIASES[rawType];
  if (eventType === undefined) return { kind: "ignored" };
  if (typeof candidate.teamId !== "string" || candidate.teamId !== teamId) {
    return { kind: "ignored" }
  }
  if (candidate.version !== TEAM_EVENT_VERSION) {
    return { kind: "unsupported-version", version: candidate.version };
  }
  // 旧名归一化后再进 strict schema（否则 type 字面量不匹配会被误判 invalid-payload）
  const normalized = rawType === eventType ? raw : { ...candidate, type: eventType };
  const parsed = TEAM_EVENT_SCHEMAS[eventType].safeParse(normalized);
  if (!parsed.success) return { kind: "invalid-payload", type: eventType };
  return { kind: "event", event: parsed.data };
}

// ---------------------------------------------------------------- 持久状态（C9）与统一解码

/** 旧 checkpoint 的 delivered 是 {messageId,targetId}[]；读取时归一化为 messageId[]（stateVersion 仍 4）。 */
const deliveredIdsSchema = z.preprocess((value) => {
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (typeof item === "object" && item !== null && typeof (item as { messageId?: unknown }).messageId === "string") {
      return (item as { messageId: string }).messageId;
    }
    return item;
  });
}, z.array(z.string()));

/** 持久状态（checkpoint 落盘校验用）strict schema：{ id, members, tasks, messages, delivered, nextTaskNumber, failure? }。 */
export const teamStateSchema = z.strictObject({
  id: z.string(),
  members: z.array(memberSnapshotSchema),
  tasks: z.array(taskSnapshotSchema),
  messages: z.array(messageSnapshotSchema),
  delivered: deliveredIdsSchema,
  nextTaskNumber: z.number().refine((n) => Number.isSafeInteger(n) && n >= 1, {
    message: "nextTaskNumber must be a positive safe integer",
  }),
  failure: z.string().optional(),
});
export type PersistedTeamState = z.infer<typeof teamStateSchema>;

/**
 * 持久 payload 统一解码：失败抛逐字消息 `persisted Agent Teams <type> payload is invalid`
 * （state.failure 的另一来源，规格 §3.1 C9）。事件重放与状态 checkpoint 共用。
 */
export function decodePersistedPayload<T>(type: string, schema: ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`persisted Agent Teams ${type} payload is invalid`);
  }
  return parsed.data;
}

/** strict 解析单个事件（type 已知为 4 种之一且 version=2 的场合；失败抛 C9 逐字消息）。 */
export function decodeTeamEvent(type: TeamEventType, raw: unknown): TeamEvent {
  return decodePersistedPayload(type, TEAM_EVENT_SCHEMAS[type], raw);
}
