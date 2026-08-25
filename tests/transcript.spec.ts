import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { buildDshSeed, type NativeSemanticEvent, type NativeToolCall } from '../src/transcript.ts'

const user = (id: string, text: string, turn = 0): NativeSemanticEvent => ({
  kind: 'user', id, turn, time: 1, content: [{ type: 'text', text }],
})

const assistant = (id: string, text: string, turn = 0, toolCalls?: readonly NativeToolCall[]): NativeSemanticEvent => ({
  kind: 'assistant', id, turn, time: 2, content: [{ type: 'text', text }], provider: 'codex-native', model: 'codex-model',
  ...(toolCalls === undefined ? {} : { toolCalls }),
})

describe('buildDshSeed', () => {
  it('builds a completed DSH turn from a native user and assistant exchange', () => {
    const seed = buildDshSeed([user('u1', 'inspect the repo'), assistant('a1', 'I inspected it')])

    expect(seed.map(event => event.type)).toEqual([
      'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
    ])
    expect(seed[2]).toMatchObject({ surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text: 'inspect the repo' }] } })
    expect(seed[3]).toMatchObject({ surfaceOp: 'append', data: { message: { role: 'assistant', source: { kind: 'model', provider: 'codex-native', model: 'codex-model' } } } })
  })

  it('keeps a native tool call and result in the same completed turn', () => {
    const seed = buildDshSeed([
      user('u1', 'run the check'),
      assistant('a1', 'I will run it', 0, [{ callId: 'call-1', name: 'shell', arguments: '{"cmd":"pnpm test"}' }]),
      { kind: 'tool-result', id: 'r1', turn: 0, time: 3, callId: 'call-1', content: [{ type: 'text', text: 'passed' }] },
      assistant('a2', 'The check passed'),
    ])

    expect(seed.map(event => event.type)).toEqual([
      'turn/start', 'step/start', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'step/end',
      'step/start', 'assistant/message', 'step/end', 'turn/end',
    ])
    expect(seed[5]).toMatchObject({ surfaceOp: 'append', data: { message: { source: { kind: 'tool', callId: 'call-1' } } } })
    expect(seed[8]).toMatchObject({ data: { step: 2 } })
  })

  it('allows a tool-only assistant message when the native provider has no visible text', () => {
    const seed = buildDshSeed([
      user('u1', 'run it'),
      { kind: 'assistant', id: 'a1', turn: 0, time: 2, content: [], provider: 'codex-native', model: 'codex-model', toolCalls: [{ callId: 'call-1', name: 'shell', arguments: '{}' }] },
      { kind: 'tool-result', id: 'r1', turn: 0, time: 3, callId: 'call-1', content: [{ type: 'text', text: 'done' }] },
    ])

    expect(seed).toHaveLength(8)
    expect(seed[3]).toMatchObject({ type: 'assistant/message' })
  })

  it('produces a seed accepted by the current DSH Session boundary', () => {
    const seed = buildDshSeed([
      user('u1', 'run it'),
      assistant('a1', 'running', 0, [{ callId: 'call-1', name: 'shell', arguments: '{}' }]),
      { kind: 'tool-result', id: 'r1', turn: 0, time: 3, callId: 'call-1', content: [{ type: 'text', text: 'done' }] },
      assistant('a2', 'finished'),
    ])

    expect(() => Session.create(SessionId('seed-validation'), seed)).not.toThrow()
  })

  it('rejects an unpaired native tool result', () => {
    expect(() => buildDshSeed([
      user('u1', 'run it'),
      { kind: 'tool-result', id: 'r1', turn: 0, time: 2, callId: 'missing', content: [{ type: 'text', text: 'no call' }] },
    ])).toThrow(/does not match an open tool call/)
  })

  it('rejects a native assistant turn with an unpaired tool call', () => {
    expect(() => buildDshSeed([
      user('u1', 'run it'),
      assistant('a1', 'running', 0, [{ callId: 'call-1', name: 'shell', arguments: '{}' }]),
    ])).toThrow(/unpaired tool calls/)
  })

  it('rejects assistant history without provider/model provenance', () => {
    expect(() => buildDshSeed([
      user('u1', 'hello'),
      { kind: 'assistant', id: 'a1', turn: 0, time: 2, content: [{ type: 'text', text: 'hi' }], provider: '', model: 'model' },
    ])).toThrow(/provider must be non-blank/)
  })

  it('rejects a native transcript whose turns move backwards', () => {
    expect(() => buildDshSeed([user('u1', 'first', 1), assistant('a1', 'answer', 0)])).toThrow(/non-decreasing order/)
  })
})
