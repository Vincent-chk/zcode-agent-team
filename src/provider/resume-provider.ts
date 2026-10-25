// ResumePerTurnProvider（stage-4 主实现；ADR-4 定版）：teammate = `zcode -p [--resume] --json
// --mode yolo --surface terminal --disallowed-tools Task --cwd <团队 cwd>` 的独立进程组轮次。
//   startContinuable = 首轮（fresh=任务原文逐字，D2；fork=D3 转录注入）+ db 持久接收探针；
//   deliver          = 空闲即拉起（pending 依序合并，每条保留框架头）/运行中一律 queued（内部口径）；
//   interrupt        = 采样 previousStatus → SIGTERM→3s→SIGKILL（进程组）；pending/任务归属不动；
//   drain            = D9 策略（keep=标记默认/kill=限时终止）；轮次进程不随 daemon 回收连带死。
// 恰一次：轮次记录先于孵化落盘（run/turn-N.json 携带 messageIds+promptText）；landed = 目标会话
// db 出现该 prompt 的 real_user 文本（checkpointDelivered 等价）；崩溃在任何点 → 重放轮次记录去重。
// 一切状态在盘上（origin.json/run//receipts），任何 daemon 冷启动可接管（adoptOrphans + watcher）。

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { TeammateProvider } from "./teammate-provider.js";
import type { ProvisioningRecord } from "../domain/ports.js";
import { leadWakeEnabled, maybeWakeLead, type LeadWakeResult } from "./lead-wake.js";
import {
  memberPaths,
  readOrigin,
  writeOrigin,
  writeTurn,
  readTurn,
  readCurrentTurnId,
  setCurrentTurn,
  listTurns,
  nextTurnId,
  appendReceipt,
  receiptMessageIds,
  readStopBudget,
  writeStopBudget,
  writeJsonAtomic,
  readJson,
  readModelFailed,
  writeModelFailed,
  clearModelFailed,
  type ModelFailedRecord,
  type OriginRecord,
  type TurnRecord,
  type MemberPaths,
} from "./member-files.js";
import { TranscriptReader } from "./transcript.js";
import { renderFramedBatch } from "./framing.js";
import { buildForkFirstPrompt } from "./fork-context.js";
import { resolveZcodeBin, type ZcodeBin } from "./zcode-bin.js";
import { AppServerSessionBreeder, isolationModeFromEnv, type IsolationMode } from "./session-breeder.js";
import type { MemberModelSelection } from "./model-selection.js";
import { parseModelSelection } from "./model-selection.js";
import {
  ModelInheritanceError,
  ModelSyncSuppressedError,
  classifyApplyFailure,
  classifySelectionFailure,
  selectionSignature,
  type ModelPreflight,
} from "./model-inheritance.js";
import {
  applyReasoningDefault,
  catalogSupports,
  readModelCatalog,
  type ModelCatalog,
} from "./model-catalog.js";
import { spawnDetached, pidAlive, killProcessGroup } from "./procgroup.js";
import { readSessionRegistry, upsertSessionEntry } from "../mcp/identity.js";

export interface BoundaryEvent {
  memberId: string;
  turnId?: string;
  /** 本轮 prompt 已落库的消息 id（lead = 回执消息 id）。 */
  landedMessageIds: string[];
  /** 本轮含的待投递消息 id（未落库 = 滞留 pending，等下次投递）。 */
  carriedMessageIds: string[];
}

export interface ResumeProviderOptions {
  dataRoot: string;
  teamId: string;
  /** 团队共享 cwd（缺省 TEAM_PROJECT_DIR ?? process.cwd()）。 */
  cwd?: string;
  /** 会话库路径（缺省 ~/.zcode/cli/db/db.sqlite；测试注入）。 */
  dbPath?: string;
  /** zcode 二进制（缺省 resolveZcodeBin）。 */
  zcode?: ZcodeBin;
  /** D9 drain 策略：keep（默认，休眠态保留轮次）/ kill（§12 完整序列，测试/显式处置）。 */
  drainPolicy?: "keep" | "kill";
  /** SIGTERM 宽限（interrupt/kill 策略）。 */
  termGraceMs?: number;
  /** 首轮持久接收等待上限（缺省 120s）。 */
  firstTurnTimeoutMs?: number;
  /** deliver 落库确认等待（缺省 15s；超时→queued，边界补认）。 */
  deliverConfirmMs?: number;
  /** 轮次 watcher 轮询间隔（缺省 500ms；F13 ≤1s 预算）。 */
  watcherIntervalMs?: number;
  /** 拉起退避（同成员连续拉起失败/未落库的最小间隔，防 respawn 循环）。 */
  relaunchBackoffMs?: number;
  /** 会话隔离（stage-6）：child = 宿主原生隐藏子会话（默认）；legacy = 旧顶层会话（回滚）。 */
  sessionIsolation?: IsolationMode;
  /** 培育器注入（测试用；缺省按 cwd/dbPath 构造）。 */
  breeder?: SessionBreederLike;
  /** 模型目录（档位缺省链用；缺省 readModelCatalog，测试可注入固定目录）。 */
  modelCatalog?: () => ModelCatalog;
  /** 空闲 Lead 唤醒的最小空闲窗口（缺省 TEAM_WAKE_LEAD_MIN_IDLE_MS ?? 30s）。 */
  leadWakeMinIdleMs?: number;
  /**
   * 临时故障的自动重试退避序列（0.4.1；缺省 [5s, 15s, 30s] = 首次失败后最多自动重试 3 次）。
   * 数组耗尽 → 停止自动尝试（Lead 换模或新消息解锁）。测试注入短序列。
   */
  modelRetryBackoffMs?: number[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (record: Record<string, unknown>) => void;
}

/** 培育器最小接口（依赖倒置，便于测试注入）。0.4.0：createChild 无兜底档（继承失败即抛）。 */
export interface SessionBreederLike {
  createChild(input: {
    teamId: string;
    workspacePath: string;
    modelSelection?: MemberModelSelection;
    timeoutMs?: number;
  }): Promise<{
    anchorSessionId: string;
    childSessionId: string;
    elapsedMs: number;
    workspacePath: string;
    /** 实际生效的模型选择（setModel 成功才有；失败 createChild 直接抛）。 */
    appliedModel?: MemberModelSelection;
  }>;
  /** 每轮执行前同步（0.4.0）：失败返回原因 → 调用方阻止本轮。测试桩可省略 = 同步必失败。 */
  applyModelSelection?(input: {
    sessionId: string;
    workspacePath: string;
    selection: MemberModelSelection;
    timeoutMs?: number;
  }): Promise<{ applied: boolean; reason?: string }>;
}

export interface PendingLookup {
  (memberId: string): Array<{ messageId: string; framedJson: string }>;
}

/** Lead 侧投递 = hook 回执（宿主内进程无法直接注入；D2/D12 内部适配层）。 */
export const LEAD_STEER_RESULT = false as const;

/** host 装配标记：Lead 投递走 hook 通道（steerLead=false + 回执折叠）。 */
export const LEAD_DELIVERY_VIA_HOOKS = true as const;

/** 临时故障自动重试退避（0.4.1：5s/15s/30s，最多 3 次；耗尽后等 Lead 换模或新消息解锁）。 */
export const DEFAULT_MODEL_RETRY_BACKOFF_MS: readonly number[] = [5_000, 15_000, 30_000];

export type { ModelPreflight };
export { providerHasModelPreflight } from "./model-inheritance.js";

export class ResumePerTurnProvider implements TeammateProvider {
  readonly LEAD_DELIVERY_VIA_HOOKS = LEAD_DELIVERY_VIA_HOOKS;
  readonly teamDir: string;
  private readonly cwd: string;
  private readonly reader: TranscriptReader;
  private readonly zcode: ZcodeBin;
  private readonly drainPolicy: "keep" | "kill";
  private readonly termGraceMs: number;
  private readonly firstTurnTimeoutMs: number;
  private readonly deliverConfirmMs: number;
  private readonly watcherIntervalMs: number;
  private readonly relaunchBackoffMs: number;
  private readonly sessionIsolation: IsolationMode;
  private readonly leadWakeMinIdleMs: number;
  private readonly modelRetryBackoffMs: readonly number[];
  private readonly breeder: SessionBreederLike;
  private readonly modelCatalog: () => ModelCatalog;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (record: Record<string, unknown>) => void;

