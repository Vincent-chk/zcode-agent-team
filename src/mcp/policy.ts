// 〔issue #9 三档化 D28〕LeadMode 枚举真源在 domain/config.ts；本文件只承载注入文本与拼装
// （buildSessionStartContext 第三参 = 模式段文本，由 hooks 按档位+建队状态算好传入）。

// 策略三层注入的定版文本（stage-3 T3.3；〔对齐轮修订 2026-10-17〕换版 0.2.1-alpha.5，冻结包 06 §3.1）。
// 主通道 = SessionStart hook additionalContext（src/hooks.ts 经 buildSessionStartContext 组装）；
// 辅通道 = skills/team-coordination/SKILL.md（同文）；兜底 = 工具 description（tools.ts）。
//
// 文本以冻结包 06 §3.1 为基准，ZCode 适配：
//  - D7 冻结替换句（第 3 段 FS_STALE_VERSION 一句改写为 ZCode 文件冲突语义等价句）；
//  - D5（0.2.1）：首段门控从句删除 → 首段仅 "Agent Teams is available in this session"。
// 第 4 段含 interrupt 插值（D3）；2026-11-04 按 ZCode 实测修订消息交付与任务闭环，三通道同文。
// 模式段仅对 Lead 注入；auto 首次建队结果亦附完整 ON_DEMAND_SECTION_TEXT。

/**
 * team:policy 全文（ZCode 消息/任务语义；D7 文件冲突句；D3 interrupt 插值）。
 * 四段，空行分隔。注入形态 = hook additionalContext（`hook_context` 用户侧消息，D10）。
 */
export function teamPolicy(interrupt: boolean): string {
  return (
    `Agent Teams is available in this session\n` +
    `\n` +
    `The Team Lead and all teammates share the same working directory and filesystem. Edits are immediately visible to every member. Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. Write-scope overlap is advisory, not a lock.\n` +
    `\n` +
    `Prefer read/edit/write for file changes. If a file operation reports that the file changed since you last read it, read the current file again, rebase your intended change onto the new content, and retry. Bash, formatters, code generators, and scripts are not fully protected by the filesystem version guard; coordinate them explicitly and have the Lead review the final diff and run tests.\n` +
    `\n` +
    `Use the target returned by spawn_teammate or list_agents for send_message${interrupt ? " and interrupt_agent" : ""}, or as owner when assigning or filtering shared tasks. send_message queues delivery to a running teammate's next turn boundary and starts or resumes an inactive teammate. The Lead receives queued messages through wait_agent during its current turn, with session hooks as a fallback. inactive means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents. provisioning means member creation is in progress; failed means member creation failed. A peer message starts with its sender name. A successful send does not mean the recipient has processed it. Each delegated unit needs a shared task with acceptance criteria. Create it before dispatching the work; the teammate must list/get it, claim with the current revision, perform the work, then complete and report to the Lead. An initial prompt or an output file is not a task-board record. Task readiness never starts an owner. Use wait_agent to receive pending Lead inbox messages before sending follow-ups, even when teammates are inactive. With no pending messages, it waits for new changes and returns noProgress immediately when no other member can produce a change; it never wakes a member. Consume returned messages, then recheck shared tasks before deciding whether more work or another message is needed. Re-list after wakeup or timeout. The Lead must wait for required teammates before giving the final answer.`
  );
}

/** 默认（interrupt=true）策略文本；hook 注入使用本常量。 */
export const POLICY_TEXT = teamPolicy(true);

/**
 * D7 冻结替换句对照（登记用；不参与运行逻辑）。
 * 原句（02 §9.2 第 3 段）：
 *   "If a file operation returns FS_STALE_VERSION, read the current file, rebase your intended change onto the new content, and retry."
 * ZCode 等价句（本 stage 冻结）：
 *   "If a file operation reports that the file changed since you last read it, read the current file again, rebase your intended change onto the new content, and retry."
 */
export const D7_ORIGINAL_SENTENCE =
  "If a file operation returns FS_STALE_VERSION, read the current file, rebase your intended change onto the new content, and retry.";
export const D7_REPLACEMENT_SENTENCE =
  "If a file operation reports that the file changed since you last read it, read the current file again, rebase your intended change onto the new content, and retry.";

/** SessionStart hook 注入前缀（接口草案 §4 冻结模板）。 */
export const HOOK_POLICY_PREFIX = "[agent-team]";

/**
 * team:identity 运行时上下文两分支（〔对齐轮〕0.2.1 D2；冻结包 06 §3.2 逐字）。
 * 字节级事实：无 <system-reminder> 包装、无前导/尾随换行。
 * ZCode 等价承载 = SessionStart hook additionalContext 同层交付（startup/resume 每轮重注入
 * ——对齐 required/抗压缩语义；验收标准 F03/F08 对齐轮修订口径）。
 * teammate 分支的 ${name} = 成员名替换（session-map 映射；无映射会话一律 Lead 分支）。
 */
