# 架构说明（as-built，2026-10-24）

> 本文描述 **0.1.2 发布基线 + stage-8 模型可配置化开发轮**的实际结构（as-built），不是设计稿。规格映射与逐条证据见 `docs/traceability.md`；偏差编号沿用《04-能力映射与差距分析》D1–D27。

## 1. 一图看清

```text
                    ┌──────────────────────────── ZCode 宿主会话 ────────────────────────────┐
                    │                                                                        │
 用户 ──对话──▶ Lead 会话（模型）                                                             │
                    │   ├─ 工具调用（MCP stdio）──▶ team-daemon（每会话按需拉起）             │
                    │   ├─ SessionStart/Stop/UserPromptSubmit hook ──▶ dist/team-hooks.mjs    │
                    │   └─ MCP Apps surface「智能体团队」◀─ ui://agent-team/team-panel.html   │
                    │                                                                        │
                    └───────────────┬────────────────────────────────────────────────────────┘
                                    │ stdio MCP
                    ┌───────────────▼───────────────────┐
                    │ team-daemon                        │
                    │  ├─ MCP server（10 工具 / 9 当        │
                    │  │   interrupt=false）              │
                    │  ├─ 身份解析（_meta.session_id）     │
                    │  ├─ 协调者 host：锁 / 重放 / 恢复对账 │
                    │  ├─ 代理 RPC 客户端（非协调者）       │
                    │  ├─ ResumePerTurnProvider            │
                    │  ├─ 模型目录（team://models，脱敏）   │
                    │  └─ 面板视图服务（帧构建/订阅推送）    │
                    └───────┬───────────────┬────────────┘
                            │               │
         zcode -p --resume  │               │ 文件系统（插件数据目录）
                            ▼               ▼
                teammate 子会话（独立进程组）  teams/<sessionId>/
                （宿主原生隐藏子会话）           events.jsonl / checkpoint.json
                                                coordinator.lock(+hb) / coordinator.sock
                                                members/ / lead/ / ui/ / logs/ / meta/
```

三层职责：

| 层 | 位置 | 职责 |
|---|---|---|
| 域层（纯逻辑，零 IO） | `src/domain/**` | 事件模型、投影、花名册、任务板/DAG、邮箱、生命周期、错误码、限额校验 |
| 协调层（IO 与并发） | `src/coord/**` | journal 追加、重放/checkpoint、瞬时协调者锁、unix socket RPC、单写者纪律、崩溃对账 |
| 宿主适配层 | `src/mcp/**`、`src/provider/**`、`src/panel/**`、`src/ui-core/**`、`src/hooks*`、`src/daemon.ts` | 工具面、身份、策略注入、teammate 进程、面板/卡片渲染、hooks |

## 2. 进程与生命周期

- **daemon**：MCP stdio server，会话按需拉起；宿主空闲 30s 回收是常态（H9/ADR-3）。启动即全量重放日志 + 恢复对账，任何实例都可服务。回收时不杀 teammate 轮次（D17，默认 `keep`）。
- **协调者（瞬时）**：`teams/<id>/coordinator.lock` 独占文件锁选出唯一写者。锁 = owner 文件（O_EXCL，inode+token 永不改写）+ 按 token 分开的心跳文件；心跳 1000ms / 过期 4500ms / 轮询 200ms。协调者死亡 → 心跳过期 → 下一个实例抢占接任（实测 kill -9 → 接任 ≤5s）。非协调者实例经 `coordinator.sock`（NDJSON，0600，路径过长时回退 `/tmp/at-<hash>.sock`）代理写操作。
- **teammate**：`ResumePerTurnProvider` 每轮 `zcode -p --resume <childSession> --json --mode yolo --surface terminal --disallowed-tools Task`，独立进程组；首轮前经 `session-breeder` 用 app-server 创建宿主原生 `selection_side_chat` 隐藏子会话 + anchor tombstone（会话隔离）。进程退出码 + transcript 即完成信号。
- **hooks**：三个合法事件（SessionStart startup/resume、Stop、UserPromptSubmit）；读 stdin 事件 → 写 `logs/hooks.jsonl` → 按角色注入策略/收件箱/Stop block；RPC ack 失败静默（回执文件为权威）。
- **面板**：daemon 内视图服务以 500ms 轮询构帧，`resources/subscribe` 推 `team://view`；面板 25s 心跳 `team_panel_call` 保活 Lead 侧连接；detail 视图按页只读 db.sqlite（按轮摘要：用户指令 + 动作组 + 每轮结论）；`team://models` 按 config.json mtime 缓存返回脱敏模型目录（stage-8）。

