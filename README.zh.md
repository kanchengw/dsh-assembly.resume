# dsh-assembly.resume

版本：`v0.1.0`

将已有的 Codex 或 Claude Code 会话带入 DSH，并由 DSH Agent 接续后续对话。

## 功能

- 发现本机上的 Codex、Claude Code CLI 和 Claude Code Desktop 会话。
- 按原始项目归类会话，便于在大量历史记录中定位。
- 将选中的会话导入 DSH，包括可见消息和工具活动。
- 当原会话属于某个项目，自动创建 DSH 项目和工作区。
- 转接后在 DSH 中继续对话。

## 安装

从 npm 安装：

```bash
npm install dsh-assembly.resume
```

添加到 DSH profile：

```bash
dsh plugin --profile web add dsh-assembly.resume
```

启动 DSH：

```bash
dsh web
```

在“设置 > 插件”中选择 **Session Resume**，然后选择 Provider 和要接续的会话。
