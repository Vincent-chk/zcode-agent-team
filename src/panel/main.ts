// agent-team 会话面板（MCP Apps 主载体；stage-5 T5.2 生产实现 + T5.7 成员会话查看视图）。
// 数据：resources/subscribe 订阅 team://view（推帧 → readServerResource 全量重读；对齐
// DSH「全量视图广播」口径）；断线/异常 → callServerTool refresh 拉全量基线恢复。
// 保活：H12 定案 = 每 25s 心跳 callServerTool（生产常开，不破坏只读语义）。
// 回环：刷新/详情动作全部经 app.callServerTool("team_panel_call")（面板唯一 server 通道，
// F14①）；「唤醒成员」下钻经 updateModelContext 注入下一轮（F14②）——面板零直接变更
// 能力（F07 只读口径，§10.6）。
// 文案：§10.7 词典逐字（zh/en 随宿主 locale）；几何/颜色：§10.3–§10.6（ui-core 同源层）。
// T5.7：成员行点击 → 面板内二级视图（detail 契约分页/三态/复制会话 id；H15b 未证实 →
// 不呈现「在桌面打开」引导）。
// stage-8 D：成员卡齿轮 → 模型设置弹窗（模型目录 + 当前来源 + 受控变更 + 高级模式引导；
// 弹窗 DOM 挂在 .team-panel 下、list/detail 之外——列表每帧重渲染不摧毁弹窗）。
import { App } from "@modelcontextprotocol/ext-apps";
import {
  EmptyResultSchema,
  ResourceUpdatedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { COMPONENT_CSS, PANEL_CSS } from "../ui-core/css.js";
import { DICT, type Lang, langOfLocale, td } from "../ui-core/dict.js";
import { isCompact, renderPanelBody } from "../ui-core/render.js";
import {
  renderDetailView as renderDetailViewHtml,
  type DetailViewState,
} from "../ui-core/detail-render.js";
import {
  draftFromCurrent,
  draftSelection,
  renderMemberSettingsModal,
  selectLevel,
  selectModel,
  selectProvider,
  type MemberModelCurrent,
  type MemberSettingsState,
} from "../ui-core/member-settings.js";
import type { ViewFrame } from "../ui-core/view.js";
import type { ModelCatalog } from "../provider/model-catalog.js";
import type { DetailMode, DetailResult } from "../panel/detail.js";
import { attachExpandBehavior, memoryExpandStore, type ExpandStore } from "../ui-core/expand.js";
import { RequestSequencer } from "../ui-core/request-sequencer.js";

const VIEW_URI = "team://view";
/** H12 定案：心跳保活为主方案（25s < 30s 回收窗）。 */
const HEARTBEAT_MS = 25_000;

const app = new App({ name: "agent-team-panel", version: "0.5.0" }, {});

// ---------------------------------------------------------------- 状态

let frame: ViewFrame | null = null;
let lang: Lang = "zh";
let navError: string | undefined;
type DetailState = DetailViewState;
let detailState: DetailState = { kind: "closed" };
/** 〔视图修订 2026-10-25〕detail 视图模式（默认简洁；切模式 = 回末页 + 重拉）。 */
let detailMode: DetailMode = "summary";
/** stage-8 D：成员模型设置弹窗状态（closed 时 DOM 空且 hidden）。 */
let settingsState: MemberSettingsState = { kind: "closed" };
let expandStore: ExpandStore = memoryExpandStore();
let detachExpand: (() => void) | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatInFlight = false;
/** 视图帧请求序号：通知/刷新/首读并发时只落地最后一次。 */
const viewSequencer = new RequestSequencer();
/** 详情请求序号：快速切成员/关闭视图时作废在途响应。 */
const detailSequencer = new RequestSequencer();
/** 设置弹窗请求序号：快速开关/连点刷新时只落地最后一次。 */
const settingsSequencer = new RequestSequencer();

// ---------------------------------------------------------------- DOM 骨架

const style = document.createElement("style");
style.textContent = COMPONENT_CSS + PANEL_CSS;
document.head.appendChild(style);

const root = document.createElement("div");
root.className = "at-root";
root.innerHTML =
  `<div class="team-panel" role="dialog" tabindex="-1" data-team-panel>` +
  `<div class="panel-body" data-list-view></div>` +
  `<div class="detail-view" data-detail-view tabindex="-1" hidden></div>` +
  `<div data-settings-layer hidden></div>` +
  `</div>`;
document.body.appendChild(root);

const panelEl = root.querySelector<HTMLElement>(".team-panel")!;
const listView = root.querySelector<HTMLElement>("[data-list-view]")!;
const detailView = root.querySelector<HTMLElement>("[data-detail-view]")!;
const settingsLayer = root.querySelector<HTMLElement>("[data-settings-layer]")!;

// ---------------------------------------------------------------- 主题/语言/宿主上下文

function applyHostContext(): void {
  const ctx = app.getHostContext();
  const theme = ctx?.theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  // 宿主样式变量（MCP Apps 标准 --color-* → tokens 首选层；随主题切换重注入）
  const vars = ctx?.styles?.variables;
  if (vars !== undefined) {
    for (const [k, v] of Object.entries(vars)) {
      if (typeof v === "string") document.documentElement.style.setProperty(k, v);
    }
  }
  lang = langOfLocale(ctx?.locale);
  panelEl.setAttribute("aria-label", DICT[lang].trigger);
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
}

// widgetState（会话内跨 remount 保活；仅 UI 呈现态 = 展开集合，≤16KiB）
function restoreWidgetState(): void {
  const ws = app.getHostContext()?.["zcode/widgetState"] as { expanded?: string[] } | undefined;
  if (ws !== undefined && Array.isArray(ws.expanded)) {
    expandStore = memoryExpandStore(new Set(ws.expanded));
  }
}

let saveWidgetQueued = false;
function persistWidgetState(): void {
  if (saveWidgetQueued) return;
  saveWidgetQueued = true;
  setTimeout(() => {
    saveWidgetQueued = false;
    const expanded = [...expandedIds()];
    // ui/set-widget-state 不在 AppRequest 联合类型内（同 resources/subscribe），运行时经
    // Protocol.request 发送；宿主无该能力 → reject 静默降级（呈现态非权威，可接受）
    void (app as unknown as { request(m: unknown, s: unknown): Promise<unknown> })
      .request({ method: "ui/set-widget-state", params: { widgetState: { expanded } } }, EmptyResultSchema)
      .catch(() => undefined);
  }, 200);
}

function expandedIds(): Set<string> {
  const ids = new Set<string>();
  for (const el of root.querySelectorAll<HTMLElement>("article.task")) {
    const toggle = el.querySelector<HTMLButtonElement>("[data-task-toggle]");
    if (toggle !== null && toggle.getAttribute("aria-expanded") === "true") {
      ids.add(el.dataset.taskId ?? "");
    }
  }
  return ids;
}

// ---------------------------------------------------------------- 数据通道

function parseToolText(res: { content?: Array<{ type?: string; text?: string }> }): string {
  const first = res.content?.[0];
  if (first === undefined || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("empty tool result");
  }
  return first.text;
}

async function readView(): Promise<void> {
  const seq = viewSequencer.begin();
  const res = await app.readServerResource({ uri: VIEW_URI });
  const first = res.contents?.[0];
  const text = first !== undefined && "text" in first ? first.text : undefined;
  if (text === undefined) throw new Error("empty view resource");
  const next = JSON.parse(text) as ViewFrame;
  if (!viewSequencer.isCurrent(seq)) return; // 已有更新的视图请求 → 丢弃本次
  frame = next;
  navError = undefined;
  render();
}

/** 回环刷新（断线重连基线/兜底；F14①：daemon 被回收时宿主重 spawn + 重建 ≤5s）。 */
async function refreshViaCall(): Promise<void> {
  const seq = viewSequencer.begin();
  const res = await app.callServerTool({ name: "team_panel_call", arguments: { action: "refresh" } });
  const body = JSON.parse(parseToolText(res)) as {
    frame?: ViewFrame;
    error?: { message?: string };
  };
  if (body.frame === undefined) throw new Error(body.error?.message ?? "refresh failed");
  if (!viewSequencer.isCurrent(seq)) return; // 已有更新的视图请求 → 丢弃本次
  frame = body.frame;
  navError = undefined;
  render();
}

async function subscribe(): Promise<void> {
  // resources/subscribe 不在 AppRequest 联合类型内（泛型收窄），运行时经 Protocol.request 发送
  await (app as unknown as { request(m: unknown, s: unknown): Promise<unknown> }).request(
    { method: "resources/subscribe", params: { uri: VIEW_URI } },
    EmptyResultSchema,
  );
  await readView();
}

// resources/updated 通知不在 App 的 on* 映射内，经 Protocol.setNotificationHandler 注册
(app as unknown as {
  setNotificationHandler(
    schema: unknown,
    handler: (n: { params: { uri: string } }) => Promise<void>,
  ): void;
}).setNotificationHandler(ResourceUpdatedNotificationSchema, async (n) => {
  if (n.params.uri !== VIEW_URI) return;
  try {
    await readView();
  } catch {
    // 推帧读取失败（daemon 回收竞态）→ 回环兜底重拉；仍失败置导航错误条（可读原因，不静默）
    try {
      await refreshViaCall();
    } catch (err) {
      navError = err instanceof Error ? err.message : String(err);
      render();
    }
  }
});

// 心跳（H12 定案主方案）：25s 一次 callServerTool——保活 daemon（兼负 D11 Lead 连接保活）；
// 失败即自愈：重订阅（触发宿主重 spawn + 订阅重建），面板期间维持最后帧。
function startHeartbeat(): void {
  if (heartbeatTimer !== null) return;
  heartbeatTimer = setInterval(() => {
    if (heartbeatInFlight) return; // 上一拍未返回（宿主慢/回收中）→ 不叠加请求
    heartbeatInFlight = true;
    void (async () => {
      try {
        await app.callServerTool({ name: "team_panel_call", arguments: { label: "heartbeat" } });
      } catch {
        try {
          await subscribe();
        } catch {
          try {
            await refreshViaCall();
          } catch (err) {
            navError = err instanceof Error ? err.message : String(err);
            render();
          }
        }
      } finally {
        heartbeatInFlight = false;
      }
    })();
  }, HEARTBEAT_MS);
}

// ---------------------------------------------------------------- detail（T5.7）

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
  // 从列表进入详情时把焦点交给详情容器（列表行已被重渲染移除）：Escape/键盘回返仍可用。
  if (fromList) detailView.focus();
  try {
    const res = await app.callServerTool({
      name: "team_panel_call",
      arguments: {
        action: "detail",
        target: memberId,
        mode,
        ...(cursor !== undefined ? { cursor } : {}),
      },
    });
    if (!detailSequencer.isCurrent(seq)) return; // 快速切成员：旧响应不得覆盖新详情
    const body = JSON.parse(parseToolText(res)) as {
      detail?: DetailResult;
      error?: { code?: string; message?: string; reason?: string };
    };
    if (body.detail !== undefined) {
      detailMode = body.detail.mode;
      detailState = { kind: "ready", memberId, name, detail: body.detail };
    } else {
      detailState = {
        kind: "error",
        memberId,
        name,
        message: body.error?.message ?? "detail failed",
        ...(body.error?.reason !== undefined ? { reason: body.error.reason } : {}),
      };
    }
  } catch (err) {
    if (!detailSequencer.isCurrent(seq)) return;
    detailState = { kind: "error", memberId, name, message: err instanceof Error ? err.message : String(err) };
  }
  render();
}