  private boundaryListeners = new Set<(event: BoundaryEvent) => void>();
  private watcherTimer: NodeJS.Timeout | null = null;
  private adoptedPids = new Set<number>();
  private watcherBusy = false;
  private leadReceiptsMtimeMs: number | null = null;
  private lastLaunchFailureAt = 0;
  private pendingLookup: PendingLookup | null = null;
  private closed = false;
  /** 失败记录变化监听（0.4.1：host 接线 → roster.notifyStatusChanged 刷新成员展示）。 */
  private modelFailureListeners = new Set<() => void>();

  constructor(private readonly opts: ResumeProviderOptions) {
    this.teamDir = path.join(opts.dataRoot, "teams", safeDir(opts.teamId));
    this.cwd = opts.cwd ?? process.env.TEAM_PROJECT_DIR ?? process.cwd();
    this.reader = new TranscriptReader({ ...(opts.dbPath !== undefined ? { dbPath: opts.dbPath } : {}) });
    this.zcode = opts.zcode ?? resolveZcodeBin();
    this.drainPolicy = opts.drainPolicy ?? drainPolicyFromEnv();
    this.termGraceMs = opts.termGraceMs ?? 3_000;
    this.firstTurnTimeoutMs = opts.firstTurnTimeoutMs ?? 120_000;
    this.deliverConfirmMs = opts.deliverConfirmMs ?? 15_000;
    this.watcherIntervalMs = opts.watcherIntervalMs ?? 500;
    this.relaunchBackoffMs = opts.relaunchBackoffMs ?? 2_000;
    this.sessionIsolation = opts.sessionIsolation ?? isolationModeFromEnv();
    this.leadWakeMinIdleMs =
      opts.leadWakeMinIdleMs ?? Number(process.env.TEAM_WAKE_LEAD_MIN_IDLE_MS ?? 30_000);
    this.modelRetryBackoffMs =
      opts.modelRetryBackoffMs !== undefined && opts.modelRetryBackoffMs.length > 0
        ? opts.modelRetryBackoffMs
        : DEFAULT_MODEL_RETRY_BACKOFF_MS;
    this.breeder =
      opts.breeder ??
      new AppServerSessionBreeder({
        zcode: this.zcode,
        ...(opts.dbPath !== undefined ? { dbPath: opts.dbPath } : {}),
        log: (record) => this.log(record),
        now: opts.now ?? Date.now,
      });
    this.now = opts.now ?? Date.now;
    this.modelCatalog = opts.modelCatalog ?? (() => readModelCatalog());
    this.sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log =
      opts.log ??
      (() => {
        /* 静默（测试）；daemon 注入 provider.jsonl */
      });
  }

  // ---------------------------------------------------------------- 边界与接线

  /** 协调者接线（host.serve）：轮次边界监听 + pending 合并查询（mailbox 派生）
   *  + 模型失败记录变化通知（0.4.1：后台续跑失败 → 成员展示立即刷新）。 */
  bind(hooks: {
    onBoundary: (event: BoundaryEvent) => void;
    pendingLookup: PendingLookup;
    onModelFailureChanged?: () => void;
  }): void {
    this.boundaryListeners.add(hooks.onBoundary);
    this.pendingLookup = hooks.pendingLookup;
    if (hooks.onModelFailureChanged !== undefined) {
      this.modelFailureListeners.add(hooks.onModelFailureChanged);
    }
  }

  private notifyModelFailureChanged(): void {
    for (const listener of this.modelFailureListeners) {
      try {
        listener();
      } catch (err) {
        this.log({ ts: iso(this.now()), kind: "model-failure-listener-error", error: errText(err) });
      }
    }
  }

  /**
   * spawn 前置校验（0.4.1）：Lead 模型不可继承 → 抛错。roster 在**登记成员之前**调用，
   * 可提前识别的配置错误不产生 provisioning 成员、不占成员名、不建隐藏子会话。
   * 供给阶段仍复检（resolveLeadInheritance 在 startContinuable 内照跑）——预检后配置可能变化。
   * legacy 隔离模式无继承语义 → 恒通过。
   */
  preflightMemberModel(): void {
    if (this.sessionIsolation !== "child") return;
    this.resolveLeadInheritance();
  }

  /** 协调者启动纳管：孤儿轮次定案/再收养 + drain 标记处置 + lead 回执折叠（T4.4/触发点②）。 */
  adoptOrphans(): { finalized: string[]; adopted: string[] } {
    const finalized: string[] = [];
    const adopted: string[] = [];
    for (const memberId of listMembers(this.teamDir)) {
      const paths = memberPaths(this.teamDir, memberId);
      this.handleDrainMarker(paths);
      for (const turn of listTurns(paths.runDir)) {
        if (turn.status !== "running" && turn.status !== "starting") continue;
        if (this.finalizeIfDead(memberId, turn)) {
          finalized.push(turn.turnId);
        } else if (turn.pid !== null) {
          this.adoptedPids.add(turn.pid);
          adopted.push(turn.turnId);
        }
      }
    }
    this.foldLeadReceipts(true);
    this.startWatcher();
    return { finalized, adopted };
  }

  /** 协调者关闭：停 watcher（轮次进程不杀——独立进程组纪律）。 */
  detach(): void {
    this.closed = true;
    if (this.watcherTimer !== null) {
      clearInterval(this.watcherTimer);
      this.watcherTimer = null;
    }
    this.adoptedPids.clear();
  }

  private emitBoundary(event: BoundaryEvent): void {
    for (const listener of this.boundaryListeners) {
      try {
        listener(event);
      } catch (err) {
        this.log({ ts: iso(this.now()), kind: "boundary-listener-error", memberId: event.memberId, error: errText(err) });
      }
    }
  }

  private startWatcher(): void {
    if (this.watcherTimer !== null || this.closed) return;
    const timer = setInterval(() => {
      void this.watchTick().catch((err: unknown) => {
        // 坏 turn/回执文件或 db 瞬态失败不得变成 unhandled rejection（会杀 daemon）；
        // 单次 tick 失败在下一次轮询重试。
        this.log({ ts: iso(this.now()), kind: "watcher-error", error: errText(err) });
      });
    }, this.watcherIntervalMs);
    timer.unref?.();
    this.watcherTimer = timer;
  }

  private async watchTick(): Promise<void> {
    if (this.watcherBusy || this.closed) return;
    this.watcherBusy = true;
    try {
      for (const memberId of listMembers(this.teamDir)) {
        const paths = memberPaths(this.teamDir, memberId);
        const turnId = readCurrentTurnId(paths);
        if (turnId === undefined) continue;
        const turn = readTurn(paths.runDir, turnId);
        if (turn === undefined) continue;
        if (turn.status === "running" || turn.status === "starting") {
          if (turn.interruptRequestedAt !== undefined) {
            // 协调者在 interrupt 中途崩溃：接任者补杀并收尾。
            const dead = await killProcessGroup(turn.pgid, this.termGraceMs);
            if (dead) {
              const landed =
                turn.sessionId !== null && this.reader.hasUserText(turn.sessionId, turn.promptText);
              writeTurn(paths.runDir, {
                ...turn,
                status: "interrupted",
                exitedAt: iso(this.now()),
                landed,
              });
              this.emitBoundary({
                memberId,
                turnId: turn.turnId,
                landedMessageIds: landed ? turn.messageIds : [],
                carriedMessageIds: turn.messageIds,
              });
            }
            continue;
          }
          this.finalizeIfDead(memberId, turn);
        }
      }
      this.foldLeadReceipts(false);
    } finally {
      this.watcherBusy = false;
    }
  }

  /** 轮次进程已死 → 定案（landed 实查）+ 边界事件；返回是否已定案。 */
  private finalizeIfDead(memberId: string, turn: TurnRecord): boolean {
    if (turn.pid !== null && pidAlive(turn.pid)) {
      this.adoptedPids.add(turn.pid);
      return false;
    }
    const landed = turn.sessionId !== null && this.reader.hasUserText(turn.sessionId, turn.promptText);
    const next: TurnRecord = {
      ...turn,
      status: "exited",
      exitedAt: iso(this.now()),
      landed,
    };
    const paths = memberPaths(this.teamDir, memberId);
    writeTurn(paths.runDir, next);
    this.adoptedPids.delete(turn.pid ?? -1);
    this.log({
      ts: iso(this.now()),
      kind: "turn-exit",
      teamId: this.opts.teamId,
      memberId,
      turnId: turn.turnId,
      landed,
      messageIds: turn.messageIds,
    });
    if (!landed && turn.messageIds.length > 0) {
      this.lastLaunchFailureAt = this.now();
    }
    this.emitBoundary({
      memberId,
      turnId: turn.turnId,
      landedMessageIds: landed ? turn.messageIds : [],
      carriedMessageIds: turn.messageIds,
    });
    return true;
  }

