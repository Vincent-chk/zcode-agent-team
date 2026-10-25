// F01/F03/F04/F06/F07/F08/F11 + 恢复对账四条件 + 边界/纳管 + drain 策略（fake-zcode 真子进程路径）。
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildProviderKit,
  withFakeEnv,
  framedText,
  waitFor,
  openHost,
  insertModelUsage,
  insertSessionEntry,
  type ProviderKit,
} from "./kit.js";
import { memberPaths, readOrigin, listTurns, readTurn, readCurrentTurnId, writeOrigin, writeTurn as writeTurnDirect, type OriginRecord } from "../../src/provider/member-files.js";
import { readSessionRegistry } from "../../src/mcp/identity.js";
import type { BoundaryEvent } from "../../src/provider/resume-provider.js";

let kit: ProviderKit | null = null;
const restoreFns: Array<() => void> = [];

beforeEach(() => {
  // 0.3.2：继承链按目录分类过滤——注入含假 provider 的目录，否则本机真实目录会把
  // usage-prov/entry-prov 滤掉（leadModelSelectionOf 链语义测试将失真）。
  kit = buildProviderKit({
    modelCatalog: () => ({
      providers: [
        { providerId: "entry-prov", name: "entry", kind: "test", enabled: true, models: [{ id: "entry-model" }] },
        { providerId: "usage-prov", name: "usage", kind: "test", enabled: true, models: [{ id: "usage-model" }] },
      ],
    }),
  });
});

afterEach(async () => {
  // LIFO：嵌套 withFakeEnv 的保存值按逆序恢复（内层先恢复其保存值，外层最终恢复原值）
  for (const restore of restoreFns.splice(0).reverse()) restore();
  await kit?.cleanup();
  kit = null;
});

function db(): DatabaseSync {
  return new DatabaseSync(kit!.dbPath);
}

function countUserText(text: string, sessionId?: string): number {
  const d = db();
  const row = d
    .prepare(
      `SELECT COUNT(*) n FROM message m JOIN part p ON p.message_id = m.id
       WHERE json_extract(m.data,'$.role')='user' AND json_extract(m.data,'$.semantics.origin')='real_user'
         AND json_extract(p.data,'$.type')='text' AND json_extract(p.data,'$.text') = ?
         ${sessionId ? "AND m.session_id = ?" : ""}`,
    )
    .get(...(sessionId ? [text, sessionId] : [text])) as { n: number };
  d.close();
  return row.n;
}

const SPAWN_ARGS = {
  teamId: "sess_s4_lead",
  memberId: "m-s4-a",
  name: "alpha",
  description: "s4 worker",
  firstPrompt: "写一个 sort 函数",
  context: "fresh" as const,
};

