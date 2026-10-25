// T5.7 成员会话查看视图渲染（纯函数；面板 src/panel/main.ts 与伴生面板页共用 = 单一实现）。
// V16 口径：无 DSH 参照 → 宿主风格；判据 = 几何不破版 + 风格一致（不做像素保真）。
// 只读边界（F13）：零发送/中断控件；「复制会话 id」恒有；「在桌面打开」引导按 H15b
// 结论（未证实前不呈现——当前不呈现）。
// 〔视图修订 2026-10-25·二次〕视图仅保留简洁形态（按轮摘要：用户指令 + toolGroup +
// 每轮结论），无模式切换；计数恒显示「n 条 · 共 sourceTotal 条转录」。toolGroup 条目
// 渲染为一行动作汇总（前端按 tools 数组现算名称聚合），点击就地展开逐条工具行（复用
// tool-row/tool-detail 结构 → 既有折叠绑定自动覆盖）。

import { td, type Lang } from "./dict.js";
import { esc } from "./render.js";
import { iconArrowLeft, iconChevron } from "./icons.js";
import type { DetailItem, DetailResult, DetailToolEntry } from "../panel/detail.js";

/** 二级视图状态（面板与伴生页同构）。 */
export type DetailViewState =
  | { kind: "closed" }
  | { kind: "loading"; memberId: string; name: string }
  | { kind: "ready"; memberId: string; name: string; detail: DetailResult }
  | { kind: "error"; memberId: string; name: string; message: string; reason?: string };

/** toolGroup 名称聚合串（`Bash×7 · Read×4`）：计数降序、同数按名称升序。 */
export function aggregateToolNames(tools: ReadonlyArray<Pick<DetailToolEntry, "name">>): string {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, n]) => `${name}×${n}`)
    .join(" · ");
}

/** 单条工具行（toolCall 与 toolGroup 成员共用）：有载荷=可折叠按钮，无载荷=静态行。 */
function renderToolEntry(tool: DetailToolEntry): string {
  const hasPayload = tool.text !== undefined && tool.text.length > 0;
  const summary =
    `<span class="tool-summary">${hasPayload ? iconChevron(12) : ""}` +
    `<span class="tool-name">${esc(tool.name)}</span><span>${esc(tool.status)}</span></span>`;
  return hasPayload
    ? `<button class="tool-row" aria-expanded="false">${summary}</button><pre class="tool-detail">${esc(tool.text!)}</pre>`
    : `<span class="tool-static">${summary}</span>`;
}

export function renderDetailItem(item: DetailItem, lang: Lang): string {
  const time = item.ts.slice(11, 19);
  const badge =
    item.framed !== undefined
      ? `<span class="msg-badge">${esc(td(lang, "detail.framedFrom", { name: item.framed.from }))}</span>`
      : "";
  if (item.kind === "toolCall") {
    const tool = item.tool ?? { name: "?", status: "?" };
    const entry: DetailToolEntry = {
      ts: item.ts,
      name: tool.name,
      status: tool.status,
      ...(item.text !== undefined ? { text: item.text } : {}),
    };
    return (
      `<div class="msg assistant">` +
      `<div class="msg-head"><span class="msg-role">assistant</span><span class="msg-time">${time}</span></div>` +
      renderToolEntry(entry) +
      `</div>`
    );
  }
  if (item.kind === "toolGroup") {
    const tools = item.tools ?? [];
    const count = item.count ?? tools.length;
    const label = td(lang, "detail.toolGroup", { n: count, list: aggregateToolNames(tools) });
    return (
      `<div class="msg assistant tool-group">` +
      `<div class="msg-head"><span class="msg-role">assistant</span><span class="msg-time">${time}</span></div>` +
      `<button class="tool-group-head" aria-expanded="false">${iconChevron(12)}` +
      `<span class="tool-group-label">${esc(label)}</span></button>` +
      `<div class="tool-group-items">${tools.map((tool) => renderToolEntry(tool)).join("")}</div>` +
      `</div>`
    );
  }
  const roleLabel = item.role === "user" ? esc(td(lang, "detail.you")) : item.role;
  return (
    `<div class="msg ${item.role}">` +
    `<div class="msg-head"><span class="msg-role">${roleLabel}</span><span class="msg-time">${time}</span>${badge}</div>` +
    `<div class="msg-text">${esc(item.text ?? "")}</div>` +
    `</div>`
  );
}

export function renderDetailBody(st: Exclude<DetailViewState, { kind: "closed" }>, lang: Lang): string {
  if (st.kind === "loading") {
    return `<div class="detail-state"><span class="dot ongoing"></span>${esc(td(lang, "detail.loading"))}</div>`;
  }
  if (st.kind === "error") {
    const text =
      st.reason === "session-not-settled"
        ? td(lang, "detail.noSession")
        : td(lang, "detail.failed", { message: st.message });
    return (
      `<div class="detail-state error"><span class="dot error"></span><span>${esc(text)}</span></div>` +
      `<div class="detail-pager"><button class="detail-action" data-detail-retry>${esc(td(lang, "detail.refresh"))}</button></div>`
    );
  }
  const d = st.detail;
  const count = `<span class="msg-time">${esc(td(lang, "detail.countSummary", { n: d.total, sourceTotal: d.sourceTotal }))}</span>`;
  if (d.page.items.length === 0) {
    return `<div class="detail-state">${esc(td(lang, "detail.empty"))}</div>`;
  }
  const pager =
    d.page.nextCursor !== undefined
      ? `<div class="detail-pager"><button class="detail-action" data-detail-earlier data-cursor="${d.page.nextCursor}">${esc(td(lang, "detail.earlier"))}</button>${count}</div>`
      : `<div class="detail-pager">${count}</div>`;
  return pager + d.page.items.map((item) => renderDetailItem(item, lang)).join("");
}

export function renderDetailView(
  st: DetailViewState,
  lang: Lang,
  opts: { wake?: boolean } = {},
): string {
  if (st.kind === "closed") return "";
  const actions: string[] = [];
  if (st.kind === "ready") {
    actions.push(`<button class="detail-action" data-detail-refresh>${esc(td(lang, "detail.refresh"))}</button>`);
    actions.push(
      `<button class="detail-action" data-detail-copy title="${esc(st.detail.sessionId)}">${esc(td(lang, "detail.copySessionId"))}</button>`,
    );
    if (opts.wake === true) {
      // 唤醒下钻仅面板载体（updateModelContext 是 MCP Apps 能力；伴生页无模型通道）
      actions.push(`<button class="detail-action" data-detail-wake>${esc(td(lang, "detail.wake"))}</button>`);
    }
  }
  return (
    `<div class="detail-head">` +
    `<button class="detail-back" data-detail-back>${iconArrowLeft(14)}${esc(td(lang, "detail.back"))}</button>` +
    `<span class="detail-title">${esc(st.name)}</span>` +
    `<span class="detail-actions">${actions.join("")}</span>` +
    `</div>` +
    `<div class="detail-list" data-detail-list>${renderDetailBody(st, lang)}</div>`
  );
}
