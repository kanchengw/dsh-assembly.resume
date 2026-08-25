# dsh-assembly.resume

版本：`v0.1.0`

用于将本地 Codex 和 Claude Code 会话导入为新的 DSH Agent 会话的独立 DSH 插件。

插件注册 `ctx.sessionResume`，提供类型安全的 Host Remote 接口，并提供浏览器设置页面。它会扫描各个 Provider 管理的 JSONL 会话存储，读取有限的会话元数据，解析选中的原生会话记录，将语义历史转换为经过校验的 DSH 会话种子，并基于该历史启动 DSH Agent。接管完成后，后续消息由普通 DSH composer 发送给 DSH Agent。

## 功能

- 通过配置的存储后端持久化原生会话到 DSH 的接管绑定，并支持 DSH 重启后恢复。
- 使用 `ctx.agents.resume()` 恢复 DSH Agent，不会启动原生 CLI。
- 从 `CODEX_HOME` 或 `~/.codex/sessions` 发现 Codex 会话。
- 从 `CLAUDE_CONFIG_DIR` 或 `~/.claude/projects` 发现 Claude Code 会话。
- 读取 Claude Code Desktop 官方 `claude-code-sessions` 元数据，并通过 `cliSessionId` 定位对应的本地 Claude 会话记录。
- 导入用户消息、Agent 回复和工具事件，并保留 Provider 与模型来源信息。
- 分别提供 Codex、Claude Code CLI 和 Claude Code Desktop 选择器，支持按项目分组、选择会话和接管到 DSH。

## 安装

从 npm 安装：

```bash
npm install dsh-assembly.resume
```

安装到 DSH profile：

```bash
dsh plugin --profile web add dsh-assembly.resume
```

然后启动 profile：

```bash
dsh web
```
