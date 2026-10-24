// 文案词典（02 §10.7 逐字，命名空间 agent-team；F08 零容忍项）。
// 纪律：DICT 恰为规格 25 键——不得增删改（〔核查修订 B7〕无 status.deleted 键，
// deleted 复用 completed 文案由 statusKey() 承担）；T5.7 成员会话查看视图的新增文案
// 一律放 DETAIL_DICT（无 DSH 参照的设计物，V16 口径），避免污染逐字 diff 面。

export type Lang = "zh" | "en";

/** 规格 §10.7 的 25 键（键序 = 规格表行序；F08 断言用）。 */
export const DICT_KEYS = [
  "trigger",
  "loading",
  "unavailable",
  "failure",
  "empty",
  "roster",
  "tasks",
  "model",
  "open",
  "current",
  "owner",
  "unowned",
  "blockedBy",
  "writeScopes",
  "ready",
  "blocked",
  "task.expand",
  "task.collapse",
  "memberStatus.running",
  "memberStatus.inactive",
  "memberStatus.provisioning",
  "memberStatus.failed",
  "status.pending",
  "status.in_progress",
  "status.completed",
] as const;

export type DictKey = (typeof DICT_KEYS)[number];

export const DICT: Record<Lang, Record<DictKey, string>> = {
  zh: {
    trigger: "智能体团队",
    loading: "正在加载团队…",
    unavailable: "Team 暂不可用",
    failure: "团队持久记录无效：{message}",
    empty: "暂无共享任务，可以通过对话创建",
    roster: "成员",
    tasks: "共享任务",
    model: "模型",
    open: "打开成员会话",
    current: "当前会话",
    owner: "Owner",
    unowned: "未分配",
    blockedBy: "依赖",
    writeScopes: "写入范围",
    ready: "可开始",
    blocked: "被依赖阻塞",
    "task.expand": "展开",
    "task.collapse": "收起",
    "memberStatus.running": "运行中",
    "memberStatus.inactive": "未运行",
    "memberStatus.provisioning": "准备中",
    "memberStatus.failed": "失败",
    "status.pending": "待处理",
    "status.in_progress": "进行中",
    "status.completed": "已完成",
  },
  en: {
    trigger: "Agent Team",
    loading: "Loading Team…",
    unavailable: "Team is unavailable",
    failure: "Invalid persisted Team record: {message}",
    empty: "No shared tasks yet. Create them through the conversation.",
    roster: "Members",
    tasks: "Shared tasks",
    model: "Model",
    open: "Open member conversation",
    current: "Current chat",
    owner: "Owner",
    unowned: "Unowned",
    blockedBy: "Blocked by",
    writeScopes: "Write scopes",
    ready: "Ready",
    blocked: "Blocked by dependencies",
    "task.expand": "Show more",
    "task.collapse": "Show less",
    "memberStatus.running": "Running",
    "memberStatus.inactive": "Inactive",
    "memberStatus.provisioning": "Provisioning",
    "memberStatus.failed": "Failed",
    "status.pending": "Pending",
    "status.in_progress": "In progress",
    "status.completed": "Completed",
  },
};

/**
 * T5.7 成员会话查看视图新增文案（无 DSH 参照 → 按宿主风格；不进 F08 逐字面）。
 * zh/en 键集必须一致（F08 的「en 键集完整」精神延用）。
 */
export const DETAIL_DICT = {
  zh: {
    "detail.back": "返回",
    "detail.title": "成员会话",
    "detail.loading": "正在加载会话…",
    "detail.empty": "该成员暂无会话消息",
    "detail.failed": "会话读取失败：{message}",
    "detail.refresh": "刷新",
    "detail.copySessionId": "复制会话 id",
    "detail.copied": "已复制",
    "detail.earlier": "更早消息",
    "detail.wake": "请求 Lead 唤醒该成员",
    "detail.wakeInjected": "已注入下一轮：请求唤醒 {name}",
    "detail.framedFrom": "Team 消息 · 来自 {name}",
    "detail.hookBadge": "hook 注入",
    "detail.toolCall": "工具调用",
    "detail.noSession": "会话 id 未落定（成员可能尚在准备中）",
    "detail.you": "我",
    "detail.count": "{n} 条",
  },
  en: {
    "detail.back": "Back",
    "detail.title": "Member conversation",
    "detail.loading": "Loading conversation…",
    "detail.empty": "No conversation messages for this member yet",
    "detail.failed": "Conversation read failed: {message}",
    "detail.refresh": "Refresh",
    "detail.copySessionId": "Copy session id",
    "detail.copied": "Copied",
    "detail.earlier": "Earlier messages",
    "detail.wake": "Ask Lead to wake this member",
    "detail.wakeInjected": "Injected for next turn: wake request for {name}",
    "detail.framedFrom": "Team message · from {name}",
    "detail.hookBadge": "hook injected",
    "detail.toolCall": "Tool call",
    "detail.noSession": "Session id not settled yet (member may still be provisioning)",
    "detail.you": "me",
    "detail.count": "{n} items",
  },
} as const;

export type DetailDictKey = keyof (typeof DETAIL_DICT)["zh"];

/** t()：词典取值 + {message}/{name}/{n} 插值（规格 failure 键带 {message}）。 */
export function t(lang: Lang, key: DictKey, vars?: Record<string, string | number>): string {
  return interpolate(DICT[lang][key], vars);
}

export function td(lang: Lang, key: DetailDictKey, vars?: Record<string, string | number>): string {
  return interpolate(DETAIL_DICT[lang][key], vars);
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (vars === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) =>
    k in vars ? String(vars[k]) : m,
  );
}

/** locale → Lang（zh* → zh，其余 → en；宿主 locale 形如 zh-CN / en-US）。 */
export function langOfLocale(locale: string | undefined | null): Lang {
  return typeof locale === "string" && locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}

/** 任务状态 → 词典键（〔核查修订 B7〕deleted 复用 completed；视图本身不含 deleted 任务）。 */
export function statusKey(status: "pending" | "in_progress" | "completed" | "deleted"): DictKey {
  return status === "deleted" ? "status.completed" : `status.${status}`;
}

/** 成员状态 → 词典键。 */
export function memberStatusKey(
  status: "running" | "inactive" | "provisioning" | "failed",
): DictKey {
  return `memberStatus.${status}`;
}
