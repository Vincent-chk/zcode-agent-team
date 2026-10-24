// 视图帧夹具（T5.6 视觉回归 8 组状态；F01 枚举）：
// 空团队 / 单 Lead 紧凑 / 满员 8 成员 / 六态任务 / failed 成员 / failure 终态 /
// 长文本截断 / 窄容器（= 常规状态在窄视口渲染，夹具帧复用满员）。
// 纯数据（与渲染器解耦；Playwright 夹具页与 team-ctl widget 演示同源）。

import type { ViewFrame } from "../../src/ui-core/view.js";
import type { TeamTaskView } from "../../src/domain/task-view.js";

const TEAM = "sess_fixture_lead";

function member(
  name: string,
  status: "running" | "inactive" | "provisioning" | "failed",
  extra: Partial<{ model: string; diagnostics: string[]; sessionId: string }> = {},
): ViewFrame["members"][number] {
  return {
    target: name,
    role: name === "lead" ? "lead" : "teammate",
    status,
    diagnostics: extra.diagnostics ?? [],
    id: name === "lead" ? TEAM : `m_${name}`,
    sessionId: extra.sessionId ?? (name === "lead" ? TEAM : `sess_${name}`),
    ...(extra.model !== undefined ? { model: extra.model } : {}),
    ...(name === "lead" ? {} : { description: `${name} 的职责描述`, provider: "spawn", context: "fresh" as const }),
  };
}

function task(id: string, subject: string, description: string, partial: Partial<TeamTaskView> = {}): TeamTaskView {
  return {
    id,
    revision: 1,
    subject,
    description,
    status: "pending",
    blockedBy: [],
    writeScopes: [],
    ready: true,
    writeScopeWarnings: [],
    ...partial,
  };
}

function frame(partial: Partial<ViewFrame> & { members: ViewFrame["members"]; tasks: TeamTaskView[] }, seq = 7): ViewFrame {
  return {
    type: "view",
    stateVersion: 4,
    team: { teamId: TEAM, status: "active", seq },
    meta: { generatedAt: "2026-10-18T00:00:00.000Z", revision: seq, sessionId: TEAM },
    ...partial,
  };
}

/** ① 空团队（无 Team 值 → §10.4 unavailable 通知条；team:null）。 */
export const FIXTURE_EMPTY: ViewFrame = {
  type: "view",
  stateVersion: 4,
  team: null,
  members: [],
  tasks: [],
  meta: { generatedAt: "2026-10-18T00:00:00.000Z", revision: 0 },
};
export const FIXTURE_SOLO_LEAD: ViewFrame = frame({
  members: [member("lead", "running", { model: "claude-sonnet-4-5" })],
  tasks: [],
});

/** ③ 满员 8 成员（maxMembers=8：lead + 7 teammate，四态齐现）。 */
export const FIXTURE_FULL: ViewFrame = frame({
  members: [
    member("lead", "running", { model: "claude-sonnet-4-5" }),
    member("alice", "running", { model: "gpt-5.1" }),
    member("bob", "inactive"),
    member("carol", "provisioning"),
    member("dave", "failed", { diagnostics: ["child Session recovery failed: spawn ETIMEDOUT"] }),
    member("erin", "inactive"),
    member("frank", "running"),
    member("grace", "inactive"),
  ],
  tasks: [
    task("task-1", "接入持久事件日志", "从 events.jsonl 全量重放。", { status: "in_progress", ownerName: "alice" }),
    task("task-2", "任务板 CAS", "revision 不一致拒绝写入。", { ownerName: "bob" }),
  ],
});

