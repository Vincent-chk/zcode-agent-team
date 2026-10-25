// 面板/卡片同源渲染器（纯函数，零 DOM 依赖 → 面板 iife 与 ::visualize 卡片、Playwright
// 夹具、team-ctl 静态导出共用；V15 基线共用前提）。几何/文案/状态点映射 = 02 §10.4–§10.6，
// 逐条对照 assets/TeamAction.module.pretty.css。
// 只读口径（§10.6/F07）：本渲染器不产出任何任务/成员变更控件——只读展示 + 展开开关 +
// （面板）成员行点击下钻 detail（交互由载体绑定，见 panel-main/widget）。

import type { ViewFrame, ViewFrameMember } from "./view.js";
import type { TeamTaskView } from "../domain/task-view.js";
import { type Lang, t, statusKey, memberStatusKey } from "./dict.js";
import { iconUser, iconChevron } from "./icons.js";
import { esc } from "./escape.js";

export { esc } from "./escape.js";

/** 紧凑模式判定（§10.3/V01：仅 1 成员且 0 任务）。 */
export function isCompact(frame: ViewFrame): boolean {
  return frame.members.length === 1 && frame.tasks.length === 0;
}

/** 当前会话成员 id（§10.5「当前会话」高亮/禁用判定）：sessionId 命中调用方会话。 */
export function currentMemberId(frame: ViewFrame): string | undefined {
  const sid = frame.meta.sessionId;
  if (sid === undefined) return undefined;
  return frame.members.find((m) => m.sessionId === sid)?.id;
}

/** 成员是否禁用（§10.5：当前会话行、failed、provisioning 禁用；其余可点下钻）。 */
export function isMemberDisabled(m: ViewFrameMember, currentId: string | undefined): boolean {
  return m.id === currentId || m.status === "failed" || m.status === "provisioning";
}

/** 成员状态 → 状态点类（§10.5/F09：running/provisioning→ongoing、failed→error、inactive→人形图标）。 */
export type DotState = "ongoing" | "error" | "idle" | "warning" | "done";
export function memberDot(status: ViewFrameMember["status"]): DotState | "icon" {
  switch (status) {
    case "running":
    case "provisioning":
      return "ongoing";
    case "failed":
      return "error";
    case "inactive":
    default:
      return "icon";
  }
}

/** 任务状态 → 状态点类（§10.6/F09）。 */
export function taskDot(task: TeamTaskView): DotState {
  switch (task.status) {
    case "in_progress":
      return "ongoing";
    case "completed":
      return "done";
    case "deleted":
      return "idle"; // 上游 deleted→idle（视图通常不含墓碑，防御口径）
    case "pending":
    default:
      return task.ready ? "idle" : "warning";
  }
}

function dot(state: DotState): string {
  return `<span class="dot ${state}"></span>`;
}

/** 状态指示（成员）：inactive → 14px 人形图标；其余 → 状态点。 */
function memberIndicator(m: ViewFrameMember): string {
  const d = memberDot(m.status);
  const inner = d === "icon" ? `<span class="icon-user">${iconUser(14)}</span>` : dot(d);
  return `<span class="member-dot">${inner}</span>`;
}

/** 单个成员卡（§10.5）。0.4.0：无齿轮——成员模型没有面板配置通道。 */
export function renderMember(
  m: ViewFrameMember,
  opts: {
    lang: Lang;
    isCurrent: boolean;
    highlightCurrent?: boolean;
    disabled: boolean;
  },
): string {
  const { lang, isCurrent, disabled } = opts;
  const highlight = opts.highlightCurrent ?? isCurrent;
  const cls = ["member", highlight ? "current" : ""].filter(Boolean).join(" ");
  const nameRow =
    `<span class="row1">` +
    `<span class="name">${esc(m.target)}</span>` +
    (isCurrent ? `<span class="current-tag">${esc(t(lang, "current"))}</span>` : "") +
    `</span>`;
  const modelSuffix = m.model !== undefined ? `<span class="model"> · ${esc(t(lang, "model"))}: ${esc(m.model)}</span>` : "";
  const sub = `<span class="sub">${esc(t(lang, memberStatusKey(m.status)))}${modelSuffix}</span>`;
  const diag = m.diagnostics.length > 0 ? `<span class="diagnostic">${esc(m.diagnostics[0])}</span>` : "";
  // 可点行 → <button>（下钻 detail）；禁用行 → <button disabled>（§10.5 cursor default，不响应）
  const openAttr = disabled ? "" : ` title="${esc(t(lang, "open"))}"`;
  return (
    `<button class="${cls}" data-member-id="${esc(m.id)}"${disabled ? " disabled" : ""}${openAttr}>` +
    memberIndicator(m) +
    `<span class="member-text">${nameRow}${sub}${diag}</span>` +
    `</button>`
  );
}

/** 花名册区（§10.5）：h3（count 仅 members>1 显示）+ 双列网格。 */
export function renderRoster(frame: ViewFrame, lang: Lang): string {
  const members = frame.members;
  const currentId = currentMemberId(frame);
  const countHtml = members.length > 1 ? `<span class="count">${members.length}</span>` : "";
  const cards = members
    .map((m) =>
      renderMember(m, {
        lang,
        // Tag 恒随当前会话；高亮/描边才受 members>1 限制（上游 TeamAction 同口径）。
        isCurrent: m.id === currentId,
        highlightCurrent: m.id === currentId && members.length > 1,
        disabled: isMemberDisabled(m, currentId),
      }),
    )
    .join("");
  return `<section class="roster-section">` +
    `<h3>${esc(t(lang, "roster"))}${countHtml}</h3>` +
    `<div class="roster">${cards}</div>` +
    `</section>`;
}

