# 《02 规格》→ 实现/测试/证据 追溯矩阵（SF09）

> 对照源：`zcode-agent-team-plan/stage-0-research/02-AgentTeam插件全量功能规格.md`（对齐轮修订版）
> ＋ `stage-0-research/06-基准升版-0.2.1-alpha.5.md`（冻结包 06，2026-10-17 基准）。
> 口径：每节至少一个用例/脚本或「不适用 + 理由」；「通过」= 自动化用例或 e2e 证据可复核。
> 偏差编号引用 `zcode-agent-team-plan/stage-0-research/04-能力映射与差距分析.md`（D1–D25，D19–D25 为本轮新增）。
> 文档更新时间：2026-10-25（0.3.2 detail 摘要视图〔二次修订：仅简洁〕文档回写）。

## 1. 包组成与组合（§1）

| 规格点 | 实现 | 用例/证据 | 状态 |
|---|---|---|---|
| 四包组合（experimental/tool/client-ui/profile） | ZCode 单插件：`.zcode-plugin/plugin.json` + MCP server + skills + command + ui.surfaces | `npm run check`（plugins validate）；`test/mcp/tools-snapshot.test.ts` | 通过（偏差 D1：单包承载） |
| 工具注册 9 个（interrupt=false → 8）〔stage-8 修订 2026-10-24：10 个 / 关闭 interrupt 时 9 个，+§9.13〕 | `src/mcp/registry.ts`、`src/mcp/handlers.ts` | `test/mcp/tools-snapshot.test.ts`（wire 清单恰 10；无 team_ping） | 通过 |
| 插件展示（name/description/icon） | `.zcode-plugin/plugin.json`、`marketplace.json` | `npm run check` 校验 | 通过（图标属 stage-7） |

## 2. 领域模型与术语（§2）

| 规格点 | 实现 | 用例/证据 | 状态 |
|---|---|---|---|
| Lead/teammate、target/name/id、provisioning/active/failed、inactive 语义 | `src/domain/roster.ts`、`src/domain/projection.ts` | `test/domain/roster.test.ts`（25）、`test/domain/projection-member.test.ts` | 通过 |
| 隐式 Lead（每个根会话即团队） | `src/mcp/identity.ts` | `test/mcp/identity.test.ts`（含孤儿/fail-closed 分支） | 通过 |
| teammate 会话隔离（selection_side_chat 隐藏子会话） | `src/provider/session-breeder.ts` | `test/provider/session-breeder.test.ts`（14）、`test/provider/session-isolation.test.ts`；e2e S2（真模型 child 会话） | 通过 |

## 3. 持久事件模型（§3）

| 规格点 | 实现 | 用例/证据 | 状态 |
|---|---|---|---|
| 事件 4 型 + version 2 + 旧名兼容（D23） | `src/domain/events.ts`（`team/member|team/task|team/message/queued|delivered`；legacy alias） | `test/domain/events.test.ts`（30）、`test/domain/projection-message.test.ts`；S3 17 点矩阵 | 通过 |
| 追加前校验 = 投影 apply 校验 | `src/domain/invariant.ts`、`src/coord/journal.ts` | `test/domain/invariant.test.ts`、`test/coord/unit-journal.test.ts` | 通过 |
| 重放 fail-closed（坏行/断裂 seq → failure，不静默） | `src/coord/replay.ts` | `test/coord/unit-replay.test.ts`、`test/coord/replay-checkpoint-utf8.test.ts`、`test/coord/integration/dual-writer.test.ts` | 通过 |
| 客户端投影视图（wire） | `src/domain/task-view.ts`、`src/ui-core/view.ts` | `test/domain/task-view.test.ts`、`test/ui-core/widget.test.ts` | 通过 |
| checkpoint（字节偏移 + 重建；D23） | `src/coord/replay.ts`、`src/coord/journal.ts` | `test/coord/unit-journal.test.ts`（close 落盘）、`scripts/upgrade-drill.mjs`（删除后冷启动重建） | 通过 |
| 1 万行重放性能 | — | `scripts/perf-baseline.mjs`：233ms（阈值 2000ms） | 通过 |

## 4. 配置与限额（§4，0.2.1：4 项）

| 规格点 | 实现 | 用例/证据 | 状态 |
|---|---|---|---|
| 4 限额校验（正整数 + fail loud） | `src/domain/config.ts`、`src/shared.ts` | `test/domain/config.test.ts`（15）、`test/domain/f31-codes.test.ts` | 通过 |
| 真实链路 4 类限额逐字 | daemon 装配（userConfig/env） | `scripts/e2e/s4-limits.mjs`：maxMembers/maxTasks/maxMessageBytes/wait 边界，逐字错误 | 通过（UI 截图转用户清单） |

