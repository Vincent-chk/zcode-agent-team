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
import {
  buildSessionStartContext,
  IDENTITY_LEAD_TEXT,
  identityTeammateText,
  ORCHESTRATOR_SECTION_TEXT,
  ON_DEMAND_SECTION_TEXT,
  DEGRADED_SOLO_NOTE,
  SOLO_RETRACT_NOTE,
} from "./mcp/policy.js";
import { validateLeadMode } from "./domain/config.js";
import { readSessionRegistry, upsertSessionEntry, safeSessionKey } from "./mcp/identity.js";
import { teamPaths, assertPathInside } from "./coord/paths.js";
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
import { readStopBudget, writeStopBudget, memberPaths, teamEverCreated } from "./provider/member-files.js";
import { recordLeadTurnEvent, readLeadState, markSoloNotified, markSoloRetracted } from "./provider/lead-wake.js";
import { probeLeadPlanModel } from "./provider/lead-model-probe.js";


interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  stop_hook_active?: boolean;
  source?: string;
  matcher?: string;
  /** 〔D30〕宿主 SessionStart 载荷自带（"providerId/modelId" 扁平串；UPS/Stop 载荷无此字段）。 */
  model?: string;
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
/** 〔D30〕SessionStart 载荷 model 的分类（account / builtin / custom / null=未下发）。
 *  只记形态、不记 modelId——排障需要的是「套餐档 vs 第三方」这一位，且避免落模型明细。 */
function modelCategory(model: unknown): "account" | "builtin" | "custom" | null {
  if (typeof model !== "string" || model.trim().length === 0) return null;
  if (model.startsWith("account:")) return "account";
  if (model.startsWith("builtin:")) return "builtin";
  return "custom";
}
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
  // 〔D30〕宿主是否下发 model + 其形态（account/builtin/custom/null）。只记分类、不记 model；
  // 让「startup 能否凭载荷判定套餐」从源码推断变成日志实证。
  model_category: modelCategory(input.model),
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

// —— 〔issue #9 三档化 D28〕leadMode 全事件共用解析（原仅 SessionStart 分支；off 需在
// UserPromptSubmit/Stop 也生效）。回落序（R2 四级）：env（teammate 继承 daemon env / e2e 显式注入）
// → 宿主 config.json 直读 → runtime-config → 默认 auto。
const runtimeConfig = readRuntimeConfig();
const leadMode = validateLeadMode(
  process.env.TEAM_LEAD_MODE !== undefined
    ? process.env.TEAM_LEAD_MODE
    : (readHostLeadModeOverride() ?? runtimeConfig?.leadMode),
);
/** off 仅对 Lead 会话生效：teammate 会话（既有团队）注入恒走原逻辑。 */
const leadOff = role.role === "lead" && leadMode === "off";

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
  const teamDir = safeTeamDir(role.teamId);
  if (teamDir === null) return;
  await callCoordinator(teamDir, role.teamId, method, params, { timeoutMs: 2_000, connectTimeoutMs: 500 }).catch(
    () => undefined,
  );
}

/**
 * 入口白名单（Mimosa L3 路径穿越口径，stage-2 政策）：hook 输入的 teamId 只接受
 * `[A-Za-z0-9._-]` 且非裸 `.`/`..`；非法返回 null（hook 全程 best-effort，跳过即可）。
 * 校验后再经 teamPaths（内含 assertPathInside 二重防线）取 teamDir。
 */
