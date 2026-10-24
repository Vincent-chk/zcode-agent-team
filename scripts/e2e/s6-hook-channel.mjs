// S6 hook 通道剧本（SF05b；生产 hook 二进制确定性矩阵）：
//   Lead 回合内消息到达 → Stop block（≤3 次/run）→ 预算耗尽后 UserPromptSubmit / SessionStart 接力；
//   全程 delivered/回执不重复，每条消息恰一次注入；注入文本可区分发送者与内容边界。
// 说明：本剧本直接执行 dist/team-hooks.mjs（与宿主同一二进制/同一 stdin 协议），
// 不依赖模型可用性；真实模型回合中的同一机制由 S1 的 resume 汇总与 SU 盲测覆盖。
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Checks, PROJ, loadConfig, teamDirFor, writeResult } from "./common.mjs";

const cfg = loadConfig();
const leadId = `${cfg.teamPrefix}-s6-${crypto.randomUUID()}`;
const memberId = crypto.randomUUID();
const memberName = `s6-sender-${crypto.randomBytes(2).toString("hex")}`;
const teamDir = teamDirFor(cfg, leadId);
fs.mkdirSync(teamDir, { recursive: true, mode: 0o700 });
const eventsFile = path.join(teamDir, "events.jsonl");
const checks = new Checks("S6");
const evidence = { leadId, memberId, memberName };

let seq = 0;
function append(event) {
  seq += 1;
  fs.appendFileSync(
    eventsFile,
    JSON.stringify({ seq, ts: new Date().toISOString(), writer: `${memberId}:${process.pid}`, event }) + "\n",
    { mode: 0o600 },
  );
  return seq;
}

// 最小合法团队状态：一个 active 成员 + 逐批 queued 消息
append({
  type: "team/member",
  version: 2,
  teamId: leadId,
  member: { id: memberId, name: memberName, description: "s6", provider: "spawn", context: "fresh", phase: "provisioning" },
});
append({
  type: "team/member",
  version: 2,
  teamId: leadId,
  member: { id: memberId, name: memberName, description: "s6", provider: "spawn", context: "fresh", phase: "active" },
});

const batches = { A: [], B: [], C: [], D: [], E: [] };
function queueMessage(batch, content) {
  const messageId = `team-message-${crypto.randomUUID()}`;
  append({
    type: "team/message/queued",
    version: 2,
    teamId: leadId,
    message: { id: messageId, senderId: memberId, senderName: memberName, targetId: leadId, content: [{ type: "text", text: content }] },
  });
  batches[batch].push({ messageId, content });
  return messageId;
}

function runHook(hookEvent, payload) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [path.join(PROJ, "dist", "team-hooks.mjs")],
      {
        env: {
          ...process.env,
          TEAM_PLUGIN_DATA: cfg.dataRoot,
          TEAM_PROJECT_DIR: cfg.ws,
          TEAM_DB_PATH: cfg.dbPath,
          ZCODE_SESSION_ID: leadId,
          TEAM_INTERRUPT: "false",
        },
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        let parsed = null;
        try {
          parsed = stdout.trim() ? JSON.parse(stdout) : {};
        } catch {
          parsed = { parseError: stdout.slice(0, 500) };
        }
        resolve({ ok: !err, parsed, stdout: String(stdout), stderr: String(stderr), code: err?.code ?? 0 });
      },
    );
    child.stdin.end(JSON.stringify({ hook_event_name: hookEvent, session_id: leadId, cwd: cfg.ws, ...payload }));
  });
}

