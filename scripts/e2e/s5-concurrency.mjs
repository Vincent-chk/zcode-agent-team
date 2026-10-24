// S5 并发剧本（SF05；确定性，fake-zcode 驱动）：
//  - 3 成员对同一 pending 任务并发 claim ×20 轮：每轮恰一成功，失败方 STALE/ALREADY_CLAIMED；
//  - revision 连续（无断裂/无回退）；
//  - 50 条并发消息：delivered 集合 = queued 集合、messageId 唯一、target 与源头一致。
// 依赖：npm run build（dist/team-daemon.mjs）；TEAM_DB_PATH 指向测试库（本脚本自建）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  Checks,
  createTestSessionDb,
  loadConfig,
  originByName,
  readEvents,
  startDaemon,
  teamDirFor,
  waitFor,
  writeResult,
} from "./common.mjs";

const cfg = loadConfig();
createTestSessionDb(cfg.dbPath);
const leadId = `${cfg.teamPrefix}-s5-${crypto.randomUUID()}`;
const members = ["s5-alpha", "s5-beta", "s5-gamma"].map((base) => `${base}-${crypto.randomBytes(2).toString("hex")}`);
const checks = new Checks("S5");
const evidence = { leadId, members, rounds: [], messages: {} };

const daemon = startDaemon(cfg, {
  env: {
    TEAM_ZCODE_BIN: cfg.fakeZcode,
    TEAM_SESSION_ISOLATION: "legacy",
    TEAM_WAKE_LEAD: "0",
    TEAM_DEBUG_DELIVERY: "1",
    FAKE_ZCODE_RESPONSE: "s5-ok",
  },
});
const leadMeta = { session_id: leadId };

function errCode(err) {
  const message = String(err?.message ?? err);
  const match = message.match(/TEAM_[A-Z_]+/);
  return match ? match[0] : message.slice(0, 200);
}