## 5. 花名册（§5）

| 规格点 | 实现 | 用例/证据 | 状态 |
|---|---|---|---|
| 命名规则/重名 | `src/domain/roster.ts` | `test/domain/roster.test.ts` | 通过 |
| 成员资格解析（fail-closed） | `src/mcp/identity.ts`、`src/domain/projection.ts` | `test/mcp/identity.test.ts`、`test/domain/invariant.test.ts` | 通过 |
| spawnTeammate 全流程（供给/首轮/落定） | `src/provider/resume-provider.ts`、`src/domain/roster.ts` | e2e S1（真模型：2 fresh + 产物）、S2（fork）；`test/provider/resume-provider.test.ts` | 通过 |
| 恢复对账 reconcileProvisioning | `src/provider/resume-provider.ts`（readProvisioningRecord/adoptOrphans） | `test/provider/resume-provider.test.ts`、S3 takeover/crash 点 | 通过 |
| listMembers（MEMBER_VIEW） | `src/domain/roster.ts` | `test/domain/roster.test.ts`、S1 list_agents | 通过 |
| interrupt（Lead-only；interrupt=false 不注册 D3） | `src/domain/roster.ts`、`src/mcp/registry.ts` | `test/domain/roster.test.ts`、`test/mcp/tools-snapshot.test.ts`、S1/S6 相关 | 通过 |

## 6. 消息投递（§6）

| 规格点 | 实现 | 用例/证据 | 状态 |
|---|---|---|---|
| 恰一次 / pending 落盘先于投递 | `src/domain/mailbox.ts`、`src/coord/journal.ts` | `test/domain/mailbox.test.ts`、S3 delivered 崩溃点、S5 delivered=queued（50） | 通过 |
| send 全流程（含三态 accepted/pending/rejected） | `src/domain/mailbox.ts` | `test/domain/mailbox.test.ts`、`test/audit-fixes.test.ts` | 通过 |
| 投递 dispatch（Lead steer / 运行中 queued / 冷恢复 / 去重） | `src/domain/mailbox.ts`、`src/provider/resume-provider.ts` | S3、S5、S6；`scripts/perf-baseline.mjs`（三态延迟） | 通过 |
| 框架头逐字、无 messageId（D1） | `src/domain/mailbox.ts#frameMessage` | `scripts/text-audit.mjs`（框架头 + 无 id）、S6（发送者/内容边界） | 通过 |
| pending 补投扫描（瞬时失败不永久滞留） | `src/coord/host.ts#startDeliverySweep` | S5（50 条全部 delivered）、`test/coord/integration/host-message-limit.test.ts` | 通过（Round-2 新增） |

## 7. 共享任务板（§7）

| 规格点 | 实现 | 用例/证据 | 状态 |
|---|---|---|---|
| 标识/上限/tombstone 不占限额 | `src/domain/taskboard.ts` | `test/domain/taskboard.test.ts` | 通过 |
| create（依赖/写域校验） | `src/domain/taskboard.ts`、`src/domain/task-graph.ts` | `test/domain/taskboard.test.ts`、`test/domain/task-graph.test.ts`、S1（3 任务 + 依赖） | 通过 |
| update CAS 状态机（8 action） | `src/domain/taskboard.ts` | `test/domain/taskboard.test.ts`、S5（20 轮 3 成员并发 CAS） | 通过 |
| 全图依赖校验（环/自依赖/缺失） | `src/domain/task-graph.ts` | `test/domain/task-graph.test.ts`（12） | 通过 |
| writeScopes 归一/警告 | `src/domain/task-view.ts` | `test/domain/task-view.test.ts` | 通过 |
| list/get/cursor/limit | `src/domain/taskboard.ts` | `test/domain/taskboard.test.ts`、S1/S5 | 通过 |

## 8. 等待与活动信号（§8）

| 规格点 | 实现 | 用例/证据 | 状态 |
|---|---|---|---|
| waitForChange、noProgress 快捷（逐字） | `src/domain/activity.ts`、`src/mcp/policy.ts` | `test/domain/activity-lifecycle.test.ts`、S1（wait 返回）、`scripts/text-audit.mjs`（noProgress 逐字） | 通过 |
| 取消（AbortSignal）与超时边界 | `src/domain/activity.ts`、`src/coord/methods.ts` | `test/domain/activity-lifecycle.test.ts`、S4（wait 边界） | 通过 |
| progress 保活（≤10s） | `src/mcp/backend.ts#withKeepAlive` | `test/mcp/wait-keepalive.test.ts` | 通过 |
| wait 唤醒延迟 ≤1s | — | `scripts/perf-baseline.mjs`：11ms | 通过 |

