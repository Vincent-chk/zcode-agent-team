// TranscriptReader 单测：schema 子集库上的探针语义（首条真实用户文本/落库判定/导出/模型行）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranscriptReader } from "../../src/provider/transcript.js";
import { createTestDb, insertModelUsage, insertSessionEntry } from "./kit.js";

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
    expect(reader.latestModelSelection("sess_x")).toBeUndefined();
    expect(reader.latestModelUsage("sess_x")).toBeUndefined();
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

describe("TranscriptReader · 模型选择/模型调用探针（stage-8 Round B）", () => {
  it("latestModelSelection：嵌套三元组优先，time_created 最新者胜", () => {
    insertSessionEntry(dbPath, {
      sessionId: "s1",
      id: "entry-old",
      timeCreated: 1,
      data: { modelSelection: { providerId: "p1", modelId: "m1", options: { reasoningLevel: "high" } } },
    });
    insertSessionEntry(dbPath, {
      sessionId: "s1",
      id: "entry-new",
      timeCreated: 2,
      data: { modelSelection: { providerId: "p2", modelId: "m2" } },
    });
    const reader = new TranscriptReader({ dbPath });
    expect(reader.latestModelSelection("s1")).toEqual({ providerId: "p2", modelId: "m2" });
    expect(reader.latestModelSelection("s-none")).toBeUndefined();
    reader.close();
  });

  it("latestModelSelection：兼容平铺旧行；坏 JSON / 无效形状 → undefined", () => {
    insertSessionEntry(dbPath, {
      sessionId: "s-flat",
      data: { providerId: "p3", modelId: "m3", thoughtLevel: "low" },
    });
    const raw = new DatabaseSync(dbPath);
    raw.prepare(
      "INSERT INTO session_entry (id, session_id, type, time_created, time_updated, data) VALUES (?,?,?,?,?,?)",
    ).run("entry-bad", "s-bad", "runtime/model_selection", 1, 1, "{broken");
    raw.prepare(
      "INSERT INTO session_entry (id, session_id, type, time_created, time_updated, data) VALUES (?,?,?,?,?,?)",
    ).run(
      "entry-invalid",
      "s-invalid",
      "runtime/model_selection",
      1,
      1,
      JSON.stringify({ modelSelection: { providerId: "p" }, modelId: "m-top" }),
    );
    raw.close();
    const reader = new TranscriptReader({ dbPath });
    expect(reader.latestModelSelection("s-flat")).toEqual({
      providerId: "p3",
      modelId: "m3",
      reasoningLevel: "low",
    });
    expect(reader.latestModelSelection("s-bad")).toBeUndefined();
    expect(reader.latestModelSelection("s-invalid")).toBeUndefined();
    reader.close();
  });

  it("latestModelUsage：最新记录；variant → reasoningLevel；空 variant/空三元组归一", () => {
    insertModelUsage(dbPath, { sessionId: "u1", providerId: "p1", modelId: "m1", variant: "high", startedAt: 1 });
    insertModelUsage(dbPath, { sessionId: "u1", providerId: "p2", modelId: "m2", variant: null, startedAt: 2 });
    insertModelUsage(dbPath, { sessionId: "u2", providerId: "p3", modelId: "m3", variant: "max", startedAt: 1 });
    insertModelUsage(dbPath, { sessionId: "u-empty", providerId: " ", modelId: "m4", startedAt: 1 });
    const reader = new TranscriptReader({ dbPath });
    expect(reader.latestModelUsage("u1")).toEqual({ providerId: "p2", modelId: "m2" });
    expect(reader.latestModelUsage("u2")).toEqual({ providerId: "p3", modelId: "m3", reasoningLevel: "max" });
    expect(reader.latestModelUsage("u-empty")).toBeUndefined();
    expect(reader.latestModelUsage("u-none")).toBeUndefined();
    reader.close();
  });
});