try {
  await daemon.ready();
  await daemon.callJson("spawn_teammate", {
    name: members[0],
    description: "S5 alpha",
    prompt: "S5 alpha 首轮：只回复 s5-ok",
  }, leadMeta);
  await daemon.callJson("spawn_teammate", {
    name: members[1],
    description: "S5 beta",
    prompt: "S5 beta 首轮：只回复 s5-ok",
  }, leadMeta);
  await daemon.callJson("spawn_teammate", {
    name: members[2],
    description: "S5 gamma",
    prompt: "S5 gamma 首轮：只回复 s5-ok",
  }, leadMeta);
  const teamDir = teamDirFor(cfg, leadId);
  // 等三名成员的会话落定（origin.sessionId 回填）
  await Promise.all(
    members.map((name) =>
      waitFor(() => {
        const origin = originByName(teamDir, name);
        return origin?.sessionId ?? null;
      }, { timeoutMs: 60_000, label: `session for ${name}` }),
    ),
  );
  const origins = Object.fromEntries(members.map((name) => [name, originByName(teamDir, name)]));
  evidence.origins = Object.fromEntries(
    Object.entries(origins).map(([name, origin]) => [name, { memberId: origin.memberId, sessionId: origin.sessionId }]),
  );
  const metaOf = (name) => ({ session_id: origins[name].sessionId });

  // —— 任务创建（lead）
  const created = await daemon.callJson("team_task_create", {
    subject: "S5 并发任务",
    description: "3 成员并发 CAS",
  }, leadMeta);
  const taskId = created.id;
  let revision = created.revision;
  checks.check("初始任务 revision=1 / status=pending", created.revision === 1 && created.status === "pending", {
    taskId,
    revision: created.revision,
  });

  // —— 20 轮 3 成员并发 claim
  const failures = new Set();
  let continuityOk = true;
  for (let round = 1; round <= 20; round += 1) {
    const attempts = await Promise.allSettled(
      members.map((name) =>
        daemon.callJson("team_task_update", {
          task_id: taskId,
          expected_revision: revision,
          action: "claim",
        }, metaOf(name)),
      ),
    );
    const winners = attempts
      .map((attempt, index) => ({ attempt, name: members[index] }))
      .filter((entry) => entry.attempt.status === "fulfilled");
    const loserCodes = attempts
      .filter((attempt) => attempt.status === "rejected")
      .map((attempt) => {
        const code = errCode(attempt.reason);
        failures.add(code);
        return code;
      });
    const winner = winners[0];
    const winnerRow = winner?.attempt.value;
    const roundOk =
      winners.length === 1 &&
      loserCodes.length === 2 &&
      loserCodes.every((code) =>
        code === "TEAM_TASK_STALE" ||
        code === "TEAM_TASK_STALE_REVISION" ||
        code === "TEAM_TASK_ALREADY_CLAIMED",
      ) &&
      winnerRow?.revision === revision + 1 &&
      winnerRow?.status === "in_progress";
    if (!roundOk) continuityOk = false;
    evidence.rounds.push({
      round,
      winners: winners.map((entry) => entry.name),
      losers: loserCodes,
      revisionBefore: revision,
      revisionAfter: winnerRow?.revision ?? null,
    });
    revision = winnerRow?.revision ?? revision;
    // lead 把任务释放回 pending（reassign 空 owner），进入下一轮
    await daemon.callJson("team_task_update", {
      task_id: taskId,
      expected_revision: revision,
      action: "reassign",
      owner: "",
    }, leadMeta);
    revision += 1;
  }
  const finalTask = await daemon.callJson("team_task_get", { task_id: taskId }, leadMeta);
  checks.check("20 轮并发 CAS：每轮恰一成功、失败方 STALE/ALREADY_CLAIMED", continuityOk, {
    failureCodes: [...failures],
  });
  checks.check("revision 连续：最终 = 1 + 20×2", finalTask.revision === 1 + 40, {
    expected: 41,
    actual: finalTask.revision,
  });
  checks.check("任务终态 pending（释放后）且归属已清", finalTask.status === "pending" && finalTask.ownerName === undefined, {
    status: finalTask.status,
    ownerName: finalTask.ownerName,
  });

  // —— 50 条并发消息（只发给 teammate，避免 Lead hook 通道 pending）
  const sends = [];
  for (let i = 0; i < 50; i += 1) {
    const fromIndex = i % 3;
    const toIndex = (i + 1 + (i % 2)) % 3; // 永远发给另一名成员
    const from = members[fromIndex];
    const to = members[toIndex === fromIndex ? (toIndex + 1) % 3 : toIndex];
    sends.push(
      daemon
        .callJson("send_message", { target: to, message: `s5-msg-${i}` }, metaOf(from))
        .then(() => ({ ok: true }))
        .catch((err) => ({ ok: false, error: errCode(err) })),
    );
  }
  const sendOutcomes = await Promise.all(sends);
  const failedSends = sendOutcomes.filter((outcome) => !outcome.ok);
  evidence.messages.sendFailures = failedSends;

  // 投递是异步的（忙成员先 queued，轮次边界再 deliver）→ 等待 delivered ⊇ queued（上限 180s）。
  const queuedAtSend = readEvents(teamDir)
    .filter((line) => line.event?.type === "team/message/queued")
    .map((line) => line.event.message);
  let timedOut = false;
  try {
    await waitFor(() => {
      const ids = new Set(
        readEvents(teamDir)
          .filter((line) => line.event?.type === "team/message/delivered")
          .map((line) => line.event.messageId),
      );
      return queuedAtSend.every((message) => ids.has(message.id));
    }, { timeoutMs: 180_000, intervalMs: 500, label: "all queued messages delivered" });
  } catch {
    timedOut = true;
  }
  const events = readEvents(teamDir);
  const queued = events.filter((line) => line.event?.type === "team/message/queued").map((line) => line.event.message);
  const delivered = events.filter((line) => line.event?.type === "team/message/delivered").map((line) => line.event);
  const queuedIds = queued.map((message) => message.id);
  const deliveredIds = delivered.map((event) => event.messageId);
  const deliveredSet = new Set(deliveredIds);
  const missing = queuedIds.filter((id) => !deliveredSet.has(id));
  const duplicates = deliveredIds.filter((id, index) => deliveredIds.indexOf(id) !== index);
  evidence.messages.waitTimedOut = timedOut;
  const targetMismatch = delivered.filter((event) => {
    const source = queued.find((message) => message.id === event.messageId);
    return source !== undefined && source.targetId !== event.targetId;
  });

  checks.check("50 条并发消息全部成功发送", failedSends.length === 0, {
    failures: failedSends.slice(0, 5),
    total: 50,
  });
  checks.check("delivered 集合 = queued 集合", queuedIds.length >= 50 && missing.length === 0, {
    queued: queuedIds.length,
    delivered: deliveredIds.length,
    missing,
  });
  checks.check("无重复交付（messageId 唯一）", duplicates.length === 0, { duplicates });
  checks.check("delivered targetId 与 queued 一致", targetMismatch.length === 0, {
    mismatches: targetMismatch.slice(0, 3),
  });
  evidence.messages = {
    queued: queuedIds.length,
    delivered: deliveredIds.length,
    missing,
    duplicates,
    sampleQueued: queuedIds.slice(0, 3),
  };
} catch (err) {
  checks.check("S5 未抛异常", false, { error: String(err?.stack ?? err).slice(0, 2000) });
} finally {
  const exited = await daemon.kill("SIGINT");
  const result = checks.toJSON({
    evidence,
    daemonExit: exited,
    daemonStderrTail: daemon.stderr().slice(-6000),
    env: { zcode: cfg.zcode, dataRoot: cfg.dataRoot, db: cfg.dbPath },
  });
  const file = writeResult(cfg.out, "S5", result);
  process.stdout.write(`S5 result → ${file}\n`);
  if (!result.pass) process.exitCode = 1;
  if (process.env.E2E_KEEP !== "1") {
    try {
      fs.rmSync(cfg.dataRoot, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* 证据已落盘 */
    }
  }
}
