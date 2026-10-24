// stage-5 T5.2 数据面集成测（真实 TeamToolBackend + MockProvider 装配；F01/F02/F14 服务侧）：
//  - 帧内容：spawn/task 后 members/tasks 行进帧（MEMBER_VIEW ⊕ id/sessionId）；
//  - F02：mailbox-only 变化 contentKey 不变（不发帧口径）；任务变化 → 键变；
//  - snapshot 落盘/读回（断线基线）；
//  - team_panel_call：heartbeat 基线（stage-1 语义）/refresh 帧/detail 契约/错误可读。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { TeamToolBackend } from "../../src/mcp/backend.js";
import { MockProvider } from "../../src/provider/mock-provider.js";
import { upsertSessionEntry } from "../../src/mcp/identity.js";
import { PanelViewService, snapshotFile, buildStaticFrame } from "../../src/panel/view-service.js";
import { handlePanelCall, type PanelCallResult } from "../../src/panel/panel-call.js";
import { TranscriptReader } from "../../src/provider/transcript.js";
import { createTestDb } from "../provider/kit.js";
import { load } from "../../src/coord/replay.js";
import type { TeamLimits } from "../../src/domain/config.js";

const LIMITS: TeamLimits = {
  maxMembers: 8,
  maxTasks: 256,
  maxMessageBytes: 65536,
  disposalTimeoutMs: 5000,
};

const LEAD = "sess_s5_lead";
const BOOT = Date.now();

let root = "";
let dataRoot = "";
let dbPath = "";
let db: DatabaseSync;
let backend: TeamToolBackend;
let provider: MockProvider;
let service: PanelViewService;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-s5-view-"));
  dataRoot = path.join(root, "data");
  dbPath = path.join(root, "db.sqlite");
  createTestDb(dbPath);
  db = new DatabaseSync(dbPath);
  provider = new MockProvider();
  backend = new TeamToolBackend({ dataRoot, limits: LIMITS, provider });
  service = new PanelViewService({ dataRoot, bootTimeMs: BOOT, backend });
});

