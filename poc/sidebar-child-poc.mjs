#!/usr/bin/env node
// Phase 0 硬门 PoC：验证「原生隐藏子会话」路线可行（P1–P7）。
// 步骤：
//   1) spawn `zcode app-server`（NDJSON）→ 等 startup/storageState ready
//   2) session/create：draft anchor（persistence=deferred，parentSessionId=Lead）
//   3) v4/command createSelectionSideSession → childSessionId
//   4) 读 db.sqlite（只读）核对 child 行 task_type/parent_id
//   5) 查 tasks-index.sqlite（只读）确认 child 未入列
//   6) `zcode -p --resume <child> "<probe>"` 真实一轮，核对首条 real_user 逐字落库
//   7) 扫 child 全部 part，检查是否有 Lead 历史 / boundary reminder 泄漏
// 输出：JSON 报告 + 人读摘要。不修改任何数据库（只读打开）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ZCODE = process.env.ZCODE_BIN ?? "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const LEAD_SESSION = process.env.POC_LEAD_SESSION ?? "sess_68052df5-df1b-4aad-acdf-ab41ca944ffc";
const DB_PATH = process.env.ZCODE_DB_PATH ?? path.join(os.homedir(), ".zcode/cli/db/db.sqlite");
const TASKS_INDEX = process.env.ZCODE_TASKS_INDEX ?? path.join(os.homedir(), ".zcode/v2/tasks-index.sqlite");
const WORKSPACE = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-sidebar-poc-"));
const PROMPT = "只回复 POC-HIDDEN-CHILD-OK 这一串字符，不要调用任何工具，不要解释。";
const TIMEOUT_MS = Number(process.env.POC_TIMEOUT_MS ?? 240_000);

const report = { leadSession: LEAD_SESSION, workspace: WORKSPACE, steps: {}, pass: {}, errors: [] };
const t0 = Date.now();
const log = (k, v) => {
  report.steps[k] = v;
  console.log(`[${k}]`, JSON.stringify(v).slice(0, 1200));
};

// ---------------------------------------------------------------- app-server 客户端
function startAppServer() {
  const child = spawn(process.execPath, [ZCODE, "app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
    cwd: WORKSPACE,
  });
  let buf = "";
  let nextId = 1;
  const pending = new Map();
  const notifications = [];
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
        continue;
      }
      if (msg.method) {
        notifications.push(msg);
        if (msg.id !== undefined) {
          // server→client 请求：回默认偏好，避免挂起
          const result =
            msg.method === "session/requestRuntimePreferences"
              ? { nativeSearchEnhancementsEnabled: true, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true }
              : null;
          child.stdin.write(JSON.stringify({ id: msg.id, result }) + "\n");
        }
      }
    }
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
  const rpc = (method, params, timeoutMs = 60_000) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }, timeoutMs);
      pending.set(id, (m) => {
        clearTimeout(timer);
        if (m.error) {
          const e = new Error(m.error.message ?? "rpc error");
          e.rpc = m.error;
          reject(e);
        } else resolve(m.result);
      });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  };
  const waitReady = async (timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = notifications.find((n) => n.method === "startup/storageState" && n.params?.phase === "ready");
      if (ready) return ready;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };
  const close = () => {
    try { child.stdin.end(); } catch {}
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 1500).unref();
  };
  return { child, rpc, waitReady, close, notifications, getStderr: () => stderr };
}

function sessionIdOf(created) {
  return created?.session?.sessionId ?? created?.session?.id ?? created?.sessionId ?? created?.id ?? null;
}

// ---------------------------------------------------------------- db 只读探针
function readChildRow(sessionId) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const row = db
      .prepare("select id, task_type, parent_id, title, directory, time_created from session where id = ?")
      .get(sessionId);
    const msgs = db
      .prepare("select id, data from message where session_id = ? order by time_created asc")
      .all(sessionId);
    const parts = db
      .prepare("select id, message_id, data from part where session_id = ? order by time_created asc")
      .all(sessionId);
    return { row, msgs, parts };
  } finally {
    db.close();
  }
}

function readTaskIndexRow(taskId) {
  const db = new DatabaseSync(TASKS_INDEX, { readOnly: true });
  try {
    return db.prepare("select task_id, workspace_path, title, archived, deleted from tasks where task_id = ?").get(taskId);
  } finally {
    db.close();
  }
}

function runTurn(sessionId, prompt) {
  return new Promise((resolve) => {
    const argv = [ZCODE, "-p", prompt, "--json", "--mode", "yolo", "--surface", "terminal", "--cwd", WORKSPACE, "--resume", sessionId];
    const child = spawn(process.execPath, argv, { cwd: WORKSPACE, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, TIMEOUT_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      let parsed = null;
      try { parsed = JSON.parse(stdout); } catch {}
      resolve({ code, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 4000), parsed });
    });
  });
}