  /** lead 回执折叠：回执文件变化 → 边界事件（runtime → mailbox.observeDelivery → markDelivered）。 */
  private foldLeadReceipts(force: boolean): void {
    const paths = memberPaths(this.teamDir, this.opts.teamId);
    let mtimeMs: number | null = null;
    try {
      mtimeMs = fs.statSync(paths.receiptsFile).mtimeMs;
    } catch {
      mtimeMs = null;
    }
    if (!force && mtimeMs === this.leadReceiptsMtimeMs) return;
    this.leadReceiptsMtimeMs = mtimeMs;
    if (mtimeMs === null) return;
    const ids = [...receiptMessageIds(paths)];
    if (ids.length === 0) return;
    this.emitBoundary({ memberId: this.opts.teamId, landedMessageIds: ids, carriedMessageIds: ids });
  }

  // ---------------------------------------------------------------- TeammateProvider

  async startContinuable(args: {
    teamId: string;
    memberId: string;
    name: string;
    description: string;
    firstPrompt: string;
    context: "fresh" | "fork";
    signal?: AbortSignal;
  }): Promise<{ memberId: string; accepted: boolean }> {
    if (args.teamId !== this.opts.teamId) {
      throw new Error(`provider serves team ${this.opts.teamId} but spawn targets ${args.teamId}`);
    }
    const paths = memberPaths(this.teamDir, args.memberId);
    const prompt =
      args.context === "fork"
        ? buildForkFirstPrompt(this.reader, this.opts.teamId, args.firstPrompt).prompt
        : args.firstPrompt; // D2：fresh 首轮 = 任务原文逐字（无身份前缀块）

    // 0.4.0 成员模型唯一路线：child 隔离模式跟随 Lead 最新**已确认**选择（三源判定，
    // 见 resolveLeadInheritance）。解析不出 / 官方套餐 / 目录外 = 孵化前抛错（fail-fast：
    // 不产生成员、不静默回退宿主缺省冒充继承成功）。显式参数通道、usage 兜底档、分类跳过
    // 分支全部删除。legacy 模式无继承语义（CLI 工作区缺省）。
    const inheritedSelection =
      this.sessionIsolation === "child" ? this.resolveLeadInheritance() : undefined;

    // 会话隔离（stage-6）：先在宿主侧培育一个原生隐藏子会话，再以 `--resume <child>` 驱动首轮。
    // 失败 = 抛出（上游落 failed 成员）——不静默回退成会在任务栏可见的顶层会话（DSH 口径）。
    let bred: {
      anchorSessionId: string;
      childSessionId: string;
      elapsedMs: number;
      workspacePath: string;
      appliedModel?: MemberModelSelection;
    } | null = null;
    if (this.sessionIsolation === "child") {
      try {
        bred = await this.breeder.createChild({
          teamId: this.opts.teamId,
          workspacePath: this.cwd,
          ...(inheritedSelection !== undefined ? { modelSelection: inheritedSelection } : {}),
        });
      } catch (err) {
        // 继承模型被宿主拒绝 → 统一失败记录路径（成员卡诊断兜底 + 重试控制字段；主报错已从
        // spawn 返回值透出），原错误继续上抛（roster 失败路径落 failed 成员）。其他培育失败
        // 与模型无关，直接上抛。
        const message = err instanceof Error ? err.message : String(err);
        if (inheritedSelection !== undefined && /inherited model/.test(message)) {
          // 记录 reason = 中文包装（「成员模型无法继承：…」；0.4.0 起诊断断言口径）。
          this.recordModelFailure(
            paths,
            args.memberId,
            new ModelInheritanceError(`成员模型无法继承：${message}`, inheritedSelection),
            [],
            classifyApplyFailure(message),
          );
        }
        throw err;
      }
    }
    // 培育器可能从会话库解析出 Lead 的真实目录；轮次/探针必须使用同一目录。
    const spawnCwd = bred?.workspacePath ?? this.cwd;

    const origin: OriginRecord = {
      teamId: this.opts.teamId,
      memberId: args.memberId,
      name: args.name,
      provider: args.context === "fork" ? "fork" : "spawn",
      mode: "continuable",
      context: args.context,
      createdAt: iso(this.now()),
      cwd: spawnCwd,
      firstPromptText: prompt,
      firstPromptSha256: sha256(prompt),
      sessionId: bred?.childSessionId ?? null,
      initialUserMessageAccepted: false,
      // 只记实际生效者（createChild 失败即抛，走到这里 appliedModel 与继承选择一致或 legacy 无）。
      ...(bred?.appliedModel !== undefined
        ? { modelSelection: bred.appliedModel, modelSource: "inherited" as const }
        : {}),
      sessionIsolation: bred !== null ? "child" : "legacy",
      ...(bred !== null
        ? {
            anchorSessionId: bred.anchorSessionId,
            logicalParentSessionId: this.opts.teamId,
            sessionKind: "selection_side_chat" as const,
          }
        : { sessionKind: "interactive" as const }),
    };
    writeOrigin(paths, origin); // 落盘先于投递（接口草案 §1 冻结纪律）

    const spawnT0 = this.now();
    const turn = await this.launchTurn({
      paths,
      memberId: args.memberId,
      name: args.name,
      kind: "first",
      messageIds: [],
      promptText: prompt,
      sessionId: bred?.childSessionId ?? null,
      resume: bred !== null,
      cwd: spawnCwd,
      // createChild 刚把继承选择应用进子会话（0.4.1 验收：首轮不重复应用同一选择）。
      modelJustApplied: bred?.appliedModel !== undefined,
    });
    this.startWatcher();

    try {
      const sessionId = await this.awaitFirstAccept({
        paths,
        origin,
        turn,
        spawnT0,
        signal: args.signal,
      });
      return { memberId: args.memberId, accepted: sessionId !== null };
    } catch (err) {
      if (args.signal?.aborted) throw err;
      // 探针异常（db 读失败等）→ 按未持久接收处理（上游 TEAM_PROVISIONING_CONFLICT / 失败路径）
      this.log({ ts: iso(this.now()), kind: "first-probe-error", memberId: args.memberId, error: errText(err) });
      return { memberId: args.memberId, accepted: false };
    }
  }

  /** 首轮持久接收探针：session id 认领（hook 领地优先，db 目录+首条用户文本兜底）+ 落库确认。 */
  private async awaitFirstAccept(args: {
    paths: MemberPaths;
    origin: OriginRecord;
    turn: TurnRecord;
    spawnT0: number;
    signal?: AbortSignal;
  }): Promise<string | null> {
    const { paths, origin, turn, spawnT0 } = args;
    const deadline = spawnT0 + this.firstTurnTimeoutMs;
    // 隔离模式：session id 在孵化前已确定（隐藏子会话）→ 直接以它为探针目标；
    // 旧模式（legacy）仍走 hook 领地 / db 首条文本兜底认领。
    let sessionId: string | null = origin.sessionId;
    for (;;) {
      if (args.signal?.aborted) throw args.signal.reason ?? new Error("aborted");
      sessionId ??= this.claimedSessionId(origin.memberId);
      if (sessionId === null) {
        const exclude = this.claimedSessionsExcluding(origin.memberId);
        const found = this.reader.findSessionByFirstPrompt({
          cwd: origin.cwd,
          firstPrompt: origin.firstPromptText,
          sinceMs: spawnT0,
          ...(exclude.size > 0 ? { excludeSessionIds: exclude } : {}),
        });
        if (found !== undefined) sessionId = found;
      }
      if (sessionId !== null) {
        const landed = this.reader.hasUserText(sessionId, origin.firstPromptText);
        if (landed) {
          // 再读一次 origin：同步/恢复对账可能已写入 modelSelection（不覆盖）。
          const nextOrigin: OriginRecord = {
            ...(readOrigin(paths) ?? origin),
            sessionId,
            initialUserMessageAccepted: true,
          };
          writeOrigin(paths, nextOrigin);
          const current = readTurn(paths.runDir, turn.turnId) ?? turn;
          writeTurn(paths.runDir, { ...current, sessionId, landed: true });
          this.writeTeammateMapping(sessionId, nextOrigin);
          this.log({
            ts: iso(this.now()),
            kind: "first-accepted",
            teamId: this.opts.teamId,
            memberId: origin.memberId,
            turnId: turn.turnId,
            sessionId,
            ms: this.now() - spawnT0,
          });
          return sessionId;
        }
      }
      const turnNow = readTurn(paths.runDir, turn.turnId);
      const pid = turnNow?.pid ?? turn.pid;
      if (pid === null || !pidAlive(pid)) {
        // 进程已死仍未落库 → 未持久接收（F04：进程起但会话未落）
        this.log({
          ts: iso(this.now()),
          kind: "first-not-accepted",
          teamId: this.opts.teamId,
          memberId: origin.memberId,
          turnId: turn.turnId,
          sessionId,
        });
        return null;
      }
      if (this.now() >= deadline) {
        await killProcessGroup(turnNow?.pgid ?? turn.pgid, this.termGraceMs).catch(() => undefined);
        this.log({
          ts: iso(this.now()),
          kind: "first-probe-timeout",
          teamId: this.opts.teamId,
          memberId: origin.memberId,
          turnId: turn.turnId,
        });
        return null;
      }
      await this.sleep(150);
    }
  }

