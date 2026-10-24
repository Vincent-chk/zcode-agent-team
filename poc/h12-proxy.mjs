// H12 代理验证（零 UI）：经宿主（app-server）建立对 team-daemon 的 resources/subscribe，
// 保持订阅挂起 ≥75s（无任何工具调用），观察宿主是否回收 daemon。
// 面板的数据通路 = 同一宿主订阅管道，此处为无 UI 的等价压力测试。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ZCODE = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const DATA = path.join(process.env.HOME, ".zcode/cli/plugins/data/agent-team@inline");
const LIFE = path.join(DATA, "logs/daemon-lifecycle.jsonl");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startups() {
  try { return fs.readFileSync(LIFE, "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; }
}
function daemons() {
  try { return require("node:child_process").execSync("pgrep -f team-daemon.mjs", { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return []; }
}

const proc = spawn("node", [ZCODE, "app-server"], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "", nid = 1, ready = false;
const pend = new Map();
const notes = [];
function rpc(method, params) {
  const id = nid++;
  return new Promise((res, rej) => {
    pend.set(id, (m) => (m.error ? rej(Object.assign(new Error(m.error.message), { rpc: m.error })) : res(m.result)));
    proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
proc.stdout.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!l) continue;
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    else if (m.method) {
      notes.push({ method: m.method, ts: Date.now() });
      if (m.method === "startup/storageState" && m.params?.phase === "ready") ready = true;
      if (m.id !== undefined) proc.stdin.write(JSON.stringify({ id: m.id, result: { nativeSearchEnhancementsEnabled: true, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true } }) + "\n");
    }
  }
});
const dl = Date.now() + 15000;
while (!ready && Date.now() < dl) await sleep(100);

const W = { workspace: { workspacePath: "/tmp", workspaceKey: "file:///tmp" } };
const created = await rpc("session/create", W);
console.log("[session]", created.session.sessionId);
await rpc("mcp/list", W); // 连接 daemon（宿主侧引用建立）
await sleep(1500);
const base = startups().filter((l) => l.event === "startup").length;
const t0 = Date.now();
console.log(`[t0] 订阅前 daemon pids=${daemons()}，开始尝试宿主侧订阅…`);

// 宿主侧订阅：尝试 mcp/uiSubscribeResource（面板同款方法族）
let subscribed = false;
for (const [method, params] of [
  ["mcp/uiSubscribeResource", { serverName: "plugin:agent-team:team-daemon", uri: "team://view", ...W }],
  ["mcp/uiSubscribeResource", { name: "plugin:agent-team:team-daemon", uri: "team://view" }],
  ["mcp/readResource", { serverName: "plugin:agent-team:team-daemon", uri: "team://view", ...W }],
]) {
  try {
    const r = await rpc(method, params);
    console.log(`[${method}] OK:`, JSON.stringify(r).slice(0, 200));
    if (method.includes("Subscribe")) subscribed = true;
    break;
  } catch (e) {
    console.log(`[${method}] ✗`, e.message.slice(0, 100), "code=", e.rpc?.code);
  }
}

// 无论订阅方法是否可用：观察 75s 内 daemon 存活/回收（session 引用保持 + 无工具调用）
let lastErr = null;
for (let s = 0; s <= 75; s += 5) {
  await sleep(5000);
  const alive = daemons();
  const st = startups().filter((l) => l.event === "startup").length;
  if (s % 15 === 0) console.log(`[t+${s}s] daemon=${alive.length}(${alive.join(",")}) startups Δ=${st - base} 通知=${notes.length}`);
  if (alive.length === 0) { lastErr = `daemon 全部消失于 t+${s}s`; break; }
}
const finalStartups = startups().filter((l) => l.event === "startup").length;
console.log(`[result] 75s 观察：daemon 最终=${daemons().length}，新增 startup=${finalStartups - base}，宿主侧订阅可用=${subscribed}`);
console.log(`[H12 语义] session 存活（引用持有）+ 无工具调用 + ${subscribed ? "宿主侧订阅挂起" : "无订阅"} → daemon ${daemons().length > 0 ? "存活（未被回收）" : "被回收"}`);
proc.kill();
process.exit(0);