describe("F01 · fresh spawn 全链路（真子进程）", () => {
  it("startContinuable：首轮=任务原文逐字落库、origin/session-map/轮次记录齐备、accepted", async () => {
    const result = await kit!.provider.startContinuable(SPAWN_ARGS);
    expect(result.accepted).toBe(true);
    const origin = readOrigin(memberPaths(kit!.provider.teamDir, "m-s4-a"))!;
    expect(origin.sessionId).toMatch(/^sess_fake_/);
    expect(origin.initialUserMessageAccepted).toBe(true);
    // D2：首条用户消息逐字 == prompt（无身份前缀块）
    expect(countUserText("写一个 sort 函数", origin.sessionId!)).toBe(1);
    // 身份映射：provider 兜底写 session-map（teammate 认领，hook 或 daemon 任一先写）
    const registry = readSessionRegistry(kit!.dataRoot);
    const entry = Object.values(registry).find((e) => e.memberId === "m-s4-a");
    expect(entry?.role).toBe("teammate");
    expect(entry?.teamId).toBe("sess_s4_lead");
    // D6/启动参数：--disallowed-tools Task / --surface terminal / --mode yolo / --json
    const turns = listTurns(memberPaths(kit!.provider.teamDir, "m-s4-a").runDir);
    expect(turns).toHaveLength(1);
    expect(turns[0].argv).toContain("Task");
    expect(turns[0].argv).toContain("--disallowed-tools");
    expect(turns[0].argv).toContain("terminal");
    expect(turns[0].argv).toContain("--surface");
    expect(turns[0].argv).toContain("yolo");
    expect(turns[0].argv).toContain("--json");
    expect(turns[0].kind).toBe("first");
    expect(turns[0].messageIds).toEqual([]);
    // 模型行：成员行 model 实查（fake-flash）
    expect(kit!.provider.modelOf("m-s4-a")).toBe("fake-flash");
  });

  it("长轮次存活：isAlive/statusOf=running；退出后 watcher 定案 + 边界事件", async () => {
    restoreFns.push(withFakeEnv({ FAKE_ZCODE_SLEEP_MS: "2500" }));
    const started = await kit!.provider.startContinuable(SPAWN_ARGS);
    expect(started.accepted).toBe(true);
    expect(kit!.provider.isAlive("m-s4-a")).toBe(true);
    expect(kit!.provider.statusOf("m-s4-a")).toBe("running");
    const boundaries: BoundaryEvent[] = [];
    kit!.provider.bind({
      onBoundary: (e) => boundaries.push(e),
      pendingLookup: () => [],
    });
    kit!.provider.adoptOrphans();
    await waitFor(() => !kit!.provider.isAlive("m-s4-a"), 8000);
    expect(kit!.provider.statusOf("m-s4-a")).toBe("inactive");
    await waitFor(() => boundaries.some((b) => b.memberId === "m-s4-a"), 3000); // watcher tick（≤200ms 轮询）
    const turns = listTurns(memberPaths(kit!.provider.teamDir, "m-s4-a").runDir);
    expect(turns[turns.length - 1].status).toBe("exited");
  });
});

describe("模型呈现（stage-8 Round B）", () => {
  it("modelOf：transcript 实查优先；无消息回退 origin 三元组/旧 model；无 origin → undefined", async () => {
    const started = await kit!.provider.startContinuable(SPAWN_ARGS);
    expect(started.accepted).toBe(true);
    expect(kit!.provider.modelOf("m-s4-a")).toBe("fake-flash"); // 消息里的 modelSelection 实查

    const originBase: Omit<OriginRecord, "memberId" | "sessionId"> = {
      teamId: kit!.teamId,
      name: "n",
      provider: "spawn",
      mode: "continuable",
      context: "fresh",
      createdAt: new Date().toISOString(),
      cwd: kit!.cwd,
      firstPromptText: "p",
      firstPromptSha256: "sha",
      initialUserMessageAccepted: false,
    };
    const selected = memberPaths(kit!.provider.teamDir, "m-origin-sel");
    writeOrigin(selected, {
      ...originBase,
      memberId: "m-origin-sel",
      sessionId: null,
      modelSelection: { providerId: "p", modelId: "cfg-model" },
      modelSource: "explicit",
    });
    expect(kit!.provider.modelOf("m-origin-sel")).toBe("cfg-model");

    const legacy = memberPaths(kit!.provider.teamDir, "m-origin-legacy");
    writeOrigin(legacy, {
      ...originBase,
      memberId: "m-origin-legacy",
      sessionId: "sess_no_rows",
      model: "legacy-model",
    });
    expect(kit!.provider.modelOf("m-origin-legacy")).toBe("legacy-model");
    expect(kit!.provider.modelOf("m-nobody")).toBeUndefined();
  });

  it("leadModelSelectionOf：三源按时间戳取最新（0.4.0 展示口径；不可继承 → undefined）", () => {
    expect(kit!.provider.leadModelSelectionOf()).toBeUndefined();
    insertModelUsage(kit!.dbPath, {
      sessionId: kit!.teamId,
      providerId: "usage-prov",
      modelId: "usage-model",
      variant: "high",
      startedAt: 1,
    });
    expect(kit!.provider.leadModelSelectionOf()).toEqual({
      providerId: "usage-prov",
      modelId: "usage-model",
      reasoningLevel: "high",
    });
    insertSessionEntry(kit!.dbPath, {
      sessionId: kit!.teamId,
      data: {
        modelSelection: {
          providerId: "entry-prov",
          modelId: "entry-model",
          options: { reasoningLevel: "max" },
        },
      },
    });
    // 条目是权威：即使 usage 更新也不影响（继承链第一档）
    expect(kit!.provider.leadModelSelectionOf()).toEqual({
      providerId: "entry-prov",
      modelId: "entry-model",
      reasoningLevel: "max",
    });
  });

  it("leadModelOf：Lead 最近消息 → model_usage 兜底 → undefined", () => {
    expect(kit!.provider.leadModelOf()).toBeUndefined();
    insertModelUsage(kit!.dbPath, {
      sessionId: kit!.teamId,
      providerId: "p",
      modelId: "usage-lead",
      startedAt: 1,
    });
    expect(kit!.provider.leadModelOf()).toBe("usage-lead");
    const d = db();
    d.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)",
    ).run(
      "msg_lead",
      kit!.teamId,
      Date.now(),
      Date.now(),
      JSON.stringify({
        role: "user",
        semantics: { origin: "real_user" },
        modelSelection: { providerId: "p", modelId: "message-lead" },
      }),
      0,
    );
    d.close();
    expect(kit!.provider.leadModelOf()).toBe("message-lead");
  });
});

