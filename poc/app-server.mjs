// app-server harness：spawn `zcode app-server`（NDJSON，ZCode Protocol v1）
// 报文形状（实测）：请求 {id, method, params}（无 jsonrpc 键！）；通知 {method, params}；响应 {id, result|error}
// 启动时 server 先推 startup/storageState 通知若干条。
// 用法：
//   node poc/app-server.mjs probe                     —— initialize + session/create + mcp/list + plugins/listUiSurfaces（零模型配额）
//   node poc/app-server.mjs send <sessId> "<prompt>"   —— 对指定会话发一轮 prompt（走模型）
//   node poc/app-server.mjs running-send <sessId> "<prompt>" —— 负例：对运行中会话 send（预期 -32010）
//   node poc/app-server.mjs stop <sessId>              —— 停止运行中会话
//   node poc/app-server.mjs fork <sessId>              —— fork 会话（H3）
//   node poc/app-server.mjs messages <sessId>          —— 读消息转录
//   node poc/app-server.mjs events <sessId>            —— 读事件
//   node poc/app-server.mjs subscribe <sessId> <secs>  —— 订阅事件流 <secs> 秒并录制
//   node poc/app-server.mjs longrun <sessId>           —— 长任务发起（配合 stop 观察）
// 环境变量：ZCODE_WS（会话工作目录，默认 /tmp）、RECORD_DIR（报文录制目录）
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ZCODE = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
const WS = process.env.ZCODE_WS ?? "/tmp";
const RECORD_DIR = process.env.RECORD_DIR ?? "/tmp/app-server-records";
fs.mkdirSync(RECORD_DIR, { recursive: true });
const recordFile = path.join(RECORD_DIR, `record-${Date.now()}.jsonl`);
const record = fs.createWriteStream(recordFile, { flags: "a" });

const proc = spawn("node", [ZCODE, "app-server"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
let buf = "";
let nextId = 1;
const pending = new Map();
const notifications = [];

proc.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error("NON-JSON:", line.slice(0, 300));
      continue;
    }
    record.write(JSON.stringify({ dir: "in", msg }) + "\n");
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      notifications.push(msg);
      // server→client 请求（如 session/requestRuntimePreferences）：按 zcodeSessionRuntimePreferencesResultSchema 回默认值
      if (msg.id !== undefined) {
        const result =
          msg.method === "session/requestRuntimePreferences"
            ? { nativeSearchEnhancementsEnabled: true, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: true }
            : null;
        record.write(JSON.stringify({ dir: "out", msg: { id: msg.id, result } }) + "\n");
        proc.stdin.write(JSON.stringify({ id: msg.id, result }) + "\n");
      }
    }
  }
});
proc.stderr.on("data", (d) => process.stderr.write("[app-server-stderr] " + d));

function rpc(method, params) {
  const id = nextId++;
  record.write(JSON.stringify({ dir: "out", msg: { id, method, params } }) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, (m) => (m.error ? reject(Object.assign(new Error(m.error.message ?? "rpc error"), { rpc: m.error })) : resolve(m.result)));
    proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function init() {
  // ZCode Protocol 无 MCP 式 initialize 握手：等待 storageState ready 即可用
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const ready = notifications.find((n) => n.method === "startup/storageState" && n.params?.phase === "ready");
    if (ready) return ready;
    await sleep(100);
  }
  return null;
}

async function createSession() {
  return rpc("session/create", { workspace: { workspacePath: WS, workspaceKey: process.env.ZCODE_WS_KEY ?? `file://${WS}` } });
}

