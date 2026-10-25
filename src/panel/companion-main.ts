// T5.5 伴生面板页（浏览器 iife → dist/ui/team-companion.html；高保真「原交互对照载体」）。
// 与 MCP Apps 面板同源组件层（COMPONENT_CSS + renderPanelBody + detail-render），差异 = 载体：
//  - 数据 = SSE 订阅（全量视图广播口径；contentKey 去抖同构，服务端实现）；
//  - 下钻 = POST（refresh/detail，面板回环同语义，只读）；
//  - **复刻 DSH TeamAction 全部触发器交互**（规格 §10.2/§10.3，F10 验收矩阵）：
//    hover 150ms 开 / 离开 trigger+panel 120ms 宽限关（进入面板取消关闭）/ 点击 pin+焦点入面板 /
//    Escape（焦点在面板内 → 还给触发器）/ 外点关闭 / 锚定定位 gap5·margin16 / 紧凑模式 /
//    a11y（role=dialog·tabIndex=-1·aria-*）。
// 网络面纪律（SSRF 零面）：只有两个**字符串常量相对端点**（"/events"、"/api/call"），
// 浏览器同源解析到加载本页的回环伴生服务（companion-server 仅绑定 127.0.0.1 + token
// 鉴权，见 companion-server.ts）；无任何外部/用户可控 URL 参与请求构造。
// 只读口径（F07）：无任何任务/成员变更控件（伴生页无模型通道，也不提供唤醒注入）。

import { COMPONENT_CSS } from "../ui-core/css.js";
import { DICT, type Lang, langOfLocale, td } from "../ui-core/dict.js";
import { iconUsers } from "../ui-core/icons.js";
import { isCompact, renderPanelBody } from "../ui-core/render.js";
import { renderDetailView, type DetailViewState } from "../ui-core/detail-render.js";
import { attachExpandBehavior, memoryExpandStore, type ExpandStore } from "../ui-core/expand.js";
import type { ViewFrame } from "../ui-core/view.js";
import type { DetailMode, DetailResult } from "./detail.js";
import { RequestSequencer } from "../ui-core/request-sequencer.js";

// ---------------------------------------------------------------- DSH 交互时序常量（§10.2，F10）
const HOVER_OPEN_MS = 150;
const LEAVE_CLOSE_MS = 120;
const ANCHOR_GAP = 5;
const ANCHOR_MARGIN = 16;

// 固定同源端点（字符串常量；token 仅作为凭证参数/请求头，不参与 URL 目标构造）
const EVENTS_ENDPOINT = "/events";
const API_ENDPOINT = "/api/call";

const token = new URLSearchParams(location.search).get("token") ?? "";
const lang: Lang = langOfLocale(navigator.language);
let frame: ViewFrame | null = null;
let detailState: DetailViewState = { kind: "closed" };
/** 〔视图修订 2026-10-25〕detail 视图模式（默认简洁；无持久化，面板重开回默认）。 */
let detailMode: DetailMode = "summary";
let expandStore: ExpandStore = memoryExpandStore();
let detachExpand: (() => void) | null = null;
let pinned = false;
let open = false;
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let leaveTimer: ReturnType<typeof setTimeout> | null = null;
/** 快速切成员/关闭详情时作废在途 detail 响应。 */
const detailSequencer = new RequestSequencer();

// ---------------------------------------------------------------- DOM 骨架（DSH TeamAction 结构等价）
const style = document.createElement("style");
style.textContent =
  COMPONENT_CSS +
  `
html, body { margin: 0; min-height: 100%; background: var(--at-bg-menu); font-family: var(--at-font); }
.at-root { padding: 12px; container-type: inline-size; }
.at-trigger {
  min-height: 28px; color: var(--at-label-tertiary); cursor: pointer; background: none; border: 0;
  border-radius: 6px; align-items: center; gap: 5px; padding: 3px 7px; font-size: 12px;
  display: inline-flex; font-family: inherit;
}
.at-trigger:hover, .at-trigger:focus-visible { color: var(--at-label-primary); }
.at-trigger .at-trigger-label { display: inline; }
@container (max-width: 480px) { .at-trigger .at-trigger-label { display: none; } }
.at-panel-wrap { position: fixed; visibility: hidden; left: 0; top: 0; z-index: 100; }
.at-panel-wrap.open { visibility: visible; }
.team-panel { position: relative; }
.at-conn { font-size: 11px; color: var(--at-label-tertiary); margin-left: 8px; }
`;
document.head.appendChild(style);

