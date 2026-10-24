// stage-4 分支补测：provider 边缘路径（无会话/缺映射/损坏记录/drain 标记 kill）、transcript 聚合分支、
// procgroup 直接单测、member-files 错误分支；外加 F06b Lead 投递 host 级路径（回执 → delivered）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProviderKit, withFakeEnv, openHost, waitFor, framedText } from "./kit.js";
import { createTestDb } from "./kit.js";
import { TranscriptReader } from "../../src/provider/transcript.js";
import { killProcessGroup, pidAlive, spawnDetached } from "../../src/provider/procgroup.js";
import {
  memberPaths,
  listTurns,
  readJson,
  readOrigin,
  writeOrigin,
  writeTurn,
  setCurrentTurn,
  type OriginRecord,
} from "../../src/provider/member-files.js";

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-s4-b-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeOrigin(teamId: string, memberId: string, over: Partial<OriginRecord> = {}): OriginRecord {
  return {
    teamId,
    memberId,
    name: "alpha",
    provider: "spawn",
    mode: "continuable",
    context: "fresh",
    createdAt: new Date().toISOString(),
    cwd: dir,
    firstPromptText: "p",
    firstPromptSha256: "h",
    sessionId: null,
    initialUserMessageAccepted: false,
    ...over,
  };
}

describe("provider 边缘分支（合成状态，零进程）", () => {
  it("deliver：无 origin / sessionId 未落定 → queued（宁滞留）", async () => {
    const { buildProviderKit: build } = await import("./kit.js");
    const kit = build();
    try {
      const msg = framedText("lead", "x");
      await expect(
        kit.provider.deliver({ memberId: "m-none", framedMessage: msg.framedJson, messageId: msg.messageId }),
      ).resolves.toBe("queued"); // 无供给记录
      const paths = memberPaths(kit.provider.teamDir, "m-x");
      writeOrigin(paths, makeOrigin(kit.teamId, "m-x")); // sessionId=null 且 db 无匹配
      await expect(
        kit.provider.deliver({ memberId: "m-x", framedMessage: msg.framedJson, messageId: msg.messageId }),
      ).resolves.toBe("queued");
    } finally {
      await kit.cleanup();
    }
  });

  it("containsMessage：turn 携带未落库 → false；landed:true → true；lead 回执集", async () => {
    const { buildProviderKit: build } = await import("./kit.js");
    const kit = build();
    try {
      const paths = memberPaths(kit.provider.teamDir, "m-y");
      writeOrigin(paths, makeOrigin(kit.teamId, "m-y", { sessionId: "sess_none" }));
      writeTurn(paths.runDir, {
        turnId: "turn-1",
        memberId: "m-y",
        kind: "deliver",
        sessionId: "sess_none",
        messageIds: ["mid-unlanded"],
        promptText: "Team message from lead:\nx",
        argv: [],
        pid: null,
        pgid: null,
        status: "exited",
        startedAt: "t",
        stdoutFile: "turn-1.out",
        landed: false,
      });
      writeTurn(paths.runDir, {
        turnId: "turn-2",
        memberId: "m-y",
        kind: "deliver",
        sessionId: "sess_none",
        messageIds: ["mid-landed"],
        promptText: "Team message from lead:\ny",
        argv: [],
        pid: null,
        pgid: null,
        status: "exited",
        startedAt: "t",
        stdoutFile: "turn-2.out",
        landed: true,
      });
      setCurrentTurn(paths, "turn-2");
      expect(kit.provider.containsMessage("m-y", "mid-unlanded")).toBe(false);
      expect(kit.provider.containsMessage("m-y", "mid-landed")).toBe(true);
      expect(kit.provider.containsMessage("m-y", "mid-unknown")).toBe(false);
      kit.provider.recordLeadReceipts(["lead-msg-1"], "stop");
      expect(kit.provider.containsMessage(kit.teamId, "lead-msg-1")).toBe(true);
      expect(kit.provider.containsMessage(kit.teamId, "lead-msg-2")).toBe(false);
      // readColdRecord：无 origin → undefined；有 origin → recorded 合成
      expect(kit.provider.readColdRecord("m-none", "x")).toBeUndefined();
      expect(kit.provider.readColdRecord("m-y", "mid-landed")).toEqual({ recorded: true });
    } finally {
      await kit.cleanup();
    }
  });

  it("readProvisioningRecord：sessionId 未回填但 db 有落库首条 → 实查回填 accepted=true", async () => {
    const { buildProviderKit: build } = await import("./kit.js");
    const kit = build();
    try {
      const db = new DatabaseSync(kit.dbPath);
      const now = Date.now();
      db.prepare("INSERT INTO session (id, directory, time_created) VALUES ('sess_probe_hit', ?, ?)").run(kit.cwd, now);
      db.prepare("INSERT INTO message VALUES ('pm1','sess_probe_hit',?,?,?,0)").run(now, now, JSON.stringify({ role: "user", semantics: { origin: "real_user" } }));
      db.prepare("INSERT INTO part VALUES ('pp1','pm1','sess_probe_hit',?,?,?,0)").run(now, now, JSON.stringify({ type: "text", text: "probe-prompt" }));
      db.close();
      const paths = memberPaths(kit.provider.teamDir, "m-z");
      writeOrigin(paths, makeOrigin(kit.teamId, "m-z", { cwd: kit.cwd, firstPromptText: "probe-prompt" }));
      const record = kit.provider.readProvisioningRecord("m-z")!;
      expect(record.initialUserMessageAccepted).toBe(true);
      expect(record.descriptor).toEqual({ provider: "spawn", mode: "continuable" });
      // 回写 origin：sessionId 已探得（下次读直接命中）
      expect(readOrigin(paths)!.sessionId).toBe("sess_probe_hit");
    } finally {
      await kit.cleanup();
    }
  });
});

