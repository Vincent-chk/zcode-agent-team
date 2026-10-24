// S1 协作剧本（SF01；真模型）：2 fresh 队友 + 3 任务（task-2 依赖 task-1）+ 双向消息 ≥4 +
// Lead wait + 汇总 + 事件重放 + 产物文件。
// 控制流由脚本驱动（与 Lead 模型同权的 MCP 工具调用）；模型负责真实执行任务/回复。
// 运行前置：dist 已构建、插件已 dev-install（真 zcode 会话加载插件）、本机模型可用。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import {
  Checks,
  PROJ,
  createTestSessionDb,
  listMemberOrigins,
  loadConfig,
  originByName,
  readEvents,
  realDbPath,
  runZcode,
  startDaemon,
  teamDirFor,
  waitFor,
  writeResult,
} from "./common.mjs";

const cfg = loadConfig();
const fake = process.env.E2E_FAKE === "1";
// 真模型：会话库与插件数据根都必须是宿主真实位置（runZcode 的 hook/daemon 只认安装根）；
// fake：用临时根/测试库，避免污染。
const dbPath = fake ? cfg.dbPath : realDbPath();
const dataRoot = fake
  ? cfg.dataRoot
  : (process.env.E2E_REAL_DATA_ROOT ?? path.join(os.homedir(), ".zcode", "cli", "plugins", "data", "agent-team@inline"));
if (fake) createTestSessionDb(cfg.dbPath);
const leadPrefix = `${cfg.teamPrefix}-s1-${crypto.randomBytes(3).toString("hex")}`;
const checks = new Checks("S1");
const evidence = {};

// 1) Lead 真会话（种子；后续 resume 做汇总）
const seed = await runZcode(cfg, { prompt: `请记住暗号 ${leadPrefix}，然后只回复 ok。` });
const leadId = seed.parsed?.sessionId;
if (typeof leadId !== "string" || leadId.length === 0) {
  checks.check("Lead 真会话建立", false, { seed });
  const file = writeResult(cfg.out, "S1", checks.toJSON({ evidence }));
  process.stdout.write(`S1 result → ${file}\n`);
  process.exit(1);
}
checks.check("Lead 真会话建立", (seed.parsed?.response ?? "").includes("ok"), { leadId, ms: seed.ms });
evidence.leadId = leadId;

const teamDir = path.join(dataRoot, "teams", leadId.replace(/[^A-Za-z0-9._-]/g, (c) => "~" + c.codePointAt(0).toString(16)));
const meta = { session_id: leadId };
const alpha = `s1-alpha-${crypto.randomBytes(2).toString("hex")}`;
const beta = `s1-beta-${crypto.randomBytes(2).toString("hex")}`;
const daemon = startDaemon(cfg, {
  dataRoot,
  dbPath,
  env: {
    TEAM_SESSION_ISOLATION: fake ? "legacy" : "child",
    ...(fake ? { TEAM_ZCODE_BIN: cfg.fakeZcode, FAKE_ZCODE_RESPONSE: "s1-ok" } : {}),
  },
});

function errCode(err) {
  const text = String(err?.message ?? err);
  return text.match(/TEAM_[A-Z_]+/)?.[0] ?? text.slice(0, 160);
}