const root = document.createElement("div");
root.className = "at-root";
root.innerHTML =
  `<span style="display:inline-flex;align-items:center">` +
  `<button class="at-trigger" aria-haspopup="dialog" aria-expanded="false" aria-label="${DICT[lang].trigger}" data-trigger>` +
  `<span data-trigger-icon></span><span class="at-trigger-label">${DICT[lang].trigger}</span>` +
  `</button><span class="at-conn" data-conn>connecting…</span></span>` +
  `<div class="at-panel-wrap" data-wrap>` +
  `<div class="team-panel" role="dialog" tabindex="-1" data-team-panel aria-label="${DICT[lang].trigger}">` +
  `<div class="panel-body" data-list-view></div>` +
  `<div class="detail-view" data-detail-view tabindex="-1" hidden></div>` +
  `</div></div>`;
document.body.appendChild(root);

const trigger = root.querySelector<HTMLButtonElement>("[data-trigger]")!;
trigger.querySelector("[data-trigger-icon]")!.innerHTML = iconUsers(14);
const wrap = root.querySelector<HTMLElement>("[data-wrap]")!;
const panelEl = root.querySelector<HTMLElement>(".team-panel")!;
const listView = root.querySelector<HTMLElement>("[data-list-view]")!;
const detailView = root.querySelector<HTMLElement>("[data-detail-view]")!;
const conn = root.querySelector<HTMLElement>("[data-conn]")!;
document.documentElement.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

// ---------------------------------------------------------------- 渲染
function render(): void {
  const inDetail = detailState.kind !== "closed";
  listView.hidden = inDetail;
  detailView.hidden = !inDetail;
  panelEl.classList.toggle("compact", frame !== null && isCompact(frame) && !inDetail);
  if (inDetail) {
    detailView.innerHTML = renderDetailView(detailState, lang, { mode: detailMode });
    bindDetail();
    return;
  }
  if (detachExpand !== null) { detachExpand(); detachExpand = null; }
  if (frame === null) {
    listView.innerHTML = renderPanelBody(
      { type: "view", stateVersion: 4, team: null, members: [], tasks: [], meta: { generatedAt: "", revision: 0 } },
      lang,
      { loading: true },
    );
    return;
  }
  listView.innerHTML = renderPanelBody(frame, lang, { loading: false });
  detachExpand = attachExpandBehavior(listView, expandStore, {
    expand: DICT[lang]["task.expand"],
    collapse: DICT[lang]["task.collapse"],
  });
}

// ---------------------------------------------------------------- 锚定定位（gap5 / margin16，§10.3）
function positionPanel(): void {
  const tr = trigger.getBoundingClientRect();
  const pw = panelEl.offsetWidth;
  const ph = panelEl.offsetHeight;
  let left = tr.left;
  let top = tr.bottom + ANCHOR_GAP;
  const maxLeft = window.innerWidth - pw - ANCHOR_MARGIN;
  if (left > maxLeft) left = Math.max(ANCHOR_MARGIN, maxLeft);
  if (top + ph > window.innerHeight - ANCHOR_MARGIN) {
    const above = tr.top - ANCHOR_GAP - ph;
    if (above >= ANCHOR_MARGIN) top = above; // 下方放不下且上方够 → 翻到上方
  }
  wrap.style.left = `${Math.round(left)}px`;
  wrap.style.top = `${Math.round(top)}px`;
}

