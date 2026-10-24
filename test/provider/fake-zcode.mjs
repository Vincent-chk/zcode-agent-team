// fake-zcode：zcode CLI 的可编程替身（stage-4 集成测试夹具；零模型调用、确定性、毫秒级）。
// 模拟面：-p/--resume/--json/--cwd 参数解析；db.sqlite（TEAM_DB_PATH 指定的测试库）写入
// session/message/part 行（schema/字段形态对齐 23-F08）；--json 尾输出 {sessionId,...}；
// 可编程故障（环境变量）：
//   FAKE_ZCODE_NO_PERSIST=1   进程起但不落任何行（F04：进程起但会话未落）
//   FAKE_ZCODE_PRE_SLEEP_MS=<n> 落库**前**睡眠（F14：inflight 不可取消窗口——deliver 确认循环挂起）
//   FAKE_ZCODE_SLEEP_MS=<n>   落库后长任务睡眠（interrupt/边界测试）
//   FAKE_ZCODE_IGNORE_SIGTERM=1 忽略 SIGTERM（SIGKILL 升级路径）
//   FAKE_ZCODE_EXIT_CODE=<n>  退出码
//   FAKE_ZCODE_RESPONSE=<txt> assistant 文本
import fs from "node:fs";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
const prompt = arg("-p");
const resume = arg("--resume");
const cwd = arg("--cwd") ?? process.cwd();
const dbPath = process.env.TEAM_DB_PATH;
if (!dbPath) {
  process.stderr.write("fake-zcode: TEAM_DB_PATH required\n");
  process.exit(2);
}
if (prompt === undefined) {
  process.stderr.write("fake-zcode: -p required\n");
  process.exit(2);
}

// 组信号处置：默认尊重 SIGTERM（H5 语义）；IGNORE 模式下挂住等 SIGKILL
if (process.env.FAKE_ZCODE_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
}

if (process.env.FAKE_ZCODE_NO_PERSIST !== "1") {
  if (process.env.FAKE_ZCODE_PRE_SLEEP_MS) {
    const pre = Date.now() + Number(process.env.FAKE_ZCODE_PRE_SLEEP_MS);
    while (Date.now() < pre) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  const sessionId = resume ?? `sess_fake_${crypto.randomUUID()}`;
  const now = Date.now();
  db.prepare(
    "INSERT OR IGNORE INTO session (id, directory, task_type, title, time_created, time_updated) VALUES (?,?,?,?,?,?)",
  ).run(sessionId, cwd, "interactive", prompt.slice(0, 60), now, now);
  const msgId = `msg_fake_${crypto.randomUUID()}`;
  db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)").run(
    msgId,
    sessionId,
    now,
    now,
    JSON.stringify({
      role: "user",
      semantics: { origin: "real_user", kind: "user_prompt" },
      modelSelection: { providerId: "fake", modelId: process.env.FAKE_ZCODE_MODEL ?? "fake-flash" },
    }),
    0,
  );
  db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?,?)").run(
    `part_fake_${crypto.randomUUID()}`,
    msgId,
    sessionId,
    now,
    now,
    JSON.stringify({ type: "text", text: prompt }),
    0,
  );
  // assistant 回复（transcript 完整性/fork 导出/.latestModel 用）
  const aMsgId = `msg_fake_${crypto.randomUUID()}`;
  const response = process.env.FAKE_ZCODE_RESPONSE ?? "fake-ok";
  db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)").run(
    aMsgId,
    sessionId,
    now + 1,
    now + 1,
    JSON.stringify({ role: "assistant", semantics: { origin: "model" } }),
    1,
  );
  db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?,?)").run(
    `part_fake_${crypto.randomUUID()}`,
    aMsgId,
    sessionId,
    now + 1,
    now + 1,
    JSON.stringify({ type: "text", text: response }),
    0,
  );
  db.close();
  if (process.env.FAKE_ZCODE_SLEEP_MS) {
    const ms = Number(process.env.FAKE_ZCODE_SLEEP_MS);
    const end = Date.now() + ms;
    while (Date.now() < end) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(200, end - Date.now()));
    }
  }
  process.stdout.write(
    JSON.stringify({ sessionId, traceId: "tr_fake", turnId: "turn_fake", response, usage: {}, eventCount: 2, projection: {} }) + "\n",
  );
}
process.exit(Number(process.env.FAKE_ZCODE_EXIT_CODE ?? 0));
