// 域测试共用夹具：事件构造器（默认值对齐 02 §3.1 快照形状）。
import type {
  TeamEvent,
  TeamMemberSnapshot,
  TeamMessageSnapshot,
  TeamTaskSnapshot,
} from "../../src/domain/events.js";

export const TEAM_ID = "sess_lead-root-0001";

export function memberSnapshot(
  overrides: Partial<TeamMemberSnapshot> & Pick<TeamMemberSnapshot, "id" | "name">,
): TeamMemberSnapshot {
  return {
    description: "helper default description",
    provider: "spawn",
    context: "fresh",
    phase: "provisioning",
    ...overrides,
  };
}

export function memberEvent(
  overrides: Partial<TeamMemberSnapshot> & Pick<TeamMemberSnapshot, "id" | "name">,
  teamId: string = TEAM_ID,
): TeamEvent {
  return { type: "team/member", version: 2, teamId, member: memberSnapshot(overrides) };
}

export function taskSnapshot(
  overrides: Partial<TeamTaskSnapshot> & Pick<TeamTaskSnapshot, "id">,
): TeamTaskSnapshot {
  return {
    revision: 1,
    subject: "subject",
    description: "description",
    status: "pending",
    blockedBy: [],
    writeScopes: [],
    ...overrides,
  };
}

export function taskEvent(
  overrides: Partial<TeamTaskSnapshot> & Pick<TeamTaskSnapshot, "id">,
  teamId: string = TEAM_ID,
): TeamEvent {
  return { type: "team/task", version: 2, teamId, task: taskSnapshot(overrides) };
}

export function messageSnapshot(
  overrides: Partial<TeamMessageSnapshot> & Pick<TeamMessageSnapshot, "id" | "targetId">,
): TeamMessageSnapshot {
  return {
    senderId: TEAM_ID,
    senderName: "lead",
    content: [{ type: "text", text: "hello" }],
    ...overrides,
  };
}

export function queuedEvent(
  overrides: Partial<TeamMessageSnapshot> & Pick<TeamMessageSnapshot, "id" | "targetId">,
  teamId: string = TEAM_ID,
): TeamEvent {
  return { type: "team/message/queued", version: 2, teamId, message: messageSnapshot(overrides) };
}

export function deliveredEvent(
  messageId: string,
  targetId: string,
  teamId: string = TEAM_ID,
): TeamEvent {
  return { type: "team/message/delivered", version: 2, teamId, messageId, targetId };
}
