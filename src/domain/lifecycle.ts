// Lifecycle 处置（02 规格 §12；F30 + C2/D9）。dispose(reason) 为抽象触发（上层：SIGINT
// handler / 冷启动对账 / 显式调用），域核心不假设来源。
// 序列：关准入（abort reason = TEAM_DISPOSED `Agent Teams service disposed`）→ 唤醒等待者
// → 限时结算在飞（超时 → TEAM_DISPOSAL_TIMEOUT `Agent Teams runtime disposal exceeded <n>ms`）
// → drain 花名册子进程（非团队子进程不动，由 provider 保证）→ 失败聚合
// AggregateError(`Agent Teams runtime disposal failed`) 显式抛出；取消类拒绝
// （含 cause 链 TEAM_DISPOSED）不计失败。

import { TeamError, isTeamError } from "./errors.js";
import type { Clock, TeamStore } from "./ports.js";

/** 服务依赖的处置端口（roster/mailbox/taskboard 经此准入与登记在飞）。 */
export interface LifecyclePort {
  /** 处置中 → TEAM_DISPOSED（`Agent Teams service is disposing`）。 */
  requireOpen(): void;
  /** 运行时中止信号（reason = TEAM_DISPOSED `Agent Teams service disposed`；dispose 时触发）。 */
  runtimeSignal(): AbortSignal;
  /** 在飞登记（spawn/send 等长操作；dispose 限时等待其结算）。 */
  track<T>(p: Promise<T>): Promise<T>;
}

export type DisposalDrainer = (args: { timeoutMs: number }) => Promise<void>;

export interface LifecycleDeps {
  teamId: string;
  store: TeamStore;
  disposalTimeoutMs: number;
  /** drain 花名册子进程（provider.drain 适配）。 */
  drainer: DisposalDrainer;
  /** 等待者唤醒钩子（Activity.closeAll 接线；缺省无操作）。 */
  closeWaiters?: () => void;
  clock?: Clock;
}

export class TeamLifecycle implements LifecyclePort {
  private phase: "open" | "disposing" | "closed" = "open";
  private readonly abort = new AbortController();
  private readonly inflight = new Set<Promise<unknown>>();
  private disposeRun: Promise<void> | undefined;

  constructor(private readonly deps: LifecycleDeps) {}

  get status(): "open" | "disposing" | "closed" {
    return this.phase;
  }

  requireOpen(): void {
    if (this.phase !== "open") {
      throw new TeamError("TEAM_DISPOSED", "Agent Teams service is disposing");
    }
  }

  runtimeSignal(): AbortSignal {
    return this.abort.signal;
  }

  track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    // 登记簿 promise：吞掉拒绝（原始 p 的拒绝由调用方处理；不可产生未处理派生拒绝）
    void p
      .finally(() => {
        this.inflight.delete(p);
      })
      .catch(() => undefined);
    return p;
  }

  /** dispose(reason)：D9 抽象触发；幂等（重复调用等首次结果）。 */
  dispose(reason?: unknown): Promise<void> {
    void reason; // 触发来源仅审计用（D9：域核心不假设来源）
    this.disposeRun ??= this.runDispose();
    return this.disposeRun;
  }

  private async runDispose(): Promise<void> {
    const failures: unknown[] = [];
    // ① 关准入 + 运行时中止（C2①：abort reason 逐字）
    this.phase = "disposing";
    this.abort.abort(new TeamError("TEAM_DISPOSED", "Agent Teams service disposed"));
    // ② 唤醒全部等待者（Activity.closeAll；closed 后新等待立即返回）
    this.deps.closeWaiters?.();
    // ③ 限时结算在飞
    const clock = this.deps.clock ?? defaultClock;
    const settle = Promise.allSettled([...this.inflight]);
    let settled: PromiseSettledResult<unknown>[] = [];
    const timedOut = await Promise.race([
      settle.then((results) => {
        settled = results;
        return false as const;
      }),
      clock.sleep(this.deps.disposalTimeoutMs).then(() => true as const),
    ]);
    // 超时后不再等待在飞结算（其结果已不可观察；超时本身计入失败）
    for (const entry of settled) {
      if (entry.status === "rejected" && !isCancellation(entry.reason)) failures.push(entry.reason);
    }
    if (timedOut) {
      failures.push(
        new TeamError(
          "TEAM_DISPOSAL_TIMEOUT",
          `Agent Teams runtime disposal exceeded ${this.deps.disposalTimeoutMs}ms`,
        ),
      );
    }
    // ④ drain 花名册子进程（非团队子进程不动 = provider 契约）
    try {
      await this.deps.drainer({ timeoutMs: this.deps.disposalTimeoutMs });
    } catch (err) {
      if (!isCancellation(err)) failures.push(err);
    }
    // ⑤ 显式失败聚合
    this.phase = "closed";
    if (failures.length > 0) {
      throw new AggregateError(failures, "Agent Teams runtime disposal failed");
    }
  }
}

const defaultClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** 取消类拒绝：TeamError(TEAM_DISPOSED) 或 cause 链含 TEAM_DISPOSED（§12「不计为失败」）。 */
export function isCancellation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth++) {
    if (isTeamError(current) && current.code === "TEAM_DISPOSED") return true;
    if (current instanceof AggregateError && current.errors.length > 0) {
      if (current.errors.every((e) => isCancellation(e))) return true;
    }
    current = (current as Error).cause;
  }
  return false;
}
