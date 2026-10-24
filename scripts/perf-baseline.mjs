#!/usr/bin/env node
// SF10 性能基线（T6.3 七指标）：
//   ① spawn 冷启动（spawn 调用 → 会话落定）
//   ② 投递延迟：空闲（send→delivered）/ 运行中（轮次边界→delivered）
//   ③ wait 唤醒延迟（轮次退出→wait 返回）
//   ④ 面板渲染（8 成员 + 20 任务 → HTML 渲染 ≤500ms）
//   ⑤ 协调者 RSS（8 成员）；⑥ 1 万行事件重放；⑦ daemon 冷启动 → 可服务。
// 确定性执行器 = fake-zcode（零模型成本）；门槛超出即非零退出。
// 用法：node scripts/perf-baseline.mjs
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { PROJ, createTestSessionDb, loadConfig, startDaemon, writeResult } from "./e2e/common.mjs";

const cfg = loadConfig();
createTestSessionDb(cfg.dbPath);
const checks = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (n) => Math.round(n * 100) / 100;
function step(text) {
  process.stdout.write(`… ${text}\n`);
}
function record(id, value, threshold, ok, extra = {}) {
  checks.push({ id, value, threshold, ok, ...extra });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${id} = ${value}${threshold !== null ? ` (阈值 ${threshold})` : ""}\n`);
}

function teamEvents(teamDir) {
  try {
    return fs
      .readFileSync(path.join(teamDir, "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
async function waitUntil(fn, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await fn()) return Date.now() - startedAt;
    await sleep(30);
  }
  throw new Error(`timeout ${timeoutMs}ms: ${label}`);
}
function memberDirOf(teamDir, name) {
  try {
    return fs
      .readdirSync(path.join(teamDir, "members"))
      .map((id) => path.join(teamDir, "members", id))
      .find((dir) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, "origin.json"), "utf8")).name === name;
        } catch {
          return false;
        }
      });
  } catch {
    return undefined;
  }
}
function turnStatuses(memberDir) {
  try {
    return fs
      .readdirSync(path.join(memberDir, "run"))
      .filter((f) => /^turn-\d+\.json$/.test(f))
      .map((f) => JSON.parse(fs.readFileSync(path.join(memberDir, "run", f), "utf8")));
  } catch {
    return [];
  }
}
function deliveredCount(teamDir) {
  return teamEvents(teamDir).filter((line) => line.event?.type === "team/message/delivered").length;
}

// ---------------------------------------------------------------- A. 空闲/满员（无长轮次）
async function phaseIdleAndRss() {
  const leadId = `sess_perf_idle_${crypto.randomBytes(2).toString("hex")}`;
  const meta = { session_id: leadId };
  const daemon = startDaemon(cfg, {
    env: { TEAM_ZCODE_BIN: cfg.fakeZcode, TEAM_SESSION_ISOLATION: "legacy", FAKE_ZCODE_RESPONSE: "perf-ok" },
  });
  try {
    step("daemon ready");
    await daemon.ready();
    const teamDir = path.join(cfg.dataRoot, "teams", leadId);
    step("spawn perf-1");
    const spawnStart = Date.now();
    await daemon.callJson("spawn_teammate", { name: "perf-1", description: "d", prompt: "perf-1 首轮" }, meta);
    await waitUntil(() => memberDirOf(teamDir, "perf-1") !== undefined, 60_000, "perf-1 origin");
    const spawnMs = Date.now() - spawnStart;
    record("spawn 冷启动（ms）", ms(spawnMs), null, true);
    const memberDir = memberDirOf(teamDir, "perf-1");
    await waitUntil(() => turnStatuses(memberDir).some((turn) => turn.status === "exited"), 60_000, "perf-1 turn exit");

    step("idle delivery");
    const before = deliveredCount(teamDir);
    const sendStart = Date.now();
    await daemon.callJson("send_message", { target: "perf-1", message: "perf-idle" }, meta);
    const idleMs = await waitUntil(() => deliveredCount(teamDir) > before, 30_000, "idle delivered");
    record("投递延迟·空闲（ms）", ms(Math.min(idleMs, Date.now() - sendStart)), 2_000, idleMs <= 2_000);

    step("spawn perf-2..8");
    for (let i = 2; i <= 8; i += 1) {
      await daemon.callJson("spawn_teammate", { name: `perf-${i}`, description: "d", prompt: `perf-${i} 首轮` }, meta);
    }
    await waitUntil(() => {
      const rows = teamEvents(teamDir).filter((line) => line.event?.type === "team/member" && line.event.member.phase === "active");
      return new Set(rows.map((line) => line.event.member.id)).size >= 8;
    }, 60_000, "8 active members");
    await sleep(300);
    let rssMb = null;
    try {
      const kb = Number(execFileSync("ps", ["-o", "rss=", "-p", String(daemon.pid)], { encoding: "utf8" }).trim());
      rssMb = Math.round(kb / 1024);
    } catch {
      rssMb = null;
    }
    record("协调者 RSS·8 成员（MB）", rssMb, 150, rssMb !== null && rssMb <= 150, { pid: daemon.pid });
    step("idle phase done");
  } finally {
    await daemon.kill("SIGINT").catch(() => undefined);
  }
}

// ---------------------------------------------------------------- B. 运行中投递 + wait 唤醒（长轮次）
async function phaseRunningAndWait() {
  const leadId = `sess_perf_run_${crypto.randomBytes(2).toString("hex")}`;
  const meta = { session_id: leadId };
  const daemon = startDaemon(cfg, {
    env: {
      TEAM_ZCODE_BIN: cfg.fakeZcode,
      TEAM_SESSION_ISOLATION: "legacy",
      FAKE_ZCODE_RESPONSE: "perf-ok",
      FAKE_ZCODE_SLEEP_MS: "4000",
    },
  });
  try {
    await daemon.ready();
    const teamDir = path.join(cfg.dataRoot, "teams", leadId);
    step("spawn perf-slow (4s turn)");
    await daemon.callJson("spawn_teammate", { name: "perf-slow", description: "d", prompt: "perf-slow 首轮" }, meta);
    await waitUntil(() => memberDirOf(teamDir, "perf-slow") !== undefined, 60_000, "slow origin");
    const memberDir = memberDirOf(teamDir, "perf-slow");
    await waitUntil(() => turnStatuses(memberDir).some((turn) => turn.status === "running"), 30_000, "slow running");

    // 运行中投递：send 于运行期间（队列入 pending）→ 测「轮次退出→delivered」
    // 同时把 wait 注册在「首个长轮次运行中」；轮次退出 = 唯一后续变化 → 测「退出→wait 返回」。
    step("register wait");
    let settledAt = null;
    const registerWait = () => {
      settledAt = null;
      daemon
        .callJson("wait_agent", { timeout_ms: 30_000 }, meta, 45_000)
        .then(() => {
          settledAt = Date.now();
        })
        .catch(() => {
          settledAt = Date.now();
        });
    };
    registerWait();
    await sleep(300);
    // wait 可能在注册后的空窗里已被某个变化唤醒 → 重新注册，保证下面测的是「send 引起的变化 → 返回」。
    if (settledAt !== null) {
      registerWait();
      await sleep(200);
    }
    step("send while running");
    const tChange = Date.now();
    await daemon.callJson("send_message", { target: "perf-slow", message: "perf-running" }, meta);
    const before = deliveredCount(teamDir);
    await waitUntil(() => settledAt !== null, 10_000, "wait settled after send");
    const wakeMs = settledAt - tChange;
    record("wait 唤醒延迟（变化→wait 返回，ms）", ms(wakeMs), 1_000, wakeMs >= 0 && wakeMs <= 1_000, { tChange, settledAt });

    await waitUntil(() => turnStatuses(memberDir).some((turn) => turn.status === "exited"), 60_000, "first turn exit");
    const exitAt = Date.now();
    const runningMs = await waitUntil(() => deliveredCount(teamDir) > before, 30_000, "running delivered");
    record("投递延迟·运行中（轮次退出→delivered，ms）", ms(runningMs), 2_000, runningMs <= 2_000, { exitAt });
  } finally {
    await daemon.kill("SIGINT").catch(() => undefined);
  }
}

// ---------------------------------------------------------------- C. 面板渲染 / 重放 / 冷启动
const bundleDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-perf-bundle-"));
async function bundle(name, entry) {
  const out = path.join(bundleDir, `${name}.mjs`);
  await build({
    stdin: { contents: entry, resolveDir: PROJ, loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: out,
    logLevel: "silent",
  });
  return import(pathToFileURL(out).href);
}

async function phaseRenderAndReplay() {
  step("panel render");
  const ui = await bundle(
    "ui",
    `export { renderPanelBody } from ${JSON.stringify(path.join(PROJ, "src/ui-core/render.ts"))};`,
  );
  const members = Array.from({ length: 8 }, (_, i) => ({
    target: i === 0 ? "lead" : `perf-${i}`,
    role: i === 0 ? "lead" : "teammate",
    status: i % 3 === 0 ? "running" : "inactive",
    diagnostics: [],
    id: `m${i}`,
    sessionId: `sess_m${i}`,
  }));
  const tasks = Array.from({ length: 20 }, (_, i) => ({
    id: `task-${i + 1}`,
    revision: 1,
    subject: `任务 ${i + 1}`,
    description: "perf",
    status: i < 5 ? "in_progress" : "pending",
    blockedBy: [],
    writeScopes: [],
    ready: i >= 5,
    writeScopeWarnings: [],
  }));
  const frame = { type: "view", stateVersion: 4, team: { teamId: "sess_perf", status: "active", seq: 100 }, members, tasks, meta: { generatedAt: "", revision: 100 } };
  const iterations = 200;
  const t0 = performance.now();
  for (let i = 0; i < iterations; i += 1) ui.renderPanelBody(frame, "zh", { loading: false });
  const avg = (performance.now() - t0) / iterations;
  record("面板渲染·8 成员+20 任务（ms/次）", ms(avg), 500, avg <= 500, { iterations });

  step("10k replay");
  const replayDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-perf-replay-"));
  const replayTeam = "sess_perf_replay";
  const replayTeamDir = path.join(replayDir, "teams", replayTeam);
  fs.mkdirSync(replayTeamDir, { recursive: true, mode: 0o700 });
  const events = [
    { type: "team/member", version: 2, teamId: replayTeam, member: { id: "m1", name: "w1", description: "d", provider: "spawn", context: "fresh", phase: "provisioning" } },
    { type: "team/member", version: 2, teamId: replayTeam, member: { id: "m1", name: "w1", description: "d", provider: "spawn", context: "fresh", phase: "active" } },
  ];
  for (let i = 0; i < 4_999; i += 1) {
    events.push({ type: "team/message/queued", version: 2, teamId: replayTeam, message: { id: `perf-msg-${i}`, senderId: "m1", senderName: "w1", targetId: replayTeam, content: [{ type: "text", text: `m${i}` }] } });
    events.push({ type: "team/message/delivered", version: 2, teamId: replayTeam, messageId: `perf-msg-${i}`, targetId: replayTeam });
  }
  const content = events.map((event, index) => JSON.stringify({ seq: index + 1, ts: new Date().toISOString(), writer: "m1:1", event })).join("\n") + "\n";
  fs.writeFileSync(path.join(replayTeamDir, "events.jsonl"), content, { mode: 0o600 });
  const replay = await bundle("replay", `export { load } from ${JSON.stringify(path.join(PROJ, "src/coord/replay.js"))};`);
  const r0 = performance.now();
  const loaded = await replay.load(replayTeamDir, replayTeam);
  const replayMs = performance.now() - r0;
  record("1 万行重放（ms）", ms(replayMs), 2_000, replayMs <= 2_000 && loaded.seq === 10_000 && loaded.corrupt === undefined, {
    seq: loaded.seq,
    corrupt: loaded.corrupt,
  });

  step("cold start on 10k team");
  const coldDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-perf-cold-"));
  const coldTeamDir = path.join(coldDir, "teams", replayTeam);
  fs.mkdirSync(coldTeamDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(coldTeamDir, "events.jsonl"), content, { mode: 0o600 });
  const coldDb = path.join(coldDir, "session.sqlite");
  createTestSessionDb(coldDb);
  const coldDaemon = startDaemon(cfg, {
    dataRoot: coldDir,
    dbPath: coldDb,
    env: { TEAM_ZCODE_BIN: cfg.fakeZcode, TEAM_SESSION_ISOLATION: "legacy" },
    label: "cold-daemon",
  });
  const coldStart = Date.now();
  await coldDaemon.ready(30_000);
  await coldDaemon.callJson("list_agents", {}, { session_id: replayTeam }, 30_000);
  const coldMs = Date.now() - coldStart;
  record("daemon 冷启动→可服务·1 万行（ms）", ms(coldMs), 3_000, coldMs <= 3_000);
  await coldDaemon.kill("SIGINT").catch(() => undefined);
  fs.rmSync(coldDir, { recursive: true, force: true, maxRetries: 3 });
  fs.rmSync(replayDir, { recursive: true, force: true, maxRetries: 3 });
  fs.rmSync(bundleDir, { recursive: true, force: true });
}

try {
  await phaseIdleAndRss();
  await phaseRunningAndWait();
  await phaseRenderAndReplay();
} catch (err) {
  record("perf 场景未抛异常", null, null, false, { error: String(err?.stack ?? err).slice(0, 1500) });
} finally {
  fs.rmSync(bundleDir, { recursive: true, force: true });
  const pass = checks.every((check) => check.ok);
  const summary = { scenario: "perf-baseline", pass, ts: new Date().toISOString(), node: process.version, checks };
  const file = writeResult(cfg.out, "PERF", summary);
  process.stdout.write(`\nPERF result → ${file}\n`);
  process.exitCode = pass ? 0 : 1;
}
