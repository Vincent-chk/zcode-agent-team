// T5.1 设计令牌映射（docs/token-map.md 同源；面板与 ::visualize 卡片共用本层）。
// 口径（开发规划 T5.1）：DSH dsw 令牌 → ZCode 主题变量。三级取值链（先命中先用）：
//  ① MCP Apps 宿主标准变量（--color-*，hostContext.styles.variables 注入，随宿主主题切换）
//     —— 面板载体在场；
//  ② ::visualize 沙箱主题变量（--foreground/--muted-foreground/--card/--border/--red/--blue/
//     --green/--yellow/--primary，stage-1 已验两载体都提供主题 CSS 变量）—— 卡片载体在场；
//  ③ 主题化字面兜底（light/dark 两套 = stage-1 PoC 冻结色，evidence 45-V04）——
//     Playwright 夹具页 / standalone 导出 / CLI 静态页。
// V12「无硬编码色」扫描口径：兜底字面量只允许出现在本文件 TOKEN_CSS（组件 CSS 一律
// 引用 --at-* 语义令牌）。映射总表见 docs/token-map.md（视觉验收判色依据；同步修订）。

/** 语义令牌层：--at-*（agent-team）。组件 CSS 只准引用这层。 */
export const TOKEN_CSS = `
:root, [data-theme="light"] {
  color-scheme: light;
  /* 文字四档（dsw label-primary/secondary/tertiary/caption；
     caption 无独立宿主变量 → tertiary 同档 + 字面兜底区分） */
  --at-label-primary: var(--color-text-primary, var(--foreground, #1a2233));
  --at-label-secondary: var(--color-text-secondary, var(--muted-foreground, #3d4a5c));
  --at-label-tertiary: var(--color-text-tertiary, var(--muted-foreground, #8a94a6));
  --at-label-caption: var(--color-text-tertiary, #9aa3b2);
  /* 背景两档（dsw specific-menu / bg-layer-2） */
  --at-bg-menu: var(--color-background-secondary, var(--muted, #f7f8fa));
  --at-bg-layer-2: var(--color-background-primary, var(--card, #ffffff));
  /* 描边三档（dsw border-l1/l2/l3；宿主单档 --border → 三档透明度派生） */
  --at-border-l1: var(--color-border-primary, var(--border, rgba(16, 24, 40, 0.08)));
  --at-border-l2: var(--color-border-tertiary, var(--border, #e3e6eb));
  --at-border-l3: var(--color-border-secondary, var(--border, #c9cfd8));
  /* 状态点五类色（ongoing/idle/done/warning → --green/灰/--blue/--yellow 或自绘） */
  --at-state-ongoing: var(--color-text-success, var(--green, #12a675));
  --at-state-error: var(--color-text-danger, var(--red, #e5484d));
  --at-state-idle: var(--color-text-disabled, #98a2b3);
  --at-state-warning: var(--color-text-warning, var(--yellow, #f59e0b));
  --at-state-done: var(--color-text-info, var(--blue, #3e7bfa));
  /* 业务主色（dsw state-business-primary：当前会话高亮/info Tag） */
  --at-business: var(--color-text-info, var(--primary, #3e7bfa));
  /* 错误文本（dsw state-error-primary） */
  --at-error-text: var(--color-text-danger, var(--red, var(--destructive, #d93036)));
  /* 阴影两档（dsw elevation-prominent / elevation-panel） */
  --at-shadow-prominent: var(--shadow-lg, 0 8px 28px rgba(16, 24, 40, 0.16));
  --at-shadow-panel: var(--shadow-md, 0 4px 16px rgba(16, 24, 40, 0.12));
  /* 滚动条（dsh scrollbar 令牌自绘） */
  --at-scrollbar-thumb: color-mix(in srgb, var(--at-label-tertiary) 40%, transparent);
  --at-scrollbar-thumb-hover: color-mix(in srgb, var(--at-label-tertiary) 60%, transparent);
  /* 字体（不引外部字体，跟随宿主 UI 字体栈） */
  --at-font: var(--font-sans, -apple-system, "PingFang SC", "Segoe UI", sans-serif);
}
[data-theme="dark"] {
  color-scheme: dark;
  --at-label-primary: var(--color-text-primary, var(--foreground, #e8eaf0));
  --at-label-secondary: var(--color-text-secondary, var(--muted-foreground, #c0c6d2));
  --at-label-tertiary: var(--color-text-tertiary, var(--muted-foreground, #8d95a3));
  --at-label-caption: var(--color-text-tertiary, #7d8593);
  --at-bg-menu: var(--color-background-secondary, var(--muted, #1b1e24));
  --at-bg-layer-2: var(--color-background-primary, var(--card, #23262d));
  --at-border-l1: var(--color-border-primary, var(--border, rgba(255, 255, 255, 0.08)));
  --at-border-l2: var(--color-border-tertiary, var(--border, #333842));
  --at-border-l3: var(--color-border-secondary, var(--border, #434a56));
  --at-state-ongoing: var(--color-text-success, var(--green, #2fbf8f));
  --at-state-error: var(--color-text-danger, var(--red, #ff6b6e));
  --at-state-idle: var(--color-text-disabled, #7d8593);
  --at-state-warning: var(--color-text-warning, var(--yellow, #ffb454));
  --at-state-done: var(--color-text-info, var(--blue, #6c9cff));
  --at-business: var(--color-text-info, var(--primary, #6c9cff));
  --at-error-text: var(--color-text-danger, var(--red, var(--destructive, #ff8a8d)));
  --at-shadow-prominent: var(--shadow-lg, 0 8px 28px rgba(0, 0, 0, 0.5));
  --at-shadow-panel: var(--shadow-md, 0 4px 16px rgba(0, 0, 0, 0.4));
}
`;
