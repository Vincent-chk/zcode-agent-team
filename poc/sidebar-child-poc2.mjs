#!/usr/bin/env node
// Phase 0 PoC v2：用 v4 `createSession`（permissionScope=session）创建「已持久化空 anchor」，
// 再在其下创建 selection_side_chat child；验证 child 隐藏 + `-p --resume` 可驱动。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ZCODE = process.env.ZCODE_BIN ?? "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const DB_PATH = process.env.ZCODE_DB_PATH ?? path.join(os.homedir(), ".zcode/cli/db/db.sqlite");
const TASKS_INDEX = process.env.ZCODE_TASKS_INDEX ?? path.join(os.homedir(), ".zcode/v2/tasks-index.sqlite");
const WORKSPACE = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-sidebar-poc2-"));
const PROMPT = "只回复 POC2-HIDDEN-CHILD-OK 这一串字符，不要调用任何工具，不要解释。";
const report = { workspace: WORKSPACE, steps: {}, pass: {}, errors: [] };
const t0 = Date.now();
const log = (k, v) => { report.steps[k] = v; console.log(`[${k}]`, JSON.stringify(v).slice(0, 1600)); };

const child = spawn(process.execPath, [ZCODE, "app-server"], { stdio: ["pipe", "pipe", "pipe"], env: process.env, cwd: WORKSPACE });
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
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); continue; }
    if (msg.method) {
      notifications.push(msg);
      if (msg.id !== undefined) {
        const result = msg.method === "session/requestRuntimePreferences"
          ? { nativeSearchEnhancementsEnabled: true, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true }
          : null;
        child.stdin.write(JSON.stringify({ id: msg.id, result }) + "\n");
      }
    }
  }
});
let stderr = "";
child.stderr.on("data", (d) => { stderr += d.toString(); });
function rpc(method, params, timeoutMs = 60_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`rpc timeout: ${method}`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(timer); if (m.error) { const e = new Error(m.error.message ?? "rpc error"); e.rpc = m.error; reject(e); } else resolve(m.result); });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
async function waitReady(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (notifications.some((n) => n.method === "startup/storageState" && n.params?.phase === "ready")) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
function close() { try { child.stdin.end(); } catch {} try { child.kill("SIGTERM"); } catch {} setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 1500).unref(); }

function dbRead(sql, ...args) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}
function indexRead(taskId) {
  const db = new DatabaseSync(TASKS_INDEX, { readOnly: true });
  try { return db.prepare("select task_id, title, archived, deleted from tasks where task_id=?").get(taskId); } finally { db.close(); }
}
function runTurn(sessionId, prompt, timeoutMs = 240_000) {
  return new Promise((resolve) => {
    const argv = [ZCODE, "-p", prompt, "--json", "--mode", "yolo", "--surface", "terminal", "--cwd", WORKSPACE, "--resume", sessionId];
    const c = spawn(process.execPath, argv, { cwd: WORKSPACE, env: process.env });
    let stdout = "", err = "";
    c.stdout.on("data", (d) => { stdout += d.toString(); });
    c.stderr.on("data", (d) => { err += d.toString(); });
    const timer = setTimeout(() => { try { c.kill("SIGKILL"); } catch {} }, timeoutMs);
    c.on("exit", (code) => {
      clearTimeout(timer);
      let parsed = null; try { parsed = JSON.parse(stdout); } catch {}
      resolve({ code, stdout: stdout.slice(0, 3000), stderr: err.slice(0, 2000), parsed });
    });
  });
}

