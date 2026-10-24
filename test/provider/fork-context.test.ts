// D3 fork 上下文（T4.2/F02）：转录注入位置（任务块之前）、截断策略、暗号可继承性、身份不占首轮块位。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TranscriptReader } from "../../src/provider/transcript.js";
import { buildForkFirstPrompt, truncateTurns, FORK_HEADER, FORK_FOOTER } from "../../src/provider/fork-context.js";
import { createTestDb } from "./kit.js";

let dir = "";
let db: DatabaseSync;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-s4-fk-"));
  const dbPath = path.join(dir, "db.sqlite");
  createTestDb(dbPath);
  db = new DatabaseSync(dbPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function insertText(sessionId: string, role: "user" | "assistant", text: string, seq: number): void {
  const now = Date.now() + seq;
  const msgId = `m${seq}`;
  db.prepare("INSERT INTO session (id, directory, task_type, time_created) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING").run(sessionId, "/ws", "interactive", now);
  db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)").run(
    msgId,
    sessionId,
    now,
    now,
    JSON.stringify({ role, semantics: { origin: role === "user" ? "real_user" : "model" } }),
    seq,
  );
  db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?,?)").run(
    `p${seq}`,
    msgId,
    sessionId,
    now,
    now,
    JSON.stringify({ type: "text", text }),
    0,
  );
}

describe("buildForkFirstPrompt（D3）", () => {
  it("位置断言：转录在任务块之前、以任务块收尾；框架头/尾在场", () => {
    insertText("lead", "user", "埋下暗号 fir-s4-77", 0);
    insertText("lead", "assistant", "记住了", 1);
    const reader = new TranscriptReader({ dbPath: path.join(dir, "db.sqlite") });
    const result = buildForkFirstPrompt(reader, "lead", "写 sort 测试");
    expect(result.prompt.startsWith(FORK_HEADER)).toBe(true);
    expect(result.prompt).toContain("fir-s4-77"); // 暗号进入转录（teammate 能答出——F02 真实路径）
    const taskIdx = result.prompt.indexOf("写 sort 测试");
    const headerIdx = result.prompt.indexOf(FORK_FOOTER);
    expect(taskIdx).toBeGreaterThan(headerIdx); // 任务块在转录（尾标）之后 = 转录之前
    expect(result.prompt.endsWith("写 sort 测试")).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.includedTurns).toBe(2);
    reader.close();
  });

  it("无身份前缀块（D2）：prompt 不含 team:identity 文本", () => {
    insertText("lead", "user", "q", 0);
    const reader = new TranscriptReader({ dbPath: path.join(dir, "db.sqlite") });
    const result = buildForkFirstPrompt(reader, "lead", "task");
    expect(result.prompt).not.toContain("You are teammate");
    expect(result.prompt).not.toContain("You are the Team Lead");
    reader.close();
  });

  it("空转录（Lead 无已完成回合）→ 仅任务块", () => {
    const reader = new TranscriptReader({ dbPath: path.join(dir, "db.sqlite") });
    const result = buildForkFirstPrompt(reader, "lead", "只做任务");
    expect(result.includedTurns).toBe(0);
    expect(result.prompt).toContain("只做任务");
    reader.close();
  });
});

describe("truncateTurns", () => {
  it("预算内全保留", () => {
    const turns = [
      { role: "user" as const, text: "a".repeat(100), toolNames: [] },
      { role: "assistant" as const, text: "b".repeat(100), toolNames: [] },
    ];
    expect(truncateTurns(turns, 300)).toEqual({ turns, truncated: false });
  });

  it("超预算 → 保留首回合 + 最近回合，标记 truncated", () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `${i}-`.repeat(100),
      toolNames: [],
    }));
    const kept = truncateTurns(turns, 400);
    expect(kept.truncated).toBe(true);
    expect(kept.turns[0]).toBe(turns[0]); // 首回合锚定
    expect(kept.turns[kept.turns.length - 1]).toBe(turns[turns.length - 1]); // 最近回合贴近现场
    expect(kept.turns.length).toBeLessThan(turns.length);
    const total = kept.turns.reduce((sum, t) => sum + t.text.length, 0);
    expect(total).toBeLessThanOrEqual(400 + turns[0].text.length);
  });
});
