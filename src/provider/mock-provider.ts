// MockProvider：可编程延迟/失败/丢消息的 teammate 供给桩（单测与 stage-3 复用）。
// 实现 TeammateProvider（草案 §1 四方法）+ ReconciliationSource/TargetInspector（§5.4/§6.3 端口）。
// 持久化桩：provisioning 记录（rootSessionId / descriptor / 初始用户消息接收）与消息接收标记
// （received）——「收（received）」与「认（delivered 事件）」可分离，供恰一次/kill 点演练。

import { randomUUID } from "node:crypto";
import type { TeammateProvider } from "./teammate-provider.js";
import type { ProvisioningRecord, ReconciliationSource, TargetInspector } from "../domain/ports.js";

export type StartOutcome =
  | { kind: "accept" }
  | { kind: "reject" } // 返回 accepted:false（未持久接收）
  | { kind: "throw"; error: unknown }
  | { kind: "hang" }; // 挂起直到 signal 中止（模拟首轮 prompt 未持久接收的等待）

export interface MockChild {
  memberId: string;
  name: string;
  context: "fresh" | "fork";
  model: string | undefined;
  firstPrompt: string;
  alive: boolean;
  /** 已持久接收的消息 id（去重口径：再次 deliver 同 id 不重复写入）。 */
  received: Set<string>;
  /** 已投递（deliver 成功写入）次数——恰一次断言用。 */
  deliverCount: Map<string, number>;
  interrupted: number;
  drained: boolean;
  status: "running" | "idle";
}

export interface MockProviderProgram {
  startOutcome?: StartOutcome;
  /** startContinuable 延迟 ms。 */
  startDelayMs?: number;
  /** deliver 结果序列（循环取用；缺省全 "accepted"）。 */
  deliverResults?: Array<"accepted" | "queued" | "throw" | "lost">;
  deliverDelayMs?: number;
  /** 冷读（readColdRecord / containsMessage 冷路径）行为。 */
  coldRead?: "ok" | "throw";
  /** 冷拉起结局（deliver 遇不存活子进程时的行为；缺省 queued=保守滞留）。 */
  coldDeliverOutcome?: "accepted" | "queued";
  /** drain 行为：抛错（聚合语义验证）。 */
  drainError?: unknown;
  /** interrupt 行为：抛错（清理失败路径）。 */
  interruptError?: unknown;
}

export class MockProvider implements TeammateProvider, ReconciliationSource, TargetInspector {
  readonly teamChildren = new Map<string, MockChild>();
  /** 非团队子进程（§12「非 Team 的 continuable 子代理不动」验证）。 */
  readonly foreignChildren = new Set<string>();
  readonly provisioningRecords = new Map<string, ProvisioningRecord>();
  drainedTeamIds: string[] = [];
  drainCalls = 0;
  startCalls = 0;
  deliverCalls = 0;
  private program: MockProviderProgram = {};
  private deliverScript: Array<"accepted" | "queued" | "throw" | "lost"> = [];

  programWith(program: MockProviderProgram): this {
    this.program = program;
    this.deliverScript = program.deliverResults ? [...program.deliverResults] : [];
    return this;
  }

