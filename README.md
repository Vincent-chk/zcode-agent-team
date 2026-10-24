# agent-team（ZCode 复刻 DSH Agent Teams · stage-1–6）

- 状态：stage-1–5 全部交付（域核心 / 工具面 / 队友运行时 / 可视化 UI / 成员会话隔离），2026-10-19 合同与安全修复轮 + 2026-10-20 Round-2 收口（锁 TOCTOU、视图泵并发、RPC 权限、消息边界、落盘安全）；**stage-6 自动化验收已执行**（S1–S6、文本审计、性能/安全/升级演练全绿；用户手工清单与终验待回填）。架构决策见 `../zcode-agent-team-plan/stage-0-research/04`（ADR-4/5 已定版）
- stage-5：主载体 = MCP Apps 会话面板（`resources/subscribe` 实时视图帧 + 25s 心跳保活 + `callServerTool` 回环）；辅 = ::visualize 快照卡片（桌面）；CLI = `/team` 文本摘要 + `team-ctl state/transcript/widget/open-panel`；视觉/文案保真 = 02 §10（`docs/token-map.md` 令牌映射 + `scripts/visual-regress.mjs` 72 基线）；成员会话查看视图（T5.7）= db.sqlite 只读导出 + events/delivered 徽标回填；伴生面板（可选，`TEAM_COMPANION=1`）复刻 DSH 全触发器交互
- stage-4：teammate = `zcode -p [--resume] --json --mode yolo --surface terminal --disallowed-tools Task` 独立进程组轮次（ADR-4 主实现）；恰一次 = `run/turn-*.json` 先于孵化落盘 + db 落库实查；Lead 投递 = hook 三通道（Stop block ≤3/run、UserPromptSubmit、SessionStart(resume)）+ 回执文件；恢复对账 = `members/<id>/origin.json` 四条件 + 孤儿轮次纳管；崩溃矩阵 `node scripts/crash-matrix.mjs`；真实模型验收 `node scripts/stage4-real.mjs`（参数见文件头）
- 要求：Node ≥ 22（daemon 启动自检，`process.version` 记录于 `$TEAM_PLUGIN_DATA/logs/daemon-lifecycle.jsonl`）

## 组件

