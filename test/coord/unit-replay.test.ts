// T2.2 replay 单元：冷启动全量/增量、checkpoint 命中与回退、损坏行 fail-closed、writers 审计。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load, writeCheckpoint, checkpointPath } from "../../src/coord/replay.js";
import { buildTeamProjection } from "../../src/domain/projection.js";
import { memberEvent, queuedEvent, deliveredEvent, TEAM_ID } from "../domain/helpers.js";

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "at-replay-"));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 受限目录内拼接路径（边界校验：拒绝越出 root 的片段）。 */
function under(root: string, name: string): string {
  const p = path.join(root, name);
  const base = path.resolve(root) + path.sep;
  if (!path.resolve(p).startsWith(base)) throw new Error(`path escapes test root: ${name}`);
  return p;
}

function writeLines(team: string, lines: Array<{ seq: number; writer?: string; event: unknown }>): string {
  const teamDir = under(dir, team);
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(
    path.join(teamDir, "events.jsonl"),
    lines
      .map((l) => JSON.stringify({ ts: "2026-10-15T00:00:00.000Z", writer: l.writer ?? "boot-a:1", ...l }))
      .join("\n") + "\n",
  );
  return teamDir;
}

describe("replay · 冷启动全量重放", () => {
  it("空目录 → 空状态 seq 0；与 domain buildTeamProjection 一致", async () => {
    const teamDir = under(dir, "empty");
    fs.mkdirSync(teamDir, { recursive: true });
    const loaded = await load(teamDir, TEAM_ID);
    expect(loaded.seq).toBe(0);
    expect(loaded.fromCheckpoint).toBe(false);
    expect(loaded.state).toEqual(buildTeamProjection([], TEAM_ID));
    expect(loaded.view.members).toHaveLength(1); // Lead 伪行
  });

  it("健康日志 → 状态 = 逐事件 fold（复用 domain，不重写规则）", async () => {
    const events = [
      memberEvent({ id: "a1", name: "w1", phase: "provisioning" }),
      memberEvent({ id: "a1", name: "w1", phase: "active" }),
      queuedEvent({ id: "m1", targetId: "a1" }),
      deliveredEvent("m1", "a1"),
    ];
    const teamDir = writeLines(
      "healthy",
      events.map((event, i) => ({ seq: i + 1, event })),
    );
    const loaded = await load(teamDir, TEAM_ID);
    expect(loaded.seq).toBe(4);
    expect(loaded.state).toEqual(buildTeamProjection(events, TEAM_ID));
    expect(loaded.state.messages).toHaveLength(1);
    expect(loaded.state.delivered).toEqual(["m1"]);
    expect(loaded.corrupt).toBeUndefined();
  });

  it("writers 首见序列（双写排查依据）", async () => {
    const teamDir = writeLines("writers", [
      { seq: 1, writer: "boot-a:1", event: memberEvent({ id: "a1", name: "w1" }) },
      { seq: 2, writer: "boot-a:1", event: memberEvent({ id: "a1", name: "w1", phase: "active" }) },
      { seq: 3, writer: "boot-b:2", event: queuedEvent({ id: "m1", targetId: "a1" }) },
    ]);
    const loaded = await load(teamDir, TEAM_ID);
    expect(loaded.writers).toEqual(["boot-a:1", "boot-b:2"]);
  });
});

describe("replay · 损坏行 fail-closed（不静默跳过）", () => {
  it("末尾半行（无换行的残缺 JSON）→ failure 保护 + corrupt 定位", async () => {
    const teamDir = under(dir, "torn");
    fs.mkdirSync(teamDir, { recursive: true });
    const good = JSON.stringify({ seq: 1, ts: "t", writer: "b:1", event: memberEvent({ id: "a1", name: "w1" }) });
    fs.writeFileSync(path.join(teamDir, "events.jsonl"), good + "\n" + '{"seq":2,"ts":"t","wri');
    const loaded = await load(teamDir, TEAM_ID);
    expect(loaded.state.failure).toBe("persisted Agent Teams stream payload is invalid");
    expect(loaded.corrupt).toEqual({ line: 2, reason: "trailing partial line (no newline)" });
    expect(loaded.seq).toBe(2);
  });

  it("坏 JSON 中段行 → failure（type 宽松提取）", async () => {
    const teamDir = under(dir, "badjson");
    fs.mkdirSync(teamDir, { recursive: true });
    const good = JSON.stringify({ seq: 1, ts: "t", writer: "b:1", event: memberEvent({ id: "a1", name: "w1" }) });
    const bad = '{"seq":2,"ts":"t","writer":"b:1","event":{"type":"team/member", BROKEN';
    fs.writeFileSync(path.join(teamDir, "events.jsonl"), `${good}\n${bad}\n`);
    const loaded = await load(teamDir, TEAM_ID);
    expect(loaded.state.failure).toBe("persisted Agent Teams team/member payload is invalid");
    expect(loaded.corrupt?.reason).toBe("invalid JSON");
  });

  it("seq 断号 → corrupt（行形状/连续性）", async () => {
    const teamDir = writeLines("seqjump", [
      { seq: 1, event: memberEvent({ id: "a1", name: "w1" }) },
      { seq: 3, event: memberEvent({ id: "a1", name: "w1", phase: "active" }) },
    ]);
    const loaded = await load(teamDir, TEAM_ID);
    expect(loaded.corrupt?.reason).toBe("line shape invalid or seq discontinuous");
    expect(loaded.state.failure).toBeDefined();
  });

  it("合法 JSON 但域 schema 违规 → 第一轮投影逐字 failure（C9 消息）", async () => {
    const teamDir = writeLines("schemabad", [
      { seq: 1, event: { ...memberEvent({ id: "a1", name: "w1" }), member: { id: "a1" } } },
    ]);
    const loaded = await load(teamDir, TEAM_ID);
    expect(loaded.state.failure).toBe("persisted Agent Teams team/member payload is invalid");
  });
});

