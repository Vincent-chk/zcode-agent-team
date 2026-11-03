// Roster 服务（02 规格 §5；F08–F14 + C1/C2/C3/C6/B5）。
// 一切消息逐字以规格原文为准；零直接 IO（store/provider 端口注入）；一切追加经 store
// （journal 适配时自动含追加前不变量 + flush）。

import { TeamError } from "./errors.js";
import type { TeamLimits } from "./config.js";
import { requiredText } from "./validation.js";
import type { TeamMemberSnapshot } from "./events.js";
import type { TeamState } from "./projection.js";
import { requireMembership } from "./projection.js";
import type { TeamStore, ReconciliationSource, TargetInspector } from "./ports.js";
import { errorMessage } from "./ports.js";
import type { TeammateProvider } from "../provider/teammate-provider.js";
import { providerHasModelPreflight } from "../provider/model-inheritance.js";
import type { LifecyclePort } from "./lifecycle.js";

/** §5.1 名字规则。 */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 〔D33〕provisioning 对账宽限：事件年龄小于此值且尚未出现「可续跑且首轮已受理」记录 → defer。
 *  取值依据（2026-11-02 实测）：provisioning 事件到首轮落盘的窗口实测 7–46s（createChild 含
 *  app-server ready 20s + 两次 v4/command 各 30s + setModel 20s 的理论上限 ~100s）；20s 不足以
 *  覆盖真实窗口。宽限只推迟误判、不掩盖真故障：年龄 ≥ 宽限 或 恢复抛错 → 照旧定案。 */
const PROVISIONING_GRACE_MS = 60_000;
/** 〔D33〕defer 后的一次性复核间隔（unref；admin.reconcile 亦为兜底通道）。 */
const PROVISIONING_RECHECK_MS = 10_000;

// 〔对齐轮修订 2026-10-17〕原 §9.3 身份前缀块（identityPrefix）已删除：
// 0.2.1-alpha.5 身份改由运行时上下文承载（systemPrompt.context，required、抗压缩、每请求重发），
// spawn 首轮 prompt = 任务原文（sends the initial task unchanged）；ZCode 侧身份注入改 hook 通道（stage-3 T3.3）。

export interface SpawnArgs {
  name: string;
  description: string;
  prompt: string;
  context?: "fresh" | "fork";
  // 0.4.0 注销 model/modelSelection/thoughtLevel：成员模型唯一路线 = provider 每轮跟随 Lead。
  signal?: AbortSignal;
  /** 协调者失锁（非显式 dispose）→ pending，不写成成员失败。 */
  ownershipSignal?: AbortSignal;
  /** MCP → 协调者 → origin 的稳定请求关联。 */
  requestId?: string;
}

/** MEMBER_VIEW 行（§9.4；listMembers 输出）。 */
export interface MemberRow {
  target: string;
  role: "lead" | "teammate";
  status: "running" | "inactive" | "provisioning" | "failed";
  description?: string;
  provider?: string;
  context?: "fresh" | "fork";
  model?: string;
  diagnostics: string[];
}

/** §5.5 呈现补充能力（availability/model；MockProvider 实现，真 provider 于 stage-4 落地）。 */
export interface MemberPresentation {
  statusOf(memberId: string): "running" | "inactive";
  modelOf(memberId: string): string | undefined;
  /** Lead 会话模型实查（可选；真 provider 实现，缺省回落 deps.leadModel）。 */
  leadModelOf?(): string | undefined;
  /** 成员附加诊断（可选；如模型设置终态失败。GitHub #6：失败必须在成员行可见）。 */
  diagnosticsOf?(memberId: string): string[];
}

export interface RosterDeps {
  teamId: string;
  store: TeamStore;
  provider: TeammateProvider;
  recon: ReconciliationSource;
  inspector: TargetInspector;
  limits: TeamLimits;
  lifecycle: LifecyclePort;
  presentation?: MemberPresentation;
  /** 工具插件 config（02 §4 默认 spawn/fork）。 */
  providers?: { fresh: string; fork: string };
  leadModel?: string;
  warn?: (message: string) => void;
  newId?: () => string;
}