  async deliver(args: { memberId: string; framedMessage: string; messageId: string }): Promise<"accepted" | "queued"> {
    const debug = process.env.TEAM_DEBUG_DELIVERY === "1";
    const paths = memberPaths(this.teamDir, args.memberId);
    const origin = readOrigin(paths);
    if (origin === undefined) {
      if (debug) this.log({ ts: iso(this.now()), kind: "deliver-deferred", memberId: args.memberId, reason: "no-origin" });
      return "queued"; // 无供给记录（冷目标）→ 滞留（宁滞留不重复）
    }
    if (this.containsMessage(args.memberId, args.messageId)) return "accepted"; // 崩溃在收/认之间 → 去重

    const current = this.currentRunningTurn(paths);
    if (current !== null) {
      if (debug) this.log({ ts: iso(this.now()), kind: "deliver-deferred", memberId: args.memberId, reason: "running", turnId: current.turnId });
      return "queued"; // 运行中一律 queued（-32010 等价：不做无谓尝试）
    }

    const sessionId = origin.sessionId ?? this.resolveSessionId(origin);
    if (sessionId === null) {
      if (debug) this.log({ ts: iso(this.now()), kind: "deliver-deferred", memberId: args.memberId, reason: "session-unsettled" });
      return "queued"; // 会话未落定 → 滞留待恢复对账
    }

    if (this.now() - this.lastLaunchFailureAt < this.relaunchBackoffMs && this.lastLaunchFailureAt > 0) {
      if (debug) this.log({ ts: iso(this.now()), kind: "deliver-deferred", memberId: args.memberId, reason: "launch-backoff" });
      return "queued"; // 拉起退避（防 respawn 循环）
    }

    // pending 依序合并（一轮多消息，每条保留框架头）
    const batchRaw =
      this.pendingLookup !== null
        ? this.pendingLookup(args.memberId)
        : [{ messageId: args.messageId, framedJson: args.framedMessage }];
    const batch = batchRaw.filter((item) => !this.containsMessage(args.memberId, item.messageId));
    if (batch.length === 0) return "accepted";
    const { promptText } = renderFramedBatch(batch);

    const turn = await this.launchTurn({
      paths,
      memberId: args.memberId,
      name: origin.name,
      kind: "deliver",
      messageIds: batch.map((item) => item.messageId),
      promptText,
      sessionId,
      resume: true,
      cwd: origin.cwd,
    }).catch((err: unknown) => {
      // 0.4.1 重试闸拦截（后台 sweep 的重复尝试）：静默滞留（消息保留、不误标 delivered、
      // 不重复 setModel）；首次失败仍上抛（send_message 调用方看到明确错误）。
      if (err instanceof ModelSyncSuppressedError) {
        if (debug) {
          this.log({ ts: iso(this.now()), kind: "deliver-deferred", memberId: args.memberId, reason: "model-sync-suppressed" });
        }
        return null;
      }
      throw err;
    });
    if (turn === null) return "queued";
    this.startWatcher();

    const deadline = this.now() + this.deliverConfirmMs;
    for (;;) {
      if (this.reader.hasUserText(sessionId, promptText)) {
        const current2 = readTurn(paths.runDir, turn.turnId) ?? turn;
        writeTurn(paths.runDir, { ...current2, landed: true });
        this.log({
          ts: iso(this.now()),
          kind: "deliver-landed",
          teamId: this.opts.teamId,
          memberId: args.memberId,
          turnId: turn.turnId,
          messageIds: current2.messageIds,
        });
        return "accepted";
      }
      const turnNow = readTurn(paths.runDir, turn.turnId);
      const pid = turnNow?.pid ?? turn.pid;
      if (pid === null || !pidAlive(pid)) {
        // 未落库即退出 → 滞留 pending（边界事件已/将由 watcher 定案）
        this.lastLaunchFailureAt = this.now();
        return "queued";
      }
      if (this.now() >= deadline) {
        return "queued"; // 慢启动：保持 pending，边界（退出/下轮）补认——不重复拉起
      }
      await this.sleep(150);
    }
  }

  async interrupt(args: { memberId: string }): Promise<{ previousStatus: string }> {
    const paths = memberPaths(this.teamDir, args.memberId);
    const current = this.currentRunningTurn(paths);
    const previousStatus = current !== null ? "running" : "inactive"; // 采样先行（§5.6）
    if (current === null) return { previousStatus };
    // 先落 intent 但保持 status=running（currentRunningTurn 仍视为 live，禁止并发 resume）。
    writeTurn(paths.runDir, { ...current, interruptRequestedAt: iso(this.now()) });
    let dead: boolean;
    try {
      dead = await killProcessGroup(current.pgid, this.termGraceMs);
    } catch (err) {
      writeTurn(paths.runDir, { ...current });
      throw err;
    }
    if (!dead) {
      writeTurn(paths.runDir, { ...current });
      throw new Error(`interrupt failed: process group ${String(current.pgid)} is still alive`);
    }
    const finalTurn = readTurn(paths.runDir, current.turnId) ?? current;
    const landed =
      finalTurn.sessionId !== null && this.reader.hasUserText(finalTurn.sessionId, finalTurn.promptText);
    writeTurn(paths.runDir, { ...finalTurn, status: "interrupted", exitedAt: iso(this.now()), landed });
    this.log({
      ts: iso(this.now()),
      kind: "interrupt",
      teamId: this.opts.teamId,
      memberId: args.memberId,
      turnId: current.turnId,
      previousStatus,
      dead,
      landed,
    });
    this.emitBoundary({
      memberId: args.memberId,
      turnId: current.turnId,
      landedMessageIds: landed ? current.messageIds : [],
      carriedMessageIds: current.messageIds,
    });
    return { previousStatus };
  }

  async drain(args: { teamId: string; timeoutMs: number }): Promise<void> {
    const memberIds = listMembers(this.teamDir);
    if (this.drainPolicy === "keep") {
      // D9 休眠态默认：只落 drain 标记（宽限 ~260ms 内可完成）；轮次进程保留待唤醒
      for (const memberId of memberIds) {
        const paths = memberPaths(this.teamDir, memberId);
        const current = readCurrentTurnId(paths);
        if (current === undefined) continue;
        writeJsonAtomic(paths.drainMarkerFile, { policy: "keep", requestedAt: iso(this.now()), turnId: current });
      }
      this.log({ ts: iso(this.now()), kind: "drain-keep", teamId: this.opts.teamId, members: memberIds.length });
      return;
    }
    // kill 策略：§12 完整 drain（SIGTERM→宽限→SIGKILL，限时）
    const grace = Math.max(200, Math.min(this.termGraceMs, Math.floor(args.timeoutMs * 0.6)));
    const failures: string[] = [];
    for (const memberId of memberIds) {
      const paths = memberPaths(this.teamDir, memberId);
      const turnId = readCurrentTurnId(paths);
      if (turnId === undefined) continue;
      const turn = readTurn(paths.runDir, turnId);
      if (turn === undefined || (turn.status !== "running" && turn.status !== "starting")) continue;
      const dead = await killProcessGroup(turn.pgid, grace);
      if (!dead) failures.push(`${memberId}/${turn.turnId}`);
      else {
        const landed =
          turn.sessionId !== null && this.reader.hasUserText(turn.sessionId, turn.promptText);
        writeTurn(paths.runDir, { ...turn, status: "exited", exitedAt: iso(this.now()), landed });
      }
    }
    this.log({ ts: iso(this.now()), kind: "drain-kill", teamId: this.opts.teamId, failures: failures.length });
    if (failures.length > 0) {
      throw new Error(`drain left ${failures.length} turn process(es) alive: ${failures.join(", ")}`);
    }
  }

  // ---------------------------------------------------------------- ReconciliationSource / TargetInspector / 呈现