function safeTeamDir(teamId: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(teamId) || teamId === "." || teamId === "..") return null;
  const { teamDir } = teamPaths(DATA, teamId);
  try {
    assertPathInside(path.join(DATA, "teams"), teamDir);
  } catch {
    return null;
  }
  return teamDir;
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
  const interrupt =
    process.env.TEAM_INTERRUPT !== undefined
      ? process.env.TEAM_INTERRUPT !== "false"
      : (runtimeConfig?.interrupt ?? true);
  // 〔issue #9 三档化 D28〕模式段计算（仅 Lead 会话；teammate 恒不追加 = 注入逐字节不变）：
  //   always → 编排段（原 D26 行为）；auto → 该会话曾建过队（members/ 存在非 sessionId 条目，
  //   teamEverCreated）才注入按需段，未建队 = 策略+身份（上游按需组队语义）；off → 整体不输出。
  let modeSection: string | undefined;
  if (role.role === "lead") {
    if (leadMode === "always") {
      modeSection = ORCHESTRATOR_SECTION_TEXT;
    } else if (leadMode === "auto") {
      const teamDir = safeTeamDir(role.teamId);
      if (teamDir !== null && teamEverCreated(teamDir, role.teamId)) {
        modeSection = ON_DEMAND_SECTION_TEXT;
      }
    }
  }
  let context = buildSessionStartContext(identityText, interrupt, modeSection);

  // 〔issue #5 / D29·D30〕订阅套餐降级：Lead 最新已确认模型为官方套餐 → 队友不可孵化。每会话
  // **首次**注入单 agent 兜底提示（lead state soloNotifiedAt 锚去重；off 档整体不输出已天然门控）。
  // 〔D30〕SessionStart 载荷自带 model 字段（宿主当前选模快照，"providerId/modelId" 扁平串）：
  // startup 全新会话 hook 早于会话行/选模条目落库（实测 ~1.4s）→ 三源必空，hint 补齐该路径；
  // 老宿主无该字段 → 回落三源（resume/派生路径条目已就位）。已通知且未撤回时的对账：
  // 有 hint 走 hint（宿主权威），无 hint 走三源（老宿主 resume 也能自愈）；evidence=none 不撤回。
  if (role.role === "lead" && !leadOff && rawSessionId !== null) {
    const soloTeamDir = safeTeamDir(role.teamId);
    if (soloTeamDir !== null) {
      const soloState = readLeadState(soloTeamDir);
      const modelHint =
        typeof input.model === "string" && input.model.trim().length > 0 ? input.model.trim() : undefined;
      if (soloState?.soloNotifiedAt === undefined) {
        const probe = probeLeadPlanModel(rawSessionId, undefined, modelHint);
        if (probe.blocked) {
          context += `\n${DEGRADED_SOLO_NOTE}`;
          markSoloNotified(soloTeamDir, Date.now(), probe.evidence === "hint" ? "hint" : "db");
        }
      } else if (soloState.soloRetractedAt === undefined) {
        // 已通知未撤回：只要有判定证据（hint 或三源）且已非套餐 → 一次性撤回。
        const recheck = probeLeadPlanModel(rawSessionId, undefined, modelHint);
        if (recheck.evidence !== "none" && !recheck.blocked) {
          context += `\n${SOLO_RETRACT_NOTE}`;
          markSoloRetracted(soloTeamDir);
        }
      }
    }
  }

  // Lead 收件箱附加段（resume 冷拉起 = 无上限交付点）+ 回执
  let pending: Awaited<ReturnType<typeof pendingForLead>> = [];
  if (role.role === "lead" && rawSessionId !== null) {
    const teamDir = safeTeamDir(role.teamId);
    if (teamDir !== null) {
      recordLeadTurnEvent(teamDir, "start");
      // 〔issue #9 D28〕off 档不投递收件箱；轮次记录保留（重新开启后投递链路完好）。
      if (!leadOff) {
        pending = await pendingForLead(teamDir, role.teamId);
        if (pending.length > 0) {
          context += `\n${buildInboxContext(pending.map((m) => m.text))}`;
        }
      }
    }
  }
  // 〔issue #9 D28〕off 档：完全不输出 additionalContext（插件对模型不可见）；session-map 注册/
  // 触发日志/恢复对账等内部副作用照旧（便于诊断与后续重新开启）。
  if (!leadOff) {
    await out({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
    });
  }
  // 输出成功后才落回执（顺序 = 注入可达性优先；回执让协调者折叠 delivered）。
  if (role.role === "lead" && rawSessionId !== null) {
    if (!leadOff && pending.length > 0) {
      writeReceipts(DATA, role.teamId, pending.map((m) => m.messageId), "sessionstart");
      await boundedAck("mailbox.ack", { session_id: rawSessionId, messageIds: pending.map((m) => m.messageId) });
    }
    // 恢复对账触发（T4.4：协调者在场则立即对账；缺位 → 下次 daemon 冷启动兜底）
    if (input.source === "resume") void ackCoordinator("admin.reconcile", { session_id: rawSessionId });
  }
} else if (event === "userpromptsubmit") {
  if (role.role === "lead" && rawSessionId !== null) {
    const teamDir = safeTeamDir(role.teamId);
    if (teamDir !== null) {
      recordLeadTurnEvent(teamDir, "start");
      // 〔issue #9 D28〕off 档：不投递收件箱（插件对模型不可见）；轮次记录保留。
      const pending = leadOff ? [] : await pendingForLead(teamDir, role.teamId);
      // 〔issue #5 / D29·D30〕降级提示与对账（每会话一次），与收件箱合并为一次 additionalContext：
      //   未通知 → 三源探针（UPS 载荷无 model 字段；宿主轮首 ensureSessionPersisted 已写会话行+
      //   选模条目 → 源2 首轮必可见；消息快照源1 要等本轮回落库 +25ms~1.2s）；
      //   已通知未撤回 → 对账：三源确认非套餐（evidence=db）→ 一次性撤回（startup hint 误报 /
      //   会话中途切第三方都自愈）；三源全空（evidence=none，异常时序）→ 留待下一轮。
      const soloState = readLeadState(teamDir);
      let soloNeeded = false;
      let soloRetractNeeded = false;
      if (!leadOff) {
        if (soloState?.soloNotifiedAt === undefined) {
          soloNeeded = probeLeadPlanModel(rawSessionId).blocked;
        } else if (soloState.soloRetractedAt === undefined) {
          const recheck = probeLeadPlanModel(rawSessionId);
          if (recheck.evidence === "db" && !recheck.blocked) soloRetractNeeded = true;
        }
      }
      if (pending.length > 0 || soloNeeded || soloRetractNeeded) {
        const parts: string[] = [];
        if (soloRetractNeeded) parts.push(SOLO_RETRACT_NOTE);
        if (soloNeeded) parts.push(DEGRADED_SOLO_NOTE);
        if (pending.length > 0) parts.push(buildInboxContext(pending.map((m) => m.text)));
        await out({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: parts.join("\n"),
          },
        });
        if (soloNeeded) markSoloNotified(teamDir, Date.now(), "db");
        if (soloRetractNeeded) markSoloRetracted(teamDir);
        if (pending.length > 0) {
          writeReceipts(DATA, role.teamId, pending.map((m) => m.messageId), "userpromptsubmit");
          await boundedAck("mailbox.ack", { session_id: rawSessionId, messageIds: pending.map((m) => m.messageId) });
        }
      }
    }
  }
  // teammate：进程即边界（pending 由协调者在轮次边界合并投递）；lead 无 pending → 不干预
} else if (event === "stop") {
  if (role.role === "lead" && rawSessionId !== null) {
    const teamDir = safeTeamDir(role.teamId);
    if (teamDir !== null) {
      recordLeadTurnEvent(teamDir, "stop");
      // 〔issue #9 D28〕off 档：不 block 不投递（同上）；轮次记录保留。
      const pending = leadOff ? [] : await pendingForLead(teamDir, role.teamId);
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
  }
  // teammate 的 Stop：轮次进程退出即边界，协调者纳管（不注入）
}

// 不裸 exit：让 stdout/ack 的异步句柄自然 drain；hook JSON 已在上面 await 写完。
process.exitCode = 0;
