import { mkdtemp, mkdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  discoverExternalSessions,
  inspectExternalSession,
  parseClaudeTranscript,
  parseCodexTranscript,
} from '../src/providers.ts'
import { buildDshSeed } from '../src/transcript.ts'

describe('native provider discovery', () => {
  it('discovers Codex metadata and uses the native session index title', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-codex-'))
    const cwd = join(root, 'workspace')
    await mkdir(cwd)
    const file = join(root, '2026', '08', '23', 'session.jsonl')
    await mkdir(join(root, '2026', '08', '23'), { recursive: true })
    await writeFile(file, [
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'codex-1', cwd, timestamp: '2026-08-23T00:00:00.000Z' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'initial task' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'follow-up task' } }),
    ].join('\n'))
    const index = join(root, 'session_index.jsonl')
    await writeFile(index, JSON.stringify({ id: 'codex-1', thread_name: 'Fix the failing test', updated_at: '2026-08-23T00:01:00.000Z' }) + '\n')

    await expect(discoverExternalSessions({ provider: 'codex' }, { codexHome: root, codexIndex: index })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({
        provider: 'codex',
        externalSessionId: 'codex-1',
        cwd,
        title: 'Fix the failing test',
        firstUserMessage: 'initial task',
        lastUserMessage: 'follow-up task',
        resumable: true,
      })]),
    )
  })

  it('uses completed Codex UserMessage items for safe session previews', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-codex-completed-user-'))
    const cwd = join(root, 'workspace')
    await mkdir(cwd)
    await writeFile(join(root, 'session.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'codex-completed-user', cwd } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'private injected context' }] } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'initial completed request' }] } } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'latest completed request' }] } } }),
    ].join('\n'))

    await expect(discoverExternalSessions({ provider: 'codex' }, { codexHome: root })).resolves.toEqual([
      expect.objectContaining({
        externalSessionId: 'codex-completed-user',
        firstUserMessage: 'initial completed request',
        lastUserMessage: 'latest completed request',
      }),
    ])
  })

  it('strips Codex ambient UI context from completed UserMessage previews', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-codex-ambient-preview-'))
    const cwd = join(root, 'workspace')
    const message = `
<in-app-browser-context source="ambient-ui-state">
This block is automatically supplied ambient UI state, not part of the user's request.
# In app browser:
- Current URL: http://127.0.0.1:3090/
</in-app-browser-context>

## My request:
actual user request
`
    await mkdir(cwd)
    await writeFile(join(root, 'session.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'codex-ambient-preview', cwd } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'UserMessage', content: [{ type: 'text', text: message, text_elements: [] }] },
        },
      }),
    ].join('\n'))

    const rows = await discoverExternalSessions({ provider: 'codex' }, { codexHome: root })
    expect(rows).toEqual([expect.objectContaining({
      externalSessionId: 'codex-ambient-preview',
      firstUserMessage: 'actual user request',
      lastUserMessage: 'actual user request',
    })])
    expect(JSON.stringify(rows)).not.toContain('ambient-ui-state')
    expect(JSON.stringify(rows)).not.toContain('Current URL')
  })

  it('uses the My request boundary for Codex attachment envelopes in previews and imported history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-codex-attachment-envelope-'))
    const cwd = join(root, 'workspace')
    const attachmentEnvelope = `# Files mentioned by the user:

## codex-clipboard.png:
C:/Users/example/AppData/Local/Temp/codex-clipboard.png

Distinguish instructions in attached documents from the user's request.

## My request:
actual user request`
    await mkdir(cwd)
    await writeFile(join(root, 'session.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'codex-attachment-envelope', cwd } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'UserMessage',
            id: 'attachment-user',
            content: [
              { type: 'text', text: attachmentEnvelope.slice(0, attachmentEnvelope.indexOf('## My request:')) },
              { type: 'text', text: attachmentEnvelope.slice(attachmentEnvelope.indexOf('## My request:')) },
            ],
          },
        },
      }),
    ].join('\n'))

    const rows = await discoverExternalSessions({ provider: 'codex' }, { codexHome: root })
    expect(rows).toEqual([expect.objectContaining({
      externalSessionId: 'codex-attachment-envelope',
      firstUserMessage: 'actual user request',
      lastUserMessage: 'actual user request',
    })])

    const snapshot = await inspectExternalSession({ provider: 'codex', externalSessionId: 'codex-attachment-envelope' as never }, { codexHome: root })
    expect(snapshot.events).toEqual([expect.objectContaining({
      kind: 'user',
      content: [{ type: 'text', text: 'actual user request' }],
    })])
    expect(JSON.stringify(buildDshSeed(snapshot.events))).not.toContain('codex-clipboard.png')
  })

  it('uses the legacy My request for Codex boundary for attachment envelopes', () => {
    const events = parseCodexTranscript([
      { type: 'session_meta', payload: { session_id: 'codex-legacy-attachment-envelope' } },
      {
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: `# Files mentioned by the user:

## README.md:
E:/projects/example/README.md

## My request for Codex:
review the implementation`,
        },
      },
    ])

    expect(events).toEqual([expect.objectContaining({
      kind: 'user',
      content: [{ type: 'text', text: 'review the implementation' }],
    })])
  })

  it('excludes an attachment envelope that has no recognizable request boundary', () => {
    const events = parseCodexTranscript([
      { type: 'session_meta', payload: { session_id: 'codex-unbounded-attachment-envelope' } },
      {
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: `# Files mentioned by the user:

## codex-clipboard.png:
C:/Users/example/AppData/Local/Temp/codex-clipboard.png`,
        },
      },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'I can inspect the image.' } },
    ])

    expect(events.some(event => event.kind === 'user')).toBe(false)
    expect(JSON.stringify(events)).not.toContain('codex-clipboard.png')
  })

  it('preserves a My request heading that belongs to a regular user message', () => {
    const message = `I am drafting a document:\n\n## My request:\nkeep this heading and its preceding context.`
    const events = parseCodexTranscript([
      { type: 'session_meta', payload: { session_id: 'codex-user-authored-heading' } },
      { type: 'event_msg', payload: { type: 'user_message', message } },
    ])

    expect(events).toEqual([expect.objectContaining({
      kind: 'user',
      content: [{ type: 'text', text: message }],
    })])
  })

  it('does not expose Codex developer or context records as user messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-codex-context-'))
    const cwd = join(root, 'workspace')
    await mkdir(cwd)
    const file = join(root, 'session.jsonl')
    await writeFile(file, [
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'codex-context', cwd } }),
      JSON.stringify({ type: 'response_item', payload: { role: 'developer', content: [{ type: 'text', text: 'private developer context' }] } }),
      JSON.stringify({ type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: 'private injected context' }] } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'real user request' } }),
    ].join('\n'))

    const rows = await discoverExternalSessions({ provider: 'codex' }, { codexHome: root })
    expect(rows).toEqual([expect.objectContaining({
      externalSessionId: 'codex-context',
      firstUserMessage: 'real user request',
      lastUserMessage: 'real user request',
    })])
    expect(JSON.stringify(rows)).not.toContain('private developer context')
    expect(JSON.stringify(rows)).not.toContain('private injected context')
  })

  it('excludes legacy Codex exec task templates from discovery and importable user history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-codex-exec-template-'))
    const cwd = join(root, 'workspace')
    await mkdir(cwd)
    const rows = [
      { type: 'session_meta', payload: { session_id: 'codex-exec-template', cwd, source: 'exec', history_mode: 'legacy' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Your task is to perform the following. Follow the instructions below exactly. Internal task envelope.' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'internal task response' } },
    ]
    await writeFile(join(root, 'session.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'))

    await expect(discoverExternalSessions({ provider: 'codex' }, { codexHome: root })).resolves.toEqual([])
    expect(parseCodexTranscript(rows).some(event => event.kind === 'user')).toBe(false)
  })

  it('keeps a genuine legacy Codex exec prompt that does not use the generated task envelope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-codex-exec-user-'))
    const cwd = join(root, 'workspace')
    await mkdir(cwd)
    await writeFile(join(root, 'session.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'codex-exec-user', cwd, source: 'exec', history_mode: 'legacy' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Please review this document.' } }),
    ].join('\n'))

    await expect(discoverExternalSessions({ provider: 'codex' }, { codexHome: root })).resolves.toEqual([
      expect.objectContaining({ externalSessionId: 'codex-exec-user', firstUserMessage: 'Please review this document.' }),
    ])
  })

  it('marks Codex-managed new chats without turning their storage directory into a project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-codex-new-chat-'))
    const newChatRoot = join(root, 'Documents', 'Codex')
    const cwd = join(newChatRoot, '2026-08-24', 'zai')
    const file = join(root, 'sessions', 'new-chat.jsonl')
    await mkdir(join(root, 'sessions'), { recursive: true })
    await mkdir(cwd, { recursive: true })
    await writeFile(file, [
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'codex-new-chat', cwd } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'standalone question' } }),
    ].join('\n'))

    const rows = await discoverExternalSessions({ provider: 'codex' }, { codexHome: join(root, 'sessions'), codexNewChatRoot: newChatRoot })
    expect(rows).toEqual([expect.objectContaining({
      externalSessionId: 'codex-new-chat',
      cwd,
    })])
    expect(rows[0]).not.toHaveProperty('projectPath')
  })

  it('excludes Codex subagent transcripts from the resumable conversation list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-codex-subagent-'))
    const cwd = join(root, 'workspace')
    await mkdir(cwd)
    await writeFile(join(root, 'parent.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'parent-id', session_id: 'parent-id', cwd } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'parent request' } }),
    ].join('\n'))
    await writeFile(join(root, 'subagent.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'subagent-id', session_id: 'parent-id', parent_thread_id: 'parent-id', cwd, source: { subagent: {} } } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'subagent task' } }),
    ].join('\n'))

    await expect(discoverExternalSessions({ provider: 'codex' }, { codexHome: root })).resolves.toEqual([
      expect.objectContaining({ externalSessionId: 'parent-id', firstUserMessage: 'parent request' }),
    ])
  })

  it('returns only the newest source when native storage has duplicate session files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-codex-duplicates-'))
    const cwd = join(root, 'workspace')
    const older = join(root, 'archive', 'session.jsonl')
    const newer = join(root, 'active', 'session.jsonl')
    await mkdir(cwd)
    await mkdir(join(root, 'archive'), { recursive: true })
    await mkdir(join(root, 'active'), { recursive: true })
    await writeFile(older, [
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'codex-duplicate-source', cwd } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'older copy' } }),
    ].join('\n'))
    await writeFile(newer, [
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'codex-duplicate-source', cwd } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'newer copy' } }),
    ].join('\n'))
    await utimes(older, new Date('2026-08-20T00:00:00.000Z'), new Date('2026-08-20T00:00:00.000Z'))
    await utimes(newer, new Date('2026-08-24T00:00:00.000Z'), new Date('2026-08-24T00:00:00.000Z'))

    await expect(discoverExternalSessions({ provider: 'codex' }, { codexHome: root })).resolves.toEqual([
      expect.objectContaining({
        externalSessionId: 'codex-duplicate-source',
        sourcePath: newer,
        firstUserMessage: 'newer copy',
      }),
    ])
  })

  it('discovers Claude Code sessions from project JSONL without exposing transcript bodies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-claude-'))
    const cwd = join(root, 'workspace')
    await mkdir(cwd)
    const file = join(root, 'project', 'session.jsonl')
    await mkdir(join(root, 'project'), { recursive: true })
    await writeFile(file, [
      JSON.stringify({ type: 'user', sessionId: 'claude-1', cwd, timestamp: '2026-08-23T00:00:00.000Z', message: { role: 'user', content: 'inspect repo' } }),
      JSON.stringify({ type: 'system', sessionId: 'claude-1', cwd, slug: 'inspect-repo' }),
      JSON.stringify({ type: 'assistant', sessionId: 'claude-1', cwd, message: { role: 'assistant', content: [{ type: 'text', text: 'private assistant detail' }] } }),
    ].join('\n'))

    const rows = await discoverExternalSessions({ provider: 'claude-code' }, { claudeHome: root })
    expect(rows).toEqual([expect.objectContaining({ provider: 'claude-code', externalSessionId: 'claude-1', title: 'inspect-repo', firstUserMessage: 'inspect repo' })])
    expect(JSON.stringify(rows)).not.toContain('private assistant detail')
  })

  it('discovers native Claude Code Desktop metadata through its linked local transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-claude-desktop-'))
    const cwd = join(root, 'workspace')
    const claudeHome = join(root, 'claude-projects')
    const desktopHome = join(root, 'Claude', 'claude-code-sessions')
    const transcript = join(claudeHome, 'project', 'desktop-cli-id.jsonl')
    await mkdir(cwd)
    await mkdir(join(claudeHome, 'project'), { recursive: true })
    await mkdir(join(desktopHome, 'account', 'workspace'), { recursive: true })
    await writeFile(transcript, [
      JSON.stringify({ type: 'user', sessionId: 'desktop-cli-id', cwd, timestamp: '2026-08-23T00:00:00.000Z', message: { role: 'user', content: 'desktop request' } }),
      JSON.stringify({ type: 'assistant', sessionId: 'desktop-cli-id', cwd, timestamp: '2026-08-23T00:00:01.000Z', message: { role: 'assistant', model: 'claude-sonnet', content: [{ type: 'text', text: 'desktop answer' }] } }),
    ].join('\n'))
    await writeFile(join(desktopHome, 'account', 'workspace', 'local_desktop-id.json'), JSON.stringify({
      sessionId: 'local_desktop-id', cliSessionId: 'desktop-cli-id', cwd, originCwd: cwd,
      title: 'Desktop task', createdAt: 1787443200000, lastActivityAt: 1787443260000, isArchived: false,
    }))

    const config = { claudeHome, claudeDesktopHome: desktopHome }
    const rows = await discoverExternalSessions({ provider: 'claude-code-desktop' }, config)
    expect(rows).toEqual([expect.objectContaining({
      provider: 'claude-code-desktop', externalSessionId: 'local_desktop-id', cwd, projectPath: cwd,
      sourcePath: transcript, title: 'Desktop task', firstUserMessage: 'desktop request',
      createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:01:00.000Z',
    })])
    await expect(inspectExternalSession({ provider: 'claude-code-desktop', externalSessionId: 'local_desktop-id' as never }, config)).resolves.toMatchObject({
      session: { provider: 'claude-code-desktop', externalSessionId: 'local_desktop-id', sourcePath: transcript },
      events: [expect.objectContaining({ kind: 'user' }), expect.objectContaining({ kind: 'assistant', model: 'claude-sonnet' })],
    })
  })

  it('keeps CLI-imported Desktop records in CLI and excludes native Desktop transcripts from CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-claude-sources-'))
    const cwd = join(root, 'workspace')
    const claudeHome = join(root, 'claude-projects')
    const desktopHome = join(root, 'Claude', 'claude-code-sessions')
    await mkdir(cwd)
    await mkdir(join(claudeHome, 'project'), { recursive: true })
    await mkdir(join(desktopHome, 'account', 'workspace'), { recursive: true })
    const transcriptRow = (sessionId: string, message: string): string => JSON.stringify({ type: 'user', sessionId, cwd, message: { role: 'user', content: message } })
    await writeFile(join(claudeHome, 'project', 'native-desktop.jsonl'), transcriptRow('native-desktop', 'native desktop'))
    await writeFile(join(claudeHome, 'project', 'imported-cli.jsonl'), transcriptRow('imported-cli', 'imported CLI'))
    await writeFile(join(desktopHome, 'account', 'workspace', 'local_native-record.json'), JSON.stringify({ sessionId: 'local_native-record', cliSessionId: 'native-desktop', cwd }))
    await writeFile(join(desktopHome, 'account', 'workspace', 'local_imported-cli.json'), JSON.stringify({ sessionId: 'local_imported-cli', cliSessionId: 'imported-cli', cwd }))

    const config = { claudeHome, claudeDesktopHome: desktopHome }
    await expect(discoverExternalSessions({ provider: 'claude-code' }, config)).resolves.toEqual([
      expect.objectContaining({ provider: 'claude-code', externalSessionId: 'imported-cli' }),
    ])
    await expect(discoverExternalSessions({ provider: 'claude-code-desktop' }, config)).resolves.toEqual([
      expect.objectContaining({ provider: 'claude-code-desktop', externalSessionId: 'local_native-record', sourcePath: join(claudeHome, 'project', 'native-desktop.jsonl') }),
    ])
  })

  it('does not advertise archived, cloud, broken, or transcript-less Desktop metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-claude-desktop-invalid-'))
    const cwd = join(root, 'workspace')
    const claudeHome = join(root, 'claude-projects')
    const desktopHome = join(root, 'Claude', 'claude-code-sessions')
    await mkdir(cwd)
    await mkdir(join(claudeHome, 'project'), { recursive: true })
    await mkdir(join(desktopHome, 'account', 'workspace'), { recursive: true })
    await writeFile(join(claudeHome, 'project', 'archived.jsonl'), JSON.stringify({ type: 'user', sessionId: 'archived', cwd, message: { role: 'user', content: 'archived' } }))
    await writeFile(join(desktopHome, 'account', 'workspace', 'local_archived.json'), JSON.stringify({ sessionId: 'local_archived', cliSessionId: 'archived', cwd, isArchived: true }))
    await writeFile(join(desktopHome, 'account', 'workspace', 'cloud.json'), JSON.stringify({ sessionId: 'cse_cloud', cliSessionId: 'archived', cwd }))
    await writeFile(join(desktopHome, 'account', 'workspace', 'local_missing.json'), JSON.stringify({ sessionId: 'local_missing', cliSessionId: 'missing', cwd }))
    await writeFile(join(desktopHome, 'account', 'workspace', 'local_broken.json'), '{')

    await expect(discoverExternalSessions({ provider: 'claude-code-desktop' }, { claudeHome, claudeDesktopHome: desktopHome })).resolves.toEqual([])
  })

  it('filters by provider, workspace, query, and limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-filter-'))
    const cwd = join(root, 'workspace')
    await mkdir(join(root, 'codex'), { recursive: true })
    await mkdir(cwd)
    await writeFile(join(root, 'codex', 'one.jsonl'), JSON.stringify({ type: 'session_meta', payload: { session_id: 'one', cwd } }) + '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'alpha' } }))
    await writeFile(join(root, 'codex', 'two.jsonl'), JSON.stringify({ type: 'session_meta', payload: { session_id: 'two', cwd } }) + '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'beta' } }))
    await expect(discoverExternalSessions({ provider: 'codex', cwd, query: 'beta', limit: 1 }, { codexHome: join(root, 'codex') })).resolves.toEqual([
      expect.objectContaining({ externalSessionId: 'two' }),
    ])
  })
})

