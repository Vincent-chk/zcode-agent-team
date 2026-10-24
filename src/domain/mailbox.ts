// Mailbox 持久邮箱（〔对齐轮修订 2026-10-17〕：对齐 0.2.1-alpha.5 直投口径；F15–F21 + B6/C4/C10 子句同步修订）。
// 官方 0.2.1：send 直投目标 inbox（服务层返回 { messageId }，不暴露投递状态；不再写 queued/delivered 事件）。
// ZCode 适配（P5 决策）：无 steer 原语 → 投递只能发生在回合边界，pending 落盘为必需适配层；
// team/message(queued)/team/message/delivered 事件与 MessageSource 保留为**内部适配层**（对外不暴露 queued/accepted）。
// 保证口径：消息永不丢失、永不重复投递；「进程内重试 + 目标会话去重」达成恰一次（协调者单写者边界）。
// delivered 持久载体 = team/message/delivered 事件（经 store/journal 落盘）；重放后 state.delivered 即恢复依据。

import { TeamError } from "./errors.js";
import type { TeamLimits } from "./config.js";
import type { ContentBlock, TeamMessageSnapshot } from "./events.js";
import type { TeamState } from "./projection.js";
import { requireMembership } from "./projection.js";
import type { TeamStore, TargetInspector } from "./ports.js";
import type { TeammateProvider } from "../provider/teammate-provider.js";
import type { LifecyclePort } from "./lifecycle.js";

/** §6.3 source 标记（0.2.1 目标侧来源形状；不再用 team-message source）。 */
export interface MessageSource {
  kind: "agent-message";
  form: "relay";
  senderSessionId: string;
}

/** 投递结果三态：accepted=已确认送达；pending=已进入适配层收件箱；rejected=确定性失败。 */
export type DispatchStatus = "accepted" | "pending" | "rejected";

export interface DispatchOutcome {
  status: DispatchStatus;
  reason?: string;
}

export interface SendResult {
  messageId: string;
  status: DispatchStatus;
  reason?: string;
}

export interface MailboxDeps {
  teamId: string;
  store: TeamStore;
  provider: TeammateProvider;
  inspector: TargetInspector;
  limits: TeamLimits;
  lifecycle: LifecyclePort;
  /** Lead 投递（§6.3 分支 1：root.steer 等价口；缺省 = 进程内接受）。
   *  〔stage-4〕返回 false = 本进程无法直达 Lead（宿主内会话，ZCode 无 steer 原语）——
   *  投递改经 hook 三通道回合边界（D2/D12 内部适配层），delivered 依据 = 回执（inspector.containsMessage）。 */
  steerLead?: (framed: ContentBlock[], source: MessageSource) => boolean | void;
  warn?: (message: string) => void;
  newId?: () => string;
}

/** §6.2 resolveActiveMember：trim 后 "lead" → Lead；否则同名且 active 的成员。 */
export function resolveActiveMember(
  state: TeamState,
  teamId: string,
  rawName: string,
): { id: string; name: string } {
  const name = rawName.trim();
  if (name === "lead") return { id: teamId, name: "lead" };
  const member = state.members.find((m) => m.name === name && m.phase === "active");
  if (member === undefined) {
    throw new TeamError("TEAM_MEMBER_NOT_FOUND", `active teammate "${name}" not found`);
  }
  return { id: member.id, name: member.name };
}

