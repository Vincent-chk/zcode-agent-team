// daemon 冒烟测试：不走宿主，直接 stdio JSON-RPC 握手 → tools/list → tools/call(带 _meta) → resources/read → subscribe
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DAEMON = path.resolve(import.meta.dirname, "..", "dist", "team-daemon.mjs");
const DATA = fs.mkdtempSync(path.join("/tmp", "agent-team-smoke-"));

const proc = spawn("node", [DAEMON], {
  env: {
    ...process.env,
    TEAM_PLUGIN_DATA: DATA,
    TEAM_PROJECT_DIR: "/tmp",
    TEAM_MAX_MEMBERS: "8",
    TEAM_MAX_TASKS: "256",
    TEAM_MAX_PENDING_MESSAGES_PER_MEMBER: "64",
    TEAM_MAX_MESSAGE_BYTES: "65536",
    TEAM_DISPOSAL_TIMEOUT_MS: "5000",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
const pending = new Map();
let nextId = 1;
const notifications = [];

proc.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      } else if (msg.method) {
        notifications.push(msg);
      }
    } catch {
      console.error("NON-JSON on stdout:", line.slice(0, 200));
      process.exitCode = 1;
    }
  }
});
proc.stderr.on("data", (d) => process.stderr.write("[daemon-stderr] " + d));

function rpc(method, params, _meta) {
  const id = nextId++;
  const p = params ?? {};
  const payload = { jsonrpc: "2.0", id, method, params: _meta ? { ...p, _meta } : p };
  return new Promise((resolve) => {
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify(payload) + "\n");
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) initialize
const init = await rpc("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0.0.1" },
});
console.log("== initialize ==", JSON.stringify(init.result?.serverInfo), "capabilities:", JSON.stringify(init.result?.capabilities));
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

// 2) tools/list
const tools = await rpc("tools/list");
console.log("== tools ==", tools.result.tools.map((t) => `${t.name}(visibility=${t.visibility ?? "model"})`).join(", "));

// 3) tools/call with _meta
const ping = await rpc(
  "tools/call",
  { name: "team_ping", arguments: { echo: "smoke" } },
  { session_id: "sess_smoke_0001", turn_id: "turn_smoke_1", workspace_path: "/tmp", client_mode: "smoke" },
);
const pingBody = JSON.parse(ping.result.content[0].text);
console.log("== team_ping ==", JSON.stringify({ pong: pingBody.pong, identity: pingBody.identity, config: pingBody.config, nodeWarn: pingBody.runtime.nodeWarn }));
if (pingBody.pong !== true || pingBody.identity.session_id !== "sess_smoke_0001") { console.error("FAIL: ping identity"); process.exitCode = 1; }