describe("transcript 聚合分支", () => {
  it("exportTurns：tool 连续聚合/无前项、损坏 part 跳过、无消息模型 undefined", () => {
    const dbPath = path.join(dir, "agg.sqlite");
    createTestDb(dbPath);
    const db = new DatabaseSync(dbPath);
    const now = Date.now();
    const insMsg = (mid: string, role: string, seq: number) =>
      db.prepare("INSERT INTO message VALUES (?,?,?,?,?,?)").run(
        mid,
        "s",
        now + seq,
        now + seq,
        JSON.stringify({ role, semantics: { origin: role === "user" ? "real_user" : "model" } }),
        seq,
      );
    const insPart = (mid: string, data: unknown, seq: number) =>
      db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?,?)").run(`p-${mid}-${seq}`, mid, "s", now, now, typeof data === "string" ? data : JSON.stringify(data), seq);
    db.prepare("INSERT INTO session (id, directory, time_created) VALUES ('s', ?, 1)").run(dir);
    insMsg("a1", "assistant", 0);
    insPart("a1", { type: "tool", tool: "Bash" }, 0); // 无前项 → 自立一条
    insPart("a1", { type: "text", text: "done" }, 1);
    insPart("a1", "{broken json", 2); // 损坏 part → JSON.parse 失败静默跳过
    insMsg("u1", "user", 1);
    insPart("u1", { type: "text", text: "q" }, 0);
    db.close();
    const reader = new TranscriptReader({ dbPath });
    const turns = reader.exportTurns("s");
    expect(turns).toEqual([
      { role: "assistant", text: "", toolNames: ["Bash"] },
      { role: "assistant", text: "done", toolNames: [] },
      { role: "user", text: "q", toolNames: [] },
    ]);
    expect(reader.latestModel("s")).toBeUndefined(); // 无 modelSelection
    expect(reader.realUserTexts("s")).toHaveLength(1); // real_user 消息可见
    reader.close();
  });
});

describe("procgroup 直接单测", () => {
  it("killProcessGroup(null) → true；spawnDetached 结果错误上抛（helper 缺失）", async () => {
    await expect(killProcessGroup(null, 0)).resolves.toBe(true);
    const prev = process.env.TEAM_DETACH_HELPER;
    process.env.TEAM_DETACH_HELPER = "/nonexistent/helper.mjs";
    try {
      await expect(
        spawnDetached({
          command: process.execPath,
          argv: ["-e", "0"],
          env: process.env,
          cwd: dir,
          stdoutFile: path.join(dir, "x.out"),
        }),
      ).rejects.toThrow(/detach helper failed/);
    } finally {
      if (prev === undefined) delete process.env.TEAM_DETACH_HELPER;
      else process.env.TEAM_DETACH_HELPER = prev;
    }
  });

  it("spawnDetached + 小宽限组终止（活进程快速回收）", async () => {
    const spawned = await spawnDetached({
      command: process.execPath,
      argv: ["-e", "setTimeout(() => {}, 8000)"],
      env: process.env,
      cwd: dir,
      stdoutFile: path.join(dir, "sleep.out"),
    });
    expect(spawned.pid).not.toBeNull();
    expect(pidAlive(spawned.pid)).toBe(true);
    await expect(killProcessGroup(spawned.pgid, 100)).resolves.toBe(true);
    expect(pidAlive(spawned.pid)).toBe(false);
  });
});

describe("member-files 错误分支", () => {
  it("listTurns 于文件路径（非目录）→ 抛错；readJson 损坏 JSON → 抛错", () => {
    const file = path.join(dir, "not-a-dir");
    fs.writeFileSync(file, "x");
    expect(() => listTurns(file)).toThrow();
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{nope");
    expect(() => readJson(bad)).toThrow();
    expect(readJson(path.join(dir, "missing.json"))).toBeUndefined();
  });
});

describe("F06b · Lead 投递（host 级：steerLead=false → 回执折叠 delivered）", () => {
  it("成员发往 lead → pending；hook 回执（recordLeadReceipts）→ watcher → delivered 事件", async () => {
    const restore = withFakeEnv({ FAKE_ZCODE_SLEEP_MS: "600" });
    const kit = buildProviderKit();
    try {
      const host = await openHost(kit);
      try {
        await host.dispatch("member.spawn", { session_id: kit.teamId, name: "alpha", description: "d", prompt: "p" });
        const memberId = fs.readdirSync(path.join(kit.provider.teamDir, "members"))[0];
        const sent = (await host.dispatch("message.send", {
          session_id: memberId, // 成员身份发送（callerId = 域成员 id）
          targetName: "lead",
          content: [{ type: "text", text: "lead-msg-body" }],
        })) as { messageId: string };
        let board = await host.readBoard();
        expect(board.state.delivered).toHaveLength(0); // 无直达通道 → 滞留（内部 pending）
        // 模拟 hook 注入成功后的回执（真实路径 = dist/team-hooks.mjs 落 receipts.jsonl）
        kit.provider.recordLeadReceipts([sent.messageId], "stop");
        await waitFor(async () => (await host.readBoard()).state.delivered.length === 1, 5000, 100);
        board = await host.readBoard();
        expect(board.state.delivered[0]).toBe(sent.messageId);
      } finally {
        await host.close().catch(() => undefined);
      }
    } finally {
      restore();
      await kit.cleanup();
    }
  });
});
