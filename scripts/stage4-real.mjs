// stage-4 真实模型验收（F01/F02/F06/F06b/F07/F09/F11/F13/F16/F17 + V01/V03 证据；U01 剧本面）
// 路径全部走生产形态：真 zcode -p 会话（Lead + teammate 轮次）+ 真插件 daemon（dist/team-daemon.mjs
// 经 MCP stdio）+ 真 hook（dist/team-hooks.mjs，由宿主在真会话中触发）。
// 数据根 = 实装插件数据根（~/.zcode/cli/plugins/data/agent-team@inline）——teammate 自带 daemon 与
// 身份解析依赖共享根（生产同构）；本脚本产出一个团队目录（teams/<leadId>/），为验收数据。
// 用法：node scripts/stage4-real.mjs [--ws <dir>] [--out <evidenceDir>] [--skip <场景,...>]
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const proj = path.resolve(__dirname, "..");
const ZCODE = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const DAEMON = path.join(proj, "dist/team-daemon.mjs");
const DATA_ROOT = path.join(os.homedir(), ".zcode/cli/plugins/data/agent-team@inline");
const DB = path.join(os.homedir(), ".zcode/cli/db/db.sqlite");

const argOf = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
};
const WS = argOf("ws") ?? "/tmp/at-s4-real/ws";
const OUT = argOf("out") ?? path.resolve(proj, "../zcode-agent-team-plan/stage-4-teammate-runtime/evidence/real");
const SKIP = new Set((argOf("skip") ?? "").split(",").filter(Boolean));
const LEAD_REUSE = argOf("lead");
const TAG = argOf("tag") ?? ""; // 复用团队时成员名加后缀（§5.1 名字永不复用） // 复用既有团队（--lead <sessId>）：跳过 S0–S3 直接 S4+
const CODE1 = argOf("code1");
const PROGRESS = path.join(OUT, "progress.log");
function progress(line) {
  fs.appendFileSync(PROGRESS, `${now()} ${line}\n`);
}
fs.mkdirSync(WS, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const evidence = { scenarios: {}, startedAt: now(), env: { ZCODE, DAEMON, DATA_ROOT, DB, WS, node: process.version } };
let pass = true;
function record(name, ok, details) {
  evidence.scenarios[name] = { pass: ok, ...details, ts: now() };
  if (!ok) pass = false;
  const line = `[${ok ? "PASS" : "FAIL"}] ${name} ${ok ? "" : JSON.stringify(details).slice(0, 400)}`;
  process.stdout.write(line + "\n");
  progress(`record ${line}`);
}

if (!fs.existsSync(ZCODE)) {
  process.stdout.write(`zcode CLI 不存在：${ZCODE}\n`);
  process.exit(2);
}
if (!fs.existsSync(DAEMON)) {
  process.stdout.write("dist/team-daemon.mjs 缺失——先 npm run build\n");
  process.exit(2);
}

// ---------------------------------------------------------------- 真 zcode -p 会话
function runZcode(prompt, extraArgs = [], label = "zcode") {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = execFile(
      process.execPath,
      [ZCODE, "-p", prompt, ...extraArgs, "--json", "--mode", "yolo", "--surface", "terminal", "--cwd", WS],
      { maxBuffer: 32 * 1024 * 1024, timeout: 300_000 },
      (err, stdout, stderr) => {
        progress(`zcode-exit label=${label} err=${err ? String(err.message).slice(0, 120) : "none"} stdout=${stdout.length}B`);
        let parsed = null;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          /* 保持 null */
        }
        resolve({ label, ok: !err, code: err?.code ?? 0, ms: Date.now() - t0, parsed, stdout: stdout.slice(0, 2000), stderr: String(stderr).slice(0, 1000) });
      },
    );
    void p;
  });
}