  async startContinuable(args: {
    teamId: string;
    memberId: string;
    name: string;
    description: string;
    firstPrompt: string;
    context: "fresh" | "fork";
    model?: string;
    signal?: AbortSignal;
  }): Promise<{ memberId: string; accepted: boolean }> {
    this.startCalls += 1;
    const outcome = this.program.startOutcome ?? { kind: "accept" as const };
    if (this.program.startDelayMs && this.program.startDelayMs > 0) {
      await sleep(this.program.startDelayMs);
    }
    if (outcome.kind === "hang") {
      await new Promise<never>((_, reject) => {
        const onAbort = () => reject((args.signal?.reason ?? new Error("aborted")) as unknown);
        if (args.signal?.aborted) return onAbort();
        args.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (outcome.kind === "throw") throw outcome.error;
    const child: MockChild = {
      memberId: args.memberId,
      name: args.name,
      context: args.context,
      model: args.model,
      firstPrompt: args.firstPrompt,
      alive: true,
      received: new Set<string>(),
      deliverCount: new Map<string, number>(),
      interrupted: 0,
      drained: false,
      status: "running", // 首轮 prompt 已投递 → 存活即 running（availability 口径）
    };
    this.teamChildren.set(args.memberId, child);
    // 持久化桩：四条件对账数据（accepted ⇒ 初始用户消息已持久接收）
    this.provisioningRecords.set(args.memberId, {
      rootSessionId: args.teamId,
      descriptor: { provider: args.context === "fork" ? "fork" : "spawn", mode: "continuable" },
      initialUserMessageAccepted: outcome.kind === "accept",
    });
    return { memberId: args.memberId, accepted: outcome.kind === "accept" };
  }

  async deliver(args: { memberId: string; framedMessage: string; messageId: string }): Promise<"accepted" | "queued"> {
    this.deliverCalls += 1;
    if (this.program.deliverDelayMs && this.program.deliverDelayMs > 0) {
      await sleep(this.program.deliverDelayMs);
    }
    const child = this.teamChildren.get(args.memberId);
    if (child === undefined || !child.alive) {
      // 冷拉起（§6.3 分支 3 的 steer 冷恢复路径）：可编程结局；accepted ⇒ 持久写入接收记录
      if (this.program.coldDeliverOutcome === "accepted") {
        const cold: MockChild = child ?? {
          memberId: args.memberId,
          name: args.memberId,
          context: "fresh",
          model: undefined,
          firstPrompt: "",
          alive: false,
          received: new Set<string>(),
          deliverCount: new Map<string, number>(),
          interrupted: 0,
          drained: false,
          status: "idle",
        };
        if (!cold.received.has(args.messageId)) {
          cold.received.add(args.messageId);
          cold.deliverCount.set(args.messageId, (cold.deliverCount.get(args.messageId) ?? 0) + 1);
        }
        if (child === undefined) this.teamChildren.set(args.memberId, cold);
        return "accepted";
      }
      return "queued"; // 冷目标保守滞留（宁滞留不重复）
    }
    const verdict = this.deliverScript.length > 0 ? this.deliverScript.shift() : "accepted";
    if (verdict === "throw") throw new Error(`mock deliver failure for ${args.messageId}`);
    if (verdict === "lost") {
      // 丢消息：不记录接收、不计数，返回 accepted（模拟「已应答未落目标」的丢失——由重试+去重兜底）
      return "accepted";
    }
    if (verdict === "queued") {
      return "queued"; // 已入 pending 持久化、未写入 transcript——不得记录 received（宁滞留不重复）
    }
    if (child.received.has(args.messageId)) {
      return "accepted"; // 去重：transcript 已含该消息身份（宁滞留不重复）
    }
    child.received.add(args.messageId);
    child.deliverCount.set(args.messageId, (child.deliverCount.get(args.messageId) ?? 0) + 1);
    return "accepted";
  }

  async interrupt(args: { memberId: string }): Promise<{ previousStatus: string }> {
    if (this.program.interruptError !== undefined) throw this.program.interruptError;
    const child = this.teamChildren.get(args.memberId);
    if (child === undefined || !child.alive) return { previousStatus: "inactive" };
    const previousStatus = child.status;
    child.interrupted += 1;
    child.status = "idle"; // 只取消当前回合；收件箱/任务归属不动（§5.6）
    return { previousStatus };
  }

  async drain(args: { teamId: string; timeoutMs: number }): Promise<void> {
    this.drainCalls += 1;
    if (this.program.drainError !== undefined) throw this.program.drainError;
    await sleep(Math.min(args.timeoutMs, 5));
    for (const child of this.teamChildren.values()) {
      if (child.alive) {
        child.alive = false;
        child.drained = true;
      }
    }
    this.drainedTeamIds.push(args.teamId);
    // foreignChildren 不动（§12：非团队子进程不动）
  }

  // ------------------------------------------------ ReconciliationSource（§5.4 桩）

  readProvisioningRecord(memberId: string): ProvisioningRecord | undefined {
    return this.provisioningRecords.get(memberId);
  }

  /** 测试直改桩（构造四条件缺失场景）。 */
  setProvisioningRecord(memberId: string, record: ProvisioningRecord | undefined): void {
    if (record === undefined) this.provisioningRecords.delete(memberId);
    else this.provisioningRecords.set(memberId, record);
  }

  // ------------------------------------------------ TargetInspector（§5.5/§6.3）

  isAlive(memberId: string): boolean {
    const child = this.teamChildren.get(memberId);
    return child !== undefined && child.alive;
  }

  containsMessage(memberId: string, messageId: string): boolean {
    const child = this.teamChildren.get(memberId);
    if (child === undefined) return this.readColdRecord(memberId, messageId)?.recorded ?? false;
    return child.received.has(messageId);
  }

  readColdRecord(memberId: string, messageId: string): { recorded: boolean } | undefined {
    if (this.program.coldRead === "throw") {
      throw new Error(`mock cold read failure for ${memberId}`);
    }
    const child = this.teamChildren.get(memberId);
    if (child === undefined) return undefined; // 无持久会话记录
    return { recorded: child.received.has(messageId) };
  }

  /** 测试辅助：外部把某消息标记为目标已持久接收（F20 回执观察等价钩子）。 */
  markReceived(memberId: string, messageId: string): void {
    const child = this.teamChildren.get(memberId);
    if (child) child.received.add(messageId);
  }

  /** 测试辅助：非团队子进程登记（drain 不动它们）。 */
  addForeignChild(memberId: string): void {
    this.foreignChildren.add(memberId);
  }

  /** 测试辅助：成员生死控制（成员启动/退出模拟）。 */
  killChild(memberId: string): void {
    const child = this.teamChildren.get(memberId);
    if (child) child.alive = false;
  }

  reviveChild(memberId: string): void {
    const child = this.teamChildren.get(memberId);
    if (child) child.alive = true;
  }

  // §5.5 呈现能力（listMembers 的 availability/model）

  statusOf(memberId: string): "running" | "inactive" {
    return this.isAlive(memberId) ? "running" : "inactive";
  }

  modelOf(memberId: string): string | undefined {
    return this.teamChildren.get(memberId)?.model;
  }

  newId(): string {
    return randomUUID();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
