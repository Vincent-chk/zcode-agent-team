// 服务层端口（零 IO 纪律）：五个服务只依赖这些注入端口，不触碰 fs/net/进程。
// store = 第二轮 journal 的抽象（内存实现供单测；src/coord/store-adapter.ts 提供真 journal 适配）。

import type { TeamState } from "./projection.js";

/** 事件存储端口：一切追加经此（自动含追加前不变量 + flush；非法候选抛逐字错误）。 */
export interface TeamStore {
  append(event: unknown): Promise<{ seq: number; state: TeamState }>;
  state(): TeamState;
  /** 同 team 尾链串行（写事务）。 */
  transact<T>(op: () => Promise<T>): Promise<T>;
  /** 提交边（Activity 唤醒源之一）。 */
  onCommit(listener: (seq: number, state: TeamState) => void): () => void;
}

/** 进程内存储实现（单测/桩用；真持久化走 src/coord/store-adapter.ts）。 */
export class MemoryTeamStore implements TeamStore {
  private teamState: TeamState;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(seq: number, state: TeamState) => void>();
  private txDepth = 0;
  private lastSeq = 0;

  constructor(
    private readonly apply: (state: TeamState, event: unknown) => TeamState,
    initial: TeamState,
  ) {
    this.teamState = initial;
  }

  async append(event: unknown): Promise<{ seq: number; state: TeamState }> {
    return this.transact(async () => {
      const next = this.apply(this.teamState, event);
      if (next.failure !== undefined && this.teamState.failure === undefined) {
        throw new Error(`session event ${this.lastSeq + 1} violates the Agent Teams stream: ${next.failure}`);
      }
      this.teamState = next;
      this.lastSeq += 1;
      for (const l of this.listeners) l(this.lastSeq, next);
      return { seq: this.lastSeq, state: next };
    });
  }

  state(): TeamState {
    return this.teamState;
  }

  /**
   * 同 team 尾链串行；**重入安全**：事务回调内的嵌套 transact/append（同步完成写盘）在当前
   * 串行区内直接执行，不再向尾链排队（否则与外层事务互相等待 → 死锁）。
   */
  transact<T>(op: () => Promise<T>): Promise<T> {
    if (this.txDepth > 0) return this.runGuarded(op);
    const run = this.tail.then(
      () => this.runGuarded(op),
      () => this.runGuarded(op),
    );
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runGuarded<T>(op: () => Promise<T>): Promise<T> {
    this.txDepth += 1;
    try {
      return await op();
    } finally {
      this.txDepth -= 1;
    }
  }

  onCommit(listener: (seq: number, state: TeamState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** §5.4 恢复对账所需的持久化桩端口（stage-4 由真 provider 会话存储实现；本轮 MockProvider）。 */
export interface ProvisioningRecord {
  rootSessionId: string;
  /** 后缀中的 subagent/descriptor；缺失（非 continuable 子代理）= undefined。 */
  descriptor?: { provider: string; mode: string } | undefined;
  initialUserMessageAccepted: boolean;
}

export interface ReconciliationSource {
  /** 读取成员的持久化供给记录；无记录返回 undefined；读取失败抛错（→ `child Session recovery failed: …`）。 */
  readProvisioningRecord(memberId: string): ProvisioningRecord | undefined;
}

/** 目标侧可见性端口（§6.3 投递分支与 §5.5 availability）。 */
export interface TargetInspector {
  /** 是否在存活注册表（§5.2 注册表同 id 同对象口径的等价抽象）。 */
  isAlive(memberId: string): boolean;
  /** 目标会话是否已持久含该消息身份（去重路径）；读取失败抛错（→ C4 警告路径，仅冷读使用）。 */
  containsMessage(memberId: string, messageId: string): boolean;
  /** 冷目标持久记录读取：无记录 undefined；读失败抛错（C4）。recorded = 该消息是否已持久记录。 */
  readColdRecord(memberId: string, messageId: string): { recorded: boolean } | undefined;
}

/** 可注入时钟（测试不依赖真实长等待）。 */
export interface Clock {
  now(): number;
  /** 可取消睡眠：abort 时立即 resolve（调用方以 settled 标记忽略后续）。 */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

/** 单行错误文本（§5.3「error=单行 errorMessage」口径：取首行）。 */
export function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n")[0] ?? message;
}
