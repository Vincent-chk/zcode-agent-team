// TeamCoordinatorHost：真实装配（stage-2 第四轮 A1）。
// 持锁 → 协调者模式：lock + journal(store-adapter) + TeamRuntime(MockProvider 默认，真 provider
// stage-4) + RpcServer 全方法表；失锁 → 代理模式：不碰 journal，写经 socket 转发、读本地重放。
// 锁心跳/接任/exit handler 复用既有 lock 纪律（本轮只做装配，不改锁语义）。
//
// 接任：代理模式默认开启 autoTakeover 观察者（poll lock；持有者心跳过期/锁消失 → 抢锁晋升
// 协调者，kill -9 → 接任 ≤5s 由 lock 调参保证：4500ms 过期 + 200ms 轮询）。

import { CoordinatorLock, AcquireTimeout, type LockInfo } from "./lock.js";
import { JournalTeamStore } from "./store-adapter.js";
import type { JournalOptions } from "./journal.js";
import { RpcServer, callCoordinator, writeRpcToken, newRpcToken, frameBudgetFor } from "./rpc.js";
import { teamPaths, ensureTeamDir, resolveSocketPath, writeSocketRegistry, removeSocketRegistryIf } from "./paths.js";
import { buildTeamMethodTable, registerTeamMethods, invokeTeamMethod, methodTimeoutMs, type TeamMethodHandler } from "./methods.js";
import { load as replayLoad, type LoadedTeam } from "./replay.js";
import { bootId } from "./identity.js";
import { TeamRuntime } from "../domain/runtime.js";
import { validateTeamLimits } from "../domain/config.js";
import type { TeamLimits } from "../domain/config.js";
import { frameMessage } from "../domain/mailbox.js";
import { MockProvider } from "../provider/mock-provider.js";
import type { TeammateProvider } from "../provider/teammate-provider.js";
import type { ReconciliationSource, TargetInspector } from "../domain/ports.js";
import type { BoundaryEvent, ResumePerTurnProvider } from "../provider/resume-provider.js";

export type HostMode = "coordinator" | "proxy";

/** 宿主默认限额（生产 env 注入归 stage-3/4；此处给出与 02 §4 同形的缺省；〔对齐轮〕0.2.1：4 限额）。 */
export const DEFAULT_HOST_LIMITS: TeamLimits = {
  maxMembers: 8,
  maxTasks: 256,
  maxMessageBytes: 65536,
  disposalTimeoutMs: 5000,
};

export interface TeamHostOptions {
  dataRoot: string;
  teamId: string;
  limits?: TeamLimits;
  /** 默认 MockProvider（真 provider 是 stage-4）。 */
  provider?: TeammateProvider & ReconciliationSource & TargetInspector;
  /** 抢锁等待（默认 0 = 单发尝试；他人持有 → 代理模式）。 */
  lockWaitMs?: number;
  /** RpcServer 全局单方法超时（默认 10s；wait.agent 按方法豁免）。 */
  callTimeoutMs?: number;
  /** journal 选项透传（crashHook 演练注入）。 */
  journal?: JournalOptions;
  warn?: (message: string) => void;
  /** 代理模式下自动观察并接任（默认 true）。 */
  autoTakeover?: boolean;
  takeoverPollMs?: number;
  /** pending 消息补投扫描间隔（缺省 2000ms；0 = 关闭）。 */
  deliverySweepMs?: number;
  onPromoted?: (info: { socketPath: string; seq: number; fromCheckpoint: boolean; failure?: string }) => void;
}

export interface HostReadyInfo {
  mode: HostMode;
  socketPath?: string;
  seq: number;
  fromCheckpoint: boolean;
  lockInfo?: LockInfo;
  /** 投影 failure 终态（降级服务中）：读路径保留，成员域调用经 C5 → TEAM_NOT_MEMBER。 */
  failure?: string;
}

export class TeamCoordinatorHost {
  private constructor(
    readonly dataRoot: string,
    readonly teamId: string,
    private readonly opts: TeamHostOptions,
    private readonly lock: CoordinatorLock,
    private readonly limits: TeamLimits,
    private readonly provider: TeammateProvider & ReconciliationSource & TargetInspector,
  ) {}

