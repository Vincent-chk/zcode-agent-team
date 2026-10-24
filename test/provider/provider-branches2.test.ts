// stage-4 分支补测 II：deliver 超时/退避/空批、探针超时/中止、interrupt 无 current、drain 标记 kill、
// session 认领守卫、watcher 空转、zcode-bin 空值链、transcript 负路径、procgroup 结果错误分支。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProviderKit, withFakeEnv, framedText, waitFor, createTestDb } from "./kit.js";
import { ResumePerTurnProvider } from "../../src/provider/resume-provider.js";
import { TranscriptReader } from "../../src/provider/transcript.js";
import { resolveZcodeBin } from "../../src/provider/zcode-bin.js";
import { spawnDetached, pidAlive } from "../../src/provider/procgroup.js";
import {
  memberPaths,
  readOrigin,
  readTurn,
  writeOrigin,
  writeTurn,
  setCurrentTurn,
  writeJsonAtomic,
  type OriginRecord,
  type TurnRecord,
} from "../../src/provider/member-files.js";
import { upsertSessionEntry } from "../../src/mcp/identity.js";

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-s4-b2-"));
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
    createdAt: new Date(Date.now() - 5_000).toISOString(),
    cwd: dir,
    firstPromptText: "p",
    firstPromptSha256: "h",
    sessionId: null,
    initialUserMessageAccepted: false,
    ...over,
  };
}

function makeTurn(memberId: string, over: Partial<TurnRecord> = {}): TurnRecord {
  return {
    turnId: "turn-1",
    memberId,
    kind: "deliver",
    sessionId: "sess_none",
    messageIds: [],
    promptText: "x",
    argv: [],
    pid: null,
    pgid: null,
    status: "exited",
    startedAt: new Date().toISOString(),
    stdoutFile: "turn-1.out",
    ...over,
  };
}

describe("provider 分支 II（合成 + 快速真进程）", () => {
  it("first 探针：signal 中止 → 抛出（C2③ 口径）", async () => {
    const restore = withFakeEnv({ FAKE_ZCODE_PRE_SLEEP_MS: "4000" });
    const kit = buildProviderKit();
    try {
      const controller = new AbortController();
      const probe = kit.provider.startContinuable({
        teamId: kit.teamId,
        memberId: "m-ab",
        name: "alpha",
        description: "d",
        firstPrompt: "p",
        context: "fresh",
        signal: controller.signal,
      });
      await sleep(300);
      controller.abort(new Error("boom-abort"));
      await expect(probe).rejects.toThrow(/boom-abort/);
    } finally {
      restore();
      await kit.cleanup();
    }
  });

  it("first 探针超时：宽限内杀进程 + accepted:false", async () => {
    const restore = withFakeEnv({ FAKE_ZCODE_PRE_SLEEP_MS: "30000" });
    const kit = buildProviderKit();
    try {
      // 收紧探针超时（构造独立 provider）
      const slow = new ResumePerTurnProvider({
        dataRoot: kit.dataRoot,
        teamId: kit.teamId,
        cwd: kit.cwd,
        dbPath: kit.dbPath,
        zcode: { command: process.execPath, argvPrefix: [path.resolve(import.meta.dirname, "fake-zcode.mjs")], source: "env" },
        sessionIsolation: "legacy",
        firstTurnTimeoutMs: 600,
        watcherIntervalMs: 100,
        log: () => undefined,
      });
      const result = await slow.startContinuable({
        teamId: kit.teamId,
        memberId: "m-to",
        name: "alpha",
        description: "d",
        firstPrompt: "p",
        context: "fresh",
      });
      expect(result.accepted).toBe(false);
      const paths = memberPaths(slow.teamDir, "m-to");
      const turnId = "turn-1";
      await waitFor(() => readOrigin(paths)?.sessionId === null && !pidAlive(readTurn(paths.runDir, turnId)!.pid), 4000);
      slow.close();
    } finally {
      restore();
      await kit.cleanup();
    }
  });

  it("deliver：拉起退避窗口 → queued；运行中 current=starting → queued", async () => {
    const kit = buildProviderKit();
    try {
      const paths = memberPaths(kit.provider.teamDir, "m-bk");
      writeOrigin(paths, makeOrigin(kit.teamId, "m-bk", { sessionId: "sess_none" }));
      writeTurn(paths.runDir, makeTurn("m-bk", { status: "starting", pid: process.pid, pgid: process.pid })); // 存活进程（本测试进程）
      setCurrentTurn(paths, "turn-1");
      const msg = framedText("lead", "backoff");
      // 上一轮失败时间戳在窗口内（私有状态经日志行为验证：改用——构造前次失败：直接调 deliver 且 db 无此会话 → 拉起失败）
      // 这里先验证 starting 状态视作运行中：
      await expect(
        kit.provider.deliver({ memberId: "m-bk", framedMessage: msg.framedJson, messageId: msg.messageId }),
      ).resolves.toBe("queued");
      // 清掉 current，制造一次失败拉起（fake 立即退出且不落库 → queued + 退避标记）
      writeTurn(paths.runDir, makeTurn("m-bk", { status: "exited", pid: null }));
      const restore = withFakeEnv({ FAKE_ZCODE_NO_PERSIST: "1" });
      try {
        await expect(
          kit.provider.deliver({ memberId: "m-bk", framedMessage: msg.framedJson, messageId: msg.messageId }),
        ).resolves.toBe("queued");
        // 退避窗口内再次投递 → 不再拉起（仍 queued；run/ 无新增 turn-3 之前的记录数断言）
        const before = fs.readdirSync(paths.runDir).filter((n) => n.endsWith(".json")).length;
        await expect(
          kit.provider.deliver({ memberId: "m-bk", framedMessage: msg.framedJson, messageId: msg.messageId }),
        ).resolves.toBe("queued");
        const after = fs.readdirSync(paths.runDir).filter((n) => n.endsWith(".json")).length;
        expect(after).toBe(before); // 退避生效：未再拉起
      } finally {
        restore();
      }
    } finally {
      await kit.cleanup();
    }
  });

  it("interrupt：current 指向已退出轮次 → previousStatus=inactive（currentRunningTurn 排除 exited）", async () => {
    const kit = buildProviderKit();
    try {
      const paths = memberPaths(kit.provider.teamDir, "m-iv");
      writeOrigin(paths, makeOrigin(kit.teamId, "m-iv", { sessionId: "sess_none" }));
      writeTurn(paths.runDir, makeTurn("m-iv", { status: "exited", pid: null }));
      setCurrentTurn(paths, "turn-1");
      await expect(kit.provider.interrupt({ memberId: "m-iv" })).resolves.toEqual({ previousStatus: "inactive" });
    } finally {
      await kit.cleanup();
    }
  });

  it("adoptOrphans：drain 标记（kill）+ 存活 pid → 纳管时补杀（触发点②兜底）", async () => {
    const kit = buildProviderKit();
    try {
      // 用 procgroup 直接起一个长睡眠独立进程组，冒充被标记 kill 的轮次
      const spawned = await spawnDetached({
        command: process.execPath,
        argv: ["-e", "setTimeout(() => {}, 30000)"],
        env: process.env,
        cwd: dir,
        stdoutFile: path.join(dir, "orphan.out"),
      });
      const paths = memberPaths(kit.provider.teamDir, "m-dm");
      writeOrigin(paths, makeOrigin(kit.teamId, "m-dm", { sessionId: "sess_none" }));
      writeTurn(paths.runDir, makeTurn("m-dm", { status: "running", pid: spawned.pid, pgid: spawned.pgid }));
      setCurrentTurn(paths, "turn-1");
      writeJsonAtomic(paths.drainMarkerFile, { policy: "kill", turnId: "turn-1" });
      expect(pidAlive(spawned.pid)).toBe(true);
      kit.provider.adoptOrphans();
      await waitFor(() => !pidAlive(spawned.pid), 5000);
      expect(fs.existsSync(paths.drainMarkerFile)).toBe(false); // 标记已清
    } finally {
      await kit.cleanup();
    }
  });

  it("session 认领守卫：已有他属 teammate 映射不覆盖；claimedSessions 排除他属", async () => {
    const kit = buildProviderKit();
    try {
      upsertSessionEntry(kit.dataRoot, "sess_other_member", {
        teamId: kit.teamId,
        role: "teammate",
        name: "beta",
        memberId: "m-other",
      });
      const paths = memberPaths(kit.provider.teamDir, "m-me");
      writeOrigin(paths, makeOrigin(kit.teamId, "m-me", { firstPromptText: "unique-mine" }));
      // writeTeammateMapping 经 readProvisioningRecord 探针回填（他属会话已认领 → db 兜底路径排除它）
      const record = kit.provider.readProvisioningRecord("m-me")!;
      expect(record.initialUserMessageAccepted).toBe(false); // db 无匹配（无落库）→ 不满足
      expect(readOrigin(paths)!.sessionId).toBeNull();
    } finally {
      await kit.cleanup();
    }
  });

  it("watcher：无成员目录/无 current 空转不炸；foldLeadReceipts 无文件/空回执静默", async () => {
    const kit = buildProviderKit();
    try {
      kit.provider.bind({ onBoundary: () => undefined, pendingLookup: () => [] });
      kit.provider.adoptOrphans(); // 空团队
      await sleep(250); // 若干 watcher tick
      expect(true).toBe(true);
    } finally {
      await kit.cleanup();
    }
  });
});

