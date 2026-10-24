# agent-team

把 DSH Agent Teams 的协作方式带到 ZCode：Lead 在会话中创建 teammate 子会话、共享任务板、收发成员消息，并以 MCP Apps 面板实时呈现团队状态。

## 安装

- 从插件市场安装：打开 **插件市场 / Plugin Marketplace**，找到「智能体团队 / Agent Teams」，点击 **安装 / Install**。
- 本地或团队市场：在插件市场点击 **添加 / Add → 添加插件市场 / Add Plugin Marketplace**，选择包含 `marketplace.json` 的市场根目录，再从「个人 / Personal」中安装本插件。
- 安装后可在 **设置 → 插件 / Settings → Plugins** 中管理。

## 启用

在 **设置 → 插件** 中启用 `agent-team`。插件声明的 SessionStart / Stop / UserPromptSubmit hooks 随插件启用自动生效，无需额外的 hooks 开关或信任授予。团队限额（最大成员数、任务数、单条消息字节数、处置超时）可在插件设置中调整。

## 快速上手

新建一个任务，发送：

```text
创建一个叫 reviewer 的队友，让它检查 README 前三段的错别字，然后汇总它的结论。
```

预期：Lead 创建 `reviewer` 成员并分配任务；会话中的「智能体团队」面板出现该成员和任务状态；`reviewer` 完成后，Lead 给出汇总。成员会话作为隐藏子会话运行，不会与 Lead 平级出现在左侧任务栏。

## Node 版本要求

本插件的 daemon、hooks 与 `team-ctl` 由 Node 运行，要求 **Node ≥ 22**。安装前自检：

```bash
node -v
```

输出应为 `v22.x` 或更高（如 `v25.8.1`）。低于 `v22` 时 daemon 启动自检会失败，请先升级 Node。

## 卸载后数据怎么处理

TODO（stage-2 实测后补全）：卸载对插件自有数据目录 `$ZCODE_PLUGIN_DATA` 的处置（保留或删除）以实测结论为准；在补全前请勿据此清理数据。

## 故障排查

TODO（stage-2 实测后补全）：日志位置与 `team-ctl` 自查步骤待实测后补全。
