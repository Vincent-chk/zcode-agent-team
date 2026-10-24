// 服务层 × 真 journal 集成（数据根 os.tmpdir()）：
//   ① 「一切内存态皆可丢弃」：跑剧本 → 丢弃实例 → 重放重建 → 状态/行为一致；
//   ② 崩溃点 delivered:before/after（F18 kill 点）：恰一次交付；
//   ③ F29 升级补测：未 delivered 的 queued 获得真实续投语义（恢复后投递完成且不重复）。
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JournalTeamStore } from "../../../src/coord/store-adapter.js";
import type { JournalOptions, CrashPoint } from "../../../src/coord/journal.js";
import { TeamRuntime } from "../../../src/domain/runtime.js";
import { MockProvider } from "../../../src/provider/mock-provider.js";
import { validateTeamLimits } from "../../../src/domain/config.js";
import { teamPaths, ensureTeamDir } from "../../../src/coord/paths.js";
import { CoordinatorLock } from "../../../src/coord/lock.js";
import { load } from "../../../src/coord/replay.js";
import { writerId } from "../../../src/coord/identity.js";

const TEAM = "sess_it_journal";
const LIMITS = validateTeamLimits({
  maxMembers: 8,
  maxTasks: 256,
  maxMessageBytes: 65536,
  disposalTimeoutMs: 5000,
});
const TEXT = [{ type: "text", text: "hello" }];

let root: string;
const evidence: Record<string, unknown> = {};

function under(r: string, name: string): string {
  const p = path.join(r, name);
  if (!path.resolve(p).startsWith(path.resolve(r) + path.sep)) throw new Error("escape");
  return p;
}

function caseRoot(name: string): string {
  const dir = under(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function openRuntime(provider: MockProvider, journalOpts: JournalOptions = {}, teamRoot?: string) {
  const store = await JournalTeamStore.open(teamRoot ?? root, TEAM, { journal: journalOpts });
  const runtime = new TeamRuntime({ teamId: TEAM, store, provider, limits: LIMITS, presentation: provider });
  return { store, runtime };
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "at-svc-it-"));
});
afterAll(() => {
  const dir = under(fs.realpathSync(os.tmpdir()), "at-stage2-evidence");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "services-journal.json"), JSON.stringify(evidence, null, 2));
  fs.rmSync(root, { recursive: true, force: true });
});

describe("服务 × journal · 丢弃重建（一切内存态皆可丢弃）", () => {
  it("剧本 → 丢弃 → 重放重建 → 状态/行为一致", { timeout: 30_000 }, async () => {
    const provider = new MockProvider();
    const teamRoot = caseRoot("rebuild");
    const first = await openRuntime(provider, {}, teamRoot);
    await first.runtime.roster.spawnTeammate(TEAM, { name: "worker", description: "d", prompt: "p" });
    await first.runtime.taskboard.create(TEAM, { subject: "s1", description: "d" });
    const sent = await first.runtime.mailbox.send(TEAM, { target: "worker", content: [...TEXT] });
    expect(sent.messageId).toMatch(/^team-message-/);
    const canonical = JSON.stringify((await load(teamPaths(teamRoot, TEAM).teamDir, TEAM)).state);
    await first.runtime.dispose();
    await first.store.close();
    first.runtime.close();

    // 丢弃一切内存态：全新 store（冷启动重放）+ 全新 runtime
    const second = await openRuntime(provider, {}, teamRoot);
    await second.runtime.recoverAll();
    const rebuilt = await load(teamPaths(teamRoot, TEAM).teamDir, TEAM);
    expect(JSON.stringify(rebuilt.state)).toBe(canonical);
    // 行为一致：重建后继续操作（seq 续进、无重复）
    const next = await second.runtime.taskboard.create(TEAM, { subject: "s2", description: "d" });
    expect(next.task.id).toBe("task-2");
    const members = second.runtime.roster.listMembers(TEAM).members;
    expect(members.map((m) => m.target)).toEqual(["lead", "worker"]);
    await second.runtime.dispose();
    await second.store.close();
    second.runtime.close();
    evidence.discardRebuild = { consistent: true };
  });
});

