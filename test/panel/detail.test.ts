// T5.7 detail 合成器单测（F13 纯逻辑面；〔视图修订 2026-10-25·二次〕固定按轮摘要）：
//  - 消息流合成：时间序、role 区分、text/toolGroup/结论三型、hook_context 用户消息不进流；
//  - 按轮投影：轮切分、三条目顺序、结论取最后非空、虚拟轮 0、动作组聚合与载荷截断；
//  - framed 徽标回填（源 state.messages/delivered；不改写原文；每条只标一次）；
//  - 分页游标（默认 100/上限 200/首屏=末页/nextCursor；基于投影流）+ sourceTotal；
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
  projectSummary,
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

describe("synthesize：流合成（F13；固定按轮摘要）", () => {
  it("时间序 + role 区分；hook_context/系统消息不进流；工具并入动作组", () => {
    insertMessage(MEMBER_SESSION, "user", "hook_context", [{ type: "text", text: "[agent-team inbox] 注入" }]);
    insertMessage(MEMBER_SESSION, "user", "real_user", [{ type: "text", text: "请实现功能 A" }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [
      { type: "text", text: "开始处理" },
      { type: "tool", tool: "Bash", status: "completed", input: { command: "ls" }, output: "a\nb" },
    ]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "reasoning", text: "思考中" } as never]);
    const result = buildDetail(deps(stateWith([], [])), { target: MEMBER_ID }, () => MEMBER_SESSION);
    const kinds = result.page.items.map((i) => `${i.role}:${i.kind}`);
    expect(kinds).toEqual(["user:text", "assistant:toolGroup", "assistant:text"]);
    expect(result.page.items[0].text).toBe("请实现功能 A");
    expect(result.page.items[1].tools?.[0]).toMatchObject({ name: "Bash", status: "completed" });
    expect(result.page.items[1].tools?.[0].text).toContain("input: ");
    expect(result.page.items[1].tools?.[0].text).toContain("output: a\nb");
    expect(result.page.items[2].text).toBe("开始处理");
    expect(result.sourceTotal).toBe(3);
    // seq 连续（基于投影流）
    expect(result.page.items.map((i) => i.seq)).toEqual([1, 2, 3]);
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

describe("按轮摘要投影（〔视图修订 2026-10-25·二次〕固定形态）", () => {
  it("轮切分与每轮三条目顺序：user → toolGroup → 结论", () => {
    insertMessage(MEMBER_SESSION, "user", "real_user", [{ type: "text", text: "第一轮指令" }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [
      { type: "tool", tool: "Bash", status: "completed", input: { command: "ls" }, output: "a" },
    ]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "text", text: "结论一" }]);
    insertMessage(MEMBER_SESSION, "user", "real_user", [{ type: "text", text: "第二轮指令" }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "text", text: "中间稿" }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "text", text: "结论二" }]);
    insertMessage(MEMBER_SESSION, "user", "real_user", [{ type: "text", text: "第三轮指令" }]);

    const result = buildDetail(deps(stateWith([], [])), { target: MEMBER_ID }, () => MEMBER_SESSION);

    expect(result.sourceTotal).toBe(7);
    expect(result.total).toBe(6);
    expect(result.page.items.map((i) => `${i.role}:${i.kind}`)).toEqual([
      "user:text",
      "assistant:toolGroup",
      "assistant:text",
      "user:text",
      "assistant:text",
      "user:text",
    ]);
    expect(result.page.items.map((i) => i.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.page.items[0].text).toBe("第一轮指令");
    expect(result.page.items[1].count).toBe(1);
    expect(result.page.items[1].tools?.[0].name).toBe("Bash");
    expect(result.page.items[2].text).toBe("结论一");
    expect(result.page.items[3].text).toBe("第二轮指令");
    expect(result.page.items[4].text).toBe("结论二"); // 中间稿被丢弃
    expect(result.page.items[5].text).toBe("第三轮指令");
  });

  it("toolGroup：聚合计数 + 逐条载荷沿用 toolCall（2000 字符截断）+ 组 ts 取末条", () => {
    insertMessage(MEMBER_SESSION, "user", "real_user", [{ type: "text", text: "开始" }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [
      { type: "tool", tool: "Read", status: "completed", input: { path: "a.md" }, output: "ok" },
    ]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [
      { type: "tool", tool: "Bash", status: "running", input: { command: "ls" }, output: "x".repeat(2500) },
    ]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "text", text: "完成" }]);

    const result = buildDetail(deps(stateWith([], [])), { target: MEMBER_ID }, () => MEMBER_SESSION);
    const group = result.page.items[1];
    expect(group.kind).toBe("toolGroup");
    expect(group.role).toBe("assistant");
    expect(group.count).toBe(2);
    expect(group.tools).toHaveLength(2);
    expect(group.tools?.[0]).toMatchObject({ name: "Read", status: "completed" });
    expect(group.tools?.[0].text).toContain('input: {"path":"a.md"}');
    expect(group.tools?.[1]).toMatchObject({ name: "Bash", status: "running" });
    expect(group.tools?.[1].text?.endsWith("\n…(truncated)")).toBe(true);
    expect(group.tools?.[1].text?.length).toBe(2000 + "\n…(truncated)".length);
    expect(group.ts).toBe(group.tools?.[1].ts); // 组 ts = 该组最后一个工具的 ts
  });

  it("framed 徽标保留在摘要 user 条目（原文不改写）", () => {
    const messages = [
      { id: "msg-1", senderId: TEAM, senderName: "lead", targetId: MEMBER_ID, content: [{ type: "text" as const, text: "推进" }] },
    ];
    insertMessage(MEMBER_SESSION, "user", "real_user", [{ type: "text", text: "Team message from lead:\n推进" }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "tool", tool: "Read", status: "completed" }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "text", text: "收到" }]);

    const result = buildDetail(deps(stateWith(messages, ["msg-1"])), { target: MEMBER_ID }, () => MEMBER_SESSION);
    const first = result.page.items[0];
    expect(first.kind).toBe("text");
    expect(first.framed).toEqual({ messageId: "msg-1", from: "lead" });
    expect(first.text).toBe("Team message from lead:\n推进");
  });

  it("结论选取：最后非空 / 空白不算 / 运行中取最近 / 无非空则省略", () => {
    insertMessage(MEMBER_SESSION, "user", "real_user", [{ type: "text", text: "轮一" }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "text", text: "  \n\t " }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "text", text: "有效结论" }]);
    insertMessage(MEMBER_SESSION, "user", "real_user", [{ type: "text", text: "轮二" }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "tool", tool: "Bash", status: "completed" }]);
    insertMessage(MEMBER_SESSION, "user", "real_user", [{ type: "text", text: "轮三" }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "tool", tool: "Read", status: "completed" }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "text", text: "运行中最近结论" }]);

    const result = buildDetail(deps(stateWith([], [])), { target: MEMBER_ID }, () => MEMBER_SESSION);
    expect(result.page.items.map((i) => `${i.role}:${i.kind}:${i.text ?? ""}`)).toEqual([
      "user:text:轮一",
      "assistant:text:有效结论",
      "user:text:轮二",
      "assistant:toolGroup:",
      "user:text:轮三",
      "assistant:toolGroup:",
      "assistant:text:运行中最近结论",
    ]);
  });

  it("虚拟轮 0：首个 user 前孤儿条目 → toolGroup + 最后非空 assistant text", () => {
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "tool", tool: "Bash", status: "completed" }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "text", text: "旧草稿" }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "text", text: "预热结论" }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "tool", tool: "Read", status: "completed" }]);
    insertMessage(MEMBER_SESSION, "user", "real_user", [{ type: "text", text: "正式指令" }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "text", text: "正式结论" }]);

    const result = buildDetail(deps(stateWith([], [])), { target: MEMBER_ID }, () => MEMBER_SESSION);
    expect(result.page.items.map((i) => `${i.role}:${i.kind}`)).toEqual([
      "assistant:toolGroup",
      "assistant:text",
      "user:text",
      "assistant:text",
    ]);
    expect(result.page.items[0].count).toBe(2);
    expect(result.page.items[0].tools?.map((t) => t.name)).toEqual(["Bash", "Read"]);
    expect(result.page.items[1].text).toBe("预热结论"); // 旧草稿被丢弃
  });

  it("分页基于投影流：total/seq/nextCursor 与 sourceTotal（原始条数）", () => {
    insertMessage(MEMBER_SESSION, "user", "real_user", [{ type: "text", text: "u1" }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "tool", tool: "Bash", status: "completed" }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "text", text: "a1a" }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "text", text: "a1b" }]);
    insertMessage(MEMBER_SESSION, "user", "real_user", [{ type: "text", text: "u2" }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "text", text: "a2" }]);

    const summary = buildDetail(deps(stateWith([], [])), { target: MEMBER_ID, limit: 4 }, () => MEMBER_SESSION);

    expect(summary.sourceTotal).toBe(6); // 投影前原始条目
    expect(summary.total).toBe(5); // 投影后条目
    expect(summary.page.items.map((i) => i.seq)).toEqual([2, 3, 4, 5]);
    expect(summary.page.nextCursor).toBe(2);
  });
});

