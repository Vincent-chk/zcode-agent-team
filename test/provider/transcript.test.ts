// TranscriptReader 单测：schema 子集库上的探针语义（首条真实用户文本/落库判定/导出/模型行）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranscriptReader } from "../../src/provider/transcript.js";
import { createTestDb } from "./kit.js";

let dir = "";
let dbPath = "";
let db: DatabaseSync;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-s4-tr-"));
  dbPath = path.join(dir, "db.sqlite");
  createTestDb(dbPath);
  db = new DatabaseSync(dbPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function insertTurn(sessionId: string, role: string, text: string, origin: string, seq: number, model = "m1"): void {
  const now = Date.now();
  const msgId = `msg_${crypto.randomUUID()}`;
  db.prepare("INSERT INTO session (id, directory, task_type, time_created) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING").run(sessionId, "/ws", "interactive", now);
  db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)").run(
    msgId,
    sessionId,
    now,
    now,
    JSON.stringify({
      role,
      semantics: { origin, kind: origin === "real_user" ? "user_prompt" : "model" },
      ...(role === "user" ? { modelSelection: { providerId: "p", modelId: model } } : {}),
    }),
    seq,
  );
  db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?,?)").run(
    `part_${crypto.randomUUID()}`,
    msgId,
    sessionId,
    now,
    now,
    JSON.stringify({ type: "text", text }),
    0,
  );
}

describe("TranscriptReader", () => {
  it("库不存在 → session undefined / hasUserText false（空库语义，不抛错）", () => {
    const reader = new TranscriptReader({ dbPath: path.join(dir, "missing.sqlite") });
    expect(reader.session("sess_x")).toBeUndefined();
    expect(reader.hasUserText("sess_x", "t")).toBe(false);
    expect(reader.findSessionByFirstPrompt({ cwd: "/ws", firstPrompt: "t", sinceMs: 0 })).toBeUndefined();
    reader.close();
  });

  it("firstRealUserText / hasUserText：跳过非 real_user（hook/系统注入不计数）", () => {
    insertTurn("s1", "user", "hook message", "agent_runtime", 0);
    insertTurn("s1", "user", "real prompt", "real_user", 1);
    insertTurn("s1", "assistant", "answer", "model", 2);
    const reader = new TranscriptReader({ dbPath });
    expect(reader.firstRealUserText("s1")).toBe("real prompt");
    expect(reader.hasUserText("s1", "real prompt")).toBe(true);
    expect(reader.hasUserText("s1", "hook message")).toBe(false);
    reader.close();
  });

  it("findSessionByFirstPrompt：按 cwd+首条真实用户文本锚定；排除已认领会话", () => {
    insertTurn("s1", "user", "alpha prompt", "real_user", 0);
    insertTurn("s2", "user", "beta prompt", "real_user", 0);
    const reader = new TranscriptReader({ dbPath });
    expect(reader.findSessionByFirstPrompt({ cwd: "/ws", firstPrompt: "beta prompt", sinceMs: 0 })).toBe("s2");
    expect(
      reader.findSessionByFirstPrompt({ cwd: "/ws", firstPrompt: "beta prompt", sinceMs: 0, excludeSessionIds: new Set(["s2"]) }),
    ).toBeUndefined();
    expect(reader.findSessionByFirstPrompt({ cwd: "/other", firstPrompt: "alpha prompt", sinceMs: 0 })).toBeUndefined();
    reader.close();
  });

  it("exportTurns（D3 转录源数据）：real_user/assistant 文本 + tool 名；model-only 不导出", () => {
    insertTurn("s1", "user", "task A", "real_user", 0);
    insertTurn("s1", "assistant", "doing", "model", 1);
    const reader = new TranscriptReader({ dbPath });
    expect(reader.exportTurns("s1")).toEqual([
      { role: "user", text: "task A", toolNames: [] },
      { role: "assistant", text: "doing", toolNames: [] },
    ]);
    expect(reader.latestModel("s1")).toBe("m1");
    reader.close();
  });
});
