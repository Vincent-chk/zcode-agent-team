// Activity + Lifecycle 测试（02 §8/§12；F28/F30 + C2/C7/D9）。消息逐字；fake clock 不依赖真实等待。
import { describe, expect, it } from "vitest";
import { TeamError } from "../../src/domain/errors.js";
import { TeamActivity } from "../../src/domain/activity.js";
import { TeamLifecycle, isCancellation } from "../../src/domain/lifecycle.js";
import { MemoryTeamStore } from "../../src/domain/ports.js";
import type { Clock } from "../../src/domain/ports.js";
import { applyProjectionEvent, emptyTeamState } from "../../src/domain/projection.js";
import { buildKit, TEAM } from "../services/kit.js";
import { memberEvent, queuedEvent } from "./helpers.js";

const LEAD = TEAM;

/** 手动推进的假时钟：sleep 挂起直到 advance() 触发对应定时。 */
class FakeClock implements Clock {
  private timers: Array<{ due: number; resolve: () => void }> = [];
  private nowMs = 0;
  now(): number {
    return this.nowMs;
  }
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timers.push({ due: this.nowMs + ms, resolve });
    });
  }
  async advance(ms: number): Promise<void> {
    this.nowMs += ms;
    const due = this.timers.filter((t) => t.due <= this.nowMs);
    this.timers = this.timers.filter((t) => t.due > this.nowMs);
    for (const t of due) t.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

function activityWith(clock: FakeClock): { activity: TeamActivity; store: MemoryTeamStore; unbind: () => void } {
  const store = new MemoryTeamStore(applyProjectionEvent, emptyTeamState(LEAD));
  const activity = new TeamActivity({ store, clock });
  const unbind = activity.bindCommitEdge();
  return { activity, store, unbind };
}

describe("Activity · waitForChange（F28）", () => {
  it("timeout 范围校验逐字；C7 顺序：timeout 校验 → throwIfAborted → closed", async () => {
    const { activity } = activityWith(new FakeClock());
    for (const bad of [9_999, 3_600_001, 1.5]) {
      await expect(activity.waitForChange(LEAD, bad)).rejects.toMatchObject({
        code: "TEAM_INVALID_TIMEOUT",
        message: "timeoutMs must be an integer from 10000 through 3600000",
      });
    }
    // C7①：已中止 signal + 非法 timeout → timeout 错误优先
    const ac = new AbortController();
    ac.abort(new Error("early"));
    await expect(activity.waitForChange(LEAD, 5, ac.signal)).rejects.toMatchObject({
      code: "TEAM_INVALID_TIMEOUT",
    });
    // C7②：已中止 signal + closed → 抛 reason（closed 检查在后）
    const ac2 = new AbortController();
    ac2.abort(new Error("early-again"));
    activity.closeAll();
    await expect(activity.waitForChange(LEAD, 30_000, ac2.signal)).rejects.toMatchObject({
      message: "early-again",
    });
  });

  it("注册后的日志提交边与成员状态边各唤醒恰一次；timedOut 只经超时", async () => {
    const clock = new FakeClock();
    const { activity, store } = activityWith(clock);
    const wait1 = activity.waitForChange(LEAD, 30_000);
    await Promise.resolve();
    await store.append(memberEvent({ id: "m1", name: "w1" }, LEAD)); // 提交边
    expect(await wait1).toEqual({ timedOut: false });
    const wait2 = activity.waitForChange(LEAD, 30_000);
    await Promise.resolve();
    activity.notifyMemberStatus(); // 成员状态边
    expect(await wait2).toEqual({ timedOut: false });
    const wait3 = activity.waitForChange(LEAD, 10_000);
    await Promise.resolve();
    await store.append(queuedEvent({ id: "msg-1", targetId: "m1" }, LEAD));
    const raceWinner = await Promise.race([wait3, clock.advance(10_000).then(() => "timeout" as const)]);
    void raceWinner; // wait3 已被提交边唤醒
    expect(await wait3).toEqual({ timedOut: false });
    // 真超时路径
    const wait4 = activity.waitForChange(LEAD, 10_000);
    await clock.advance(10_000);
    expect(await wait4).toEqual({ timedOut: true });
  });

  it("取消：Error 原样抛；非 Error → TEAM_WAIT_ABORTED 逐字", async () => {
    const { activity } = activityWith(new FakeClock());
    const ac1 = new AbortController();
    const w1 = activity.waitForChange(LEAD, 30_000, ac1.signal);
    await Promise.resolve();
    const reason = new Error("caller cancelled");
    ac1.abort(reason);
    await expect(w1).rejects.toBe(reason);
    const ac2 = new AbortController();
    const w2 = activity.waitForChange(LEAD, 30_000, ac2.signal);
    await Promise.resolve();
    ac2.abort("boom");
    await expect(w2).rejects.toMatchObject({
      code: "TEAM_WAIT_ABORTED",
      message: "wait_agent aborted: boom",
    });
  });

  it("处置 close：唤醒全部等待者；closed 后新等待立即返回 {timedOut:false}", async () => {
    const { activity } = activityWith(new FakeClock());
    const w1 = activity.waitForChange(LEAD, 30_000);
    const w2 = activity.waitForChange(LEAD, 30_000);
    await Promise.resolve();
    activity.closeAll();
    expect(await w1).toEqual({ timedOut: false });
    expect(await w2).toEqual({ timedOut: false });
    expect(await activity.waitForChange(LEAD, 30_000)).toEqual({ timedOut: false });
  });

  it("非成员等待 → TEAM_NOT_MEMBER", async () => {
    const { activity } = activityWith(new FakeClock());
    await expect(activity.waitForChange("stranger", 30_000)).rejects.toMatchObject({
      code: "TEAM_NOT_MEMBER",
      message: 'agent "stranger" is not a member of an active Agent Team',
    });
  });
});

describe("Lifecycle · dispose（F30 + C2/D9）", () => {
  it("序列：关准入 → 唤醒等待者 → 结算在飞 → drain → 无失败即静默完成", async () => {
    const kit = buildKit();
    const events: string[] = [];
    const origDrain = kit.provider.drain.bind(kit.provider);
    (kit.provider as unknown as { drain: typeof origDrain }).drain = async (args) => {
      events.push(`drain:${args.timeoutMs}`);
      return origDrain(args);
    };
    const wait = kit.activity.waitForChange(LEAD, 30_000);
    await Promise.resolve();
    const tracked = kit.lifecycle.track(
      (async () => {
        await new Promise((r) => setTimeout(r, 20));
        events.push("inflight-done");
      })(),
    );
    await tracked;
    await kit.runtime.dispose();
    events.push("disposed");
    expect(await wait).toEqual({ timedOut: false }); // 唤醒等待者
    expect(events).toEqual(["inflight-done", "drain:5000", "disposed"]);
    expect(kit.lifecycle.status).toBe("closed");
    // 准入已关：is disposing 逐字（C2②）
    await expect(kit.runtime.roster.spawnTeammate(LEAD, { name: "x", description: "d", prompt: "p" })).rejects.toMatchObject({
      code: "TEAM_DISPOSED",
      message: "Agent Teams service is disposing",
    });
    // 幂等
    await kit.runtime.dispose();
  });

  it("在飞结算超时 → TEAM_DISPOSAL_TIMEOUT 逐字（进聚合）；drain 失败 → AggregateError 逐字", async () => {
    // 超时（真实短时钟）
    const store = new MemoryTeamStore(applyProjectionEvent, emptyTeamState(LEAD));
    const lifecycle = new TeamLifecycle({
      teamId: LEAD,
      store,
      disposalTimeoutMs: 60,
      drainer: () => Promise.resolve(),
    });
    lifecycle.track(new Promise(() => undefined)); // 永不结算
    const err = await lifecycle.dispose().catch((e: unknown) => e) as AggregateError;
    expect(err).toBeInstanceOf(AggregateError);
    expect(err.message).toBe("Agent Teams runtime disposal failed");
    const timeout = err.errors.find(
      (e) => e instanceof TeamError && e.code === "TEAM_DISPOSAL_TIMEOUT",
    ) as TeamError | undefined;
    expect(timeout?.message).toBe("Agent Teams runtime disposal exceeded 60ms");

    // drain 失败进聚合；取消类（TEAM_DISPOSED 链）不计
    const store2 = new MemoryTeamStore(applyProjectionEvent, emptyTeamState(LEAD));
    const lifecycle2 = new TeamLifecycle({
      teamId: LEAD,
      store: store2,
      disposalTimeoutMs: 500,
      drainer: () => Promise.reject(new Error("drain exploded")),
    });
    lifecycle2.track(Promise.reject(new TeamError("TEAM_DISPOSED", "Agent Teams service disposed")));
    const err2 = await lifecycle2.dispose().catch((e: unknown) => e) as AggregateError;
    expect(err2.message).toBe("Agent Teams runtime disposal failed");
    expect(err2.errors).toHaveLength(1);
    expect((err2.errors[0] as Error).message).toBe("drain exploded");
    expect(isCancellation(new TeamError("TEAM_DISPOSED", "Agent Teams service disposed"))).toBe(true);
    expect(isCancellation(new Error("wrapped", { cause: new TeamError("TEAM_DISPOSED", "x") }))).toBe(true);
    expect(isCancellation(new Error("plain"))).toBe(false);
  });

  it("drain 花名册子进程：团队子进程终止、非团队子进程不动（§12）", async () => {
    const kit = buildKit();
    await kit.runtime.roster.spawnTeammate(LEAD, { name: "worker", description: "d", prompt: "p" });
    kit.provider.addForeignChild("foreign-1");
    await kit.runtime.dispose();
    const child = [...kit.provider.teamChildren.values()][0];
    expect(child?.drained).toBe(true);
    expect(child?.alive).toBe(false);
    expect(kit.provider.foreignChildren.has("foreign-1")).toBe(true); // 不动
    expect(kit.provider.drainedTeamIds).toEqual([LEAD]);
  });
});