describe("投影后分页预算（作用于投影流）", () => {
  it("投影后 256KiB 裁剪仍生效（total 基于投影后条目）", () => {
    const raw = Array.from({ length: 60 }, (_, i) => ({
      ts: new Date(1760000000000 + i).toISOString(),
      role: "user" as const,
      kind: "text" as const,
      text: "x".repeat(8000), // 60×8KiB ≈ 480KiB > 256KiB
    }));
    const projected = projectSummary(raw);
    expect(projected).toHaveLength(60); // user 条目原样保留（每轮一条）
    const { page, total, truncated } = pageDetail(projected, { limit: 200 });
    expect(total).toBe(60);
    expect(truncated).toBe(true);
    expect(page.items.length).toBeLessThan(60);
    expect(page.items[page.items.length - 1].text).toBe("x".repeat(8000)); // 保留最近
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
  it("同一合成流的文本渲染：固定摘要 header/时间/framed 徽标/动作组行", () => {
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
    expect(text).toContain("assistant · 1 个动作（Read×1）");
    expect(text).toContain("已完成");
    expect(text).toContain("· 3 items (summary of 3)"); // header 恒为摘要口径
  });

  it("动作组行按名称聚合降序（Bash×2 · Read×1）", () => {
    insertMessage(MEMBER_SESSION, "user", "real_user", [{ type: "text", text: "请实现" }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "tool", tool: "Bash", status: "completed" }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "tool", tool: "Bash", status: "completed" }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "tool", tool: "Read", status: "completed" }]);
    insertMessage(MEMBER_SESSION, "assistant", "model", [{ type: "text", text: "完成" }]);

    const result = buildDetail(deps(stateWith([], [])), { target: MEMBER_ID }, () => MEMBER_SESSION);
    const text = renderDetailText(result, "alice");
    expect(text).toContain("· 3 items (summary of 5)"); // 投影后 3 / 原始 5
    expect(text).toMatch(/\[\d{2}:\d{2}:\d{2}\] assistant · 3 个动作（Bash×2 · Read×1）/);
    expect(text).not.toContain("tool Bash (completed)"); // 摘要不逐条渲染动作
  });
});
