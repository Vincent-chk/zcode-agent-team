// stage-4 崩溃矩阵（T4.6 五类真实进程故障；stage-6 回归复用）：
//   C1 kill teammate 轮次中进程（kill -9）→ 边界定案 + pending 重投（--resume）→ delivered；
//   C2 kill 协调者（kill -9 daemon）→ 接任（锁过期 ≤5.5s）+ run/ 纳管 → 剧本续跑；
//   C3 kill 成员 daemon（proxy 模式）→ 协调者不受影响；
//   C4 模拟宿主回收（SIGINT→260ms→SIGKILL）→ 轮次进程存活（独立进程组）+ 接任续跑；
//   C5 断电模拟（写盘 burst 中 kill -9）→ journal O_APPEND 一致：重放干净或显式 fail-closed，
//      delivered ⊆ messages 恒成立，pending 重投完成。
// 用法：node scripts/crash-matrix.mjs [--out <evidence.json>]
// 输出：每类一行 {verdict,...} + 末行 {summary, pass}；--out 把全量 JSON 写入证据文件。
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const proj = path.resolve(__dirname, "..");
const TEAM = "sess_s4_crash_lead";

const outIdx = process.argv.indexOf("--out");
const outFile = outIdx !== -1 ? process.argv[outIdx + 1] : null;

const results = [];
function record(cls, pass, details) {
  results.push({ class: cls, pass, details });
  process.stdout.write(JSON.stringify({ verdict: cls, pass, details }) + "\n");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function createTestDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, task_type TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER);
    CREATE INDEX message_session_sequence_idx ON message (session_id, sequence, time_created, id);
    CREATE INDEX part_session_idx ON part (session_id);
    CREATE INDEX part_message_sequence_idx ON part (message_id, sequence, time_created, id);
  `);
  db.close();
}

// ---------------------------------------------------------------- daemon 孵化（stdin/stdout NDJSON 协议）

function makeHandle(child) {
  const events = [];
  const waiters = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  // 被 kill 后仍可能有在途写（C5 断电窗口）→ 吞 stdin 的 EPIPE，避免脚本自身崩掉
  child.stdin.on("error", () => undefined);
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      events.push(evt);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].type === evt.type) {
          clearTimeout(waiters[i].timer);
          waiters[i].resolve(evt);
          waiters.splice(i, 1);
        }
      }
    }
  });
  return {
    child,
    pid: child.pid,
    events,
    exited: new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal }))),
    waitFor(type, timeoutMs = 20000) {
      const existing = [...events].reverse().find((e) => e.type === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting daemon event: ${type}`)), timeoutMs);
        waiters.push({ type, timer, resolve, reject });
      });
    },
    send(obj) {
      // 进程可能刚被 kill（C5 断电窗口）→ stdin 写会异步报 EPIPE；吞掉，由后续断言判定业务结果
      try {
        child.stdin.write(JSON.stringify(obj) + "\n");
      } catch {
        /* stdin 已关闭 */
      }
    },
    kill(sig = "SIGKILL") {
      try {
        process.kill(this.pid, sig);
      } catch {
        /* 已退出 */
      }
    },
  };
}

async function spawnDaemon(dir, env, lockWaitMs) {
  const argv = [path.join(dir, "crash-daemon.mjs"), "--root", dir, "--team", TEAM, "--lock-wait", String(lockWaitMs)];
  const child = execFile(
    process.execPath,
    argv,
    { env: { ...process.env, ...env, TEAM_DB_PATH: path.join(dir, "db.sqlite") }, maxBuffer: 64 * 1024 * 1024 },
    () => undefined,
  );
  const handle = makeHandle(child);
  await handle.waitFor("ready");
  return handle;
}

async function boardOf(d) {
  const idx = d.events.length;
  d.send({ op: "board" });
  for (const deadline = Date.now() + 10000; Date.now() < deadline; ) {
    await sleep(30);
    for (let i = idx; i < d.events.length; i++) {
      if (d.events[i].type === "board") return d.events[i];
      if (d.events[i].type === "board-error") throw new Error(d.events[i].message);
    }
  }
  throw new Error("board timeout");
}

async function dispatchOk(d, method, params, timeoutMs = 30000) {
  const idx = d.events.length;
  d.send({ op: "dispatch", method, params });
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
    await sleep(40);
    for (let i = idx; i < d.events.length; i++) {
      if (d.events[i].type === "dispatch-ok" && d.events[i].method === method) return d.events[i].result;
      if (d.events[i].type === "dispatch-error" && d.events[i].method === method) {
        throw new Error(`dispatch ${method} failed: ${d.events[i].message}`);
      }
    }
  }
  throw new Error(`dispatch ${method} timeout`);
}

async function waitFor(fn, timeoutMs, what) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
    if (await fn()) return;
    await sleep(60);
  }
  throw new Error(`waitFor timeout: ${what}`);
}

// ---------------------------------------------------------------- run/ 记录读取（最小实现，与 member-files 同构）