  readProvisioningRecord(memberId: string): ProvisioningRecord | undefined {
    const paths = memberPaths(this.teamDir, memberId);
    const origin = readOrigin(paths); // 损坏 → 抛错 → `child Session recovery failed: …`
    if (origin === undefined) return undefined; // → `provisioning did not leave a resumable child Session`
    let sessionId = origin.sessionId;
    if (sessionId === null) {
      sessionId = this.resolveSessionId(origin); // 冷启动补探（hook 认领 → db 兜底）
      if (sessionId !== null) {
        writeOrigin(paths, { ...origin, sessionId }); // 回填：后续读/投递直接命中
      }
    }
    // 四条件中可独立验证的部分：会话行存在、隔离类型/parent 匹配、目录匹配、首条 real_user
    // 文本逐字等于 origin.firstPromptText。origin 的 accepted 标志不再单独采信（避免自证）。
    if (sessionId === null) {
      // origin 存在但会话未落定/未解析：结构条件不满足（不是“无 origin”）。
      return {
        rootSessionId: origin.teamId,
        descriptor: { provider: origin.provider, mode: origin.mode },
        initialUserMessageAccepted: false,
      };
    }
    const session = this.reader.session(sessionId);
    if (session === undefined) {
      return {
        rootSessionId: origin.teamId,
        descriptor: { provider: origin.provider, mode: origin.mode },
        initialUserMessageAccepted: false,
      };
    }
    // task_type 是宿主内部字段；旧库/夹具可能缺失 → 仅在字段在场时校验类型/父子。
    const typeKnown = typeof session.task_type === "string" && session.task_type.length > 0;
    const structureOk = !typeKnown
      ? true
      : origin.sessionIsolation === "child"
        ? session.task_type === "selection_side_chat" &&
          (origin.anchorSessionId === undefined || session.parent_id === origin.anchorSessionId)
        : session.task_type === "interactive";
    const directoryOk =
      typeof session.directory !== "string" || session.directory.length === 0
        ? true
        : session.directory === origin.cwd;
    const firstText = this.reader.firstRealUserText(sessionId);
    const accepted =
      structureOk && directoryOk && firstText !== undefined && firstText === origin.firstPromptText;
    return {
      rootSessionId: origin.teamId,
      descriptor: { provider: origin.provider, mode: origin.mode },
      initialUserMessageAccepted: accepted,
    };
  }

  isAlive(memberId: string): boolean {
    const paths = memberPaths(this.teamDir, memberId);
    return this.currentRunningTurn(paths) !== null;
  }

  containsMessage(memberId: string, messageId: string): boolean {
    if (memberId === this.opts.teamId) {
      return receiptMessageIds(memberPaths(this.teamDir, memberId)).has(messageId);
    }
    const paths = memberPaths(this.teamDir, memberId);
    for (const turn of listTurns(paths.runDir)) {
      if (!turn.messageIds.includes(messageId)) continue;
      if (turn.landed === true) return true;
      if (turn.sessionId !== null && this.reader.hasUserText(turn.sessionId, turn.promptText)) return true;
      return false; // 本轮携带过但未落库 → 未接收
    }
    return false;
  }

  readColdRecord(memberId: string, messageId: string): { recorded: boolean } | undefined {
    const origin = readOrigin(memberPaths(this.teamDir, memberId));
    if (origin === undefined) return undefined;
    return { recorded: this.containsMessage(memberId, messageId) };
  }

  statusOf(memberId: string): "running" | "inactive" {
    return this.isAlive(memberId) ? "running" : "inactive";
  }

  modelOf(memberId: string): string | undefined {
    const origin = readOrigin(memberPaths(this.teamDir, memberId));
    if (origin === undefined) return undefined;
    // 实查优先（消息里的 modelSelection）→ origin 配置值（显式/继承记录）→ 旧 model 字符串。
    const observed = origin.sessionId !== null ? this.reader.latestModel(origin.sessionId) : undefined;
    return observed ?? origin.modelSelection?.modelId ?? origin.model;
  }

  /** Lead 行模型（roster Lead 伪行）：Lead 会话最近消息实查 → model_usage 兜底。 */
  leadModelOf(): string | undefined {
    return this.reader.latestModel(this.opts.teamId) ?? this.reader.latestModelUsage(this.opts.teamId)?.modelId;
  }

  /** Lead 当前结构化选择（成员卡/roster 展示用；0.4.0 = 三源判定的可继承选择，可能 undefined）。 */
  leadModelSelectionOf(): MemberModelSelection | undefined {
    return this.resolveLeadInheritance({ throwOnUnusable: false });
  }

  // 0.4.0 注销 setMemberModel：成员模型不存在独立配置通道（唯一路线 = 每轮跟随 Lead）。

  // ---------------------------------------------------------------- hook 回执（Lead 投递 landed 依据）

  /** hook 注入成功后落回执（hooks 进程与协调者双写者安全：O_APPEND+fsync）。 */
  recordLeadReceipts(messageIds: ReadonlyArray<string>, channel: "stop" | "userpromptsubmit" | "sessionstart"): void {
    const paths = memberPaths(this.teamDir, this.opts.teamId);
    for (const messageId of messageIds) {
      appendReceipt(paths, { messageId, channel, ts: iso(this.now()) });
    }
    this.log({ ts: iso(this.now()), kind: "lead-receipt", teamId: this.opts.teamId, channel, messageIds: [...messageIds] });
  }

  /** Stop 预算（≤3 次/run；runKey 复位语义见 hooks）。 */
  consumeStopBudget(memberId: string, runKey: string): boolean {
    const paths = memberPaths(this.teamDir, memberId);
    const current = readStopBudget(paths);
    const budget = current !== undefined && current.runKey === runKey ? current : { runKey, blocks: 0 };
    if (budget.blocks >= 3) {
      writeStopBudget(paths, budget);
      return false;
    }
    writeStopBudget(paths, { runKey, blocks: budget.blocks + 1 });
    return true;
  }

  /**
   * 空闲 Lead 唤醒（灰度）：只在 TEAM_WAKE_LEAD=1、Lead 回合状态为 inactive 且空闲超阈值时
   * 拉起一个“处理收件箱”的 --resume 回合。返回 woke=false 时调用方必须保持 pending。
   */
  wakeLead(): Promise<LeadWakeResult> {
    if (!leadWakeEnabled()) return Promise.resolve({ woke: false, reason: "disabled" });
    return maybeWakeLead({
      teamDir: this.teamDir,
      leadSessionId: this.opts.teamId,
      cwd: this.cwd,
      zcode: this.zcode,
      minIdleMs: this.leadWakeMinIdleMs,
      now: this.now(),
    });
  }

  close(): void {
    this.detach();
    this.reader.close();
  }

  // ---------------------------------------------------------------- 内部

  /** 孵化一轮（turn 记录先落盘 → spawn → 回填 pid/running）。 */
  private async launchTurn(args: {
    paths: MemberPaths;
    memberId: string;
    name: string;
    kind: "first" | "deliver";
    messageIds: string[];
    promptText: string;
    sessionId: string | null;
    resume: boolean;
    cwd?: string;
    /**
     * createChild 刚成功应用了继承模型（首轮）：跳过轮前同步（验收口径「首轮已由
     * createChild 正确设置模型 → 不重复应用同一选择」）。仅 startContinuable 传 true。
     */
    modelJustApplied?: boolean;
  }): Promise<TurnRecord> {
    const turnId = nextTurnId(args.paths.runDir);
    const stdoutFile = path.join(args.paths.runDir, `${turnId}.out`);
    const turnCwd = args.cwd ?? this.cwd;
    // 0.4.0 执行前同步（每轮唯一入口，覆盖续跑/恢复）：Lead 最新已确认选择与成员
    // 宿主实际选择不一致 → 先 setModel 再启动本轮；失败 = 抛错阻止本轮（绝不带着旧模型
    // 或宿主缺省悄悄开跑）。Lead 已切官方套餐同样阻止并报错——「同步失败即明确报告」。
    // 0.4.1：携带本轮消息 id（失败记录做「新消息解锁重试」判定）；首轮由 createChild 定模时跳过。
    if (args.modelJustApplied !== true) {
      await this.syncMemberModel(args.paths, args.memberId, args.sessionId, turnCwd, args.messageIds);
    }
    const scriptArgs = [
      ...this.zcode.argvPrefix,
      "-p",
      args.promptText,
      "--json",
      "--mode",
      "yolo",
      "--surface",
      "terminal",
      "--disallowed-tools",
      "Task", // D6
      "--cwd",
      turnCwd,
      ...(args.resume && args.sessionId !== null ? ["--resume", args.sessionId] : []),
    ];
    const turn: TurnRecord = {
      turnId,
      memberId: args.memberId,
      kind: args.kind,
      sessionId: args.sessionId,
      messageIds: args.messageIds,
      promptText: args.promptText,
      argv: scriptArgs,
      pid: null,
      pgid: null,
      status: "starting",
      startedAt: iso(this.now()),
      stdoutFile,
    };
    writeTurn(args.paths.runDir, turn); // 落盘先于孵化（恰一次锚点）
    setCurrentTurn(args.paths, turnId);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TEAM_SPAWN_IDENTITY: JSON.stringify({
        teamId: this.opts.teamId,
        memberId: args.memberId,
        name: args.name,
      }),
    };
    if (this.opts.dbPath !== undefined) env.TEAM_DB_PATH = this.opts.dbPath;

