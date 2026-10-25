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

describe("TranscriptReader · 0.4.0 三源探针（提交快照/带时间条目/主轮调用）", () => {
  it("库不存在 → 三源探针与导出全走空库语义（undefined/[]/null，不抛错）", () => {
    const reader = new TranscriptReader({ dbPath: path.join(dir, "missing2.sqlite") });
    expect(reader.latestSubmissionSelection("s")).toBeUndefined();
    expect(reader.latestModelSelectionTimed("s")).toBeUndefined();
    expect(reader.latestMainTurnUsage("s")).toBeUndefined();
    expect(reader.firstRealUserText("s")).toBeNull();
    expect(reader.realUserTexts("s")).toEqual([]);
    expect(reader.latestModel("s")).toBeUndefined();
    expect(reader.exportTurns("s")).toEqual([]);
    expect(reader.exportDetailParts("s")).toEqual([]);
    reader.close();
  });

  it("latestSubmissionSelection：最新提交胜；空白三元组作废；非 real_user 不算提交；无档位不带 reasoningLevel", () => {
    // 两条提交（time_created 不同）→ 最新者胜
    insertSubmission(dbPath, { sessionId: "s-sub", providerId: "p1", modelId: "m1", timeCreated: 100 });
    insertSubmission(dbPath, { sessionId: "s-sub", providerId: "p2", modelId: "m2", reasoningLevel: "high", timeCreated: 200 });
    // 空白 providerId（宿主异常形态）→ WHERE 过滤 modelId 非 NULL 但 providerId 空白 → 整行仍返回？
    //   实际 latestSubmissionSelection 读 providerId/modelId 后 trim，空白 → undefined。
    insertSubmission(dbPath, { sessionId: "s-sub-blank", providerId: "  ", modelId: "x", timeCreated: 1 });
    // 非 real_user（hook 注入）→ 不算提交
    insertNonRealUser(dbPath, { sessionId: "s-sub-hook", providerId: "p", modelId: "m", timeCreated: 1 });
    const reader = new TranscriptReader({ dbPath });
    expect(reader.latestSubmissionSelection("s-sub")).toEqual({
      selection: { providerId: "p2", modelId: "m2", reasoningLevel: "high" },
      at: 200,
    });
    // 无档位提交 → selection 不含 reasoningLevel
    insertSubmission(dbPath, { sessionId: "s-sub-nolvl", providerId: "p3", modelId: "m3", timeCreated: 1 });
    expect(reader.latestSubmissionSelection("s-sub-nolvl")).toEqual({
      selection: { providerId: "p3", modelId: "m3" },
      at: 1,
    });
    expect(reader.latestSubmissionSelection("s-sub-blank")).toBeUndefined();
    expect(reader.latestSubmissionSelection("s-sub-hook")).toBeUndefined();
    expect(reader.latestSubmissionSelection("s-sub-none")).toBeUndefined();
    reader.close();
  });

  it("latestModelSelectionTimed：at=MAX(time_updated,time_created)；坏 JSON 条目 → undefined", () => {
    // time_updated 比 time_created 新（/model 提交后修改）→ at 取 time_updated
    insertSessionEntry(dbPath, {
      sessionId: "s-t1",
      id: "s-t1:runtime-model-selection",
      timeCreated: 100,
      data: { modelSelection: { providerId: "p", modelId: "m" } },
    });
    bumpEntryTime(dbPath, "s-t1:runtime-model-selection", 900);
    // 坏 JSON 条目 → latestModelSelection undefined → timed 也 undefined
    const raw = new DatabaseSync(dbPath);
    raw.prepare(
      "INSERT OR REPLACE INTO session_entry (id, session_id, type, time_created, time_updated, data) VALUES (?,?,?,?,?,?)",
    ).run("s-t2:runtime-model-selection", "s-t2", "runtime/model_selection", 1, 1, "{broken");
    raw.close();
    const reader = new TranscriptReader({ dbPath });
    expect(reader.latestModelSelectionTimed("s-t1")).toEqual({
      selection: { providerId: "p", modelId: "m" },
      at: 900,
    });
    expect(reader.latestModelSelectionTimed("s-t2")).toBeUndefined();
    expect(reader.latestModelSelectionTimed("s-none")).toBeUndefined();
    reader.close();
  });

  it("latestMainTurnUsage：主轮过滤（辅助行不算）；空白三元组 → undefined；variant 空白 → 无档位", () => {
    // 更晚的辅助行（compact）必须被 query_source='main_turn' 过滤
    insertModelUsage(dbPath, { sessionId: "s-mu", providerId: "acct", modelId: "title", startedAt: 900, querySource: "session_title" });
    insertModelUsage(dbPath, { sessionId: "s-mu", providerId: "p", modelId: "m", variant: "low", startedAt: 800, querySource: "main_turn" });
    // 空白 provider → undefined
    insertModelUsage(dbPath, { sessionId: "s-mu-blank", providerId: " ", modelId: "m", startedAt: 1 });
    // variant 空白 → 无 reasoningLevel
    insertModelUsage(dbPath, { sessionId: "s-mu-nov", providerId: "p2", modelId: "m2", variant: "  ", startedAt: 1 });
    const reader = new TranscriptReader({ dbPath });
    expect(reader.latestMainTurnUsage("s-mu")).toEqual({
      selection: { providerId: "p", modelId: "m", reasoningLevel: "low" },
      at: 800,
    });
    expect(reader.latestMainTurnUsage("s-mu-blank")).toBeUndefined();
    expect(reader.latestMainTurnUsage("s-mu-nov")).toEqual({
      selection: { providerId: "p2", modelId: "m2" },
      at: 1,
    });
    expect(reader.latestMainTurnUsage("s-mu-none")).toBeUndefined();
    reader.close();
  });
});