function membersRoot(dir) {
  return path.join(dir, "data", "teams", TEAM, "members");
}
function memberIds(dir) {
  return fs.readdirSync(membersRoot(dir)).filter((n) => !n.startsWith("."));
}
function currentTurn(dir, memberId) {
  const runDir = path.join(membersRoot(dir), memberId, "run");
  const current = JSON.parse(fs.readFileSync(path.join(runDir, "current.json"), "utf8"));
  const record = JSON.parse(fs.readFileSync(path.join(runDir, `${current.turnId}.json`), "utf8"));
  return { turnId: current.turnId, record };
}
function allTurns(dir, memberId) {
  const runDir = path.join(membersRoot(dir), memberId, "run");
  return fs
    .readdirSync(runDir)
    .filter((n) => /^turn-\d+\.json$/.test(n))
    .map((n) => JSON.parse(fs.readFileSync(path.join(runDir, n), "utf8")));
}

function baseEnv(dir, extra = {}) {
  return { TEAM_PLUGIN_DATA: path.join(dir, "data"), ...extra };
}

function newDir() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-s4-crash-"));
  createTestDb(path.join(dir, "db.sqlite"));
  fs.mkdirSync(path.join(dir, "ws"), { recursive: true });
  return dir;
}

// ---------------------------------------------------------------- 五类矩阵