    let spawned;
    try {
      spawned = await spawnDetached({
        command: this.zcode.command,
        argv: scriptArgs,
        // 真实 env 必须完整传给子进程（API key 等）；spec 只短暂存在（helper 读后立即删除，0600）。
        env,
        cwd: turnCwd,
        stdoutFile,
      });
    } catch (err) {
      writeTurn(args.paths.runDir, { ...turn, status: "spawn-error", exitedAt: iso(this.now()), exitCode: null });
      this.lastLaunchFailureAt = this.now();
      this.log({ ts: iso(this.now()), kind: "spawn-error", teamId: this.opts.teamId, memberId: args.memberId, turnId, error: errText(err) });
      throw err;
    }
    const running: TurnRecord = { ...turn, pid: spawned.pid, pgid: spawned.pgid, status: "running" };
    writeTurn(args.paths.runDir, running);
    if (spawned.pid !== null) this.adoptedPids.add(spawned.pid);
    this.log({
      ts: iso(this.now()),
      kind: "turn-launch",
      teamId: this.opts.teamId,
      memberId: args.memberId,
      turnId,
      kindOfTurn: args.kind,
      pid: spawned.pid,
      messageIds: args.messageIds,
      resume: args.resume,
      // 只记 flag 名；prompt/session id/cwd 值不落 provider.jsonl（隐私/体积）。
      argv: [path.basename(scriptArgs[0] ?? ""), ...scriptArgs.slice(1).map((a) => (a.startsWith("--") ? a : "<redacted>"))],
    });
    return running;
  }

  /** 当前「running 且进程存活」的轮次；无 → null。 */
  private currentRunningTurn(paths: MemberPaths): TurnRecord | null {
    const turnId = readCurrentTurnId(paths);
    if (turnId === undefined) return null;
    const turn = readTurn(paths.runDir, turnId);
    if (turn === undefined) return null;
    if (turn.status !== "running" && turn.status !== "starting") return null;
    if (turn.pid === null || !pidAlive(turn.pid)) return null;
    return turn;
  }

  /** 会话 id 认领：session-map（teammate SessionStart hook 经 TEAM_SPAWN_IDENTITY 落的映射）。 */
  private claimedSessionId(memberId: string): string | null {
    for (const entry of Object.values(readSessionRegistry(this.opts.dataRoot))) {
      if (entry.memberId === memberId && typeof entry.session_id === "string") return entry.session_id;
    }
    return null;
  }

  private claimedSessionsExcluding(memberId: string): Set<string> {
    const set = new Set<string>();
    for (const entry of Object.values(readSessionRegistry(this.opts.dataRoot))) {
      if (entry.memberId !== undefined && entry.memberId !== memberId && typeof entry.session_id === "string") {
        set.add(entry.session_id);
      }
    }
    return set;
  }

  private resolveSessionId(origin: OriginRecord): string | null {
    const claimed = this.claimedSessionId(origin.memberId);
    if (claimed !== null) return claimed;
    const createdAtMs = Date.parse(origin.createdAt);
    return (
      this.reader.findSessionByFirstPrompt({
      cwd: origin.cwd,
        firstPrompt: origin.firstPromptText,
        sinceMs: Number.isNaN(createdAtMs) ? 0 : createdAtMs,
        excludeSessionIds: this.claimedSessionsExcluding(origin.memberId),
      }) ?? null
    );
  }

  /** 档位缺省（已有则不覆盖）：目录 defaultVariant → "max"（E-1b 统一落点）。 */
  private withReasoningDefault(selection: MemberModelSelection): MemberModelSelection {
    return applyReasoningDefault(this.modelCatalog(), selection);
  }

  /**
   * Lead 最新**已确认**模型选择（0.4.0 三源判定；成员跟随 Lead 的唯一解析入口）。
   *
   * 三源各带时间戳，取最新者（epoch ms）：
   *   1. real_user 提交快照 —— 宿主在保存用户消息时写入该次提交的 modelSelection，
   *      输入框切换在提交瞬间即体现在这里（issue #7 不影响本源：它不刷新 entry，但刷得动消息快照）；
   *   2. session_entry —— `/model` 命令等会话选模记录（time_updated 识别「提交后的修改」）；
   *   3. main_turn 实际调用 —— `query_source='main_turn'` 严格过滤，compact/标题/subagent/
   *      workflow 等辅助行绝不能当作 Lead 模型（本机实测取值域已核验）。
   *
   * 判出后按目录分类：官方套餐（`account:`/`builtin:` 前缀）或目录外（provider/model 不存在
   * 或被禁用）= 不可继承。`throwOnUnusable`（缺省 true）：
   *   - true：spawn/每轮同步入口 —— 不可继承或三源全空 → 抛 ModelInheritanceError（明确报告，
   *     绝不静默回退宿主缺省冒充继承成功）；
   *   - false：展示口径（Lead 伪行模型）—— 返回 undefined 交回退链处理。
   * 空目录守卫：目录不可读 = 无法分类 → 不过滤（照旧尝试，宿主 setModel 终审）。
   */
  private resolveLeadInheritance(options?: { throwOnUnusable?: boolean }): MemberModelSelection | undefined {
    const throwOnUnusable = options?.throwOnUnusable !== false;
    const sources = [
      this.reader.latestSubmissionSelection(this.opts.teamId),
      this.reader.latestModelSelectionTimed(this.opts.teamId),
      this.reader.latestMainTurnUsage(this.opts.teamId),
    ].filter((source): source is NonNullable<typeof source> => source !== undefined);
    let latest: MemberModelSelection | undefined;
    if (sources.length > 0) {
      const winner = sources.reduce((a, b) => (b.at > a.at ? b : a));
      latest = winner.selection;
    }
    if (latest === undefined) {
      if (!throwOnUnusable) return undefined;
      throw new ModelInheritanceError(
        "无法确定 Lead 当前模型（会话库中没有提交快照、选模记录或主轮调用），成员无法继承。",
      );
    }
    const model = `${latest.providerId}/${latest.modelId}`;
    const isOfficialPlan =
      latest.providerId.startsWith("account:") || latest.providerId.startsWith("builtin:");
    if (isOfficialPlan) {
      if (!throwOnUnusable) return undefined;
      throw new ModelInheritanceError(
        `Lead 当前使用官方套餐模型（${model}），成员无法继承（CLI 进程拿不到订阅套餐凭据）。` +
          "请在 ZCode 中切换到自配的第三方模型后重试。",
        latest,
      );
    }
    const catalog = this.modelCatalog();
    if (catalog.providers.length > 0 && !catalogSupports(catalog, latest)) {
      if (!throwOnUnusable) return undefined;
      throw new ModelInheritanceError(
        `Lead 模型 ${model} 不在可用模型目录（Provider 已删除/禁用，或模型不存在），成员无法继承。`,
        latest,
      );
    }
    return this.withReasoningDefault(latest);
  }