describe("F03 · 供给失败路径", () => {
  it("坏二进制 → 抛错（spawn-error 落轮次记录）", async () => {
    const { badZcodeBin } = await import("./kit.js");
    const bad = buildProviderKit({ zcode: badZcodeBin() });
    try {
      await expect(
        bad.provider.startContinuable({ ...SPAWN_ARGS, teamId: bad.teamId }),
      ).rejects.toThrow(/turn process|Cannot find module|launch failed/i);
      const turns = listTurns(memberPaths(bad.provider.teamDir, "m-s4-a").runDir);
      expect(turns[0].status).toBe("spawn-error");
    } finally {
      await bad.cleanup();
    }
  });
});

describe("F04 · 首轮未持久接收", () => {
  it("进程起但会话未落（FAKE_ZCODE_NO_PERSIST）→ accepted:false（上游 TEAM_PROVISIONING_CONFLICT）", async () => {
    restoreFns.push(withFakeEnv({ FAKE_ZCODE_NO_PERSIST: "1" }));
    const result = await kit!.provider.startContinuable(SPAWN_ARGS);
    expect(result).toEqual({ memberId: "m-s4-a", accepted: false });
  });
});

describe("F06/F07 · 消息投递（运行中/空闲/冷）", () => {
  it("运行中 → queued；轮次退出后边界投递（host 装配：--resume 合并框架头 + delivered 事件）", async () => {
    restoreFns.push(withFakeEnv({ FAKE_ZCODE_SLEEP_MS: "1200" }));
    const host = await openHost(kit!);
    try {
      const spawned = (await host.dispatch("member.spawn", {
        session_id: kit!.teamId,
        name: "alpha",
        description: "s4 worker",
        prompt: "写一个 sort 函数",
      })) as { member: { status: string; target: string } };
      expect(spawned.member.status).toBe("running"); // 首轮仍在跑（availability 实查）
      const memberId = fs.readdirSync(path.join(kit!.provider.teamDir, "members"))[0];
      const sent = (await host.dispatch("message.send", {
        session_id: kit!.teamId,
        targetName: "alpha",
        content: [{ type: "text", text: "amber-s4-01" }],
      })) as { messageId: string };
      expect(typeof sent.messageId).toBe("string");
      // 运行中：pending 落盘（对外 {messageId}，无 queued 字段——D1 工具层口径）；delivered 未记
      let board = await host.readBoard();
      expect(board.state.delivered).toHaveLength(0);
      // 负断言（F06）：运行中不发起拉起尝试——本轮无 deliver 轮次
      expect(listTurns(memberPaths(kit!.provider.teamDir, memberId).runDir)).toHaveLength(1);
      // 轮次退出 → watcher 边界 → recoverFor 拉起 --resume → landed → delivered（内部适配自证）
      await waitFor(async () => (await host.readBoard()).state.delivered.length === 1, 15_000, 100);
      board = await host.readBoard();
      expect(board.state.delivered[0]).toBe(sent.messageId);
      const origin = readOrigin(memberPaths(kit!.provider.teamDir, memberId))!;
      const turns = listTurns(memberPaths(kit!.provider.teamDir, memberId).runDir);
      const deliverTurn = turns.find((t) => t.kind === "deliver")!;
      expect(deliverTurn.argv[deliverTurn.argv.indexOf("--resume") + 1]).toBe(origin.sessionId);
      expect(deliverTurn.messageIds).toEqual([sent.messageId]);
      expect(deliverTurn.promptText).toContain("Team message from lead:\namber-s4-01"); // D1 框架头（无 id）
      expect(countUserText(deliverTurn.promptText, origin.sessionId!)).toBe(1); // 恰一次（transcript 检索）
      // 模型在下一轮引用消息内容 = prompt 逐字进入该轮（真实模型路径由 scripts/stage4-real.mjs 验收）
    } finally {
      await host.close().catch(() => undefined);
    }
  });

  it("空闲/冷目标 → 立即拉起并 accepted", async () => {
    const started = await kit!.provider.startContinuable(SPAWN_ARGS);
    expect(started.accepted).toBe(true);
    await waitFor(() => !kit!.provider.isAlive("m-s4-a"), 8000);
    const msg = framedText("lead", "birch-s4-02");
    await expect(kit!.provider.deliver({ memberId: "m-s4-a", framedMessage: msg.framedJson, messageId: msg.messageId })).resolves.toBe("accepted");
    expect(kit!.provider.containsMessage("m-s4-a", msg.messageId)).toBe(true);
  });

  it("多消息合并：pendingLookup 全量依序并入一轮 prompt（每条保留框架头）", async () => {
    const started = await kit!.provider.startContinuable(SPAWN_ARGS);
    expect(started.accepted).toBe(true);
    await waitFor(() => !kit!.provider.isAlive("m-s4-a"), 8000);
    const m1 = framedText("lead", "m1-body");
    const m2 = framedText("beta", "m2-body");
    kit!.provider.bind({
      onBoundary: () => undefined,
      pendingLookup: (memberId) => (memberId === "m-s4-a" ? [m1, m2] : []),
    });
    await expect(kit!.provider.deliver({ memberId: "m-s4-a", framedMessage: m1.framedJson, messageId: m1.messageId })).resolves.toBe("accepted");
    const turns = listTurns(memberPaths(kit!.provider.teamDir, "m-s4-a").runDir);
    const deliverTurn = turns.find((t) => t.kind === "deliver")!;
    expect(deliverTurn.messageIds).toEqual([m1.messageId, m2.messageId]);
    expect(deliverTurn.promptText).toContain("Team message from lead:\nm1-body");
    expect(deliverTurn.promptText).toContain("Team message from beta:\nm2-body");
    expect(countUserText(deliverTurn.promptText)).toBe(1);
  });
});