export const IDENTITY_LEAD_TEXT =
  `You are the Team Lead named "lead".\n` +
  `Use list_agents({}) to find your teammates and their names.\n` +
  `To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).`;

export function identityTeammateText(name: string): string {
  return (
    `You are teammate "${name}".\n` +
    `Your Team Lead is named "lead".\n` +
    `To message your Team Lead, use send_message({ target: "lead", message: "..." }).\n` +
    `Use list_agents({}) to find your teammates and their names.\n` +
    `To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).`
  );
}

/**
 * F08 暗号（stage-3 定版）：hook 注入的策略上下文尾部附一行验证标记——真实会话中询问
 * 模型该标记可复述 = 注入到达模型上下文的证据（startup/resume 两路各验一次）。
 * 标记不属于策略正文（正文逐字不动），是注入载体的一部分（D10 口径）。
 */
export const POLICY_PROBE_MARKER = "quartz-ember-73";

/**
 * Lead 编排模式附加段（〔stage-6.5 D26〕2026-10-24 定稿；stage-6.5/开发规划 §3 逐字）。
 * 〔issue #9 三档化 D28〕本段仅注入 **always** 档 Lead 会话；语义 = 分解→默认委派→自主组队→
 * 带验收标准任务→Lead 独立复核（reopen 带问题 / edit 追加验收记录 = D27 标记完成闭环）→护栏。
 * 红线：不含 interrupt_agent / do not resend 子串。
 */
export const ORCHESTRATOR_SECTION_TEXT =
  "Lead operating mode (orchestrator): Decompose any non-trivial multi-step request into disjoint work packages before doing hands-on work. Do not edit files or implement directly except trivial one-line fixes or when no eligible member exists — delegate by creating teammates that cover the roles the goal requires. You decide the team composition and spawn it without being asked; consult the user only when the choice materially changes cost or scope. Turn every delegated unit into a shared task whose description states concrete acceptance criteria, assign an owner, record expected write scopes, and set dependencies when ordering matters. Require each owner to self-check and report changed files and test results before completing. When a task reaches completed, verify it independently: review the final diff and run the relevant tests yourself; if it fails, reopen the task with concrete findings; if it passes, append your acceptance verdict to the task description — a task is done when completed plus your recorded acceptance. Reuse idle teammates before spawning new ones and keep one member per role, within the member limit. You still wait for required teammates and synthesize their results for the final answer.";

/**
 * Lead 按需委派附加段（〔issue #9 三档化 D28〕2026-11-02 定稿）。
 * 仅注入 **auto 档且该会话曾建过队** 的 Lead 会话（hooks 用 teamEverCreated 判定后传入）；
 * 语义 = 委派价值门槛 + 正反例（Lead 直接处理 / 走团队流程）+ 委派时沿用 D26 的
 * 验收标准/独立复核/护栏句（验收闭环语义与 always 档一致）。
 * 红线：不含 interrupt_agent / do not resend 子串。
 */
export const ON_DEMAND_SECTION_TEXT =
  "Lead operating mode (on-demand): Judge each request by delegation value before using the team. Handle work directly yourself — with a one-line reason, no forced tasks — for questions and explanations, small changes confined to a single file, read-only research summaries, or when every teammate is busy and the request is unrelated to existing work. Use the team workflow when work clearly benefits from multiple roles in parallel, when write scopes must be split across members, when a long task deserves its own context, or when the user explicitly names members. When you delegate, turn each delegated unit into a shared task whose description states concrete acceptance criteria, assign an owner, record expected write scopes, and set dependencies when ordering matters. Require each owner to self-check and report changed files and test results before completing. When a task reaches completed, verify it independently: review the final diff and run the relevant tests yourself; if it fails, reopen the task with concrete findings; if it passes, append your acceptance verdict to the task description — a task is done when completed plus your recorded acceptance. Reuse idle teammates before spawning new ones and keep one member per role, within the member limit. Wait for required teammates and synthesize their results for the final answer.";

/**
 * auto 档「会话中途首建队」提示（〔issue #9 D28〕）：SessionStart 只在 startup|resume 触发，
 * 首次 spawn 发生在中途不会重跑——以独立 text 块附在首成员 spawn 成功结果尾部（withFailLoud
 * 同款追加方式，不改结果 JSON 本体）。语义 = 团队模式已激活 + 此后按委派价值判断。
 */
export const FIRST_SPAWN_NOTE =
  `[agent-team] Team mode is now active: this is the first teammate of this session.\n${ON_DEMAND_SECTION_TEXT}`;