  /**
   * 每轮执行前同步（0.4.0；0.4.1 修正一致性判断与重试控制）：
   * Lead 最新已确认选择 ≠ 成员**宿主实际**选择 → setModel 后再启动本轮。
   * - 一致性判断以宿主会话实际状态为准（session_entry → main_turn usage 实查）；
   *   origin.modelSelection 只是辅助记录（setModel 成功后 origin 更新前崩溃 → 宿主为准，
   *   不能因 origin 相同就放行）。实际状态无法确认（首轮前无任何记录）→ 重新应用 Lead
   *   选择（宁多一次 setModel，不带着未确认的模型开跑）。
   * - 确认一致 → 清除旧失败记录（验证成功才清；不因 Lead 改了配置就清）+ 零 RPC。
   * - 应用失败 / Lead 不可继承：写统一失败记录（含类别/尝试次数/退避闸/Lead 指纹/消息 id）
   *   + 抛 ModelInheritanceError 阻止本轮 —— 绝不带着旧模型或宿主缺省悄悄开跑。
   * - legacy 隔离模式 / 会话未落定（首轮由 createChild 定模）：跳过。
   *
   * `trigger`：本轮携带的待投递消息 id（失败记录里做「新消息解锁重试」判定；首轮 = []）。
   */
  private async syncMemberModel(
    paths: MemberPaths,
    memberId: string,
    sessionId: string | null,
    workspacePath: string,
    triggerMessageIds: readonly string[] = [],
  ): Promise<void> {
    if (this.sessionIsolation !== "child" || sessionId === null) return;
    let lead: MemberModelSelection | undefined;
    try {
      // 不可继承 = 抛（launchTurn 调用方看到明确错误）；同时落统一失败记录（可见性）。
      // 重试闸先行：同一目标的解析失败已有记录且未到重试时机 → 静默滞留（后台 sweep
      // 不再每 2s 重新抛给 mailbox）。
      lead = this.resolveLeadInheritance();
    } catch (err) {
      if (err instanceof ModelInheritanceError) {
        const selection = err.selection;
        const gate = this.retryGate(paths, selection, triggerMessageIds);
        if (!gate.allow) {
          this.log({
            ts: iso(this.now()),
            kind: "model-sync-suppressed",
            teamId: this.opts.teamId,
            memberId,
            reason: gate.reason,
          });
          throw new ModelSyncSuppressedError(err.message, selection);
        }
        this.recordModelFailure(paths, memberId, err, triggerMessageIds);
      }
      throw err;
    }
    // 档位缺省链已在 resolveLeadInheritance 内应用；此处防御性兜底（undefined 时不动作）
    if (lead === undefined) return;

    // 0.4.1 一致性判断：宿主实际状态优先（entry = setModel/--resume 的生效锚点；
    // main_turn usage = 实际调用证据）。origin.modelSelection 只是辅助记录——宿主实际
    // 选择无法确认时（observed=undefined，如刚恢复），即便 origin 记过同一选择也重新
    // 应用（宁多一次 setModel，不带着未确认状态放行），故此处不做 origin 短路。
    const observed =
      this.reader.latestModelSelection(sessionId) ??
      this.reader.latestMainTurnUsage(sessionId)?.selection;
    if (observed !== undefined && sameModelSelection(observed, lead)) {
      // 宿主实际状态已确认与 Lead 一致 = 验证成功 → 清除旧失败提示（修复4），不打扰宿主。
      this.clearFailureIfVerified(paths);
      // origin 落后于宿主实际状态（setModel 成功后、origin 更新前崩溃）→ 修复辅助记录，
      // 保持展示/审计一致（零 RPC，只是文件写）。
      const originNow = readOrigin(paths);
      if (
        originNow !== undefined &&
        (originNow.modelSelection === undefined || !sameModelSelection(originNow.modelSelection, lead))
      ) {
        writeOrigin(paths, { ...originNow, modelSelection: lead, modelSource: "inherited" });
      }
      return;
    }
    const origin = readOrigin(paths);

    // 0.4.1 重试控制闸：同一 Lead 选择下的既有失败记录，按类别决定是否允许本次自动尝试。
    // 显式意图（Lead 换模 / 用户再次明确发送**新**消息）不受闸限制。拦截 = 抛
    // ModelSyncSuppressedError：deliver 捕获后按 "queued" 滞留（消息保留、不误标 delivered、
    // 不重复 setModel；后台 sweep 的重复尝试不再每 2s 打一次宿主）。首次失败仍是
    // ModelInheritanceError 原样上抛（send_message 调用方看到明确错误）。
    const gate = this.retryGate(paths, lead, triggerMessageIds);
    if (!gate.allow) {
      this.log({
        ts: iso(this.now()),
        kind: "model-sync-suppressed",
        teamId: this.opts.teamId,
        memberId,
        reason: gate.reason,
      });
      throw new ModelSyncSuppressedError(
        `成员 "${memberId}" 与 Lead 模型（${lead.providerId}/${lead.modelId}）不一致，上一次同步失败尚未到重试时机：${gate.reason}`,
        lead,
      );
    }

    const result = await this.applySelectionNow(sessionId, workspacePath, lead, memberId);
    if (!result.applied) {
      const reason = result.reason ?? "model was rejected by the host";
      const err = new ModelInheritanceError(
        `成员 "${memberId}" 无法同步 Lead 模型（${lead.providerId}/${lead.modelId}）：${reason}`,
        lead,
      );
      // 记录里存宿主原始拒绝原因（不含成员 id/模型前缀）——诊断面已含 `prov/model`，
      // reason 留给「为什么被拒」（截断 80 时优先保留宿主文本，而非包装前缀）。
      this.recordModelFailure(paths, memberId, err, triggerMessageIds, classifyApplyFailure(reason), reason);
      throw err;
    }
    // 同步成功后才更新 origin（不谎报；崩溃在两者之间 → 下次以宿主实际状态判断，见上）。
    if (origin !== undefined) {
      writeOrigin(paths, { ...(readOrigin(paths) ?? origin), modelSelection: lead, modelSource: "inherited" });
    }
    this.clearFailureIfVerified(paths);
    this.log({
      ts: iso(this.now()),
      kind: "model-synced",
      teamId: this.opts.teamId,
      memberId,
      providerId: lead.providerId,
      modelId: lead.modelId,
      reasoningLevel: lead.reasoningLevel ?? null,
    });
  }

  /**
   * 自动重试闸（0.4.1）：读失败记录，判定本次同步尝试是否放行。
   * - 无记录 / Lead 选择已变（指纹不同）→ 放行（换模 = 重新尝试的显式信号）。
   * - 新消息解锁：trigger 里有记录 messageIds 之外的**新** id → 放行（用户再次明确发送）。
   * - deterministic（含 0.4.0 旧记录无 kind）→ 暂停相同选择的自动重试（拒绝）。
   * - transient → 未到 nextAttemptAt 拒绝；到期且 attempts ≤ 退避序列长度放行；
   *   序列耗尽 → 停止自动尝试（拒绝）。
   * `lead` 缺省 = 解析失败（三源全空，无选择指纹）——按记录的 leadSignature 缺省口径同目标。
   */
  private retryGate(
    paths: MemberPaths,
    lead: MemberModelSelection | undefined,
    triggerMessageIds: readonly string[],
  ): { allow: boolean; reason: string; record?: ModelFailedRecord } {
    let record: ModelFailedRecord | undefined;
    try {
      record = readModelFailed(paths);
    } catch {
      record = undefined; // 损坏记录不阻塞同步（尝试后会被新记录覆盖）
    }
    if (record === undefined) return { allow: true, reason: "" };
    const signature = lead !== undefined ? selectionSignature(lead) : undefined;
    if (record.leadSignature !== signature) {
      return { allow: true, reason: "" }; // Lead 已换选择 → 解锁
    }
    const known = new Set(record.messageIds ?? []);
    const hasNewMessage = triggerMessageIds.some((id) => !known.has(id));
    if (hasNewMessage) {
      return { allow: true, reason: "", record }; // 用户再次明确发送 → 解锁（尝试会刷新记录）
    }
    const kind = record.kind ?? "deterministic"; // 0.4.0 旧记录 → 保守按确定性处理
    if (kind === "deterministic") {
      return {
        allow: false,
        reason: `相同选择的同步已被确定性拒绝（${record.reason}），等待 Lead 切换可用模型或新消息后重试`,
        record,
      };
    }
    const attempts = record.attempts ?? 1;
    const nextAt = record.nextAttemptAt;
    if (nextAt !== undefined && this.now() < nextAt) {
      return {
        allow: false,
        reason: `临时故障退避中（第 ${attempts} 次尝试已失败），${Math.ceil((nextAt - this.now()) / 1000)}s 后自动重试`,
        record,
      };
    }
    if (attempts > this.modelRetryBackoffMs.length) {
      return {
        allow: false,
        reason: `临时故障已连续失败 ${attempts - 1} 次（退避序列耗尽），停止自动重试；等待 Lead 切换模型或新消息`,
        record,
      };
    }
    return { allow: true, reason: "", record };
  }