describe('native provider semantic transcript parsing', () => {
  it('parses Codex user and assistant events with model provenance', () => {
    expect(parseCodexTranscript([
      { type: 'session_meta', payload: { session_id: 'codex-parse', model_provider: 'openai', model: 'gpt-5' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'inspect the repo', turn_id: 'turn-1' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'I inspected it', turn_id: 'turn-1' } },
    ])).toEqual([
      expect.objectContaining({ kind: 'user', turn: 1, content: [{ type: 'text', text: 'inspect the repo' }] }),
      expect.objectContaining({ kind: 'assistant', turn: 1, provider: 'openai', model: 'gpt-5', content: [{ type: 'text', text: 'I inspected it' }] }),
    ])
  })

  it('deduplicates Codex assistant representations even when transport records separate them', () => {
    expect(parseCodexTranscript([
      { type: 'session_meta', payload: { session_id: 'codex-duplicate', model_provider: 'openai', model: 'gpt-5' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'hello', turn_id: 'turn-1' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'same answer', turn_id: 'turn-1' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'same answer' }], turn_id: 'turn-1' } },
    ]).filter(event => event.kind === 'assistant')).toHaveLength(1)
  })

  it('omits Codex tool traces because the native runtime cannot be resumed in DSH', () => {
    const events = parseCodexTranscript([
      { type: 'session_meta', payload: { session_id: 'codex-tools', model_provider: 'openai', model: 'gpt-5' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'run tests', turn_id: 'turn-1' } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{"cmd":"pnpm test"}', turn_id: 'turn-1' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'passed', turn_id: 'turn-1' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'All tests passed', turn_id: 'turn-1' } },
    ])
    expect(events).toEqual([
      expect.objectContaining({ kind: 'user' }),
      expect.objectContaining({ kind: 'assistant', content: [{ type: 'text', text: 'All tests passed' }] }),
    ])
    expect(events.some(event => event.kind === 'tool-result' || (event.kind === 'assistant' && event.toolCalls !== undefined))).toBe(false)
  })

  it('skips a Codex tool trace even when transport records carry different turns', () => {
    const events = parseCodexTranscript([
      { type: 'session_meta', payload: { session_id: 'codex-tool-turn', model_provider: 'openai', model: 'gpt-5' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'run tests', turn_id: 'user-turn' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-1', name: 'shell', input: '{"cmd":"pnpm test"}', turn_id: 'model-turn' } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: 'passed', turn_id: 'user-turn' } },
    ])

    expect(events.map(event => event.turn)).toEqual([1])
    expect(() => buildDshSeed(events)).not.toThrow()
  })

  it('skips a Codex tool exchange whose output is empty', () => {
    const events = parseCodexTranscript([
      { type: 'session_meta', payload: { session_id: 'codex-empty-tool-output', model_provider: 'openai', model: 'gpt-5' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'run the task', turn_id: 'turn-1' } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'empty-call', name: 'delegate', arguments: '{}', turn_id: 'turn-1' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'empty-call', output: '', turn_id: 'turn-1' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'completed', turn_id: 'turn-1' } },
    ])

    expect(events.map(event => event.kind)).toEqual(['user', 'assistant'])
    expect(() => buildDshSeed(events)).not.toThrow()
  })

  it('skips a Codex tool exchange whose output is whitespace-only', () => {
    const events = parseCodexTranscript([
      { type: 'session_meta', payload: { session_id: 'codex-whitespace-tool-output', model_provider: 'openai', model: 'gpt-5' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'run the task', turn_id: 'turn-1' } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'empty-call', name: 'delegate', arguments: '{}', turn_id: 'turn-1' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'empty-call', output: '  \n', turn_id: 'turn-1' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'completed', turn_id: 'turn-1' } },
    ])

    expect(events.map(event => event.kind)).toEqual(['user', 'assistant'])
  })

  it('does not import Codex developer or injected context as user history', () => {
    const events = parseCodexTranscript([
      { type: 'session_meta', payload: { session_id: 'codex-context', model_provider: 'openai', model: 'gpt-5' } },
      { type: 'response_item', payload: { role: 'developer', content: [{ type: 'text', text: 'private developer context' }] } },
      { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: 'private injected context' }] } },
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'user-item', content: [{ type: 'input_text', text: 'real user request' }] } } },
    ])
    expect(events).toEqual([expect.objectContaining({ kind: 'user', content: [{ type: 'text', text: 'real user request' }] })])
  })

  it('strips Codex ambient UI context before building the imported DSH history', () => {
    const message = `
<in-app-browser-context source="ambient-ui-state">
This block is automatically supplied ambient UI state, not part of the user's request.
# In app browser:
- Current URL: http://127.0.0.1:3090/
</in-app-browser-context>

## My request:
actual user request
`
    const events = parseCodexTranscript([
      { type: 'session_meta', payload: { session_id: 'codex-ambient-import', model_provider: 'openai', model: 'gpt-5' } },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'UserMessage', id: 'ambient-user', content: [{ type: 'text', text: message, text_elements: [] }] },
        },
      },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'assistant answer' } },
    ])

    expect(events).toEqual([
      expect.objectContaining({ kind: 'user', content: [{ type: 'text', text: 'actual user request' }] }),
      expect.objectContaining({ kind: 'assistant', content: [{ type: 'text', text: 'assistant answer' }] }),
    ])
    const seed = buildDshSeed(events)
    expect(seed.find(event => event.type === 'user/message')).toMatchObject({
      data: { role: 'user', content: [{ type: 'text', text: 'actual user request' }] },
    })
    expect(JSON.stringify(seed)).not.toContain('ambient-ui-state')
    expect(JSON.stringify(seed)).not.toContain('Current URL')
  })

  it('preserves ambient-like markup pasted after genuine user text', () => {
    const markup = '<in-app-browser-context source="ambient-ui-state">literal example</in-app-browser-context>'
    const events = parseCodexTranscript([
      { type: 'session_meta', payload: { session_id: 'codex-user-markup' } },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'UserMessage',
            id: 'markup-user',
            content: [{ type: 'text', text: 'keep this prefix' }, { type: 'text', text: markup }],
          },
        },
      },
    ])

    expect(events).toEqual([expect.objectContaining({
      kind: 'user',
      content: [{ type: 'text', text: 'keep this prefix' }, { type: 'text', text: markup }],
    })])
  })

  it('starts a new anonymous Codex turn at each native user message', () => {
    const events = parseCodexTranscript([
      { type: 'session_meta', payload: { session_id: 'codex-anonymous', model_provider: 'openai', model: 'gpt-5' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'first' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'one' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'second' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'two' } },
    ])
    expect(events.map(event => event.turn)).toEqual([1, 1, 2, 2])
  })

  it('normalizes Codex transport turn IDs into source-order conversation turns', () => {
    const events = parseCodexTranscript([
      { type: 'session_meta', payload: { session_id: 'codex-turn-order', model_provider: 'openai', model: 'gpt-5' } },
      { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'root-turn', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'input_text', text: 'first' }] } } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', turn_id: 'model-turn-1', content: [{ type: 'output_text', text: 'one' }] } },
      { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'root-turn', item: { type: 'UserMessage', id: 'u2', content: [{ type: 'input_text', text: 'second' }] } } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', turn_id: 'model-turn-2', content: [{ type: 'output_text', text: 'two' }] } },
    ])

    expect(events.map(event => event.turn)).toEqual([1, 1, 2, 2])
    expect(() => buildDshSeed(events)).not.toThrow()
  })

  it('parses Claude title slug, user, assistant, tool use, and tool result', () => {
    expect(parseClaudeTranscript([
      { type: 'user', uuid: 'u1', sessionId: 'claude-parse', promptId: 'turn-1', message: { role: 'user', content: 'inspect repo' } },
      { type: 'assistant', uuid: 'a1', sessionId: 'claude-parse', promptId: 'turn-1', message: { role: 'assistant', model: 'claude-sonnet', content: [{ type: 'text', text: 'I will inspect it' }, { type: 'tool_use', id: 'tool-1', name: 'shell', input: { cmd: 'ls' } }] } },
      { type: 'user', uuid: 'r1', sessionId: 'claude-parse', promptId: 'turn-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } },
      { type: 'assistant', uuid: 'a2', sessionId: 'claude-parse', promptId: 'turn-1', message: { role: 'assistant', model: 'claude-sonnet', content: [{ type: 'text', text: 'Done' }] } },
    ])).toEqual([
      expect.objectContaining({ kind: 'user', content: [{ type: 'text', text: 'inspect repo' }] }),
      expect.objectContaining({ kind: 'assistant', toolCalls: [{ callId: 'tool-1', name: 'shell', arguments: '{"cmd":"ls"}' }] }),
      expect.objectContaining({ kind: 'tool-result', callId: 'tool-1', content: [{ type: 'text', text: 'ok' }] }),
      expect.objectContaining({ kind: 'assistant', content: [{ type: 'text', text: 'Done' }] }),
    ])
  })

  it('does not turn Claude hidden thinking blocks into ordinary DSH history', () => {
    expect(parseClaudeTranscript([
      { type: 'user', sessionId: 'claude-thinking', promptId: 'turn-1', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', sessionId: 'claude-thinking', promptId: 'turn-1', message: { role: 'assistant', model: 'claude-sonnet', content: [{ type: 'thinking', thinking: 'private chain of thought' }, { type: 'text', text: 'public answer' }] } },
    ])).toEqual([
      expect.objectContaining({ kind: 'user' }),
      expect.objectContaining({ kind: 'assistant', content: [{ type: 'text', text: 'public answer' }] }),
    ])
  })

  it('keeps a Claude assistant without promptId in its preceding user turn', () => {
    const events = parseClaudeTranscript([
      { type: 'mode', sessionId: 'claude-turn-order' },
      { type: 'user', sessionId: 'claude-turn-order', promptId: 'user-prompt', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', sessionId: 'claude-turn-order', message: { role: 'assistant', model: 'claude-sonnet', content: [{ type: 'text', text: 'hello back' }] } },
    ])

    expect(events.map(event => event.turn)).toEqual([1, 1])
    expect(() => buildDshSeed(events)).not.toThrow()
  })

  it('rejects malformed native JSONL during inspection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-invalid-'))
    const cwd = join(root, 'workspace')
    await mkdir(cwd)
    await writeFile(join(root, 'bad.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'bad', cwd } }),
      '{invalid-json',
    ].join('\n'))
    await expect(inspectExternalSession({ provider: 'codex', externalSessionId: 'bad' as never }, { codexHome: root })).rejects.toThrow(/invalid JSON/)
  })

  it('returns an import fingerprint and semantic events for a selected session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-inspect-'))
    const cwd = join(root, 'workspace')
    await mkdir(cwd)
    await writeFile(join(root, 'session.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { session_id: 'inspect-me', cwd, model_provider: 'openai', model: 'gpt-5' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hello' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'hi' } }),
    ].join('\n'))
    const snapshot = await inspectExternalSession({ provider: 'codex', externalSessionId: 'inspect-me' as never }, { codexHome: root })
    expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(snapshot.sourceRevision).toMatch(/^[a-f0-9]{64}$/u)
    expect(snapshot.events).toHaveLength(2)
  })
})