export class TeamRoster {
  private readonly statusListeners = new Set<() => void>();
  /** 〔D33〕defer 复核定时器（成员 id → timer；一次性、unref）。 */
  private readonly recheckTimers = new Map<string, NodeJS.Timeout>();
  private readonly recoveryStopped = new Set<string>();
  private recoveryDone: Promise<void> | undefined;

  constructor(private readonly deps: RosterDeps) {}

  /** 仅由宿主在完整意图/轮次恢复后启动；构造对象不得提前判 provisioning 失败。 */
  startRecovery(): Promise<void> {
    this.recoveryDone ??= this.reconcileProvisioning().then(
      () => undefined,
      () => undefined,
    );
    return this.recoveryDone;
  }

  cancelPendingRecovery(): void {
    for (const timer of this.recheckTimers.values()) clearTimeout(timer);
    this.recheckTimers.clear();
    this.recoveryStopped.clear();
  }

  /** 成员状态变化边（Activity 唤醒源之二；settle/interrupt 后触发）。 */
  onMemberStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** 外部状态变化通知（stage-4：provider 轮次边界 → Activity 唤醒；F13 ≤1s 路径）。 */
  notifyStatusChanged(): void {
    this.notifyStatus();
  }

  /** C5 服务层落点：投影 failure → 一切调用 TEAM_NOT_MEMBER。 */
  private loadState(): TeamState {
    const state = this.deps.store.state();
    if (state.failure !== undefined) throw new Error(state.failure);
    return state;
  }

  private requireMember(callerId: string): { state: TeamState; name: string } {
    const membership = requireMembership(() => {
      const state = this.loadState();
      if (state.failure !== undefined) throw new Error(state.failure);
      return state;
    }, callerId);
    return { state: this.loadState(), name: membership.name };
  }

  // ---------------------------------------------------------------- spawn（§5.3）

  async spawnTeammate(callerId: string, args: SpawnArgs): Promise<{ member: MemberRow; creation?: "pending"; message?: string }> {
    return this.deps.lifecycle.track(this.spawnInner(callerId, args));
  }

