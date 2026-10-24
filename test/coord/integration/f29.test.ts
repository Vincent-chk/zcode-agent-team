// F29 演练（真实子进程 fixture daemon；数据根 os.tmpdir()）：
//   ① kill -9 接任（≤5s；重放 {state,view} 与 kill 前一致；未 delivered 的 queued 完整可枚举）
//   ② 宿主回收序列（H10：SIGINT → ~269ms escalate；SIGINT 后退出耗时对照 ≤200ms 预算；冷启动一致）
//   ③ 缺位窗口写请求 → TEAM_DISPOSED 临时错误 + 重试指引 → 接任后成功
//   ④ 释放双路径：正常退出（exit handler 立即释放）与 SIGKILL（锁残留 → 心跳过期接任）
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnDaemon, killDaemon } from "../fixture/daemon-kit.js";
import { load } from "../../../src/coord/replay.js";
import {
  callCoordinator,
  callWithRetry,
  COORDINATOR_UNAVAILABLE_MESSAGE,
} from "../../../src/coord/rpc.js";
import { safeTeamId } from "../../../src/coord/paths.js";
import { TeamError } from "../../../src/domain/errors.js";

const evidence: Array<Record<string, unknown>> = [];
let rootBase: string;
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

function baseOps(teamId: string): unknown[] {
  return [
    { type: "team/member", version: 2, teamId, member: { id: "m1", name: "worker", description: "d", provider: "spawn", context: "fresh", phase: "provisioning" } },
    { type: "team/member", version: 2, teamId, member: { id: "m1", name: "worker", description: "d", provider: "spawn", context: "fresh", phase: "active" } },
    { type: "team/message/queued", version: 2, teamId, message: { id: "msg-1", senderId: teamId, senderName: "lead", targetId: "m1", content: [{ type: "text", text: "hello" }] } },
    { type: "team/message/queued", version: 2, teamId, message: { id: "msg-2", senderId: "m1", senderName: "worker", targetId: teamId, content: [{ type: "text", text: "reply" }] } },
  ];
}

function extraTask(teamId: string, n: number): unknown {
  return { type: "team/task", version: 2, teamId, task: { id: `task-${n}`, revision: 1, subject: "s", description: "d", status: "pending", blockedBy: [], writeScopes: [] } };
}

function teamDirOf(root: string, teamId: string): string {
  return under(under(root, "teams"), safeTeamId(teamId));
}

