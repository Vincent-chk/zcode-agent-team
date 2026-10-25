// team-ctl transcript / widget 脚本集成测试（stage-5 T5.3/T5.7 CLI 对等；F12）。
// 验证 dist 打包链路（薄启动器 → dist/team-ctl.mjs）真实输出：
//  - transcript：lead/成员会话流合成（db 只读导出 + framed 徽标回填 + 分页游标 + --json）；
//  - widget：::visualize 片段 / standalone 静态页 / --out 落盘（含路径穿越防护）；
//  - state：既有基线不回归（新命令并入后 usage 正确）。
// 数据面 = 直写 events.jsonl（合法基线）+ origin.json + 独立夹具 db（TEAM_DB_PATH 注入）。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createTestDb } from "../provider/kit.js";

const PROJ = path.resolve(import.meta.dirname, "../..");
const CTL = path.join(PROJ, "scripts", "team-ctl.mjs");
const TEAM = "sess_cli_ui_demo";
const MEMBER_ID = "m_worker";
const MEMBER_SESSION = "sess_worker_child";

let root: string;
let dbPath: string;
let db: DatabaseSync;
let teamDir: string;

function under(base: string, name: string): string {
  const p = path.join(base, name);
  if (!path.resolve(p).startsWith(path.resolve(base) + path.sep)) throw new Error("escape");
  return p;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [CTL, ...args],
      { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NO_COLOR: "", TEAM_DB_PATH: dbPath, ...extraEnv } },
      (err, stdout, stderr) => {
        void err;
        resolve({ code: child.exitCode ?? (err ? 1 : 0), stdout, stderr });
      },
    );
  });
}

