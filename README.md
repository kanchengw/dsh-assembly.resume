# dsh-assembly.resume

Version: `v0.1.0`

Bring an existing Codex or Claude Code conversation into DSH, then continue it
with the DSH Agent.

## What It Does

- Finds local conversations from Codex, Claude Code CLI, and Claude Code Desktop.
- Groups conversations by their original project so they are easier to find.
- Imports the selected conversation into DSH, including its visible messages and tool activity.
- Automatically creates the matching DSH project and workspace when the source conversation belongs to a project.
- Continue the conversation in DSH after transfer.

## Installation

Install the package from npm:

```bash
npm install dsh-assembly.resume
```

Add it to a DSH profile:

```bash
dsh plugin --profile web add dsh-assembly.resume
```

Start DSH:

```bash
dsh web
```

Open Settings > Plugins and select **Session Resume** to choose a provider and
conversation.