  private async spawnInner(callerId: string, args: SpawnArgs): Promise<{ member: MemberRow; creation?: "pending"; message?: string }> {
    const { state } = this.requireMember(callerId); // F11：非成员 → TEAM_NOT_MEMBER
    this.deps.lifecycle.requireOpen(); // F11：处置中 → TEAM_DISPOSED（is disposing）
    if (callerId !== state.id) {
      throw new TeamError("TEAM_LEAD_REQUIRED", "only the Team Lead can create teammates");
    }

    // 步骤 1：校验
    const name = args.name;
    if (
      typeof name !== "string" ||
      name.length > 64 ||
      name === "lead" ||
      !NAME_PATTERN.test(name)
    ) {
      throw new TeamError(
        "TEAM_INVALID_MEMBER_NAME",
        'teammate name must be lower-kebab-case, at most 64 characters, and not "lead"',
      );
    }
    const description = requiredText("description", args.description, 200);
    const providers = this.deps.providers ?? { fresh: "spawn", fork: "fork" };
    const context: "fresh" | "fork" = args.context ?? "fresh";
    const providerName = requiredText("provider", context === "fork" ? providers.fork : providers.fresh, 200);
    const childId = (this.deps.newId ?? defaultNewId)();
    const requestId = args.requestId ?? defaultNewId();
    // 完整意图是唯一恢复来源，必须先于 provisioning 登记与宿主副作用。
    this.deps.provider.prepareContinuable?.({
      teamId: this.deps.teamId,
      memberId: childId,
      name,
      description,
      firstPrompt: args.prompt,
      context,
      requestId,
    });

    // 步骤 2：事务内重读 + 限额 + 模型预检 + provisioning 落盘（store.append = flush 完成）
    await this.deps.store.transact(async () => {
      const fresh = this.loadState();
      if (fresh.members.some((m) => m.name === name)) {
        throw new TeamError("TEAM_MEMBER_NAME_TAKEN", `teammate name "${name}" was already used in this Team`);
      }
      if (fresh.members.length >= this.deps.limits.maxMembers) {
        throw new TeamError("TEAM_MEMBER_LIMIT", `Team member limit ${this.deps.limits.maxMembers} reached`);
      }
      // 0.4.1：模型继承预检——Lead 模型不可继承（官方套餐/目录外/解析不出）在
      // 登记成员之前失败：不增加成员数量、不占用成员名、不创建隐藏子会话（修正 Lead
      // 模型后原名可重用）。供给阶段仍复检（startContinuable 内），处理预检后配置漂移。
      // 无预检能力的 provider 跳过。
      if (providerHasModelPreflight(this.deps.provider)) {
        this.deps.provider.preflightMemberModel();
      }
      await this.deps.store.append({
        type: "team/member",
        version: 2,
        teamId: this.deps.teamId,
        member: memberSnapshotOf(childId, name, description, providerName, context, "provisioning"),
      });
    });

    // 步骤 3–4：startContinuable（含首轮 prompt 持久接收检查：accepted 口径）+ 中止映射（C2③）
    const run = (async () => {
      const signal = combineSignals(args.signal, this.deps.lifecycle.runtimeSignal());
      const ownershipSignal = args.ownershipSignal;
      const runSignal = ownershipSignal === undefined ? signal : AbortSignal.any([signal, ownershipSignal]);
      try {
        return await this.deps.provider.startContinuable({
          teamId: this.deps.teamId,
          memberId: childId,
          name,
          description,
          firstPrompt: args.prompt, // 对齐轮：0.2.1 初始任务不含身份前缀
          context,
          requestId,
          signal: runSignal,
        });
      } catch (err) {
        if (ownershipSignal?.aborted) throw new ProvisioningPending("协调者代次已撤销，创建结果待确认");
        throw this.mapAbortToDisposed(err);
      }
    })();

    let started: Awaited<typeof run>;
    try {
      started = await run;
    } catch (originalError) {
      if (originalError instanceof ProvisioningPending) {
        return { member: this.rowOf(childId), creation: "pending", message: originalError.message };
      }
      // 步骤 6：失败路径 —— failed 落盘（error=单行 errorMessage）→ 清理 → 原错误上抛
      let becameActiveConflict: TeamError | undefined;
      let recordError: unknown;
      let recordErrorSet = false;
      try {
        const settled = await this.settleProvisioning(childId, "failed", errorMessage(originalError));
        if (settled === "active") {
          // 清理时发现已 active（恢复流程抢先定为 active）→ 冲突原样上抛
          becameActiveConflict = new TeamError(
            "TEAM_PROVISIONING_CONFLICT",
            `teammate "${name}" became active while its creator reported failure`,
          );
        }
      } catch (err) {
        recordError = err;
        recordErrorSet = true;
      }
      if (becameActiveConflict !== undefined) {
        this.notifyStatus();
        throw becameActiveConflict;
      }
      if (recordErrorSet) {
        // B5：触发面 = 原始错误 + 失败记录环节任何错误
        throw new AggregateError(
          [originalError, recordError],
          "teammate creation and durable failure recording both failed",
        );
      }
      try {
        await this.deps.provider.interrupt({ memberId: childId });
      } catch (cleanupError) {
        throw new AggregateError(
          [originalError, cleanupError],
          "teammate creation and durable failure recording both failed",
        );
      }
      this.notifyStatus();
      throw originalError;
    }
    if (started.memberId !== childId) {
      throw new Error(`provider returned memberId ${started.memberId} != provisioned ${childId}`);
    }
    if (started.creation === "pending") {
      return { member: this.rowOf(childId), creation: "pending", message: "结果待确认" };
    }
    if (!started.accepted) {
      const rejection = new TeamError("TEAM_PROVISIONING_CONFLICT", `teammate "${childId}" initial prompt was not durably accepted`);
      await this.settleProvisioning(childId, "failed", rejection.message);
      await this.deps.provider.interrupt({ memberId: childId });
      this.notifyStatus();
      throw rejection;
    }
    // 首轮已确认后，本地 active 提交失败绝不进入失败清理。
    const settled = await this.settleProvisioning(childId, "active");
    if (settled === "failed") {
      const conflict = new TeamError(
        "TEAM_PROVISIONING_CONFLICT",
        `teammate "${name}" was reconciled as failed while creation was in progress`,
      );
      try {
        await this.deps.provider.interrupt({ memberId: childId });
      } catch (cleanupError) {
        throw new AggregateError([conflict, cleanupError], "provisioning conflict cleanup failed");
      }
      throw conflict;
    }
    this.notifyStatus();
    return { member: this.rowOf(childId) };
  }