function receiptLines() {
  const file = path.join(teamDir, "members", leadId, "receipts.jsonl");
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function budget() {
  const file = path.join(teamDir, "members", leadId, "stop-budget.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

try {
  queueMessage("A", "S6-A1 第一条（应在第一次 Stop 注入）");
  queueMessage("A", "S6-A2 第二条（应在第一次 Stop 注入）");
  const stop1 = await runHook("Stop", { stop_hook_active: false });
  const reason1 = String(stop1.parsed?.reason ?? "");
  checks.check(
    "Stop#1 block：一次注入 A 批两条（发送者 + 内容边界可辨）",
    stop1.parsed?.decision === "block" && reason1.includes("S6-A1") && reason1.includes("S6-A2") &&
      reason1.includes(`Team message from ${memberName}:`) && reason1.includes("[agent-team inbox]"),
    { decision: stop1.parsed?.decision },
  );

  queueMessage("B", "S6-B1（第二次 Stop）");
  const stop2 = await runHook("Stop", { stop_hook_active: true });
  checks.check("Stop#2 block：注入 B 批", stop2.parsed?.decision === "block" && String(stop2.parsed?.reason).includes("S6-B1"), {
    decision: stop2.parsed?.decision,
  });

  queueMessage("C", "S6-C1（第三次 Stop）");
  const stop3 = await runHook("Stop", { stop_hook_active: true });
  checks.check("Stop#3 block：注入 C 批", stop3.parsed?.decision === "block" && String(stop3.parsed?.reason).includes("S6-C1"), {
    decision: stop3.parsed?.decision,
  });

  queueMessage("D", "S6-D1（预算耗尽，应留待 UserPromptSubmit）");
  const stop4 = await runHook("Stop", { stop_hook_active: true });
  checks.check(
    "Stop#4：预算耗尽 → 不 block、不注入",
    stop4.parsed?.decision === undefined && stop4.parsed?.reason === undefined,
    { parsed: stop4.parsed },
  );
  const budgetState = budget();
  checks.check("Stop 预算计数 = 3 次，runKey = continuation", budgetState?.blocks === 3 && budgetState?.runKey === "continuation", budgetState);

  const ups = await runHook("UserPromptSubmit", { prompt: "继续" });
  const upsContext = String(ups.parsed?.hookSpecificOutput?.additionalContext ?? "");
  checks.check(
    "UserPromptSubmit 接力：D 批被注入",
    ups.parsed?.hookSpecificOutput?.hookEventName === "UserPromptSubmit" && upsContext.includes("S6-D1") && upsContext.includes("待收消息 1 条"),
    { contextHead: upsContext.slice(0, 160) },
  );

  queueMessage("E", "S6-E1（SessionStart 冷恢复）");
  const sessionStart = await runHook("SessionStart", { source: "resume" });
  const ssContext = String(sessionStart.parsed?.hookSpecificOutput?.additionalContext ?? "");
  checks.check(
    "SessionStart(resume) 接力：E 批被注入（策略全文 + 收件箱段）",
    ssContext.includes("S6-E1") && ssContext.includes("[agent-team inbox]") && ssContext.includes("Agent Teams"),
    { contextHead: ssContext.slice(0, 200) },
  );

  const receipts = receiptLines();
  const channels = new Set(receipts.map((receipt) => receipt.channel));
  checks.check(
    "回执通道覆盖 stop / userpromptsubmit / sessionstart",
    channels.has("stop") && channels.has("userpromptsubmit") && channels.has("sessionstart"),
    { channels: [...channels] },
  );
  const allIds = [...batches.A, ...batches.B, ...batches.C, ...batches.D, ...batches.E].map((m) => m.messageId);
  const receiptIds = receipts.map((receipt) => receipt.messageId);
  const duplicates = receiptIds.filter((id, index) => receiptIds.indexOf(id) !== index);
  const missing = allIds.filter((id) => !receiptIds.includes(id));
  checks.check("每条消息恰一次回执（无重复/无遗漏）", duplicates.length === 0 && missing.length === 0, {
    receipts: receiptIds.length,
    messages: allIds.length,
    duplicates,
    missing,
  });
  // 回执顺序 = 注入发生顺序（A/B/C/D/E），用于证明「前 3 次 Stop、之后 UPS/SessionStart」
  const order = receiptIds.slice(0, 4).map((id) => allIds.indexOf(id));
  checks.check("前 4 条回执顺序 = A 批 → B → C（Stop 阶段）", order.every((value, index) => index === 0 || value > order[index - 1]), {
    order,
  });
  evidence.receipts = receipts.map((receipt) => ({ channel: receipt.channel, messageId: receipt.messageId }));
  evidence.budget = budgetState;
} catch (err) {
  checks.check("S6 未抛异常", false, { error: String(err?.stack ?? err).slice(0, 2000) });
} finally {
  const result = checks.toJSON({ evidence, env: { dataRoot: cfg.dataRoot, db: cfg.dbPath, ws: cfg.ws } });
  const file = writeResult(cfg.out, "S6", result);
  process.stdout.write(`S6 result → ${file}\n`);
  if (!result.pass) process.exitCode = 1;
}
