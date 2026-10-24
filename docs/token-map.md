# T5.1 · 设计令牌映射表（DSH dsw → ZCode/MCP Apps）

> 视觉验收的判色依据（stage-5 开发规划 T5.1）。面板（MCP Apps）与 ::visualize 快照卡片
> **共用同一映射**；实现同源 = `src/ui-core/tokens.ts`（`--at-*` 语义令牌层），本表与
> 该文件必须同步修订。
>
> 取值链（三级，先命中先用）：
> ① MCP Apps 宿主标准变量（`--color-*`，hostContext `styles.variables` 注入，ZCode 侧来源
>    = 宿主内部令牌 `--color-foreground` 等，深浅主题自动切换）——面板载体在场；
> ② ::visualize 沙箱主题变量（`--foreground`/`--muted-foreground`/`--card`/`--muted`/
>    `--border`/`--red`/`--green`/`--blue`/`--yellow`/`--primary`，stage-1 已验两载体都提供）
>    ——卡片载体在场；
> ③ 主题化字面兜底（light/dark 两套 = stage-1 PoC 冻结色，evidence 45-V04）——Playwright
>    夹具页 / standalone 导出 / CLI 静态页。
> `data-theme` 属性只影响②③兜底分支；①在场时跟随宿主主题。
>
> V12「无硬编码色」扫描口径：兜底字面量**只允许**出现在 `src/ui-core/tokens.ts` 的
> TOKEN_CSS（与 vendor/基线截图工程）；组件 CSS 一律只引用 `--at-*`。

## 1. 颜色令牌

| DSH dsw 令牌 | 语义令牌 | ① 宿主变量 | ② visualize 变量 | 兜底 light | 兜底 dark | 用途（规格 §10） |
|---|---|---|---|---|---|---|
| `--dsw-alias-label-primary` | `--at-label-primary` | `--color-text-primary` | `--foreground` | #1a2233 | #e8eaf0 | h3 节标题、成员名、任务标题、hover 提升文字 |
| `--dsw-alias-label-secondary` | `--at-label-secondary` | `--color-text-secondary` | `--muted-foreground` | #3d4a5c | #c0c6d2 | 任务描述（§10.6） |
| `--dsw-alias-label-tertiary` | `--at-label-tertiary` | `--color-text-tertiary` | `--muted-foreground` | #8a94a6 | #8d95a3 | 成员次行、meta 行、taskState、展开开关、空板段落、inactive 人形图标 |
| `--dsw-alias-label-caption` | `--at-label-caption` | `--color-text-tertiary`（同档） | —（字面） | #9aa3b2 | #7d8593 | h3 count（§10.5） |
| `--dsw-specific-menu` | `--at-bg-menu` | `--color-background-secondary` | `--muted` | #f7f8fa | #1b1e24 | 面板背景（§10.3） |
| `--dsw-alias-bg-layer-2` | `--at-bg-layer-2` | `--color-background-primary` | `--card` | #ffffff | #23262d | 成员卡/任务卡背景 |
| `--dsw-alias-border-l1` | `--at-border-l1` | `--color-border-primary` | `--border` | rgba(16,24,40,.08) | rgba(255,255,255,.08) | 面板描边（stroke 等价） |
| `--dsw-alias-border-l2` | `--at-border-l2` | `--color-border-tertiary` | `--border` | #e3e6eb | #333842 | 成员卡描边（elevation-stroke）、任务卡 border 0.5px |
| `--dsw-alias-border-l3` | `--at-border-l3` | `--color-border-secondary` | `--border` | #c9cfd8 | #434a56 | 成员卡 hover/focus 描边加深 |
| `--dsw-alias-state-error-primary` | `--at-error-text` | `--color-text-danger` | `--red` → `--destructive` | #d93036 | #ff8a8d | 导航错误条、failure 条、diagnostic 行、writeScopeWarning |
| `--dsw-alias-state-business-primary` | `--at-business` | `--color-text-info` | `--primary` | #3e7bfa | #6c9cff | 当前会话高亮（40% 混色描边 + inset 1px 内环）、current Tag |
| 状态点 ongoing | `--at-state-ongoing` | `--color-text-success` | `--green` | #12a675 | #2fbf8f | running/provisioning、in_progress |
| 状态点 error | `--at-state-error` | `--color-text-danger` | `--red` | #e5484d | #ff6b6e | failed |
| 状态点 idle | `--at-state-idle` | `--color-text-disabled` | —（自绘字面） | #98a2b3 | #7d8593 | pending∧ready |
| 状态点 warning | `--at-state-warning` | `--color-text-warning` | `--yellow` | #f59e0b | #ffb454 | pending∧¬ready |
| 状态点 done | `--at-state-done` | `--color-text-info` | `--blue` | #3e7bfa | #6c9cff | completed（deleted 复用） |

