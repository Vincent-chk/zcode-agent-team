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
import { applyReasoningDefault, readModelCatalog, type ModelCatalog } from "./model-catalog.js";
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
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (record: Record<string, unknown>) => void;
}

/** 培育器最小接口（依赖倒置，便于测试注入）。 */
export interface SessionBreederLike {
  createChild(input: {
    teamId: string;
    workspacePath: string;
    modelSelection?: MemberModelSelection;
    /** 主选失败后的唯一兜底（继承链第二档）；仅 primary 存在且失败才尝试。 */
    modelFallback?: MemberModelSelection;
    timeoutMs?: number;
  }): Promise<{
    anchorSessionId: string;
    childSessionId: string;
    elapsedMs: number;
    workspacePath: string;
    /** 实际生效的模型选择（primary/fallback；都失败则缺省）。 */
    appliedModel?: MemberModelSelection;
  }>;
  /** mid-life 应用（可选：测试桩可省略 → 立即应用按失败处理，落 pending）。 */
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

  /** 协调者接线（host.serve）：轮次边界监听 + pending 合并查询（mailbox 派生）。 */
  bind(hooks: { onBoundary: (event: BoundaryEvent) => void; pendingLookup: PendingLookup }): void {
    this.boundaryListeners.add(hooks.onBoundary);
    this.pendingLookup = hooks.pendingLookup;
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
    model?: string;
    /** 结构化模型选择（显式指定优先；缺省时 child 隔离模式继承 Lead）。 */
    modelSelection?: MemberModelSelection;
    /** 思考强度覆盖（合并进最终选择：显式/继承的 reasoningLevel 被它替换）。 */
    thoughtLevel?: string;
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

    // 模型选择（Round B/E-1）：显式 > 继承链 [session_entry 条目, model_usage 兜底]；仅 child 隔离
    // 模式可应用（legacy 顶层会话没有培育器 setModel 的作用点：不应用也不记录，避免 origin 谎报）。
    // 显式指定不设兜底——用户意图优先，失败仅容忍（落 CLI 缺省）。
    const explicitSelection = args.modelSelection;
    const inheritedSelections =
      this.sessionIsolation === "child" && explicitSelection === undefined
        ? this.lookupLeadModelSelections()
        : [];
    const primarySelection =
      this.sessionIsolation !== "child"
        ? undefined
        : (explicitSelection ?? inheritedSelections[0]);
    // thoughtLevel 是强度覆盖：只覆盖主选（兜底沿用其自身记录的档位，不臆造该模型不支持的强度）。
    const finalSelection =
      primarySelection !== undefined && args.thoughtLevel !== undefined
        ? { ...primarySelection, reasoningLevel: args.thoughtLevel }
        : primarySelection;
    const fallbackSelection = explicitSelection !== undefined ? undefined : inheritedSelections[1];
    // 档位缺省链（E-1b，统一落点 = provider 层）：应用前若 selection 无 reasoningLevel →
    // 目录 defaultVariant（有则用）→ "max"；后端只保留「variants 已知才校验」。
    const appliedSelection = finalSelection !== undefined ? this.withReasoningDefault(finalSelection) : undefined;
    const appliedFallback =
      fallbackSelection !== undefined ? this.withReasoningDefault(fallbackSelection) : undefined;

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
      bred = await this.breeder.createChild({
        teamId: this.opts.teamId,
        workspacePath: this.cwd,
        ...(appliedSelection !== undefined ? { modelSelection: appliedSelection } : {}),
        ...(appliedFallback !== undefined ? { modelFallback: appliedFallback } : {}),
      });
    }
    // 培育器可能从会话库解析出 Lead 的真实目录；轮次/探针必须使用同一目录。
    const spawnCwd = bred?.workspacePath ?? this.cwd;