## 9. 模型工具面（§9，10 个工具〔stage-8 修订 2026-10-24：9 → 10〕）

| 规格点 | 实现 | 用例/证据 | 状态 |
|---|---|---|---|
| 注册与作用域（app-only team_panel_call；team_ping 默认隐藏 D22） | `src/daemon.ts`、`src/mcp/registry.ts` | `test/mcp/tools-snapshot.test.ts`（wire 恰 9）、`test/mcp/policy-injection.test.ts` | 通过（0.4.0 口径） |
| team:policy 全文（0.2.1 换版；D4/D5/D7） | `src/mcp/policy.ts` | `scripts/text-audit.mjs`（23 项全绿；含 D26 编排段） | 通过 |
| 9 工具 schema/逐字参数/错误 | `src/mcp/handlers.ts`、`src/mcp/registry.ts`、`src/mcp/tools.ts` | `test/mcp/f07-codes.test.ts`、S1/S4/S5 | 通过（0.4.0 口径） |
| MEMBER_VIEW / TASK_VIEW 字段 | `src/domain/roster.ts`、`src/domain/task-view.ts`、`src/provider/resume-provider.ts#modelOf` | `test/domain/roster.test.ts`（27）、`test/domain/task-view.test.ts`、`test/provider/resume-provider.test.ts`（modelOf/leadModelOf） | 通过 |
| §9.3 spawn 的 model/thoughtLevel | —— | —— | **注销（0.4.0）**：成员模型唯一路线 = 每轮跟随 Lead；F34 原文见 §18 |
| §9.13 member_set_model | —— | —— | **注销（0.4.0）**：F35/F37 原文见 §18 |
| send 结果 {sent:true}（D1，不暴露 messageId） | `src/mcp/backend.ts` | `test/mcp/tools-snapshot.test.ts`、S1/S5 | 通过 |
| identity 两分支（D2，hook 同层注入） | `src/mcp/policy.ts`、`src/hooks.ts` | `scripts/text-audit.mjs`、S2（无身份前缀）、S6（SessionStart 注入） | 通过 |

## 10. Web UI（§10）

| 规格点 | 实现 | 用例/证据 | 状态 |
|---|---|---|---|
| 挂载/数据源（resources/subscribe → team://view） | `src/daemon.ts`、`src/panel/main.ts` | `test/panel/view-service.test.ts`、`test/ui-core/widget.test.ts` | 通过 |
| 触发器交互（hover 150/pin/Escape/外点/锚定/紧凑） | `src/panel/companion-main.ts` | `scripts/f10-companion.mjs`（17 项全绿，含快速切成员） | 通过 |
| 通知条/花名册/任务板（只读；D21 静态卡片 inactive） | `src/ui-core/render.ts`、`src/ui-core/detail-render.ts` | `test/ui-core/render.test.ts`（26）、视觉回归 76 基线 | 通过（0.4.0：齿轮/弹窗下线） |
| 文案词典 25 键（zh/en 一致，无 status.deleted） | `src/ui-core/dict.ts` | `scripts/text-audit.mjs` | 通过 |
| 成员会话查看视图 detail（分页/三态/复制 id；〔0.3.2·二次〕按轮摘要唯一形态、toolGroup、sourceTotal） | `src/panel/detail.ts`、`src/ui-core/detail-render.ts`、`src/panel/main.ts`、`src/panel/companion-main.ts`、`src/cli/ui.ts` | `test/panel/detail.test.ts`（24）、`test/ui-core/detail-render.test.ts`（25）、`test/cli`（transcript 摘要对等、无 `--mode`）、f10 快速切成员、视觉回归 detail 3 组 12 页 | 通过 |
| §10.5 成员设置齿轮 | —— | —— | **注销（0.4.0）**：F36 原文见 §18；render 测试保留反向断言（任何路径不输出齿轮/member-card） |
| §10.1/§10.6 面板受控变更例外（modelOptions/setMemberModel） | —— | —— | **注销（0.4.0）**：面板恢复零变更通道；F36 原文见 §18 |
| §10.7 MEMBER_SETTINGS_DICT 独立命名空间 | —— | —— | **注销（0.4.0）**：弹窗词典随模块下线；25 键 DICT 不变 |

## 11. 错误码总表（§11，27 个）

