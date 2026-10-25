// 工具面后端（stage-3 T3.1/T3.2）：9 工具 → 协调层/域服务的接线（0.4.0 注销 member_set_model）。
// 冷启动即服务：按 teamId 惰性打开 TeamCoordinatorHost（首调即开；并发调用共享同一
// open promise），持锁 → 协调者模式（方法表进程内直执行）；他人持锁 → 代理模式
// （经 socket 转发）。参数守卫复用方法表冻结口径（requireString/enum 等，stage-2 已测）。
//
// 例外接线（方法表无对应方法，见 stage-3 开发记录登记）：
//  - list_agents：协调者模式 → runtime.roster.listMembers（MEMBER_VIEW 全保真）；
//    代理模式 → 本地重放派生（保守 availability——存活注册表在协调者进程；stage-4 全保真）；
//  - wait_agent no-active-peer 捷径：仅协调者模式评估（代理模式跳过捷径直接注册等待——
//    保守方向：不误报 noProgress）。
//
// wait_agent 保活（T3.2 定版）：等待期间每 ≤10s 发一次 notifications/progress
// （宿主 resetTimeoutOnProgress:true——stage-1 已证实 + 2026-10-16 bundle 现场核实
// callToolOnClientInner）；.mcp.json timeoutMs=3600000。
//
// 本文件只做接线：业务语义全部在 src/domain/**（不改动）；传输语义在 src/coord/**
// （不改动；host.teamRuntime getter 为附加式小改，披露于开发记录）。

import { TeamCoordinatorHost } from "../coord/host.js";
import { callCoordinator } from "../coord/rpc.js";
import { teamPaths } from "../coord/paths.js";
import { WAIT_AGENT_GRACE_MS } from "../coord/methods.js";
import { TeamError } from "../domain/errors.js";
import { requireMembership } from "../domain/projection.js";
import type { MemberRow } from "../domain/roster.js";
import type { TeamTaskView } from "../domain/task-view.js";
import type { TeamLimits } from "../domain/config.js";
import type { ContentBlock } from "../domain/events.js";
import type { ResolvedIdentity } from "./identity.js";
import { noProgressResult, NO_PROGRESS_REASON } from "./policy.js";
import type { TeammateProvider } from "../provider/teammate-provider.js";
import type { ReconciliationSource, TargetInspector } from "../domain/ports.js";

/**
 * wait 保活 progress 间隔（验收口径：实测相邻间隔 ≤10s）。
 * 设计值取 9s 而非 10s：setInterval 存在 1–3ms/次的调度滞后，10s 设计值会让实测间隔
 * 恒为 10001–10003ms（stage-3 验收轮 F11 实测），9s 留出 10% 余量后实测约 9000–9003ms。
 */
export const WAIT_PROGRESS_INTERVAL_MS = 9_000;
/** wait_agent 工具层缺省与合法域（02 §9.7/§8）。 */
export const WAIT_DEFAULT_TIMEOUT_MS = 30_000;
export const WAIT_MIN_TIMEOUT_MS = 10_000;
export const WAIT_MAX_TIMEOUT_MS = 3_600_000;

export interface BackendOptions {
  dataRoot: string;
  limits: TeamLimits;
  /** 测试注入 provider（缺省 = host 默认 MockProvider；真 provider 归 stage-4）。 */
  provider?: TeammateProvider & ReconciliationSource & TargetInspector;
  /** stage-4：按 teamId 构造真 provider（ResumePerTurnProvider；daemon 注入，优先于 provider）。 */
  providerFactory?: (teamId: string) => TeammateProvider & ReconciliationSource & TargetInspector;
  /** 〔对齐轮〕0.2.1 D3：interrupt 开关（默认 true；false 时工具面 8 工具，interrupt_agent 不注册）。 */
  interrupt?: boolean;
  /** 空闲团队 host 回收阈值（缺省 10 分钟；0 = 关闭回收）。 */
  idleReclaimMs?: number;
  /** 时钟注入（回收测试用）。 */
  now?: () => number;
  warn?: (message: string) => void;
}

/** notifications/progress 发射口（handlers 层从 MCP extra.sendNotification 适配）。 */
export interface ProgressSink {
  (progress: number, message?: string): Promise<void>;
}

