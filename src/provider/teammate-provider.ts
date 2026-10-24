// TeammateProvider 接口 —— 接口草案 §1 逐字对齐（stage-1 冻结契约）。
// 唯一增补：args.signal?: AbortSignal（02 §5.3 步骤 3「调用方 signal 与运行时 signal 的
// AbortSignal.any」的承载位；草案 §1 注释引用了该语义但类型漏列）——已单列登记。

/** teammate 会话供给接口 —— 两实现（AppServerProvider / ResumePerTurnProvider），ADR-4 定版后主实现 + 兜底开关 */
export interface TeammateProvider {
  /** 创建可续跑成员会话并投递首轮 prompt。
   *  返回 { memberId: sess_…, accepted: boolean }；首轮 prompt = 任务原文（〔对齐轮〕0.2.1：身份由运行时上下文承载，不含前缀块）。
   *  context: "fresh"=新会话；"fork"=继承 Lead 上下文（app-server session/fork 或 D3 转录注入兜底）。
   *  实现 MUST 保证「落盘先于投递」：member(provisioning) 事件已 fsync 后才 spawn。
   *  accepted = 首轮 prompt 已被目标会话持久接收（02 §5.3 checkpointInitialPrompt 的承载口径）；
   *  accepted:false / 抛错 = 未持久接收（→ TEAM_PROVISIONING_CONFLICT 分支或失败路径）。 */
  startContinuable(args: {
    teamId: string;
    memberId: string;
    name: string;
    description: string;
    firstPrompt: string;
    context: "fresh" | "fork";
    model?: string; // 缺省 = provider 默认（最低档）
    signal?: AbortSignal;
  }): Promise<{ memberId: string; accepted: boolean }>;

  /** 向成员会话投递一条已框架化消息（「Team message from <name>: 」前缀，逐字；〔对齐轮〕0.2.1 无消息 id）。
   *  返回 "accepted"（本轮调用内完成拉起/写入）或 "queued"（目标运行中，已入 pending 持久化；〔对齐轮〕0.2.1 已删 pending 上限）。
   *  实现不得重复投递：拉起前查 transcript 去重（崩溃在收/认之间 → 宁滞留不重复）。 */
  deliver(args: { memberId: string; framedMessage: string; messageId: string }): Promise<"accepted" | "queued">;

  /** 中断成员当前轮次，保留 pending 队列与任务归属；previousStatus 语义保留。
   *  会话必须仍可续（session/stop 或 SIGTERM→宽限 3s→SIGKILL；--resume 完好性由 H5 保证）。 */
  interrupt(args: { memberId: string }): Promise<{ previousStatus: string }>;

  /** 处置：关准入 → 唤醒等待者 → 限时结算（disposalTimeoutMs）→ 终止全部轮次进程。
   *  D9：daemon SIGINT handler 尽力 + 冷启动恢复对账兜底；不承诺每次完整处置日志。 */
  drain(args: { teamId: string; timeoutMs: number }): Promise<void>;
}