| 规格点 | 实现 | 用例/证据 | 状态 |
|---|---|---|---|
| 27 码集合（删 TEAM_MAILBOX_FULL） | `src/domain/errors.ts` | `scripts/text-audit.mjs`（27 + 目录模板）、`test/domain/errors.test.ts` | 通过 |
| 27 码逐条触发 | `src/domain/**`、`src/coord/**` | `test/domain/f31-codes.test.ts`（12 条代表）、`test/audit-fixes.test.ts`；S3/S4/S5 真实链路子集 | 通过（全 27 码逐条清单见 stage-3 F31 记录） |
| TeamError code 透传（RPC/工具面） | `src/coord/rpc.ts`、`src/mcp/results.ts` | `test/coord/unit-rpc.test.ts`、S4 | 通过 |

## 12. 处置（Disposal）语义（§12）

| 规格点 | 实现 | 用例/证据 | 状态 |
|---|---|---|---|
| 触发点① SIGINT 轻量落盘；② 冷启动对账（D9） | `src/daemon.ts`、`src/coord/host.ts`、`src/provider/resume-provider.ts#adoptOrphans` | `test/coord/integration/crash-matrix.test.ts`（C2/C4）、S3、`scripts/upgrade-drill.mjs` | 通过 |
| drain 策略（keep/kill）与轮次进程独立进程组 | `src/provider/resume-provider.ts`、`src/provider/procgroup.ts` | `test/provider/provider-branches*.test.ts`、C1/C4/C5 | 通过 |
| 崩溃恢复「不丢/不重/状态连续」 | journal + replay | S3（17 点矩阵） | 通过 |

## 13. 模型体验（§13）

| 规格点 | 实现 | 用例/证据 | 状态 |
|---|---|---|---|
| 策略/身份/工具描述三层注入、模型可读 | `src/mcp/policy.ts`、`skills/team-coordination/SKILL.md`、`src/mcp/tools.ts` | `scripts/text-audit.mjs`、S1（Lead 汇总）、S6（注入文本可辨） | 通过 |
| 无 ID 的框架头、无探针污染（默认） | `src/domain/mailbox.ts`、`src/mcp/policy.ts` | text-audit（默认无探针；`TEAM_POLICY_PROBE=1` 才出现） | 通过 |

## 14. 已知限制（§14，非目标）

| 规格点 | 处理 | 理由 |
|---|---|---|
| 无 SessionEnd hook → 处置降级 | D9：SIGINT 尽力 + 冷启动对账 | 宿主能力差异，已登记 |
| 无常驻协调者（30s 回收） | 瞬时协调者 + 锁 + 全量重放常态 | D8；H10 实测 |
| ::visualize 仅桌面门控 | CLI 走 `/team` + team-ctl | D4（补充核查） |
| 无 steer 原语 → hook 边界投递 | Stop/UPS/SessionStart 三通道 | D2/D12；S6 矩阵 |

## 15. 20 处逐字/行为抽查

| # | 细节 | 期望 | 证据 |
|---|---|---|---|
| 1 | 策略首段 | `Agent Teams is available in this session` | text-audit #1 |
| 2 | 策略段落数 | 4 段（空行分隔） | text-audit #2 |
| 3 | D7 替换句 | 新句在场、旧句不在 | text-audit #3 |
| 4 | interrupt=false | 策略不含 `interrupt_agent` | text-audit #4 |
| 5 | send 语义句 | "does not mean the recipient has processed it." | text-audit #5 |
| 6 | Lead identity | 逐字三行 | text-audit #6 |
| 7 | teammate identity | name 替换 + lead 行 | text-audit #7 |
| 8 | 默认无探针 | 不含 quartz-ember-73 | text-audit #8 |
| 9 | 探针开关 | `TEAM_POLICY_PROBE=1` 才出现 | text-audit #9 |
| 10 | 框架头 | `Team message from <name>:`，无 id | text-audit #10 |
| 11 | noProgress | reason=no-active-peer + 逐字 message | text-audit #11 |
| 12 | 错误码数量 | 27，无 TEAM_MAILBOX_FULL | text-audit #12 |
| 13 | 词典键数 | 25，zh/en 一致 | text-audit #13 |
| 14 | 词典无 status.deleted | 键集不含 | text-audit #14 |
| 15 | team_ping 默认不可见 | wire 10 工具无 team_ping | `test/mcp/tools-snapshot.test.ts` |
| 16 | 工具错误格式 | `{"error":{"code","message"}}` + isError | `test/mcp/f07-codes.test.ts`、S4 |
| 17 | CAS 失败码 | TEAM_TASK_STALE_REVISION / ALREADY_CLAIMED | S5（20 轮） |
| 18 | fork 注入 | `[Agent Teams fork context]` + Lead 转录 + 任务在尾 | S2（真模型） |
| 19 | wait 被唤醒 | timedOut=false（变化触发） | S1 / perf 11ms |
| 20 | hook 三通道 | stop 3 次后 UPS/SessionStart 接力、回执恰一次 | S6（10 项） |
| 21 | D26 编排段 | orchestrator 注入含段且禁 interrupt_agent；collaborator/两参缺省不含段 | `scripts/text-audit.mjs`（D26 项）+ `test/mcp/policy-injection.test.ts` |
| 22 | 工具面 9 个（0.4.0） | wire 清单逐字节 = 期望 JSON（无 team_ping；无 member_set_model；spawn 无模型参数） | `test/mcp/tools-snapshot.test.ts` |
| 23 | 模型目录脱敏（内部；0.4.0 起 `team://models` 资源已下线） | provider 读目录输出无 `apiKey`/`baseURL`/凭据值；mtime 缓存 | `test/provider/model-catalog.test.ts`；`test/mcp/tools-snapshot.test.ts`（资源面反向断言：无 team://models） |
| 24 | 成员无配置入口（0.4.0 反向） | 全部渲染路径无 `data-member-gear`/`.member-card`/弹窗节点 | `test/ui-core/render.test.ts`、`scripts/visual-regress.mjs`（gearCount=0 全页断言） |
| 25 | 零凭据输入（全页面） | 全 76 页无 `input[type=password]`/`textarea`/凭据字段 | `scripts/visual-regress.mjs` |

