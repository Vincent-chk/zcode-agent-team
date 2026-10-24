// team-ctl 格式化单测（第四轮 C）：state 表格/空态/failure、tail 四类着色/本地时区/非法行、
// inject 样例、colors 降级。数据根 os.tmpdir()。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderState } from "../../src/cli/state.js";
import { formatTailLine, localTime, type TailInput, type TailLine } from "../../src/cli/tail.js";
import { injectEvent, invalidMemberSample } from "../../src/cli/inject.js";
import { paintFor, type Paint } from "../../src/cli/colors.js";

const plain: Paint = paintFor({ isTTY: false });
const colored: Paint = paintFor({ isTTY: true });

let root: string;

function under(base: string, name: string): string {
  const p = path.join(base, name);
  if (!path.resolve(p).startsWith(path.resolve(base) + path.sep)) throw new Error("escape");
  return p;
}

function lineOf(overrides: Partial<TailLine["event"]>): TailInput {
  return {
    kind: "line",
    line: {
      seq: 3,
      ts: "2026-10-15T12:34:56.789Z",
      writer: "boot-1:123",
      event: { type: "team/member", ...overrides },
    },
  };
}

// 纯内存 LoadedTeam 构造（避免依赖真实盘面）
function fakeLoaded(overrides: Partial<Parameters<typeof renderState>[0]["loaded"]> = {}) {
  return {
    state: {
      id: "sess_ctl",
      members: [
        { id: "m1", name: "worker", description: "d", provider: "spawn", context: "fresh", phase: "active" },
        { id: "m2", name: "broken", description: "d", provider: "spawn", context: "fork", phase: "failed", error: "boom" },
      ],
      tasks: [],
      messages: [
        { id: "team-message-1", senderId: "sess_ctl", senderName: "lead", targetId: "m1", content: [] },
        { id: "team-message-2", senderId: "m1", senderName: "worker", targetId: "sess_ctl", content: [] },
      ],
      delivered: ["team-message-1"],
      nextTaskNumber: 1,
    },
    view: {
      members: [
        { id: "sess_ctl", name: "lead", role: "lead", phase: "active" },
        { id: "m1", name: "worker", role: "teammate", phase: "active" },
        { id: "m2", name: "broken", role: "teammate", phase: "failed", error: "boom" },
      ],
      tasks: [],
    },
    seq: 7,
    fromCheckpoint: false,
    writers: ["boot-1:1"],
    replayMs: 3,
    ...overrides,
  } as Parameters<typeof renderState>[0]["loaded"];
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-cli-"));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("team-ctl state 渲染", () => {
  it("分区齐全：Roster/Tasks/Mailbox + 头部元信息 + 空任务占位", () => {
    const out = renderState({ teamId: "sess_ctl", loaded: fakeLoaded(), json: false }, plain);
    expect(out).toContain("Agent Team sess_ctl");
    expect(out).toContain("seq 7");
    expect(out).toContain("Roster (3)");
    expect(out).toContain("worker");
    expect(out).toContain("boom"); // 成员 diagnostics 进渲染
    expect(out).toContain("Tasks (0)");
    expect(out).toContain("（暂无任务）");
    expect(out).toContain("Mailbox（pending 1 / delivered 1）");
    expect(out).toContain("team-message-1");
    expect(out).toContain("[delivered]");
    expect(out).toContain("[queued]");
    expect(out).toContain("lead → worker");
    expect(out).toContain("worker → lead");
  });

  it("failure 终态醒目置顶", () => {
    const loaded = fakeLoaded();
    loaded.state.failure = 'teammate "ghost" must begin provisioning';
    const out = renderState({ teamId: "sess_ctl", loaded, json: false }, plain);
    expect(out).toContain("FAILURE（终态，后续合法事件不再改变视图）：teammate \"ghost\" must begin provisioning");
  });

  it("--json 机器可读：视图/邮箱/重放元信息齐全", () => {
    const out = renderState({ teamId: "sess_ctl", loaded: fakeLoaded(), json: true }, plain);
    const parsed = JSON.parse(out);
    expect(parsed.teamId).toBe("sess_ctl");
    expect(parsed.view.members).toHaveLength(3);
    expect(parsed.mailbox.messages).toHaveLength(2);
    expect(parsed.seq).toBe(7);
  });
});

