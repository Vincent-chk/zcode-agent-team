// stage-4 边角单测：zcode 二进制发现链、framing 渲染防御分支、transcript 读失败路径、member-files 损坏行。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveZcodeBin, DESKTOP_ZCODE_CJS } from "../../src/provider/zcode-bin.js";
import { renderFramed, renderFramedBatch, buildInboxContext } from "../../src/provider/framing.js";
import { TranscriptReader } from "../../src/provider/transcript.js";
import {
  appendReceipt,
  readReceipts,
  receiptMessageIds,
  memberPaths,
  listTurns,
  nextTurnId,
  writeTurn,
} from "../../src/provider/member-files.js";

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-s4-u-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("resolveZcodeBin（发现链）", () => {
  it("env 显式覆盖 → source env；.cjs 用 node 解释", () => {
    const bin = resolveZcodeBin({ TEAM_ZCODE_BIN: "/x/y/zcode.cjs" });
    expect(bin).toEqual({ command: process.execPath, argvPrefix: ["/x/y/zcode.cjs"], source: "env" });
  });

  it("原生二进制 → 直接执行（无解释器前缀）", () => {
    const bin = resolveZcodeBin({ TEAM_ZCODE_BIN: "/usr/local/bin/zcode" });
    expect(bin.argvPrefix).toEqual([]);
    expect(bin.command).toBe("/usr/local/bin/zcode");
  });

  it("ZCODE_RG_BINARY 推导桌面捆绑路径", () => {
    const rg = "/Applications/ZCode.app/Contents/Resources/tools/ripgrep/rg";
    if (!fs.existsSync(rg)) return; // 非 Desktop 环境跳过（CI 上兜底走常驻路径/which）
    const bin = resolveZcodeBin({ ZCODE_RG_BINARY: rg });
    expect(bin.source).toBe("rg-derive");
    expect(bin.argvPrefix[0]).toBe(DESKTOP_ZCODE_CJS);
  });

  it("RG 指向的 Resources 无 glm/zcode.cjs → 回退 Desktop 常驻路径", () => {
    if (!fs.existsSync(DESKTOP_ZCODE_CJS)) return; // 无桌面环境则跳过（which 链路依赖 PATH）
    const bin = resolveZcodeBin({ ZCODE_RG_BINARY: "/Applications/ZCode.app/Contents/X/tools/ripgrep/rg" });
    expect(bin.source).toBe("desktop-default");
    expect(bin.argvPrefix[0]).toBe(DESKTOP_ZCODE_CJS);
  });
});

describe("framing 防御分支", () => {
  it("非 JSON / 非数组 / 空数组 / 首块非文本 → 显式错误", () => {
    expect(() => renderFramed("not json")).toThrow();
    expect(() => renderFramed("42")).toThrow(/non-empty JSON array/);
    expect(() => renderFramed("[]")).toThrow(/non-empty JSON array/);
    expect(() => renderFramed(JSON.stringify([{ type: "image" }]))).toThrow(/first block/);
  });

  it("框架头格式不符 → 显式错误；非 text 块单行 JSON 序列化", () => {
    expect(() =>
      renderFramed(JSON.stringify([{ type: "text", text: "Team message 123 from x:" }])),
    ).toThrow(/header mismatch/);
    const rendered = renderFramed(
      JSON.stringify([
        { type: "text", text: "Team message from alpha:" },
        { type: "tool-call", id: "t1", name: "Bash", arguments: {} },
      ]),
    );
    expect(rendered.senderName).toBe("alpha");
    expect(rendered.text).toContain('"type":"tool-call"');
  });

  it("renderFramedBatch 保序合并 + buildInboxContext 计数", () => {
    const mk = (name: string, body: string) =>
      JSON.stringify([{ type: "text", text: `Team message from ${name}:` }, { type: "text", text: body }]);
    const batch = renderFramedBatch([
      { messageId: "m1", framedJson: mk("a", "1") },
      { messageId: "m2", framedJson: mk("b", "2") },
    ]);
    expect(batch.promptText).toBe("Team message from a:\n1\n\nTeam message from b:\n2");
    expect(batch.rendered.map((r) => r.messageId)).toEqual(["m1", "m2"]);
    expect(buildInboxContext([batch.rendered[0].text])).toContain("待收消息 1 条");
  });
});

describe("TranscriptReader 读失败路径", () => {
  it("库文件损坏（非 sqlite）→ 打开抛错（→ child Session recovery failed）", () => {
    const corrupt = path.join(dir, "corrupt.sqlite");
    fs.writeFileSync(corrupt, "this is not a database");
    const reader = new TranscriptReader({ dbPath: corrupt });
    expect(() => reader.session("s")).toThrow();
    reader.close();
  });

  it("missing → 库出现后自动重开（宿主晚建场景）", () => {
    const dbPath = path.join(dir, "late.sqlite");
    const reader = new TranscriptReader({ dbPath });
    expect(reader.session("s")).toBeUndefined();
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, task_type TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)",
    );
    db.prepare("INSERT INTO session (id, time_created) VALUES ('s1', 1)").run();
    db.close();
    expect(reader.session("s1")).toMatchObject({ id: "s1" });
    reader.close();
  });

  it("realUserTexts 返回模型字段与时间序", () => {
    const dbPath = path.join(dir, "u.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER)");
    const now = Date.now();
    const ins = (mid: string, seq: number, origin: string) => {
      db.prepare("INSERT INTO message VALUES (?,?,?,?,?,?)").run(mid, "s", now + seq, now + seq, JSON.stringify({ role: "user", semantics: { origin }, modelSelection: { modelId: "mx" } }), seq);
      db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?,?)").run(`p${mid}`, mid, "s", now + seq, now + seq, JSON.stringify({ type: "text", text: `t${seq}` }), 0);
    };
    ins("m0", 0, "agent_runtime");
    ins("m1", 1, "real_user");
    db.close();
    const reader = new TranscriptReader({ dbPath });
    const texts = reader.realUserTexts("s");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ text: "t1", origin: "real_user", modelId: "mx" });
    reader.close();
  });
});

describe("member-files 损坏行/辅助", () => {
  it("回执损坏行显式抛错（不静默）", () => {
    const paths = memberPaths(path.join(dir, "team"), "m1");
    fs.mkdirSync(path.dirname(paths.receiptsFile), { recursive: true });
    fs.writeFileSync(paths.receiptsFile, "{broken\n");
    expect(() => readReceipts(paths)).toThrow();
    expect(() => receiptMessageIds(paths)).toThrow();
  });

  it("appendReceipt 落盘 + 读取；listTurns/nextTurnId 空目录", () => {
    const paths = memberPaths(path.join(dir, "team"), "m2");
    appendReceipt(paths, { messageId: "x", channel: "stop", ts: "t" });
    expect(readReceipts(paths)).toEqual([{ messageId: "x", channel: "stop", ts: "t" }]);
    const empty = memberPaths(path.join(dir, "team"), "m3");
    expect(listTurns(empty.runDir)).toEqual([]);
    expect(nextTurnId(empty.runDir)).toBe("turn-1");
    writeTurn(empty.runDir, {
      turnId: "turn-1",
      memberId: "m3",
      kind: "first",
      sessionId: null,
      messageIds: [],
      promptText: "p",
      argv: [],
      pid: 1,
      pgid: 1,
      status: "running",
      startedAt: "t",
      stdoutFile: "x.out",
    });
    expect(nextTurnId(empty.runDir)).toBe("turn-2");
  });
});