function openPanel(focus: boolean): void {
  if (open) return;
  open = true;
  wrap.classList.add("open");
  trigger.setAttribute("aria-expanded", "true");
  positionPanel();
  if (focus) panelEl.focus();
}

function closePanel(returnFocus: boolean): void {
  if (!open) return;
  open = false;
  pinned = false;
  wrap.classList.remove("open");
  trigger.setAttribute("aria-expanded", "false");
  if (returnFocus) trigger.focus();
}

// ---------------------------------------------------------------- 触发器交互（DSH 全交互复刻，F10）
const triggerLabel = root.querySelector<HTMLElement>(".at-trigger-label");
trigger.addEventListener("mouseenter", () => {
  if (pinned) return;
  // 窄容器下 label 隐藏时只允许点击打开（DSH 同语义），hover 不排定时器。
  if (triggerLabel !== null && getComputedStyle(triggerLabel).display === "none") return;
  clearTimers();
  hoverTimer = setTimeout(() => openPanel(false), HOVER_OPEN_MS);
});
trigger.addEventListener("mouseleave", () => {
  if (pinned) return;
  clearTimers();
  leaveTimer = setTimeout(() => closePanel(false), LEAVE_CLOSE_MS);
});
panelEl.addEventListener("mouseenter", () => {
  if (leaveTimer !== null) { clearTimeout(leaveTimer); leaveTimer = null; }
});
panelEl.addEventListener("mouseleave", () => {
  if (pinned || !open) return;
  clearTimers();
  leaveTimer = setTimeout(() => closePanel(false), LEAVE_CLOSE_MS);
});
trigger.addEventListener("click", () => {
  clearTimers();
  pinned = true;
  if (open) panelEl.focus();
  else openPanel(true);
});
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  const inPanel = panelEl.contains(document.activeElement) || document.activeElement === panelEl;
  if (open) {
    // Escape 只要打开就关闭；仅焦点在面板内时把焦点还给触发器（DSH 同语义）。
    ev.preventDefault();
    closePanel(inPanel);
  }
});
document.addEventListener("pointerdown", (ev) => {
  // 外点关闭同时解除 pin（DSH useDismissOnOutsidePointer 无 pinned 条件）。
  if (!open) return;
  const t = ev.target as Node;
  if (trigger.contains(t) || panelEl.contains(t)) return;
  closePanel(false);
});
window.addEventListener("resize", () => { if (open) positionPanel(); });
window.addEventListener("scroll", () => { if (open) positionPanel(); }, true);

function clearTimers(): void {
  if (hoverTimer !== null) { clearTimeout(hoverTimer); hoverTimer = null; }
  if (leaveTimer !== null) { clearTimeout(leaveTimer); leaveTimer = null; }
}

// ---------------------------------------------------------------- 数据：SSE 订阅 + 下钻（同源固定端点）
function connect(): void {
  const es = new EventSource(`${EVENTS_ENDPOINT}?token=${encodeURIComponent(token)}`);
  es.addEventListener("hello", () => { conn.textContent = "live"; });
  es.addEventListener("view", (ev) => {
    try {
      frame = JSON.parse((ev as MessageEvent<string>).data) as ViewFrame;
      conn.textContent = "live";
      render();
    } catch { /* 帧解析失败忽略（保留上一帧） */ }
  });
  es.onerror = () => { conn.textContent = "reconnecting…"; };
}

async function apiCall(args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(API_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", "x-team-token": token },
    body: JSON.stringify(args),
  });
  return res.json() as Promise<unknown>;
}

// ---------------------------------------------------------------- detail（T5.7 二级视图；只读）
listView.addEventListener("click", (ev) => {
  const target = ev.target as HTMLElement | null;
  if (target?.closest("[data-task-toggle]") !== null && target !== undefined) return;
  const member = target?.closest<HTMLButtonElement>("button.member");
  if (member === null || member === undefined || member.disabled) return;
  const id = member.dataset.memberId;
  if (id === undefined) return;
  void openDetail(id, member.querySelector(".name")?.textContent ?? id);
});

