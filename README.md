# dsh-assembly.resume

Version: `v0.1.0`

Independent DSH plugin for importing local Codex and Claude Code sessions into
a new DSH Agent conversation.

The plugin registers `ctx.sessionResume`, exposes a typed Host Remote surface,
and ships a browser settings section. It scans provider-owned JSONL stores for
bounded metadata, reads the selected native transcript, translates its
semantic history into a validated DSH seed, and starts a DSH Agent on that
history. After takeover, the normal DSH composer sends all future messages to
the DSH Agent.

## What It Does

- Persists native-to-DSH takeover bindings across DSH restarts through the configured storage backend.
- Reopens the DSH Agent with `ctx.agents.resume()`; it never starts a native CLI.
- Discovers Codex sessions from `CODEX_HOME` or `~/.codex/sessions`.
- Discovers Claude Code sessions from `CLAUDE_CONFIG_DIR` or `~/.claude/projects`.
- Discovers Claude Code Desktop metadata from its official `claude-code-sessions`
  store and follows `cliSessionId` to the matching local Claude transcript.
- Imports user/assistant/tool semantic events with provider/model provenance.
- Provides separate Codex, Claude Code CLI, and Claude Code Desktop selectors,
  with project grouping, selection, and takeover actions.

## Installation

Install from npm:

```bash
npm install dsh-assembly.resume
```

Install into a DSH profile:

```bash
dsh plugin --profile web add dsh-assembly.resume
```

Then start the profile:

```bash
dsh web
```
