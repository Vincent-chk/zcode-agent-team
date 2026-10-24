// agent-team hook 处理器（command 型，短生命周期）
// 事件：SessionStart(startup|resume) / Stop / UserPromptSubmit —— 仅 7 合法事件中的这 3 个
// 职责：① 触发日志（F03/F15 证据：env overlay 的 ZCODE_SESSION_ID 等）
//      ② SessionStart → additionalContext 注入（策略全文 + team:identity 分支 + 收件箱附加段）
//         + session-map 注册 / teammate 认领（TEAM_SPAWN_IDENTITY）+ 恢复对账触发（best-effort socket）
//      ③ UserPromptSubmit → Lead pending → additionalContext 兜底注入（无次数上限）
//      ④ Stop → Lead pending → decision:block + reason（回合边界交付，≤3 次/run）+ 轻量处置检查
// 回执与预算逻辑在 src/hooks/inbox.ts（纯逻辑层，单测覆盖）；socket 加速 ack 失败静默（回执文件为权威）。
// stdout 只输出 hook JSON；日志走文件。
import fs from "node:fs";
import path from "node:path";
import { dataDir, ensureDir, appendJsonl, ts, readRuntimeConfig, readHostLeadModeOverride, isSensitiveEnvKey } from "./shared.js";
import { buildSessionStartContext, IDENTITY_LEAD_TEXT, identityTeammateText } from "./mcp/policy.js";
import { validateLeadMode } from "./domain/config.js";
import { readSessionRegistry, upsertSessionEntry, safeSessionKey } from "./mcp/identity.js";
import { teamPaths } from "./coord/paths.js";
import { callCoordinator } from "./coord/rpc.js";
import {
  resolveHookRole,
  pendingForLead,
  buildStopReason,
  buildInboxContext,
  writeReceipts,
  runKeyFor,
  budgetAllows,
  nextBudget,
} from "./hooks/inbox.js";
import { readStopBudget, writeStopBudget, memberPaths } from "./provider/member-files.js";
import { recordLeadTurnEvent } from "./provider/lead-wake.js";


interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  stop_hook_active?: boolean;
  source?: string;
  matcher?: string;
  [k: string]: unknown;
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const raw = readStdin();
let input: HookInput = {};
try {
  input = raw ? (JSON.parse(raw) as HookInput) : {};
} catch {
  input = { parse_error: true, raw_preview: raw.slice(0, 500) };
}

const DATA = dataDir();
ensureDir(path.join(DATA, "logs"));
const event = (input.hook_event_name ?? process.env.ZCODE_HOOK_EVENT ?? "unknown").toLowerCase();

// —— F03/F15 证据：完整 env overlay 快照 + 事件日志
const envOverlay: Record<string, string | undefined> = {};
for (const k of Object.keys(process.env)) {
  if (
    k.startsWith("ZCODE_") ||
    k.startsWith("CLAUDE_") ||
    k.startsWith("TEAM_")
  ) {
    envOverlay[k] = isSensitiveEnvKey(k) ? "<redacted>" : process.env[k];
  }
}
const rawSessionId = input.session_id ?? process.env.ZCODE_SESSION_ID ?? process.env.CLAUDE_SESSION_ID ?? null;
const promptText = input.prompt ? String(input.prompt) : null;
const logLine = {
  ts: ts(),
  event,
  input_session_id: input.session_id ?? null,
  env_session_id: process.env.ZCODE_SESSION_ID ?? process.env.CLAUDE_SESSION_ID ?? null,
  env_overlay: envOverlay,
  cwd: input.cwd ?? process.cwd(),
  stop_hook_active: input.stop_hook_active ?? null,
  // 不落 prompt 原文（可能含私有任务/代码）；只记长度供排障。
  prompt_chars: promptText !== null ? promptText.length : null,
  source: input.source ?? null,
};
appendJsonl(path.join(DATA, "logs", "hooks.jsonl"), logLine);

// —— 角色解析（session-map / TEAM_SPAWN_IDENTITY）
const registry = readSessionRegistry(DATA);
const sessionKey = rawSessionId !== null ? safeSessionKey(rawSessionId) : "";
const selfEntry = rawSessionId !== null ? registry[sessionKey] : undefined;
const role = resolveHookRole({
  registryEntry: selfEntry,
  spawnIdentityEnv: process.env.TEAM_SPAWN_IDENTITY,
  sessionId: rawSessionId ?? "",
});

// —— 各事件输出
/** stdout 写完后才 resolve：回执/ack 必须晚于注入输出，避免“先记 delivered 但模型没收到”。 */
function out(obj: unknown): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(JSON.stringify(obj), () => resolve());
  });
}

/** best-effort socket：协调者在场时加速（回执折叠 delivered 事件 / 恢复对账）；缺位静默（回执文件为权威）。 */
async function ackCoordinator(method: string, params: Record<string, unknown>): Promise<void> {
  if (rawSessionId === null) return;
  const { teamDir } = teamPaths(DATA, role.teamId);
  await callCoordinator(teamDir, role.teamId, method, params, { timeoutMs: 2_000, connectTimeoutMs: 500 }).catch(
    () => undefined,
  );
}

/** ack 是加速器：最多等 500ms，不阻塞 hook 退出（回执文件为权威）。 */
async function boundedAck(method: string, params: Record<string, unknown>): Promise<void> {
  await Promise.race([
    ackCoordinator(method, params),
    new Promise<void>((resolve) => setTimeout(resolve, 500)),
  ]);
}