async function c1KillTurnProcess(bundleTo) {
  const dir = newDir();
  await bundleTo(dir);
  const env = baseEnv(dir, { FAKE_ZCODE_SLEEP_MS: "6000" });
  const d = await spawnDaemon(dir, env, 15000);
  try {
    await dispatchOk(d, "member.spawn", { session_id: TEAM, name: "alpha", description: "d", prompt: "task-1" });
    const sent = (await dispatchOk(d, "message.send", { session_id: TEAM, targetName: "alpha", content: [{ type: "text", text: "c1-msg" }] })).messageId;
    const memberId = memberIds(dir)[0];
    const t1 = currentTurn(dir, memberId);
    process.kill(t1.record.pid, "SIGKILL"); // C1：轮次中进程 kill -9
    await waitFor(() => {
      const deliverTurn = allTurns(dir, memberId).find((t) => t.kind === "deliver" && t.messageIds.includes(sent));
      return deliverTurn !== undefined && deliverTurn.landed === true;
    }, 25000, "C1 redelivered turn landed");
    const board = await boardOf(d);
    record("C1-kill-turn-process", board.delivered.includes(sent) && !pidAlive(t1.record.pid), {
      killedPid: t1.record.pid,
      zombie: pidAlive(t1.record.pid),
      delivered: board.delivered,
    });
  } finally {
    d.kill();
    await d.exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function c2KillCoordinator(bundleTo) {
  const dir = newDir();
  await bundleTo(dir);
  const env = baseEnv(dir, { FAKE_ZCODE_SLEEP_MS: "6000" });
  const a = await spawnDaemon(dir, env, 15000);
  let b = null;
  try {
    await dispatchOk(a, "member.spawn", { session_id: TEAM, name: "beta", description: "d", prompt: "task-2" });
    const sent = (await dispatchOk(a, "message.send", { session_id: TEAM, targetName: "beta", content: [{ type: "text", text: "c2-msg" }] })).messageId;
    a.kill("SIGKILL"); // C2：协调者 kill -9（锁残留 → 过期接任）
    const t0 = Date.now();
    b = await spawnDaemon(dir, env, 15000);
    const takeoverMs = Date.now() - t0;
    const ready = b.events.find((e) => e.type === "ready");
    if (ready.mode !== "coordinator") throw new Error("daemon B not coordinator after takeover");
    const board1 = await boardOf(b);
    const pendingPreserved = board1.messages.includes(sent);
    await waitFor(async () => (await boardOf(b)).delivered.includes(sent), 30000, "C2 pending redelivered after takeover");
    const board2 = await boardOf(b);
    record("C2-kill-coordinator-takeover", pendingPreserved && board2.delivered.includes(sent), {
      takeoverMs,
      pendingPreserved,
      delivered: board2.delivered,
    });
  } finally {
    b?.kill();
    await (b?.exited ?? Promise.resolve());
    a.kill();
    await a.exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function c3KillProxyDaemon(bundleTo) {
  const dir = newDir();
  await bundleTo(dir);
  const env = baseEnv(dir, {});
  const a = await spawnDaemon(dir, env, 15000); // 协调者
  try {
    await dispatchOk(a, "member.spawn", { session_id: TEAM, name: "gamma", description: "d", prompt: "task-3" });
    const proxy = await spawnDaemon(dir, env, 0); // 抢不到锁 → proxy
    proxy.kill("SIGKILL"); // C3：proxy（成员侧）daemon kill -9
    await proxy.exited;
    await sleep(300);
    const board = await boardOf(a); // 协调者不受影响
    const spawn2 = await dispatchOk(a, "member.spawn", { session_id: TEAM, name: "delta", description: "d", prompt: "task-3b" });
    record("C3-kill-proxy-daemon", board.members.length >= 1 && spawn2.member !== undefined, {
      coordinatorAlive: true,
      members: board.members.map((m) => `${m.name}:${m.phase}`),
    });
  } finally {
    a.send({ op: "close" });
    await a.exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function c4HostRecycle(bundleTo) {
  const dir = newDir();
  await bundleTo(dir);
  const env = baseEnv(dir, { FAKE_ZCODE_SLEEP_MS: "10000" });
  const a = await spawnDaemon(dir, env, 15000);
  let b = null;
  try {
    await dispatchOk(a, "member.spawn", { session_id: TEAM, name: "eps", description: "d", prompt: "task-4" });
    const memberId = memberIds(dir)[0];
    const t1 = currentTurn(dir, memberId);
    a.kill("SIGINT"); // 宿主回收第一步（graceful 尽力：checkpoint + drain 标记）
    await sleep(260);
    a.kill("SIGKILL"); // H10 实测宽限 ~260ms 后强杀
    await a.exited;
    await sleep(300);
    const turnAliveAfterRecycle = pidAlive(t1.record.pid); // 独立进程组：daemon 回收不连带杀轮次
    b = await spawnDaemon(dir, env, 15000);
    const board = await boardOf(b);
    const phase = board.members.find((m) => m.name === "eps")?.phase;
    record("C4-host-recycle-sigint-sigkill", turnAliveAfterRecycle && phase === "active", {
      turnPid: t1.record.pid,
      turnAliveAfterRecycle,
      memberPhaseAfterAdopt: phase,
    });
  } finally {
    if (b) {
      b.send({ op: "close" });
      await b.exited;
      const memberId = memberIds(dir)[0];
      try {
        const t = currentTurn(dir, memberId);
        if (t.record.pid) process.kill(-t.record.pid, "SIGKILL");
      } catch {
        /* 组可能已退 */
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function c5PowerLossMidwrite(bundleTo) {
  const dir = newDir();
  await bundleTo(dir);
  const env = baseEnv(dir, { FAKE_ZCODE_SLEEP_MS: "1200" });
  const a = await spawnDaemon(dir, env, 15000);
  let b = null;
  try {
    await dispatchOk(a, "member.spawn", { session_id: TEAM, name: "zeta", description: "d", prompt: "task-5" });
    // burst 写入 + 中途 kill -9（O_APPEND 断电窗口）
    const burst = (async () => {
      for (let i = 0; i < 30; i++) {
        a.send({ op: "dispatch", method: "message.send", params: { session_id: TEAM, targetName: "zeta", content: [{ type: "text", text: `c5-${i}` }] } });
        await sleep(15);
      }
    })();
    await sleep(220);
    a.kill("SIGKILL");
    await burst.catch(() => undefined);
    await a.exited;
    b = await spawnDaemon(dir, env, 15000); // 恢复：全量重放 + 对账 + pending 重投
    const board = await boardOf(b);
    const replayOk =
      board.failure === undefined || board.failure.startsWith("persisted Agent Teams");
    const deliveredSubset = board.delivered.every((id) => board.messages.includes(id));
    await waitFor(async () => {
      const cur = await boardOf(b);
      return cur.delivered.length === cur.messages.length;
    }, 60000, "C5 all pending redelivered");
    const final = await boardOf(b);
    record("C5-power-loss-midwrite", replayOk && deliveredSubset && final.delivered.length === final.messages.length, {
      replayFailure: board.failure ?? null,
      messages: final.messages.length,
      delivered: final.delivered.length,
      consistent: replayOk && deliveredSubset,
    });
  } finally {
    if (b) {
      b.send({ op: "close" });
      await b.exited;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- 入口

async function main() {
  // bundle crash-daemon（TS → 目标目录 mjs；每次矩阵运行自包含）+ detach-helper 资产 sibling
  const bundleTo = async (dir) => {
    await build({
      entryPoints: [path.join(proj, "test/provider/crash-daemon.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      outfile: path.join(dir, "crash-daemon.mjs"),
      logLevel: "silent",
    });
    fs.copyFileSync(path.join(proj, "src/provider/detach-helper.mjs"), path.join(dir, "detach-helper.mjs"));
    fs.copyFileSync(path.join(proj, "test/provider/fake-zcode.mjs"), path.join(dir, "fake-zcode.mjs"));
  };

  await c1KillTurnProcess(bundleTo);
  await c2KillCoordinator(bundleTo);
  await c3KillProxyDaemon(bundleTo);
  await c4HostRecycle(bundleTo);
  await c5PowerLossMidwrite(bundleTo);

  const pass = results.every((r) => r.pass);
  const summary = { summary: "stage-4 crash matrix", pass, classes: results.map((r) => ({ cls: r.class, pass: r.pass })), ts: new Date().toISOString() };
  process.stdout.write(JSON.stringify(summary) + "\n");
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2));
    process.stdout.write(`evidence → ${outFile}\n`);
  }
  process.exitCode = pass ? 0 : 1;
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ summary: "stage-4 crash matrix", pass: false, error: String(err && err.message ? err.message : err), partial: results }) + "\n");
  process.exitCode = 1;
});