afterEach(async () => {
  await backend.close().catch(() => undefined);
  db.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

const leadMeta = { session_id: LEAD };

function panelDeps(): Parameters<typeof handlePanelCall>[0] {
  let counter = 0;
  return {
    view: service,
    dataRoot,
    bootTimeMs: BOOT,
    reader: new TranscriptReader({ dbPath }),
    bumpCounter: () => (counter += 1),
  };
}

async function spawn(name: string): Promise<void> {
  await backend.spawnTeammate(
    { sessionId: LEAD, teamId: LEAD, role: "lead", name: "lead", agentId: LEAD, source: "meta", hookRegistered: true },
    { name, description: `${name} desc`, prompt: `work ${name}` },
  );
}

describe("构帧（F01 数据源）", () => {
  it("无团队事件 → team:null 空帧（面板加载/不可用条数据源）", async () => {
    const frame = await service.buildFrame(leadMeta);
    expect(frame.team).toBeNull();
    expect(frame.members).toEqual([]);
    expect(frame.tasks).toEqual([]);
    expect(frame.stateVersion).toBe(4);
  });

  it("无身份 → 空帧（不向订阅者抛错）", async () => {
    const frame = await service.buildFrame(undefined);
    expect(frame.team).toBeNull();
  });

  it("spawn 后：lead 伪行 + teammate 行（MEMBER_VIEW 字段 ⊕ id/sessionId）", async () => {
    await spawn("alice");
    const frame = await service.buildFrame(leadMeta);
    expect(frame.team).toMatchObject({ teamId: LEAD, status: "active" });
    expect(frame.members).toHaveLength(2);
    const lead = frame.members[0];
    expect(lead).toMatchObject({ target: "lead", role: "lead", id: LEAD, sessionId: LEAD });
    const alice = frame.members[1];
    expect(alice.target).toBe("alice");
    expect(alice.role).toBe("teammate");
    expect(alice.status).toBe("running"); // MockProvider isAlive=true（运行中呈现）
    expect(alice.id).toBeTruthy();
    expect(alice.diagnostics).toEqual([]);
    expect(frame.meta.sessionId).toBe(LEAD);
  });

  it("task.create 后进帧（TASK_VIEW 原样：ready/blockedBy/writeScopeWarnings）", async () => {
    await backend.taskCreate(
      { sessionId: LEAD, teamId: LEAD, role: "lead", name: "lead", agentId: LEAD, source: "meta", hookRegistered: true },
      { subject: "任务甲", description: "描述", write_scopes: ["src/a"] },
    );
    const frame = await service.buildFrame(leadMeta);
    expect(frame.tasks).toHaveLength(1);
    expect(frame.tasks[0]).toMatchObject({ subject: "任务甲", status: "pending", ready: true, writeScopes: ["src/a"] });
  });

  it("F02：mailbox-only 变化 contentKey 不变（不发帧）；task 变化 → 键变", async () => {
    await spawn("alice");
    const aliceId = (await service.buildFrame(leadMeta)).members[1].id;
    const k0 = service.contentKey(await service.buildFrame(leadMeta));
    // send_message → queued（MockProvider deliver=accepted 折叠或 queued 均不触碰 members/tasks）
    await backend.sendMessage(
      { sessionId: LEAD, teamId: LEAD, role: "lead", name: "lead", agentId: LEAD, source: "meta", hookRegistered: true },
      { target: "alice", message: "hello" },
    );
    const k1 = service.contentKey(await service.buildFrame(leadMeta));
    expect(k1).toBe(k0);
    void aliceId;
    // 任务变更 → 键变
    await backend.taskCreate(
      { sessionId: LEAD, teamId: LEAD, role: "lead", name: "lead", agentId: LEAD, source: "meta", hookRegistered: true },
      { subject: "任务乙", description: "d" },
    );
    const k2 = service.contentKey(await service.buildFrame(leadMeta));
    expect(k2).not.toBe(k1);
  });
});

describe("snapshot（断线重连基线）", () => {
  it("writeSnapshot → readSnapshot 往返一致；损坏文件 → undefined", async () => {
    await spawn("alice");
    const frame = await service.buildFrame(leadMeta);
    service.writeSnapshot(LEAD, frame);
    const file = snapshotFile(path.join(dataRoot, "teams", LEAD.replace(/[^A-Za-z0-9._-]/g, (c) => "~" + c.codePointAt(0)!.toString(16))));
    expect(fs.existsSync(file)).toBe(true);
    const back = service.readSnapshot(LEAD);
    expect(back).toEqual(frame);
    fs.writeFileSync(file, "{corrupt");
    expect(service.readSnapshot(LEAD)).toBeUndefined();
  });
});

describe("buildStaticFrame（保守派生；team-ctl widget/listAgents 失败兜底）", () => {
  it("active 成员保守呈 inactive；lead 伪行恒在；failure 透传", async () => {
    await spawn("alice");
    const teamDir = path.join(dataRoot, "teams", LEAD.replace(/[^A-Za-z0-9._-]/g, (c) => "~" + c.codePointAt(0)!.toString(16)));
    const loaded = await load(teamDir, LEAD);
    const staticFrame = buildStaticFrame(loaded, LEAD, "2026-10-18T00:00:00.000Z", LEAD, teamDir);
    expect(staticFrame.members[0]).toMatchObject({ target: "lead", status: "inactive" });
    expect(staticFrame.members[1]).toMatchObject({ target: "alice", status: "inactive" }); // D16a 保守
    expect(staticFrame.team?.status).toBe("active");
  });
});

describe("team_panel_call（F14 回环面）", () => {
  it("label-only = stage-1 心跳基线（counter 递增，无 action 兼容）", async () => {
    const deps = panelDeps();
    const r1 = (await handlePanelCall(deps, { label: "heartbeat" }, leadMeta)) as Extract<PanelCallResult, { kind: "heartbeat" }>;
    const r2 = (await handlePanelCall(deps, { label: "heartbeat" }, leadMeta)) as Extract<PanelCallResult, { kind: "heartbeat" }>;
    expect(r1.kind).toBe("heartbeat");
    expect(r2.counter).toBe(r1.counter + 1);
    expect(r1.label).toBe("heartbeat");
  });

  it("action=refresh → 全量视图帧（frame.team 在场）", async () => {
    await spawn("alice");
    const r = (await handlePanelCall(panelDeps(), { action: "refresh" }, leadMeta)) as Extract<PanelCallResult, { kind: "view" }>;
    expect(r.kind).toBe("view");
    expect(r.frame.team?.teamId).toBe(LEAD);
    expect(r.frame.members).toHaveLength(2);
  });

  it("action=detail → T5.7 契约（sessionId/memberId/page.items）", async () => {
    await spawn("alice");
    // lead 会话转录（db 夹具插一条 real_user）
    db.prepare("INSERT INTO session (id, directory, task_type, time_created) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING").run(LEAD, "/ws", "interactive", Date.now());
    db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)").run(
      "m1", LEAD, Date.now(), Date.now(),
      JSON.stringify({ role: "user", semantics: { origin: "real_user" } }), 1,
    );
    db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?,?)").run(
      "p1", "m1", LEAD, Date.now(), Date.now(), JSON.stringify({ type: "text", text: "lead prompt" }), 0,
    );
    const r = (await handlePanelCall(panelDeps(), { action: "detail", target: "lead" }, leadMeta)) as Extract<PanelCallResult, { kind: "detail" }>;
    expect(r.kind).toBe("detail");
    expect(r.detail.sessionId).toBe(LEAD);
    expect(r.detail.page.items).toHaveLength(1);
    expect(r.detail.page.items[0]).toMatchObject({ role: "user", kind: "text", text: "lead prompt", seq: 1 });
  });

  it("detail 无 target → TEAM_INVALID_ARGUMENT（工具面冻结消息）", async () => {
    const r = (await handlePanelCall(panelDeps(), { action: "detail" }, leadMeta)) as Extract<PanelCallResult, { kind: "error" }>;
    expect(r.kind).toBe("error");
    expect(r.code).toBe("TEAM_INVALID_ARGUMENT");
    expect(r.message).toBe('param "target" must be a non-empty string');
  });

  it("detail 目标不存在 → TEAM_MEMBER_NOT_FOUND；未知 action → 可读错误", async () => {
    await spawn("alice");
    const r = (await handlePanelCall(panelDeps(), { action: "detail", target: "ghost" }, leadMeta)) as Extract<PanelCallResult, { kind: "error" }>;
    expect(r.code).toBe("TEAM_MEMBER_NOT_FOUND");
    expect(r.message).toBe('active teammate "ghost" not found');
    const r2 = (await handlePanelCall(panelDeps(), { action: "nope" }, leadMeta)) as Extract<PanelCallResult, { kind: "error" }>;
    expect(r2.code).toBe("TEAM_INVALID_ARGUMENT");
    expect(r2.message).toContain('unknown panel action "nope"');
  });

  it("无身份调用 refresh → team:null 空帧（fail-closed 呈现，不抛协议错）", async () => {
    const r = (await handlePanelCall(panelDeps(), { action: "refresh" }, undefined)) as Extract<PanelCallResult, { kind: "view" }>;
    expect(r.kind).toBe("view");
    expect(r.frame.team).toBeNull();
  });
});

