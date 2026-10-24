// H10/H11 观测：daemon 空闲回收时序（SIGINT→SIGTERM→SIGKILL）与 isolation 池行为
// 用法：
//   node poc/h10-h11.mjs recycle        —— H10：触发 daemon → 空闲 → 观察优雅回收（graceful 模式）
//   node poc/h10-h11.mjs escalate       —— H10：signal-test 模式（忽略信号）→ 观察 SIGKILL 升级时序
//   node poc/h10-h11.mjs isolation       —— H11：两会话 + mcp/list → 统计 daemon 进程数（读当前 manifest）
//   node poc/h10-h11.mjs cross           —— H11 补充：两个 app-server 进程 → 统计 daemon 进程数
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ZCODE = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const WS = process.env.ZCODE_WS ?? "/tmp";
const DATA = process.env.TEAM_PLUGIN_DATA ?? path.join(process.env.HOME, ".zcode/cli/plugins/data/agent-team@inline");
const SIGNALS = path.join(DATA, "logs/signals.jsonl");
const LIFECYCLE = path.join(DATA, "logs/daemon-lifecycle.jsonl");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function daemonPids() {
  try {
    return execSync("pgrep -f 'team-daemon.mjs'", { encoding: "utf8" })
      .trim().split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function startAppServer() {
  const proc = spawn("node", [ZCODE, "app-server"], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  let nextId = 1;
  const pending = new Map();
  const notifications = [];
  let ready = false;
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method) {
        notifications.push(m);
        if (m.method === "startup/storageState" && m.params?.phase === "ready") ready = true;
        if (m.id !== undefined) {
          const result = m.method === "session/requestRuntimePreferences"
            ? { nativeSearchEnhancementsEnabled: true, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true }
            : {};
          proc.stdin.write(JSON.stringify({ id: m.id, result }) + "\n");
        }
      }
    }
  });
  return {
    proc,
    rpc(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
        proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    },
    async waitReady() {
      const dl = Date.now() + 15000;
      while (!ready && Date.now() < dl) await sleep(100);
    },
    kill() { try { proc.kill(); } catch {} },
  };
}

const WS_PARAM = { workspacePath: WS, workspaceKey: `file://${WS}` };

async function spawnDaemonViaMcpList(as) {
  const r = await as.rpc("mcp/list", { workspace: WS_PARAM });
  const st = r.statuses?.["plugin:agent-team:team-daemon"];
  console.log("[mcp/list] team-daemon:", JSON.stringify(st));
  return st;
}

function tailSignals() {
  try { return fs.readFileSync(SIGNALS, "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; }
}
function tailLifecycle() {
  try { return fs.readFileSync(LIFECYCLE, "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; }
}

const action = process.argv[2];

if (action === "recycle" || action === "escalate") {
  const escalate = action === "escalate";
  if (escalate) { fs.writeFileSync(path.join(DATA, "signal-test"), "1"); console.log("[mode] signal-test 已创建（daemon 将忽略 SIGINT/SIGTERM）"); }
  const before = tailSignals().length;
  const as = await startAppServer();
  await as.waitReady();
  const created = await as.rpc("session/create", { workspace: WS_PARAM });
  const sessId = created.session.sessionId;
  await spawnDaemonViaMcpList(as);
  // 先观察「引用持有」窗口 10s（预期：daemon 存活——引用计数，而非无流量即回收）
  await sleep(10000);
  const held = daemonPids();
  console.log(`[held] session 存活 + 无任何调用 10s 后 daemon pids=${held}（预期非空 = 引用持有保活）`);
  // 释放引用 → 空闲宽限计时开始
  try { await as.rpc("session/close", { sessionId: sessId }); console.log("[close] session/close 已应答"); }
  catch (e) { console.log("[close] session/close err:", e.message); }
  const t0 = Date.now();
  console.log(`[t0] 引用释放时刻：${new Date(t0).toISOString()}，等待空闲回收…`);
  let diedAt = null;
  while (Date.now() - t0 < 120000) {
    const pids = daemonPids().filter((p) => p !== process.pid);
    if (pids.length === 0) { diedAt = Date.now(); break; }
    await sleep(500);
  }
  const idleMs = diedAt ? diedAt - t0 : null;
  console.log(`[result] daemon 消失于 t0+${idleMs}ms（${diedAt ? new Date(diedAt).toISOString() : "120s 内未回收"}）`);
  await sleep(1000);
  const sigs = tailSignals().slice(before);
  console.log("[signals.jsonl 新增]", JSON.stringify(sigs));
  for (const s of sigs) {
    console.log(`  ${s.sig} @ ${s.ts}  (= t0+${new Date(s.ts).getTime() - t0}ms)`);
  }
  if (escalate) {
    const sigint = sigs.find((s) => s.sig === "SIGINT");
    const sigterm = sigs.find((s) => s.sig === "SIGTERM");
    if (sigint && sigterm) console.log(`[escalation] SIGINT→SIGTERM 间隔 ${new Date(sigterm.ts).getTime() - new Date(sigint.ts).getTime()}ms`);
    if (sigterm && diedAt) console.log(`[escalation] SIGTERM→死亡(SIGKILL) 间隔约 ${diedAt - new Date(sigterm.ts).getTime()}ms`);
    if (sigint && diedAt) console.log(`[grace 总时长] SIGINT→进程消失 ${diedAt - new Date(sigint.ts).getTime()}ms（对照 disposalTimeoutMs=5000）`);
    fs.rmSync(path.join(DATA, "signal-test"));
    console.log("[cleanup] signal-test 已移除");
  }
  as.kill();
} else if (action === "isolation" || action === "cross") {
  const mode = action === "isolation" ? "单 app-server 双会话" : "双 app-server 各一会话";
  console.log(`[H11] manifest 当前 isolation 字段：`, JSON.parse(fs.readFileSync(".mcp.json", "utf8")).mcpServers["team-daemon"].isolation ?? "(未声明)", `· 模式：${mode}`);
  const lcBefore = tailLifecycle().filter((l) => l.event === "startup").length;
  const servers = [];
  const n = action === "isolation" ? 1 : 2;
  for (let i = 0; i < n; i++) {
    const as = await startAppServer();
    await as.waitReady();
    servers.push(as);
  }
  const sA = servers[0];
  const cA = await sA.rpc("session/create", { workspace: WS_PARAM });
  console.log("[会话A]", cA.session.sessionId);
  await spawnDaemonViaMcpList(sA);
  if (action === "isolation") {
    const cB = await sA.rpc("session/create", { workspace: WS_PARAM });
    console.log("[会话B]", cB.session.sessionId);
    await spawnDaemonViaMcpList(sA);
  } else {
    const cB = await servers[1].rpc("session/create", { workspace: WS_PARAM });
    console.log("[会话B]", cB.session.sessionId);
    await spawnDaemonViaMcpList(servers[1]);
  }
  await sleep(1500);
  const pids = daemonPids();
  const startups = tailLifecycle().filter((l) => l.event === "startup");
  console.log(`[result] daemon 进程数=${pids.length}（pids=${pids}），lifecycle startups 新增=${startups.length - lcBefore}`);
  for (const s of servers) s.kill();
} else {
  console.log("用法: node poc/h10-h11.mjs recycle|escalate|isolation|cross");
}
process.exit(0);