if (event === "sessionstart") {
  // session-map 注册 + teammate 认领（首轮 hook 早于 daemon 的 origin 认领——env 提示即映射源）。
  if (rawSessionId !== null) {
    const claim =
      role.role === "teammate"
        ? {
            teamId: role.teamId,
            role: "teammate" as const,
            name: role.name,
            ...(role.memberId !== undefined ? { memberId: role.memberId } : {}),
          }
        : {};
    upsertSessionEntry(DATA, rawSessionId, {
      ...(selfEntry?.firstSeen === undefined ? { firstSeen: ts() } : {}),
      lastSeen: ts(),
      event,
      cwd: logLine.cwd,
      hookRegistered: true,
      ...claim,
    });
  }

  // 策略注入主通道（stage-3 T3.3；D10 口径 = hook_context 消息形态）+ 身份分支（D2 每轮重注入）
  const identityText =
    role.role === "teammate" ? identityTeammateText(role.name) : IDENTITY_LEAD_TEXT;
  // hooks 读不到 userConfig：优先 env（teammate 轮次继承 daemon env），否则读 daemon 落盘配置。
  const runtimeConfig = readRuntimeConfig();
  const interrupt =
    process.env.TEAM_INTERRUPT !== undefined
      ? process.env.TEAM_INTERRUPT !== "false"
      : (runtimeConfig?.interrupt ?? true);
  // 〔stage-6.5 D26/R2〕leadMode 回落序（R2 后四级）：env（teammate 继承 daemon env / e2e 显式注入）
  // → 宿主 config.json plugins.options 直读（消除首会话时序限制）→ runtime-config.json → 默认。
  // 编排段仅 Lead 会话注入（teammate 传 undefined = 注入逐字节不变）。
  const leadMode = validateLeadMode(
    process.env.TEAM_LEAD_MODE !== undefined
      ? process.env.TEAM_LEAD_MODE
      : (readHostLeadModeOverride() ?? runtimeConfig?.leadMode),
  );
  let context = buildSessionStartContext(identityText, interrupt, role.role === "lead" ? leadMode : undefined);

  // Lead 收件箱附加段（resume 冷拉起 = 无上限交付点）+ 回执
  let pending: Awaited<ReturnType<typeof pendingForLead>> = [];
  if (role.role === "lead" && rawSessionId !== null) {
    const { teamDir } = teamPaths(DATA, role.teamId);
    recordLeadTurnEvent(teamDir, "start");
    pending = await pendingForLead(teamDir, role.teamId);
    if (pending.length > 0) {
      context += `\n${buildInboxContext(pending.map((m) => m.text))}`;
    }
  }
  await out({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  });
  // 输出成功后才落回执（顺序 = 注入可达性优先；回执让协调者折叠 delivered）。
  if (role.role === "lead" && rawSessionId !== null) {
    if (pending.length > 0) {
      writeReceipts(DATA, role.teamId, pending.map((m) => m.messageId), "sessionstart");
      await boundedAck("mailbox.ack", { session_id: rawSessionId, messageIds: pending.map((m) => m.messageId) });
    }
    // 恢复对账触发（T4.4：协调者在场则立即对账；缺位 → 下次 daemon 冷启动兜底）
    if (input.source === "resume") void ackCoordinator("admin.reconcile", { session_id: rawSessionId });
  }
} else if (event === "userpromptsubmit") {
  if (role.role === "lead" && rawSessionId !== null) {
    const { teamDir } = teamPaths(DATA, role.teamId);
    recordLeadTurnEvent(teamDir, "start");
    const pending = await pendingForLead(teamDir, role.teamId);
    if (pending.length > 0) {
      await out({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: buildInboxContext(pending.map((m) => m.text)),
        },
      });
      writeReceipts(DATA, role.teamId, pending.map((m) => m.messageId), "userpromptsubmit");
      await boundedAck("mailbox.ack", { session_id: rawSessionId, messageIds: pending.map((m) => m.messageId) });
    }
  }
  // teammate：进程即边界（pending 由协调者在轮次边界合并投递）；lead 无 pending → 不干预
} else if (event === "stop") {
  if (role.role === "lead" && rawSessionId !== null) {
    const { teamDir } = teamPaths(DATA, role.teamId);
    recordLeadTurnEvent(teamDir, "stop");
    const pending = await pendingForLead(teamDir, role.teamId);
    if (pending.length > 0) {
      const runKey = runKeyFor(input.stop_hook_active);
      const budgetPaths = memberPaths(teamDir, role.teamId);
      const state = readStopBudget(budgetPaths);
      if (budgetAllows(state, runKey)) {
        writeStopBudget(budgetPaths, nextBudget(state, runKey));
        await out({
          decision: "block",
          reason: buildStopReason(pending.map((m) => m.text)),
        });
        writeReceipts(DATA, role.teamId, pending.map((m) => m.messageId), "stop");
        await boundedAck("mailbox.ack", { session_id: rawSessionId, messageIds: pending.map((m) => m.messageId) });
      }
      // 预算耗尽（≥3 次/run）→ 不 block，消息滞留 pending 至下轮 SessionStart/UserPromptSubmit
    }
    // 无 pending → 放行（不干预回合结束；处置轻量检查由 daemon 侧承担）
  }
  // teammate 的 Stop：轮次进程退出即边界，协调者纳管（不注入）
}

// 不裸 exit：让 stdout/ack 的异步句柄自然 drain；hook JSON 已在上面 await 写完。
process.exitCode = 0;