describe("teammate 身份构帧（跨会话视角）", () => {
  it("teammate 会话调用 → 同团队帧（session-map 映射路径）", async () => {
    await spawn("alice");
    const frame0 = await service.buildFrame(leadMeta);
    const aliceId = frame0.members[1].id;
    upsertSessionEntry(dataRoot, "sess_alice_child", {
      session_id: "sess_alice_child",
      teamId: LEAD,
      role: "teammate",
      name: "alice",
      memberId: aliceId,
    });
    const frame = await service.buildFrame({ session_id: "sess_alice_child" });
    expect(frame.team?.teamId).toBe(LEAD);
    expect(frame.meta.sessionId).toBe("sess_alice_child");
    // 当前会话判定 = teammate 行（面板高亮数据源）
    expect(frame.members.find((m) => m.sessionId === "sess_alice_child")).toBeDefined();
  });
});

describe("分支补强（failure 终态/快照异常/loadState/无事件+快照基线）", () => {
  function teamDirOf(teamId: string): string {
    return path.join(dataRoot, "teams", teamId.replace(/[^A-Za-z0-9._-]/g, (c) => "~" + c.codePointAt(0)!.toString(16)));
  }

  it("投影 failure 终态 → listAgents 抛 C5 → 静态保守帧（failure 透传，面板可见）", async () => {
    const teamDir = teamDirOf(LEAD);
    fs.mkdirSync(teamDir, { recursive: true });
    const events = [
      { type: "team/member", version: 2, teamId: LEAD, member: { id: "m1", name: "w", description: "d", provider: "spawn", context: "fresh", phase: "provisioning" } },
      { type: "team/member", version: 2, teamId: LEAD, member: { id: "m1", name: "w", description: "d", provider: "spawn", context: "fresh", phase: "active" } },
      // 非法：成员必须先 provisioning 的新 id 重复 active（不变量拒绝 → failure 终态）
      { type: "team/member", version: 2, teamId: LEAD, member: { id: "m2", name: "w2", description: "d", provider: "spawn", context: "fresh", phase: "active" } },
    ];
    fs.writeFileSync(
      path.join(teamDir, "events.jsonl"),
      events.map((event, i) => JSON.stringify({ seq: i + 1, ts: new Date().toISOString(), writer: "seed:1", event })).join("\n") + "\n",
    );
    const frame = await service.buildFrame(leadMeta);
    expect(frame.team?.status).toBe("failure");
    expect(frame.team?.failure).toBeTruthy();
    expect(frame.members.length).toBeGreaterThanOrEqual(2); // 保守成员行仍在（静态派生）
  });

  it("readSnapshot：无文件/损坏 JSON → undefined", () => {
    expect(service.readSnapshot("sess_none")).toBeUndefined();
    const file = snapshotFile(teamDirOf(LEAD));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{corrupt");
    expect(service.readSnapshot(LEAD)).toBeUndefined();
    fs.rmSync(file);
  });

  it("writeSnapshot 目标不可写（teamDir 是文件）→ 仅告警不抛", async () => {
    const warns: string[] = [];
    const svc2 = new PanelViewService({ dataRoot, bootTimeMs: BOOT, backend, warn: (m) => warns.push(m) });
    const badTeam = "sess_bad_snapshot";
    const teamDirBad = teamDirOf(badTeam);
    fs.mkdirSync(path.dirname(teamDirBad), { recursive: true });
    fs.writeFileSync(teamDirBad, "not-a-dir");
    const frame = await service.buildFrame(leadMeta);
    svc2.writeSnapshot(badTeam, frame);
    expect(warns.some((w) => w.includes("snapshot write failed"))).toBe(true);
  });

  it("事件日志被清但快照在场 → 快照即基线（F03 断线口径）", async () => {
    const teamDir = teamDirOf(LEAD);
    fs.mkdirSync(teamDir, { recursive: true });
    const eventsFile = path.join(teamDir, "events.jsonl");
    fs.writeFileSync(
      eventsFile,
      JSON.stringify({
        seq: 1,
        ts: new Date().toISOString(),
        writer: "seed:1",
        event: { type: "team/task", version: 2, teamId: LEAD, task: { id: "task-1", revision: 1, subject: "基线任务", description: "d", status: "pending", blockedBy: [], writeScopes: [] } },
      }) + "\n",
    );
    const before = await service.buildFrame(leadMeta);
    expect(before.team?.teamId).toBe(LEAD);
    service.writeSnapshot(LEAD, before);
    // 事件日志被清（异常）→ 快照即基线（非 team:null 空帧）
    fs.rmSync(eventsFile);
    const svc2 = new PanelViewService({ dataRoot, bootTimeMs: BOOT, backend });
    const frame = await svc2.buildFrame(leadMeta);
    expect(frame.team?.teamId).toBe(LEAD);
    expect(frame.tasks).toHaveLength(1);
    expect(frame.meta.sessionId).toBe(LEAD);
  });

  it("loadState：重放态直读（messages 供 detail framed 回填）", async () => {
    // 重建事件日志（上一用例清掉了）
    const teamDir = teamDirOf(LEAD);
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, "events.jsonl"),
      JSON.stringify({
        seq: 1,
        ts: new Date().toISOString(),
        writer: "seed:1",
        event: { type: "team/message/queued", version: 2, teamId: LEAD, message: { id: "msg-x", senderId: LEAD, senderName: "lead", targetId: "m1", content: [{ type: "text", text: "hi" }] } },
      }) + "\n",
    );
    const state = await service.loadState(LEAD);
    expect(state.id).toBe(LEAD);
    expect(state.messages).toHaveLength(1);
  });
});