describe("F08 · 恰一次交付（内部适配自证）", () => {
  it("崩溃在收/认之间（落库但未 delivered）→ 重投去重：不重复写 transcript", async () => {
    const started = await kit!.provider.startContinuable(SPAWN_ARGS);
    expect(started.accepted).toBe(true);
    const origin = readOrigin(memberPaths(kit!.provider.teamDir, "m-s4-a"))!;
    const msg = framedText("lead", "cedar-s4-03");
    await expect(kit!.provider.deliver({ memberId: "m-s4-a", framedMessage: msg.framedJson, messageId: msg.messageId })).resolves.toBe("accepted");
    await waitFor(() => !kit!.provider.isAlive("m-s4-a"), 8000);
    // 目标已收、delivered 未记 → 再次 deliver 同 id：accepted 且无新轮次
    const turnsBefore = listTurns(memberPaths(kit!.provider.teamDir, "m-s4-a").runDir).length;
    await expect(kit!.provider.deliver({ memberId: "m-s4-a", framedMessage: msg.framedJson, messageId: msg.messageId })).resolves.toBe("accepted");
    expect(listTurns(memberPaths(kit!.provider.teamDir, "m-s4-a").runDir)).toHaveLength(turnsBefore);
    expect(countUserText(JSON.parse(msg.framedJson).map((b: { text?: string }) => b.text).join("\n"), origin.sessionId!)).toBe(1);
  });
});

