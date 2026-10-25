// 组件 CSS（面板与 ::visualize 卡片同源；V 类几何断言的唯一来源）。
// 数值 = 02 §10.3–§10.6 + assets/TeamAction.module.pretty.css 逐条对照；
// 颜色一律引用 src/ui-core/tokens.ts 的 --at-* 语义令牌（V12 无硬编码色）。
// 布局差异（D4）：DSH 的 fixed 定位/锚定/z-index/backdrop 属宿主弹层交互，两载体都由
// 宿主容器承载 → .team-panel 用 width/max-height 语义（100vw/100vh → 容器百分比在
// PANEL_CSS 内联覆写），其余几何逐值保持。

import { TOKEN_CSS } from "./tokens.js";

/** 基础组件样式（两载体共用；几何 = §10.3–§10.6 数值）。 */
export const COMPONENT_CSS = `
${TOKEN_CSS}
* { box-sizing: border-box; }
.at-root {
  font-family: var(--at-font);
  font-size: 13px;
  line-height: 1.5;
  color: var(--at-label-primary);
  width: 100%;
}
/* §10.3 面板：宽 min(500px, 容器−32px)；紧凑 min(320px,…)；最大高 min(680px, 视口−32px)；
   圆角 12；padding 8px 2px 0；flex column；overflow hidden；elevation-prominent 阴影；
   border-l1 描边（stroke 等价，无 border） */
.team-panel {
  width: min(500px, 100% - 32px);
  max-height: min(680px, 100vh - 32px);
  border-radius: 12px;
  box-shadow: var(--at-shadow-prominent);
  outline: 0.5px solid var(--at-border-l1);
  background: var(--at-bg-menu);
  padding: 8px 2px 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}
.team-panel.compact { width: min(320px, 100% - 32px); }
/* §10.3 body：overflow-y auto；scrollbar-gutter stable；padding 0 9px 16px 14px */
.panel-body {
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding: 0 9px 16px 14px;
  flex: auto;
  min-height: 0;
  scrollbar-color: var(--at-scrollbar-thumb) transparent;
}
.panel-body::-webkit-scrollbar { width: 8px; }
.panel-body::-webkit-scrollbar-thumb {
  background: var(--at-scrollbar-thumb);
  border-radius: 4px;
}
.panel-body::-webkit-scrollbar-thumb:hover { background: var(--at-scrollbar-thumb-hover); }
/* §10.5 节标题：13px/500，margin 16px 0 8px 4px（首节 top 8px），gap 8；
   count 12px/16px tabular-nums caption 色 */
.panel-body h3 {
  font-size: 13px;
  font-weight: 500;
  color: var(--at-label-primary);
  margin: 16px 0 8px 4px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.panel-body section:first-of-type h3 { margin-top: 8px; }
h3 .count {
  font-size: 12px;
  line-height: 16px;
  font-weight: 400;
  color: var(--at-label-caption);
  font-variant-numeric: tabular-nums;
}
/* §10.5 花名册网格：双列 minmax(0,1fr) gap 8；紧凑单列 */
.roster { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.compact .roster { grid-template-columns: minmax(0, 1fr); }
/* §10.5 成员卡：圆角 8；padding 10px 12px；gap 8；bg-layer-2；描边 border-l2（stroke 等价）；
   文字左对齐；flex 顶对齐；hover（非禁用）border-l3 + elevation-panel；disabled cursor default */
.member {
  border-radius: 8px;
  padding: 10px 12px;
  gap: 8px;
  background: var(--at-bg-layer-2);
  box-shadow: 0 0 0 0.5px var(--at-border-l2);
  border: none;
  text-align: left;
  display: flex;
  align-items: flex-start;
  font: inherit;
  color: inherit;
  min-width: 0;
  cursor: pointer;
}
.member:disabled { cursor: default; }
.member:not(:disabled):hover,
.member:not(:disabled):focus-visible {
  box-shadow: 0 0 0 0.5px var(--at-border-l3), var(--at-shadow-panel);
}
/* 当前会话高亮（仅 members>1）：business 40% 混色描边 + inset 1px 内环 */
.member.current {
  box-shadow: 0 0 0 0.5px color-mix(in srgb, var(--at-business) 40%, transparent),
    inset 0 0 0 1px color-mix(in srgb, var(--at-business) 40%, transparent);
}
/* 名字/次行文本列（§10.5 memberText：column，min-width 0 供 ellipsis） */
.member .member-text { display: flex; flex-direction: column; min-width: 0; gap: 2px; }
.member .row1 { display: inline-flex; align-items: center; gap: 5px; min-width: 0; max-width: 100%; }
/* 状态点容器：1lh 高垂直对齐（§10.5 memberDot） */
.member-dot { flex: none; align-items: center; height: 1lh; display: inline-flex; }
.member .name {
  font-weight: 500;
  color: var(--at-label-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.member .sub {
  font-size: 11px;
  color: var(--at-label-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
/* hover/focus 才显示「 · 模型: model」（§10.5/V06） */
.member .model { display: none; }
.member:hover .model,
.member:focus-visible .model { display: inline; }
.member .diagnostic {
  font-size: 11px;
  color: var(--at-error-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}
/* 当前会话 Tag（10px/15px，padding 0 4px，info tone） */
.current-tag {
  font-size: 10px;
  line-height: 15px;
  padding: 0 4px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--at-business) 16%, transparent);
  color: var(--at-business);
  flex: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* stage-8 D 成员卡容器：齿轮与成员按钮并列（HTML 不允许 button 嵌 button）。
   网格子项由 .member 变为 .member-card；成员按钮铺满容器，右侧让出齿轮位。 */
.member-card { position: relative; display: flex; min-width: 0; }
.member-card .member { width: 100%; padding-right: 28px; }
/* 齿轮：常显低强调（tertiary 55%），hover/focus 提亮；22px 命中区内嵌 14px 线性图标 */
.member-gear {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 22px;
  height: 22px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--at-label-tertiary);
  cursor: pointer;
  opacity: 0.55;
  transition: opacity 0.12s, color 0.12s, background-color 0.12s;
}
.member-card:hover .member-gear,
.member-gear:focus-visible { opacity: 1; }
.member-gear:hover,
.member-gear:focus-visible {
  color: var(--at-label-primary);
  background: color-mix(in srgb, var(--at-label-tertiary) 12%, transparent);
}
.member-gear:focus-visible { outline: 2px solid color-mix(in srgb, var(--at-business) 45%, transparent); outline-offset: 1px; }
/* stage-8 D 设置弹窗：.team-panel 为 position:relative + overflow:hidden → absolute inset 覆盖面板 */
.settings-overlay {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: color-mix(in srgb, var(--at-label-primary) 22%, transparent);
}
.settings-modal {
  width: min(380px, 100%);
  max-height: 100%;
  overflow-y: auto;
  scrollbar-gutter: stable;
  background: var(--at-bg-menu);
  color: var(--at-label-primary);
  border-radius: 12px;
  box-shadow: var(--at-shadow-prominent);
  outline: 0.5px solid var(--at-border-l1);
  padding: 12px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.settings-head { display: flex; align-items: center; gap: 8px; }
.settings-title {
  font-size: 13px;
  font-weight: 500;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.settings-close {
  margin-left: auto;
  flex: none;
  width: 22px;
  height: 22px;
  padding: 0;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--at-label-tertiary);
  font: inherit;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
.settings-close:hover,
.settings-close:focus-visible { color: var(--at-label-primary); background: color-mix(in srgb, var(--at-label-tertiary) 12%, transparent); }
.settings-current {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--at-label-secondary);
}
.settings-label { font-size: 11px; color: var(--at-label-tertiary); }
.settings-current-model { font-size: 12px; font-weight: 500; color: var(--at-label-primary); }
.source-badge {
  font-size: 10px;
  line-height: 15px;
  padding: 0 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--at-business) 16%, transparent);
  color: var(--at-business);
}
.source-badge.inherited {
  background: color-mix(in srgb, var(--at-state-ongoing) 16%, transparent);
  color: var(--at-state-ongoing);
}
.source-badge.observed {
  background: color-mix(in srgb, var(--at-label-tertiary) 14%, transparent);
  color: var(--at-label-secondary);
}
.source-badge.cli-default {
  background: color-mix(in srgb, var(--at-label-tertiary) 10%, transparent);
  color: var(--at-label-tertiary);
}
.settings-field { display: flex; flex-direction: column; gap: 4px; }
.modal-select {
  width: 100%;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  padding: 4px 6px;
  border-radius: 6px;
  border: 0.5px solid var(--at-border-l2);
  background: var(--at-bg-layer-2);
  color: var(--at-label-primary);
}
.modal-select:disabled { opacity: 0.6; }
.modal-select:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--at-business) 45%, transparent);
  outline-offset: 1px;
}
.settings-state {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--at-label-tertiary);
  padding: 8px 0;
}
.settings-state.error { color: var(--at-error-text); }
.settings-notice { font-size: 11px; color: var(--at-state-ongoing); }
/* GitHub #6：终态失败提示用错误色（与「已应用 / 下一轮生效」中性提示区分） */
.settings-notice.error { color: var(--at-error-text); }
.settings-foot { display: flex; justify-content: flex-end; gap: 8px; }
.settings-btn {
  background: none;
  border: 0.5px solid var(--at-border-l2);
  border-radius: 6px;
  color: var(--at-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 20px;
  padding: 1px 10px;
  cursor: pointer;
}
.settings-btn:hover,
.settings-btn:focus-visible { color: var(--at-label-primary); border-color: var(--at-border-l3); }
.settings-btn.primary {
  background: color-mix(in srgb, var(--at-business) 14%, transparent);
  border-color: color-mix(in srgb, var(--at-business) 45%, transparent);
  color: var(--at-business);
  font-weight: 500;
}
.settings-btn[disabled] { opacity: 0.45; cursor: default; }
.settings-advanced {
  border-top: 0.5px solid var(--at-border-l2);
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.settings-advanced-title { font-size: 11px; font-weight: 500; color: var(--at-label-secondary); }
.settings-advanced-hint { font-size: 11px; line-height: 16px; color: var(--at-label-tertiary); }
.settings-advanced .settings-btn { align-self: flex-start; }
/* 状态点：直径一致 8px（V06） */
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; }
.dot.ongoing { background: var(--at-state-ongoing); }
.dot.error { background: var(--at-state-error); }
.dot.idle { background: var(--at-state-idle); }
.dot.warning { background: var(--at-state-warning); }
.dot.done { background: var(--at-state-done); }
/* inactive 人形图标：14px tertiary（§10.5/V06） */
.icon-user { width: 14px; height: 14px; flex: none; color: var(--at-label-tertiary); display: inline-flex; }
/* §10.4 通知条：flex gap 6 padding 9 字号 12；error = 错误色；按序渲染 */
.notice, .error-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px;
  font-size: 12px;
}
.error-bar { color: var(--at-error-text); }
.notice { color: var(--at-label-secondary); }
/* §10.6 任务板：空板段落 12px tertiary margin 16px 0 0 4px；列表 flex column gap 7 */
.empty-notice { font-size: 12px; color: var(--at-label-tertiary); margin: 16px 0 0 4px; }
.tasks { display: flex; flex-direction: column; gap: 7px; }
/* 任务卡：border 0.5px border-l2；圆角 9；padding 11px 13px；bg-layer-2 */
article.task {
  border: 0.5px solid var(--at-border-l2);
  border-radius: 9px;
  padding: 11px 13px;
  background: var(--at-bg-layer-2);
}
.task .title-row { display: flex; align-items: center; gap: 8px; }
.task strong { font-size: 13px; font-weight: 500; line-height: 1.4; color: var(--at-label-primary); }
/* 状态徽标右对齐 11px gap 6 */
.task .task-state {
  margin-left: auto;
  font-size: 11px;
  color: var(--at-label-tertiary);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
/* 描述 12px/18px pre-wrap margin 5px 0；两行截断 */
.task p {
  font-size: 12px;
  line-height: 18px;
  color: var(--at-label-secondary);
  white-space: pre-wrap;
  margin: 5px 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.task p.expanded { -webkit-line-clamp: unset; display: block; }
/* 展开开关：float right；11px/20px；chevron 12px 旋转 180° transition .12s */
.expand-toggle {
  float: right;
  font-size: 11px;
  line-height: 20px;
  color: var(--at-label-tertiary);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  margin-left: 10px;
  font-family: inherit;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.expand-toggle:hover, .expand-toggle:focus-visible { color: var(--at-label-primary); }
.expand-toggle svg { transition: transform 0.12s; }
.expand-toggle.open svg { transform: rotate(180deg); }
.expand-toggle[hidden] { display: none; }
/* meta 行：11px/20px；子项间距 10px；warning 提醒色（advisory 非错误） */
.task .meta { font-size: 11px; line-height: 20px; color: var(--at-label-tertiary); }
.task .meta > span { margin-right: 10px; }
.task .meta .warning { color: var(--at-warning-text); }
/* T5.7 成员会话查看视图（V16：无 DSH 参照，宿主风格；判据=不破版+几何一致） */
.detail-view { display: flex; flex-direction: column; min-height: 0; flex: auto; }
.detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 9px 8px 6px;
  border-bottom: 0.5px solid var(--at-border-l2);
  flex: none;
}
.detail-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  color: var(--at-label-tertiary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
}
.detail-back:hover, .detail-back:focus-visible { color: var(--at-label-primary); background: color-mix(in srgb, var(--at-label-tertiary) 10%, transparent); }
.detail-title { font-size: 13px; font-weight: 500; color: var(--at-label-primary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail-actions { margin-left: auto; display: inline-flex; gap: 6px; flex: none; }
.detail-action {
  background: none;
  border: 0.5px solid var(--at-border-l2);
  border-radius: 6px;
  color: var(--at-label-secondary);
  font: inherit;
  font-size: 11px;
  line-height: 18px;
  padding: 1px 8px;
  cursor: pointer;
}
.detail-action:hover, .detail-action:focus-visible { color: var(--at-label-primary); border-color: var(--at-border-l3); }
.detail-list { overflow-y: auto; scrollbar-gutter: stable; padding: 8px 9px 16px 14px; flex: auto; min-height: 0; scrollbar-color: var(--at-scrollbar-thumb) transparent; }
.detail-state { font-size: 12px; color: var(--at-label-tertiary); padding: 16px 4px; display: flex; align-items: center; gap: 6px; }
.detail-state.error { color: var(--at-error-text); }
.msg { margin: 0 0 10px; min-width: 0; }
.msg-head { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--at-label-tertiary); margin-bottom: 2px; }
.msg-role { font-weight: 500; color: var(--at-label-secondary); }
.msg-time { font-variant-numeric: tabular-nums; }
.msg-text {
  font-size: 12px;
  line-height: 18px;
  color: var(--at-label-primary);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.msg.user .msg-text { color: var(--at-label-secondary); }
.msg-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  line-height: 15px;
  padding: 0 4px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--at-business) 16%, transparent);
  color: var(--at-business);
}
.msg-badge.hook { background: color-mix(in srgb, var(--at-label-tertiary) 14%, transparent); color: var(--at-label-tertiary); }
.tool-row { display: block; width: 100%; text-align: left; background: none; border: none; border-top: 0.5px solid var(--at-border-l2); padding: 4px 0; margin-top: 4px; font: inherit; cursor: pointer; color: var(--at-label-tertiary); }
.tool-row:hover, .tool-row:focus-visible { color: var(--at-label-primary); }
.tool-static { display: block; border-top: 0.5px solid var(--at-border-l2); padding: 4px 0; margin-top: 4px; color: var(--at-label-tertiary); }
.tool-row .tool-summary, .tool-static .tool-summary { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; line-height: 20px; }
.tool-row .tool-name, .tool-static .tool-name { font-weight: 500; color: var(--at-label-secondary); }
.tool-row svg { transition: transform 0.12s; }
.tool-row.open svg { transform: rotate(180deg); }
.tool-detail {
  display: none;
  font-size: 11px;
  line-height: 16px;
  color: var(--at-label-tertiary);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  max-height: 200px;
  overflow-y: auto;
  margin: 2px 0 0 18px;
}
.tool-row.open + .tool-detail { display: block; }
/* toolGroup：按轮动作组（头部一行汇总；展开逐条工具行，缩进对齐 tool-detail） */
.tool-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  border-top: 0.5px solid var(--at-border-l2);
  padding: 4px 0;
  margin-top: 4px;
  font: inherit;
  color: var(--at-label-tertiary);
  cursor: pointer;
}
.tool-group-head:hover, .tool-group-head:focus-visible { color: var(--at-label-primary); }
.tool-group-head .tool-group-label { font-size: 11px; line-height: 20px; color: var(--at-label-secondary); }
.tool-group-head:hover .tool-group-label,
.tool-group-head:focus-visible .tool-group-label { color: var(--at-label-primary); }
.tool-group-head svg { flex: none; transition: transform 0.12s; }
.tool-group.open .tool-group-head svg { transform: rotate(180deg); }
.tool-group-items { display: none; margin-left: 18px; }
.tool-group.open .tool-group-items { display: block; }
.tool-group-items > :first-child { border-top: none; }
.detail-pager { display: flex; align-items: center; gap: 8px; padding: 4px 0 8px; }
.detail-pager .detail-action[disabled] { opacity: 0.45; cursor: default; }
`;

/** 面板载体覆写（iframe 内容区：§10.3 卡片几何原样保留，居中呈现，背景透明）。 */
export const PANEL_CSS = `
html, body { margin: 0; padding: 0; height: 100%; }
body { background: transparent; }
.at-root { height: 100%; display: flex; align-items: flex-start; justify-content: center; padding: 16px 0; }
.team-panel { margin: 0 auto; }
/* 作者样式表中的 display 声明会覆盖 UA 的 [hidden]{display:none}（如 .detail-view 的
   display:flex）：列表↔详情切换必须由 hidden 真正隐藏，否则返回列表后详情残留在下方。 */
.team-panel [hidden] { display: none !important; }
`;

/** 卡片载体覆写（::visualize 沙箱：容器内居中呈现 §10.3 卡片形态）。 */
export const CARD_CSS = `
html, body { margin: 0; padding: 0; }
.at-root { display: flex; justify-content: center; padding: 16px 0; }
.team-panel { margin: 0 auto; }
`;