## 16. 不适用项与理由

| 规格点 | 结论 | 理由 |
|---|---|---|
| DSH 四包 `cordis.patch.yml` 组合 | 不适用 | ZCode 插件以 `.zcode-plugin/plugin.json` 单包承载；D1 登记 |
| `team:policy` 作为 system prompt 节 | 等价承载 | ZCode 无 system prompt 注入面 → SessionStart hook additionalContext（D10） |
| Lead 消息进程内 steer | 等价承载 | 宿主无 steer 原语 → hook 三通道（D2/D12）；`steerLead` 在 Lead 同进程时可用 |
| 原版 SessionEnd 处置 | 不适用 | ZCode 无该 hook → D9 |
| 图标/市场元数据 | 不适用（本阶段） | stage-7 发布工作，本阶段不做 |

## 17. 覆盖率结论

- 02 规格 §1–§14 全部有映射（含子节）；不适用项 5 条均给出理由。
- 27 错误码、4 限额、25 词典键、4 事件类型在自动化审计中逐字核对；工具面 0.4.0 起 = 9（§18/§19 记录增删演变）。
- 偏差登记：D1–D27（D19–D25 见 04；D26/D27 见 stage-6.5）；stage-8 适配登记见 §18；0.4.0 收敛注销见 §19。

## 18. stage-8 模型可配置化（2026-10-24；F33–F36）

规格增补：§9.3（spawn +model/thoughtLevel）、§9.4（model 字段语义）、§9.13（member_set_model）、§10.1/§10.6（面板受控变更例外）、§10.5（齿轮）、§10.7（MEMBER_SETTINGS_DICT）。

