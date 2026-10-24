// src/cli/ui.ts 进程内单测（transcript/widget 渲染纯函数面；子进程链路见
// test/cli/ui-commands.test.ts）。覆盖率口径：cli/ui.ts 进门槛（in-process）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../provider/kit.js";
import { renderTranscript, renderWidget, safeOutPath } from "../../src/cli/ui.js";
import { load } from "../../src/coord/replay.js";
import { FIXTURE_TASK_STATES } from "../visual/fixtures.js";

const TEAM = "sess_cli_ui_unit";
const MEMBER_ID = "m_w";
const MEMBER_SESSION = "sess_w_child";

let root: string;
let teamDir: string;
let dbPath: string;
let db: DatabaseSync;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-cli-ui-"));
  dbPath = path.join(root, "db.sqlite");
  createTestDb(dbPath);
  db = new DatabaseSync(dbPath);
  // teamDir = <dataRoot>/teams/<teamId>（dataRootOf 上推两级约定）
  teamDir = path.join(root, "teams", TEAM);
  fs.mkdirSync(path.join(teamDir, "members", MEMBER_ID), { recursive: true });
  const events = [
    { type: "team/member", version: 2, teamId: TEAM, member: { id: MEMBER_ID, name: "worker", description: "d", provider: "spawn", context: "fresh", phase: "provisioning" } },
    { type: "team/member", version: 2, teamId: TEAM, member: { id: MEMBER_ID, name: "worker", description: "d", provider: "spawn", context: "fresh", phase: "active" } },
    { type: "team/task", version: 2, teamId: TEAM, task: { id: "task-1", revision: 1, subject: "单元任务", description: "d", status: "pending", blockedBy: [], writeScopes: [] } },
  ];
  fs.writeFileSync(
    path.join(teamDir, "events.jsonl"),
    events.map((event, i) => JSON.stringify({ seq: i + 1, ts: new Date().toISOString(), writer: "seed:1", event })).join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(teamDir, "members", MEMBER_ID, "origin.json"),
    JSON.stringify({
      teamId: TEAM, memberId: MEMBER_ID, name: "worker", provider: "spawn", mode: "continuable",
      context: "fresh", createdAt: new Date().toISOString(), cwd: "/ws", firstPromptText: "w",
      firstPromptSha256: "x", sessionId: MEMBER_SESSION, initialUserMessageAccepted: true,
    }),
  );
  // db 一条成员消息
  const now = Date.now();
  const msgId = `msg_${crypto.randomUUID()}`;
  db.prepare("INSERT INTO session (id, directory, task_type, time_created) VALUES (?,?,?,?)").run(MEMBER_SESSION, "/ws", "interactive", now);
  db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)").run(
    msgId, MEMBER_SESSION, now, now, JSON.stringify({ role: "user", semantics: { origin: "real_user" } }), 1,
  );
  db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?,?)").run(
    `part_${crypto.randomUUID()}`, msgId, MEMBER_SESSION, now, now, JSON.stringify({ type: "text", text: "hello unit" }), 0,
  );
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("renderTranscript（进程内）", () => {
  it("文本输出：成员名/会话 id/消息文本", async () => {
    const loaded = await load(teamDir, TEAM);
    const out = renderTranscript({ teamDir, teamId: TEAM, loaded, member: MEMBER_ID, json: false, dbPath });
    expect(out).toContain("member worker");
    expect(out).toContain(MEMBER_SESSION);
    expect(out).toContain("hello unit");
  });

  it("json 输出：detail 契约形状（sessionId/page.items/total）", async () => {
    const loaded = await load(teamDir, TEAM);
    const out = renderTranscript({ teamDir, teamId: TEAM, loaded, member: "worker", json: true, dbPath });
    const parsed = JSON.parse(out);
    expect(parsed.sessionId).toBe(MEMBER_SESSION);
    expect(parsed.memberName).toBe("worker");
    expect(parsed.total).toBe(1);
    expect(parsed.page.items[0]).toMatchObject({ seq: 1, role: "user", kind: "text", text: "hello unit" });
  });

  it("cursor/limit 透传", async () => {
    const loaded = await load(teamDir, TEAM);
    const out = renderTranscript({ teamDir, teamId: TEAM, loaded, member: MEMBER_ID, json: true, dbPath, cursor: 1, limit: 10 });
    expect(JSON.parse(out).page.items).toEqual([]);
  });

  it("非成员 → TeamError（由 main 单行化，本层原样抛）", async () => {
    const loaded = await load(teamDir, TEAM);
    expect(() => renderTranscript({ teamDir, teamId: TEAM, loaded, member: "ghost", json: false, dbPath })).toThrowError(
      'active teammate "ghost" not found',
    );
  });
});