describe("TranscriptReader · 导出与文本探针防御分支", () => {
  it("exportTurns：损坏行跳过；非 text/tool part 跳过；tool 归并；孤立 tool 新开 assistant", () => {
    const sid = "s-exp";
    const ins = (mid: string, seq: number, mdata: string, pdata: string) => {
      db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)").run(mid, sid, seq, seq, mdata, seq);
      db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?,?)").run(`p-${mid}`, mid, sid, seq, seq, pdata, 0);
    };
    ins("bad-m", 0, "{broken", JSON.stringify({ type: "text", text: "x" }));
    ins("bad-p", 1, JSON.stringify({ role: "assistant" }), "{broken");
    ins("u1", 2, JSON.stringify({ role: "user", semantics: { origin: "real_user" } }), JSON.stringify({ type: "text", text: "问" }));
    ins("a1", 3, JSON.stringify({ role: "assistant" }), JSON.stringify({ type: "text", text: "答" }));
    ins("a2", 4, JSON.stringify({ role: "assistant" }), JSON.stringify({ type: "tool", tool: "Bash" }));
    ins("a3", 5, JSON.stringify({ role: "assistant" }), JSON.stringify({ type: "tool", tool: "Read" }));
    ins("a4", 6, JSON.stringify({ role: "assistant" }), JSON.stringify({ type: "reasoning" }));
    ins("u2", 7, JSON.stringify({ role: "user", semantics: { origin: "real_user" } }), JSON.stringify({ type: "text", text: "再问" }));
    ins("a5", 8, JSON.stringify({ role: "assistant" }), JSON.stringify({ type: "text", text: "再答" }));
    ins("a6", 9, JSON.stringify({ role: "assistant" }), JSON.stringify({ type: "tool", tool: "Edit" }));
    ins("sys1", 10, JSON.stringify({ role: "system" }), JSON.stringify({ type: "text", text: "noise" }));
    const reader = new TranscriptReader({ dbPath });
    expect(reader.exportTurns(sid)).toEqual([
      { role: "user", text: "问", toolNames: [] },
      { role: "assistant", text: "答", toolNames: ["Bash"] },
      { role: "assistant", text: "", toolNames: ["Read"] },
      { role: "user", text: "再问", toolNames: [] },
      { role: "assistant", text: "再答", toolNames: ["Edit"] },
    ]);
    reader.close();
  });

  it("exportDetailParts：坏行/未知角色/非 real_user 用户行/非契约 part 全跳过；tool 状态与非数值 ts 归一", () => {
    const sid = "s-detail";
    const ins = (mid: string, seq: number, mdata: string, pdata: string, ptc?: number) => {
      db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)").run(mid, sid, seq, seq, mdata, seq);
      db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?,?)").run(`p-${mid}`, mid, sid, ptc ?? seq, seq, pdata, 0);
    };
    ins("d-bad-m", 0, "{broken", JSON.stringify({ type: "text", text: "x" }));
    ins("d-bad-p", 1, JSON.stringify({ role: "assistant" }), "{broken");
    ins("d-sys", 2, JSON.stringify({ role: "system" }), JSON.stringify({ type: "text", text: "n" }));
    ins("d-hookuser", 3, JSON.stringify({ role: "user", semantics: { origin: "agent_runtime" } }), JSON.stringify({ type: "text", text: "inject" }));
    ins("d-user", 4, JSON.stringify({ role: "user", semantics: { origin: "real_user" } }), JSON.stringify({ type: "text", text: "问题" }), 400);
    ins("d-tool", 5, JSON.stringify({ role: "assistant" }), JSON.stringify({ type: "tool", tool: "Bash", state: { status: 42, input: { c: 1 }, output: "ok" } }), 500);
    ins("d-tool2", 6, JSON.stringify({ role: "assistant" }), JSON.stringify({ type: "tool", tool: "Read" }));
    ins("d-file", 7, JSON.stringify({ role: "assistant" }), JSON.stringify({ type: "file", path: "/x" }));
    ins("d-a", 8, JSON.stringify({ role: "assistant" }), JSON.stringify({ type: "text", text: "回答" }));
    const reader = new TranscriptReader({ dbPath });
    expect(reader.exportDetailParts(sid)).toEqual([
      { ts: 400, role: "user", kind: "text", text: "问题" },
      { ts: 500, role: "assistant", kind: "toolCall", toolName: "Bash", toolStatus: "unknown", toolInput: { c: 1 }, toolOutput: "ok" },
      { ts: 6, role: "assistant", kind: "toolCall", toolName: "Read", toolStatus: "unknown" },
      { ts: 8, role: "assistant", kind: "text", text: "回答" },
    ]);
    reader.close();
  });

  it("firstRealUserText/realUserTexts：text part 缺 text 字段 → null；消息无 text part → 不进结果", () => {
    // part 是合法 JSON 的 text 型但无 text 字段 → extractText null → firstRealUserText null
    // （WHERE 里 json_extract 会先于 extractText 对坏 JSON 报错——宿主行恒合法，防御在 extractText）
    db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)").run(
      "m-ft", "s-ft", 1, 1, JSON.stringify({ role: "user", semantics: { origin: "real_user" } }), 0,
    );
    db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?,?)").run(
      "p-ft", "m-ft", "s-ft", 1, 1, JSON.stringify({ type: "text" }), 0,
    );
    // realUserTexts：消息存在但无 part 行 → 不出现在结果
    db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)").run(
      "m-nopart", "s-np", 2, 2, JSON.stringify({ role: "user", semantics: { origin: "real_user" }, modelSelection: { modelId: "mm" } }), 0,
    );
    const reader = new TranscriptReader({ dbPath });
    expect(reader.firstRealUserText("s-ft")).toBeNull();
    expect(reader.realUserTexts("s-np")).toEqual([]);
    reader.close();
  });
});