/** 框架化内容（F16 对齐轮逐字：0.2.1 无消息 id）：首块短文本 + 原内容块顺序不变。 */
export function frameMessage(message: TeamMessageSnapshot): ContentBlock[] {
  return [
    { type: "text", text: `Team message from ${message.senderName}:` },
    ...message.content,
  ];
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export class TeamMailbox {
  private readonly targetChains = new Map<string, Promise<void>>();
  private readonly inflight = new Map<string, Promise<DispatchOutcome>>();

  constructor(private readonly deps: MailboxDeps) {}

  /** send（对齐轮修订）：校验 → pending 落盘 flush（先于任何投递尝试）→ tryDispatch 同步发起（B6）。 */
  async send(
    callerId: string,
    args: { target: string; content: ContentBlock[] },
  ): Promise<SendResult> {
    return this.deps.lifecycle.track(this.sendInner(callerId, args));
  }

  private async sendInner(
    callerId: string,
    args: { target: string; content: ContentBlock[] },
  ): Promise<SendResult> {
    const membership = requireMembership(() => this.loadState(), callerId);
    this.deps.lifecycle.requireOpen();
    let messageId: string | undefined;
    let dispatch: Promise<DispatchOutcome> | undefined;
    await this.deps.store.transact(async () => {
      const state = this.loadState();
      // 1. resolveActiveMember
      const target = resolveActiveMember(state, this.deps.teamId, args.target);
      // 2. 自发
      if (target.id === callerId) {
        throw new TeamError("TEAM_SELF_MESSAGE", "a Team member cannot message itself");
      }
      // 3. id + 快照（structuredClone 原文）
      const id = `team-message-${(this.deps.newId ?? defaultNewId)()}`;
      const snapshot: TeamMessageSnapshot = {
        id,
        senderId: callerId,
        senderName: membership.name,
        targetId: target.id,
        content: structuredClone(args.content),
      };
      // 4. 框架化 + 字节计量（含框架；上限保留，0.2.1 未变）
      const framed = frameMessage(snapshot);
      const bytes = utf8Bytes(JSON.stringify(framed));
      if (bytes > this.deps.limits.maxMessageBytes) {
        throw new TeamError("TEAM_MESSAGE_TOO_LARGE", `team message exceeds ${this.deps.limits.maxMessageBytes} bytes`);
      }
      // 5. 追加 pending 并 flush（store.append 即落盘先于投递）
      await this.deps.store.append({
        type: "team/message/queued",
        version: 2,
        teamId: this.deps.teamId,
        message: snapshot,
      });
      // 6. tryDispatch 事务回调内同步发起（仅 await 在事务外，B6）
      messageId = id;
      dispatch = this.tryDispatch(snapshot);
    });
    const outcome = await (dispatch as Promise<DispatchOutcome>);
    if (outcome.status === "rejected") {
      // 硬失败：目标冷读失败或投递异常。消息仍持久 pending（恢复可重试），但调用方不得当作已送达。
      throw new Error(
        `team message could not be delivered to "${args.target}": ${outcome.reason ?? "unknown delivery failure"}`,
      );
    }
    return {
      messageId: messageId as string,
      status: outcome.status,
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    };
  }

  /** C5 服务层落点。 */
  private loadState(): TeamState {
    const state = this.deps.store.state();
    if (state.failure !== undefined) throw new Error(state.failure);
    return state;
  }

  pendingCount(state: TeamState, targetId: string): number {
    const deliveredIds = new Set(state.delivered);
    return state.messages.filter((m) => m.targetId === targetId && !deliveredIds.has(m.id)).length;
  }

  /** 目标的全部 pending（队列序）。 */
  pendingFor(state: TeamState, targetId: string): TeamMessageSnapshot[] {
    const deliveredIds = new Set(state.delivered);
    return state.messages.filter((m) => m.targetId === targetId && !deliveredIds.has(m.id));
  }

  // ---------------------------------------------------------------- 投递（§6.3）

  /** 单消息入口：in-flight 去重 + C10 短路 + 按目标串行（dispatchThrough）。 */
  private tryDispatch(message: TeamMessageSnapshot): Promise<DispatchOutcome> {
    const state = this.loadState();
    if (!this.pendingFor(state, message.targetId).some((m) => m.id === message.id)) {
      return Promise.resolve({ status: "accepted" }); // C10：已不在 pending（并发已投递）
    }
    const existing = this.inflight.get(message.id);
    if (existing !== undefined) return existing; // 同一消息同进程仅一次投递尝试
    const prev = this.targetChains.get(message.targetId) ?? Promise.resolve();
    const attempt = prev.then(
      () => this.dispatchThrough(message),
      () => this.dispatchThrough(message),
    );
    this.inflight.set(
      message.id,
      attempt.finally(() => this.inflight.delete(message.id)),
    );
    this.targetChains.set(
      message.targetId,
      attempt.then(
        () => undefined,
        () => undefined,
      ),
    );
    return this.inflight.get(message.id) as Promise<DispatchOutcome>;
  }

  /** 取该目标全部 pending，按队列序投递直到本条；前序 pending/rejected 即整体返回该结果。 */
  private async dispatchThrough(message: TeamMessageSnapshot): Promise<DispatchOutcome> {
    const state = this.loadState();
    const queue = this.pendingFor(state, message.targetId);
    for (const candidate of queue) {
      const outcome = await this.dispatchOne(candidate);
      if (candidate.id === message.id) return outcome; // 投到本条为止
      if (outcome.status !== "accepted") return outcome; // 前序未送达 → 本条跟随其状态
    }
    return { status: "accepted" }; // 本条已不在 pending（并发投递完成，C10）
  }

  /** dispatchOnce 分支矩阵（§6.3）：accepted=确认送达；pending=适配层收件箱；rejected=硬失败。 */
  private async dispatchOne(message: TeamMessageSnapshot): Promise<DispatchOutcome> {
    try {
      const framed = frameMessage(message);
      const source: MessageSource = {
        kind: "agent-message",
        form: "relay",
        senderSessionId: message.senderId,
      };
      // 分支 1：目标是 Lead 本人（进程内 steer → 直达；hook 通道 → 回执为 delivered 依据）
      if (message.targetId === this.deps.teamId) {
        const steered = this.deps.steerLead
          ? this.deps.steerLead(framed, source)
          : defaultSteerLead(framed, source);
        if (steered !== false) {
          return await this.tryMarkDelivered(message);
        }
        // 宿主内 Lead 无法直达（D2）：hook 注入已发生（回执在场）→ 折叠 delivered；否则 durable pending
        if (this.deps.inspector.containsMessage(message.targetId, message.id)) {
          return await this.tryMarkDelivered(message);
        }
        return { status: "pending", reason: "lead inbox has no receipt yet" };
      }
      // 分支 2：目标在注册表
      if (this.deps.inspector.isAlive(message.targetId)) {
        if (this.deps.inspector.containsMessage(message.targetId, message.id)) {
          return await this.tryMarkDelivered(message); // 去重路径（崩溃在收/认之间）
        }
        const verdict = await this.deliverFramed(message, framed);
        if (verdict === "accepted") return await this.checkpointDelivered(message);
        return { status: "pending", reason: "target is running; delivery deferred to turn boundary" };
      }
      // 分支 3：目标不在注册表（冷）
      let record: { recorded: boolean } | undefined;
      try {
        record = this.deps.inspector.readColdRecord(message.targetId, message.id);
      } catch (err) {
        this.deps.warn?.(
          `cannot read Team message target "${message.targetId}": ${errText(err)}`,
        );
        return { status: "rejected", reason: errText(err) }; // 宁可滞留不可重复（C4），但调用方需知道
      }
      if (record !== undefined && record.recorded) {
        return await this.tryMarkDelivered(message); // 已记录 → 补记 delivered
      }
      // 读到但未记录（或无记录）→ 冷拉起（steer 冷恢复路径）
      const verdict = await this.deliverFramed(message, framed);
      if (verdict === "accepted") return await this.checkpointDelivered(message);
      return { status: "pending", reason: "cold target resume deferred" };
    } catch (err) {
      this.deps.warn?.(`team message "${message.id}" remains queued: ${errText(err)}`);
      return { status: "rejected", reason: errText(err) };
    }
  }

  /** provider.deliver（framedMessage 序列化为字符串——草案 §1 deliver 签名）。 */
  private deliverFramed(
    message: TeamMessageSnapshot,
    framed: ContentBlock[],
  ): Promise<"accepted" | "queued"> {
    return this.deps.provider.deliver({
      memberId: message.targetId,
      framedMessage: JSON.stringify(framed),
      messageId: message.id,
    });
  }

  /** §6.3 checkpointDelivered：确认目标日志确已含该消息身份，再 markDelivered（幂等）。 */
  private async checkpointDelivered(message: TeamMessageSnapshot): Promise<DispatchOutcome> {
    const confirmed =
      message.targetId === this.deps.teamId ||
      this.deps.inspector.containsMessage(message.targetId, message.id);
    if (!confirmed) {
      this.deps.warn?.(`team message "${message.id}" remains queued: target confirmation missing`);
      // provider 已接受但确认缺失：保留 pending（恢复可补记），不谎报确认送达。
      return { status: "pending", reason: "target confirmation missing" };
    }
    return await this.tryMarkDelivered(message);
  }

  /**
   * 投递已发生但 delivered 事件未落盘（如 journal 崩溃/确认缺失）：返回 pending，
   * 由恢复路径按 containsMessage 补记；不向调用方谎报 accepted，也不误报 rejected。
   */
  private async tryMarkDelivered(message: TeamMessageSnapshot): Promise<DispatchOutcome> {
    try {
      await this.markDelivered(message);
      return { status: "accepted" };
    } catch (err) {
      this.deps.warn?.(`team message "${message.id}" delivered confirmation not recorded: ${errText(err)}`);
      return { status: "pending", reason: "delivered confirmation not recorded" };
    }
  }

  /** markDelivered（幂等：已 delivered / 消息不存在 / targetId 不符 → 静默返回）。 */
  async markDelivered(message: TeamMessageSnapshot): Promise<void> {
    await this.deps.store.transact(async () => {
      const state = this.loadState();
      const existing = state.messages.find((m) => m.id === message.id);
      if (existing === undefined) return; // 消息不存在
      if (existing.targetId !== message.targetId) return; // targetId 不符
      if (state.delivered.includes(message.id)) return; // 已 delivered
      await this.deps.store.append({
        type: "team/message/delivered",
        version: 2,
        teamId: this.deps.teamId,
        messageId: message.id,
        targetId: message.targetId,
      });
    });
  }

  // ---------------------------------------------------------------- 回执观察与恢复重试（F20）

  /** §6.3 回执观察（全局 session/event 等价钩子）：目标已持久接收 → 补记 delivered。 */
  async observeDelivery(memberId: string, messageId: string): Promise<void> {
    try {
      const state = this.loadState();
      const message = state.messages.find((m) => m.id === messageId);
      if (message === undefined || message.targetId !== memberId) return;
      if (state.delivered.includes(messageId)) return;
      if (this.deps.inspector.containsMessage(memberId, messageId)) {
        await this.markDelivered(message);
      }
    } catch (err) {
      this.deps.warn?.(`Team message "${messageId}" acknowledgement failed: ${errText(err)}`);
    }
  }

  /** §6.3 恢复重试：成员启动 → 其 pending 重投；Lead（"all"）→ 全量。 */
  async recoverFor(target: string): Promise<void> {
    const state = this.loadState();
    const targets =
      target === "all"
        ? [...new Set(state.messages.map((m) => m.targetId))]
        : [target];
    for (const targetId of targets) {
      const queue = this.pendingFor(this.loadState(), targetId);
      if (process.env.TEAM_DEBUG_DELIVERY === "1") {
        this.deps.warn?.(`delivery-recover target=${targetId} pending=${queue.length}`);
      }
      for (const message of queue) {
        const outcome = await this.tryDispatch(message);
        if (process.env.TEAM_DEBUG_DELIVERY === "1") {
          this.deps.warn?.(`delivery-recover target=${targetId} message=${message.id} status=${outcome.status} reason=${outcome.reason ?? ""}`);
        }
      }
    }
  }
}

function defaultSteerLead(framed: ContentBlock[], source: MessageSource): void {
  void framed;
  void source; // 进程内 Lead 恒可达：steer 即成功（stage-4 接 hook 通道）
}

function defaultNewId(): string {
  return globalThis.crypto.randomUUID();
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