try {
  log("P0_ready", { ready: await waitReady(), elapsedMs: Date.now() - t0, stderr: stderr.slice(0, 300) });

  // 1) v4 createSession（permissionScope 强制持久化空会话）
  const ack = await rpc("v4/command", {
    commandId: `poc2-create-${Date.now()}`,
    clientId: "sidebar-child-poc2",
    sessionId: null,
    issuedAt: Date.now(),
    type: "createSession",
    payload: { workspaceId: WORKSPACE, permissionScope: "session" },
  });
  log("P1a_create_anchor", { ack });
  const anchorId = ack?.result?.sessionId ?? null;
  if (!anchorId) throw new Error(`anchor id missing: ${JSON.stringify(ack)}`);
  report.steps.anchorSessionId = anchorId;

  const anchorRows = dbRead("select id, task_type, parent_id, title, directory, (select count(*) from message where session_id=session.id) as msgs from session where id=?", anchorId);
  log("P1b_anchor_row", anchorRows);

  // 2) 在 anchor 下创建 hidden child
  const sideAck = await rpc("v4/command", {
    commandId: `poc2-side-${Date.now()}`,
    clientId: "sidebar-child-poc2",
    sessionId: anchorId,
    issuedAt: Date.now(),
    type: "createSelectionSideSession",
    payload: {},
  });
  log("P1c_side", { sideAck });
  const childId = sideAck?.result?.sessionId ?? null;
  if (!childId) throw new Error(`child id missing: ${JSON.stringify(sideAck)}`);
  report.steps.childSessionId = childId;

  const childRows = dbRead("select id, task_type, parent_id, title, directory, (select count(*) from message where session_id=session.id) as msgs from session where id=?", childId);
  log("P1d_child_row", childRows);
  report.pass.P1_child_kind = childRows[0]?.task_type === "selection_side_chat";
  report.pass.P1_child_parent = childRows[0]?.parent_id === anchorId;
  report.pass.P1_anchor_empty = (anchorRows[0]?.msgs ?? -1) === 0;

  // 3) tasks-index 创建时点
  report.steps.index_before = { anchor: indexRead(anchorId), child: indexRead(childId) };
  report.pass.P3_child_absent = indexRead(childId) === undefined;

  close();

  // 4) -p --resume child 真实一轮
  const turn = await runTurn(childId, PROMPT);
  const msgs = dbRead("select id, data from message where session_id=? order by time_created", childId);
  const parts = dbRead("select id, message_id, data from part where session_id=? order by time_created", childId);
  const roleByMsg = new Map(msgs.map((m) => { let role=null; try{role=JSON.parse(m.data).role}catch{} return [m.id, role]; }));
  const firstUser = parts.find((p) => roleByMsg.get(p.message_id) === "user" && String(p.data).includes("\"text\""));
  let firstUserText = null;
  try { firstUserText = JSON.parse(firstUser.data).text; } catch {}
  log("P2_turn", { code: turn.code, response: turn.parsed?.response ?? null, firstUserText, msgs: msgs.length, parts: parts.length, stderrTail: turn.stderr.slice(-400) });
  report.pass.P2_resume_turn = turn.code === 0 && firstUserText === PROMPT;

  // 5) 泄漏扫描（boundary reminder 是否出现）
  const needles = ["history_continuity", "selection_side_chat", "system-reminder", "inherited from the parent", "Do not continue the parent"];
  const hits = [];
  for (const p of parts) {
    const s = String(p.data);
    for (const n of needles) if (s.includes(n)) hits.push({ needle: n, excerpt: s.slice(0, 500) });
  }
  log("P4_scan", { hits: hits.slice(0, 6), total: hits.length });
  report.pass.P4_boundary_documented = hits.length >= 0; // 记录，不阻塞

  report.steps.index_after = { anchor: indexRead(anchorId), child: indexRead(childId) };
  report.pass.P3_child_absent_after_turn = indexRead(childId) === undefined;

  // 6) child 的可见消息（detail 数据源）
  report.pass.P5_detail_data = msgs.length >= 2 && firstUserText === PROMPT;
  report.steps.totalMs = Date.now() - t0;
} catch (err) {
  report.errors.push(err instanceof Error ? `${err.message}` : String(err));
  console.error("[ERROR]", report.errors.at(-1));
} finally { close(); }

const fails = Object.entries(report.pass).filter(([, v]) => v !== true);
report.summary = { passCount: Object.values(report.pass).filter((v) => v === true).length, total: Object.keys(report.pass).length, failed: fails.map(([k]) => k), errors: report.errors.length, verdict: fails.length === 0 && report.errors.length === 0 ? "PASS" : "FAIL" };
console.log("\n=== SUMMARY ===");
console.log(JSON.stringify(report.summary, null, 2));
console.log(JSON.stringify(report, null, 2).slice(0, 14000));
const out = path.join("/tmp", `sidebar-child-poc2-${Date.now()}.json`);
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\nreport: ${out}`);
process.exitCode = report.summary.verdict === "PASS" ? 0 : 1;