// --- 0.4.0 三源探针夹具 ---

function insertSubmission(
  dbPath: string,
  args: { sessionId: string; providerId: string; modelId: string; reasoningLevel?: string; timeCreated: number },
): void {
  const raw = new DatabaseSync(dbPath);
  try {
    raw.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)",
    ).run(
      `sub-${args.sessionId}-${args.timeCreated}`,
      args.sessionId,
      args.timeCreated,
      args.timeCreated,
      JSON.stringify({
        role: "user",
        semantics: { origin: "real_user" },
        modelSelection: {
          providerId: args.providerId,
          modelId: args.modelId,
          ...(args.reasoningLevel !== undefined ? { options: { reasoningLevel: args.reasoningLevel } } : {}),
        },
      }),
      args.timeCreated,
    );
  } finally {
    raw.close();
  }
}

function insertNonRealUser(
  dbPath: string,
  args: { sessionId: string; providerId: string; modelId: string; timeCreated: number },
): void {
  const raw = new DatabaseSync(dbPath);
  try {
    raw.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)",
    ).run(
      `hook-${args.sessionId}-${args.timeCreated}`,
      args.sessionId,
      args.timeCreated,
      args.timeCreated,
      JSON.stringify({
        role: "user",
        semantics: { origin: "agent_runtime" },
        modelSelection: { providerId: args.providerId, modelId: args.modelId },
      }),
      args.timeCreated,
    );
  } finally {
    raw.close();
  }
}

function bumpEntryTime(dbPath: string, entryId: string, timeUpdated: number): void {
  const raw = new DatabaseSync(dbPath);
  try {
    raw.prepare("UPDATE session_entry SET time_updated = ? WHERE id = ?").run(timeUpdated, entryId);
  } finally {
    raw.close();
  }
}