  private mode: HostMode = "proxy";
  private store: JournalTeamStore | null = null;
  private runtime: TeamRuntime | null = null;
  private server: RpcServer | null = null;
  private table: Map<string, TeamMethodHandler> | null = null;
  private watcher: NodeJS.Timeout | null = null;
  /** pending 补投扫描（崩溃/瞬时失败后不得永久滞留；边界之外的兜底）。 */
  private deliveryTimer: NodeJS.Timeout | null = null;
  private promoting: Promise<boolean> | null = null;
  private closed = false;
  private initialLoad: { seq: number; fromCheckpoint: boolean } | null = null;
  /** 投影 failure 终态 → 降级服务（见 serve()）。 */
  private degradedReason: string | undefined;

  static async open(opts: TeamHostOptions): Promise<TeamCoordinatorHost> {
    const paths = teamPaths(opts.dataRoot, opts.teamId);
    ensureTeamDir(paths);
    let host!: TeamCoordinatorHost;
    const lock = new CoordinatorLock(paths.lockFile, paths.auditFile, {
      // 失锁 = 立即降级；不能继续以 coordinator 身份写 journal/占用 socket。
      onLost: () => {
        void host.demoteToProxy("coordinator lock lost");
      },
    });
    lock.installExitHandlers();
    const limits = validateTeamLimits({ ...DEFAULT_HOST_LIMITS, ...opts.limits });
    host = new TeamCoordinatorHost(opts.dataRoot, opts.teamId, opts, lock, limits, opts.provider ?? new MockProvider());
    try {
      await lock.acquire({ waitMs: opts.lockWaitMs ?? 0 });
    } catch (err) {
      if (err instanceof AcquireTimeout) {
        // 他人持有 → 代理模式（读本地重放 / 写经 socket；不碰 journal）
        host.startTakeoverWatcher();
        return host;
      }
      throw err;
    }
    await host.serve();
    return host;
  }

  get currentMode(): HostMode {
    return this.mode;
  }

  get socketPath(): string | undefined {
    return this.server?.socketPath;
  }

  get committedSeq(): number {
    return this.store?.committedSeq ?? this.initialLoad?.seq ?? 0;
  }

  get coordinatorBootId(): string {
    return this.lock.info?.bootId ?? bootId();
  }

  /** 代理模式下的方法表（§2 一致性断言用；协调者模式为 null）。 */
  get methodTable(): ReadonlyMap<string, TeamMethodHandler> | null {
    return this.table;
  }

  /** 降级原因（投影 failure 终态）；未降级为 undefined。 */
  get degradedFailure(): string | undefined {
    return this.degradedReason;
  }

  /**
   * 协调者模式下的域运行时（stage-3 工具面接线用：list_agents 的 MEMBER_VIEW 全保真
   * 与 wait 捷径需要 roster 呈现；附加式小改，披露于 stage-3 开发记录）。
   * 代理模式为 null（本进程无 runtime）。
   */
  get teamRuntime(): TeamRuntime | null {
    return this.mode === "coordinator" ? this.runtime : null;
  }

  /** 协调者就绪信息（socketPath/seq；代理模式仅 seq 本地重放值）。 */
  async readyInfo(): Promise<HostReadyInfo> {
    if (this.mode === "coordinator") {
      return {
        mode: this.mode,
        socketPath: this.socketPath,
        seq: this.committedSeq,
        fromCheckpoint: this.initialLoad?.fromCheckpoint ?? false,
        lockInfo: this.lock.info ?? undefined,
        ...(this.degradedReason !== undefined ? { failure: this.degradedReason } : {}),
      };
    }
    const loaded = await replayLoad(this.paths().teamDir, this.teamId);
    return {
      mode: this.mode,
      seq: loaded.seq,
      fromCheckpoint: loaded.fromCheckpoint,
      ...(loaded.state.failure !== undefined ? { failure: loaded.state.failure } : {}),
    };
  }