/**
 * 订阅套餐降级提示（〔issue #5 / D29〕2026-11-02；〔D30 修订〕2026-11-02 改为事实描述）。
 *
 * **为什么不写禁止句**：本提示注入到对话历史，是不可撤销的强指令。实测（2026-11-02 真订阅会话）
 * 证明「do not call spawn_teammate」一旦入史，后续的告知式撤回提示压不过它——用户切到第三方模型后
 * 模型仍拒绝尝试 spawn，表现为「切了还是不可用」。故改为**只陈述当前事实 + 明确恢复条件**，
 * 不禁止任何调用：模型读到的是「此刻 spawn 会失败（原因：套餐凭据不可继承）」，
 * 加上「一旦切换为非套餐模型即可正常使用、无需额外确认」，切模型后模型自然会试。
 * 红线：不含 interrupt_agent / do not resend。
 */
export const DEGRADED_SOLO_NOTE =
  "[agent-team] Heads-up (informational, not a restriction): in this session the Lead's model is an official plan model whose credentials teammate processes cannot inherit, so a spawn_teammate call made right now would fail with an inheritance error. Doing the work directly is the reliable path while that remains true. This is a statement of the current state, not a standing rule: the moment the Lead's model is a self-configured third-party provider, spawn_teammate works normally — just call it as usual, no extra confirmation needed. Ask the user to switch the Lead model if teammates are wanted.";

/**
 * 订阅降级撤回提示（〔issue #5 / D30〕2026-11-02）：startup 提示按宿主 SessionStart 载荷判定，
 * 用户在首条消息前（或会话中途）切到第三方模型时该提示已过时 → 对账（UPS 复探三源 / resume 载荷）
 * 确认非套餐后**一次性**撤回（soloRetractedAt 锚）。
 * 措辞与 DEGRADED_SOLO_NOTE 同为事实描述，但额外显式解除早前提示的约束力（兼容已被旧版
 * 禁止句污染的会话）。红线：不含 interrupt_agent / do not resend。
 */
export const SOLO_RETRACT_NOTE =
  "[agent-team] Update — the earlier unavailability notice no longer applies. The Lead's model is now a self-configured third-party provider, so teammate processes can inherit it and spawn_teammate works normally. Treat that earlier notice as superseded and expired; any instruction in it to avoid spawn_teammate is void. Call spawn_teammate as usual whenever delegation adds value — no re-confirmation needed. Also tell the user in one short line that teammates are available again (they cannot see this notice, and 2026-11-02 feedback showed the recovery was invisible to them).";

/**
 * 按身份分支构建 SessionStart 注入全文（策略 + 身份 + 可选模式段 + 可选暗号行，各一行 [agent-team] 前缀）。
 * 〔issue #9 三档化 D28〕第三参从 leadMode 枚举改为 **模式段文本**（调用方算好传入）：
 *   always → ORCHESTRATOR_SECTION_TEXT；auto 且已建队 → ON_DEMAND_SECTION_TEXT；
 *   auto 未建队 / teammate / 不追加 → undefined。off 档 hooks 整体不输出（不进入本函数）。
 * 探针标记只在显式 `TEAM_POLICY_PROBE=1` 时注入；生产默认不污染模型上下文。
 */
export function buildSessionStartContext(
  identityText: string,
  interrupt = true,
  modeSection?: string,
): string {
  const policy = teamPolicy(interrupt);
  const section = modeSection !== undefined ? `\n${HOOK_POLICY_PREFIX} ${modeSection}` : "";
  const probe =
    process.env.TEAM_POLICY_PROBE === "1"
      ? `\n${HOOK_POLICY_PREFIX} 策略注入验证标记：${POLICY_PROBE_MARKER}`
      : "";
  return `${HOOK_POLICY_PREFIX} ${policy}\n${HOOK_POLICY_PREFIX} ${identityText}${section}${probe}`;
}

/** SessionStart additionalContext 定版全文（缺省 = Lead 分支 + 新默认 auto·未建队 = 策略+身份，无模式段；teammate 会话由 hooks 换分支）。 */
export const SESSION_START_CONTEXT = buildSessionStartContext(IDENTITY_LEAD_TEXT, true);


/**
 * fail-loud 警告行（D10）：daemon 检测到本会话 hook 注入未生效时，附在团队工具结果尾部的
 * 一行警告文本（独立 text 块，不改结果 JSON schema）。
 */
export const FAIL_LOUD_WARNING =
  "[agent-team] 警告：未检测到本会话的策略注入（SessionStart hook 可能未生效）。请确认插件已启用且 hooks 声明存在；团队工具仍可调用，但模型可能未加载完整协作策略。";

/**
 * wait_agent no-active-peer 捷径常量（02 §8 逐字）。
 * reason 为 const "no-active-peer"；message 逐字。
 */
export { NO_PROGRESS_REASON, NO_PROGRESS_MESSAGE, noProgressResult } from "../domain/activity.js";

// 注（〔对齐轮〕0.2.1 换版）：旧风险表「queued 结果附 do-not-resend 提示」随 0.2.1 一并失效——
// send 不再返回 queued/accepted 状态（工具层 {sent:true}），策略旧句 "do not resend" 已删除并替换为
// "A successful send does not mean the recipient has processed it."（冻结包 06 §3.1，逐字）。E2E 观察项进 stage-6。
