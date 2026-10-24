// Activity 等待与活动信号（02 规格 §8；F28 + C7）。
// 只报 { timedOut: boolean }——不携带变化内容、无错误码；唤醒边 = Team 日志提交 + 成员状态
// 变化（等待注册之后发生的边才唤醒）；处置 close() 唤醒全部且新等待立即返回。
// C7 顺序：timeout 校验 → signal.throwIfAborted() → closed 检查（严格保持）。

import { TeamError } from "./errors.js";
import type { TeamState } from "./projection.js";
import { requireMembership } from "./projection.js";
import type { Clock, TeamStore } from "./ports.js";
import { errorMessage, realClock } from "./ports.js";

export interface WaitResult {
  timedOut: boolean;
}

interface Waiter {
  wake: () => void;
}

export interface ActivityDeps {
  store: TeamStore;
  clock?: Clock;
}

export class TeamActivity {
  private readonly waiters = new Set<Waiter>();
  private closed = false;
  private readonly clock: Clock;
  private unsubscribeCommit: (() => void) | undefined;

  constructor(private readonly deps: ActivityDeps) {
    this.clock = deps.clock ?? realClock;
  }

  /** 接线：Team 日志提交边（由 runtime/装配调用；每提交唤醒全部已注册等待者一次）。 */
  bindCommitEdge(): () => void {
    this.unsubscribeCommit?.();
    this.unsubscribeCommit = this.deps.store.onCommit(() => this.wakeAll());
    return () => this.unsubscribeCommit?.();
  }

  /** 接线：成员状态变化边（roster.onMemberStatus → 此处）。 */
  notifyMemberStatus(): void {
    this.wakeAll();
  }

  /** 处置：唤醒全部等待者并关闭准入（新等待立即返回 { timedOut:false }）。 */
  closeAll(): void {
    this.closed = true;
    this.wakeAll();
  }

  /** §8 waitForChange。 */
  async waitForChange(
    callerId: string,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<WaitResult> {
    // ① timeout 范围校验（逐字）
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) {
      throw new TeamError(
        "TEAM_INVALID_TIMEOUT",
        "timeoutMs must be an integer from 10000 through 3600000",
      );
    }
    // ② C7：已中止的 signal 在 timeout 校验后、closed 检查前直接抛 reason
    signal?.throwIfAborted();
    // ③ 处置后新等待立即返回
    if (this.closed) return { timedOut: false };
    requireMembership(() => this.loadState(), callerId);

    return new Promise<WaitResult>((resolve, reject) => {
      const sleepAbort = new AbortController();
      const waiter: Waiter = {
        wake: () => {
          cleanup();
          resolve({ timedOut: false });
        },
      };
      const onAbort = () => {
        cleanup();
        const reason = signal?.reason;
        if (reason instanceof Error) reject(reason); // Error → 原样抛
        else
          reject(
            new TeamError("TEAM_WAIT_ABORTED", `wait_agent aborted: ${errorMessage(reason)}`),
          );
      };
      const cleanup = () => {
        if (settled) return;
        this.waiters.delete(waiter);
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        sleepAbort.abort(); // 取消 timeout sleep，避免长会话累积最长 1h 的 timer
      };
      let settled = false;
      this.waiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      void this.clock.sleep(timeoutMs, sleepAbort.signal).then(() => {
        if (settled) return;
        cleanup();
        resolve({ timedOut: true });
      });
    });
  }

  private wakeAll(): void {
    const current = [...this.waiters];
    this.waiters.clear();
    for (const waiter of current) waiter.wake();
  }

  private loadState(): TeamState {
    const state = this.deps.store.state();
    if (state.failure !== undefined) throw new Error(state.failure);
    return state;
  }
}

const defaultClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
