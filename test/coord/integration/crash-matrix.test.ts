// H：崩溃注入矩阵（本轮子集 ≥6 点）+ 接管中 + 随机杀。
// 每点断言：重启重放状态一致；行级原子（无半行落盘）；已应答 ⇒ 必已落盘；未应答可丢（重试语义）。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnDaemon, killDaemon } from "../fixture/daemon-kit.js";
import { load } from "../../../src/coord/replay.js";
import type { LoadedTeam } from "../../../src/coord/replay.js";
import { buildTeamProjection } from "../../../src/domain/projection.js";
import { safeTeamId } from "../../../src/coord/paths.js";

let rootBase: string;
const evidence: Array<Record<string, unknown>> = [];
let evidenceFile: string;

function under(root: string, name: string): string {
  const p = path.join(root, name);
  if (!path.resolve(p).startsWith(path.resolve(root) + path.sep)) throw new Error("escape");
  return p;
}

/** retry 隔离：每次尝试用唯一 case 目录（失败重试不重放旧 journal/锁，retry 才能生效）。 */
function attemptTag(): string {
  return Math.random().toString(36).slice(2, 8);
}

function teamDirOf(root: string, teamId: string): string {
  return under(under(root, "teams"), safeTeamId(teamId));
}

/** 生成 n 组合法事件（member provisioning+active + 2 条消息），返回全部事件数组。 */
function genOps(teamId: string, groups: number): unknown[] {
  const ops: unknown[] = [];
  for (let i = 0; i < groups; i++) {
    const m = `m${i}`;
    ops.push({ type: "team/member", version: 2, teamId, member: { id: m, name: `w${i}`, description: "d", provider: "spawn", context: "fresh", phase: "provisioning" } });
    ops.push({ type: "team/member", version: 2, teamId, member: { id: m, name: `w${i}`, description: "d", provider: "spawn", context: "fresh", phase: "active" } });
    ops.push({ type: "team/message/queued", version: 2, teamId, message: { id: `msg-a${i}`, senderId: teamId, senderName: "lead", targetId: m, content: [{ type: "text", text: "x" }] } });
    ops.push({ type: "team/message/delivered", version: 2, teamId, messageId: `msg-a${i}`, targetId: m });
  }
  return ops;
}

/** 行级原子断言：每行完整 JSON、seq 从 1 连续。 */
async function assertJournalHealthy(teamDir: string, teamId: string): Promise<LoadedTeam> {
  const raw = fs.readFileSync(path.join(teamDir, "events.jsonl"), "utf8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  for (let i = 0; i < lines.length; i++) {
    const parsed = JSON.parse(lines[i]) as { seq: number }; // 半行/坏 JSON 会在 parse 抛出
    expect(parsed.seq, `line ${i + 1} seq continuity`).toBe(i + 1);
  }
  const loaded = await load(teamDir, teamId);
  expect(loaded.corrupt, "replay must not report corruption").toBeUndefined();
  return loaded;
}

