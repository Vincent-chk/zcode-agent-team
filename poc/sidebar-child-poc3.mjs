#!/usr/bin/env node
// Phase 0 PoC v3：项目 workspace 内的 anchor + child + anchor tombstone（tasks-index deleted=1）。
// 验证：child 为 selection_side_chat；anchor 行被 tombstone 隐藏；child 未入列；-p --resume 在项目 cwd 可工作。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const ZCODE = process.env.ZCODE_BIN ?? "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const DB_PATH = process.env.ZCODE_DB_PATH ?? path.join(os.homedir(), ".zcode/cli/db/db.sqlite");
const TASKS_INDEX = process.env.ZCODE_TASKS_INDEX ?? path.join(os.homedir(), ".zcode/v2/tasks-index.sqlite");
const WORKSPACE = process.env.POC_WORKSPACE ?? "/Volumes/Lexar/deepseek扩展开发";
const PROMPT = "请用 Bash 执行 pwd 和 head -c 60 agent-team/package.json，然后回复 pwd 与 name 字段。不要做其他事。";
const report = { workspace: WORKSPACE, steps: {}, pass: {}, errors: [] };
const t0 = Date.now();
const log = (k, v) => { report.steps[k] = v; console.log(`[${k}]`, JSON.stringify(v).slice(0, 1600)); };

const child = spawn(process.execPath, [ZCODE, "app-server"], { stdio: ["pipe", "pipe", "pipe"], env: process.env, cwd: WORKSPACE });
let buf = "", nextId = 1; const pending = new Map(), notifications = [];
child.stdout.on("data", (d) => {
  buf += d.toString(); let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1); if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); continue; }
    if (msg.method) { notifications.push(msg); if (msg.id !== undefined) { const result = msg.method === "session/requestRuntimePreferences" ? { nativeSearchEnhancementsEnabled: true, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true } : null; child.stdin.write(JSON.stringify({ id: msg.id, result }) + "\n"); } }
  }
});
let stderr = ""; child.stderr.on("data", (d) => { stderr += d.toString(); });
function rpc(method, params, timeoutMs = 60_000) { const id = nextId++; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error(`rpc timeout: ${method}`)); }, timeoutMs); pending.set(id, (m) => { clearTimeout(timer); if (m.error) { const e = new Error(m.error.message ?? "rpc error"); e.rpc = m.error; reject(e); } else resolve(m.result); }); child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); }); }
async function waitReady(timeoutMs = 30_000) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (notifications.some((n) => n.method === "startup/storageState" && n.params?.phase === "ready")) return true; await new Promise((r) => setTimeout(r, 100)); } return false; }
function close() { try { child.stdin.end(); } catch {} try { child.kill("SIGTERM"); } catch {} setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 1500).unref(); }
function q(sql, ...args) { const db = new DatabaseSync(DB_PATH, { readOnly: true }); try { return db.prepare(sql).all(...args); } finally { db.close(); } }
function idxGet(taskId) { const db = new DatabaseSync(TASKS_INDEX, { readOnly: true }); try { return db.prepare("select task_id, title, archived, deleted from tasks where task_id=?").get(taskId); } finally { db.close(); } }

/** 只对 anchor 自己写 tombstone：deleted=1；绝不触碰其他行。 */
function tombstoneAnchor(anchorId, workspacePath) {
  const db = new DatabaseSync(TASKS_INDEX);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    const now = Date.now();
    const title = "Agent Team anchor";
    const meta = JSON.stringify({ taskId: anchorId, title, workspacePath, createdAt: now, updatedAt: now, mode: "default", provider: "glm", status: "completed", titleOverridden: false });
    db.prepare(
      `INSERT INTO tasks (workspace_key, workspace_path, workspace_identity, task_id, title, task_status, provider, mode, model, created_at, updated_at, unread_at, last_unread_at, pinned, archived, deleted, title_overridden, searchable_text, meta_json)
       VALUES (?, ?, NULL, ?, ?, 'completed', 'glm', 'default', NULL, ?, ?, NULL, 0, 0, 0, 1, 0, ?, ?)
       ON CONFLICT(workspace_key, task_id) DO UPDATE SET deleted = 1, updated_at = excluded.updated_at
       WHERE tasks.task_id = excluded.task_id AND (tasks.title = '' OR tasks.title = 'Untitled session' OR tasks.title = 'Agent Team anchor')`,
    ).run(workspacePath, workspacePath, anchorId, title, now, now, title, meta);
    db.exec("COMMIT");
  } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; } finally { db.close(); }
}

