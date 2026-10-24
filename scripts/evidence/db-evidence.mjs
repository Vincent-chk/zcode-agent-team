#!/usr/bin/env node
// 证据补验（stage-4 S3 db 实查 + stage-5/6 SF15 ③）：
//   node scripts/evidence/db-evidence.mjs --team-dir <teams/xxx> --team <leadId> \
//        [--db <db.sqlite>] [--tasks-index <tasks-index.sqlite>] [--out <file.json>]
// 只读：db.sqlite / tasks-index 均 readOnly 打开；输出真实 messageId/targetId/senderName/
// promptHead/resumeArg、成员 origin、anchor 行与成员行状态（deleted/archived）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const teamDir = path.resolve(argOf("team-dir") ?? "");
const teamId = argOf("team");
const dbPath = argOf("db") ?? process.env.TEAM_DB_PATH ?? path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
const tasksIndex = argOf("tasks-index") ?? process.env.TEAM_TASKS_INDEX ?? path.join(os.homedir(), ".zcode", "v2", "tasks-index.sqlite");
const outFile = argOf("out") ?? path.join(teamDir, `db-evidence-${Date.now()}.json`);
if (teamId === undefined || !fs.existsSync(teamDir)) {
  process.stderr.write("usage: --team-dir <dir> --team <leadId>\n");
  process.exit(2);
}

function readEvents() {
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
function query(dbFile, sql, params = []) {
  if (!fs.existsSync(dbFile)) return [];
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } catch (err) {
    return [{ error: String(err?.message ?? err) }];
  } finally {
    db.close();
  }
}
function origins() {
  const membersRoot = path.join(teamDir, "members");
  let ids;
  try {
    ids = fs.readdirSync(membersRoot);
  } catch {
    return [];
  }
  return ids
    .map((id) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(membersRoot, id, "origin.json"), "utf8"));
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}
function turnsOf(memberId) {
  const runDir = path.join(teamDir, "members", memberId, "run");
  try {
    return fs
      .readdirSync(runDir)
      .filter((f) => /^turn-\d+\.json$/.test(f))
      .sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(runDir, f), "utf8")));
  } catch {
    return [];
  }
}

const events = readEvents();
const eventList = events.map((line) => line.event);
const queued = eventList.filter((e) => e.type === "team/message/queued").map((e) => e.message);
const delivered = eventList.filter((e) => e.type === "team/message/delivered");
const tasks = new Map();
for (const e of eventList.filter((x) => x.type === "team/task")) tasks.set(e.task.id, e.task);
const originsList = origins();

const messages = queued.map((message) => {
  const deliveries = delivered.filter((d) => d.messageId === message.id);
  const member = originsList.find((o) => o.memberId === message.senderId);
  return {
    messageId: message.id,
    senderName: message.senderName,
    senderId: message.senderId,
    targetId: message.targetId,
    contentHead: String(message.content?.[0]?.text ?? "").slice(0, 120),
    delivered: deliveries.length > 0,
    deliveredTargetId: deliveries[0]?.targetId ?? null,
    senderSessionId: member?.sessionId ?? (message.senderId === teamId ? teamId : null),
  };
});

const deliverTurns = originsList.flatMap((origin) =>
  turnsOf(origin.memberId)
    .filter((turn) => turn.kind === "deliver")
    .map((turn) => ({
      member: origin.name,
      memberId: origin.memberId,
      turnId: turn.turnId,
      messageIds: turn.messageIds,
      promptHead: String(turn.promptText ?? "").split("\n")[0],
      resumeArg: Array.isArray(turn.argv) && turn.argv.indexOf("--resume") !== -1 ? turn.argv[turn.argv.indexOf("--resume") + 1] : null,
      resumeMatchesSession: turn.argv?.includes("--resume") ? turn.argv[turn.argv.indexOf("--resume") + 1] === origin.sessionId : null,
      landed: turn.landed === true,
      status: turn.status,
    })),
);

const sessionRows = [teamId, ...originsList.map((o) => o.sessionId).filter(Boolean)].map((id) => ({
  id,
  ...(query(dbPath, "SELECT id, directory, task_type, title FROM session WHERE id = ?", [id])[0] ?? { missing: true }),
}));

const taskIndexRows = [];
for (const origin of originsList) {
  if (typeof origin.anchorSessionId === "string") {
    taskIndexRows.push({
      kind: "anchor",
      member: origin.name,
      taskId: origin.anchorSessionId,
      row: query(tasksIndex, "SELECT task_id, title, deleted, archived, workspace_path FROM tasks WHERE task_id = ?", [
        origin.anchorSessionId,
      ])[0] ?? null,
    });
  }
  if (typeof origin.sessionId === "string") {
    taskIndexRows.push({
      kind: "member",
      member: origin.name,
      taskId: origin.sessionId,
      row: query(tasksIndex, "SELECT task_id, title, deleted, archived, workspace_path FROM tasks WHERE task_id = ?", [
        origin.sessionId,
      ])[0] ?? null,
    });
  }
}

const deliveredIds = delivered.map((d) => d.messageId);
const invariants = {
  deliveredSubsetOfQueued: deliveredIds.every((id) => messages.some((m) => m.messageId === id)),
  noDuplicateDeliveries: deliveredIds.length === new Set(deliveredIds).size,
  seqContinuous: events.every((line, index) => line.seq === index + 1),
  anchorsTombstoned: taskIndexRows
    .filter((row) => row.kind === "anchor" && row.row !== null)
    .every((row) => row.row.deleted === 1),
  childMembersAbsentFromTaskIndex: taskIndexRows
    .filter((row) => row.kind === "member" && originsList.find((o) => o.name === row.member)?.sessionIsolation === "child")
    .every((row) => row.row === null || row.row.archived === 1),
};

const report = {
  teamId,
  teamDir,
  dbPath,
  tasksIndex,
  generatedAt: new Date().toISOString(),
  events: {
    lines: events.length,
    lastSeq: events.at(-1)?.seq ?? 0,
    types: Object.fromEntries(eventList.reduce((acc, e) => acc.set(e.type, (acc.get(e.type) ?? 0) + 1), new Map())),
  },
  tasks: [...tasks.values()].map((task) => ({ id: task.id, revision: task.revision, status: task.status, subject: task.subject })),
  origins: originsList.map((origin) => ({
    name: origin.name,
    memberId: origin.memberId,
    sessionId: origin.sessionId,
    context: origin.context,
    sessionIsolation: origin.sessionIsolation ?? null,
    anchorSessionId: origin.anchorSessionId ?? null,
    workspace: origin.cwd,
  })),
  messages,
  deliverTurns,
  sessionRows,
  taskIndexRows,
  invariants,
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(report, null, 2), { mode: 0o600 });
process.stdout.write(JSON.stringify({ out: outFile, invariants, events: report.events, messages: messages.length, deliverTurns: deliverTurns.length }, null, 2) + "\n");
process.exitCode = Object.values(invariants).every(Boolean) ? 0 : 1;