/** ④ 六态任务（pending∧ready / pending∧¬ready / in_progress / completed ×2 + 警告）。 */
export const FIXTURE_TASK_STATES: ViewFrame = frame({
  members: [member("lead", "running"), member("alice", "inactive")],
  tasks: [
    task("task-1", "域核心纯逻辑层", "事件 schema、重放、不变量校验。", { status: "completed", ownerName: "lead" }),
    task("task-2", "协调层接线", "journal/lock/rpc/checkpoint 装配。", {
      status: "in_progress",
      ownerName: "alice",
      writeScopes: ["src/coord"],
    }),
    task("task-3", "工具面注册", "9 工具 schema 与描述逐字。", { ready: true, writeScopes: ["src/mcp"] }),
    task("task-4", "面板数据面", "订阅推帧与快照基线。", {
      ready: false,
      blockedBy: ["task-2"],
      writeScopes: ["src/coord", "src/panel"],
      writeScopeWarnings: ["write scopes overlap with task-2"],
    }),
    task("task-5", "骨架搭建", "六组件清单。", { status: "completed", ownerName: "lead" }),
  ],
});

/** ⑤ failed 成员（诊断行 + error 状态点）。 */
export const FIXTURE_FAILED_MEMBER: ViewFrame = frame({
  members: [
    member("lead", "running"),
    member("bob", "failed", { diagnostics: ["spawn failed: Client closed"] }),
    member("carol", "inactive"),
  ],
  tasks: [task("task-1", "继续推进", "由 carol 接手。", { ownerName: "carol" })],
});

/** ⑥ failure 终态（§10.4 第三型：failure 条 + 最后有效状态照常渲染）。 */
export const FIXTURE_FAILURE: ViewFrame = frame({
  team: { teamId: TEAM, status: "failure", failure: 'invalid event at line 42: member "x" duplicated', seq: 42 },
  members: [member("lead", "inactive"), member("alice", "inactive")],
  tasks: [task("task-1", "冻结前任务", "视图冻结。", { status: "in_progress", ownerName: "alice" })],
});

/** ⑦ 长文本截断（3+ 行描述 → 两行截断 + 展开开关；30 字长名字）。 */
export const FIXTURE_LONG_TEXT: ViewFrame = frame({
  members: [
    member("lead", "running"),
    member("这是一个非常非常长的成员名字用于验证省略号截断行为", "inactive"),
  ],
  tasks: [
    task(
      "task-1",
      "超长标题验证：任务标题本身也可能很长需要截断处理",
      "第一行：任务描述用于两行截断验证。\n第二行：展开开关应当在实测溢出时出现。\n第三行：收起后恢复两行截断。\n第四行：aria-expanded 同步。",
      { status: "in_progress", ownerName: "lead", writeScopes: ["src/ui-core", "docs"] },
    ),
  ],
});

/** ⑧ 窄容器（帧复用满员；视口 ≤480px 由回归脚本控制）。 */
export const FIXTURE_NARROW: ViewFrame = FIXTURE_FULL;

export const FIXTURES: Record<string, ViewFrame> = {
  empty: FIXTURE_EMPTY,
  "solo-lead": FIXTURE_SOLO_LEAD,
  full: FIXTURE_FULL,
  "task-states": FIXTURE_TASK_STATES,
  "failed-member": FIXTURE_FAILED_MEMBER,
  failure: FIXTURE_FAILURE,
  "long-text": FIXTURE_LONG_TEXT,
  narrow: FIXTURE_NARROW,
};

// ---------------------------------------------------------------- stage-8 D 成员设置弹窗夹具

/** 弹窗夹具：目录（含禁用 provider / 无 reasoning 模型）+ 当前生效值（继承自 Lead）。 */
export const FIXTURE_SETTINGS = {
  memberId: "m_alice",
  name: "alice",
  catalog: {
    providers: [
      {
        providerId: "prov-bigmodel",
        name: "BigModel - Coding Plan",
        kind: "anthropic",
        enabled: true,
        models: [
          { id: "GLM-5.3", reasoning: { variants: ["low", "high", "max"], defaultVariant: "max" } },
          { id: "GLM-5.3-Flash", reasoning: { variants: ["low", "high", "max"], defaultVariant: "max" } },
        ],
      },
      {
        providerId: "prov-deepseek",
        name: "DeepSeek",
        kind: "openai",
        enabled: true,
        models: [{ id: "deepseek-flash" }],
      },
      {
        providerId: "prov-off",
        name: "Z.ai - Coding Plan",
        kind: "anthropic",
        enabled: false,
        disabledReason: "oauth_provider_inactive",
        models: [{ id: "GLM-5.3" }],
      },
    ],
  },
  current: {
    model: "GLM-5.3",
    providerId: "prov-bigmodel",
    reasoningLevel: "high",
    source: "inherited" as const,
  },
  draft: { providerId: "prov-bigmodel", modelId: "GLM-5.3", reasoningLevel: "high" },
};