function runTurn(sessionId, prompt, cwd, timeoutMs = 240_000) {
  return new Promise((resolve) => {
    const argv = [ZCODE, "-p", prompt, "--json", "--mode", "yolo", "--surface", "terminal", "--cwd", cwd, "--resume", sessionId];
    const c = spawn(process.execPath, argv, { cwd, env: process.env });
    let stdout = "", err = ""; c.stdout.on("data", (d) => { stdout += d.toString(); }); c.stderr.on("data", (d) => { err += d.toString(); });
    const timer = setTimeout(() => { try { c.kill("SIGKILL"); } catch {} }, timeoutMs);
    c.on("exit", (code) => { clearTimeout(timer); let parsed = null; try { parsed = JSON.parse(stdout); } catch {} resolve({ code, stdout: stdout.slice(0, 3000), stderr: err.slice(0, 2000), parsed }); });
  });
}

try {
  log("P0_ready", { ready: await waitReady(), elapsedMs: Date.now() - t0 });
  const ack = await rpc("v4/command", { commandId: `poc3-create-${Date.now()}`, clientId: "sidebar-child-poc3", sessionId: null, issuedAt: Date.now(), type: "createSession", payload: { workspaceId: WORKSPACE, permissionScope: "session" } });
  const anchorId = ack?.result?.sessionId ?? null;
  if (!anchorId) throw new Error(`anchor id missing: ${JSON.stringify(ack)}`);
  report.steps.anchorSessionId = anchorId;
  log("P1a_anchor", { anchorId, row: q("select id,task_type,parent_id,title,directory from session where id=?", anchorId)[0] });

  const side = await rpc("v4/command", { commandId: `poc3-side-${Date.now()}`, clientId: "sidebar-child-poc3", sessionId: anchorId, issuedAt: Date.now(), type: "createSelectionSideSession", payload: {} });
  const childId = side?.result?.sessionId ?? null;
  if (!childId) throw new Error(`child id missing: ${JSON.stringify(side)}`);
  report.steps.childSessionId = childId;
  const childRow = q("select id,task_type,parent_id,title,directory from session where id=?", childId)[0];
  log("P1b_child", childRow);
  report.pass.P1_child_kind = childRow?.task_type === "selection_side_chat" && childRow?.parent_id === anchorId;

  // anchor tombstone
  tombstoneAnchor(anchorId, WORKSPACE);
  report.steps.index_after_tombstone = { anchor: idxGet(anchorId), child: idxGet(childId) };
  report.pass.P6_anchor_tombstoned = idxGet(anchorId)?.deleted === 1;
  report.pass.P3_child_absent = idxGet(childId) === undefined;
  close();

  // 在项目 cwd 下 resume child（工具 cwd 必须 = 项目）
  const turn = await runTurn(childId, PROMPT, WORKSPACE);
  log("P2_turn", { code: turn.code, response: turn.parsed?.response ?? null, stderrTail: turn.stderr.slice(-400) });
  const resp = String(turn.parsed?.response ?? "");
  report.pass.P2_resume_turn = turn.code === 0 && resp.includes("deepseek扩展开发") && resp.includes("agent-team");

  const msgs = q("select id,data from message where session_id=? order by time_created", childId);
  const parts = q("select id,message_id,data from part where session_id=? order by time_created", childId);
  const realUser = msgs.filter((m) => { try { const d = JSON.parse(m.data); return d.semantics?.origin === "real_user"; } catch { return false; } });
  report.steps.messageSummary = { total: msgs.length, realUser: realUser.length, parts: parts.length };
  report.pass.P5_real_user_landed = realUser.length >= 2; // 首轮 + 本轮
  report.steps.totalMs = Date.now() - t0;
} catch (err) {
  report.errors.push(err instanceof Error ? err.message : String(err));
  console.error("[ERROR]", report.errors.at(-1));
} finally { close(); }

const fails = Object.entries(report.pass).filter(([, v]) => v !== true);
report.summary = { passCount: Object.values(report.pass).filter((v) => v === true).length, total: Object.keys(report.pass).length, failed: fails.map(([k]) => k), errors: report.errors.length, verdict: fails.length === 0 && report.errors.length === 0 ? "PASS" : "FAIL" };
console.log("\n=== SUMMARY ===");
console.log(JSON.stringify(report.summary, null, 2));
console.log(JSON.stringify(report, null, 2).slice(0, 12000));
const out = path.join("/tmp", `sidebar-child-poc3-${Date.now()}.json`);
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\nreport: ${out}`);
process.exitCode = report.summary.verdict === "PASS" ? 0 : 1;