状态点六态映射（§10.5/§10.6，F09）：member `running/provisioning → ongoing`、`failed → error`、
`inactive → 人形图标`（14px，`--at-label-tertiary`）；task `pending∧ready → idle`、
`pending∧¬ready → warning`、`in_progress → ongoing`、`completed → done`。

## 2. 阴影/滚动条/字体

| DSH | 语义令牌 | 宿主变量 | 兜底 light | 兜底 dark | 用途 |
|---|---|---|---|---|---|
| `--dsw-elevation-prominent` | `--at-shadow-prominent` | `--shadow-lg` | 0 8px 28px rgba(16,24,40,.16) | 0 8px 28px rgba(0,0,0,.5) | 面板阴影（V02「阴影存在」） |
| `--dsw-elevation-panel` | `--at-shadow-panel` | `--shadow-md` | 0 4px 16px rgba(16,24,40,.12) | 0 4px 16px rgba(0,0,0,.4) | 成员卡 hover 提升 |
| `--dsh-scrollbar-thumb(-hover)` | `--at-scrollbar-thumb(-hover)` | —（color-mix 派生） | tertiary 40%/60% 透明混色 | 同左 | body 滚动条自绘 |
| dsw 字体栈 | `--at-font` | `--font-sans` | -apple-system, "PingFang SC", "Segoe UI", sans-serif | 同左 | 全局（不引外部字体） |

## 3. 宿主变量来源备注（2026-10-18 现场核实）

ZCode 桌面 renderer 把内部令牌映射为 MCP Apps 标准变量注入 iframe：
`--color-text-primary ← --color-foreground`、`--color-text-secondary ← --color-foreground-subtle`、
`--color-text-tertiary ← --color-foreground-subtlest`、`--color-text-danger ← --color-destructive`、
`--color-text-info ← --color-brand`、`--color-text-success ← --color-success`、
`--color-text-warning ← --color-warning`、`--color-background-primary ← --color-background`、
`--color-background-secondary ← --color-panel`、`--color-border-primary ← --color-border`、
`--color-border-secondary ← --color-border-hover`、`--color-border-tertiary ← --color-card-border`
（bundle 现场摘录，app.asar `styleVariables` 构造表）。深浅主题下宿主变量值自动切换，
`data-theme` 属性只影响兜底字面分支。

## 4. 两载体差异登记

- MCP Apps 面板：宿主变量在场 → 全表首选列生效（跟随 ZCode 主题，与宿主 UI 一致）；
- ::visualize 卡片（静态沙箱）：宿主变量缺位 → 兜底字面值生效（light/dark 由渲染参数
  `?theme=` 或内嵌快照 meta 决定）；两载体几何数值同一套组件 CSS（同源，V15 基线共用前提）；
- 当前会话 Tag（§10.5 tone=info）：`--at-business` 16% 混色背景 + 同色文字（宿主无
  info-background 语义时保持自绘混色，两主题对比度均 ≥4.5:1 由 V 类截图人工复核兜底）。
