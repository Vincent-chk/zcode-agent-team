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
  readonly recoveryDone: Promise<void>;

  constructor(private readonly deps: RosterDeps) {
    // C6：构造时对已存活成员全量调度恢复（对账自身抛错仅警告，C3）
    this.recoveryDone = this.reconcileProvisioning().then(
      () => undefined,
      () => undefined,
    );
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

  async spawnTeammate(callerId: string, args: SpawnArgs): Promise<{ member: MemberRow }> {
    return this.deps.lifecycle.track(this.spawnInner(callerId, args));
  }

  private async spawnInner(callerId: string, args: SpawnArgs): Promise<{ member: MemberRow }> {
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
      try {
        return await this.deps.provider.startContinuable({
          teamId: this.deps.teamId,
          memberId: childId,
          name,
          description,
          firstPrompt: args.prompt, // 对齐轮：0.2.1 初始任务不含身份前缀
          context,
          signal,
        });
      } catch (err) {
        throw this.mapAbortToDisposed(err);
      }
    })();

    try {
      const started = await run;
      if (started.memberId !== childId) {
        throw new Error(`provider returned memberId ${started.memberId} != provisioned ${childId}`);
      }
      if (!started.accepted) {
        // 未持久接收（02 §5.3 步骤 4）
        throw new TeamError(
          "TEAM_PROVISIONING_CONFLICT",
          `teammate "${childId}" initial prompt was not durably accepted`,
        );
      }
      // 步骤 5：事务内 settleProvisioning(active)；恢复流程抢先定 failed → 冲突 + 清理
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
    } catch (originalError) {
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
   *  （active/failed 任一去向；幂等竞态下相位已被他方定案也计入——结局已持久）。 */
  async reconcileProvisioning(): Promise<{ orphans: string[]; settled: string[] }> {
    const state = this.loadState();
    const pending = state.members.filter(
      (m) => m.phase === "provisioning" && !this.deps.inspector.isAlive(m.id),
    );
    const orphans = pending.map((m) => m.id);
    const settled: string[] = [];
    for (const member of pending) {
      try {
        let failure: string | undefined;
        let active = false;
        try {
          const record = this.deps.recon.readProvisioningRecord(member.id);
          if (record === undefined) {
            failure = "provisioning did not leave a resumable child Session";
          } else if (
            record.rootSessionId === this.deps.teamId &&
            record.descriptor !== undefined &&
            record.descriptor.mode === "continuable" &&
            record.descriptor.provider === member.provider &&
            record.initialUserMessageAccepted
          ) {
            active = true;
          } else {
            failure = "persisted child Session does not match the provisioned continuation";
          }
        } catch (err) {
          failure = `child Session recovery failed: ${errorMessage(err)}`;
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
    return { orphans, settled };
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

function defaultNewId(): string {
  return globalThis.crypto.randomUUID();
}

function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (a === undefined) return b;
  return AbortSignal.any([a, b]);
}