| 编号 | 规格点 | 实现 | 测试/证据 | 状态 |
|---|---|---|---|---|
| F33 | **teammate 默认继承 Lead 模型+思考强度** | `src/provider/model-selection.ts`（新：三元组/`parseModelSpec`/形状校验）；`src/provider/transcript.ts#latestModelSelection`（`session_entry` 权威条目）+`#latestModelUsage`（`model_usage` 兜底）；`src/provider/session-breeder.ts`（同实例 `session/setModel`，失败容忍）；`src/provider/resume-provider.ts`（继承链、`origin.modelSelection`/`modelSource`、`modelOf` 回退、`leadModelOf`）；`src/domain/roster.ts`（Lead 伪行实查优先） | `test/provider/session-isolation.test.ts`（8：显式/继承条目/usage 兜底/无条目/legacy 不应用五态）、`test/provider/model-selection.test.ts`（10）、`test/provider/transcript.test.ts`（7：嵌套优先/平铺兼容/坏行/最新胜/variant）、`test/provider/session-breeder.test.ts`（22：setModel 参数形状/失败容忍/不落 result）、`test/provider/resume-provider.test.ts`（20：modelOf 三层回退+leadModelOf）、`test/domain/roster.test.ts`（27：Lead 行） | 通过 |
| F34 | **spawn 的 model/thoughtLevel + 裸 id 消歧** | `src/mcp/tools.ts`（schema/描述逐字）；`src/mcp/handlers.ts`（转发）；`src/mcp/backend.ts#resolveModelArgs`（`providerId$modelId`/裸 id：Lead 当前 provider → 唯一 enabled → 歧义列候选；目录不可用报错；thoughtLevel 按 variants 校验） | `test/mcp/model-tools.test.ts`（17）、`test/mcp/tools-snapshot.test.ts`（5，F01 逐字节 10 工具）、`test/coord/integration/host-methods.test.ts`（method 表 14） | 通过 |
| F35 | **member_set_model + mid-life + team://models（脱敏目录）** | `src/coord/methods.ts`（`member.set_model`，60s）、`src/provider/session-breeder.ts#applyModelSelection`（临时实例 `session/resume`→`session/setModel`）、`src/provider/resume-provider.ts#setMemberModel`（now/next-turn/pending 兜底）、`src/provider/member-files.ts`（`model-pending.json`）、`src/provider/model-catalog.ts`（白名单投影+mtime 缓存）、`src/daemon.ts`（`RESOURCES`+read 分支） | `test/provider/member-set-model.test.ts`（9：now/next-turn/未落定/即时失败/pending 三例）、`test/provider/model-catalog.test.ts`（8：脱敏/容错/缓存）、`test/provider/session-breeder.test.ts`（22，含 apply 三例）、`test/mcp/tools-snapshot.test.ts`（team://models 资源契约：无 apiKey/baseURL/options）、`test/mcp/model-tools.test.ts` | 通过 |
| F36 | **面板齿轮 + 弹窗 + 高级模式（含规格例外）** | `src/ui-core/icons.ts#iconGear`、`src/ui-core/render.ts`（member-card/齿轮/选项门控）、`src/ui-core/member-settings.ts`（新：弹窗+MEMBER_SETTINGS_DICT+联动）、`src/ui-core/css.ts`、`src/ui-core/escape.ts`（新，防循环引用）、`src/panel/panel-call.ts`（modelOptions/modelSet）、`src/panel/main.ts`（齿轮点击/状态机/ESC/遮罩）、`src/daemon.ts`（schema+两分支） | `test/ui-core/member-settings.test.ts`（22：四来源/optgroup/无 reasoning/零凭据/联动）、`test/ui-core/render.test.ts`（29，齿轮 4 例）、`test/ui-core/dict.test.ts`（15，命名空间隔离）、`test/panel/member-model-call.test.ts`（15）、`scripts/visual-regress.mjs` 80 基线（齿轮几何/弹窗控件/零凭据输入） | 通过（桌面实录待内测） |
| F37 | **设置失败可见性（GitHub #6；§9.13 failed 语义 + §10.7 30 键修订）** | `src/coord/methods.ts`（`applied:"failed"`+reason 终态）、`src/provider/resume-provider.ts`（失败不落 pending/前置应用失败终态/`diagnosticsOf`/spawn 降级与显式失败落盘/成功清除）、`src/provider/member-files.ts`（`model-failed.json` 读写）、`src/domain/roster.ts`（presentation 诊断追加）、`src/panel/panel-call.ts`（`current.failedApply`）、`src/ui-core/member-settings.ts`（`settings.failedApply` 常驻错误提示）、`src/mcp/tools.ts`+`test/mcp/expected-tools.ts`（描述补失败语义，F01 双源） | `test/provider/member-set-model.test.ts`（9→14）、`test/panel/member-model-call.test.ts`（+3）、`test/mcp/model-tools.test.ts`（+1）、`test/ui-core/member-settings.test.ts`（+1）、`test/coord/integration/host-methods.test.ts`（+1）、`test/domain/roster.test.ts`（+2）、`test/provider/session-isolation.test.ts`（+1）；真模型 E2E 失败路径四断言（e2e6/6b/6c/6d，`stage-8-model-config/e2e-real-model-evidence.json`） | 通过（v0.3.1，issue #6 已关闭附验证评论） |
| F38 | **第三方模型继承精化（0.3.2 分类优先）**：继承链 [session_entry → model_usage] 按目录过滤（新导出 `catalogSupports` 为唯一判据：provider+model 存在且均 enabled）；官方套餐（account:/builtin:）零 setModel 尝试直接回退宿主缺省；空目录守卫（目录不可读不过滤）；跳过仍写 model-failed（套餐/目录外两态文案）；显式通道与尝试失败路径不变 | `src/provider/model-catalog.ts#catalogSupports`、`src/provider/resume-provider.ts#lookupLeadModelSelections`（过滤+守卫）与 startContinuable（跳过分支+两态文案）、`README.md` §2.1 继承边界声明、`docs/使用手册.md` §2.1 同口径 | `test/provider/model-catalog.test.ts`（catalogSupports 五态）、`test/provider/session-isolation.test.ts`（32 it：分类五态/空目录守卫/显式不变/既有重写）；真模型 E2E qwen3.8-flash+max 双源 + 套餐零尝试（stage-8-model-config/e2e-real-model-evidence.json） | 通过（v0.3.2）；**部分被 0.4.0 取代（§19 F39）** |