interface TeamBackend {
  host: TeamCoordinatorHost | null;
  opening: Promise<TeamCoordinatorHost>;
  /** 本团队 provider 实例（模型目录消歧要读 Lead 当前选择；代理模式下也读本地只读库）。 */
  provider?: TeammateProvider & ReconciliationSource & TargetInspector;
  /** 最近一次工具调用时间（空闲回收判定）。 */
  lastUsedAt: number;
  /** 在途工具调用数（>0 不回收：避免关掉正在 wait/dispatch 的 host）。 */
  inflight: number;
}

const DEFAULT_IDLE_RECLAIM_MS = 10 * 60_000;
const IDLE_SWEEP_MS = 60_000;

export class TeamToolBackend {
  private readonly teams = new Map<string, TeamBackend>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly idleReclaimMs: number;

  constructor(private readonly opts: BackendOptions) {
    this.now = opts.now ?? Date.now;
    this.idleReclaimMs = opts.idleReclaimMs ?? DEFAULT_IDLE_RECLAIM_MS;
  }

  /** 〔对齐轮〕0.2.1 D3：interrupt 开关（默认 true）。 */
  get interruptEnabled(): boolean {
    return this.opts.interrupt ?? true;
  }

  /** 冷启动即服务：惰性 open（并发共享同一 promise）；失败不留半成品缓存。 */
  private backendFor(teamId: string): Promise<TeamCoordinatorHost> {
    let entry = this.teams.get(teamId);
    if (entry === undefined) {
      const provider =
        this.opts.providerFactory !== undefined
          ? this.opts.providerFactory(teamId)
          : this.opts.provider !== undefined
            ? this.opts.provider
            : undefined;
      const resolvedProvider = provider;
      const opening = TeamCoordinatorHost.open({
        dataRoot: this.opts.dataRoot,
        teamId,
        limits: this.opts.limits,
        ...(provider !== undefined ? { provider } : {}),
        warn: this.opts.warn,
      });
      entry = {
        host: null,
        opening,
        // 缺省装配（host 内部 new MockProvider）时拿不到实例 → 模型消歧退化为「按目录唯一命中」。
        ...(resolvedProvider !== undefined ? { provider: resolvedProvider } : {}),
        lastUsedAt: this.now(),
        inflight: 0,
      };
      const self = entry;
      void opening.then(
        (host) => {
          self.host = host;
          return host;
        },
        (err) => {
          if (this.teams.get(teamId) === self) this.teams.delete(teamId);
          // 不要在派生 promise 里 rethrow：调用方通过 entry.opening 收到原错误；
          // 这里的 rejection 无人消费，Node 会当作 unhandled rejection 直接退出 daemon。
          this.opts.warn?.(`agent-team host open failed for "${teamId}": ${err instanceof Error ? err.message : String(err)}`);
          return undefined;
        },
      );
      this.teams.set(teamId, entry);
      this.ensureIdleSweep();
    }
    entry.lastUsedAt = this.now();
    return entry.opening;
  }

  /** 用法包装：记录在途/最后使用时间；工具方法统一经此取 host。 */
  private async withHost<T>(teamId: string, fn: (host: TeamCoordinatorHost) => Promise<T>): Promise<T> {
    const host = await this.backendFor(teamId);
    const entry = this.teams.get(teamId);
    if (entry !== undefined) entry.inflight += 1;
    try {
      return await fn(host);
    } finally {
      if (entry !== undefined) {
        entry.inflight -= 1;
        entry.lastUsedAt = this.now();
      }
    }
  }