## 3. 持久化与一致性

```text
teams/<sessionId>/
  events.jsonl            追加写（O_APPEND，行级原子，fsync）；4 类事件 + 版本 2
  checkpoint.json         重放加速（字节偏移 + 状态快照），每 256 次提交与关闭时落盘
  coordinator.lock        当前写者（pid/bootId/token/acquiredAt）
  coordinator.lock.hb-*   心跳（原子 tmp+rename）
  coordinator.sock        RPC（NDJSON 一请求一响应）
  coordinator.audit.jsonl 锁获取/释放/接任审计
  lead/state.json         Lead 侧轻量状态
  members/<id>/           origin.json（身份/会话/模型选择）、run/turn-*.json（恰一次凭据）、receipts.jsonl、model-pending.json（stage-8 待应用模型）
  ui/view-snapshot.json   最近一帧（面板冷启动回放）
  rpc.token               RPC 鉴权（0600）
```

不变量：追加前按投影校验（schema/version/引用完整性/CAS/DAG）；任何坏行或 seq 断裂 → 重放 **fail-closed**（显式 `failure` 终态，不静默合并）；`delivered ⊆ messages` 恒成立；同一团队单写者（双写者交错会被 seq 连续性拒绝，F32/崩溃矩阵 C5 实证）。

## 4. 关键数据流

1. **spawn**：Lead 调 `spawn_teammate` → 域层校验名额/命名 → 协调者写 `team/member(provisioning)` → **模型选择解析**（显式 `model`/`thoughtLevel` 经目录消歧；缺省继承 Lead 的 `session_entry(runtime/model_selection)` → `model_usage` 兜底）→ 培育隐藏子会话（同实例内 `session/setModel` 落选择；失败只留痕不杀成员）→ 孵化首轮（先落 `run/turn-1.json` 再起进程）→ 轮次结束定案 `active/failed`。
2. **消息**：`send_message` → 目标运行中则 queued（回合边界交付，D2）；空闲则拉起/恢复一轮 → teammate 侧以 `Team message from <name>:` 框架头注入 → 完成回执/transcript 判 delivered（D18）。
3. **任务**：`team_task_*` → CAS（expected_revision）→ 事件追加 → 投影；orchestrator 模式下 Lead 对 completed 任务独立复核：失败 `reopen`、通过 `edit` 追加验收记录（D27）。
4. **策略注入**：SessionStart additionalContext 注入策略全文（D7 替换句、D26 编排段按 leadMode 插值）；UserPromptSubmit 仅在有待收消息时注入收件箱段；skill/工具描述为冗余层。hook 进程读不到 userConfig，经 daemon 落盘 `meta/runtime-config.json` 兜底（D19）。
5. **面板**：视图服务构建帧（身份解析 + 重放 + 活性 + snapshot）→ 订阅推送；无变化不推（contentKey）；detail 只读 db.sqlite + 事件回填框架头；按轮摘要投影在**合成层**完成（投影与分页前），不改 db 查询；全量转录不进视图。
6. **模型设置（stage-8）**：三条写入通路共用 provider 层同一方法——① spawn 参数（首轮前 `session/setModel`）；② 对话工具 `member_set_model` → 方法表 `member.set_model`；③ 面板 `team_panel_call {action:"setMemberModel"}`。mid-life 修改走「临时 app-server 实例 → `session/resume` → `session/setModel`」；目标运行中或即时失败 → `members/<id>/model-pending.json`，下一轮 `launchTurn` 写轮次记录**之前**兜底应用。生效锚点 = 会话库 `session_entry(type='runtime/model_selection')`（headless `--resume` 每轮恢复）。面板 `{action:"modelOptions"}` 读脱敏目录（`~/.zcode/v2/config.json` 白名单投影，apiKey/baseURL 不出 daemon）。