beforeAll(() => {
  rootBase = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-f29-"));
  const evidenceDir = under(fs.realpathSync(os.tmpdir()), "at-stage2-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  evidenceFile = path.join(evidenceDir, "f29.json");
});

afterAll(() => {
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
  // maxRetries：失败早退路径可能遗留孤儿 daemon 心跳写盘竞态（macOS ENOTEMPTY）
  fs.rmSync(rootBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function record(name: string, data: Record<string, unknown>): void {
  evidence.push({ scenario: name, ...data });
  console.log(`[f29] ${name}: ${JSON.stringify(data)}`);
}

describe("F29 · kill -9 接任（场景 1）", () => {
  // retry：时序预算断言（≤5s/≤250ms）在套件级 CPU 负载下有瞬态抖动——断言不变，仅对瞬态重跑
  it("≤5s 接任；重放 state/view 与 kill 前一致；queued 未投递完整可枚举", { timeout: 30_000, retry: 2 }, async () => {
    const root = under(rootBase, `s1-${attemptTag()}`); // retry 隔离
    const team = "sess_f29_s1";
    const teamDir = teamDirOf(root, team);
    const a = await spawnDaemon({ root, team, ops: baseOps(team) });
    await a.waitFor("ready");
    // 写路径经协调者 socket（RPC 代理变更）；ops（4 条）与本追加共用 journal 尾链 → seq 确定
    const appended = await callCoordinator<{ seq: number }>(teamDir, team, "team.append", {
      event: extraTask(team, 1),
    });
    expect(appended.seq).toBe(5);

    const pre = await load(teamDir, team);
    const preQueued = pre.state.messages
      .filter((m) => !pre.state.delivered.includes(m.id))
      .map((m) => m.id);

    const b = await spawnDaemon({ root, team });
    await new Promise((r) => setTimeout(r, 300)); // b 进入抢锁轮询
    const t0 = Date.now();
    killDaemon(a, "SIGKILL");
    await a.exited;
    const readyB = await b.waitFor("ready", 8_000);
    const takeoverMs = Date.now() - t0;
    expect(takeoverMs).toBeLessThanOrEqual(5_000);

    const post = await load(teamDir, team);
    expect(JSON.stringify(post.state)).toBe(JSON.stringify(pre.state));
    expect(JSON.stringify(post.view)).toBe(JSON.stringify(pre.view));
    // 未 delivered 的 queued 完整可枚举（真实续投 = 第三轮 mailbox；本轮到可枚举为止——降级边界见交付说明）
    const postQueued = post.state.messages
      .filter((m) => !post.state.delivered.includes(m.id))
      .map((m) => m.id);
    expect(postQueued).toEqual(preQueued);
    expect(postQueued).toContain("msg-1");
    expect(postQueued).toContain("msg-2");

    killDaemon(b, "SIGINT");
    await b.exited;
    record("kill9-takeover", { takeoverMs, readySeq: readyB.seq, queuedPending: postQueued });
  });
});

describe("F29 · 宿主回收序列（场景 2，H10：SIGINT → ~269ms escalate）", () => {
  it("SIGINT 后 ≤250ms 退出（预算 200ms）+ 锁即释；escalate 序列模拟；冷启动全量一致", { timeout: 30_000, retry: 2 }, async () => {
    const root = under(rootBase, `s2-${attemptTag()}`); // retry 隔离
    const team = "sess_f29_s2";
    const teamDir = teamDirOf(root, team);
    const a = await spawnDaemon({ root, team, ops: baseOps(team), holdMs: 60_000 });
    await a.waitFor("ready");
    await a.waitFor("workload-done"); // 基线落盘完成后再取快照
    const pre = await load(teamDir, team);

    const t0 = Date.now();
    killDaemon(a, "SIGINT");
    const exitDone = a.exited;
    // H10 escalate：269ms 后仍未退则 SIGTERM（正常应远早于此）
    const escalate = setTimeout(() => {
      try {
        killDaemon(a, "SIGTERM");
      } catch {
        /* 已退出 */
      }
    }, 269);
    await exitDone;
    clearTimeout(escalate);
    const exitMs = Date.now() - t0;
    expect(exitMs).toBeLessThanOrEqual(250);
    expect(fs.existsSync(path.join(teamDir, "coordinator.lock"))).toBe(false); // 双路径 ①：exit handler 立即释放
    expect(fs.existsSync(path.join(teamDir, "socket.path"))).toBe(false);

    const c = await spawnDaemon({ root, team }); // 冷启动（全新进程、全量重放）
    await c.waitFor("ready", 10_000);
    const post = await load(teamDir, team);
    expect(JSON.stringify(post.state)).toBe(JSON.stringify(pre.state));
    killDaemon(c, "SIGINT");
    await c.exited;
    record("host-recycle", { exitMsAfterSigint: exitMs, budgetMs: 200, escalateDelayMs: 269 });
  });
});

describe("F29 · 缺位窗口写请求（场景 3）", () => {
  it("协调者 SIGKILL 后立即写 → TEAM_DISPOSED 临时错误；按指引重试 → 接任后成功", { timeout: 30_000 }, async () => {
    const root = under(rootBase, `s3-${attemptTag()}`); // retry 隔离
    const team = "sess_f29_s3";
    const teamDir = teamDirOf(root, team);
    const a = await spawnDaemon({ root, team, ops: baseOps(team), holdMs: 60_000 });
    await a.waitFor("ready");
    await a.waitFor("workload-done"); // 基线 4 条全部落盘（ready 先于 ops，必须等完成）

    killDaemon(a, "SIGKILL");
    await a.exited;
    const t0 = Date.now();
    // 锁未过期（心跳新鲜）且 socket 已死 → 缺位窗口
    const first = await callCoordinator(teamDir, team, "team.append", { event: extraTask(team, 1) }).catch(
      (e: Error) => e,
    );
    expect(first).toBeInstanceOf(TeamError);
    expect((first as TeamError).code).toBe("TEAM_DISPOSED");
    expect((first as TeamError).message).toBe(COORDINATOR_UNAVAILABLE_MESSAGE);
    const firstErrorMs = Date.now() - t0;

    const b = await spawnDaemon({ root, team }); // 触发接任
    let retries = 0;
    const result = await callWithRetry(
      () => callCoordinator<{ seq: number }>(teamDir, team, "team.append", { event: extraTask(team, 2) }),
      { deadlineMs: 9_000, baseMs: 200, maxMs: 800, onRetry: () => (retries += 1) },
    );
    expect(result.seq).toBe(5); // 4 基线 + task-2（task-1 缺位期被拒、未落盘）
    const retryMs = Date.now() - t0;
    killDaemon(b, "SIGINT");
    await b.exited;
    record("absence-window", { firstErrorMs, retryMs, retries });
  });
});

describe("F29 · 释放双路径（场景 4）", () => {
  it("① 正常退出：hold 到期自行退出 → 锁与 socket 立即清理", { timeout: 20_000 }, async () => {
    const root = under(rootBase, `s4a-${attemptTag()}`); // retry 隔离
    const team = "sess_f29_s4a";
    const teamDir = teamDirOf(root, team);
    const a = await spawnDaemon({ root, team, ops: baseOps(team), holdMs: 400 });
    await a.waitFor("ready");
    await a.exited;
    expect(fs.existsSync(path.join(teamDir, "coordinator.lock"))).toBe(false);
    expect(fs.existsSync(path.join(teamDir, "coordinator.sock"))).toBe(false);
    record("release-path-exit-handler", { lockCleaned: true, socketCleaned: true });
  });

  it("② SIGKILL：锁残留（过期兜底前提）→ 接任者 ≤5s 内经心跳过期接管", { timeout: 30_000, retry: 2 }, async () => {
    const root = under(rootBase, `s4b-${attemptTag()}`); // retry 隔离
    const team = "sess_f29_s4b";
    const teamDir = teamDirOf(root, team);
    const a = await spawnDaemon({ root, team, ops: baseOps(team), holdMs: 60_000 });
    await a.waitFor("ready");
    const b = await spawnDaemon({ root, team });
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    killDaemon(a, "SIGKILL");
    await a.exited;
    expect(fs.existsSync(path.join(teamDir, "coordinator.lock"))).toBe(true); // 残留 = 兜底路径前提
    await b.waitFor("ready", 8_000);
    const takeoverMs = Date.now() - t0;
    expect(takeoverMs).toBeLessThanOrEqual(5_000);
    killDaemon(b, "SIGINT");
    await b.exited;
    record("release-path-heartbeat-expiry", { takeoverMs, lockLingeredAfterSigkill: true });
  });
});