// ---------------------------------------------------------------- 主流程
const srv = startAppServer();
try {
  const ready = await srv.waitReady();
  log("P0_ready", { ready: ready !== null, elapsedMs: Date.now() - t0, stderr: srv.getStderr().slice(0, 500) });

  // P1：anchor + child
  const createStart = Date.now();
  const anchor = await srv.rpc("session/create", {
    workspace: { workspacePath: WORKSPACE, workspaceKey: `file://${WORKSPACE}` },
    persistence: "deferred",
    parentSessionId: LEAD_SESSION,
  });
  const anchorId = sessionIdOf(anchor);
  log("P1a_anchor", { anchorId, response: anchor, elapsedMs: Date.now() - createStart });
  if (!anchorId) throw new Error("anchor session id missing");

  const commandId = `poc-side-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ack = await srv.rpc("v4/command", {
    commandId,
    clientId: "sidebar-child-poc",
    sessionId: anchorId,
    issuedAt: Date.now(),
    type: "createSelectionSideSession",
    payload: {},
  });
  log("P1b_command", { ack });
  const childId = ack?.result?.sessionId ?? null;
  if (!childId) throw new Error(`child session id missing: ${JSON.stringify(ack)}`);
  report.steps.childSessionId = childId;
  // 第二个 child（P6 并发/多 child）
  const child2Id = (await srv.rpc("v4/command", {
    commandId: `poc-side2-${Date.now()}`,
    clientId: "sidebar-child-poc",
    sessionId: anchorId,
    issuedAt: Date.now(),
    type: "createSelectionSideSession",
    payload: {},
  }))?.result?.sessionId ?? null;
  report.steps.child2SessionId = child2Id;

  const row1 = readChildRow(childId);
  const row2 = child2Id ? readChildRow(child2Id) : null;
  log("P1c_db_rows", {
    child: row1.row,
    child2: row2?.row ?? null,
    anchor: readChildRow(anchorId).row,
  });
  report.pass.P1_child_kind = row1.row?.task_type === "selection_side_chat";
  report.pass.P1_child_parent = row1.row?.parent_id === anchorId;
  report.pass.P1_anchor_draft_parent = readChildRow(anchorId).row?.parent_id === LEAD_SESSION;

  // P3（创建后、跑轮次前）：tasks-index 不含 child
  report.steps.tasksIndex_before = {
    child: readTaskIndexRow(childId),
    child2: child2Id ? readTaskIndexRow(child2Id) : null,
    anchor: readTaskIndexRow(anchorId),
  };
  report.pass.P3_task_index_absent_before = readTaskIndexRow(childId) === undefined;

  srv.close();

  // P2：真实一轮 -p --resume child
  const turn = await runTurn(childId, PROMPT);
  const afterTurn = readChildRow(childId);
  const userTexts = afterTurn.parts
    .filter((p) => {
      try { return JSON.parse(p.data)?.type === "text"; } catch { return false; }
    })
    .map((p) => { try { return JSON.parse(p.data).text; } catch { return ""; } });
  const roleByMsg = new Map(afterTurn.msgs.map((m) => {
    let role = null, origin = null;
    try { const d = JSON.parse(m.data); role = d.role; origin = d.semantics?.origin ?? null; } catch {}
    return [m.id, { role, origin }];
  }));
  const firstUserPart = afterTurn.parts.find((p) => {
    const info = roleByMsg.get(p.message_id);
    if (info?.role !== "user") return false;
    try { return JSON.parse(p.data)?.type === "text"; } catch { return false; }
  });
  const firstUserText = firstUserPart ? (() => { try { return JSON.parse(firstUserPart.data).text; } catch { return null; } })() : null;
  log("P2_turn", {
    code: turn.code,
    response: turn.parsed?.response ?? null,
    stderrTail: turn.stderr.slice(-600),
    firstUserText,
    messageCount: afterTurn.msgs.length,
    partCount: afterTurn.parts.length,
  });
  report.pass.P2_resume_turn = turn.code === 0 && firstUserText === PROMPT;
  report.pass.P2_first_user_exact = firstUserText === PROMPT;

  // P4：上下文泄漏扫描（hidden history / boundary reminder）
  const leakNeedles = ["history_continuity", "selection_side_chat", "system-reminder", "inherited history", "Lead", LEAD_SESSION];
  const leakHits = [];
  for (const p of afterTurn.parts) {
    const s = String(p.data);
    for (const n of leakNeedles) {
      if (s.includes(n)) leakHits.push({ partId: p.id, needle: n, excerpt: s.slice(0, 400) });
    }
  }
  log("P4_leak_scan", { hits: leakHits.slice(0, 10), totalHits: leakHits.length });
  report.pass.P4_no_lead_history = !leakHits.some((h) => h.needle === LEAD_SESSION);

  // P3（跑完轮次后）：tasks-index 仍不含 child
  const idxAfter = { child: readTaskIndexRow(childId), child2: child2Id ? readTaskIndexRow(child2Id) : null };
  log("P3_after_turn", idxAfter);
  report.pass.P3_task_index_absent_after = idxAfter.child === undefined;

  // P5：detail 数据可用（消息流非空 + 首条文本）
  report.pass.P5_detail_data = afterTurn.msgs.length >= 2 && firstUserText === PROMPT;

  report.pass.P6_multi_child = child2Id !== null && child2Id !== childId;
  report.pass.P7_latency = Date.now() - t0 < 240_000;
  report.steps.totalMs = Date.now() - t0;
} catch (err) {
  report.errors.push(err instanceof Error ? `${err.message}${err.stack ? "\n" + err.stack.split("\n").slice(0, 4).join("\n") : ""}` : String(err));
  console.error("[ERROR]", report.errors.at(-1));
} finally {
  try { srv.close(); } catch {}
}

const failed = Object.entries(report.pass).filter(([, v]) => v !== true);
report.summary = {
  passCount: Object.values(report.pass).filter((v) => v === true).length,
  total: Object.keys(report.pass).length,
  failed: failed.map(([k]) => k),
  verdict: failed.length === 0 && report.errors.length === 0 ? "PASS" : "FAIL",
};
console.log("\n=== SUMMARY ===");
console.log(JSON.stringify(report.summary, null, 2));
console.log(JSON.stringify(report, null, 2).slice(0, 12000));
const out = path.join("/tmp", `sidebar-child-poc-${Date.now()}.json`);
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\nreport: ${out}`);
process.exitCode = report.summary.verdict === "PASS" ? 0 : 1;
