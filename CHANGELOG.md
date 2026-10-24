# Changelog

## 0.2.0 — 2026-10-25

描述：智能体团队：在会话中创建并协调多个 teammate 子会话、共享任务板与成员消息。

- **teammate 模型可配置化**（F33–F36，02 规格 §9.13/§10 修订）：
  - spawn 默认**继承 Lead 的模型与思考强度**（Lead 会话 `runtime/model_selection` 权威条目 → `model_usage` 兜底；条目不可用时兜底重试一次，origin 只记实际生效者）。
  - `spawn_teammate` 新增可选参数 `model`（`"providerId$modelId"` 或裸 modelId，经 `team://models` 目录消歧）与 `thoughtLevel`。
  - 新增第 10 个工具 **`member_set_model`**：mid-life 修改成员模型/思考强度；空闲成员立即生效，运行中成员下一轮生效（pending 标记 + 下轮兜底）。
  - 新增只读资源 **`team://models`**：模型目录（运行时注册表 `provider_config.json` 白名单投影，含 config.json 回退；**绝不输出 apiKey/baseURL**）。
  - 面板成员卡右上角**齿轮 → 模型设置弹窗**：provider/模型/思考强度三级联动、当前生效值与来源标识（继承自 Lead / spawn 指定 / 手动修改 / CLI 缺省）、高级模式引导（ZCode 设置加 provider 后刷新；弹窗零凭据输入）。`team_panel_call` 新增 `modelOptions`/`setMemberModel` 两动作——面板通道首个（且唯一）受控变更动作，任务板仍零变更。
  - 生效机制：会话库 `session_entry(runtime/model_selection)`（`session/setModel`，`persistAsWorkspaceLastUsed:false`），headless `--resume` 每轮自动恢复；一次设置全轮次生效。
- 测试 697 → 836；视觉基线 72 → 76（重录 28 + 新增 settings 弹窗 4）。

## 0.1.3 — 2026-10-24

描述：智能体团队：在会话中创建并协调多个 teammate 子会话、共享任务板与成员消息。

- 写域重叠警告仅挂双方 `in_progress` 的任务对（成对对称）：主体为 `completed`/`pending` 时不再产生警告。
- 面板 advisory 警告色由错误红降为警告黄（新增语义令牌 `--at-warning-text`）；红色仅保留给真报错。
- **无 MCP 契约/schema 变化**：工具清单、入参/出参与 TASK_VIEW 字段不变，仅派生口径与颜色变化。

## 0.1.2 — 2026-10-24

描述：智能体团队：在会话中创建并协调多个 teammate 子会话、共享任务板与成员消息。

- 文档定稿版：README 补齐安装/启用/快速上手/工具速查/配置/Node 自检/卸载数据处置/故障排查/宿主基线/限制与偏差（D1–D27）。
- 新增《使用手册》（含桌面 MCP Apps 面板、::visualize 卡片、CLI 文本摘要与静态卡片实拍截图），并随包分发（`docs/使用手册.md` 与 `docs/assets/manual/`）。
- 仓库新增内部移交文档：架构说明（as-built）、运维手册、测试手册（不随包分发）。
- **无运行时行为变更**：与 0.1.1 相比仅文档与包内文档资源变化；阶段二的 0.1.0→0.1.1 升级演练证据继续有效。

## 0.1.1 — 2026-10-24

描述：智能体团队：在会话中创建并协调多个 teammate 子会话、共享任务板与成员消息。

- 升级演练版本：功能与 0.1.0 相同，仅版本号与发布元数据变化，用于验证 0.1.0 → 0.1.1 的升级路径。

## 0.1.0 — 2026-10-24

描述：智能体团队：在会话中创建并协调多个 teammate 子会话、共享任务板与成员消息。

- 首个发布包：stage-1–6 交付内容（域核心、工具面、队友运行时、MCP Apps 面板、成员会话隔离）打包为可安装插件。
- 随包提供 `LICENSE`（MIT）与 `THIRD-PARTY-NOTICES.md`（bundle 内联依赖的许可声明）。
- 构建基线：Node ≥ 22；宿主实测基线 Desktop 3.16.2 / CLI 0.17.0。