// 4) config invalid path (TEAM_MAX_MEMBERS=0)
// —— 独立进程测
{
  const proc2 = spawn("node", [DAEMON], {
    env: { ...process.env, TEAM_PLUGIN_DATA: DATA + "-bad", TEAM_MAX_MEMBERS: "0" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let b2 = "";
  const pend2 = new Map();
  let id2 = 1;
  proc2.stdout.on("data", (d) => {
    b2 += d.toString();
    let i;
    while ((i = b2.indexOf("\n")) >= 0) {
      const l = b2.slice(0, i).trim();
      b2 = b2.slice(i + 1);
      if (!l) continue;
      const m = JSON.parse(l);
      if (m.id !== undefined && pend2.has(m.id)) { pend2.get(m.id)(m); pend2.delete(m.id); }
    }
  });
  const rpc2 = (method, params) => {
    const id = id2++;
    return new Promise((res) => { pend2.set(id, res); proc2.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  };
  await rpc2("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke2", version: "0" } });
  proc2.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const bad = await rpc2("tools/call", { name: "team_ping", arguments: {} });
  const text = bad.result?.content?.[0]?.text ?? "";
  console.log("== invalid config ==", bad.result?.isError === true && text.includes("TEAM_INVALID_CONFIG") ? "OK readable diagnostic" : "FAIL: " + text.slice(0, 120));
  if (!(bad.result?.isError === true && text.includes("TEAM_INVALID_CONFIG"))) process.exitCode = 1;
  proc2.kill();
}

// 5) resources/read panel + view（stage-5：team://view = 真实投影视图帧；
//    无团队事件 → team:null 空帧，面板呈现加载/不可用通知条）
const panel = await rpc("resources/read", { uri: "ui://agent-team/team-panel.html" });
console.log("== panel resource ==", `${panel.result.contents[0].text.length} bytes, mimeType=${panel.result.contents[0].mimeType}`);
if (panel.result.contents[0].text.length < 10000) { console.error("FAIL: panel too small"); process.exitCode = 1; }
const view = await rpc("resources/read", { uri: "team://view" });
const viewFrame = JSON.parse(view.result.contents[0].text);
console.log("== view resource ==", JSON.stringify({ type: viewFrame.type, stateVersion: viewFrame.stateVersion, team: viewFrame.team, members: viewFrame.members.length, tasks: viewFrame.tasks.length }));
if (viewFrame.type !== "view" || viewFrame.stateVersion !== 4) { console.error("FAIL: view frame shape"); process.exitCode = 1; }

// 6) subscribe → 视图变化推帧（stage-5 F02 口径：内容变化才推；mailbox-only/无变化不推）
const sub = await rpc("resources/subscribe", { uri: "team://view" });
console.log("== subscribe ==", JSON.stringify(sub.result));
await sleep(1200);
const before = notifications.filter((n) => n.method === "notifications/resources/updated").length;
// 6a) 团队变更（task.create 经 9 工具面）→ 500ms 轮询应在 ≤1s 推帧
const created = await rpc(
  "tools/call",
  { name: "team_task_create", arguments: { subject: "smoke 任务", description: "stage-5 推帧验证" } },
  { session_id: "sess_smoke_0001", turn_id: "turn_smoke_2" },
);
if (created.result?.isError === true) { console.error("FAIL: task_create", created.result.content?.[0]?.text); process.exitCode = 1; }
let pushed = 0;
for (let i = 0; i < 30 && pushed === 0; i++) {
  await sleep(200);
  pushed = notifications.filter((n) => n.method === "notifications/resources/updated").length - before;
}
console.log("== pushed frames after task.create (≤6s) ==", pushed, pushed >= 1 ? "OK" : "FAIL");
if (pushed < 1) process.exitCode = 1;
// 6b) 静默期：无变化 → 不推帧（1.5s 观察窗，500ms 轮询 ≥3 次机会）
const quietBefore = notifications.filter((n) => n.method === "notifications/resources/updated").length;
await sleep(1500);
const quiet = notifications.filter((n) => n.method === "notifications/resources/updated").length - quietBefore;
console.log("== pushed frames while quiet (1.5s) ==", quiet, quiet === 0 ? "OK" : "FAIL");
if (quiet !== 0) process.exitCode = 1;
// 6c) 快照基线落盘（teams/<id>/ui/view-snapshot.json）
const snapFile = path.join(DATA, "teams", "sess_smoke_0001", "ui", "view-snapshot.json");
const snapOk = fs.existsSync(snapFile);
console.log("== view-snapshot.json ==", snapOk ? "OK" : "FAIL", snapFile);
if (!snapOk) process.exitCode = 1;
// 6d) 面板回环（stage-5：refresh → 全量视图帧；心跳 label-only 基线不回归）
const refreshCall = await rpc(
  "tools/call",
  { name: "team_panel_call", arguments: { action: "refresh" } },
  { session_id: "sess_smoke_0001" },
);
const refreshBody = JSON.parse(refreshCall.result.content[0].text);
console.log("== panel refresh ==", JSON.stringify({ ok: refreshBody.ok, tasks: refreshBody.frame?.tasks?.length, team: refreshBody.frame?.team?.status }));
if (refreshBody.ok !== true || refreshBody.frame?.tasks?.length !== 1) { console.error("FAIL: panel refresh frame"); process.exitCode = 1; }
const hb = await rpc(
  "tools/call",
  { name: "team_panel_call", arguments: { label: "smoke-heartbeat" } },
  { session_id: "sess_smoke_0001" },
);
const hbBody = JSON.parse(hb.result.content[0].text);
console.log("== panel heartbeat ==", JSON.stringify(hbBody));
if (hbBody.ok !== true || hbBody.label !== "smoke-heartbeat") { console.error("FAIL: heartbeat baseline"); process.exitCode = 1; }

// 7) meta 落盘证据
const metaLog = path.join(DATA, "logs", "meta-log.jsonl");
const metaFiles = fs.readdirSync(path.join(DATA, "meta"));
console.log("== evidence files ==", `meta-log.jsonl exists=${fs.existsSync(metaLog)}, meta/ files=${metaFiles.length}`);

// 8) SIGINT graceful
proc.kill("SIGINT");
await sleep(300);
const signals = fs.readFileSync(path.join(DATA, "logs", "signals.jsonl"), "utf8").trim();
console.log("== SIGINT ==", signals);

console.log("SMOKE", process.exitCode ? "FAILED" : "PASSED");
process.exit(process.exitCode ?? 0);