  /** settleProvisioning（幂等）：已非 provisioning → 返回现有相位不追加；成员消失 → C1 冲突。 */
  private settleProvisioning(
    memberId: string,
    phase: "active" | "failed",
    error?: string,
  ): Promise<"active" | "failed"> {
    return this.deps.store.transact(async () => {
      const state = this.loadState();
      const member = state.members.find((m) => m.id === memberId);
      if (member === undefined) {
        throw new TeamError("TEAM_PROVISIONING_CONFLICT", `provisioned teammate "${memberId}" disappeared`);
      }
      if (member.phase !== "provisioning") return member.phase;
      const next: TeamMemberSnapshot =
        error !== undefined ? { ...member, phase, error } : { ...member, phase };
      await this.deps.store.append({
        type: "team/member",
        version: 2,
        teamId: this.deps.teamId,
        member: next,
      });
      return phase;
    });
  }

  // ---------------------------------------------------------------- 恢复对账（§5.4）

  /** 对每个 provisioning 且不存活的成员执行四条件对账；C3：恢复自身抛错仅警告。
   *  返回摘要（第四轮最小扩展）：orphans = 本轮识别的失联成员；settled = 本轮定案者
   *  （active/failed 任一去向；幂等竞态下相位已被他方定案也计入——结局已持久）；
   *  〔D33〕deferred = 本轮因宽限跳过判定的成员（事件年龄 < graceMs 且 origin 未落盘）。
   *
   *  〔D33 事件年龄宽限，2026-11-02〕锁易主/恢复触发的 reconcile 与 in-flight spawn 竞态：
   *  origin.json 在 createChild 之后才落盘（resume-provider.ts），此前 readProvisioningRecord
   *  恒 undefined，旧逻辑会把仍在正常供给的成员误判 failed（sess_cabd748c 实测：锁被假死抢走后
   *  新协调者构造即 reconcile，两个 in-flight 成员被误杀）。现以 journal 中该成员最后一条
   *  team/member(provisioning) 事件的 ts 计龄：尚未确认首轮受理（记录缺失或 accepted 未置位）
   *  且年龄 < graceMs → 跳过本轮并排一次性 recheck（10s）；年龄 ≥ graceMs 或恢复抛错 → 照旧
   *  定案（真故障不被掩盖）。store 未实现 readEventLines（内存桩）→ 无宽限（旧语义）。 */
  async reconcileProvisioning(): Promise<{ orphans: string[]; settled: string[]; deferred: string[] }> {
    const state = this.loadState();
    const pending = state.members.filter(
      (m) => m.phase === "provisioning" && !this.deps.inspector.isAlive(m.id),
    );
    const orphans = pending.map((m) => m.id);
    const settled: string[] = [];
    const deferred: string[] = [];
    // 〔D33〕事件年龄表（一次性读；失败/缺端口 → undefined = 不启用宽限）。
    const ages = await this.provisioningEventAges();
    for (const member of pending) {
      try {
        let failure: string | undefined;
        let missingRecord = false;
        let active = false;
        let recoveryThrew = false;
        try {
          const record = this.deps.recon.readProvisioningRecord(member.id);
          if (record === undefined) {
            missingRecord = true;
          } else if (
            record.rootSessionId === this.deps.teamId &&
            record.descriptor !== undefined &&
            record.descriptor.mode === "continuable" &&
            record.descriptor.provider === member.provider &&
            record.initialUserMessageAccepted
          ) {
            active = true;
          } else if (
            record.rootSessionId === this.deps.teamId &&
            record.descriptor !== undefined &&
            record.descriptor.mode === "continuable" &&
            record.descriptor.provider === member.provider &&
            !record.initialUserMessageAccepted
          ) {
            missingRecord = true; // 身份匹配的已保存 child 仅待首轮确认。
          } else {
            failure = "persisted child Session does not match the provisioned continuation";
          }
        } catch (err) {
          recoveryThrew = true;
          failure = `child Session recovery failed: ${errorMessage(err)}`;
        }
        // 〔0.5.4〕origin 是创建进度与预算的唯一来源；未知结果不按固定年龄定 failed。
        if (!active && !recoveryThrew && !missingRecord && failure !== undefined) {
          // 记录明确不匹配 = 可证失败；缺失/读取异常一律不是该结论。
          await this.settleProvisioning(member.id, "failed", failure);
          settled.push(member.id);
          this.notifyStatus();
          continue;
        }
        if (!active) {
          if (this.deps.provider.noteProvisioningRecovery?.(member.id) === true) {
            this.recoveryStopped.add(member.id);
            deferred.push(member.id);
            this.notifyStatus();
            continue;
          }
          if (this.deps.provider.resumeContinuable !== undefined) {
            try {
              const resumed = await this.deps.provider.resumeContinuable(
                member.id,
                this.deps.lifecycle.runtimeSignal(),
              );
              if (resumed.creation === "pending" || !resumed.accepted) {
                deferred.push(member.id);
                this.scheduleProvisioningRecheck(member.id);
                continue;
              }
              active = true;
            } catch (err) {
              if (err instanceof ProvisioningPending) {
                deferred.push(member.id);
                this.scheduleProvisioningRecheck(member.id);
                continue;
              }
              throw err;
            }
          } else {
            const ageMs = ages?.get(member.id);
            if (!recoveryThrew && ageMs !== undefined && ageMs < PROVISIONING_GRACE_MS) {
              deferred.push(member.id);
              this.scheduleProvisioningRecheck(member.id);
              continue;
            }
          }
        }
        // 事务内重查：创建方已定案 → settle 幂等返回，放弃（竞态双方结局之一）
        await this.settleProvisioning(member.id, active ? "active" : "failed", failure);
        settled.push(member.id);
        this.notifyStatus();
      } catch (err) {
        this.deps.warn?.(
          `Agent Teams recovery for "${member.id}" failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { orphans, settled, deferred };
  }

  /** 〔D33〕每个成员最后一条 team/member(provisioning) 事件的年龄（ms）；无端口/读失败 → undefined。 */
  private async provisioningEventAges(): Promise<Map<string, number> | undefined> {
    const read = this.deps.store.readEventLines;
    if (read === undefined) return undefined;
    try {
      const lines = await read.call(this.deps.store);
      const lastTs = new Map<string, number>();
      for (const line of lines) {
        const e = line.event as { type?: unknown; member?: { id?: unknown; phase?: unknown } } | null;
        if (e?.type !== "team/member") continue;
        const id = e.member?.id;
        if (typeof id !== "string") continue;
        if (e.member?.phase !== "provisioning") continue;
        const at = Date.parse(line.ts);
        if (Number.isNaN(at)) continue;
        const prev = lastTs.get(id);
        if (prev === undefined || at > prev) lastTs.set(id, at);
      }
      const now = Date.now();
      const ages = new Map<string, number>();
      for (const [id, at] of lastTs) ages.set(id, now - at);
      return ages;
    } catch {
      return undefined; // 读失败 = 不启用宽限（宁可误判也不无限 defer）
    }
  }

  /** 〔D33〕defer 后的一次性复核（不阻塞、不叠加：同成员在途则跳过）。 */
  private scheduleProvisioningRecheck(memberId: string): void {
    if (this.recheckTimers.has(memberId)) return;
    const timer = setTimeout(() => {
      this.recheckTimers.delete(memberId);
      void this.reconcileProvisioning().then(
        () => undefined,
        () => undefined, // C3：对账自身抛错仅警告语义由调用方承担
      );
    }, PROVISIONING_RECHECK_MS);
    timer.unref?.();
    this.recheckTimers.set(memberId, timer);
  }

  hasPendingAutomaticProgress(callerId: string): boolean {
    const { state } = this.requireMember(callerId);
    return state.members.some((member) =>
      (member.phase === "active" && this.deps.inspector.isAlive(member.id)) ||
      (member.phase === "provisioning" && !this.recoveryStopped.has(member.id))
    );
  }

  // ---------------------------------------------------------------- listMembers（§5.5）

  listMembers(callerId: string): { members: MemberRow[] } {
    this.requireMember(callerId);
    const state = this.loadState();
    const presentation = this.deps.presentation;
    const leadModel = presentation?.leadModelOf?.() ?? this.deps.leadModel;
    const rows: MemberRow[] = [
      {
        target: "lead",
        role: "lead",
        // availability(root)：Lead 调用方视角恒 running；teammate 视角无法观测宿主 Lead 回合，
        // 保守呈 inactive（D19 登记）。此前恒 running 会让 teammate 的 noProgress 捷径失效。
        status: callerId === state.id ? "running" : "inactive",
        ...(leadModel !== undefined ? { model: leadModel } : {}),
        diagnostics: [],
      },
    ];
    for (const member of state.members) {
      const status: MemberRow["status"] =
        member.phase === "failed"
          ? "failed"
          : member.phase === "provisioning"
            ? "provisioning"
            : presentation
              ? presentation.statusOf(member.id)
              : this.deps.inspector.isAlive(member.id)
                ? "running"
                : "inactive";
      const model = presentation?.modelOf(member.id) ?? this.deps.leadModel; // 回退链：成员 → Lead → 缺省
      // 诊断 = 域侧创建失败原因 + 呈现侧附加诊断（如模型设置未生效；#6 三面可见之一）。
      const extraDiagnostics = presentation?.diagnosticsOf?.(member.id) ?? [];
      const diagnostics = [
        ...(member.error !== undefined ? [member.error] : []),
        ...extraDiagnostics,
      ];
      rows.push({
        target: member.name,
        role: "teammate",
        status,
        description: member.description,
        provider: member.provider,
        context: member.context,
        ...(model !== undefined ? { model } : {}),
        diagnostics,
      });
    }
    return { members: rows };
  }

  // ---------------------------------------------------------------- interrupt（§5.6）

  async interrupt(callerId: string, rawName: string): Promise<{ previousStatus: string }> {
    const { state } = this.requireMember(callerId);
    if (callerId !== state.id) {
      throw new TeamError("TEAM_LEAD_REQUIRED", "only the Team Lead can interrupt teammates");
    }
    const name = rawName.trim();
    if (name === "lead") {
      throw new TeamError("TEAM_INVALID_TARGET", "the Team Lead cannot interrupt itself");
    }
    const target = state.members.find((m) => m.name === name && m.phase === "active");
    if (target === undefined) {
      throw new TeamError("TEAM_MEMBER_NOT_FOUND", `active teammate "${name}" not found`);
    }
    if (!this.deps.inspector.isAlive(target.id)) {
      return { previousStatus: "inactive" }; // 不在注册表 → 不报错
    }
    const result = await this.deps.provider.interrupt({ memberId: target.id });
    this.notifyStatus();
    return result;
  }

  // ---------------------------------------------------------------- 内部

  /** C2③：checkpoint 等待被非 Error reason 中止 → TEAM_DISPOSED `teammate creation aborted: <msg>`。 */
  private mapAbortToDisposed(err: unknown): unknown {
    if (err instanceof Error) return err;
    return new TeamError("TEAM_DISPOSED", `teammate creation aborted: ${errorMessage(err)}`);
  }

  private rowOf(memberId: string): MemberRow {
    const rows = this.listMembers(this.deps.teamId).members;
    const row = rows.find((r) => r.target === this.nameOf(memberId));
    if (row === undefined) throw new Error(`member row missing for ${memberId}`);
    return row;
  }

  private nameOf(memberId: string): string {
    const member = this.loadState().members.find((m) => m.id === memberId);
    return member?.name ?? "";
  }

  private notifyStatus(): void {
    for (const listener of this.statusListeners) listener();
  }
}

function memberSnapshotOf(
  id: string,
  name: string,
  description: string,
  provider: string,
  context: "fresh" | "fork",
  phase: "provisioning" | "active" | "failed",
  error?: string,
): TeamMemberSnapshot {
  return { id, name, description, provider, context, phase, ...(error !== undefined ? { error } : {}) };
}

export class ProvisioningPending extends Error {
  constructor(message = "结果待确认") {
    super(message);
    this.name = "ProvisioningPending";
  }
}

function defaultNewId(): string {
  return globalThis.crypto.randomUUID();
}

function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (a === undefined) return b;
  return AbortSignal.any([a, b]);
}