describe("服务 × journal · delivered 崩溃点（F18 kill 点，恰一次）", () => {
  async function runCrashCase(point: CrashPoint): Promise<void> {
    const provider = new MockProvider();
    const teamRoot = caseRoot(`crash-${point}`);
    const { store, runtime } = await openRuntime(provider, {
      crashHook: (p, ctx) => {
        // 第 4 次追加 = delivered 事件（1 provisioning / 2 active / 3 queued / 4 delivered）
        if (ctx.seq === 4 && p === point) throw new Error(`injected:${point}`);
      },
    }, teamRoot);
    await runtime.roster.spawnTeammate(TEAM, { name: "worker", description: "d", prompt: "p" });
    const sent = await runtime.mailbox.send(TEAM, { target: "worker", content: [...TEXT] });
    const deliverCallsAtCrash = provider.deliverCalls; // = 1（accepted，received 已记录）
    expect(deliverCallsAtCrash).toBe(1);
    // 「重启」：关闭被注入的实例 → 全新 store/runtime（同一 provider 桩 = 持久化子会话仍在）
    await store.close();
    runtime.close();
    const second = await openRuntime(provider, {}, teamRoot);
    await second.runtime.recoverAll();
    const state = second.store.state();
    if (point === "append:before") {
      // delivered 未落盘 → 恢复经去重路径补记，恰一次（无第二次 deliver）
      expect(state.messages).toHaveLength(1);
      expect(state.delivered).toHaveLength(1);
      expect(provider.deliverCalls).toBe(1);
      expect(sent.messageId).toMatch(/^team-message-/); // 〔对齐轮〕结果无 status：投递状态为内部适配层
    } else if (point === "fsync:after") {
      // delivered 已落盘 → 恢复后无 pending，不重投
      expect(state.delivered).toHaveLength(1);
      expect(provider.deliverCalls).toBe(1);
    }
    evidence[`crash-${point}`] = {
      deliverCalls: provider.deliverCalls,
      delivered: state.delivered.length,
      messages: state.messages.length,
      verdict: "exactly-once",
    };
    await second.runtime.dispose();
    await second.store.close();
    second.runtime.close();
  }

  it("delivered:before（追加前崩）：已收未记 → 恢复去重补记，恰一次", { timeout: 30_000 }, async () => {
    await runCrashCase("append:before");
  });

  it("delivered:after（fsync 后崩）：已收已记 → 恢复不重投", { timeout: 30_000 }, async () => {
    await runCrashCase("fsync:after");
  });

  it("F29 升级：未 delivered 的 queued 在新协调者下获得真实续投（投递完成、无重复）", { timeout: 30_000 }, async () => {
    const provider = new MockProvider();
    const teamRoot = caseRoot("f29-upgrade");
    const { store, runtime } = await openRuntime(provider, {}, teamRoot);
    await runtime.roster.spawnTeammate(TEAM, { name: "worker", description: "d", prompt: "p" });
    const workerId = [...provider.teamChildren.keys()][0];
    provider.killChild(workerId); // 目标冷 + 默认保守 → 滞留 queued
    const sent = await runtime.mailbox.send(TEAM, { target: "worker", content: [...TEXT] });
    expect(store.state().delivered).toHaveLength(0); // 〔对齐轮〕滞留：结果无 status，按 delivered 判定
    await store.close();
    runtime.close();

    // 接任协调者：成员苏醒（alive）→ 冷启动恢复 → 真实续投
    provider.reviveChild(workerId);
    const successor = await openRuntime(provider, {}, teamRoot);
    await successor.runtime.recoverAll();
    const state = successor.store.state();
    expect(state.delivered).toHaveLength(1); // 续投完成
    expect(provider.deliverCalls).toBeGreaterThanOrEqual(1);
    expect(provider.teamChildren.get(workerId)?.deliverCount.get(sent.messageId)).toBe(1); // 恰一次
    const inbox = provider.teamChildren.get(workerId)?.received.has(sent.messageId);
    expect(inbox).toBe(true);
    evidence.f29Upgrade = { status: "delivered-after-succession", exactlyOnce: true };
    await successor.runtime.dispose();
    await successor.store.close();
    successor.runtime.close();
  });
});
