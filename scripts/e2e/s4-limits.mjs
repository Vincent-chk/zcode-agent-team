// S4 限额剧本（SF04；真实 daemon/工具链）：4 类限额逐字触发
//  ① maxMembers  ② maxTasks  ③ maxMessageBytes（framed 超限）  ④ wait 超限/非法。
// UI 截图项由 stage-6 用户清单执行（此处只出工具结果证据）。
import crypto from "node:crypto";
import { Checks, createTestSessionDb, loadConfig, startDaemon, writeResult } from "./common.mjs";

const cfg = loadConfig();
createTestSessionDb(cfg.dbPath);
const leadId = `${cfg.teamPrefix}-s4-${crypto.randomUUID()}`;
const checks = new Checks("S4");
const evidence = {};
const limits = { maxMembers: 2, maxTasks: 1, maxMessageBytes: 2_000, disposalTimeoutMs: 5_000 };
const names = ["s4-a", "s4-b", "s4-c"].map((n) => `${n}-${crypto.randomBytes(2).toString("hex")}`);

const daemon = startDaemon(cfg, {
  env: {
    TEAM_ZCODE_BIN: cfg.fakeZcode,
    TEAM_SESSION_ISOLATION: "legacy",
    TEAM_WAKE_LEAD: "0",
    FAKE_ZCODE_RESPONSE: "s4-ok",
    TEAM_MAX_MEMBERS: String(limits.maxMembers),
    TEAM_MAX_TASKS: String(limits.maxTasks),
    TEAM_MAX_MESSAGE_BYTES: String(limits.maxMessageBytes),
    TEAM_DISPOSAL_TIMEOUT_MS: String(limits.disposalTimeoutMs),
  },
});
const meta = { session_id: leadId };

async function expectError(fn) {
  try {
    const value = await fn();
    return { threw: false, value };
  } catch (err) {
    return { threw: true, message: String(err?.message ?? err) };
  }
}

try {
  await daemon.ready();
  await daemon.callJson("spawn_teammate", { name: names[0], description: "d", prompt: "p" }, meta);
  await daemon.callJson("spawn_teammate", { name: names[1], description: "d", prompt: "p" }, meta);
  // ① maxMembers
  const memberLimit = await expectError(() =>
    daemon.callJson("spawn_teammate", { name: names[2], description: "d", prompt: "p" }, meta),
  );
  evidence.maxMembers = memberLimit;
  checks.check(
    "maxMembers：第 3 名 spawn → TEAM_MEMBER_LIMIT（逐字）",
    memberLimit.threw && memberLimit.message.includes("TEAM_MEMBER_LIMIT") && memberLimit.message.includes("limit 2"),
    memberLimit,
  );

  // ② maxTasks（limits.maxTasks=1）
  const task1 = await daemon.callJson("team_task_create", { subject: "s4-t1", description: "d" }, meta);
  const taskLimit = await expectError(() =>
    daemon.callJson("team_task_create", { subject: "s4-t2", description: "d" }, meta),
  );
  evidence.maxTasks = { first: task1.id, second: taskLimit };
  checks.check(
    "maxTasks：第 2 个任务 → TEAM_TASK_LIMIT（逐字）",
    taskLimit.threw && taskLimit.message.includes("TEAM_TASK_LIMIT") && taskLimit.message.includes("limit 1"),
    taskLimit,
  );

  // ③ maxMessageBytes（framed 超过 2000）
  const tooLarge = await expectError(() =>
    daemon.callJson("send_message", { target: names[0], message: "x".repeat(limits.maxMessageBytes + 500) }, meta),
  );
  evidence.maxMessageBytes = tooLarge;
  checks.check(
    "maxMessageBytes：超限消息 → TEAM_MESSAGE_TOO_LARGE（逐字 2000）",
    tooLarge.threw && tooLarge.message.includes("TEAM_MESSAGE_TOO_LARGE") && tooLarge.message.includes("2000"),
    tooLarge,
  );

  // ④ wait 超限（低于下限 10s 的数值直达域层；非法值由工具面守卫）
  const waitLow = await expectError(() => daemon.callJson("wait_agent", { timeout_ms: 9_999 }, meta, 20_000));
  evidence.waitLow = waitLow;
  checks.check(
    "wait 边界：9999ms → TEAM_INVALID_TIMEOUT（10000..3600000）",
    waitLow.threw && waitLow.message.includes("TEAM_INVALID_TIMEOUT") && waitLow.message.includes("10000 through 3600000"),
    waitLow,
  );
  const waitStr = await expectError(() => daemon.callJson("wait_agent", { timeout_ms: "soon" }, meta, 20_000));
  evidence.waitType = waitStr;
  checks.check(
    "wait 类型：非数值 → TEAM_INVALID_TIMEOUT（同一逐字消息）",
    waitStr.threw && waitStr.message.includes("TEAM_INVALID_TIMEOUT"),
    waitStr,
  );
} catch (err) {
  checks.check("S4 未抛异常", false, { error: String(err?.stack ?? err).slice(0, 2000) });
} finally {
  const exited = await daemon.kill("SIGINT").catch(() => ({ code: null, signal: null }));
  const result = checks.toJSON({
    evidence,
    limits,
    daemonExit: exited,
    daemonStderrTail: daemon.stderr().slice(-3000),
    env: { zcode: cfg.zcode, dataRoot: cfg.dataRoot, db: cfg.dbPath, fake: true },
  });
  const file = writeResult(cfg.out, "S4", result);
  process.stdout.write(`S4 result → ${file}\n`);
  if (!result.pass) process.exitCode = 1;
}
