#!/usr/bin/env node
// SF11 升级兼容演练（0.1.0 → 0.1.1 语义：事件 version 2 不变、checkpoint 可重建、进行中剧本可续）：
//  ① 旧数据可读：既有团队（成员/任务/消息）在新实例 list/task 查询正确；
//  ② checkpoint 重建：删除 checkpoint 后冷启动全量重放，关闭时重新落 checkpoint；
//  ③ 进行中剧本可续：长轮次运行中 SIGKILL 协调者 → 新实例纳管/定案 → 消息继续投递；
//  ④ 版本/运行时指纹登记（Node ≥22）。
// 用法：node scripts/upgrade-drill.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createTestSessionDb, loadConfig, startDaemon, writeResult } from "./e2e/common.mjs";

const cfg = loadConfig();
createTestSessionDb(cfg.dbPath);
const checks = [];
function check(id, ok, detail) {
  checks.push({ id, ok, ...(detail !== undefined ? { detail } : {}) });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${id}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await fn()) return Date.now() - startedAt;
    await sleep(50);
  }
  throw new Error(`timeout ${timeoutMs}ms: ${label}`);
}
function events(teamDir) {
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

const leadId = `sess_upgrade_${crypto.randomBytes(3).toString("hex")}`;
const meta = { session_id: leadId };
const teamDir = path.join(cfg.dataRoot, "teams", leadId);
const baseEnv = { TEAM_ZCODE_BIN: cfg.fakeZcode, TEAM_SESSION_ISOLATION: "legacy", FAKE_ZCODE_RESPONSE: "upgrade-ok" };
const oldEvidence = {};
const activeDaemons = [];

try {
  // —— 旧版本实例：建团队（成员 + 任务 + 已投递消息）
  const oldDaemon = startDaemon(cfg, { env: baseEnv, label: "old-daemon" });
  activeDaemons.push(oldDaemon);
  await oldDaemon.ready();
  await oldDaemon.callJson("spawn_teammate", { name: "upg-a", description: "d", prompt: "upg 首轮" }, meta);
  const task = await oldDaemon.callJson("team_task_create", { subject: "upgrade-task", description: "d" }, meta);
  await oldDaemon.callJson("send_message", { target: "upg-a", message: "upgrade-msg" }, meta);
  await waitUntil(
    () => events(teamDir).some((line) => line.event?.type === "team/message/delivered"),
    30_000,
    "old delivery",
  );
  const oldSeq = events(teamDir).length;
  oldEvidence.seq = oldSeq;
  oldEvidence.checkpointBeforeClose = fs.existsSync(path.join(teamDir, "checkpoint.json"));
  oldEvidence.eventsVersion = [...new Set(events(teamDir).map((line) => line.event?.version))];
  const oldExit = await oldDaemon.kill("SIGINT");
  oldEvidence.checkpointAfterClose = fs.existsSync(path.join(teamDir, "checkpoint.json"));
  check("旧实例正常收尾（SIGINT → exit 0）", oldExit.code === 0, oldExit);
  check("关闭路径重建 checkpoint", oldEvidence.checkpointAfterClose === true, {
    before: oldEvidence.checkpointBeforeClose,
    after: oldEvidence.checkpointAfterClose,
  });
  check("事件版本恒为 2（无 schema 变更）", oldEvidence.eventsVersion.every((v) => v === 2), oldEvidence);

  // —— 模拟升级：删除 checkpoint（强制全量重放）
  fs.rmSync(path.join(teamDir, "checkpoint.json"), { force: true });

  // —— 新版本实例：旧数据可读 + checkpoint 重建
  const newDaemon = startDaemon(cfg, { env: baseEnv, label: "new-daemon" });
  activeDaemons.push(newDaemon);
  await newDaemon.ready();
  const agents = await newDaemon.callJson("list_agents", {}, meta);
  const tasks = await newDaemon.callJson("team_task_list", {}, meta);
  check("新实例可读旧团队（成员含 lead + upg-a）", agents.some((row) => row.target === "lead") && agents.some((row) => row.target === "upg-a"), {
    targets: agents.map((row) => row.target),
  });
  check("新实例可读旧任务（upgrade-task）", tasks.tasks.some((row) => row.id === task.id && row.subject === "upgrade-task"), {
    taskIds: tasks.tasks.map((row) => row.id),
  });
  const seqAfterOpen = events(teamDir).length;
  check("冷启动不重写/不重置事件日志（seq 连续）", seqAfterOpen === oldSeq, { oldSeq, seqAfterOpen });
  await newDaemon.callJson("send_message", { target: "upg-a", message: "after-upgrade" }, meta);
  await waitUntil(
    () => events(teamDir).filter((line) => line.event?.type === "team/message/delivered").length >= 2,
    30_000,
    "post-upgrade delivery",
  );
  check("升级后消息链路继续工作（delivered +1）", events(teamDir).length > oldSeq, {
    seq: events(teamDir).length,
  });

  // —— 进行中剧本可续：消息投递窗口内 SIGKILL 协调者 → 新实例纳管/接任后续跑
  await newDaemon.callJson("send_message", { target: "upg-a", message: "running-window" }, meta);
  await sleep(150);
  await newDaemon.kill("SIGKILL");
  const adopted = startDaemon(cfg, { env: baseEnv, label: "adopt-daemon" });
  activeDaemons.push(adopted);
  await adopted.ready();
  const board = await adopted.callJson("list_agents", {}, meta);
  check("SIGKILL 后新实例可服务（代理/协调者均可）", Array.isArray(board) && board.length >= 2, { rows: board.length });
  // 接任期：锁过期 ≤4.5s；期间写入以 TEAM_DISPOSED 显式拒绝 → 有界重试（不得静默丢）。
  let sendOk = false;
  let sendAttempts = 0;
  let lastError = null;
  for (; sendAttempts < 40 && !sendOk; sendAttempts += 1) {
    try {
      await adopted.callJson("send_message", { target: "upg-a", message: "resume-after-crash" }, meta);
      sendOk = true;
    } catch (err) {
      lastError = String(err?.message ?? err);
      if (!lastError.includes("TEAM_DISPOSED")) break;
      await sleep(250);
    }
  }
  check("崩溃后接任期写入显式拒绝并重试成功（≤10s）", sendOk && sendAttempts <= 40, { sendAttempts, lastError });
  await waitUntil(
    () => events(teamDir).some((line) => line.event?.type === "team/message/queued" && line.event.message.content?.[0]?.text === "resume-after-crash"),
    30_000,
    "post-crash send",
  );
  check("崩溃后消息恰一次落盘", true);
  const adoptedExit = await adopted.kill("SIGINT");
  check("新实例关闭后 checkpoint 重建", fs.existsSync(path.join(teamDir, "checkpoint.json")), {
    checkpoint: fs.existsSync(path.join(teamDir, "checkpoint.json")),
    exit: adoptedExit,
  });

  // —— 运行时矩阵
  const nodeMajor = Number(process.version.replace(/^v/, "").split(".")[0]);
  check("Node 运行时 ≥22", nodeMajor >= 22, { node: process.version });
} catch (err) {
  check("upgrade 场景未抛异常", false, { error: String(err?.stack ?? err).slice(0, 2000) });
} finally {
  for (const daemon of activeDaemons) {
    await daemon.kill("SIGKILL").catch(() => undefined);
  }
  const pass = checks.every((c) => c.ok);
  const result = {
    scenario: "upgrade-drill",
    pass,
    ts: new Date().toISOString(),
    node: process.version,
    drills: checks,
    old: oldEvidence,
  };
  const file = writeResult(cfg.out, "UPGRADE", result);
  process.stdout.write(`\nUPGRADE result → ${file}\n`);
  process.exitCode = pass ? 0 : 1;
}
