# dsh-assembly.resume

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
- Imports user/assistant/tool semantic events with provider/model provenance.
- Provides a UI with CODEX/CC tabs, project grouping, new-chat grouping, selection, and takeover actions.

## What It Does Not Do

This package does not invoke `codex resume` or `claude --resume` for later
prompts, control the native Agent, synchronize native changes after import, or
orchestrate multiple agents. The native provider remains the read-only source
of the imported history; DSH owns every turn after takeover.
`dsh-assembly.bridge` remains a sibling independent component and is not
required by this package.

## Composition

The host must already mount `storage` and `storage-domain`:

```yaml
- id: session-resume
  name: 'dsh-assembly.resume'
  config:
    autoRecover: true
```

The bundled `cordis.patch.yml` inserts the same row for profile overlays. `storage-domain` selects the durable backend; this plugin has no `stateDir` or provider-specific file layout.

## Service Flow

1. The UI or a caller invokes `discover()`.
2. `takeOver(agent, input)` inspects the selected native transcript and builds a complete DSH seed.
3. `ctx.agents.create({ sessionId, seed, meta, agentOptions })` publishes the DSH Agent.
4. The binding is persisted only after the DSH Agent is live.
5. `open(agent, recordId)` uses `ctx.agents.resume()` after a DSH restart.
6. The native file remains read-only and is not used for future prompt delivery.

The service also exposes the existing sidecar record/lease storage helpers to
future assembly components, but they are not the continuation mechanism.

## Standalone Client

The package has two faces in one independently installable artifact:

- Host: `ctx.sessionResume`, provider discovery, native process execution, durable storage, and Remote methods.
- Client: `dsh-assembly.resume/client`, a tab under DSH's native Settings > Plugins page, loaded through the DSH client module loader.

Install this package without `dsh-assembly.bridge`. The host profile needs the
normal DSH `storage-domain` and session-persistence services for durable DSH
Agent creation/reopen.
