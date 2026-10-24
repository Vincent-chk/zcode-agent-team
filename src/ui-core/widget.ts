// ::visualize 快照卡片 / standalone 静态页渲染器（T5.3；与面板同源组件层）。
// 产出 = 自包含 HTML 片段（::visualize 沙箱规则：无 doctype、根节点唯一 id、无 fetch/XHR/
// WebSocket、vendor 仅白名单——本卡片零 vendor，纯 DOM）。数据 = 渲染时内嵌快照（沙箱禁
// 网络 → 卡片不自刷新；刷新经 /team 重渲染或 sendFollowUpMessage）。
// 布局与面板同源（共用 COMPONENT_CSS + renderPanelBody + expand 行为）→ V15 基线共用前提。
// 卡片载体专属：CARD_CSS（容器内居中呈现 §10.3 卡片形态）。
//
// 展开态持久化 = window.zcode.widgetState/setWidgetState（≤16KiB；沙箱桥，缺位时降级内存）。
// 手动刷新下钻 = window.zcode.sendFollowUpMessage({prompt:"/team"})（重渲染拉最新快照）。

import { COMPONENT_CSS, CARD_CSS } from "./css.js";
import { DICT, type Lang, t } from "./dict.js";
import { iconUsers } from "./icons.js";
import { renderPanelBody, esc, isCompact } from "./render.js";
import type { ViewFrame } from "./view.js";

export interface WidgetOptions {
  frame: ViewFrame;
  lang?: Lang;
  theme?: "light" | "dark";
  /** 根节点唯一 id（::visualize 要求；缺省 agent-team-widget）。 */
  rootId?: string;
}

/**
 * 产出自包含 ::visualize HTML 片段（无 doctype/html/head/body；单根节点 + 内联 style/script）。
 * 内嵌快照 = frame（JSON 内联进 data-* 与渲染）；展开行为与面板同源（ResizeObserver 语义）。
 */
export function renderWidgetFragment(opts: WidgetOptions): string {
  const lang = opts.lang ?? "zh";
  const theme = opts.theme ?? "light";
  const rootId = opts.rootId ?? "agent-team-widget";
  const compact = isCompact(opts.frame);
  const body = renderPanelBody(opts.frame, lang, { loading: false });
  const frameJson = esc(JSON.stringify(opts.frame));
  return (
    `<div id="${esc(rootId)}" class="at-root" data-theme="${theme}" data-lang="${lang}" data-labels='${esc(JSON.stringify(widgetLabels(lang)))}'>` +
    `<style>${COMPONENT_CSS}${CARD_CSS}</style>` +
    `<div class="team-panel${compact ? " compact" : ""}" role="dialog" aria-label="${esc(t(lang, "trigger"))}" data-team-panel>` +
    `<div class="panel-body" data-list-view>${body}</div>` +
    `</div>` +
    `<script type="application/json" data-frame>${frameJson}</script>` +
    `<script>(function(){var __AT_ROOT_ID__=${JSON.stringify(rootId)};${WIDGET_SCRIPT}})();</script>` +
    `</div>`
  );
}

/** standalone 静态页（::visualize render.py 样板等价；CLI 高保真降级路径/浏览器打开）。 */
export function renderStandalonePage(opts: WidgetOptions & { title?: string }): string {
  const lang = opts.lang ?? "zh";
  const theme = opts.theme ?? "light";
  return (
    `<!doctype html>\n<html lang="${lang === "zh" ? "zh-CN" : "en"}" data-theme="${theme}">\n` +
    `<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n` +
    `<title>${esc(opts.title ?? t(lang, "trigger"))}</title>\n<style>${COMPONENT_CSS}${CARD_CSS}</style>\n</head>\n` +
    `<body>\n${renderWidgetFragment(opts)}\n</body>\n</html>\n`
  );
}

/**
 * 卡片内联脚本（沙箱安全：无 fetch/XHR/WebSocket；window.zcode 桥可选）。
 * 行为 = 展开/收起（ResizeObserver 溢出判定，与面板 attachExpandBehavior 同语义）+
 * widgetState 持久化展开集合 + 成员行点击 → sendFollowUpMessage("/team") 下钻提示。
 * 以字符串内联（沙箱禁外部脚本；逻辑与 ui-core/expand.ts 等价，单一算法两处载体）。
 */
const WIDGET_SCRIPT = `
var root = document.getElementById(__AT_ROOT_ID__);
if (!root) return;
var labels = { expand: '展开', collapse: '收起' };
try { labels = JSON.parse(root.getAttribute('data-labels') || '{}') || labels; } catch (e) {}
var store = { set: {} };
try {
  var ws = window.zcode && window.zcode.widgetState;
  if (ws && Array.isArray(ws.expanded)) { for (var i=0;i<ws.expanded.length;i++) store.set[ws.expanded[i]] = true; }
} catch (e) {}
function persist() {
  try {
    if (window.zcode && window.zcode.setWidgetState) {
      window.zcode.setWidgetState({ expanded: Object.keys(store.set).filter(function(k){return store.set[k];}) });
    }
  } catch (e) {}
}
function measure(task) {
  var desc = task.querySelector('[data-task-desc]');
  var toggle = task.querySelector('[data-task-toggle]');
  if (!desc || !toggle) return;
  var id = task.getAttribute('data-task-id') || '';
  var expanded = !!store.set[id];
  var overflow = desc.scrollHeight > desc.clientHeight + 1;
  toggle.hidden = !(overflow || expanded);
  var lbl = toggle.querySelector('.expand-label');
  if (lbl) lbl.textContent = expanded ? (labels.collapse||'收起') : (labels.expand||'展开');
  toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  toggle.classList.toggle('open', expanded);
  desc.classList.toggle('expanded', expanded);
}
var tasks = root.querySelectorAll('article.task');
for (var j=0;j<tasks.length;j++) {
  (function(task){
    var desc = task.querySelector('[data-task-desc]');
    if (desc && typeof ResizeObserver !== 'undefined') { new ResizeObserver(function(){ measure(task); }).observe(desc); }
    measure(task);
  })(tasks[j]);
}
root.addEventListener('click', function(ev){
  var t = ev.target;
  var toggle = t && t.closest ? t.closest('[data-task-toggle]') : null;
  if (toggle) {
    var task = toggle.closest('article.task');
    var id = task ? (task.getAttribute('data-task-id')||'') : '';
    store.set[id] = !store.set[id];
    measure(task); persist();
    return;
  }
  var member = t && t.closest ? t.closest('button.member') : null;
  if (member && !member.disabled) {
    try {
      if (window.zcode && window.zcode.sendFollowUpMessage) {
        window.zcode.sendFollowUpMessage({ prompt: '/team' });
      }
    } catch (e) {}
  }
});
`;

/** labels 注入（renderWidgetFragment 内联 script 读取；此处导出供夹具/测试）。 */
export function widgetLabels(lang: Lang): { expand: string; collapse: string } {
  return { expand: DICT[lang]["task.expand"], collapse: DICT[lang]["task.collapse"] };
}

void iconUsers;