describe("replay · checkpoint（F32 前置）", () => {
  it("命中：版本匹配 → 增量（fromCheckpoint=true），结果与全量一致", async () => {
    const events = [
      memberEvent({ id: "a1", name: "w1", phase: "provisioning" }),
      memberEvent({ id: "a1", name: "w1", phase: "active" }),
    ];
    const teamDir = writeLines("ckpt-hit", events.map((event, i) => ({ seq: i + 1, event })));
    const full = await load(teamDir, TEAM_ID);
    await writeCheckpoint(teamDir, { state: full.state, view: full.view, seq: full.seq });
    // 追加第 3 行（模拟 checkpoint 后的新事件）
    fs.appendFileSync(
      path.join(teamDir, "events.jsonl"),
      JSON.stringify({ seq: 3, ts: "t", writer: "b:1", event: queuedEvent({ id: "m1", targetId: "a1" }) }) + "\n",
    );
    const loaded = await load(teamDir, TEAM_ID);
    expect(loaded.fromCheckpoint).toBe(true);
    expect(loaded.seq).toBe(3);
    // 与无 checkpoint 全量重放对照
    fs.unlinkSync(checkpointPath(teamDir));
    const fullReplay = await load(teamDir, TEAM_ID);
    expect(fullReplay.fromCheckpoint).toBe(false);
    expect(fullReplay.state).toEqual(loaded.state);
  });

  it("版本不匹配 / 损坏 / teamId 不符 / 偏移脱同步 → 忽略并全量重放", async () => {
    const events = [memberEvent({ id: "a1", name: "w1", phase: "provisioning" })];
    const tampers: Array<[string, (doc: Record<string, unknown>) => void]> = [
      ["version", (doc) => (doc.stateVersion = 99)],
      ["teamid", (doc) => ((doc.state as Record<string, unknown>).id = "sess-other")],
      ["offset", (doc) => (doc.lastOffset = 1)],
    ];
    for (const [name, tamper] of tampers) {
      const teamDir = writeLines(`ckpt-${name}`, events.map((event, i) => ({ seq: i + 1, event })));
      const full = await load(teamDir, TEAM_ID);
      await writeCheckpoint(teamDir, { state: full.state, view: full.view, seq: full.seq });
      const rawDoc = JSON.parse(fs.readFileSync(checkpointPath(teamDir), "utf8")) as Record<string, unknown>;
      tamper(rawDoc);
      fs.writeFileSync(checkpointPath(teamDir), JSON.stringify(rawDoc));
      const loaded = await load(teamDir, TEAM_ID);
      expect(loaded.fromCheckpoint, name).toBe(false);
      expect(loaded.checkpointIgnored, name).toBeTruthy();
      expect(loaded.seq, name).toBe(1);
      expect(loaded.state.members, name).toHaveLength(1);
    }
    // checkpoint 整体坏 JSON
    const teamDir = writeLines("ckpt-corrupt", events.map((event, i) => ({ seq: i + 1, event })));
    const full = await load(teamDir, TEAM_ID);
    await writeCheckpoint(teamDir, { state: full.state, view: full.view, seq: full.seq });
    fs.writeFileSync(checkpointPath(teamDir), "<<<not json>>>");
    const loaded = await load(teamDir, TEAM_ID);
    expect(loaded.fromCheckpoint).toBe(false);
    expect(loaded.seq).toBe(1);
  });

  it("checkpoint 帧形状：kind/stateVersion=4/lastSeq/lastOffset/savedAt/state/view（§5 同构 + 外层游标）", async () => {
    const events = [memberEvent({ id: "a1", name: "w1", phase: "provisioning" })];
    const teamDir = writeLines("ckpt-shape", events.map((event, i) => ({ seq: i + 1, event })));
    const full = await load(teamDir, TEAM_ID);
    await writeCheckpoint(teamDir, { state: full.state, view: full.view, seq: full.seq });
    const doc = JSON.parse(fs.readFileSync(checkpointPath(teamDir), "utf8")) as Record<string, unknown>;
    expect(doc.kind).toBe("agent-team-checkpoint");
    expect(doc.stateVersion).toBe(4);
    expect(doc.lastSeq).toBe(1);
    expect(doc.lastOffset).toBeGreaterThan(0);
    expect(typeof doc.savedAt).toBe("string");
    expect((doc.state as Record<string, unknown>).id).toBe(TEAM_ID);
    expect(doc.view).toMatchObject({ members: expect.any(Array) });
  });
});
