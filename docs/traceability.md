# 《02 规格》→ 实现/测试/证据 追溯矩阵（SF09）

> 对照源：`zcode-agent-team-plan/stage-0-research/02-AgentTeam插件全量功能规格.md`（对齐轮修订版）
> ＋ `stage-0-research/06-基准升版-0.2.1-alpha.5.md`（冻结包 06，2026-10-17 基准）。
> 口径：每节至少一个用例/脚本或「不适用 + 理由」；「通过」= 自动化用例或 e2e 证据可复核。
> 偏差编号引用 `zcode-agent-team-plan/stage-0-research/04-能力映射与差距分析.md`（D1–D25，D19–D25 为本轮新增）。
> 文档更新时间：2026-10-24（stage-8 Round E-2 文档回写）。

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
| 注册与作用域（app-only team_panel_call；team_ping 默认隐藏 D22） | `src/daemon.ts`、`src/mcp/registry.ts` | `test/mcp/tools-snapshot.test.ts`（wire 恰 10）、`test/mcp/policy-injection.test.ts` | 通过 |
| team:policy 全文（0.2.1 换版；D4/D5/D7） | `src/mcp/policy.ts` | `scripts/text-audit.mjs`（23 项全绿；含 D26 编排段） | 通过 |
| 10 工具 schema/逐字参数/错误 | `src/mcp/handlers.ts`、`src/mcp/registry.ts`、`src/mcp/tools.ts` | `test/mcp/model-tools.test.ts`（17）、`test/mcp/f07-codes.test.ts`、S1/S4/S5 | 通过 |
| MEMBER_VIEW / TASK_VIEW 字段 | `src/domain/roster.ts`、`src/domain/task-view.ts`、`src/provider/resume-provider.ts#modelOf` | `test/domain/roster.test.ts`（27）、`test/domain/task-view.test.ts`、`test/provider/resume-provider.test.ts`（modelOf/leadModelOf） | 通过 |
| §9.3 spawn 的 model/thoughtLevel（裸 id 消歧；thoughtLevel variants 校验） | `src/mcp/backend.ts#resolveModelArgs`、`src/mcp/tools.ts` | `test/mcp/model-tools.test.ts`（消歧三态/目录不可用/无 reasoning）、`test/mcp/tools-snapshot.test.ts` | 通过 |
| §9.13 member_set_model（Lead-only/active 目标/三态） | `src/mcp/handlers.ts`、`src/mcp/backend.ts#setMemberModel`、`src/coord/methods.ts`、`src/provider/resume-provider.ts#setMemberModel` | `test/mcp/model-tools.test.ts`、`test/coord/integration/host-methods.test.ts`（member.set_model 五分支）、`test/provider/member-set-model.test.ts`（9） | 通过 |
| send 结果 {sent:true}（D1，不暴露 messageId） | `src/mcp/backend.ts` | `test/mcp/tools-snapshot.test.ts`、S1/S5 | 通过 |
| identity 两分支（D2，hook 同层注入） | `src/mcp/policy.ts`、`src/hooks.ts` | `scripts/text-audit.mjs`、S2（无身份前缀）、S6（SessionStart 注入） | 通过 |

## 10. Web UI（§10）

| 规格点 | 实现 | 用例/证据 | 状态 |
|---|---|---|---|
| 挂载/数据源（resources/subscribe → team://view） | `src/daemon.ts`、`src/panel/main.ts` | `test/panel/view-service.test.ts`、`test/ui-core/widget.test.ts` | 通过 |
| 触发器交互（hover 150/pin/Escape/外点/锚定/紧凑） | `src/panel/companion-main.ts` | `scripts/f10-companion.mjs`（17 项全绿，含快速切成员） | 通过 |
| 通知条/花名册/任务板（只读；D21 静态卡片 inactive） | `src/ui-core/render.ts`、`src/ui-core/detail-render.ts` | `test/ui-core/render.test.ts`（29）、视觉回归 76 基线 | 通过 |
| 文案词典 25 键（zh/en 一致，无 status.deleted） | `src/ui-core/dict.ts` | `scripts/text-audit.mjs` | 通过 |
| 成员会话查看视图 detail（分页/三态/复制 id） | `src/panel/detail.ts`、`src/ui-core/detail-render.ts` | `test/panel/detail.test.ts`（16）、`test/ui-core/detail-render.test.ts`（17）、f10 快速切成员 | 通过 |
| §10.5 成员设置齿轮（仅 teammate / 仅面板载体；不嵌套 button） | `src/ui-core/render.ts#renderMember`、`src/panel/main.ts` | `test/ui-core/render.test.ts`（齿轮 4 例）、`scripts/visual-regress.mjs`（齿轮几何断言） | 通过 |
| §10.1/§10.6 面板受控变更例外（modelOptions/setMemberModel） | `src/panel/panel-call.ts`、`src/daemon.ts`、`src/panel/main.ts` | `test/panel/member-model-call.test.ts`（15）、`scripts/smoke-daemon.mjs` | 通过（规格例外 F36；桌面实录待内测） |
| §10.7 MEMBER_SETTINGS_DICT 独立命名空间（29 键，settings.*） | `src/ui-core/member-settings.ts` | `test/ui-core/member-settings.test.ts`（22）、`test/ui-core/dict.test.ts`（14，含与 25 键零交集）、`scripts/text-audit.mjs` | 通过 |

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
| 22 | 工具面 10 个 | wire 清单逐字节 = 期望 JSON（无 team_ping；含 member_set_model） | `test/mcp/tools-snapshot.test.ts` |
| 23 | team://models 脱敏 | 输出无 `apiKey`/`baseURL`/`options` 与占位凭据值；重复读命中 mtime 缓存 | `test/mcp/tools-snapshot.test.ts`、`test/provider/model-catalog.test.ts` |
| 24 | 成员齿轮位置/结构 | 仅 teammate、仅面板载体；22px 命中区、右上 4px、不嵌套 button | `scripts/visual-regress.mjs`、`test/ui-core/render.test.ts` |
| 25 | 弹窗零凭据输入 | 全 76 页无 `input[type=password]`/`textarea`/凭据字段 | `scripts/visual-regress.mjs`、`test/ui-core/member-settings.test.ts` |

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
- 27 错误码、4 限额、10 工具、25 词典键（+29 键独立成员设置命名空间）、4 事件类型在自动化审计中逐字核对。
- 偏差登记：D1–D27（D19–D25 见 04；D26/D27 见 stage-6.5）；stage-8 适配登记见 §18。