describe("F11 · interrupt", () => {
  it("长任务运行中 → previousStatus=running、进程终止、pending 保留、可再投递", async () => {
    restoreFns.push(withFakeEnv({ FAKE_ZCODE_SLEEP_MS: "20000" }));
    const started = await kit!.provider.startContinuable(SPAWN_ARGS);
    expect(started.accepted).toBe(true);
    const origin = readOrigin(memberPaths(kit!.provider.teamDir, "m-s4-a"))!;
    const result = await kit!.provider.interrupt({ memberId: "m-s4-a" });
    expect(result).toEqual({ previousStatus: "running" });
    await waitFor(() => !kit!.provider.isAlive("m-s4-a"), 5000);
    const turnId = readCurrentTurnId(memberPaths(kit!.provider.teamDir, "m-s4-a"));
    expect(readTurn(memberPaths(kit!.provider.teamDir, "m-s4-a").runDir, turnId!)!.status).toBe("interrupted");
    // 会话可续：下轮 --resume 正常
    const restore = withFakeEnv({ FAKE_ZCODE_SLEEP_MS: undefined });
    restoreFns.push(restore);
    const msg = framedText("lead", "post-interrupt");
    await expect(kit!.provider.deliver({ memberId: "m-s4-a", framedMessage: msg.framedJson, messageId: msg.messageId })).resolves.toBe("accepted");
    const turns = listTurns(memberPaths(kit!.provider.teamDir, "m-s4-a").runDir);
    const resumeTurn = turns[turns.length - 1];
    expect(resumeTurn.argv).toContain("--resume");
    expect(resumeTurn.argv[resumeTurn.argv.indexOf("--resume") + 1]).toBe(origin.sessionId);
  });

  it("空闲目标 → previousStatus=inactive 无副作用", async () => {
    const started = await kit!.provider.startContinuable(SPAWN_ARGS);
    expect(started.accepted).toBe(true);
    await waitFor(() => !kit!.provider.isAlive("m-s4-a"), 8000);
    await expect(kit!.provider.interrupt({ memberId: "m-s4-a" })).resolves.toEqual({
      previousStatus: "inactive",
    });
  });

  it("SIGTERM 免疫进程 → SIGKILL 升级", async () => {
    restoreFns.push(withFakeEnv({ FAKE_ZCODE_SLEEP_MS: "20000", FAKE_ZCODE_IGNORE_SIGTERM: "1" }));
    const started = await kit!.provider.startContinuable(SPAWN_ARGS);
    expect(started.accepted).toBe(true);
    const t0 = Date.now();
    const result = await kit!.provider.interrupt({ memberId: "m-s4-a" });
    expect(result.previousStatus).toBe("running");
    expect(kit!.provider.isAlive("m-s4-a")).toBe(false);
    expect(Date.now() - t0).toBeLessThan(6000); // 宽限 800ms + SIGKILL 兜底
  });
});