async function openDetail(
  memberId: string,
  name: string,
  cursor?: number,
  mode: DetailMode = detailMode,
): Promise<void> {
  const seq = detailSequencer.begin();
  const fromList = detailState.kind === "closed";
  detailState = { kind: "loading", memberId, name };
  render();
  if (fromList) detailView.focus();
  try {
    const body = (await apiCall({
      action: "detail",
      target: memberId,
      mode,
      ...(cursor !== undefined ? { cursor } : {}),
    })) as { kind: string; detail?: DetailResult; message?: string; reason?: string };
    if (!detailSequencer.isCurrent(seq)) return;
    if (body.kind === "detail" && body.detail !== undefined) {
      detailMode = body.detail.mode;
      detailState = { kind: "ready", memberId, name, detail: body.detail };
    } else {
      detailState = {
        kind: "error",
        memberId,
        name,
        message: body.message ?? "detail failed",
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      };
    }
  } catch (err) {
    if (!detailSequencer.isCurrent(seq)) return;
    detailState = { kind: "error", memberId, name, message: err instanceof Error ? err.message : String(err) };
  }
  render();
}

function closeDetail(): void {
  detailSequencer.invalidate();
  detailState = { kind: "closed" };
  render();
}

function bindDetail(): void {
  detailView.querySelector("[data-detail-back]")?.addEventListener("click", closeDetail);
  const reload = (): void => {
    if (detailState.kind === "ready" || detailState.kind === "error") {
      void openDetail(detailState.memberId, detailState.name);
    }
  };
  detailView.querySelector("[data-detail-refresh]")?.addEventListener("click", reload);
  detailView.querySelector("[data-detail-retry]")?.addEventListener("click", reload);
  detailView.querySelector("[data-detail-copy]")?.addEventListener("click", () => {
    if (detailState.kind !== "ready") return;
    void navigator.clipboard?.writeText(detailState.detail.sessionId).catch(() => undefined);
    const btn = detailView.querySelector<HTMLButtonElement>("[data-detail-copy]");
    if (btn !== null) {
      btn.textContent = td(lang, "detail.copied");
      setTimeout(() => { if (btn.isConnected) btn.textContent = td(lang, "detail.copySessionId"); }, 1500);
    }
  });
  // 〔视图修订 2026-10-25〕简洁/详细切换（同面板；本载体无 wake、无持久化）
  for (const btn of detailView.querySelectorAll<HTMLButtonElement>("[data-detail-mode]")) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.detailMode;
      if (next !== "summary" && next !== "full") return;
      if (next === detailMode) return;
      if (detailState.kind !== "ready" && detailState.kind !== "error") return;
      const { memberId, name } = detailState;
      detailMode = next;
      detailSequencer.begin(); // 跨模式 seq 不通用 → 回末页重拉
      detailState = { kind: "loading", memberId, name };
      void openDetail(memberId, name, undefined, next);
    });
  }
  detailView.querySelector("[data-detail-earlier]")?.addEventListener("click", (ev) => {
    const cursor = Number((ev.currentTarget as HTMLElement).dataset.cursor);
    if (detailState.kind === "ready" && Number.isFinite(cursor)) {
      void openDetail(detailState.memberId, detailState.name, cursor);
    }
  });
  for (const head of detailView.querySelectorAll<HTMLButtonElement>("button.tool-group-head")) {
    head.addEventListener("click", () => {
      const group = head.closest(".tool-group");
      const open = group?.classList.toggle("open") ?? false;
      head.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }
  for (const row of detailView.querySelectorAll<HTMLButtonElement>("button.tool-row")) {
    row.addEventListener("click", () => {
      const o = row.classList.toggle("open");
      row.setAttribute("aria-expanded", o ? "true" : "false");
    });
  }
}

// ---------------------------------------------------------------- 启动
render();
connect();