beforeAll(() => {
  rootBase = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-crash-"));
  const evidenceDir = under(fs.realpathSync(os.tmpdir()), "at-stage2-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  evidenceFile = path.join(evidenceDir, "crash-matrix.json");
});
afterAll(() => {
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
  // maxRetries：失败早退路径可能遗留孤儿 daemon 心跳写盘竞态（macOS ENOTEMPTY）
  fs.rmSync(rootBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("H · 崩溃注入矩阵（5 点，crash-on-seq=5，基线 ops=8 条）", () => {
  const points: Array<[string, number, number]> = [
    // [point, 最小落盘 seq, 最大落盘 seq]（未应答可丢：write 未发生=4；发生后=5）
    ["append:before", 4, 4],
    ["append:after", 4, 5],
    ["fsync:before", 4, 5],
    ["fsync:after", 5, 5],
    ["ack:before", 5, 5],
  ];
  for (const [point, minSeq, maxSeq] of points) {
    it(`${point}：kill 于第 5 条 → 落盘 seq ∈ [${minSeq},${maxSeq}]，行原子，重放=前缀 fold，续写可继续`, { timeout: 30_000 }, async () => {
      const team = `sess_crash_${point.replace(":", "-")}`;
      const root = under(rootBase, point.replace(":", "-"));
      const ops = genOps(team, 2); // 8 条
      const acked: number[] = [];
      const daemon = await spawnDaemon({ root, team, ops, crashAt: point, crashOnSeq: 5 });
      for (const ev of daemon.events) {
        if (ev.type === "appended") acked.push(ev.seq as number);
      }
      // 等 crash 或跑完（crash 注入必触发）
      const outcome = await Promise.race([daemon.exited, daemon.waitFor("crash", 15_000).then(() => daemon.exited)]);
      expect(outcome.signal).toBe("SIGKILL");
      // 收集 crash 前已 ack 的 seq（events 快照可能滞后，重读事件流）
      for (const ev of daemon.events) {
        if (ev.type === "appended") acked.push(ev.seq as number);
      }
      const maxAcked = Math.max(0, ...acked);

      const teamDir = teamDirOf(root, team);
      const loaded = await assertJournalHealthy(teamDir, team);
      expect(loaded.seq).toBeGreaterThanOrEqual(minSeq);
      expect(loaded.seq).toBeLessThanOrEqual(maxSeq);
      expect(maxAcked).toBeLessThanOrEqual(loaded.seq); // 已应答 ⇒ 必已落盘
      expect(loaded.state).toEqual(buildTeamProjection(ops.slice(0, loaded.seq), team));

      // 续写可继续（接任者冷启动 + 剩余 ops）
      const rest = ops.slice(loaded.seq);
      if (rest.length > 0) {
        const successor = await spawnDaemon({ root, team, ops: rest });
        const ready = await successor.waitFor("ready", 10_000);
        void ready;
        await successor.waitFor("workload-done", 15_000);
        const final = await assertJournalHealthy(teamDirOf(root, team), team);
        expect(final.seq).toBe(ops.length);
        expect(final.state).toEqual(buildTeamProjection(ops, team));
        killDaemon(successor, "SIGINT");
        await successor.exited;
      }
      evidence.push({ point: `${point}@5`, persistedSeq: loaded.seq, maxAcked, outcome: "recovered" });
      console.log(`[crash-matrix] ${point}@5: persisted=${loaded.seq} maxAcked=${maxAcked} → recovered`);
    });
  }
});

describe("H · 接管中（workload 中途 kill -9 协调者 → standby 接任续写）", () => {
  it("20 条慢速 workload 杀于中段 → 接任 ≤5s → 剩余续写 → 终态 = 全量参考", { timeout: 60_000, retry: 2 }, async () => {
    const team = "sess_crash_takeover";
    const root = under(rootBase, `takeover-${attemptTag()}`); // retry 隔离
    const ops = genOps(team, 5); // 20 条
    const a = await spawnDaemon({ root, team, ops, opDelayMs: 40 });
    await a.waitFor("ready");
    const b = await spawnDaemon({ root, team });
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 350)); // workload 进行中（约第 8-9 条）
    killDaemon(a, "SIGKILL");
    await a.exited;
    const readyB = await b.waitFor("ready", 8_000);
    const takeoverMs = Date.now() - t0;
    expect(takeoverMs).toBeLessThanOrEqual(5_000);
    void readyB;

    // 接任者按当前 seq 续写剩余（从重放 seq 起截取）
    const teamDir = teamDirOf(root, team);
    const mid = await load(teamDir, team);
    expect(mid.corrupt).toBeUndefined();
    const rest = ops.slice(mid.seq);
    killDaemon(b, "SIGINT");
    await b.exited;
    const c = await spawnDaemon({ root, team, ops: rest });
    await c.waitFor("workload-done", 20_000);
    const final = await assertJournalHealthy(teamDir, team);
    expect(final.seq).toBe(ops.length);
    expect(final.state).toEqual(buildTeamProjection(ops, team));
    killDaemon(c, "SIGINT");
    await c.exited;
    evidence.push({ point: "takeover-mid", takeoverMs, persistedSeqAtTakeover: mid.seq, finalSeq: final.seq, outcome: "recovered" });
    console.log(`[crash-matrix] takeover-mid: takeover=${takeoverMs}ms seqAtTakeover=${mid.seq} final=${final.seq}`);
  });
});

describe("H · 随机杀 ×3 轮（workload 循环内随机时点 SIGKILL）", () => {
  it("每轮杀后重放健康、可续写；三轮终态 = 全量参考", { timeout: 90_000 }, async () => {
    const team = "sess_crash_random";
    const root = under(rootBase, `random-${attemptTag()}`); // retry 隔离
    const ops = genOps(team, 8); // 32 条
    const teamDir = teamDirOf(root, team);
    let cursor = 0;
    for (let round = 1; round <= 3; round++) {
      const daemon = await spawnDaemon({ root, team, ops: ops.slice(cursor), opDelayMs: 25 });
      await daemon.waitFor("ready", 10_000);
      await new Promise((r) => setTimeout(r, 80 + Math.floor(Math.random() * 350)));
      killDaemon(daemon, "SIGKILL");
      await daemon.exited;
      const loaded = await assertJournalHealthy(teamDir, team);
      expect(loaded.seq).toBeGreaterThanOrEqual(cursor); // 至少未回退
      cursor = loaded.seq;
      evidence.push({ point: `random-kill-r${round}`, persistedSeq: cursor, outcome: "healthy" });
      console.log(`[crash-matrix] random-kill round ${round}: persisted=${cursor}`);
      if (cursor < ops.length && round < 3) continue;
      if (cursor < ops.length) {
        // 最后一轮必须续完
        const fin = await spawnDaemon({ root, team, ops: ops.slice(cursor) });
        await fin.waitFor("workload-done", 20_000);
        killDaemon(fin, "SIGINT");
        await fin.exited;
      }
      break;
    }
    const final = await assertJournalHealthy(teamDir, team);
    expect(final.seq).toBe(ops.length);
    expect(final.state).toEqual(buildTeamProjection(ops, team));
  });
});
