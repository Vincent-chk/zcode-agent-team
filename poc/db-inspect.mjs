// T1.4/H3 + H7：db.sqlite / tasks-index.sqlite 只读访问（node:sqlite，零原生依赖）
// 用法：
//   node poc/db-inspect.mjs schema              —— 表清单 + session/message/part DDL
//   node poc/db-inspect.mjs transcript <sessId> —— 导出会话转录（role + text 摘要 + part 类型）
//   node poc/db-inspect.mjs sessions [n]        —— 最近 n 个会话（id/status/task_type/task_type 判别）
//   node poc/db-inspect.mjs tasks-index         —— H7：tasks-index 行数与最新行 + 是否包含指定会话（env SESS_IDS=逗号分隔）
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DB_PATH = path.join(os.homedir(), ".zcode/cli/db/db.sqlite");
const TASKS_PATH = path.join(os.homedir(), ".zcode/v2/tasks-index.sqlite");

const [action, ...args] = process.argv.slice(2);
const db = new DatabaseSync(DB_PATH, { readOnly: true });

if (action === "schema") {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  console.log("tables:", tables.map((t) => t.name).join(", "));
  for (const t of ["session", "message", "part"]) {
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t);
    console.log(`\n-- ${t} --\n${ddl?.sql ?? "(missing)"}`);
  }
  console.log("\njournal_mode:", JSON.stringify(db.prepare("PRAGMA journal_mode").get()));
} else if (action === "transcript") {
  const id = args[0];
  const rows = db
    .prepare(
      `SELECT m.id msg_id, m.time_created, json_extract(m.data,'$.role') mrole,
              json_extract(p.data,'$.type') ptype,
              substr(COALESCE(json_extract(p.data,'$.text'), json_extract(p.data,'$.content'), p.data),1,300) text
       FROM message m JOIN part p ON p.message_id = m.id
       WHERE m.session_id = ? ORDER BY m.time_created, p.time_created`,
    )
    .all(id);
  console.log(`session ${id}: ${rows.length} parts`);
  for (const r of rows) console.log(`  [${r.mrole}/${r.ptype}] ${String(r.text).replace(/\n/g, "⏎").slice(0, 160)}`);
  const out = path.join("/tmp", `transcript-${id}.json`);
  fs.writeFileSync(out, JSON.stringify(rows, null, 2));
  console.log("full export →", out);
} else if (action === "sessions") {
  const n = Number(args[0] ?? 10);
  const rows = db.prepare("SELECT id, task_type, title, time_created, time_updated FROM session ORDER BY time_created DESC LIMIT ?").all(n);
  for (const r of rows) console.log(`  ${r.id} task_type=${r.task_type} title="${(r.title ?? "").slice(0, 40)}" ${new Date(r.time_created).toISOString()}`);
} else if (action === "tasks-index") {
  db.close();
  if (!fs.existsSync(TASKS_PATH)) { console.log("tasks-index.sqlite 不存在"); process.exit(0); }
  const t = new DatabaseSync(TASKS_PATH, { readOnly: true });
  const count = t.prepare("SELECT COUNT(*) n FROM tasks").get();
  console.log("tasks 总行数:", count.n);
  const recent = t.prepare("SELECT task_id, workspace_key, task_status, updated_at FROM tasks ORDER BY updated_at DESC LIMIT 8").all();
  for (const r of recent) console.log("  ", r.task_id, r.task_status, r.workspace_key);
  const wanted = (process.env.SESS_IDS ?? "").split(",").filter(Boolean);
  for (const s of wanted) {
    const hit = t.prepare("SELECT task_id, workspace_key, task_status FROM tasks WHERE task_id = ?").get(s);
    console.log(`H7: ${s} → ${hit ? "在 tasks-index 中 " + JSON.stringify(hit) : "不在 tasks-index 中"}`);
  }
  t.close();
} else {
  console.log("用法: node poc/db-inspect.mjs schema|transcript <id>|sessions [n]|tasks-index");
}
