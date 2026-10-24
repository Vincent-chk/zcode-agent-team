// 成员侧分发 helper（stage-2 第四轮 B）：读 = 本地重放；写 = 本进程持锁则方法表直执行，
// 否则经 socket 调当前协调者（缺位窗口 → 有限指数退避重试，覆盖 ≤5s 接任；预算耗尽仍缺位
// → 抛可读的 COORDINATOR_UNAVAILABLE（TEAM_DISPOSED + 逐字消息，不静默丢、不假装成功））。

import { callCoordinator, COORDINATOR_UNAVAILABLE_MESSAGE } from "./rpc.js";
import type { TeamCoordinatorHost } from "./host.js";
import { teamPaths } from "./paths.js";
import { load as replayLoad } from "./replay.js";
import { isTeamError } from "../domain/errors.js";

/** 本地重放即可服务的读方法（成员 daemon「只读本地重放」形态）。 */
export const LOCAL_READ_METHODS: ReadonlySet<string> = new Set(["board.read"]);

export interface TeamClientOptions {
  dataRoot: string;
  teamId: string;
  /** 本进程宿主（协调者模式 → 写操作直执行，不经 socket）。 */
  host?: () => TeamCoordinatorHost | null;
  /** 缺位窗口重试预算（默认 6000ms ≥ kill -9 接任上限 5s）。 */
  unavailableRetryMs?: number;
  /** 经 socket 单次调用的执行超时（缺省用 callCoordinator 默认）。 */
  callTimeoutMs?: number;
  /** 重试观测（演练/测试断言用）。 */
  onRetry?: (attempt: number, err: Error) => void;
}

export class TeamClient {
  constructor(private readonly opts: TeamClientOptions) {}

  /** 读 → 本地重放；写 → 持锁直执行 / socket 代理（带缺位窗口重试）。 */
  async dispatch(method: string, params?: unknown): Promise<unknown> {
    if (LOCAL_READ_METHODS.has(method)) {
      return this.readBoard();
    }
    const host = this.opts.host?.() ?? null;
    if (host !== null && host.currentMode === "coordinator") {
      return host.dispatch(method, params);
    }
    const { teamDir } = teamPaths(this.opts.dataRoot, this.opts.teamId);
    const fn = () =>
      callCoordinator(teamDir, this.opts.teamId, method, params, { timeoutMs: this.opts.callTimeoutMs });
    return callWithUnavailableRetry(fn, {
      deadlineMs: this.opts.unavailableRetryMs ?? 6_000,
      onRetry: this.opts.onRetry,
    });
  }

  /** 本地重放读（board.read 的本地形态；权威盘面）。 */
  async readBoard(): Promise<{ seq: number; view: unknown }> {
    const { teamDir } = teamPaths(this.opts.dataRoot, this.opts.teamId);
    const loaded = await replayLoad(teamDir, this.opts.teamId);
    return { seq: loaded.seq, view: loaded.view };
  }
}

/** 是否缺位窗口错误（code=TEAM_DISPOSED 且消息逐字 = 缺位窗口文案；服务处置 TEAM_DISPOSED 不重试）。 */
export function isCoordinatorUnavailable(err: unknown): boolean {
  return isTeamError(err) && err.code === "TEAM_DISPOSED" && err.message === COORDINATOR_UNAVAILABLE_MESSAGE;
}

/** 有限指数退避：仅缺位窗口错误重试；域错误（27 码，〔对齐轮〕0.2.1）立即上抛；预算耗尽抛最后一次错误。 */
export async function callWithUnavailableRetry<T>(
  fn: () => Promise<T>,
  opts: { deadlineMs: number; baseMs?: number; maxMs?: number; onRetry?: (attempt: number, err: Error) => void },
): Promise<T> {
  const baseMs = opts.baseMs ?? 50;
  const maxMs = opts.maxMs ?? 500;
  const deadline = Date.now() + opts.deadlineMs;
  let attempt = 0;
  let delay = baseMs;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!isCoordinatorUnavailable(err)) throw err;
      attempt += 1;
      if (Date.now() + delay >= deadline) throw err;
      opts.onRetry?.(attempt, err instanceof Error ? err : new Error(String(err)));
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(maxMs, delay * 2);
    }
  }
}