const [action, ...args] = process.argv.slice(2);
const t0 = Date.now();
try {
  const initRes = await init();
  console.log("[startup]", initRes ? "storage ready" : "no ready signal (continuing)");

  if (action === "probe") {
    const created = await createSession();
    console.log("[session/create]", JSON.stringify(created).slice(0, 1600));
    const sessId = created.session?.id ?? created.sessionId ?? created.id ?? created.projection?.sessionId;
    const ws = { workspace: { workspacePath: WS, workspaceKey: process.env.ZCODE_WS_KEY ?? `file://${WS}` } };
    for (const m of ["mcp/list", "plugins/list", "plugins/listUiSurfaces"]) {
      try { console.log(`[${m}]`, JSON.stringify(await rpc(m, ws)).slice(0, 2400)); }
      catch (e) { console.log(`[${m}] ERR`, e.message.slice(0, 200), JSON.stringify(e.rpc ?? {}).slice(0, 300)); }
    }
    await rpc("session/close", { sessionId: sessId }).catch(() => {});
  } else if (action === "send" || action === "running-send") {
    const [sessId, prompt] = args;
    try {
      const r = await rpc("session/send", { sessionId: sessId, prompt });
      console.log(`[session/send ${action}]`, JSON.stringify(r).slice(0, 800));
    } catch (e) {
      console.log(`[session/send ${action}] REJECTED:`, e.message, JSON.stringify(e.rpc ?? {}));
    }
  } else if (action === "stop") {
    const [sessId] = args;
    try { console.log("[session/stop]", JSON.stringify(await rpc("session/stop", { sessionId: sessId })).slice(0, 400)); }
    catch (e) { console.log("[session/stop] ERR", e.message, JSON.stringify(e.rpc ?? {})); }
  } else if (action === "fork") {
    const [sessId] = args;
    try { console.log("[session/fork]", JSON.stringify(await rpc("session/fork", { sessionId: sessId })).slice(0, 800)); }
    catch (e) { console.log("[session/fork] ERR", e.message, JSON.stringify(e.rpc ?? {})); }
  } else if (action === "messages") {
    const [sessId] = args;
    console.log("[session/messages]", JSON.stringify(await rpc("session/messages", { sessionId: sessId })).slice(0, 3000));
  } else if (action === "events") {
    const [sessId] = args;
    console.log("[session/events]", JSON.stringify(await rpc("session/events", { sessionId: sessId })).slice(0, 2000));
  } else if (action === "subscribe") {
    const [sessId, secs] = args;
    await rpc("session/subscribe", { sessionId: sessId });
    console.log(`[session/subscribe] ok, recording ${secs ?? 5}s...`);
    await sleep(Number(secs ?? 5) * 1000);
    console.log(`[notifications] ${notifications.length} 条（已录制）`);
    for (const n of notifications.slice(0, 5)) console.log("  notif:", JSON.stringify(n).slice(0, 200));
  } else if (action === "h5") {
    // 复合：长任务 → 运行中 send（预期 -32010）→ session/stop → 空闲 send → session/fork（H3）
    const created = await createSession();
    const sessId = created.session.sessionId;
    console.log("[session/create]", sessId);
    const longP = rpc("session/send", { sessionId: sessId, content: "长任务：先在当前目录创建文件 at-checkpoint.txt 内容为 hello-team，然后从 1 数到 200 每行一个数字，数完输出暗号 harbor-as-2。" })
      .then((r) => console.log("[长任务 send 完成]", JSON.stringify(r).slice(0, 300)))
      .catch((e) => console.log("[长任务 send 异常]", e.message, JSON.stringify(e.rpc ?? {})));
    await sleep(9000); // 让轮次跑起来
    try {
      await rpc("session/send", { sessionId: sessId, content: "打断测试：你现在能看到这条吗？" });
      console.log("[运行中 send] 意外成功（与已证事实冲突！）");
    } catch (e) {
      console.log("[运行中 send 被拒 ✓]", e.message, "code=", e.rpc?.code, JSON.stringify(e.rpc?.data ?? {}).slice(0, 200));
    }
    try { console.log("[session/stop]", JSON.stringify(await rpc("session/stop", { sessionId: sessId })).slice(0, 300)); }
    catch (e) { console.log("[session/stop] ERR", e.message, JSON.stringify(e.rpc ?? {})); }
    await longP.catch(() => {});
    await sleep(2000);
    try {
      const after = await rpc("session/send", { sessionId: sessId, content: "只回答一行：你刚才的长任务是否被中止了？" });
      console.log("[stop 后空闲 send ✓]", JSON.stringify(after).slice(0, 400));
    } catch (e) { console.log("[stop 后 send] ERR", e.message, JSON.stringify(e.rpc ?? {})); }
    try {
      const forked = await rpc("session/fork", { sessionId: sessId });
      console.log("[session/fork]", JSON.stringify(forked).slice(0, 800));
    } catch (e) { console.log("[session/fork] ERR", e.message, JSON.stringify(e.rpc ?? {})); }
    try { console.log("[session/messages]", JSON.stringify(await rpc("session/messages", { sessionId: sessId })).slice(0, 600)); } catch (e) { console.log("[messages] ERR", e.message.slice(0, 120)); }
    await rpc("session/close", { sessionId: sessId }).catch(() => {});
  } else if (action === "forkflow") {
    // H3：yolo 会话完成文件写入（产生 workspace checkpoint）→ fork → 验证新会话
    const created = await createSession();
    const S = created.session.sessionId;
    console.log("[create]", S);
    try { console.log("[setMode yolo]", JSON.stringify(await rpc("session/setMode", { sessionId: S, mode: "yolo" })).slice(0, 150)); }
    catch (e) { console.log("[setMode ✗]", e.message.slice(0, 120)); }
    await rpc("session/send", { sessionId: S, content: "请创建文件 /tmp/fork-probe.txt，内容为一行 fork-ok。完成后只回复 done。" });
    let status = "?";
    for (let i = 0; i < 45; i++) {
      await sleep(2000);
      try { const rd = await rpc("session/read", { sessionId: S }); status = rd.session?.status; if (status === "idle") break; } catch { status = "read-err"; break; }
    }
    const { existsSync } = await import("node:fs");
    console.log("[轮次状态]", status, "文件存在:", existsSync("/tmp/fork-probe.txt"));
    try {
      const f = await rpc("session/fork", { sessionId: S });
      console.log("[fork ✓]", JSON.stringify(f).slice(0, 700));
      const fid = f.session?.sessionId ?? f.sessionId;
      if (fid) {
        const msgs = await rpc("session/messages", { sessionId: fid }).catch(() => null);
        console.log("[fork 会话消息数（历史继承?）]", msgs?.messages?.length ?? "n/a");
        const { DatabaseSync } = await import("node:sqlite");
        const { homedir } = await import("node:os");
        const { join } = await import("node:path");
        const db = new DatabaseSync(join(homedir(), ".zcode/cli/db/db.sqlite"), { readOnly: true });
        console.log("[db] fork 行:", JSON.stringify(db.prepare("SELECT id, task_type, parent_id FROM session WHERE id=?").get(fid)));
        db.close();
      }
    } catch (e) { console.log("[fork ✗]", e.message.slice(0, 140), JSON.stringify(e.rpc ?? {}).slice(0, 150)); }
    await rpc("session/close", { sessionId: S }).catch(() => {});
  } else {
    console.log("unknown action:", action);
  }
} catch (e) {
  console.log(`[action ${action}] FAILED:`, e.message, JSON.stringify(e.rpc ?? {}));
  process.exitCode = 1;
} finally {
  console.log(`[record] ${recordFile} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  record.end();
  proc.kill();
  process.exit(0);
}