describe("zcode-bin 空值链", () => {
  it("空白 rg/bin → 跳过推导走常驻路径/which（桌面在场即 desktop-default）", () => {
    const bin = resolveZcodeBin({ TEAM_ZCODE_BIN: "  ", ZCODE_RG_BINARY: "   " });
    expect(["desktop-default", "which"]).toContain(bin.source);
  });
});

describe("transcript 负路径", () => {
  it("各探针在空库/无行会话上的缺省值", () => {
    const dbPath = path.join(dir, "n.sqlite");
    createTestDb(dbPath);
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO session (id, directory, time_created) VALUES ('s-empty', ?, 1)").run(dir);
    db.close();
    const reader = new TranscriptReader({ dbPath });
    expect(reader.firstRealUserText("s-empty")).toBeNull();
    expect(reader.hasUserText("s-empty", "x")).toBe(false);
    expect(reader.findSessionByFirstPrompt({ cwd: dir, firstPrompt: "none", sinceMs: 0 })).toBeUndefined();
    expect(reader.exportTurns("s-empty")).toEqual([]);
    expect(reader.latestModel("s-empty")).toBeUndefined();
    expect(reader.latestModelSelection("s-empty")).toBeUndefined();
    expect(reader.latestModelUsage("s-empty")).toBeUndefined();
    expect(reader.session("s-empty")).toMatchObject({ id: "s-empty" });
    reader.close();
  });
});

describe("procgroup 结果错误分支", () => {
  it("helper 产出 error → turn process launch failed", async () => {
    // 直接用 spawnDetached 起 不存在命令：helper 捕获 spawn error 事件并写 result.error
    await expect(
      spawnDetached({
        command: "/nonexistent/at-no-such-node",
        argv: ["-e", "0"],
        env: process.env,
        cwd: dir,
        stdoutFile: path.join(dir, "e.out"),
      }),
    ).rejects.toThrow(/turn process launch failed/);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
