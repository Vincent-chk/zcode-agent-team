// T5.7 detail 合成器单测（F13 纯逻辑面）：
//  - 消息流合成：时间序、role 区分、text/toolCall 两型、hook_context 用户消息不进流；
//  - framed 徽标回填（源 state.messages/delivered；不改写原文；每条只标一次）；
//  - 分页游标（默认 100/上限 200/首屏=末页/nextCursor）；
//  - 载荷预算截断（truncated）；
//  - 错误路径（非成员 → TEAM_MEMBER_NOT_FOUND；会话未落定 → reason=session-not-settled）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../provider/kit.js";
import { TranscriptReader } from "../../src/provider/transcript.js";
import { writeOrigin, memberPaths } from "../../src/provider/member-files.js";
import {
  buildDetail,
  framedFor,
  pageDetail,
  normalizeLimit,
  resolveMemberSessionId,
  renderDetailText,
  SessionNotSettledError,
  DETAIL_MAX_LIMIT,
  DETAIL_DEFAULT_LIMIT,
} from "../../src/panel/detail.js";
import { emptyTeamState, type TeamState } from "../../src/domain/projection.js";
import { TeamError } from "../../src/domain/errors.js";

const TEAM = "sess_lead_detail";
const MEMBER_ID = "m_alice";
const MEMBER_SESSION = "sess_alice_child";

let dir = "";
let dbPath = "";
let db: DatabaseSync;
let teamDir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-s5-detail-"));
  dbPath = path.join(dir, "db.sqlite");
  createTestDb(dbPath);
  db = new DatabaseSync(dbPath);
  teamDir = path.join(dir, "team");
  fs.mkdirSync(teamDir, { recursive: true });
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let msgSeq = 0;
function insertMessage(
  sessionId: string,
  role: "user" | "assistant",
  origin: string,
  parts: Array<{ type: string; text?: string; tool?: string; status?: string; input?: unknown; output?: unknown }>,
): void {
  const now = Date.now() + msgSeq * 1000;
  msgSeq += 1;
  const msgId = `msg_${crypto.randomUUID()}`;
  db.prepare("INSERT INTO session (id, directory, task_type, time_created) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING").run(sessionId, "/ws", "interactive", now);
  db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)").run(
    msgId, sessionId, now, now,
    JSON.stringify({ role, semantics: { origin, kind: role === "user" ? "user_prompt" : "model" } }),
    msgSeq,
  );
  parts.forEach((p, i) => {
    const data: Record<string, unknown> = { type: p.type };
    if (p.text !== undefined) data.text = p.text;
    if (p.tool !== undefined) data.tool = p.tool;
    if (p.type === "tool") data.state = { status: p.status ?? "completed", ...(p.input !== undefined ? { input: p.input } : {}), ...(p.output !== undefined ? { output: p.output } : {}) };
    db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?,?)").run(
      `part_${crypto.randomUUID()}`, msgId, sessionId, now + i, now + i, JSON.stringify(data), i,
    );
  });
}

function stateWith(
  messages: TeamState["messages"],
  delivered: TeamState["delivered"],
  members: TeamState["members"] = [
    { id: MEMBER_ID, name: "alice", description: "d", provider: "spawn", context: "fresh", phase: "active" },
  ],
): TeamState {
  return { ...emptyTeamState(TEAM), members, messages, delivered };
}

function writeMemberOrigin(sessionId: string | null): void {
  writeOrigin(memberPaths(teamDir, MEMBER_ID), {
    teamId: TEAM,
    memberId: MEMBER_ID,
    name: "alice",
    provider: "spawn",
    mode: "continuable",
    context: "fresh",
    createdAt: new Date().toISOString(),
    cwd: "/ws",
    firstPromptText: "task",
    firstPromptSha256: "x",
    sessionId,
    initialUserMessageAccepted: sessionId !== null,
  });
}

function deps(state: TeamState, reader = new TranscriptReader({ dbPath })): Parameters<typeof buildDetail>[0] {
  return { teamDir, teamId: TEAM, state, reader };
}

const readOriginSession = (memberId: string): string | null | undefined =>
  fs.existsSync(path.join(teamDir, "members", memberId, "origin.json"))
    ? (JSON.parse(fs.readFileSync(path.join(teamDir, "members", memberId, "origin.json"), "utf8")) as { sessionId: string | null }).sessionId
    : undefined;