## 19. 0.4.0 成员模型收敛（2026-10-25；F39）

决策（用户拍板）：全部收敛于「成员每轮执行前自动跟随 Lead 最新已确认模型」一条路线；**注销** §9.3 spawn 模型参数（F34）、§9.13 member_set_model（F35/F37 对话通道部分）、§10.1/§10.5/§10.6/§10.7 齿轮+弹窗+面板受控变更例外（F36），并下线 `team://models` 资源。§18 历史台账逐行保留（原文可考），下表登记替代关系。

| 编号 | 规格点 | 实现 | 测试/证据 | 状态 |
|---|---|---|---|---|
| F39 | **继承跟随 Lead（三源判定 + 每轮执行前同步 + 失败即报）**：Lead 模型解析 = [提交快照（real_user 消息 modelSelection，宿主保存消息时写入）/ session_entry（`/model` 刷新）/ main_turn 实际调用（`query_source='main_turn'` 严格排除 compact/标题/subagent/workflow 辅助行）] 三路按时间戳取最新（修 0.3.2 固定优先级 + 实证 issue #7 场景可跟上）；分类判据沿用 `catalogSupports`（空目录守卫保留）；解析不出/官方套餐/目录外 = spawn 与每轮同步抛 `ModelInheritanceError`（明确报告用户，绝不静默回退宿主缺省冒充继承成功；createChild 失败同样抛+回收）；同步点 = launchTurn 执行前统一入口（首轮/续跑/恢复三路共用，有变化才发 setModel）；origin 唯一记 `modelSource:"inherited"`（explicit 面注销）；model-pending.json 机器与 mid-life 通道删除；`model-failed.json`/`diagnosticsOf` 成员行诊断保留（继承失败兜底可见） | `src/provider/model-inheritance.ts`（新错误类型）、`transcript.ts#latestSubmissionSelection/#latestModelSelectionTimed/#latestMainTurnUsage`（三源）、`resume-provider.ts#resolveLeadInheritance/#syncMemberModel`（判定+每轮同步）、`session-breeder.ts`（createChild model-rejected 即抛、applyModelSelection 改每轮同步通道）、`mcp/tools.ts`+`expected-tools.ts`（F01 双源 9 工具）、`coord/methods.ts`（方法表 13）、`panel/panel-call.ts`+`daemon.ts`（面板两 action 与资源下线） | `test/provider/session-isolation.test.ts`（17 it：三源各路/陈旧条目→提交胜/`/model`→条目胜/main_turn 过滤辅助/套餐与目录外与无记录三抛/空目录守卫/每轮同步成功与阻止/套餐切换阻止/legacy 不应用）、`session-breeder.test.ts`（模型三例新语义：成功/失败即抛不落 result/anchor tombstone）、`tools-snapshot.test.ts`（9 工具逐字节 + spawn 无模型参数 + resources 面反向断言）、`host-methods.test.ts`（13 方法 + set_model 未知方法）、`render.test.ts`（齿轮反向）；`kit.ts` 三源夹具（query_source 列 + 提交快照插入器）；787/787 全绿 + 视觉 76 基线 + smoke | 通过 |


## 20. 0.4.1 成员模型自动跟随修复轮（2026-10-26；F40）

0.4.0 验收发现的 5 个问题全部关闭（修复规划 `.zcode/plans/plan-session_e114ea4524b05a742bc25d4cd08ba7c1.md`）。无契约/工具面变更（仍 9 工具、13 方法）；无新配置文件/数据表/后台服务（重试控制复用 `model-failed.json` 失败记录，展示刷新复用 roster 状态通知）。