  /**
   * 变更/查询分发：协调者模式 → 方法表直执行（与 socket 路径同一份处理器，语义等价）；
   * 代理模式 → 经 socket 调当前协调者（缺位窗口错误由调用方/TeamClient 决定重试策略）。
   */
  async dispatch(method: string, params?: unknown, opts: { signal?: AbortSignal } = {}): Promise<unknown> {
    if (this.mode === "coordinator" && this.table !== null) {
      return invokeTeamMethod(this.table, method, params, opts);
    }
    const { teamDir } = this.paths();
    return callCoordinator(teamDir, this.teamId, method, params, {
      // 慢方法（spawn/send）用 per-method 裕量；其余沿用 host 全局（缺省交给 RPC 层 15s）。
      timeoutMs: methodTimeoutMs(method) ?? this.opts.callTimeoutMs,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  }

  /** 本地重放读（两模式皆可；协调者模式等价于内存态，代理模式为权威盘面）。 */
  async readBoard(): Promise<LoadedTeam> {
    return replayLoad(this.paths().teamDir, this.teamId);
  }

  /** 手动触发一次接任尝试（观察者外的显式入口；测试/演练用）。 */
  tryPromote(): Promise<boolean> {
    if (this.mode === "coordinator" || this.promoting !== null) {
      return this.promoting ?? Promise.resolve(true);
    }
    const run = this.promoteOnce().finally(() => {
      this.promoting = null;
    });
    this.promoting = run;
    return run;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopWatcher();
    this.stopDeliverySweep();
    const errors: unknown[] = [];
    if (this.server !== null) {
      try {
        await this.server.close();
      } catch (err) {
        errors.push(err);
      }
      this.server = null;
    }
    if (this.runtime !== null) {
      try {
        await this.runtime.dispose();
      } catch (err) {
        errors.push(err);
      }
      this.runtime.close();
      this.runtime = null;
    }
    if (this.store !== null) {
      try {
        await this.store.close(); // journal.close 落 checkpoint
      } catch (err) {
        errors.push(err);
      }
      this.store = null;
    }
    try {
      await this.lock.release();
    } catch (err) {
      errors.push(err);
    }
    if (providerHasBoundary(this.provider)) {
      try {
        this.provider.detach(); // 停 watcher；轮次进程不杀（独立进程组纪律，D9 休眠态）
      } catch (err) {
        errors.push(err);
      }
    }
    this.table = null;
    if (errors.length > 0) throw new AggregateError(errors, "Agent Teams coordinator host close failed");
  }

  /**
   * 失锁降级：停止心跳/写路径，关闭 RPC 与 runtime，回到 proxy 并重新观察接任。
   * 与 close() 的区别：不置 closed，仍可再次晋升。
   */
  private async demoteToProxy(reason: string): Promise<void> {
    if (this.closed || this.mode !== "coordinator") return;
    this.mode = "proxy"; // 先切模式：后续 dispatch 不再走本地方法表
    this.lock.stopHeartbeat();
    this.stopDeliverySweep();
    this.opts.warn?.(`agent-team coordinator demoted for team "${this.teamId}": ${reason}`);
    const server = this.server;
    this.server = null;
    this.table = null;
    if (server !== null) {
      try {
        await server.close();
      } catch {
        /* best-effort */
      }
      removeSocketRegistryIf(this.paths().teamDir, server.socketPath);
    }
    const runtime = this.runtime;
    this.runtime = null;
    if (runtime !== null) {
      try {
        await runtime.dispose();
      } catch {
        /* best-effort */
      }
      runtime.close();
    }
    const store = this.store;
    this.store = null;
    if (store !== null) {
      try {
        await store.close();
      } catch {
        /* best-effort */
      }
    }
    this.startTakeoverWatcher();
  }

  // ---------------------------------------------------------------- 内部

  private paths() {
    return teamPaths(this.dataRoot, this.teamId);
  }

  /** 轮次边界（stage-4）：landed → observeDelivery 折叠 delivered；teammate → pending 续投；状态边 → Activity 唤醒。 */
  private async handleTurnBoundary(event: BoundaryEvent): Promise<void> {
    if (this.mode !== "coordinator" || this.runtime === null || this.closed) return;
    try {
      for (const messageId of event.landedMessageIds) {
        await this.runtime.mailbox.observeDelivery(event.memberId, messageId);
      }
      if (event.memberId !== this.teamId) {
        await this.runtime.mailbox.recoverFor(event.memberId);
      }
      this.runtime.roster.notifyStatusChanged();
    } catch (err) {
      this.opts.warn?.(
        `agent-team turn boundary handling failed for "${event.memberId}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 持锁后装配：journal(store) → runtime → 恢复对账 → RPC server + 方法表。 */
  private async serve(): Promise<void> {
    if (this.closed) throw new Error("host is closed");
    const paths = this.paths();
    this.lock.startHeartbeat();
    let store: JournalTeamStore;
    try {
      // framed 消息上限 65536 与 journal 单行上限同值时，JSON 信封（seq/ts/writer/event）
      // 会让“恰好合法”的消息在 append 阶段以普通 Error 失败。按消息上限派生行上限。
      const journal: JournalOptions = {
        ...this.opts.journal,
        maxLineBytes: Math.max(
          this.opts.journal?.maxLineBytes ?? 65_536,
          this.limits.maxMessageBytes + 4_096,
        ),
      };
      store = await JournalTeamStore.open(this.dataRoot, this.teamId, {
        lock: this.lock,
        journal,
      });
    } catch (err) {
      this.lock.stopHeartbeat();
      await this.lock.release();
      throw err;
    }
    const runtime = new TeamRuntime({
      teamId: this.teamId,
      store,
      provider: this.provider,
      limits: this.limits,
      presentation: providerIsPresentation(this.provider) ? this.provider : undefined,
      // stage-4：宿主内 Lead 无直达通道（D2）→ 投递走 hook 三通道 + 回执折叠。
      // 灰度唤醒：TEAM_WAKE_LEAD=1 且 Lead 空闲时拉起 --resume 回合；仍返回 false（未确认送达）。
      ...(providerDeliversLeadViaHooks(this.provider)
        ? {
            steerLead: () => {
              if (providerWakesLead(this.provider)) {
                void this.provider
                  .wakeLead()
                  .then((result) => {
                    if (result.woke) {
                      this.opts.warn?.(`agent-team lead wake launched for team "${this.teamId}"`);
                    } else if (
                      result.reason !== "disabled" &&
                      result.reason !== "lead-active" &&
                      result.reason !== "recent-activity" &&
                      result.reason !== "cooldown"
                    ) {
                      this.opts.warn?.(`agent-team lead wake skipped for team "${this.teamId}": ${result.reason}`);
                    }
                  })
                  .catch((err: unknown) => {
                    this.opts.warn?.(
                      `agent-team lead wake failed for team "${this.teamId}": ${err instanceof Error ? err.message : String(err)}`,
                    );
                  });
              }
              return false;
            },
          }
        : {}),
      warn: this.opts.warn,
    });
    // stage-4：轮次边界接线（teammate 轮次退出/lead 回执 → observeDelivery 折叠 + pending 续投）
    // + 孤儿纳管（T4.4 常态：任何 daemon 冷启动接任 = 全量重放 + 恢复对账 + run/ 纳管）。
    if (providerHasBoundary(this.provider)) {
      this.provider.bind({
        onBoundary: (event) => void this.handleTurnBoundary(event),
        pendingLookup: (memberId) => {
          const state = store.state();
          return runtime.mailbox
            .pendingFor(state, memberId)
            .map((message) => ({ messageId: message.id, framedJson: JSON.stringify(frameMessage(message)) }));
        },
      });
      const adopted = this.provider.adoptOrphans();
      this.opts.warn?.(
        `agent-team coordinator adopted team "${this.teamId}": finalized ${adopted.finalized.length} finished turn(s), watching ${adopted.adopted.length} live turn(s)`,
      );
    }
    this.initialLoad = store.lastLoad;
    const initialState = store.state();
    if (initialState.failure !== undefined) {
      // 投影 failure 终态（日志不可信）：恢复对账不可做（任何恢复写入都会被不变量 fail-closed 拒绝），
      // 且绝不退出/重试伪装——降级为「只读排障协调者」照常 serve：
      //   读路径保留（board.read 排障视角 / team-ctl state/tail）；成员域调用经 C5 → TEAM_NOT_MEMBER。
      this.degradedReason = initialState.failure;
      this.opts.warn?.(
        `Agent Teams coordinator for team "${this.teamId}" started in degraded mode (projection failure): ${initialState.failure}`,
      );
    } else {
      await runtime.recoverAll();
    }
    const socket = resolveSocketPath(paths.teamDir);
    // 共享凭证：每次协调者晋升生成新 token（旧代理的下一次调用自动读到新 token）。
    // 只在监听成功后写 token 文件：抢 socket 失败时不得覆盖在任协调者的凭证。
    const token = newRpcToken();
    const server = new RpcServer(socket.socketPath, {
      token,
      maxFrameBytes: frameBudgetFor(this.limits.maxMessageBytes),
    });
    const table = buildTeamMethodTable({
      teamId: this.teamId,
      runtime,
      store,
      coordinatorBootId: this.lock.info?.bootId ?? bootId(),
    });
    registerTeamMethods(server, table);
    await server.listen({ callTimeoutMs: this.opts.callTimeoutMs });
    writeRpcToken(paths.teamDir, token);
    writeSocketRegistry(paths.teamDir, socket.socketPath);
    this.store = store;
    this.runtime = runtime;
    this.server = server;
    this.table = table;
    this.mode = "coordinator";
    this.stopWatcher();
    this.startDeliverySweep();
    this.opts.onPromoted?.({
      socketPath: socket.socketPath,
      seq: store.committedSeq,
      fromCheckpoint: this.initialLoad?.fromCheckpoint ?? false,
      ...(this.degradedReason !== undefined ? { failure: this.degradedReason } : {}),
    });
  }

  /** 单发晋升尝试：锁缺失/过龄才出手；新鲜持有 → false。 */
  private async promoteOnce(): Promise<boolean> {
    if (this.mode === "coordinator" || this.closed) return this.mode === "coordinator";
    const observed = this.lock.observe();
    if (observed.exists && observed.ageMs <= this.lock.tuningOptions.expiryMs) {
      return false; // 持有者心跳新鲜，继续代理
    }
    try {
      await this.lock.acquire({ waitMs: 0 }); // 过期/缺失 → acquire 内部 steal/重抢
    } catch {
      return false; // 竞态：他者先抢（AcquireTimeout 单发语义）
    }
    await this.serve();
    return true;
  }

  private startTakeoverWatcher(): void {
    if (this.opts.autoTakeover === false || this.watcher !== null) return;
    const pollMs = this.opts.takeoverPollMs ?? 100;
    const watcher = setInterval(() => {
      void this.tryPromote().catch(() => undefined);
    }, pollMs);
    watcher.unref?.();
    this.watcher = watcher;
  }

  private stopWatcher(): void {
    if (this.watcher !== null) {
      clearInterval(this.watcher);
      this.watcher = null;
    }
  }

  /**
   * pending 补投：轮次边界是主路径；进程瞬时失败（拉起后未落库即退出）会留下 pending，
   * 若没有新的边界/发送就永远不会再试。这里按固定间隔扫描（provider 内部对运行中/退避
   * 目标快速返回 queued，不重复拉起）。
   */
  private startDeliverySweep(): void {
    if (this.deliveryTimer !== null) return;
    const everyMs = this.opts.deliverySweepMs ?? 2_000;
    if (everyMs <= 0) return;
    this.deliveryTimer = setInterval(() => {
      if (this.mode !== "coordinator" || this.runtime === null || this.closed) return;
      try {
        const state = this.store?.state();
        if (state === undefined) return;
        const delivered = new Set(state.delivered);
        if (!state.messages.some((message) => !delivered.has(message.id))) return; // 无 pending → 零成本
      } catch {
        return;
      }
      void this.runtime.mailbox.recoverFor("all").catch((err: unknown) => {
        this.opts.warn?.(
          `agent-team delivery sweep failed for "${this.teamId}": ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, everyMs);
    this.deliveryTimer.unref?.();
  }

  private stopDeliverySweep(): void {
    if (this.deliveryTimer !== null) {
      clearInterval(this.deliveryTimer);
      this.deliveryTimer = null;
    }
  }
}

/** MockProvider 实现 §5.5 呈现补充（statusOf/modelOf）；真 provider stage-4 落地。 */
function providerIsPresentation(
  provider: TeammateProvider & ReconciliationSource & TargetInspector,
): provider is TeammateProvider & ReconciliationSource & TargetInspector & { statusOf(memberId: string): "running" | "inactive"; modelOf(memberId: string): string | undefined } {
  return (
    typeof (provider as { statusOf?: unknown }).statusOf === "function" &&
    typeof (provider as { modelOf?: unknown }).modelOf === "function"
  );
}

/** stage-4：轮次边界能力（ResumePerTurnProvider）；装配 bind/adoptOrphans/detach。 */
function providerHasBoundary(
  provider: TeammateProvider & ReconciliationSource & TargetInspector,
): provider is ResumePerTurnProvider {
  return (
    typeof (provider as { bind?: unknown }).bind === "function" &&
    typeof (provider as { adoptOrphans?: unknown }).adoptOrphans === "function"
  );
}

/** stage-4：Lead 投递走 hook 通道（宿主内进程无直达口）的 provider 标记。 */
function providerDeliversLeadViaHooks(
  provider: TeammateProvider & ReconciliationSource & TargetInspector,
): boolean {
  return (provider as { LEAD_DELIVERY_VIA_HOOKS?: unknown }).LEAD_DELIVERY_VIA_HOOKS === true;
}

/** 灰度 Lead 唤醒能力（ResumePerTurnProvider 提供；测试 provider 可不实现）。 */
function providerWakesLead(
  provider: TeammateProvider & ReconciliationSource & TargetInspector,
): provider is TeammateProvider & ReconciliationSource & TargetInspector & {
  wakeLead: () => Promise<{ woke: boolean; reason: string }>;
} {
  return typeof (provider as { wakeLead?: unknown }).wakeLead === "function";
}