// ---------------------------------------------------------------- MCP daemon（生产 stdio）
function startDaemon() {
  const child = spawn(process.execPath, [DAEMON], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TEAM_PLUGIN_DATA: DATA_ROOT, TEAM_PROJECT_DIR: WS },
  });
  let nextId = 1;
  const pending = new Map();
  const notifications = [];
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else if (msg.method !== undefined) {
        notifications.push(msg);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => process.stdout.write(`[daemon-err] ${d}`));
  const rpc = (method, params, timeoutMs = 60_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`rpc timeout ${method}#${id} after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }) + "\n");
    });
  return {
    notifications,
    async ready() {
      await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "s4-real", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    callTool(name, args, meta) {
      return rpc("tools/call", { name, arguments: args, _meta: meta }, 240_000);
    },
    kill() {
      try {
        child.kill("SIGKILL");
      } catch {
        /* noop */
      }
    },
  };
}

function toolJson(res) {
  if (res.result?.isError) throw new Error(`tool error: ${res.result.content?.[0]?.text ?? "?"}`);
  return JSON.parse(res.result.content[0].text);
}

// ---------------------------------------------------------------- db 只读探针
function withDb(fn) {
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
function assistantTexts(sessionId) {
  return withDb((db) =>
    db
      .prepare(
        `SELECT json_extract(p.data,'$.text') t FROM message m JOIN part p ON p.message_id = m.id
         WHERE m.session_id = ? AND json_extract(m.data,'$.role')='assistant' AND json_extract(p.data,'$.type')='text'
         ORDER BY m.sequence, p.sequence`,
      )
      .all(sessionId)
      .map((r) => r.t)
      .filter(Boolean),
  );
}
function firstRealUserText(sessionId) {
  return withDb((db) =>
    db
      .prepare(
        `SELECT json_extract(p.data,'$.text') t FROM message m JOIN part p ON p.message_id = m.id
         WHERE m.session_id = ? AND json_extract(m.data,'$.role')='user' AND json_extract(m.data,'$.semantics.origin')='real_user'
           AND json_extract(p.data,'$.type')='text' ORDER BY m.sequence LIMIT 1`,
      )
      .get(sessionId)?.t ?? null,
  );
}
function partTextsLike(sessionId, pattern) {
  return withDb((db) =>
    db
      .prepare(`SELECT COUNT(*) n FROM part WHERE session_id = ? AND data LIKE ?`)
      .get(sessionId, pattern).n,
  );
}

async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return Date.now() - t0;
    await sleep(500);
  }
  throw new Error(`timeout (${timeoutMs}ms): ${what}`);
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const code1 = CODE1 ?? `amber-${crypto.randomBytes(3).toString("hex")}`;
  const code2 = `birch-${crypto.randomBytes(3).toString("hex")}`;
  const code3 = argOf("code3") ?? `cedar-${crypto.randomBytes(3).toString("hex")}`;
  evidence.codes = { code1, code2, code3 };

  let lead = LEAD_REUSE ?? null;
  let leadSeed = { ms: 0, parsed: null };
  if (lead === null) {
    // S0：Lead 真会话（埋 fork 暗号）
    progress("S0-start");
    const lead0 = await runZcode(`请记住暗号 ${code3}（后续会考）。另外请只回复 ok。`, [], "lead-seed");
    lead = lead0.parsed?.sessionId;
    if (!lead) {
      record("S0-lead-session", false, { run: lead0 });
      return finish();
    }
    leadSeed = lead0;
    record("S0-lead-session", (lead0.parsed?.response ?? "").includes("ok"), { lead, ms: lead0.ms, response: lead0.parsed?.response });
  } else {
    progress(`S0-skip-reuse lead=${lead}`);
    evidence.reusedLead = lead;
    SKIP.add("s1");
    SKIP.add("s2");
    SKIP.add("s3");
  }
  void leadSeed;
  const teamDir = path.join(DATA_ROOT, "teams", lead);
  const eventsFile = path.join(teamDir, "events.jsonl");

  const daemon = startDaemon();
  daemonRef = daemon;
  await daemon.ready();
  const meta = { session_id: lead };

  // S1 F01：fresh spawn 真链路（首轮=任务原文、落库、--disallowed-tools Task、模型行）
  if (!SKIP.has("s1")) {
    progress("S1-start");
    const t0 = Date.now();
    const spawnRes = toolJson(await daemon.callTool("spawn_teammate", {
      name: "s4-writer",
      description: "写 add.py",
      prompt: "在工作目录创建文件 add.py，内容为：def add(a, b):\\n    return a + b\\n创建完成后只回复 done。",
    }, meta));
    const memberDir = fs.readdirSync(path.join(teamDir, "members")).find((m) => fs.existsSync(path.join(teamDir, "members", m, "origin.json")));
    const origin = JSON.parse(fs.readFileSync(path.join(teamDir, "members", memberDir, "origin.json"), "utf8"));
    const turn1 = JSON.parse(fs.readFileSync(path.join(teamDir, "members", memberDir, "run", "turn-1.json"), "utf8"));
    const fileMs = await waitFor(() => fs.existsSync(path.join(WS, "add.py")), 120_000, "add.py 出现");
    const firstPrompt = firstRealUserText(origin.sessionId);
    const checks = {
      memberRow: spawnRes.member,
      originSessionId: origin.sessionId,
      firstPromptEqualsTask: firstPrompt === turn1.promptText && turn1.kind === "first",
      disallowedTask: turn1.argv.includes("Task") && turn1.argv[turn1.argv.indexOf("--disallowed-tools") + 1] === "Task",
      surfaceTerminal: turn1.argv.includes("terminal"),
      fileCreatedMs: fileMs,
      spawnMs: Date.now() - t0,
    };
    record("S1-F01-fresh-spawn", checks.firstPromptEqualsTask && checks.disallowedTask && checks.fileCreatedMs < 120_000, checks);
  }

  // S2 F16/D6：teammate 工具面无 Task
  if (!SKIP.has("s2")) {
    progress("S2-start");
    const spawnRes = toolJson(await daemon.callTool("spawn_teammate", {
      name: "s4-tools",
      description: "工具清单",
      prompt: "列出你当前可用的全部工具名（只要名字，用逗号分隔，不要解释）。",
    }, meta));
    void spawnRes;
    const memberDir = fs.readdirSync(path.join(teamDir, "members")).find((m) => {
      const o = path.join(teamDir, "members", m, "origin.json");
      return fs.existsSync(o) && JSON.parse(fs.readFileSync(o, "utf8")).name === "s4-tools";
    });
    const origin = JSON.parse(fs.readFileSync(path.join(teamDir, "members", memberDir, "origin.json"), "utf8"));
    await waitFor(() => assistantTexts(origin.sessionId).length > 0, 120_000, "s4-tools 回答");
    const answer = assistantTexts(origin.sessionId).join(" ");
    record("S2-F16-teammate-no-task", !/\bTask\b/.test(answer), { answer: answer.slice(0, 300) });
  }

  // S3 F06/F07/F09：teammate 空闲 → 立即拉起投递 + 回信 lead（暗号）+ 队列序
  if (!SKIP.has("s3")) {
    progress("S3-start");
    const sendRes = toolJson(await daemon.callTool("send_message", {
      target: "s4-writer",
      message: `请用 send_message 工具把暗号 ${code1} 原样发给 lead（target 填 "lead"），然后只回复 sent。`,
    }, meta));
    void sendRes; // {sent:true}——工具层不暴露 messageId（D1）；投递锚点从事件日志取
    const writerMemberId = fs.readdirSync(path.join(teamDir, "members")).find((m) => {
      const o = path.join(teamDir, "members", m, "origin.json");
      return fs.existsSync(o) && JSON.parse(fs.readFileSync(o, "utf8")).name === "s4-writer";
    });
    const sent = { messageId: latestMessageIdTo(eventsFile, writerMemberId) };
    // 消息进入 pending → 拉起 --resume 轮 → teammate 调 send_message(lead) → lead pending（无进程）
    const deliveredToWriter = await waitFor(() => {
      if (!fs.existsSync(eventsFile)) return false;
      const lines = fs.readFileSync(eventsFile, "utf8").trim().split("\n");
      return lines.some((l) => l.includes('"team/message/delivered"') && l.includes(sent.messageId));
    }, 180_000, "writer 收到消息（delivered 事件）");
    const leadGot = await waitFor(() => {
      if (!fs.existsSync(eventsFile)) return false;
      const lines = fs.readFileSync(eventsFile, "utf8").trim().split("\n");
      return lines.some((l) => (l.includes('"team/message/queued"') || l.includes('"team/message"')) && l.includes('"senderName":"s4-writer"'));
    }, 180_000, "writer 回信 lead（queued 事件）");
    record("S3-F06-F07-real-delivery", deliveredToWriter < 180_000 && leadGot < 180_000, { sentMessageId: sent.messageId, deliveredMs: deliveredToWriter, leadMessageSeenMs: leadGot });
  }

  // S4 F06b：Lead 冷（无进程）→ pending 滞留 → --resume 拉起时 SessionStart(resume) 注入 → 模型复述暗号
  if (!SKIP.has("s4")) {
    progress("S4-start");
    const lead1 = await runZcode("你收到的团队消息里的暗号是什么？只回复暗号本身。", ["--resume", lead], "lead-inbox");
    const answer = (lead1.parsed?.response ?? "");
    // 回执与 delivered 事件（SessionStart hook 注入 + mailbox.ack/冷启动折叠）
    const receiptsFile = path.join(teamDir, "members", lead, "receipts.jsonl");
    const hasReceipt = fs.existsSync(receiptsFile) && fs.readFileSync(receiptsFile, "utf8").includes("team-message-");
    record("S4-F06b-lead-hook-injection", answer.includes(code1), {
      answer: answer.slice(0, 200),
      resumeMs: lead1.ms,
      hasReceipt,
    });
  }

  // S5 F11：interrupt 长任务 + 会话可续
  if (!SKIP.has("s5")) {
    progress("S5-start");
    toolJson(await daemon.callTool("spawn_teammate", {
      name: `s4-sleeper${TAG}`,
      description: "长任务",
      prompt: "长任务：请用 Bash 工具连续执行 12 次 `sleep 5`（每次先输出序号 i/12 再执行下一次），全部完成后另起一行输出 DONE-SLEEP。不要跳过任何一次。",
    }, meta));
    const sleeperName = `s4-sleeper${TAG}`;
    await waitFor(() => listRunningTurns(teamDir).some((t) => t.member === sleeperName), 60_000, "sleeper 起跑");
    await sleep(8000); // 确保运行中
    const intr = toolJson(await daemon.callTool("interrupt_agent", { target: sleeperName }, meta));
    await waitFor(() => !listRunningTurns(teamDir).some((t) => t.member === sleeperName), 15_000, "sleeper 终止");
    const resumed = toolJson(await daemon.callTool("send_message", {
      target: sleeperName,
      message: `之前的任务已中止，不用再执行剩余 sleep。请只回复 awake-${code2}。`,
    }, meta));
    void resumed;
    const memberDir = memberDirOf(teamDir, sleeperName);
    const origin = JSON.parse(fs.readFileSync(path.join(memberDir, "origin.json"), "utf8"));
    const awakeMs = await waitFor(() => assistantTexts(origin.sessionId).some((t) => t.includes(`awake-${code2}`)), 180_000, "sleeper 唤醒回答");
    record("S5-F11-interrupt-resume", intr.previousStatus === "running" && awakeMs < 180_000, { previousStatus: intr.previousStatus, awakeMs });
  }

  // S6 F02：fork（D3 转录注入）——teammate 答出 Lead 前轮暗号
  if (!SKIP.has("s6")) {
    progress("S6-start");
    const spawnRes = toolJson(await daemon.callTool("spawn_teammate", {
      name: `s4-fork${TAG}`,
      description: "fork 上下文",
      prompt: "在你的上下文里，Team Lead 之前记住的暗号是什么？只回复暗号本身。",
      context: "fork",
    }, meta));
    void spawnRes;
    const memberDir = memberDirOf(teamDir, `s4-fork${TAG}`);
    const origin = JSON.parse(fs.readFileSync(path.join(memberDir, "origin.json"), "utf8"));
    const answerMs = await waitFor(() => assistantTexts(origin.sessionId).some((t) => t.includes(code3)), 180_000, "fork 暗号");
    const firstTurn = JSON.parse(fs.readFileSync(path.join(memberDir, "run", "turn-1.json"), "utf8"));
    const transcriptBeforeTask = firstTurn.promptText.indexOf(code3) < firstTurn.promptText.indexOf("只回复暗号本身");
    record("S6-F02-fork-context", answerMs < 180_000 && transcriptBeforeTask, { answerMs, transcriptBeforeTask, memberRow: spawnRes.member });
  }

  // S7 F13：wait_agent 真实唤醒（teammate 完成任务事件）
  if (!SKIP.has("s7")) {
    progress("S7-start");
    toolJson(await daemon.callTool("team_task_create", { subject: "s7-唤醒", description: "s4-writer 完成后 complete" }, meta));
    const task = toolJson(await daemon.callTool("team_task_list", {}, meta));
    const taskId = task.tasks[0].id;
    const rev = task.tasks[0].revision;
    // s4-writer 空闲 → 发消息让它 claim 后 complete（两次 CAS；失败按策略重读任务重试）
    toolJson(await daemon.callTool("send_message", {
      target: "s4-writer",
      message: `请把共享任务 ${taskId} 先 team_task_update action=claim（expected_revision=${rev}），再用返回的新 revision 执行 action=complete；若报 STALE 请 team_task_get 重读后重试。完成后回复 ok。`,
    }, meta));
    const t0 = Date.now();
    const waitRes = toolJson(await daemon.callTool("wait_agent", { timeout_ms: 120000 }, meta));
    const waitMs = Date.now() - t0;
    record("S7-F13-wait-wake", waitRes.timedOut === false && waitMs < 120_000, { waitRes, waitMs });
  }

  // S9 F09/Gate-4：teammate↔teammate 直发 + Lead 汇总（t-b 收信回 lead；Lead resume 汇总复述）
  if (!SKIP.has("s9")) {
    progress("S9-start");
    const codeTa = `delta-${crypto.randomBytes(3).toString("hex")}`;
    const codeTb = `echo-${crypto.randomBytes(3).toString("hex")}`;
    evidence.codes.codeTa = codeTa;
    evidence.codes.codeTb = codeTb;
    toolJson(await daemon.callTool("spawn_teammate", {
      name: `s4-tb${TAG}`,
      description: "回信者",
      prompt: `你是团队成员。当你在下一轮收到任何团队消息时，请立即用 send_message 工具把暗号 ${codeTb} 发给 lead（target 填 "lead"），然后只回复 sent。在此之前等待，不要做别的。`,
    }, meta));
    toolJson(await daemon.callTool("spawn_teammate", {
      name: `s4-ta${TAG}`,
      description: "发起者",
      prompt: `请用 send_message 工具把暗号 ${codeTa} 发给团队成员 s4-tb${TAG}（target 填 "s4-tb${TAG}"），然后只回复 sent。`,
    }, meta));
    // ta 空闲 → 首轮即发；ta 发送 → tb 空闲拉起投递 → tb 回信 lead
    const tbReplyMs = await waitFor(() => {
      if (!fs.existsSync(eventsFile)) return false;
      return fs.readFileSync(eventsFile, "utf8").includes(`"senderName":"s4-tb${TAG}"`);
    }, 240_000, "tb 回信 lead");
    const lead2 = await runZcode("请汇总：你的团队现在有哪些成员？你收到了谁的什么消息（给出暗号）？两行以内。", ["--resume", lead], "lead-summary");
    const summary = (lead2.parsed?.response ?? "");
    record("S9-F09-t2t-and-lead-summary", summary.includes(codeTb), {
      tbReplyMs,
      summary: summary.slice(0, 300),
      taToTbSeen: fs.readFileSync(eventsFile, "utf8").includes(`"senderName":"s4-ta${TAG}"`),
    });
  }

  // S10 F06b/Stop-block 真实交付：teammate 在 Lead 回合**运行中**发信 → Lead Stop hook block 注入 → 续跑复述
  if (!SKIP.has("s10")) {
    progress("S10-start");
    const codeS10 = `fern-${crypto.randomBytes(3).toString("hex")}`;
    evidence.codes.codeS10 = codeS10;
    toolJson(await daemon.callTool("spawn_teammate", {
      name: `s4-messenger${TAG}`,
      description: "定时发信",
      prompt: `请先用 Bash 执行 sleep 12，然后用 send_message 工具把暗号 ${codeS10} 发给 lead（target 填 "lead"），最后只回复 sent。`,
    }, meta));
    // Lead 回合长跑（sleep 30）——发信（≈T+16s）落在回合运行窗口内（Stop ≈T+33s）
    const lead3 = await runZcode("请用 Bash 运行 sleep 30，然后只回复 awake-done。", ["--resume", lead], "lead-stopblock");
    const receiptsFile = path.join(teamDir, "members", lead, "receipts.jsonl");
    const receipts = fs.existsSync(receiptsFile) ? fs.readFileSync(receiptsFile, "utf8") : "";
    const stopReceipt = receipts.split("\n").filter((l) => l.includes('"channel":"stop"'));
    const leadTranscript = (function () {
      return true; // 占位——助手复述由 db 断言（下方 withDb 内联）
    })();
    void leadTranscript;
    const recited = withDb((db) =>
      db
        .prepare(
          `SELECT COUNT(*) n FROM message m JOIN part p ON p.message_id=m.id
           WHERE m.session_id=? AND json_extract(m.data,'$.role')='assistant' AND json_extract(p.data,'$.type')='text'
             AND json_extract(p.data,'$.text') LIKE ?`,
        )
        .get(lead, `%${codeS10}%`).n,
    );
    record("S10-F06b-stop-block-real", recited >= 1 && stopReceipt.length >= 1, {
      codeS10,
      stopReceiptLines: stopReceipt.length,
      assistantReciteHits: recited,
      leadMs: lead3.ms,
    });
  }

  // S8 F17：teammate transcript 洁净（无 team/* 事件原文；D10 注入不落 part 的口径复核）
  if (!SKIP.has("s8")) {
    progress("S8-start");
    const dirty = [];
    for (const m of fs.readdirSync(path.join(teamDir, "members"))) {
      const o = path.join(teamDir, "members", m, "origin.json");
      if (!fs.existsSync(o)) continue;
      const origin = JSON.parse(fs.readFileSync(o, "utf8"));
      if (!origin.sessionId) continue;
      const hits = partTextsLike(origin.sessionId, '%"team/member%') + partTextsLike(origin.sessionId, '%"team/task%') + partTextsLike(origin.sessionId, '%"team/message%');
      if (hits > 0) dirty.push({ member: origin.name, hits });
    }
    record("S8-F17-teammate-transcript-clean", dirty.length === 0, { dirty });
  }

  // V01：轮次进程可辨识（ps 快照）+ V03：provider.jsonl 关联字段
  const providerLog = path.join(DATA_ROOT, "logs", "provider.jsonl");
  evidence.v01_ps = listRunningTurns(teamDir);
  if (fs.existsSync(providerLog)) {
    const lines = fs.readFileSync(providerLog, "utf8").trim().split("\n").slice(-60);
    evidence.v03_provider_log_sample = lines.filter((l) => l.includes(lead)).slice(-12);
  }

  daemon.kill();
  finish();
}

function latestMessageIdTo(eventsFile, targetId) {
  if (!fs.existsSync(eventsFile)) return null;
  const lines = fs.readFileSync(eventsFile, "utf8").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]).event;
      if ((e.type === "team/message/queued" || e.type === "team/message") && e.message.targetId === targetId) return e.message.id;
    } catch {
      /* 跳过坏行 */
    }
  }
  return null;
}

function listRunningTurns(teamDir) {
  const membersRoot = path.join(teamDir, "members");
  if (!fs.existsSync(membersRoot)) return [];
  const out = [];
  for (const m of fs.readdirSync(membersRoot)) {
    const originFile = path.join(membersRoot, m, "origin.json");
    if (!fs.existsSync(originFile)) continue;
    const origin = JSON.parse(fs.readFileSync(originFile, "utf8"));
    const runDir = path.join(membersRoot, m, "run");
    if (!fs.existsSync(runDir)) continue;
    for (const f of fs.readdirSync(runDir)) {
      if (!/^turn-\d+\.json$/.test(f)) continue;
      const t = JSON.parse(fs.readFileSync(path.join(runDir, f), "utf8"));
      if (t.status === "running" || t.status === "starting") {
        out.push({ member: origin.name, turnId: t.turnId, pid: t.pid, promptTextPreview: t.promptText.slice(0, 60) });
      }
    }
  }
  return out;
}

function memberDirOf(teamDir, name) {
  const membersRoot = path.join(teamDir, "members");
  for (const m of fs.readdirSync(membersRoot)) {
    const o = path.join(membersRoot, m, "origin.json");
    if (fs.existsSync(o) && JSON.parse(fs.readFileSync(o, "utf8")).name === name) return path.join(membersRoot, m);
  }
  throw new Error(`member dir not found: ${name}`);
}

function finish() {
  evidence.finishedAt = now();
  evidence.pass = pass;
  const out = path.join(OUT, `stage4-real-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(out, JSON.stringify(evidence, null, 2));
  process.stdout.write(`\nSUMMARY pass=${pass} → ${out}\n`);
  daemonRef?.kill(); // 活子进程（daemon 管道）会使 node 事件循环不退——显式收口
  process.exit(pass ? 0 : 1);
}
let daemonRef = null;

main().catch((err) => {
  evidence.fatal = String(err?.stack ?? err);
  pass = false;
  finish();
});