/** 任务 meta 行（§10.6）：id、Owner、可开始/被依赖阻塞（仅 pending）、依赖、写入范围、警告。 */
export function renderTaskMeta(task: TeamTaskView, lang: Lang, leadingHtml = ""): string {
  const spans: string[] = [];
  spans.push(`<span>${esc(task.id)}</span>`);
  const owner = task.ownerName !== undefined ? esc(task.ownerName) : esc(t(lang, "unowned"));
  spans.push(`<span>${esc(t(lang, "owner"))}: ${owner}</span>`);
  if (task.status === "pending") {
    spans.push(`<span>${esc(t(lang, task.ready ? "ready" : "blocked"))}</span>`);
  }
  if (task.blockedBy.length > 0) {
    spans.push(`<span>${esc(t(lang, "blockedBy"))}: ${task.blockedBy.map(esc).join(", ")}</span>`);
  }
  if (task.writeScopes.length > 0) {
    spans.push(`<span>${esc(t(lang, "writeScopes"))}: ${task.writeScopes.map(esc).join(", ")}</span>`);
  }
  for (const w of task.writeScopeWarnings) {
    spans.push(`<span class="warning">${esc(w)}</span>`);
  }
  return `<div class="meta">${leadingHtml}${spans.join("")}</div>`;
}

/** 单个任务卡（§10.6）：标题行 + 状态徽标 + 描述（两行截断）+ 展开开关 + meta。 */
export function renderTask(task: TeamTaskView, lang: Lang): string {
  const state = `<span class="task-state">${dot(taskDot(task))}<span>${esc(t(lang, statusKey(task.status)))}</span></span>`;
  const titleRow = `<div class="title-row"><strong>${esc(task.subject)}</strong>${state}</div>`;
  // 展开开关默认 hidden（仅实测溢出时由绑定层显示；§10.6 ResizeObserver 语义）；
  // aria-expanded 初始 false；chevron 12px。
  const toggle =
    `<button class="expand-toggle" hidden aria-expanded="false" data-task-toggle>` +
    `<span class="expand-label">${esc(t(lang, "task.expand"))}</span>${iconChevron(12)}` +
    `</button>`;
  const desc = `<p data-task-desc>${esc(task.description)}</p>`;
  // 上游 DOM 顺序：title → p → meta，toggle 是 meta 的首个子元素（float:right）。
  return `<article class="task" data-task-id="${esc(task.id)}">` +
    titleRow +
    desc +
    renderTaskMeta(task, lang, toggle) +
    `</article>`;
}

/** 任务板区（§10.6）：空板 → 仅 emptyNotice（无 h3）；有任务 → h3（count 恒显示）+ 列表。 */
export function renderTasks(frame: ViewFrame, lang: Lang): string {
  if (frame.tasks.length === 0) {
    return `<section class="tasks-section"><p class="empty-notice">${esc(t(lang, "empty"))}</p></section>`;
  }
  const cards = frame.tasks.map((task) => renderTask(task, lang)).join("");
  return `<section class="tasks-section">` +
    `<h3>${esc(t(lang, "tasks"))}<span class="count">${frame.tasks.length}</span></h3>` +
    `<div class="tasks">${cards}</div>` +
    `</section>`;
}

/**
 * 通知条（§10.4，按序）：① 导航错误（alert）② 加载中/不可用（status）③ 投影 failure（alert）。
 * 导航错误/加载态由载体运行时提供（面板断线/加载）；本函数产出 failure 条 + 无 team 值的
 * 加载/不可用条。failure 显示在最后有效状态之上（roster/tasks 照常渲染）。
 */
export function renderNotices(opts: {
  lang: Lang;
  navError?: string;
  loading?: boolean;
  noTeam?: boolean;
  failure?: string;
}): string {
  const { lang } = opts;
  const out: string[] = [];
  if (opts.navError !== undefined) {
    out.push(`<div class="error-bar" role="alert">${dot("error")}<span>${esc(opts.navError)}</span></div>`);
  }
  if (opts.loading === true) {
    out.push(`<div class="notice" role="status">${dot("ongoing")}<span>${esc(t(lang, "loading"))}</span></div>`);
  } else if (opts.noTeam === true) {
    out.push(`<div class="notice" role="status">${dot("warning")}<span>${esc(t(lang, "unavailable"))}</span></div>`);
  }
  if (opts.failure !== undefined) {
    out.push(`<div class="error-bar" role="alert">${dot("error")}<span>${esc(t(lang, "failure", { message: opts.failure }))}</span></div>`);
  }
  return out.join("");
}

/** 面板 body 内容（通知条 + 花名册 + 任务板；§10.4–§10.6）。 */
export function renderPanelBody(
  frame: ViewFrame,
  lang: Lang,
  runtime?: { navError?: string; loading?: boolean },
): string {
  const noTeam = frame.team === null;
  const notices = renderNotices({
    lang,
    ...(runtime?.navError !== undefined ? { navError: runtime.navError } : {}),
    ...(runtime?.loading !== undefined ? { loading: runtime.loading } : {}),
    noTeam,
    ...(frame.team?.failure !== undefined ? { failure: frame.team.failure } : {}),
  });
  // 无 team 值且非加载态 → 仅通知条（unavailable），不渲染空花名册（§10.4）
  if (noTeam && runtime?.loading !== true) {
    return notices;
  }
  return notices + renderRoster(frame, lang) + renderTasks(frame, lang);
}
