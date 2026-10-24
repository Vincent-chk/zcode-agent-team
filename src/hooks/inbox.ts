// Hook 收件箱逻辑（T4.3；纯逻辑层，dist/team-hooks.mjs 入口编排）。
// Lead 侧三通道（D2/D12 内部适配层）：
//   Stop              → pending 非空 → decision:block + reason（框架化消息逐字拼接；≤3 次/run）→ 回执；
//   UserPromptSubmit  → pending 非空 → additionalContext 注入（无上限）→ 回执；
//   SessionStart      → 策略+身份注入（stage-3 既有）+ pending 附加段（无上限）→ 回执。
// 回执 = members/<leadId>/receipts.jsonl（O_APPEND+fsync；hook 进程与协调者双写者安全）——
// delivered 事件由协调者折叠（mailbox.observeDelivery / containsMessage(lead) 读回执）。
// teammate 侧（进程即边界）：pending 由协调者在轮次边界合并为下一轮 prompt，hook 不注入收件箱；
// 身份分支按 session-map teammate 映射 / TEAM_SPAWN_IDENTITY（首轮 hook 早于 daemon 认领）。

import fs from "node:fs";
import path from "node:path";
import { load as replayLoad } from "../coord/replay.js";
import { teamPaths } from "../coord/paths.js";
import { appendReceipt, memberPaths, receiptMessageIds } from "../provider/member-files.js";
import { renderFramed } from "../provider/framing.js";

export interface SpawnIdentityHint {
  teamId: string;
  memberId: string;
  name: string;
}

export interface HookRole {
  role: "lead" | "teammate";
  teamId: string;
  /** teammate 成员名；lead 恒 "lead"。 */
  name: string;
  /** teammate 域侧成员 id（agentId）。 */
  memberId?: string;
  /** 身份来源：session-map 映射 / env 提示（首轮认领）。 */
  hint?: SpawnIdentityHint;
}

/** 解析本会话角色：session-map teammate 映射优先；TEAM_SPAWN_IDENTITY 提示次之（认领场景）。 */
export function resolveHookRole(args: {
  registryEntry: { role?: string; teamId?: string; name?: string; memberId?: string } | undefined;
  spawnIdentityEnv: string | undefined;
  sessionId: string;
}): HookRole {
  const entry = args.registryEntry;
  if (entry?.role === "teammate" && typeof entry.teamId === "string" && entry.teamId.length > 0) {
    return {
      role: "teammate",
      teamId: entry.teamId,
      name: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : "teammate",
      ...(typeof entry.memberId === "string" && entry.memberId.length > 0 ? { memberId: entry.memberId } : {}),
    };
  }
  const hint = parseSpawnIdentity(args.spawnIdentityEnv);
  if (hint !== undefined) return { role: "teammate", teamId: hint.teamId, name: hint.name, memberId: hint.memberId, hint };
  return { role: "lead", teamId: args.sessionId, name: "lead" };
}

export function parseSpawnIdentity(raw: string | undefined): SpawnIdentityHint | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw) as { teamId?: unknown; memberId?: unknown; name?: unknown };
    if (
      typeof parsed.teamId === "string" &&
      parsed.teamId.length > 0 &&
      typeof parsed.memberId === "string" &&
      parsed.memberId.length > 0 &&
      typeof parsed.name === "string" &&
      parsed.name.length > 0
    ) {
      return { teamId: parsed.teamId, memberId: parsed.memberId, name: parsed.name };
    }
  } catch {
    /* 提示损坏 → 忽略（Lead 分支 + session-map 兜底） */
  }
  return undefined;
}

export interface PendingMessage {
  messageId: string;
  senderName: string;
  /** 框架化渲染文本（框架头 + 原内容，逐字）。 */
  text: string;
}

/** Lead 的待收消息：重放 events.jsonl 派生（queued−delivered）− 已回执未折叠。 */
export async function pendingForLead(teamDir: string, teamId: string): Promise<PendingMessage[]> {
  if (!fs.existsSync(path.join(teamDir, "events.jsonl"))) return [];
  const loaded = await replayLoad(teamDir, teamId);
  if (loaded.state.failure !== undefined) return []; // failure 终态：不注入（排障视角 team-ctl）
  const delivered = new Set(loaded.state.delivered);
  const receipted = receiptMessageIds(memberPaths(teamDir, teamId));
  const pending: PendingMessage[] = [];
  for (const message of loaded.state.messages) {
    if (message.targetId !== teamId || delivered.has(message.id) || receipted.has(message.id)) continue;
    const framed = [
      { type: "text", text: `Team message from ${message.senderName}:` },
      ...message.content,
    ];
    pending.push({
      messageId: message.id,
      senderName: message.senderName,
      text: renderFramed(JSON.stringify(framed)).text,
    });
  }
  return pending;
}

/** Stop block reason（接口草案 §4 冻结模板）。 */
export function buildStopReason(texts: ReadonlyArray<string>): string {
  return `[agent-team inbox] 新消息到达，本轮结束后需处理：\n${texts.join("\n\n")}`;
}

/** UserPromptSubmit / SessionStart 附加段（接口草案 §4 冻结模板）。 */
export function buildInboxContext(texts: ReadonlyArray<string>): string {
  return `[agent-team inbox] 待收消息 ${texts.length} 条：\n${texts.join("\n\n")}`;
}

/** 注入成功 → 落回执（先回执后加速 ack；协调者据此折叠 delivered 事件）。 */
export function writeReceipts(
  dataRoot: string,
  teamId: string,
  messageIds: ReadonlyArray<string>,
  channel: "stop" | "userpromptsubmit" | "sessionstart",
): void {
  const paths = memberPaths(teamPaths(dataRoot, teamId).teamDir, teamId);
  for (const messageId of messageIds) {
    appendReceipt(paths, { messageId, channel, ts: new Date().toISOString() });
  }
}

// ---------------------------------------------------------------- Stop 预算（≤3 次/run）

export interface StopBudgetState {
  runKey: string;
  blocks: number;
}

/** runKey 语义：stop_hook_active=false → 新 run（计数复位）；true → 同 run 续跑（计数延续）。 */
export function runKeyFor(stopHookActive: boolean | null | undefined): string {
  return stopHookActive ? "continuation" : "fresh-run";
}

/**
 * 有效 block 计数：fresh-run（stop_hook_active=false）= 新 run，显式复位为 0；
 * continuation 沿用持久计数（每 run 首个 Stop 恒为 fresh → 持久值必属当前 run）。
 */
export function effectiveBlocks(state: StopBudgetState | undefined, runKey: string): number {
  if (runKey === "fresh-run") return 0;
  return state?.blocks ?? 0;
}

export function budgetAllows(state: StopBudgetState | undefined, runKey: string): boolean {
  return effectiveBlocks(state, runKey) < 3;
}

export function nextBudget(state: StopBudgetState | undefined, runKey: string): StopBudgetState {
  return { runKey, blocks: effectiveBlocks(state, runKey) + 1 };
}