function closeDetail(): void {
  detailSequencer.invalidate(); // 关闭后到达的响应不得重开详情
  detailState = { kind: "closed" };
  render();
}

/** 唤醒成员下钻（F14②）：updateModelContext 注入下一轮意图（面板零直接变更）。 */
function injectWake(name: string): void {
  void app
    .updateModelContext({
      content: [
        {
          type: "text",
          text: `[agent-team 面板注入] 用户在「智能体团队」面板请求关注成员 "${name}"：请查看该成员当前状态，必要时经 send_message 唤醒或推进其任务。`,
        },
      ],
    })
    .then(
      () => {
        const btn = detailView.querySelector<HTMLButtonElement>("[data-detail-wake]");
        if (btn !== null) btn.textContent = td(lang, "detail.wakeInjected", { name });
      },
      () => undefined, // 注入失败不打断视图（下钻是提示性动作）
    );
}

// ---------------------------------------------------------------- 成员设置弹窗（stage-8 D）

/** team_panel_call 统一应答解析（ok:false → 可读错误；错误态由调用方呈现）。 */
async function callPanelBody(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await app.callServerTool({ name: "team_panel_call", arguments: args });
  const body = JSON.parse(parseToolText(res)) as {
    ok?: boolean;
    error?: { message?: string };
  } & Record<string, unknown>;
  if (body.ok === false || body.error !== undefined) {
    throw new Error(body.error?.message ?? "panel call failed");
  }
  return body;
}