| 组件 | 位置 | 说明 |
|---|---|---|
| MCP server（team-daemon） | `.mcp.json` + `src/daemon.ts` → `dist/team-daemon.mjs` | `team_panel_call`（app 专用回环：心跳/refresh/detail）；`team_ping` 仅 `TEAM_DEBUG_TOOLS=1` 诊断暴露；`ui://agent-team/team-panel.html` 资源 + `team://view` 真实投影视图帧订阅（500ms 轮询构帧，contentKey 变化才推帧，mailbox-only 不推）；伴生 HTTP 服务（`TEAM_COMPANION=1`）；配置校验（TEAM_INVALID_CONFIG fail-loud） |
| 面板（MCP Apps） | `src/panel/main.ts` → `dist/ui/team-panel.html` | 生产 UI：§10.3–§10.6 布局/状态点/通知条/词典/紧凑/展开 + 订阅/心跳/回环/updateModelContext 下钻 + T5.7 成员会话查看二级视图（只读） |
| UI 同源层 | `src/ui-core/**` | tokens（三级令牌映射）/dict（§10.7 逐字词典 + T5.7 新增文案）/render（花名册/任务板/通知条纯函数）/detail-render（二级视图）/widget（::visualize 片段 + standalone）/expand（展开行为）/icons/view（帧类型）——面板·卡片·伴生页·夹具四载体共用 |
| 面板数据面 | `src/panel/view-service.ts`·`detail.ts`·`panel-call.ts`·`companion-server.ts` | 视图帧构建（身份解析 + 重放 + 活性呈现 + snapshot 落盘）/ detail 合成（db 只读 + framed 回填 + 分页）/ 回环分发 / 伴生 HTTP+SSE |
| hooks | `hooks/hooks.json` + `src/hooks.ts` → `dist/team-hooks.mjs` | SessionStart(startup\|resume)/Stop/UserPromptSubmit 三事件；注入与实验控制文件（`ups-demo`/`stop-demo.json`/`signal-test`） |
| skill / command | `skills/team-coordination/SKILL.md`、`commands/team.md` | 策略辅通道（H14 标记 B）与 `/team` 入口（三场景 + 三档刷新协议） |
| team-ctl | `src/cli/**` → `dist/team-ctl.mjs` | state/tail/inject-event/call + **transcript**（T5.7 CLI 对等）/**widget**（T5.3 卡片）/**open-panel**（T5.5 伴生入口） |
| userConfig | `.zcode-plugin/plugin.json` | 4 限额 + interrupt 开关；`ui.surfaces` = agent-team-panel |
| PoC 脚本 | `poc/` | resume-loop / app-server / h5-stop / h10-h11 / db-inspect |
| 视觉回归 | `scripts/visual-regress.mjs` + `test/visual/baseline/`（72 张） | 8 夹具 × 浅深 × zh/en × panel/card + detail 2 组（V16）；几何断言 ±1px + V12 硬编码色扫描 + V15 像素自比对 ≤0.5% |

## 开发循环（零 UI）

```bash
npm install && npm run build          # 构建 dist/（daemon/hooks/team-ctl/面板/伴生页）
node scripts/dev-install.mjs install  # plugins.dirs 直载 + agent-team@inline 一次性启用
# 改码 → npm run build → 开新任务即生效（无需安装/升级动作）
node scripts/dev-install.mjs status|uninstall|reinstall
node scripts/smoke-daemon.mjs         # daemon 冒烟（不依赖宿主；stage-5 帧/推帧/回环断言）
node scripts/visual-regress.mjs       # 视觉回归（72 基线；--update 重录；--only=<夹具>）
node scripts/f10-companion.mjs        # 伴生面板交互矩阵（F10；需先 npm run build）
```

桌面 Plugins UI 安装验证在 stage-6 用户清单中执行；自动化侧用 `node scripts/dev-install.mjs install` 直载本仓库。

## 已知宿主行为（stage-1 定案，设计必须消化）

- `${ZCODE_SESSION_ID}` 写入 env 即禁用 server（`plugin_variable_missing`）；会话 id 只走 callTool `_meta` + hook env
- daemon：引用归零后 30s SIGINT；SIGINT→SIGTERM ~260ms（处置只能轻量落盘）；**生命周期=按需（工具窗口驱动）**，session 存活不维持 daemon（H12 定案：面板保活用 25s callServerTool 心跳）
- **D11**：桌面 callTool 撞已回收连接 → 挂起/Client closed 会话内不恢复（teammate 走 `-p` 自管连接不受影响）
- Stop hook 续跑 ≤3 次/run；注入文本不持久化为 transcript part
- `zcode tui` 在 Desktop 捆绑 zcode.cjs 中不可用（缺 @zcode/tui，npm 无此包）
- **teammate 会话绝不进左侧任务栏（stage-6 修正）**：`zcode -p` 直接建的会话是顶层 `interactive`，
  桌面每次启动时 `seedMissingRowsFromInitialSnapshot` 会把它补登进 `tasks-index`（H7 旧结论
  「外部会话默认不可见」**已作废**）。现在 teammate 一律建为宿主原生 `selection_side_chat`
  隐藏子会话（该类型被 sessions-index/task-index 白名单排除），anchor 行再写 tombstone；
  旧团队遗留的可见行用 `team-ctl sidebar-audit --apply` 归档。见「会话隔离」小节。

## 环境变量（stage-4/5）

| 变量 | 默认 | 说明 |
|---|---|---|
| `TEAM_ZCODE_BIN` | 自动发现（`ZCODE_RG_BINARY` 推导 → Desktop 常驻路径 → which） | teammate 轮次的 zcode 二进制（.cjs/.js 用 node 解释） |
| `TEAM_DRAIN_ON_DISPOSE` | `keep` | D9 处置策略：keep=休眠态（daemon 回收不杀轮次，仅落标记）/ kill=§12 完整序列 |
| `TEAM_FORK_MAX_CHARS` | 24000 | D3 fork 转录截断预算（字符） |
| `TEAM_DB_PATH` | `~/.zcode/cli/db/db.sqlite` | 会话库只读探针路径（测试注入用；stage-5 detail 合成同源） |
| `TEAM_DETACH_HELPER` | dist sibling | 脱离孵化器资产路径（测试注入用） |
| `TEAM_COMPANION` | （关） | `1` = daemon 内启动伴生面板 HTTP 服务（127.0.0.1 随机端口 + token；注册 `logs/panel-http.json`，`team-ctl open-panel` 打开） |
| `TEAM_SESSION_ISOLATION` | `child` | teammate 会话语义：`child` = 宿主原生隐藏子会话（不进任务栏）；`legacy` = 旧顶层 interactive（仅回滚用，会在任务栏出现） |
| `TEAM_TASKS_INDEX` | `~/.zcode/v2/tasks-index.sqlite` | 桌面任务索引路径（sidebar-audit 与 anchor tombstone 用；测试注入） |
| `TEAM_APP_SERVER_BRIDGE` | dist sibling | app-server 桥接器路径（测试注入用） |
| `TEAM_WAKE_LEAD` | （关） | `1` = 空闲 Lead 收到团队消息时拉起 `--resume` 处理收件箱（灰度；默认关闭） |
| `TEAM_WAKE_LEAD_MIN_IDLE_MS` | `30000` | 空闲唤醒的最小空闲窗口（毫秒） |
| `TEAM_DEBUG_TOOLS` | （关） | `1` = 在 tools/list 暴露 `team_ping` 诊断工具（模型面默认 9 工具） |
| `TEAM_POLICY_PROBE` | （关） | `1` = SessionStart 注入策略探针标记（仅 F08 取证用） |
| `TEAM_DEBUG_DELIVERY` | （关） | `1` = 记录 pending 补投/延后原因（`logs/provider.jsonl` 与 daemon stderr；排障用） |

## 验收工具（stage-6）

```bash
npm run build                     # dist（daemon/hooks/team-ctl/ui）
node scripts/text-audit.mjs       # SF08 逐字文本审计（23 项；含 D26 编排段）
node scripts/e2e/run.mjs          # S1–S6（--only s1,s3；--retries 1）
node scripts/perf-baseline.mjs    # SF10 七指标（fake-zcode 确定性）
node scripts/security-audit.mjs   # SF12 权限/写入边界/只读审计
node scripts/upgrade-drill.mjs    # SF11 升级兼容（checkpoint/续跑）
node scripts/crash-matrix.mjs     # C1–C5 进程级故障矩阵
node scripts/visual-regress.mjs   # SV01 视觉基线（72）
node scripts/f10-companion.mjs    # 伴生面板交互矩阵（17）
```

e2e 参数：`ZCODE_BIN` / `TEAM_DATA_ROOT` / `TEAM_DB_PATH` / `E2E_OUT` / `E2E_WS` / `E2E_MODEL`；
`E2E_FAKE=1` 用 fake-zcode 走确定性链路（S1/S2 的结构断言），默认真模型。

## 会话隔离（stage-6）

**问题**：`zcode -p` 建的 teammate 会话是顶层 `interactive`，桌面在 sessions-index 基线补齐时
（`seedMissingRowsFromInitialSnapshot`）把它补登进 `tasks-index`，于是与 Lead 平级出现在左侧任务栏。

**做法**（`src/provider/session-breeder.ts`）：

1. 起一个短生命周期 `zcode app-server`（NDJSON，经 `app-server-bridge.mjs` 孵化）；
2. `v4/command createSession`（`permissionScope=session`）在项目 workspace 内建**已持久化空 anchor**；
3. 在 anchor 下 `v4/command createSelectionSideSession` 得到 `selection_side_chat` 子会话
   （宿主白名单排除：不进 sessions-index / task-index）；
4. 给 anchor 写 tasks-index tombstone（`deleted=1`，只写自己一行）；
5. 首轮用 `zcode -p … --resume <child>` 驱动；后续轮次与冷恢复沿用同一 `--resume`。

失败语义对齐 DSH：培育失败直接让成员落 `failed`，**不静默回退**成可见会话。
回滚：`TEAM_SESSION_ISOLATION=legacy` 恢复旧行为（已建 child 会话仍可正常 resume）。

**存量迁移**（显式、可复核，daemon 不自动执行）：

```bash
node dist/team-ctl.mjs sidebar-audit <teamDir>            # dry-run：列出会归档哪些行
node dist/team-ctl.mjs sidebar-audit <teamDir> --apply    # 只把成员会话行置 archived=1 + 写台账
```

台账 = `<teamDir>/sidebar-migration.json`；只匹配 `origin.json` 记录的 sessionId 且同 workspace，
不删行、不插入、不改其他列；重复执行幂等。归档视图仍可看到这些会话（可手工还原）。

## 疑难解答（本工程实测遇到的宿主环境问题）

- **Bash/工具链突然 ENOENT / `process.cwd failed`**：多为会话进程或 MCP 内核的 cwd 被删（外置卷卸载、临时目录清理）。处置：`for P in $(pgrep -f zcode-node-repl-mcp); do … lsof 查 cwd，失效则 kill $P`——宿主会按需重生内核；外置卷卸载则等重挂后路径自然恢复。
- **桌面会话工具调用挂起/`Client closed`**：见 D11——新开会话并让模型立刻调用（30s 窗口）即可命中存活 daemon。
- **双副本陷阱（开发期保持仅 inline）**：经市场安装 `agent-team@agent-team-dev` 做 UI 取证后**必须即刻卸载**（`zcode plugins uninstall agent-team@agent-team-dev --force`）——否则与 `plugins.dirs` 直载并存：hooks 双注入（所有会话）、daemon ×4、MCP 由 12:xx 静态快照应答（源码漂移后行为失真）。卸载后核对 `plugins list` 与 `~/.zcode/cli/config.json` 双通道均只剩 `agent-team@inline`（复核轮 43 号证据）。
- **db.sqlite 轮询必须走索引**：message/part 按 session_id 索引（1–2ms/查询）；对 part 全表 LIKE = 1.6GB 扫描（10s+/次）。`-p` 会话首条 real_user 文本落库约 +3s（会话行 +2.4s）——首轮探针预算据此设计
- **`--json` 输出在轮次结束才出现**：sessionId 不可从 stdout 实时取；stage-4 首轮会话 id 认领 = teammate SessionStart hook 经 `TEAM_SPAWN_IDENTITY` 写 session-map（实测 env 继承成立）+ db 目录/首条文本锚定
- **macOS AppleDouble（`._*`）会被宿主当组件解析**：曾出现幽灵命令 `_team`（`commands/._team.md` 被解析为命令，桌面 UI 可见）。本仓 `.gitignore` 已排除 `._*`；stage-7 打包须过滤 `._*`/`.DS_Store`（zip 前清扫或 `ditto -X`），清理后用 app-server `plugins/list` 复验 commands items（44 号证据）。stage-5 视觉回归同纪律：readdir 过滤 `._` 前缀（否则 AppleDouble 被当夹具页加载超时）。