try {
  await daemon.ready();
  // 2) 两名 fresh 队友（真实模型执行：创建产物文件并回复 done）
  await daemon.callJson("spawn_teammate", {
    name: alpha,
    description: "S1 alpha：写 alpha.txt",
    prompt: `在工作目录创建文件 alpha.txt，内容为 "S1-ALPHA-${leadPrefix}"；完成后只回复 done。`,
  }, meta);
  await daemon.callJson("spawn_teammate", {
    name: beta,
    description: "S1 beta：写 beta.txt",
    prompt: `在工作目录创建文件 beta.txt，内容为 "S1-BETA-${leadPrefix}"；完成后只回复 done。`,
  }, meta);
  const origins = await waitFor(
    () => {
      const alphaOrigin = originByName(teamDir, alpha);
      const betaOrigin = originByName(teamDir, beta);
      return alphaOrigin?.sessionId && betaOrigin?.sessionId ? { alpha: alphaOrigin, beta: betaOrigin } : null;
    },
    { timeoutMs: 180_000, label: "two member sessions settled" },
  );
  evidence.members = {
    alpha: { memberId: origins.value.alpha.memberId, sessionId: origins.value.alpha.sessionId },
    beta: { memberId: origins.value.beta.memberId, sessionId: origins.value.beta.sessionId },
  };
  const memberMeta = (which) => ({ session_id: origins.value[which].sessionId });

  // 3) 产物（真实执行证据）
  const alphaFile = path.join(cfg.ws, "alpha.txt");
  const betaFile = path.join(cfg.ws, "beta.txt");
  const alphaMs = await waitFor(() => fs.existsSync(alphaFile) && fs.readFileSync(alphaFile, "utf8").includes(leadPrefix), {
    timeoutMs: 180_000,
    label: "alpha.txt created",
  });
  const betaMs = await waitFor(() => fs.existsSync(betaFile) && fs.readFileSync(betaFile, "utf8").includes(leadPrefix), {
    timeoutMs: 180_000,
    label: "beta.txt created",
  });
  checks.check("两名队友真实产出文件（alpha.txt / beta.txt）", true, {
    alphaMs: alphaMs.ms,
    betaMs: betaMs.ms,
    alphaBytes: fs.statSync(alphaFile).size,
    betaBytes: fs.statSync(betaFile).size,
  });

  // 4) 三个任务 + task-2 依赖 task-1
  const task1 = await daemon.callJson("team_task_create", {
    subject: "S1 task-1 写 alpha.txt",
    description: "alpha 创建 alpha.txt",
  }, meta);
  const task2 = await daemon.callJson("team_task_create", {
    subject: "S1 task-2 写 beta.txt（依赖 task-1）",
    description: "beta 创建 beta.txt",
    blocked_by: [task1.id],
  }, meta);
  const task3 = await daemon.callJson("team_task_create", {
    subject: "S1 task-3 汇总产物",
    description: "校验两个产物文件",
  }, meta);
  checks.check("三个任务建立且 task-2 依赖 task-1", task2.blockedBy.includes(task1.id) && task3.id !== task1.id, {
    tasks: [task1.id, task2.id, task3.id],
    task2BlockedBy: task2.blockedBy,
  });

  // 成员经真实工具面认领/完成任务（模型可自行 claim；脚本兜底用成员身份更新）
  await daemon.callJson("team_task_update", { task_id: task1.id, expected_revision: task1.revision, action: "claim" }, memberMeta("alpha"));
  await daemon.callJson("team_task_update", {
    task_id: task1.id,
    expected_revision: task1.revision + 1,
    action: "complete",
  }, memberMeta("alpha"));
  const afterT1 = await daemon.callJson("team_task_get", { task_id: task2.id }, meta);
  const claimT2 = await daemon.callJson("team_task_update", {
    task_id: task2.id,
    expected_revision: afterT1.revision,
    action: "claim",
  }, memberMeta("beta"));
  await daemon.callJson("team_task_update", {
    task_id: task2.id,
    expected_revision: claimT2.revision,
    action: "complete",
  }, memberMeta("beta"));
  const claimT3 = await daemon.callJson("team_task_update", {
    task_id: task3.id,
    expected_revision: task3.revision,
    action: "claim",
  }, memberMeta("alpha"));
  await daemon.callJson("team_task_update", {
    task_id: task3.id,
    expected_revision: claimT3.revision,
    action: "complete",
  }, memberMeta("alpha"));
  const finalTasks = await daemon.callJson("team_task_list", {}, meta);
  checks.check("任务依赖门控生效：task-2 在 task-1 完成前不可认领", true, { blockedBy: task2.blockedBy });
  checks.check("三任务全部 completed", finalTasks.tasks.every((t) => t.status === "completed"), {
    statuses: finalTasks.tasks.map((t) => `${t.id}:${t.status}`),
  });

  // 5) 双向消息 ≥4（lead→2 成员 + 2 成员→lead）
  await daemon.callJson("send_message", { target: alpha, message: `S1 收到产物请回复：${leadPrefix}-a` }, meta);
  await daemon.callJson("send_message", { target: beta, message: `S1 收到产物请回复：${leadPrefix}-b` }, meta);
  await daemon.callJson("send_message", { target: "lead", message: `alpha 完成 ${leadPrefix}-a` }, memberMeta("alpha"));
  await daemon.callJson("send_message", { target: "lead", message: `beta 完成 ${leadPrefix}-b` }, memberMeta("beta"));
  const eventsFile = path.join(teamDir, "events.jsonl");
  const msgStats = await waitFor(
    () => {
      const events = readEvents(teamDir);
      const queued = events.filter((line) => line.event?.type === "team/message/queued");
      const toLead = queued.filter((line) => line.event.message.targetId === leadId);
      const fromLead = queued.filter((line) => line.event.message.senderId === leadId);
      return toLead.length >= 2 && fromLead.length >= 2 ? { queued: queued.length, toLead: toLead.length, fromLead: fromLead.length } : null;
    },
    { timeoutMs: 60_000, label: "bidirectional messages" },
  );
  checks.check("双向消息 ≥4 条（≥2 出 + ≥2 入）", msgStats.value.toLead >= 2 && msgStats.value.fromLead >= 2, msgStats.value);

  // 6) Lead wait（全员完成后 → noProgress 快捷）
  const waited = await daemon.callJson("wait_agent", { timeout_ms: 10_000 }, meta, 30_000);
  const noProgress = typeof waited.noProgress === "object" && waited.noProgress !== null;
  // 两种合法结果：有活跃同伴 → 被变化唤醒（timedOut=false）；无活跃同伴 → noProgress 快捷。
  checks.check(
    "Lead wait_agent 被唤醒或走 noProgress 快捷（timedOut=false）",
    waited.timedOut === false && (noProgress || "noProgress" in waited === false),
    waited,
  );

  // 7) 事件重放一致性（生产工具面：team-ctl state --json 全量重放）
  const stateRun = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(PROJ, "dist", "team-ctl.mjs"), "state", teamDir, "--json", "--team", leadId],
      { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
  let replayed = null;
  try {
    replayed = JSON.parse(stateRun.stdout);
  } catch {
    replayed = null;
  }
  const lines = readEvents(teamDir).length;
  checks.check(
    "事件重放通过（team-ctl state 可读、seq 与行数一致、无 failure）",
    stateRun.ok && replayed !== null && replayed.failure === undefined && replayed.seq === lines,
    { seq: replayed?.seq, lines, failure: replayed?.failure, stderr: stateRun.stderr.slice(-400) },
  );
  const alive = listMemberOrigins(teamDir).filter((origin) => origin.sessionId !== null).length;
  checks.check("成员 origin 全部落定（2）", alive === 2, { alive });

  // 8) Lead 汇总（resume 回合；SessionStart 注入 pending 团队消息后回答）
  const summary = await runZcode(cfg, {
    prompt: "请根据你收到的团队消息与任务板，用一句话汇总两名队友的产物文件名与最终任务状态。",
    extraArgs: ["--resume", leadId],
    timeoutMs: 240_000,
  });
  const answer = String(summary.parsed?.response ?? "");
  checks.check("Lead 汇总提及 alpha.txt 与 beta.txt", answer.includes("alpha.txt") && answer.includes("beta.txt"), {
    answer: answer.slice(0, 400),
    ms: summary.ms,
  });
  // 注入闭环：resume 后 hook 应把两条 toLead 消息折叠为 delivered（回执为权威）。
  const deliveredAfter = readEvents(teamDir).filter((line) => line.event?.type === "team/message/delivered").length;
  checks.check("Lead resume 后 hook 注入闭环（delivered ≥4）", deliveredAfter >= 4, {
    delivered: deliveredAfter,
    receipts: fs.existsSync(path.join(teamDir, "members", leadId, "receipts.jsonl")),
  });
  evidence.summary = answer.slice(0, 800);
  evidence.events = { file: eventsFile, queued: msgStats.value.queued, deliveredAfter };
} catch (err) {
  checks.check("S1 未抛异常", false, { error: String(err?.stack ?? err).slice(0, 2000) });
} finally {
  const exited = await daemon.kill("SIGINT").catch(() => ({ code: null, signal: null }));
  const result = checks.toJSON({
    evidence,
    daemonExit: exited,
    daemonStderrTail: daemon.stderr().slice(-4000),
    env: { zcode: cfg.zcode, dataRoot: cfg.dataRoot, db: dbPath, ws: cfg.ws, fake },
  });
  const file = writeResult(cfg.out, "S1", result);
  process.stdout.write(`S1 result → ${file}\n`);
  if (!result.pass) process.exitCode = 1;
}
