// stage-4 实证探针（三问）：
//  ① `-p` 新会话：首条 user 消息落 db.sqlite 的时延（相对 spawn），以及 --json 输出的时刻/形状；
//  ② teammate zcode 进程的自定义 env（TEAM_SPAWN_IDENTITY）是否被其 hook 子进程继承（hooks.jsonl env_overlay）；
//  ③ daemon 的父进程命令行能否发现 zcode.cjs（ps -o command= -p <ppid>）——此处用本进程演示 ps 调用形态。
// 用法：node poc/s4-probe.mjs  → 输出 /tmp/s4-probe/result.json
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const ZCODE = process.env.TEAM_ZCODE_BIN ?? "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const OUT = "/tmp/s4-probe";
const WS = path.join(OUT, "ws");
fs.mkdirSync(WS, { recursive: true });
const DB = path.join(os.homedir(), ".zcode/cli/db/db.sqlite");
const HOOKS_LOG = path.join(os.homedir(), ".zcode/cli/plugins/data/agent-team@inline/logs/hooks.jsonl");

const token = crypto.randomBytes(4).toString("hex");
const prompt = `探针 ${token}：只回复 ok。`;
const identity = JSON.stringify({ teamId: "sess_probe_team", memberId: "m-" + token, name: "probe-" + token });

const outFile = path.join(OUT, `turn-${token}.out`);
const fd = fs.openSync(outFile, "w");
const t0 = Date.now();
const child = spawn(
  process.execPath,
  [ZCODE, "-p", prompt, "--json", "--mode", "yolo", "--surface", "terminal", "--disallowed-tools", "Task", "--cwd", WS],
  { detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, TEAM_SPAWN_IDENTITY: identity } },
);
fs.closeSync(fd);
child.unref();
console.log(`[spawn] pid=${child.pid} t0=${new Date(t0).toISOString()} prompt=${JSON.stringify(prompt)}`);

const db = new DatabaseSync(DB, { readOnly: true });
let landedAt = null;
let sessionId = null;
let exitInfo = null;
child.on("exit", (code, signal) => {
  exitInfo = { code, signal, ms: Date.now() - t0 };
});

// 轮询落库
for (let i = 0; i < 1200 && landedAt === null; i++) {
  const row = db
    .prepare(
      `SELECT m.session_id sid, m.time_created tc FROM message m JOIN part p ON p.message_id = m.id
       WHERE json_extract(m.data,'$.role')='user' AND json_extract(p.data,'$.type')='text'
         AND json_extract(p.data,'$.text') = ? ORDER BY m.time_created DESC LIMIT 1`,
    )
    .get(prompt);
  if (row) {
    landedAt = Date.now();
    sessionId = row.sid;
    console.log(`[landed] +${landedAt - t0}ms session=${sessionId} (message.time_created=${new Date(row.tc).toISOString()})`);
  } else {
    await new Promise((r) => setTimeout(r, 100));
  }
}
// 等退出
while (exitInfo === null) await new Promise((r) => setTimeout(r, 200));
console.log(`[exit] code=${exitInfo.code} signal=${exitInfo.signal} +${exitInfo.ms}ms`);
const raw = fs.readFileSync(outFile, "utf8");
let parsed = null;
try {
  parsed = JSON.parse(raw);
} catch {}
console.log(`[json] keys=${parsed ? Object.keys(parsed).join(",") : "parse失败"} sessionId=${parsed?.sessionId} response=${JSON.stringify(parsed?.response ?? "").slice(0, 80)}`);

// 会话行 + 首条 user 消息
const sess = sessionId ? db.prepare("SELECT id, parent_id, directory, task_type, title FROM session WHERE id=?").get(sessionId) : null;
console.log(`[session]`, JSON.stringify(sess));
const firstUser = sessionId
  ? db
      .prepare(
        `SELECT m.id, m.sequence, json_extract(m.data,'$.semantics.origin') origin, json_extract(m.data,'$.modelSelection.modelId') model
         FROM message m WHERE m.session_id=? AND json_extract(m.data,'$.role')='user' ORDER BY m.sequence LIMIT 3`,
      )
      .all(sessionId)
  : [];
console.log(`[first-user]`, JSON.stringify(firstUser));
db.close();

// ② hooks.jsonl 里该会话的 sessionstart 行是否含 TEAM_SPAWN_IDENTITY
await new Promise((r) => setTimeout(r, 500));
const lines = fs.existsSync(HOOKS_LOG) ? fs.readFileSync(HOOKS_LOG, "utf8").trim().split("\n") : [];
const mine = lines
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter((r) => r && r.input_session_id === sessionId);
const envSeen = mine.map((r) => ({ event: r.event, source: r.source, TEAM_SPAWN_IDENTITY: r.env_overlay?.TEAM_SPAWN_IDENTITY ?? null, keys: Object.keys(r.env_overlay ?? {}).filter((k) => k.startsWith("TEAM_")) }));
console.log(`[hooks] ${mine.length} 行:`, JSON.stringify(envSeen));

// ③ ppid 发现形态
const ppidCmd = execFileSync("ps", ["-o", "command=", "-p", String(process.ppid)], { encoding: "utf8" }).trim();
console.log(`[ppid] ${process.ppid} → ${ppidCmd.slice(0, 160)}`);

const result = { token, prompt, pid: child.pid, landedMs: landedAt ? landedAt - t0 : null, sessionId, exit: exitInfo, jsonKeys: parsed ? Object.keys(parsed) : null, session: sess, firstUser, hooks: envSeen, ppidCmd };
fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
console.log(`→ ${OUT}/result.json`);