describe("恢复对账（§5.4 四条件 / F05 夹具）", () => {
  it("无 origin → undefined（→ did not leave a resumable child Session）", async () => {
    const started = await kit!.provider.startContinuable(SPAWN_ARGS);
    expect(started.accepted).toBe(true);
    const other = memberPaths(kit!.provider.teamDir, "m-s4-orphan");
    fs.mkdirSync(path.dirname(other.originFile), { recursive: true });
    expect(kit!.provider.readProvisioningRecord("m-s4-orphan")).toBeUndefined();
  });

  it("条件满足 → {rootSessionId, descriptor, initialUserMessageAccepted:true}", async () => {
    const started = await kit!.provider.startContinuable(SPAWN_ARGS);
    expect(started.accepted).toBe(true);
    const record = kit!.provider.readProvisioningRecord("m-s4-a")!;
    expect(record.rootSessionId).toBe("sess_s4_lead");
    expect(record.descriptor).toEqual({ provider: "spawn", mode: "continuable" });
    expect(record.initialUserMessageAccepted).toBe(true);
  });

  it("provider 不匹配（member.provider=fork 而 origin=spawn）→ 条件不满足（由 roster 判 does not match）", async () => {
    const started = await kit!.provider.startContinuable(SPAWN_ARGS);
    expect(started.accepted).toBe(true);
    const record = kit!.provider.readProvisioningRecord("m-s4-a")!;
    expect(record.descriptor!.provider).toBe("spawn"); // roster 对比 member.provider=fork → failed
  });

  it("origin 损坏 → 抛错（→ child Session recovery failed）", async () => {
    const paths = memberPaths(kit!.provider.teamDir, "m-s4-corrupt");
    fs.mkdirSync(path.dirname(paths.originFile), { recursive: true });
    fs.writeFileSync(paths.originFile, "{not json");
    expect(() => kit!.provider.readProvisioningRecord("m-s4-corrupt")).toThrow();
  });
});

describe("孤儿纳管（T4.4）", () => {
  it("死 pid 的 running 轮次 → adoptOrphans 定案（exited + landed 实查）+ 边界事件", async () => {
    restoreFns.push(withFakeEnv({ FAKE_ZCODE_SLEEP_MS: "400" }));
    const started = await kit!.provider.startContinuable(SPAWN_ARGS);
    expect(started.accepted).toBe(true);
    await waitFor(() => !kit!.provider.isAlive("m-s4-a"), 5000);
    const boundaries: BoundaryEvent[] = [];
    kit!.provider.bind({ onBoundary: (e) => boundaries.push(e), pendingLookup: () => [] });
    // 篡改 run 状态模拟「daemon 死前未定案」
    const paths = memberPaths(kit!.provider.teamDir, "m-s4-a");
    const turnId = readCurrentTurnId(paths)!;
    const turn = readTurn(paths.runDir, turnId)!;
    writeTurnDirect(paths.runDir, { ...turn, status: "running" });
    const result = kit!.provider.adoptOrphans();
    expect(result.finalized).toContain(turnId);
    expect(readTurn(paths.runDir, turnId)!.status).toBe("exited");
    expect(readTurn(paths.runDir, turnId)!.landed).toBe(true);
    expect(boundaries.some((b) => b.memberId === "m-s4-a")).toBe(true);
  });
});

describe("drain（D9 策略）", () => {
  it("keep（默认）：仅落标记，轮次进程存活（休眠态）", async () => {
    restoreFns.push(withFakeEnv({ FAKE_ZCODE_SLEEP_MS: "3000" }));
    const started = await kit!.provider.startContinuable(SPAWN_ARGS);
    expect(started.accepted).toBe(true);
    await kit!.provider.drain({ teamId: kit!.teamId, timeoutMs: 2000 });
    expect(kit!.provider.isAlive("m-s4-a")).toBe(true);
    const paths = memberPaths(kit!.provider.teamDir, "m-s4-a");
    expect(fs.existsSync(paths.drainMarkerFile)).toBe(true);
    // 纳管清标记
    kit!.provider.adoptOrphans();
    expect(fs.existsSync(paths.drainMarkerFile)).toBe(false);
    await waitFor(() => !kit!.provider.isAlive("m-s4-a"), 6000);
  });

  it("kill：SIGTERM→SIGKILL 限时终止；失败显式抛错", async () => {
    const killKit = buildProviderKit({ drainPolicy: "kill" });
    try {
      restoreFns.push(withFakeEnv({ FAKE_ZCODE_SLEEP_MS: "20000", FAKE_ZCODE_IGNORE_SIGTERM: "1" }));
      const started = await killKit.provider.startContinuable({ ...SPAWN_ARGS, teamId: killKit.teamId });
      expect(started.accepted).toBe(true);
      await killKit.provider.drain({ teamId: killKit.teamId, timeoutMs: 5000 });
      expect(killKit.provider.isAlive("m-s4-a")).toBe(false);
    } finally {
      await killKit.cleanup();
    }
  });
});