let msgSeq = 0;
function insertMessage(sessionId: string, role: "user" | "assistant", origin: string, text: string, toolName?: string): void {
  const now = 1760000000000 + msgSeq * 1000;
  msgSeq += 1;
  const msgId = `msg_${crypto.randomUUID()}`;
  db.prepare("INSERT INTO session (id, directory, task_type, time_created) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING").run(sessionId, "/ws", "interactive", now);
  db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)").run(
    msgId, sessionId, now, now,
    JSON.stringify({ role, semantics: { origin, kind: role === "user" ? "user_prompt" : "model" } }),
    msgSeq,
  );
  const partData = toolName !== undefined
    ? JSON.stringify({ type: "tool", tool: toolName, state: { status: "completed", input: { q: 1 }, output: "ok" } })
    : JSON.stringify({ type: "text", text });
  db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?,?)").run(
    `part_${crypto.randomUUID()}`, msgId, sessionId, now, now, partData, 0,
  );
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-ctl-ui-"));
  dbPath = under(root, "db.sqlite");
  createTestDb(dbPath);
  db = new DatabaseSync(dbPath);

  // dist/team-ctl.mjs（薄启动器依赖）
  await new Promise<void>((resolve, reject) => {
    execFile(process.execPath, [path.join(PROJ, "scripts", "build.mjs")], { maxBuffer: 32 * 1024 * 1024 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  // 合法团队基线：lead 隐式（无 member 事件）+ 一个 active teammate（provisioning→active）
  teamDir = under(under(root, "teams"), TEAM);
  fs.mkdirSync(under(teamDir, `members/${MEMBER_ID}`), { recursive: true });
  const memberEvents = [
    { type: "team/member", version: 2, teamId: TEAM, member: { id: MEMBER_ID, name: "worker", description: "d", provider: "spawn", context: "fresh", phase: "provisioning" } },
    { type: "team/member", version: 2, teamId: TEAM, member: { id: MEMBER_ID, name: "worker", description: "d", provider: "spawn", context: "fresh", phase: "active" } },
    { type: "team/task", version: 2, teamId: TEAM, task: { id: "task-1", revision: 1, subject: "cli 任务", description: "widget/transcript 验证", status: "in_progress", ownerId: MEMBER_ID, blockedBy: [], writeScopes: [] } },
    // 团队消息（lead→worker）已投递 → transcript framed 徽标回填源
    { type: "team/message/queued", version: 2, teamId: TEAM, message: { id: "msg-t1", senderId: TEAM, senderName: "lead", targetId: MEMBER_ID, content: [{ type: "text", text: "推进 cli 任务" }] } },
    { type: "team/message/delivered", version: 2, teamId: TEAM, messageId: "msg-t1", targetId: MEMBER_ID },
  ];
  fs.writeFileSync(
    path.join(teamDir, "events.jsonl"),
    memberEvents.map((event, i) => JSON.stringify({ seq: i + 1, ts: new Date().toISOString(), writer: "seed:1", event })).join("\n") + "\n",
  );
  // origin.json（成员会话 id 解析源）
  fs.writeFileSync(
    path.join(teamDir, "members", MEMBER_ID, "origin.json"),
    JSON.stringify({
      teamId: TEAM, memberId: MEMBER_ID, name: "worker", provider: "spawn", mode: "continuable",
      context: "fresh", createdAt: new Date().toISOString(), cwd: "/ws", firstPromptText: "work",
      firstPromptSha256: "x", sessionId: MEMBER_SESSION, initialUserMessageAccepted: true,
    }),
  );

  // db 转录：lead 会话 + 成员会话（含 hook 注入合并的 team 消息框架头文本）
  insertMessage(TEAM, "user", "real_user", "启动团队");
  insertMessage(TEAM, "assistant", "model", "好的");
  insertMessage(MEMBER_SESSION, "user", "real_user", "Team message from lead:\n推进 cli 任务");
  insertMessage(MEMBER_SESSION, "assistant", "model", "", "Bash");
  insertMessage(MEMBER_SESSION, "assistant", "model", "已完成");
}, 60_000);

afterAll(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("team-ctl transcript（T5.7 CLI 对等）", () => {
  it("成员会话流（full）：role 区分 + 工具折叠行 + framed 徽标回填", async () => {
    const r = await run(["transcript", teamDir, "worker", "--mode", "full"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("member worker");
    expect(r.stdout).toContain(MEMBER_SESSION);
    expect(r.stdout).toContain("[team ← lead]"); // framed 徽标（源 events/delivered，不改写原文）
    expect(r.stdout).toContain("Team message from lead:");
    expect(r.stdout).toContain("tool Bash (completed)");
    expect(r.stdout).toContain("已完成");
  });

  it("lead 会话流（target=lead → teamId 会话）", async () => {
    const r = await run(["transcript", teamDir, "lead"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("启动团队");
    expect(r.stdout).toContain(TEAM);
  });

  it("--json 机器可读（detail 契约形状；full 全量）", async () => {
    const r = await run(["transcript", teamDir, "worker", "--json", "--mode", "full"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.sessionId).toBe(MEMBER_SESSION);
    expect(parsed.memberName).toBe("worker");
    expect(Array.isArray(parsed.page.items)).toBe(true);
    const framedItem = parsed.page.items.find((i: { framed?: unknown }) => i.framed !== undefined);
    expect(framedItem.framed).toEqual({ messageId: "msg-t1", from: "lead" });
    const toolItem = parsed.page.items.find((i: { kind: string }) => i.kind === "toolCall");
    expect(toolItem.tool).toEqual({ name: "Bash", status: "completed" });
  });

  it("--mode summary（缺省）：按轮摘要 + 动作组聚合行 + framed 徽标保留", async () => {
    const r = await run(["transcript", teamDir, "worker"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("3 items (summary of 3)");
    expect(r.stdout).toContain("assistant · 1 个动作（Bash×1）");
    expect(r.stdout).toContain("[team ← lead]");
    expect(r.stdout).not.toContain("tool Bash (completed)"); // 摘要不逐条渲染动作
  });

  it("--mode full：全量转录（逐工具行，无 summary 后缀）", async () => {
    const r = await run(["transcript", teamDir, "worker", "--mode", "full"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("tool Bash (completed)");
    expect(r.stdout).not.toContain("(summary of");
  });

  it("非法 --mode → 中文错误 + 返回码 2（风格照 --theme）", async () => {
    const r = await run(["transcript", teamDir, "worker", "--mode", "nope"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--mode 仅支持 summary|full");
  });

  it("分页：--limit 1 → 首屏取末页（最近 1 条）+ nextCursor", async () => {
    const r = await run(["transcript", teamDir, "worker", "--json", "--limit", "1"]);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.page.items).toHaveLength(1);
    expect(parsed.page.items[0].text).toContain("已完成"); // 末页 = 最近
    expect(parsed.page.nextCursor).toBeTypeOf("number");
  });

  it("非成员 target → 可读错误（TEAM_MEMBER_NOT_FOUND 单行）", async () => {
    const r = await run(["transcript", teamDir, "ghost"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('active teammate "ghost" not found');
    expect(r.stderr.trimEnd().split("\n")).toHaveLength(1);
  });

  it("未知成员（origin 未落定）→ 可读错误", async () => {
    // 造一个 events 里 active 但 origin.json 缺失的成员
    const teamDir2 = under(under(root, "teams2"), TEAM);
    fs.mkdirSync(teamDir2, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir2, "events.jsonl"),
      [
        { type: "team/member", version: 2, teamId: TEAM, member: { id: "m_x", name: "nox", description: "d", provider: "spawn", context: "fresh", phase: "provisioning" } },
        { type: "team/member", version: 2, teamId: TEAM, member: { id: "m_x", name: "nox", description: "d", provider: "spawn", context: "fresh", phase: "active" } },
      ]
        .map((event, i) => JSON.stringify({ seq: i + 1, ts: new Date().toISOString(), writer: "seed:1", event }))
        .join("\n") + "\n",
    );
    const r = await run(["transcript", teamDir2, "nox"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('active teammate "nox" not found');
  });
});

describe("team-ctl widget（T5.3 CLI 降级链）", () => {
  it("默认 = ::visualize 片段（无 doctype、单根、含同源组件）", async () => {
    const r = await run(["widget", teamDir]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/<!doctype/i);
    expect(r.stdout).toContain('id="agent-team-widget"');
    expect(r.stdout).toContain("cli 任务"); // 任务进卡片
    expect(r.stdout).toContain("worker");
    expect(r.stdout).toContain("共享任务");
  });

  it("--standalone = 完整 HTML 文档", async () => {
    const r = await run(["widget", teamDir, "--standalone", "--lang", "en", "--theme", "dark"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^<!doctype html>/i);
    expect(r.stdout).toContain('<html lang="en" data-theme="dark">');
    expect(r.stdout).toContain("Shared tasks");
  });

  it("--out 落盘（返回绝对路径；文件内容 = 片段）", async () => {
    const out = under(root, "team-card.html");
    const r = await run(["widget", teamDir, "--out", out]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(path.resolve(out));
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(out, "utf8")).toContain('id="agent-team-widget"');
  });

  it("--out 路径穿越被拒（../ 段）", async () => {
    const r = await run(["widget", teamDir, "--out", "../escape.html"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("拒绝路径穿越段");
  });

  it("--out 非白名单文件名被拒", async () => {
    const r = await run(["widget", teamDir, "--out", under(root, "bad name.html")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("白名单字符");
  });

  it("非法 --theme/--lang → usage 错误", async () => {
    const bad = await run(["widget", teamDir, "--theme", "neon"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("--theme 仅支持");
  });
});

describe("usage 回归（新命令并入）", () => {
  it("help 列出 transcript / widget", async () => {
    const r = await run(["help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("transcript");
    expect(r.stdout).toContain("widget");
    expect(r.stdout).toContain("state");
    expect(r.stdout).toContain("--mode summary|full");
  });
});

describe("dist 直接执行（/team 文档路径）", () => {
  it("node dist/team-ctl.mjs state <teamDir> 自执行且有输出（薄启动器之外的第二入口）", async () => {
    const r = await new Promise<RunResult>((resolve) => {
      const child = execFile(
        process.execPath,
        [path.join(PROJ, "dist", "team-ctl.mjs"), "state", teamDir],
        { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, TEAM_DB_PATH: dbPath } },
        (err, stdout, stderr) => {
          resolve({ code: child.exitCode ?? (err ? 1 : 0), stdout, stderr });
        },
      );
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Agent Team");
    expect(r.stdout).toContain("Roster");
  });
});