describe("team-ctl tail 格式化", () => {
  it("四类事件着色区分（member=cyan/task=yellow/message=magenta/delivered=green）", () => {
    const member = formatTailLine(lineOf({ member: { id: "m1", name: "worker", phase: "active" } }), colored);
    expect(member).toContain("\x1b[36mteam/member\x1b[0m");
    const task = formatTailLine(lineOf({ type: "team/task", task: { id: "task-1", subject: "s", status: "pending", revision: 1 } }), colored);
    expect(task).toContain("\x1b[33mteam/task\x1b[0m");
    const msg = formatTailLine(lineOf({ type: "team/message/queued", message: { id: "team-message-9", senderName: "lead", targetId: "m1" } }), colored);
    expect(msg).toContain("\x1b[35mteam/message/queued\x1b[0m");
    const delivered = formatTailLine(lineOf({ type: "team/message/delivered", messageId: "team-message-9", targetId: "m1" }), colored);
    expect(delivered).toContain("\x1b[32mteam/message/delivered\x1b[0m");
  });

  it("纯文本模式无 ANSI 码；本地时区时间戳；seq/writer 呈现", () => {
    const out = formatTailLine(lineOf({ member: { id: "m1", name: "worker", phase: "active" } }), plain);
    expect(out).not.toContain("\x1b[");
    expect(out).toContain(localTime("2026-10-15T12:34:56.789Z"));
    expect(out).toMatch(/\s3\s/);
    expect(out).toContain("boot-1:123");
    expect(out).toContain("worker (m1) → active");
  });

  it("非法行红显（截断 160 字符）", () => {
    const out = formatTailLine({ kind: "invalid", raw: "x".repeat(300) }, plain);
    expect(out).toContain("无法解析的行：");
    expect(out.length).toBeLessThan(200);
  });

  it("localTime：本地时区 HH:MM:SS.mmm；非法时间戳降级", () => {
    expect(localTime("2026-10-15T12:34:56.789Z")).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(localTime("not-a-time")).toBe("invalid-ts");
  });
});

describe("team-ctl inject-event", () => {
  it("原始行注入：seq 递增 + 结构化单行日志字段", () => {
    const dir = under(root, "inj");
    const r1 = injectEvent(dir, JSON.stringify({ event: { type: "team/task", version: 2, teamId: "t", task: { id: "task-1", revision: 1, subject: "s", description: "d", status: "pending", blockedBy: [], writeScopes: [] } } }));
    expect(r1.seq).toBe(1);
    const r2 = injectEvent(dir, JSON.stringify({ event: { type: "team/task", version: 2, teamId: "t", task: { id: "task-2", revision: 1, subject: "s", description: "d", status: "pending", blockedBy: [], writeScopes: [] } } }));
    expect(r2.seq).toBe(2);
    const written = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n");
    expect(written).toHaveLength(2);
    expect((JSON.parse(written[0]) as { writer: string }).writer).toBe("team-ctl:inject");
  });

  it("非法 JSON 行 → 可读错误", () => {
    expect(() => injectEvent(under(root, "inj2"), "not-json")).toThrow(/必须是合法 JSON 行/);
  });

  it("invalid-member 样例：直接 active 的新成员（违反必须 provisioning 起点）", () => {
    const sample = invalidMemberSample("t");
    const parsed = JSON.parse(sample) as { event: { member: { phase: string; id: string } } };
    expect(parsed.event.member.phase).toBe("active");
    expect(parsed.event.member.id).toBe("sess-injected-ghost");
  });
});

describe("colors 降级", () => {
  it("非 TTY / NO_COLOR → 纯文本；FORCE_COLOR=1 强制启用", () => {
    expect(paintFor({ isTTY: false }).enabled).toBe(false);
    const before = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      expect(paintFor({ isTTY: true }).enabled).toBe(false);
    } finally {
      if (before === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = before;
    }
    const beforeForce = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = "1";
    try {
      const forced = paintFor({ isTTY: false });
      expect(forced.enabled).toBe(true);
      expect(forced.cyan("x")).toBe("\x1b[36mx\x1b[0m");
    } finally {
      if (beforeForce === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = beforeForce;
    }
  });
});