/** 弹窗背景帧（成员行含 alice，齿轮上下文可见）。 */
export const FIXTURE_SETTINGS_FRAME: ViewFrame = frame({
  members: [
    member("lead", "running", { model: "claude-sonnet-4-5" }),
    member("alice", "running", { model: "GLM-5.3" }),
    member("bob", "inactive"),
  ],
  tasks: [
    task("task-1", "面板模型设置", "齿轮打开成员模型弹窗。", { ownerName: "alice" }),
    task("task-2", "模型目录脱敏", "apiKey/baseURL 不出 daemon。", { status: "completed", ownerName: "bob" }),
    task("task-3", "对话通道", "member_set_model 与 team://models。", {
      status: "in_progress",
      ownerName: "alice",
      writeScopes: ["src/mcp"],
    }),
    task("task-4", "验收回写", "规格 §10 修订留 Round E。", { ready: false, blockedBy: ["task-3"] }),
  ],
});

// ---------------------------------------------------------------- T5.7 detail 夹具（+1 组成员转录快照）
/** detail 结果夹具（成员转录：framed 徽标 + 工具折叠 + 长文本/中英混排 + 分页）。 */
export const FIXTURE_DETAIL = {
  sessionId: "sess_alice_child",
  memberId: "m_alice",
  total: 132,
  page: {
    nextCursor: 33,
    items: [
      {
        seq: 33,
        ts: "2026-10-18T03:11:02.000Z",
        role: "user" as const,
        kind: "text" as const,
        text: "Team message from lead:\n请推进 stage-5 面板数据面，完成后汇报。",
        framed: { messageId: "msg-77", from: "lead" },
      },
      {
        seq: 34,
        ts: "2026-10-18T03:11:09.000Z",
        role: "assistant" as const,
        kind: "text" as const,
        text: "收到，先读 daemon 接线。",
      },
      {
        seq: 35,
        ts: "2026-10-18T03:11:20.000Z",
        role: "assistant" as const,
        kind: "toolCall" as const,
        tool: { name: "Read", status: "completed" },
        text: 'input: {"file_path":"/src/daemon.ts"}\noutput: (file content 480 lines)',
      },
      {
        seq: 36,
        ts: "2026-10-18T03:12:41.000Z",
        role: "assistant" as const,
        kind: "toolCall" as const,
        tool: { name: "Bash", status: "completed" },
        text: "input: {\"command\":\"npx vitest run test/panel\"}\noutput: Tests 45 passed (45)",
      },
      {
        seq: 37,
        ts: "2026-10-18T03:13:05.000Z",
        role: "assistant" as const,
        kind: "text" as const,
        text:
          "数据面接线完成：team://view 现在返回真实投影视图帧（MEMBER_VIEW ⊕ id/sessionId + TASK_VIEW），" +
          "500ms 轮询构帧、contentKey 去抖（mailbox-only changes do not push frames——中英混排 long text layout check " +
          "with a very long unbreakable token like Pneumonoultramicroscopicsilicovolcanoconiosis 和中文长串".repeat(2) + "）",
      },
      {
        seq: 38,
        ts: "2026-10-18T03:13:40.000Z",
        role: "user" as const,
        kind: "text" as const,
        text: "很好，继续 detail 通道。",
      },
    ],
  },
};

/** detail 空态（无消息三态之二）。 */
export const FIXTURE_DETAIL_EMPTY = {
  sessionId: "sess_new_child",
  memberId: "m_new",
  total: 0,
  page: { items: [] },
};