## 5. 模块地图

| 路径 | 内容 |
|---|---|
| `src/domain/` | `events` `projection` `invariant` `roster` `taskboard` `task-graph` `mailbox` `activity` `lifecycle` `config` `errors` `validation` `task-view` `runtime` `ports` |
| `src/coord/` | `journal` `replay` `lock` `lockfile` `rpc` `client` `host` `methods` `paths` `identity` `fscheck` `store-adapter` |
| `src/provider/` | `resume-provider`（ADR-4 主实现）`session-breeder` `procgroup` `transcript`（db 只读）`member-files` `framing` `fork-context` `lead-wake`（D20 灰度）`zcode-bin` `mock-provider` `model-selection`（stage-8：三元组/规格解析）`model-catalog`（stage-8：脱敏目录 + mtime 缓存） |
| `src/mcp/` | `tools`（10 工具定义，唯一真源）`handlers` `registry` `identity` `policy` `results` `backend` |
| `src/hooks*`、`src/hooks/` | hook 入口与纯逻辑（角色解析、pending、Stop 预算、回执） |
| `src/panel/`、`src/ui-core/` | 面板/伴生页/卡片/详情四载体共用渲染层（tokens/dict/render/detail-render/widget；stage-8 +`member-settings` 弹窗与独立字典、`escape` 转义下沉） |
| `src/cli/` | `team-ctl`：state/tail/inject-event/call/transcript/widget/open-panel/sidebar-audit |
| `src/sidebar/` | tasks-index 白名单写入（anchor tombstone / sidebar-audit，D25） |
| `src/daemon.ts`、`src/hooks.ts`、`src/shared.ts` | 进程入口、数据目录/配置/日志、Node 版本自检 |

## 6. 失败与降级

| 场景 | 行为 |
|---|---|
| daemon 空闲回收 | 正常事件；teammate 轮次保留（D17）；下次任一实例重放 + 对账 |
| 协调者 kill -9 | 锁心跳过期 → 接任 ≤5s；缺位窗口返回 `TEAM_DISPOSED` 临时错误，客户端退避重试（D8） |
| 日志坏行 / seq 断裂 | 重放 fail-closed → `failure` 终态；面板/工具显式报错，不猜测 |
| 宿主回收 SIGINT→SIGKILL（~260ms） | 处置只做轻量落盘；孤儿轮次由冷启动 `adoptOrphans` 定案/纳管（D9/D17） |
| db.sqlite 不可读/结构变化 | 只影响 transcript/detail 的会话内容回填与模型继承兜底，不阻塞团队域操作 |
| 模型目录不可读/漂移 | `team://models` 返回 `{providers:[]}` + warn；spawn 仍可用全称 `providerId$modelId`，裸 id 报「目录不可用」 |
| 面板 setModel 失败 | 落 `model-pending.json`，下一轮拉起前重试（返回 `next-turn`）；不阻塞轮次、不改 origin |
| 面板连接失联 | 订阅自动重建；心跳失败静默；模型面工具不受影响 |

## 7. 边界与约束

- 零原生依赖：sqlite 仅用 `node:sqlite` 只读打开；Node ≥ 22。
- 数据目录 0700、文件 0600、socket 0600（SF12 审计通过）。
- 插件只写宿主任务索引的两个白名单点；`db.sqlite` 一律只读（D25）。
- 单包承载（实验/工具/客户端 UI/配置四包合并），偏差 D1；分发形态 = 本地市场 + zip。