| 编号 | 修复点 | 实现 | 测试/证据 | 状态 |
|---|---|---|---|---|
| F40a | **一致性判断以宿主实际状态为准**：`syncMemberModel` 比对源 = 成员会话 `session_entry` → `main_turn usage` 实查（origin 降为辅助记录，不凭 origin 相同放行）；实际状态无法确认时重新应用 Lead 选择；确认一致时顺带修复落后的 origin；仅档位变化同样识别同步；首轮 createChild 已定模 → launchTurn 跳过（`modelJustApplied`，零冗余 setModel） | `resume-provider.ts#syncMemberModel/#launchTurn` | `session-isolation.test.ts`：origin=A宿主=B→先同步再启动 / setModel后origin前崩溃→恢复按宿主判断零RPC+origin修复 / 仅档位变化同步 / 首轮零apply；E2E v6 E1 | 通过 |
| F40b | **失败可见性 + 重试控制**：解析失败与应用失败统一落 `model-failed.json`（+kind/attempts/nextAttemptAt/leadSignature/messageIds）；确定性拒绝（套餐/目录外/明确不支持）暂停相同选择自动重试，临时故障（timeout/spawn/ENOENT/app-server 未就绪等）5s/15s/30s 退避≤3 次；Lead 换模或新消息解锁；拦截 = `ModelSyncSuppressedError` → deliver 按 queued 滞留（消息保留不误标）；失败记录变化经 `bind(onModelFailureChanged)` → `roster.notifyStatusChanged` 立即刷新成员展示 | `member-files.ts#ModelFailedRecord` 扩展、`model-inheritance.ts#ModelSyncSuppressedError/classifyApplyFailure/classifySelectionFailure/selectionSignature`、`resume-provider.ts#retryGate/#recordModelFailure/#deliver(catch)`、`coord/host.ts`（bind 接线） | `session-isolation.test.ts`：确定性拒绝 6s 内仅 1 次尝试（3 次 sweep 全拦截）/ 临时故障退避到期放行-耗尽停止 / 换回模型恢复交付恰一次 / 新消息解锁 / 套餐切换消息滞留+诊断可见；host 装配全路径（运行中排队→边界补投失败→扫描抑制→恢复交付）；`model-inheritance.test.ts`（6 纯函数）；E2E v6 E5/E6 | 通过 |
| F40c | **创建前校验移到成员登记之前**：provider 新增 `preflightMemberModel()`（child 模式解析+分类校验，零副作用）；roster `spawnInner` 在 provisioning 事件前调用——不可继承时不增加成员、不占名、不建隐藏子会话，修正后原名可重用；供给阶段复检保留（漂移防御） | `model-inheritance.ts#ModelPreflight/providerHasModelPreflight`、`resume-provider.ts#preflightMemberModel`、`domain/roster.ts`（步骤 1b）、`mock-provider.ts`（preflightError 注入桩） | `roster.test.ts`（预检失败零成员零占用+修正后原名可建+顺序不变）、`mcp/contract.test.ts`（MCP→backend→roster 全链路：错误透出/list_agents 不含/名字未占用）、`session-isolation.test.ts`（preflight 三态：套餐抛/可继承过/legacy 恒过）；E2E v5 既有 E3 语义不变 | 通过 |
| F40d | **旧失败提示按验证成功清除**：宿主实际状态确认一致（零 setModel）或应用成功 → `clearFailureIfVerified`（删除+展示刷新）；未恢复成功（闸拦截中）提示保留 | `resume-provider.ts#clearFailureIfVerified/#diagnosticsOf`（kind/attempts 呈现） | `session-isolation.test.ts`：失败→切回一致→续跑成功旧文件与诊断消失零额外 setModel / 未恢复时提示保留 | 通过 |
| F40e | **回归与覆盖率**：全路径用例（MCP→backend→roster 创建失败；运行中排队→边界补投失败→定时扫描抑制；宿主已提交 origin 未更新恢复盘面；失败后切回原模型续跑）；覆盖率 branches 83.25→**85.12%**（门槛达标）、statements 91.62/functions 92.56/lines 93.40；787→**840**（72 文件两轮稳定）；视觉 76 零漂移；伴生 17 项；smoke/validate/text-audit 全绿 | 上列全部 + `transcript.test.ts`（三源探针防御分支）、`mock-provider-units.test.ts`、`format.test.ts`/`main-entry.test.ts`/`view-service.test.ts`（CLI/面板分支补强） | 真模型 E2E v6（`stage-8-model-config/e2e-real-model-041.mjs`）六场景 ALL_PASS：E1 创建继承真实调用=flash+max / E2 提交切 max 跟随 / E3 `/model` 切回 flash 跟随 / E4 daemon 重启恢复团队后跟随最新 / E5 套餐阻止+诊断+滞留+9s 抑制 / E6 切回恢复交付恰一次+失败记录清除+诊断消失；终检成员真实调用 provider 仅 qwen（零 deepseek）；判定以宿主 `model_usage`/`session_entry`/成员会话落库文本为准 | 通过 |