describe("synthesize：流合成（F13）", () => {
  it("时间序 + role 区分 + text/toolCall 两型；hook_context/系统消息不进流", () => {
    insertMessage(MEMBER_SESSION, "user", "hook_context", [{ type: "text", text: "[agent-team inbox] 注入" }]);
    insertMessage(MEMBER_SESSION, "user", "real_user", [{ type: "text", text: "请实现功能 A" }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [
      { type: "text", text: "开始处理" },
      { type: "tool", tool: "Bash", status: "completed", input: { command: "ls" }, output: "a\nb" },
    ]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "reasoning", text: "思考中" } as never]);
    const result = buildDetail(deps(stateWith([], [])), { target: MEMBER_ID }, () => MEMBER_SESSION);
    const kinds = result.page.items.map((i) => `${i.role}:${i.kind}`);
    expect(kinds).toEqual(["user:text", "assistant:text", "assistant:toolCall"]);
    expect(result.page.items[0].text).toBe("请实现功能 A");
    expect(result.page.items[2].tool).toEqual({ name: "Bash", status: "completed" });
    expect(result.page.items[2].text).toContain("input: ");
    expect(result.page.items[2].text).toContain("output: a\nb");
    // seq 连续、时间升序
    expect(result.page.items.map((i) => i.seq)).toEqual([1, 2, 3]);
    const times = result.page.items.map((i) => Date.parse(i.ts));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("framed 徽标回填：delivered 团队消息标注在携带框架头的 real_user 文本上（不改写原文）", () => {
    const messages = [
      { id: "msg-1", senderId: TEAM, senderName: "lead", targetId: MEMBER_ID, content: [{ type: "text" as const, text: "推进任务 B" }] },
      { id: "msg-2", senderId: TEAM, senderName: "lead", targetId: MEMBER_ID, content: [{ type: "text" as const, text: "收尾" }] },
    ];
    // msg-1 已投递（注入落库为合并 prompt 的 real_user 文本）；msg-2 未投递（不回填）
    insertMessage(MEMBER_SESSION, "user", "real_user", [
      { type: "text", text: "Team message from lead:\n推进任务 B" },
    ]);
    const result = buildDetail(
      deps(stateWith(messages, ["msg-1"])),
      { target: MEMBER_ID },
      () => MEMBER_SESSION,
    );
    const item = result.page.items[0];
    expect(item.framed).toEqual({ messageId: "msg-1", from: "lead" });
    expect(item.text).toBe("Team message from lead:\n推进任务 B"); // 原文不改写
  });

  it("每条消息只标注一次（同文本重复出现不重复认领）", () => {
    const messages = [
      { id: "msg-1", senderId: TEAM, senderName: "lead", targetId: MEMBER_ID, content: [{ type: "text" as const, text: "同一句话" }] },
    ];
    insertMessage(MEMBER_SESSION, "user", "real_user", [{ type: "text", text: "Team message from lead:\n同一句话" }]);
    insertMessage(MEMBER_SESSION, "user", "real_user", [{ type: "text", text: "Team message from lead:\n同一句话" }]);
    const result = buildDetail(
      deps(stateWith(messages, ["msg-1"])),
      { target: MEMBER_ID },
      () => MEMBER_SESSION,
    );
    const framedItems = result.page.items.filter((i) => i.framed !== undefined);
    expect(framedItems).toHaveLength(1);
    expect(framedItems[0].seq).toBe(1);
  });

  it("framedFor：仅 delivered 且目标匹配的消息（其他成员消息不进）", () => {
    const messages = [
      { id: "msg-1", senderId: TEAM, senderName: "lead", targetId: MEMBER_ID, content: [{ type: "text" as const, text: "a" }] },
      { id: "msg-2", senderId: TEAM, senderName: "lead", targetId: "m_bob", content: [{ type: "text" as const, text: "b" }] },
      { id: "msg-3", senderId: MEMBER_ID, senderName: "alice", targetId: TEAM, content: [{ type: "text" as const, text: "c" }] },
    ];
    const entries = framedFor(stateWith(messages, ["msg-1"]), MEMBER_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ messageId: "msg-1", from: "lead", body: "a" });
  });

  it("空会话 → 0 items（无消息三态由面板呈现）", () => {
    const result = buildDetail(deps(stateWith([], [])), { target: MEMBER_ID }, () => MEMBER_SESSION);
    expect(result.page.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("db 库缺失 → 0 items（空库语义，不抛错）", () => {
    const reader = new TranscriptReader({ dbPath: path.join(dir, "missing.sqlite") });
    const result = buildDetail(deps(stateWith([], []), reader), { target: MEMBER_ID }, () => MEMBER_SESSION);
    expect(result.page.items).toEqual([]);
    reader.close();
  });
});

describe("分页（契约：默认 100/上限 200/首屏=末页）", () => {
  function items(n: number): Array<{ ts: string; role: "user"; kind: "text"; text: string }> {
    return Array.from({ length: n }, (_, i) => ({
      ts: new Date(1760000000000 + i * 1000).toISOString(),
      role: "user" as const,
      kind: "text" as const,
      text: `m${i + 1}`,
    }));
  }

  it("默认 limit=100，首屏取末页（最近上下文）", () => {
    const { page, total } = pageDetail(items(250), {});
    expect(total).toBe(250);
    expect(page.items).toHaveLength(100);
    expect(page.items[99].text).toBe("m250"); // 末页 = 最近
    expect(page.items[0].text).toBe("m151");
    expect(page.items[0].seq).toBe(151);
    expect(page.nextCursor).toBe(151);
  });

  it("cursor 向更早翻页；翻到起点后无 nextCursor", () => {
    const all = items(250);
    const p1 = pageDetail(all, { cursor: 151 });
    expect(p1.page.items[0].text).toBe("m51");
    expect(p1.page.nextCursor).toBe(51);
    const p2 = pageDetail(all, { cursor: 51 });
    expect(p2.page.items[0].text).toBe("m1");
    expect(p2.page.nextCursor).toBeUndefined();
  });

  it("limit 上限 200（超请求收敛）；limit=1 边界", () => {
    expect(normalizeLimit(999)).toBe(DETAIL_MAX_LIMIT);
    expect(normalizeLimit(undefined)).toBe(DETAIL_DEFAULT_LIMIT);
    expect(() => normalizeLimit(0)).toThrow(TeamError);
    expect(() => normalizeLimit("x")).toThrow(TeamError);
    const { page } = pageDetail(items(10), { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].text).toBe("m10");
  });

  it("单页载荷 >256KiB → 页尾裁剪（丢最旧）+ truncated", () => {
    const big = Array.from({ length: 60 }, (_, i) => ({
      ts: new Date(1760000000000 + i).toISOString(),
      role: "user" as const,
      kind: "text" as const,
      text: "x".repeat(8000), // 60×8KiB ≈ 480KiB > 256KiB
    }));
    const { page, truncated } = pageDetail(big, { limit: 200 });
    expect(truncated).toBe(true);
    expect(JSON.stringify(page.items).length).toBeLessThanOrEqual(256 * 1024 + 4096); // 单条即 8KiB 的量化误差容许
    // 裁剪丢最旧：保留的是最近（末尾）的条目
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.length).toBeLessThan(60);
  });
});

describe("成员解析与错误路径", () => {
  it("lead → teamId 会话；成员名亦可作 target", () => {
    const byName = resolveMemberSessionId(deps(stateWith([], [])), "alice", () => MEMBER_SESSION);
    expect(byName).toEqual({ memberId: MEMBER_ID, sessionId: MEMBER_SESSION, name: "alice" });
    const lead = resolveMemberSessionId(deps(stateWith([], [])), "lead", () => null);
    expect(lead.sessionId).toBe(TEAM);
  });

  it("非成员 → TEAM_MEMBER_NOT_FOUND（消息逐字 02 §11 模板）", () => {
    expect(() => resolveMemberSessionId(deps(stateWith([], [])), "ghost", () => null)).toThrowError(
      new TeamError("TEAM_MEMBER_NOT_FOUND", 'active teammate "ghost" not found'),
    );
  });

  it("会话未落定 → SessionNotSettledError（reason=session-not-settled 数据源）", () => {
    try {
      resolveMemberSessionId(deps(stateWith([], [])), "alice", () => null);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SessionNotSettledError);
      expect((err as TeamError).code).toBe("TEAM_MEMBER_NOT_FOUND");
    }
  });

  it("origin.json 在场时按 origin.sessionId 解析（buildDetail 全链）", () => {
    writeMemberOrigin(MEMBER_SESSION);
    insertMessage(MEMBER_SESSION, "user", "real_user", [{ type: "text", text: "hi" }]);
    const result = buildDetail(deps(stateWith([], [])), { target: MEMBER_ID }, readOriginSession);
    expect(result.sessionId).toBe(MEMBER_SESSION);
    expect(result.page.items).toHaveLength(1);
  });

  it("origin 未落定（sessionId=null）→ SessionNotSettledError", () => {
    writeMemberOrigin(null);
    expect(() => buildDetail(deps(stateWith([], [])), { target: MEMBER_ID }, readOriginSession)).toThrow(SessionNotSettledError);
  });
});

describe("renderDetailText（team-ctl transcript CLI 对等，F12）", () => {
  it("同一合成流的文本渲染：role/时间/framed 徽标/工具行", () => {
    insertMessage(MEMBER_SESSION, "user", "real_user", [{ type: "text", text: "Team message from lead:\n推进" }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [
      { type: "tool", tool: "Read", status: "completed" },
      { type: "text", text: "已完成" },
    ]);
    const result = buildDetail(
      deps(
        stateWith(
          [{ id: "msg-1", senderId: TEAM, senderName: "lead", targetId: MEMBER_ID, content: [{ type: "text", text: "推进" }] }],
          ["msg-1"],
        ),
      ),
      { target: MEMBER_ID },
      () => MEMBER_SESSION,
    );
    const text = renderDetailText(result, "alice");
    expect(text).toContain("member alice");
    expect(text).toContain(MEMBER_SESSION);
    expect(text).toContain("[team ← lead]");
    expect(text).toContain("推进");
    expect(text).toContain("tool Read (completed)");
    expect(text).toContain("已完成");
  });
});
