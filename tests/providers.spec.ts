import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  discoverExternalSessions,
  inspectExternalSession,
  parseClaudeTranscript,
  parseCodexTranscript,
} from '../src/providers.ts'

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
      expect.objectContaining({ kind: 'user', turn: 0, content: [{ type: 'text', text: 'inspect the repo' }] }),
      expect.objectContaining({ kind: 'assistant', turn: 0, provider: 'openai', model: 'gpt-5', content: [{ type: 'text', text: 'I inspected it' }] }),
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

  it('parses Codex tool call and output as paired semantic events', () => {
    expect(parseCodexTranscript([
      { type: 'session_meta', payload: { session_id: 'codex-tools', model_provider: 'openai', model: 'gpt-5' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'run tests', turn_id: 'turn-1' } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{"cmd":"pnpm test"}', turn_id: 'turn-1' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'passed', turn_id: 'turn-1' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'All tests passed', turn_id: 'turn-1' } },
    ])).toEqual([
      expect.objectContaining({ kind: 'user' }),
      expect.objectContaining({ kind: 'assistant', toolCalls: [{ callId: 'call-1', name: 'shell', arguments: '{"cmd":"pnpm test"}' }] }),
      expect.objectContaining({ kind: 'tool-result', callId: 'call-1', content: [{ type: 'text', text: 'passed' }] }),
      expect.objectContaining({ kind: 'assistant', content: [{ type: 'text', text: 'All tests passed' }] }),
    ])
  })

  it('does not import Codex developer or injected context as user history', () => {
    const events = parseCodexTranscript([
      { type: 'session_meta', payload: { session_id: 'codex-context', model_provider: 'openai', model: 'gpt-5' } },
      { type: 'response_item', payload: { role: 'developer', content: [{ type: 'text', text: 'private developer context' }] } },
      { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: 'private injected context' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'real user request' } },
    ])
    expect(events).toEqual([expect.objectContaining({ kind: 'user', content: [{ type: 'text', text: 'real user request' }] })])
  })

  it('starts a new anonymous Codex turn at each native user message', () => {
    const events = parseCodexTranscript([
      { type: 'session_meta', payload: { session_id: 'codex-anonymous', model_provider: 'openai', model: 'gpt-5' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'first' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'one' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'second' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'two' } },
    ])
    expect(events.map(event => event.turn)).toEqual([0, 0, 1, 1])
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