  /** 空闲回收：关闭超过阈值且无在途调用的团队 host（durable 日志保留，下次调用按冷启动恢复）。 */
  async sweepIdleHosts(): Promise<number> {
    if (this.idleReclaimMs <= 0) return 0;
    const now = this.now();
    let reclaimed = 0;
    for (const [teamId, entry] of [...this.teams.entries()]) {
      if (entry.host === null || entry.inflight > 0) continue;
      if (now - entry.lastUsedAt < this.idleReclaimMs) continue;
      // 先从缓存移除（新调用会重开），再等 close 完成（释放锁）——否则重开会以代理模式启动。
      this.teams.delete(teamId);
      const host = entry.host;
      try {
        await host.close();
        reclaimed += 1;
      } catch (err) {
        this.opts.warn?.(
          `agent-team idle host close failed for "${teamId}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (reclaimed > 0) this.opts.warn?.(`agent-team reclaimed ${reclaimed} idle team host(s)`);
    return reclaimed;
  }

  private ensureIdleSweep(): void {
    if (this.idleTimer !== null || this.idleReclaimMs <= 0) return;
    this.idleTimer = setInterval(() => void this.sweepIdleHosts(), IDLE_SWEEP_MS);
    this.idleTimer.unref?.();
  }

  /** 诊断：某团队 host 是否已开且为协调者（契约测试用）。 */
  modeOf(teamId: string): "coordinator" | "proxy" | "unopened" {
    const entry = this.teams.get(teamId);
    return entry?.host?.currentMode ?? "unopened";
  }

  async close(): Promise<void> {
    if (this.idleTimer !== null) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    const entries = [...this.teams.values()];
    this.teams.clear();
    const errors: unknown[] = [];
    for (const entry of entries) {
      try {
        const host = await entry.opening;
        await host.close();
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Agent Teams tool backend close failed");
    }
  }

  // ---------------------------------------------------------------- 9 工具操作

  /** spawn_teammate（02 §9.3；context 缺省 fresh 由域层承担；〔对齐轮〕0.2.1：初始任务不含身份前缀）。
   *  参数原值直传——类型/枚举守卫在方法表 requireString/optionalString（冻结消息）。
   *  0.4.0：model/thoughtLevel 参数注销——成员模型唯一路线 = provider 每轮跟随 Lead 最新
   *  已确认选择；Lead 模型不可继承（官方套餐/目录外/解析不出）时 provider 抛错 → 本调用报错。 */
  async spawnTeammate(
    identity: ResolvedIdentity,
    args: {
      name: unknown;
      description: unknown;
      prompt: unknown;
      context?: unknown;
    },
  ): Promise<{ member: MemberRow }> {
    return this.withHost(identity.teamId, async (host) =>
      (await host.dispatch("member.spawn", {
        session_id: identity.agentId,
        name: args.name,
        description: args.description,
        prompt: args.prompt,
        ...(args.context !== undefined ? { context: args.context } : {}),
      })) as { member: MemberRow },
    );
  }

  // 0.4.0 注销 setMemberModel / resolveModelArgs / leadProviderId / catalog / wireModelSelection /
  // validateThoughtLevel（成员模型没有独立配置通道；stage-8 原文见 traceability §18 与 git 历史）。

  /** list_agents 的行派生（协调者 = roster 全保真；代理 = 本地重放派生）。 */
  private async memberRows(host: TeamCoordinatorHost, identity: ResolvedIdentity): Promise<MemberRow[]> {
    const runtime = host.teamRuntime;
    if (runtime !== null) {
      return runtime.roster.listMembers(identity.agentId).members;
    }
    // 代理模式：本地重放派生（保守 availability；成员资格校验同 C5 口径）
    const loaded = await host.readBoard();
    requireMembership(
      () => {
        if (loaded.state.failure !== undefined) throw new Error(loaded.state.failure);
        return loaded.state;
      },
      identity.agentId,
    );
    return memberRowsFromState(loaded.state.id, loaded.state.members, identity.agentId);
  }

  /** send_message（02 §9.5；内容映射 content=[{type:"text",text:message}]，target 原值直传）。
   *  〔对齐轮〕0.2.1：工具层输出 {sent:true}（不暴露 messageId；投递状态为内部适配层）。 */
  async sendMessage(
    identity: ResolvedIdentity,
    args: { target: unknown; message: unknown },
  ): Promise<{ sent: true }> {
    const content: ContentBlock[] = [{ type: "text", text: args.message as string }];
    return this.withHost(identity.teamId, async (host) => {
      // 域层返回 {messageId,status}；rejected 会抛错，只有 accepted/pending 到达这里。
      await host.dispatch("message.send", {
        session_id: identity.agentId,
        targetName: args.target,
        content,
      });
      return { sent: true };
    });
  }

  /** list_agents（02 §9.6；输出 MEMBER_VIEW[]，Lead 伪行 target="lead"）。 */
  async listAgents(identity: ResolvedIdentity): Promise<MemberRow[]> {
    return this.withHost(identity.teamId, (host) => this.memberRows(host, identity));
  }

  /** interrupt_agent（02 §9.8；Lead-only 域层校验，工具层不放宽；target 原值直传）。
   *  〔对齐轮〕0.2.1 D3：interrupt=false 时本工具未注册——调用按「未知工具」拒绝（handlers 承担）。 */
  async interruptAgent(
    identity: ResolvedIdentity,
    args: { target: unknown },
  ): Promise<{ previousStatus: string }> {
    return this.withHost(identity.teamId, async (host) =>
      (await host.dispatch("member.interrupt", {
        session_id: identity.agentId,
        name: args.target,
      })) as { previousStatus: string },
    );
  }

  /**
   * wait_agent（02 §9.7/§8）：缺省 30000 → 非法值绕过捷径直报 TEAM_INVALID_TIMEOUT
   * → 合法则先跑 no-active-peer 捷径（仅协调者模式可评估）→ 否则注册等待
   * （等待期 progress 保活 ≤10s；代理模式经 socket 且按调用豁免超时）。
   */
  async waitAgent(
    identity: ResolvedIdentity,
    args: { timeout_ms?: unknown },
    emitProgress?: ProgressSink,
    signal?: AbortSignal,
  ): Promise<WaitAgentResult> {
    const raw = args.timeout_ms;
    const timeoutMs = raw === undefined ? WAIT_DEFAULT_TIMEOUT_MS : raw;
    // wait 最长 1h：在途期间不得被空闲回收关掉 host（withHost 的 inflight 覆盖整个等待）。
    return this.withHost(identity.teamId, async (host) => {
      if (!isValidTimeout(timeoutMs)) {
        // 02 §9.7 执行序：非法值绕过捷径直进 waitForChange（报 TEAM_INVALID_TIMEOUT，消息逐字）。
        // 数值型非法值经方法表直达域层（methods.ts 透传 number → activity 校验先于成员资格）；
        // 非数值型会被 methods.ts 缺省化为 30000（域层看不到原值）→ 工具面抛同一逐字错误，
        // 保证 F04 观察面一致（登记于开发记录）。
        if (typeof timeoutMs === "number") {
          return (await host.dispatch(
            "wait.agent",
            { session_id: identity.agentId, timeoutMs },
            signal !== undefined ? { signal } : {},
          )) as WaitAgentResult;
        }
        throw new TeamError(
          "TEAM_INVALID_TIMEOUT",
          "timeoutMs must be an integer from 10000 through 3600000",
        );
      }
      const runtime = host.teamRuntime;
      let wait: Promise<{ timedOut: boolean }>;
      if (runtime !== null) {
        // 捷径：除己外无 running|provisioning 成员 → 立即返回 noProgress 常量文本（逐字）
        const rows = runtime.roster.listMembers(identity.agentId).members;
        const selfTarget = identity.role === "lead" ? "lead" : identity.name;
        const hasActivePeer = rows.some(
          (row) =>
            row.target !== selfTarget &&
            (row.status === "running" || row.status === "provisioning"),
        );
        if (!hasActivePeer) return noProgressResult();
        wait = host.dispatch(
          "wait.agent",
          { session_id: identity.agentId, timeoutMs },
          signal !== undefined ? { signal } : {},
        ) as Promise<{ timedOut: boolean }>;
      } else {
        // 代理模式：跳过捷径（保守），经 socket 注册等待；客户端超时按调用豁免（草案 §2）
        const { teamDir } = teamPaths(this.opts.dataRoot, identity.teamId);
        wait = callCoordinator<{ timedOut: boolean }>(
          teamDir,
          identity.teamId,
          "wait.agent",
          { session_id: identity.agentId, timeoutMs },
          {
            timeoutMs: timeoutMs + WAIT_AGENT_GRACE_MS,
            ...(signal !== undefined ? { signal } : {}),
          },
        );
      }
      return emitProgress === undefined ? wait : withKeepAlive(wait, emitProgress);
    });
  }

  /** team_task_create（02 §9.9；snake_case → 方法表参数，原值直传）。 */
  async taskCreate(
    identity: ResolvedIdentity,
    args: { subject: unknown; description: unknown; blocked_by?: unknown; write_scopes?: unknown },
  ): Promise<TeamTaskView> {
    return this.withHost(identity.teamId, async (host) => {
      const result = (await host.dispatch("task.create", {
        session_id: identity.agentId,
        subject: args.subject,
        description: args.description,
        ...(args.blocked_by !== undefined ? { blockedBy: args.blocked_by } : {}),
        ...(args.write_scopes !== undefined ? { writeScopes: args.write_scopes } : {}),
      })) as { task: TeamTaskView };
      return result.task;
    });
  }

  /** team_task_list（02 §9.10；过滤/分页语义与越界消息逐字由域层承担；类型守卫在 handlers）。 */
  async taskList(
    identity: ResolvedIdentity,
    args: { status?: unknown; owner?: unknown; ready?: unknown; cursor?: unknown; limit?: unknown },
  ): Promise<{ tasks: TeamTaskView[]; nextCursor?: number }> {
    return this.withHost(identity.teamId, async (host) =>
      (await host.dispatch("task.list", {
        session_id: identity.agentId,
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.owner !== undefined ? { owner: args.owner } : {}),
        ...(args.ready !== undefined ? { ready: args.ready } : {}),
        ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      })) as { tasks: TeamTaskView[]; nextCursor?: number },
    );
  }

  /** team_task_get（02 §9.11；含 deleted 墓碑）。 */
  async taskGet(identity: ResolvedIdentity, args: { task_id: unknown }): Promise<TeamTaskView> {
    return this.withHost(identity.teamId, async (host) => {
      const result = (await host.dispatch("task.get", {
        session_id: identity.agentId,
        taskId: args.task_id,
      })) as { task: TeamTaskView };
      return result.task;
    });
  }

  /** team_task_update（02 §9.12；CAS 直传，原值交方法表校验）。 */
  async taskUpdate(
    identity: ResolvedIdentity,
    args: {
      task_id: unknown;
      expected_revision: unknown;
      action: unknown;
      subject?: unknown;
      description?: unknown;
      blocked_by?: unknown;
      write_scopes?: unknown;
      owner?: unknown;
    },
  ): Promise<TeamTaskView> {
    return this.withHost(identity.teamId, async (host) => {
      const result = (await host.dispatch("task.update", {
        session_id: identity.agentId,
        taskId: args.task_id,
        expectedRevision: args.expected_revision,
        action: args.action,
        ...(args.subject !== undefined ? { subject: args.subject } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.blocked_by !== undefined ? { blockedBy: args.blocked_by } : {}),
        ...(args.write_scopes !== undefined ? { writeScopes: args.write_scopes } : {}),
        ...(args.owner !== undefined ? { owner: args.owner } : {}),
      })) as { task: TeamTaskView };
      return result.task;
    });
  }

  /**
   * teammate 启动参数接口（T3.4；实参注入归 stage-4 provider）。
   * D6 对齐：--disallowed-tools Task（遮蔽一次性子代理工具，本阶段只留接口）。
   */
  static teammateDisallowedTools(): string[] {
    return ["Task"];
  }
}

export type WaitAgentResult = {
  timedOut: boolean;
  noProgress?: { reason: typeof NO_PROGRESS_REASON; message: string };
};

// ---------------------------------------------------------------- 模型参数（0.4.0 注销 invalidModel /
// wireModelSelection / validateThoughtLevel：成员模型唯一路线 = 每轮跟随 Lead，工具面无规格解析）

/** 02 §8 合法域：[10000, 3600000] 的 safe integer。 */
export function isValidTimeout(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= WAIT_MIN_TIMEOUT_MS &&
    value <= WAIT_MAX_TIMEOUT_MS
  );
}

/** 代理模式 MEMBER_VIEW 派生（02 §5.5 保守等价：无存活注册表 → active 呈 inactive）。 */
const MEMBER_STATUS_BY_PHASE = {
  active: "inactive",
  provisioning: "provisioning",
  failed: "failed",
} as const;

export function memberRowsFromState(
  teamId: string,
  members: ReadonlyArray<{
    id: string;
    name: string;
    description: string;
    provider: string;
    context: "fresh" | "fork";
    phase: "provisioning" | "active" | "failed";
    error?: string;
  }>,
  callerId: string,
): MemberRow[] {
  const rows: MemberRow[] = [
    { target: "lead", role: "lead", status: teamId === callerId ? "running" : "inactive", diagnostics: [] },
  ];
  for (const member of members) {
    rows.push({
      target: member.name,
      role: "teammate",
      status: MEMBER_STATUS_BY_PHASE[member.phase],
      description: member.description,
      provider: member.provider,
      context: member.context,
      diagnostics: member.error !== undefined ? [member.error] : [],
    });
  }
  return rows;
}

/** 保活：等待期间每 ≤interval 发一次 progress（重置宿主超时）。interval 缺省 = 9s（见 WAIT_PROGRESS_INTERVAL_MS）。 */
export async function withKeepAlive<T>(
  wait: Promise<T>,
  emitProgress: ProgressSink,
  intervalMs: number = WAIT_PROGRESS_INTERVAL_MS,
): Promise<T> {
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    void emitProgress(tick, "waiting for team activity").catch(() => undefined);
  }, intervalMs);
  try {
    return await wait;
  } finally {
    clearInterval(timer);
  }
}