describe("renderWidget（进程内）", () => {
  it("默认 = 片段（无 doctype；含任务/成员）", async () => {
    const loaded = await load(teamDir, TEAM);
    const { html, out } = renderWidget({ teamDir, teamId: TEAM, loaded, theme: "light", lang: "zh", standalone: false });
    expect(out).toBeUndefined();
    expect(html).not.toMatch(/<!doctype/i);
    expect(html).toContain("单元任务");
    expect(html).toContain("worker");
    expect(html).toContain('id="agent-team-widget"');
  });

  it("standalone + en/dark → 完整文档与英文词典", async () => {
    const loaded = await load(teamDir, TEAM);
    const { html } = renderWidget({ teamDir, teamId: TEAM, loaded, theme: "dark", lang: "en", standalone: true });
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain("Shared tasks");
  });

  it("--out 落盘返回绝对路径", async () => {
    const loaded = await load(teamDir, TEAM);
    const outFile = path.join(root, "card.html");
    const { out } = renderWidget({ teamDir, teamId: TEAM, loaded, theme: "light", lang: "zh", standalone: false, out: outFile });
    expect(out).toBe(path.resolve(outFile));
    expect(fs.readFileSync(outFile, "utf8")).toContain("单元任务");
  });

  it("sessionId 进帧 meta（当前会话高亮数据源）", async () => {
    const loaded = await load(teamDir, TEAM);
    const { html } = renderWidget({ teamDir, teamId: TEAM, loaded, theme: "light", lang: "zh", standalone: false, sessionId: MEMBER_SESSION });
    const m = html.match(/data-frame[^>]*>([^<]*)</);
    expect(m).not.toBeNull();
    const frame = JSON.parse((m as RegExpMatchArray)[1].replace(/&quot;/g, '"'));
    expect(frame.meta.sessionId).toBe(MEMBER_SESSION);
  });
});

describe("safeOutPath（路径穿越防护）", () => {
  it("拒绝 .. 段（posix 与 win 分隔）", () => {
    expect(() => safeOutPath("../x.html")).toThrow("拒绝路径穿越段");
    expect(() => safeOutPath("a/../../x.html")).toThrow("拒绝路径穿越段");
    expect(() => safeOutPath("..\\x.html")).toThrow("拒绝路径穿越段");
  });
  it("拒绝非白名单文件名/非 .html 后缀", () => {
    expect(() => safeOutPath("/tmp/a b.html")).toThrow("白名单字符");
    expect(() => safeOutPath("/tmp/x.txt")).toThrow("白名单字符");
    expect(() => safeOutPath("/tmp/x!.html")).toThrow("白名单字符");
  });
  it("合法路径 → resolve 绝对路径", () => {
    expect(safeOutPath("out/team-card.html")).toBe(path.resolve("out/team-card.html"));
    expect(safeOutPath("/tmp/team_card-1.html")).toBe("/tmp/team_card-1.html");
  });
});

describe("buildStaticFrame 经 renderWidget（保守派生面）", () => {
  it("active 成员呈 inactive（静态载体无活性信息，D16a 同口径）", async () => {
    const loaded = await load(teamDir, TEAM);
    const { html } = renderWidget({ teamDir, teamId: TEAM, loaded, theme: "light", lang: "zh", standalone: false });
    expect(html).toContain("未运行");
    expect(html).not.toContain("运行中");
  });
  it("夹具帧直接渲染（widget.ts 同源渲染器面）", async () => {
    // FIXTURE_TASK_STATES 走同一 renderWidgetFragment（视觉回归同源前提）
    const { renderWidgetFragment } = await import("../../src/ui-core/widget.js");
    const html = renderWidgetFragment({ frame: FIXTURE_TASK_STATES, lang: "en" });
    expect(html).toContain("In progress");
  });
});
