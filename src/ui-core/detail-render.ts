// T5.7 成员会话查看视图渲染（纯函数；面板 src/panel/main.ts 与伴生面板页共用 = 单一实现）。
// V16 口径：无 DSH 参照 → 宿主风格；判据 = 几何不破版 + 风格一致（不做像素保真）。
// 只读边界（F13）：零发送/中断控件；「复制会话 id」恒有；「在桌面打开」引导按 H15b
// 结论（未证实前不呈现——当前不呈现）。

import { td, type Lang } from "./dict.js";
import { esc } from "./render.js";
import { iconArrowLeft, iconChevron } from "./icons.js";
import type { DetailItem, DetailResult } from "../panel/detail.js";

/** 二级视图状态（面板与伴生页同构）。 */
export type DetailViewState =
  | { kind: "closed" }
  | { kind: "loading"; memberId: string; name: string }
  | { kind: "ready"; memberId: string; name: string; detail: DetailResult }
  | { kind: "error"; memberId: string; name: string; message: string; reason?: string };

export function renderDetailItem(item: DetailItem, lang: Lang): string {
  const time = item.ts.slice(11, 19);
  const badge =
    item.framed !== undefined
      ? `<span class="msg-badge">${esc(td(lang, "detail.framedFrom", { name: item.framed.from }))}</span>`
      : "";
  if (item.kind === "toolCall") {
    const tool = item.tool ?? { name: "?", status: "?" };
    const hasPayload = item.text !== undefined && item.text.length > 0;
    const summary =
      `<span class="tool-summary">${hasPayload ? iconChevron(12) : ""}` +
      `<span class="tool-name">${esc(tool.name)}</span><span>${esc(tool.status)}</span></span>`;
    return (
      `<div class="msg assistant">` +
      `<div class="msg-head"><span class="msg-role">assistant</span><span class="msg-time">${time}</span></div>` +
      (hasPayload
        ? `<button class="tool-row" aria-expanded="false">${summary}</button><pre class="tool-detail">${esc(item.text!)}</pre>`
        : `<span class="tool-static">${summary}</span>`) +
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
  const count = `<span class="msg-time">${esc(td(lang, "detail.count", { n: d.total }))}</span>`;
  if (d.page.items.length === 0) {
    return `<div class="detail-state">${esc(td(lang, "detail.empty"))}</div>`;
  }
  const pager =
    d.page.nextCursor !== undefined
      ? `<div class="detail-pager"><button class="detail-action" data-detail-earlier data-cursor="${d.page.nextCursor}">${esc(td(lang, "detail.earlier"))}</button>${count}</div>`
      : `<div class="detail-pager">${count}</div>`;
  return pager + d.page.items.map((item) => renderDetailItem(item, lang)).join("");
}

export function renderDetailView(st: DetailViewState, lang: Lang, opts: { wake?: boolean } = {}): string {
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