## 18. stage-8 模型可配置化（2026-10-24；F33–F36）

规格增补：§9.3（spawn +model/thoughtLevel）、§9.4（model 字段语义）、§9.13（member_set_model）、§10.1/§10.6（面板受控变更例外）、§10.5（齿轮）、§10.7（MEMBER_SETTINGS_DICT）。

| 编号 | 规格点 | 实现 | 测试/证据 | 状态 |
|---|---|---|---|---|
| F33 | **teammate 默认继承 Lead 模型+思考强度** | `src/provider/model-selection.ts`（新：三元组/`parseModelSpec`/形状校验）；`src/provider/transcript.ts#latestModelSelection`（`session_entry` 权威条目）+`#latestModelUsage`（`model_usage` 兜底）；`src/provider/session-breeder.ts`（同实例 `session/setModel`，失败容忍）；`src/provider/resume-provider.ts`（继承链、`origin.modelSelection`/`modelSource`、`modelOf` 回退、`leadModelOf`）；`src/domain/roster.ts`（Lead 伪行实查优先） | `test/provider/session-isolation.test.ts`（8：显式/继承条目/usage 兜底/无条目/legacy 不应用五态）、`test/provider/model-selection.test.ts`（10）、`test/provider/transcript.test.ts`（7：嵌套优先/平铺兼容/坏行/最新胜/variant）、`test/provider/session-breeder.test.ts`（22：setModel 参数形状/失败容忍/不落 result）、`test/provider/resume-provider.test.ts`（20：modelOf 三层回退+leadModelOf）、`test/domain/roster.test.ts`（27：Lead 行） | 通过 |
| F34 | **spawn 的 model/thoughtLevel + 裸 id 消歧** | `src/mcp/tools.ts`（schema/描述逐字）；`src/mcp/handlers.ts`（转发）；`src/mcp/backend.ts#resolveModelArgs`（`providerId$modelId`/裸 id：Lead 当前 provider → 唯一 enabled → 歧义列候选；目录不可用报错；thoughtLevel 按 variants 校验） | `test/mcp/model-tools.test.ts`（17）、`test/mcp/tools-snapshot.test.ts`（5，F01 逐字节 10 工具）、`test/coord/integration/host-methods.test.ts`（method 表 14） | 通过 |
| F35 | **member_set_model + mid-life + team://models（脱敏目录）** | `src/coord/methods.ts`（`member.set_model`，60s）、`src/provider/session-breeder.ts#applyModelSelection`（临时实例 `session/resume`→`session/setModel`）、`src/provider/resume-provider.ts#setMemberModel`（now/next-turn/pending 兜底）、`src/provider/member-files.ts`（`model-pending.json`）、`src/provider/model-catalog.ts`（白名单投影+mtime 缓存）、`src/daemon.ts`（`RESOURCES`+read 分支） | `test/provider/member-set-model.test.ts`（9：now/next-turn/未落定/即时失败/pending 三例）、`test/provider/model-catalog.test.ts`（8：脱敏/容错/缓存）、`test/provider/session-breeder.test.ts`（22，含 apply 三例）、`test/mcp/tools-snapshot.test.ts`（team://models 资源契约：无 apiKey/baseURL/options）、`test/mcp/model-tools.test.ts` | 通过 |
| F36 | **面板齿轮 + 弹窗 + 高级模式（含规格例外）** | `src/ui-core/icons.ts#iconGear`、`src/ui-core/render.ts`（member-card/齿轮/选项门控）、`src/ui-core/member-settings.ts`（新：弹窗+MEMBER_SETTINGS_DICT+联动）、`src/ui-core/css.ts`、`src/ui-core/escape.ts`（新，防循环引用）、`src/panel/panel-call.ts`（modelOptions/modelSet）、`src/panel/main.ts`（齿轮点击/状态机/ESC/遮罩）、`src/daemon.ts`（schema+两分支） | `test/ui-core/member-settings.test.ts`（22：四来源/optgroup/无 reasoning/零凭据/联动）、`test/ui-core/render.test.ts`（29，齿轮 4 例）、`test/ui-core/dict.test.ts`（14，命名空间隔离）、`test/panel/member-model-call.test.ts`（15）、`scripts/visual-regress.mjs` 76 基线（齿轮几何/弹窗控件/零凭据输入） | 通过（桌面实录待内测） |