    // GitHub #6：spawn 时模型没生效也要可见。继承降级（Lead 条目/usage 都不可用）写固定说明；
    // 显式指定失败同样落记录（用户意图未被满足，不能静默）。origin 仍只记实际生效者。
    if (bred !== null && appliedSelection !== undefined) {
      if (bred.appliedModel !== undefined) {
        clearModelFailed(paths);
      } else {
        this.writeModelFailure(
          paths,
          appliedSelection,
          explicitSelection !== undefined
            ? "指定的模型不可用于成员（registry 不识别）"
            : "Lead 模型不可用于成员（registry 不识别）",
        );
      }
    }

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
      ...(args.model !== undefined ? { model: args.model } : {}),
      // 只记**实际生效**者（BreedResult.appliedModel）：继承条目失败→usage 兜底成功时记 usage；
      // 两者都没生效则不记（origin 不谎报），modelSource 规则不变。
      ...(bred?.appliedModel !== undefined
        ? {
            modelSelection: bred.appliedModel,
            modelSource: explicitSelection !== undefined ? ("explicit" as const) : ("inherited" as const),
          }
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
          // 再读一次 origin：并发 setMemberModel/pending 应用可能已写入 modelSelection（不覆盖）。
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
    });
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

  /** Lead 当前结构化选择（backend 裸 modelId 消歧用：先 Lead 当前 provider）。 */
  leadModelSelectionOf(): MemberModelSelection | undefined {
    return this.lookupLeadModelSelection();
  }

  /**
   * stage-8 Round C · mid-life 改模型（GitHub #6 修订：单次尝试语义）：
   * - 空闲 → 立即应用；成功改 origin 并清失败记录；**失败返回 {applied:"failed", reason}**，
   *   写 model-failed.json（供成员行/弹窗展示），**不写 pending**（不再每轮静默重试）。
   * - 运行中 → 真排队 {applied:"next-turn"}；下一轮 launchTurn 前置一次应用（失败即终态）。
   * 目标会话未落定 → 抛错。
   */
  async setMemberModel(args: {
    memberId: string;
    modelSelection?: MemberModelSelection;
    thoughtLevel?: string;
  }): Promise<{ applied: "now" | "next-turn" | "failed"; reason?: string }> {
    const paths = memberPaths(this.teamDir, args.memberId);
    const origin = readOrigin(paths);
    if (origin === undefined || origin.sessionId === null) {
      throw new Error(`member session not settled: ${args.memberId}`);
    }
    const base = args.modelSelection ?? this.currentModelSelection(origin);
    if (base === undefined) {
      throw new Error(
        `member model is unknown: specify a model (providerId$modelId or a catalog model id) for ${args.memberId}`,
      );
    }
    const merged: MemberModelSelection =
      args.thoughtLevel !== undefined ? { ...base, reasoningLevel: args.thoughtLevel } : base;
    // 档位缺省链（E-1b）：只给 model 时也补出档位（deepseek-flash 等模型必带 reasoningLevel）。
    const selection = this.withReasoningDefault(merged);

    if (this.currentRunningTurn(paths) !== null) {
      this.writeModelPending(paths, selection);
      this.log({
        ts: iso(this.now()),
        kind: "model-set-pending",
        teamId: this.opts.teamId,
        memberId: args.memberId,
        reason: "turn-running",
      });
      return { applied: "next-turn" };
    }
    const result = await this.applySelectionNow(origin.sessionId, origin.cwd, selection, args.memberId);
    if (result.applied) {
      this.recordModelSelection(paths, origin, selection);
      return { applied: "now" };
    }
    // 终态失败：立即告知原因，并落失败记录让成员行/弹窗可见；不排队、不重试。
    const reason = result.reason ?? "model was rejected by the host";
    this.writeModelFailure(paths, selection, reason);
    return { applied: "failed", reason };
  }

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
  }): Promise<TurnRecord> {
    const turnId = nextTurnId(args.paths.runDir);
    const stdoutFile = path.join(args.paths.runDir, `${turnId}.out`);
    const turnCwd = args.cwd ?? this.cwd;
    // mid-life 模型修改兜底：写 turn 记录之前应用 pending（避免 watcher 对 pid-null 轮次误终结）。
    await this.applyPendingModelSelection(args.paths, args.sessionId, turnCwd, args.memberId);
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

  /** Lead 当前模型选择：setModel 权威条目 → 最近一次 model_usage（都无 = undefined，不调 setModel）。 */
  private lookupLeadModelSelection(): MemberModelSelection | undefined {
    return this.lookupLeadModelSelections()[0];
  }

  /** 档位缺省（已有则不覆盖）：目录 defaultVariant → "max"（E-1b 统一落点，backend 不重复补）。 */
  private withReasoningDefault(selection: MemberModelSelection): MemberModelSelection {
    return applyReasoningDefault(this.modelCatalog(), selection);
  }

  /**
   * Lead 继承链（至多两档，按序）：`session_entry` 权威条目 → `model_usage` 最近调用。
   * 去重：两档三元组完全相同则只留一个（避免对同一目标重试一次必败的 setModel）。
   */
  private lookupLeadModelSelections(): MemberModelSelection[] {
    const candidates = [
      this.reader.latestModelSelection(this.opts.teamId),
      this.reader.latestModelUsage(this.opts.teamId),
    ];
    const out: MemberModelSelection[] = [];
    for (const selection of candidates) {
      if (selection === undefined) continue;
      if (out.some((existing) => sameModelSelection(existing, selection))) continue;
      out.push(selection);
    }
    return out;
  }

  /** 成员当前选择（thoughtLevel-only 修改的基底）：origin 记录 → transcript 条目 → 最近调用。 */
  private currentModelSelection(origin: OriginRecord): MemberModelSelection | undefined {
    if (origin.modelSelection !== undefined) return origin.modelSelection;
    if (origin.sessionId === null) return undefined;
    return (
      this.reader.latestModelSelection(origin.sessionId) ?? this.reader.latestModelUsage(origin.sessionId)
    );
  }

  /** 立即应用（无培育器能力/失败 → applied:false，由调用方落 pending）。 */
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

  /** pending 标记落盘（幂等覆盖：最后一次请求胜出）。 */
  private writeModelPending(paths: MemberPaths, selection: MemberModelSelection): void {
    writeJsonAtomic(paths.modelPendingFile, { modelSelection: selection, requestedAt: iso(this.now()) });
  }

  /** origin 回写（展示/审计；再读一次避免覆盖并发更新）。成功应用即清失败记录（#6）。 */
  private recordModelSelection(
    paths: MemberPaths,
    origin: OriginRecord,
    selection: MemberModelSelection,
  ): void {
    writeOrigin(paths, { ...(readOrigin(paths) ?? origin), modelSelection: selection, modelSource: "explicit" });
    clearModelFailed(paths);
  }

  /** 记录一次**终态**模型设置失败（供成员行诊断/面板弹窗；不排队、不重试）。 */
  private writeModelFailure(
    paths: MemberPaths,
    selection: MemberModelSelection,
    reason: string,
  ): void {
    writeModelFailed(paths, {
      modelSelection: selection,
      reason: compactReason(reason),
      failedAt: iso(this.now()),
    });
    this.log({
      ts: iso(this.now()),
      kind: "model-set-failed-terminal",
      teamId: this.opts.teamId,
      providerId: selection.providerId,
      modelId: selection.modelId,
      reason: compactReason(reason),
    });
  }

  /**
   * 成员行诊断（GitHub #6）：读 model-failed.json → 一条可读诊断。
   * 无记录/损坏 → []（损坏不阻断 list_agents；失败信息已尽力而为）。
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
    const selection = parseModelSelection(record.modelSelection);
    if (selection === undefined) return [];
    const reason = compactReason(typeof record.reason === "string" ? record.reason : "");
    return [`模型设置未生效：${selection.providerId}/${selection.modelId}${reason.length > 0 ? `（${reason}）` : ""}`];
  }

  /** 下一轮拉起前应用 pending（成功删标记并同步 origin；失败保留标记，不阻塞轮次）。 */
  private async applyPendingModelSelection(
    paths: MemberPaths,
    sessionId: string | null,
    workspacePath: string,
    memberId: string,
  ): Promise<void> {
    if (sessionId === null) return;
    const pending = readJson<{ modelSelection?: unknown }>(paths.modelPendingFile);
    if (pending === undefined) return;
    const selection = parseModelSelection(pending.modelSelection);
    if (selection === undefined) {
      this.log({ ts: iso(this.now()), kind: "model-pending-invalid", teamId: this.opts.teamId, memberId });
      return;
    }
    // 旧 pending 文件可能没有 reasoningLevel（E-1b 之前写入）→ 应用前补同一缺省链。
    const applied = this.withReasoningDefault(selection);
    const result = await this.applySelectionNow(sessionId, workspacePath, applied, memberId);
    if (!result.applied) {
      // 单次尝试（GitHub #6）：失败即终态——删 pending（不再每轮重试）+ 落失败记录供诊断；
      // 轮次继续用旧模型跑（不阻塞成员）。
      try {
        fs.unlinkSync(paths.modelPendingFile);
      } catch {
        /* best-effort */
      }
      this.writeModelFailure(paths, applied, result.reason ?? "model was rejected by the host");
      return;
    }
    try {
      fs.unlinkSync(paths.modelPendingFile);
    } catch {
      /* best-effort：标记残留只会导致下一轮重复应用同一选择 */
    }
    const origin = readOrigin(paths);
    if (origin !== undefined) this.recordModelSelection(paths, origin, applied);
    this.log({
      ts: iso(this.now()),
      kind: "model-pending-applied",
      teamId: this.opts.teamId,
      memberId,
      modelId: applied.modelId,
    });
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
  const text = firstSentence.trim();
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