function memberNameOf(memberId: string): string {
  return frame?.members.find((m) => m.id === memberId)?.target ?? memberId;
}

/** 打开/刷新弹窗：拉目录 + 当前生效值（memberId 缺省时只拿目录）。 */
async function openSettings(memberId: string): Promise<void> {
  const seq = settingsSequencer.begin();
  const name = memberNameOf(memberId);
  settingsState = { kind: "loading", memberId, name };
  renderSettings();
  try {
    const body = await callPanelBody({ action: "modelOptions", memberId });
    if (!settingsSequencer.isCurrent(seq)) return;
    const catalog = body.catalog as ModelCatalog;
    const current = body.current as MemberModelCurrent | undefined;
    settingsState = {
      kind: "ready",
      memberId,
      name: typeof body.memberName === "string" ? body.memberName : name,
      catalog,
      ...(current !== undefined ? { current } : {}),
      draft: draftFromCurrent(catalog, current),
    };
  } catch (err) {
    if (!settingsSequencer.isCurrent(seq)) return;
    settingsState = {
      kind: "error",
      memberId,
      name,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  renderSettings();
}

function closeSettings(): void {
  settingsSequencer.invalidate(); // 关闭后到达的响应不得重开弹窗
  settingsState = { kind: "closed" };
  renderSettings();
}

/** 应用草稿：setMemberModel → 重新拉目录/当前值（applied=next-turn 时提示下一轮生效）。 */
async function applySettings(): Promise<void> {
  if (settingsState.kind !== "ready") return;
  const selection = draftSelection(settingsState.draft);
  if (selection === undefined) return;
  const { memberId, name, catalog, current, draft } = settingsState;
  const seq = settingsSequencer.begin();
  settingsState = {
    kind: "saving",
    memberId,
    name,
    catalog,
    ...(current !== undefined ? { current } : {}),
    draft,
  };
  renderSettings();
  let applied: "now" | "next-turn" = "now";
  try {
    const body = await callPanelBody({
      action: "setMemberModel",
      memberId,
      model: selection.model,
      ...(selection.thoughtLevel !== undefined ? { thoughtLevel: selection.thoughtLevel } : {}),
    });
    if (!settingsSequencer.isCurrent(seq)) return;
    applied = body.applied === "next-turn" ? "next-turn" : "now";
    const refreshed = await callPanelBody({ action: "modelOptions", memberId });
    if (!settingsSequencer.isCurrent(seq)) return;
    const nextCatalog = refreshed.catalog as ModelCatalog;
    const nextCurrent = refreshed.current as MemberModelCurrent | undefined;
    settingsState = {
      kind: "ready",
      memberId,
      name: typeof refreshed.memberName === "string" ? refreshed.memberName : name,
      catalog: nextCatalog,
      ...(nextCurrent !== undefined ? { current: nextCurrent } : {}),
      draft: draftFromCurrent(nextCatalog, nextCurrent),
      notice: applied === "next-turn" ? "next-turn" : "now",
    };
  } catch (err) {
    if (!settingsSequencer.isCurrent(seq)) return;
    settingsState = {
      kind: "error",
      memberId,
      name,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  renderSettings();
}

/** 弹窗渲染（独立于列表帧：frame 重渲染不触碰本层）。 */
function renderSettings(): void {
  settingsLayer.hidden = settingsState.kind === "closed";
  if (settingsState.kind === "closed") {
    settingsLayer.innerHTML = "";
    return;
  }
  settingsLayer.innerHTML = renderMemberSettingsModal(settingsState, lang);
  bindSettings();
}

function bindSettings(): void {
  const overlay = settingsLayer.querySelector<HTMLElement>("[data-settings-overlay]");
  // 遮罩点击（仅点在遮罩本身；点弹窗内部不关闭）
  overlay?.addEventListener("click", (ev) => {
    if (ev.target === overlay) closeSettings();
  });
  settingsLayer.querySelector("[data-settings-close]")?.addEventListener("click", closeSettings);
  settingsLayer.querySelector("[data-settings-cancel]")?.addEventListener("click", closeSettings);
  settingsLayer.querySelector("[data-settings-refresh]")?.addEventListener("click", () => {
    if (settingsState.kind !== "closed") void openSettings(settingsState.memberId);
  });
  settingsLayer.querySelector("[data-settings-apply]")?.addEventListener("click", () => {
    void applySettings();
  });
  const bound = settingsState;
  if (bound.kind !== "ready") return; // loading/error/saving：仅关闭/刷新可用
  const catalog = bound.catalog;
  const draft = bound.draft;
  const providerSelect = settingsLayer.querySelector<HTMLSelectElement>("[data-settings-provider]");
  providerSelect?.addEventListener("change", () => {
    if (settingsState.kind !== "ready") return;
    settingsState = { ...settingsState, draft: selectProvider(catalog, draft, providerSelect.value) };
    renderSettings();
  });
  const modelSelect = settingsLayer.querySelector<HTMLSelectElement>("[data-settings-model]");
  modelSelect?.addEventListener("change", () => {
    if (settingsState.kind !== "ready") return;
    settingsState = { ...settingsState, draft: selectModel(catalog, draft, modelSelect.value) };
    renderSettings();
  });
  const levelSelect = settingsLayer.querySelector<HTMLSelectElement>("[data-settings-level]");
  levelSelect?.addEventListener("change", () => {
    if (settingsState.kind !== "ready") return;
    settingsState = { ...settingsState, draft: selectLevel(draft, levelSelect.value) };
    renderSettings();
  });
}

// ESC 关闭弹窗（面板内唯一模态层；detail 返回仍走按钮/键盘焦点路径）
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && settingsState.kind !== "closed") {
    ev.preventDefault();
    closeSettings();
  }
});

// ---------------------------------------------------------------- 渲染

function render(): void {
  const inDetail = detailState.kind !== "closed";
  listView.hidden = inDetail;
  detailView.hidden = !inDetail;
  panelEl.classList.toggle("compact", frame !== null && isCompact(frame) && !inDetail);

  if (inDetail) {
    detailView.innerHTML = renderDetailViewHtml(detailState, lang, { wake: true, mode: detailMode });
    bindDetail();
    return;
  }
  if (detachExpand !== null) {
    detachExpand();
    detachExpand = null;
  }
  if (frame === null) {
    // 尚未拿到首帧：加载条（§10.4 第二型；无 team 值 + loading）
    listView.innerHTML = renderPanelBody(
      { type: "view", stateVersion: 4, team: null, members: [], tasks: [], meta: { generatedAt: "", revision: 0 } },
      lang,
      { loading: true, ...(navError !== undefined ? { navError } : {}) },
    );
    return;
  }
  listView.innerHTML = renderPanelBody(
    frame,
    lang,
    {
      ...(navError !== undefined ? { navError } : {}),
      loading: false,
    },
    // stage-8 D：齿轮仅在 MCP Apps 面板路径开启（伴生页/静态卡片默认关）
    { memberSettings: true },
  );
  detachExpand = attachExpandBehavior(listView, expandStore, {
    expand: DICT[lang]["task.expand"],
    collapse: DICT[lang]["task.collapse"],
  });
}

// ---------------------------------------------------------------- 交互绑定（只读口径）

listView.addEventListener("click", (ev) => {
  const target = ev.target as HTMLElement | null;
  if (target?.closest("[data-task-toggle]") !== null && target !== undefined) {
    persistWidgetState();
    return;
  }
  // stage-8 D：齿轮判定必须先于成员行（齿轮在 .member-card 容器内、成员按钮之外）
  const gear = target?.closest<HTMLElement>("[data-member-gear]");
  if (gear !== null && gear !== undefined) {
    ev.stopPropagation();
    const gearId = gear.dataset.memberGear;
    if (gearId !== undefined) void openSettings(gearId);
    return;
  }
  const member = target?.closest<HTMLButtonElement>("button.member");
  if (member === null || member === undefined || member.disabled) return; // 禁用行不响应（§10.5）
  const id = member.dataset.memberId;
  if (id === undefined) return;
  void openDetail(id, member.querySelector(".name")?.textContent ?? id);
});

function bindDetail(): void {
  detailView.querySelector("[data-detail-back]")?.addEventListener("click", closeDetail);
  const reload = (): void => {
    if (detailState.kind === "ready" || detailState.kind === "error") {
      void openDetail(detailState.memberId, detailState.name);
    }
  };
  detailView.querySelector("[data-detail-refresh]")?.addEventListener("click", reload);
  detailView.querySelector("[data-detail-retry]")?.addEventListener("click", reload);
  detailView.querySelector("[data-detail-wake]")?.addEventListener("click", () => {
    if (detailState.kind === "ready") injectWake(detailState.name);
  });
  detailView.querySelector("[data-detail-copy]")?.addEventListener("click", () => {
    if (detailState.kind !== "ready") return;
    const sid = detailState.detail.sessionId;
    void navigator.clipboard?.writeText(sid).then(undefined, () => fallbackCopy(sid));
    const btn = detailView.querySelector<HTMLButtonElement>("[data-detail-copy]");
    if (btn !== null) {
      btn.textContent = td(lang, "detail.copied");
      setTimeout(() => {
        if (btn.isConnected) btn.textContent = td(lang, "detail.copySessionId");
      }, 1500);
    }
  });
  // 〔视图修订 2026-10-25〕简洁/详细切换：模式相同忽略；切模式重置 cursor 回末页。
  for (const btn of detailView.querySelectorAll<HTMLButtonElement>("[data-detail-mode]")) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.detailMode;
      if (next !== "summary" && next !== "full") return;
      if (next === detailMode) return;
      if (detailState.kind !== "ready" && detailState.kind !== "error") return;
      const { memberId, name } = detailState;
      detailMode = next;
      detailSequencer.begin(); // 作废在途响应（跨模式 seq 不通用）
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
  // 动作组头部展开/收起（组内逐条工具行由下方 tool-row 绑定覆盖）
  for (const head of detailView.querySelectorAll<HTMLButtonElement>("button.tool-group-head")) {
    head.addEventListener("click", () => {
      const group = head.closest(".tool-group");
      const open = group?.classList.toggle("open") ?? false;
      head.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }
  // 工具调用折叠（默认折叠为一行：工具名+状态；点击展开载荷）
  for (const row of detailView.querySelectorAll<HTMLButtonElement>("button.tool-row")) {
    row.addEventListener("click", () => {
      const open = row.classList.toggle("open");
      row.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }
}

function fallbackCopy(text: string): void {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch {
    /* 剪贴板不可用：会话 id 在按钮 title 可见（可手工选取），不留死按钮 */
  }
  ta.remove();
}

// ---------------------------------------------------------------- 连接

app.onhostcontextchanged = () => {
  applyHostContext();
  render();
  if (settingsState.kind !== "closed") renderSettings(); // 语言/主题变化 → 弹窗文案同步
};

void (async () => {
  applyHostContext();
  restoreWidgetState();
  render();
  try {
    await app.connect();
    applyHostContext();
    restoreWidgetState();
    // 订阅先注册（handler 已装好，避免丢帧）；随后立即回环 refresh 取首帧——
    // resources/read 无会话身份（team:null），带 _meta.session_id 的 callServerTool
    // 才有权威身份帧（U01 ≤3s 可读；F14① 回环生效）。
    try {
      await subscribe();
    } catch {
      /* 订阅不可用（宿主无 zcode/resourceSubscribe）→ 仅回环 + 心跳 */
    }
    try {
      await refreshViaCall();
    } catch (err) {
      if (frame === null) {
        try {
          await readView();
        } catch (readErr) {
          // 首帧失败必须留下可读原因（不能只显示永久加载态）。
          navError = readErr instanceof Error ? readErr.message : err instanceof Error ? err.message : String(err);
          render();
        }
      }
    }
  } catch (err) {
    navError = err instanceof Error ? err.message : String(err);
    render();
  }
  startHeartbeat(); // H12：心跳保活为主方案（订阅在场也保留——兼负 D11 Lead 连接保活）
})();