  /**
   * 统一失败记录路径（0.4.1）：解析失败（throwOnUnusable 抛出的 ModelInheritanceError）与
   * 宿主应用失败都落到这里——model-failed.json（成员行诊断）+ provider.jsonl + 展示刷新通知。
   * 记录携带重试控制所需全部字段（类别/次数/退避闸/Lead 指纹/触发消息 id）；不重建 pending 队列。
   */
  private recordModelFailure(
    paths: MemberPaths,
    memberId: string,
    err: ModelInheritanceError,
    triggerMessageIds: readonly string[],
    kindOverride?: "deterministic" | "transient",
    reasonOverride?: string,
  ): void {
    const now = this.now();
    let previous: ModelFailedRecord | undefined;
    try {
      previous = readModelFailed(paths);
    } catch {
      previous = undefined;
    }
    const selection = err.selection;
    const signature = selection !== undefined ? selectionSignature(selection) : undefined;
    // 同目标判定：有选择 → 指纹相同；无选择（解析失败）→ 前记录也无指纹 = 同一失败目标。
    const sameTarget =
      previous !== undefined && (previous.leadSignature ?? undefined) === signature;
    // 解析失败按消息分类（三源全空 = transient：Lead 一提交即可解；套餐/目录外 = deterministic）；
    // 应用失败由调用方 kindOverride 传入（classifyApplyFailure）。
    const kind = kindOverride ?? classifySelectionFailure(err.message);
    // attempts 只对 transient 累计（= 实际 setModel 尝试次数）；deterministic 没有自动重试，
    // 重复失败（每次 sweep 重新解析仍抛）不虚增计数。
    const attempts = sameTarget && kind === "transient" ? (previous?.attempts ?? 1) + 1 : 1;
    // 退避闸：transient 且还有下一档 → now + backoff[attempts-1]；其余 = 不再自动尝试。
    const backoff =
      kind === "transient" ? this.modelRetryBackoffMs[attempts - 1] : undefined;
    const record: ModelFailedRecord = {
      ...(selection !== undefined ? { modelSelection: selection } : {}),
      reason: compactReason(reasonOverride ?? err.message),
      failedAt: iso(now),
      kind,
      attempts,
      ...(backoff !== undefined ? { nextAttemptAt: now + backoff } : {}),
      ...(signature !== undefined ? { leadSignature: signature } : {}),
      // 触发消息 id 并集（同目标累计；新消息解锁判定用）。
      ...(() => {
        const merged = new Set([...(sameTarget ? previous?.messageIds ?? [] : []), ...triggerMessageIds]);
        return merged.size > 0 ? { messageIds: [...merged] } : {};
      })(),
    };
    writeModelFailed(paths, record);
    this.log({
      ts: iso(now),
      kind: "model-sync-failed",
      teamId: this.opts.teamId,
      memberId,
      failureKind: kind,
      attempts,
      nextAttemptAt: record.nextAttemptAt ?? null,
      providerId: selection?.providerId ?? null,
      modelId: selection?.modelId ?? null,
      reason: record.reason,
    });
    this.notifyModelFailureChanged();
  }

  /** 验证成功才清除（修复4）：失败记录存在 → 删除 + 展示刷新通知。调用点均已确认一致/应用成功。 */
  private clearFailureIfVerified(paths: MemberPaths): void {
    let existed = false;
    try {
      existed = readModelFailed(paths) !== undefined;
    } catch {
      existed = true; // 损坏记录也清（读不出诊断，留着只会持续抛错）
    }
    clearModelFailed(paths);
    if (existed) this.notifyModelFailureChanged();
  }

  /** 应用一次模型选择（每轮同步通道：临时实例 resume → setModel；失败返回原因不抛）。 */
  private async applySelectionNow(
    sessionId: string,
    workspacePath: string,
    selection: MemberModelSelection,
    memberId: string,
  ): Promise<{ applied: boolean; reason?: string }> {
    if (this.breeder.applyModelSelection === undefined) {
      this.log({ ts: iso(this.now()), kind: "model-apply-unsupported", memberId });
      return { applied: false, reason: "breeder does not support model application" };
    }
    try {
      const result = await this.breeder.applyModelSelection({ sessionId, workspacePath, selection });
      if (!result.applied) {
        this.log({
          ts: iso(this.now()),
          kind: "model-apply-failed",
          teamId: this.opts.teamId,
          memberId,
          reason: result.reason ?? "unknown",
        });
      }
      return result;
    } catch (err) {
      const reason = errText(err);
      this.log({ ts: iso(this.now()), kind: "model-apply-failed", teamId: this.opts.teamId, memberId, reason });
      return { applied: false, reason };
    }
  }

  /**
   * 成员行诊断（GitHub #6 保留面）：读 model-failed.json → 一条可读诊断。
   * 无记录/损坏 → []（损坏不阻断 list_agents；失败信息已尽力而为）。
   * 0.4.1：记录可无 modelSelection（三源全空解析不出）；transient 附重试进度提示。
   */
  diagnosticsOf(memberId: string): string[] {
    const paths = memberPaths(this.teamDir, memberId);
    let record;
    try {
      record = readModelFailed(paths);
    } catch {
      return [];
    }
    if (record === undefined) return [];
    // 落盘 reason 已截断（首句≤80），这里原样呈现。
    const reason = typeof record.reason === "string" ? record.reason : "";
    const selection = parseModelSelection(record.modelSelection);
    const head =
      selection !== undefined
        ? `成员模型继承失败：${selection.providerId}/${selection.modelId}${reason.length > 0 ? `（${reason}）` : ""}`
        : `成员模型继承失败：${reason}`;
    if ((record.kind ?? "deterministic") === "transient" && (record.attempts ?? 1) > 1) {
      return [`${head}（临时故障，已自动重试 ${record.attempts! - 1} 次）`];
    }
    return [head];
  }

  /** daemon 侧补写 teammate 映射（hook 未及写时的兜底；不覆盖已有 teammate 映射）。 */
  private writeTeammateMapping(sessionId: string, origin: OriginRecord): void {
    const registry = readSessionRegistry(this.opts.dataRoot);
    const existing = registry[sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128)];
    if (existing?.role === "teammate" && existing.memberId !== origin.memberId) return;
    upsertSessionEntry(this.opts.dataRoot, sessionId, {
      teamId: origin.teamId,
      role: "teammate",
      name: origin.name,
      memberId: origin.memberId,
    });
  }

  /** drain 标记处置（触发点②兜底）：keep → 清标记（休眠态，轮次照旧纳管）；kill → 补杀。 */
  private handleDrainMarker(paths: MemberPaths): void {
    const marker = readJson<{ policy: string; turnId?: string }>(paths.drainMarkerFile);
    if (marker === undefined) return;
    try {
      fs.unlinkSync(paths.drainMarkerFile);
    } catch {
      /* best-effort */
    }
    if (marker.policy === "kill" && marker.turnId !== undefined) {
      const turn = readTurn(paths.runDir, marker.turnId);
      if (turn !== undefined && turn.pid !== null && pidAlive(turn.pid)) {
        void killProcessGroup(turn.pgid, this.termGraceMs)
          .then((dead) => {
            writeTurn(paths.runDir, { ...turn, status: dead ? "exited" : turn.status, exitedAt: iso(this.now()) });
          })
          .catch(() => undefined);
      }
    }
  }
}

// ---------------------------------------------------------------- 辅助

function listMembers(teamDir: string): string[] {
  const membersDir = path.join(teamDir, "members");
  let names: string[];
  try {
    names = fs.readdirSync(membersDir);
  } catch {
    return [];
  }
  return names.filter((n) => !n.startsWith("."));
}

function safeDir(teamId: string): string {
  return teamId.replace(/[^A-Za-z0-9._-]/g, (c) => "~" + c.codePointAt(0)!.toString(16));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** 诊断/落盘用原因精简：取首句（含中英文句末/换行），超 80 字符截断加省略号。 */
function compactReason(reason: string): string {
  const firstLine = reason.split(/\n/)[0] ?? "";
  const firstSentence = firstLine.split(/(?<=[。！？.!?])\s*/)[0] ?? firstLine;
  return truncateReason(firstSentence.trim());
}

/** 截断 ≤80 字符（空串保持空串）。 */
function truncateReason(text: string): string {
  if (text.length === 0) return "";
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/** 三元组等价（继承链去重；reasoningLevel 缺省与显式空串视为同档）。 */
function sameModelSelection(a: MemberModelSelection, b: MemberModelSelection): boolean {
  return (
    a.providerId === b.providerId &&
    a.modelId === b.modelId &&
    (a.reasoningLevel ?? "") === (b.reasoningLevel ?? "")
  );
}

function drainPolicyFromEnv(): "keep" | "kill" {
  return process.env.TEAM_DRAIN_ON_DISPOSE === "kill" ? "kill" : "keep";
}
