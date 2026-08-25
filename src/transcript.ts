import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type CallId,
  type ContentBlock,
} from '@deepseek-ai/dsh-llm'
import type { SessionEvent as DshSessionEvent } from '@deepseek-ai/dsh-session'

/** Text/reasoning content that a provider can import without losing meaning. */
export type NativeContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }

export interface NativeToolCall {
  readonly callId: string
  readonly name: string
  readonly arguments: string
}

export type NativeSemanticEvent =
  | {
      readonly kind: 'user'
      readonly id: string
      readonly turn: number
      readonly time: number
      readonly content: readonly NativeContentBlock[]
    }
  | {
      readonly kind: 'assistant'
      readonly id: string
      readonly turn: number
      readonly time: number
      readonly content: readonly NativeContentBlock[]
      readonly provider: string
      readonly model: string
      readonly toolCalls?: readonly NativeToolCall[]
    }
  | {
      readonly kind: 'tool-result'
      readonly id: string
      readonly turn: number
      readonly time: number
      readonly callId: string
      readonly content: readonly NativeContentBlock[]
      readonly isError?: boolean
    }

function nonBlank(value: string, label: string): string {
  if (value.trim() === '') throw new Error(`${label} must be non-blank`)
  return value
}

function content(blocks: readonly NativeContentBlock[], label: string): ContentBlock[] {
  if (blocks.length === 0) throw new Error(`${label} must contain content`)
  return blocks.map((block) => {
    nonBlank(block.text, `${label} text`)
    return block.type === 'text'
      ? { type: 'text', text: block.text }
      : { type: 'reasoning', text: block.text }
  })
}

function timeOf(event: NativeSemanticEvent): number {
  if (!Number.isSafeInteger(event.time) || event.time < 0) {
    throw new Error(`native event '${event.id}' has invalid time`)
  }
  return event.time
}

type SeedEvent = { type: string; seq: number; time: number; data: unknown; surfaceOp?: 'append' }

function append(events: SeedEvent[], type: string, time: number, data: unknown): void {
  events.push({ type, seq: events.length, time, data })
}

function appendSurface(events: SeedEvent[], type: string, time: number, data: unknown): void {
  events.push({ type, seq: events.length, time, data, surfaceOp: 'append' })
}

function closeStep(events: SeedEvent[], turn: number, step: number, time: number): void {
  append(events, 'step/end', time, { turn, step })
}

function openStep(events: SeedEvent[], turn: number, step: number, time: number): void {
  append(events, 'step/start', time, { turn, step })
}

function appendUser(
  events: SeedEvent[],
  event: Extract<NativeSemanticEvent, { kind: 'user' }>,
): void {
  appendSurface(events, 'user/message', event.time, createUserMessage({
    content: content(event.content, `native user '${event.id}'`),
    source: { kind: 'user' },
  }))
}

function appendAssistant(
  events: SeedEvent[],
  event: Extract<NativeSemanticEvent, { kind: 'assistant' }>,
  turn: number,
  step: number,
): string[] {
  nonBlank(event.provider, `native assistant '${event.id}' provider`)
  nonBlank(event.model, `native assistant '${event.id}' model`)
  const calls = [...event.toolCalls ?? []]
  const callIds = calls.map(call => {
    nonBlank(call.callId, `native tool call in '${event.id}' id`)
    nonBlank(call.name, `native tool call '${call.callId}' name`)
    nonBlank(call.arguments, `native tool call '${call.callId}' arguments`)
    return call.callId
  })
  if (new Set(callIds).size !== callIds.length) throw new Error(`native assistant '${event.id}' has duplicate tool call ids`)
  const visible = event.content.length === 0
    ? []
    : content(event.content, `native assistant '${event.id}'`)
  if (visible.length === 0 && calls.length === 0) {
    throw new Error(`native assistant '${event.id}' must contain content or a tool call`)
  }
  const message = createAssistantMessage({
    content: [
      ...visible,
      ...calls.map(call => ({ type: 'tool-call' as const, id: call.callId as CallId, name: call.name, arguments: call.arguments })),
    ],
    source: { provider: event.provider, model: event.model },
  })
  appendSurface(events, 'assistant/message', event.time, { turn, step, message })
  for (const call of calls) append(events, 'tool/call', event.time, { turn, step, callId: call.callId as CallId, name: call.name, arguments: call.arguments })
  return callIds
}

function appendToolResult(
  events: SeedEvent[],
  event: Extract<NativeSemanticEvent, { kind: 'tool-result' }>,
  turn: number,
  step: number,
): void {
  nonBlank(event.callId, `native tool result '${event.id}' call id`)
  const message = createToolResultMessage({
    callId: event.callId as CallId,
    content: content(event.content, `native tool result '${event.id}'`),
    isError: event.isError ?? false,
  })
  appendSurface(events, 'tool/result', event.time, { turn, step, message })
}

/**
 * Convert a validated semantic native transcript into a DSH seed.
 *
 * The builder deliberately emits only completed turns. It refuses ambiguous
 * tool chains instead of producing a plausible but incorrect model history.
 */
export function buildDshSeed(input: readonly NativeSemanticEvent[]): DshSessionEvent[] {
  if (input.length === 0) throw new Error('native transcript must not be empty')
  const ordered = [...input]
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.turn < ordered[index - 1]!.turn) {
      throw new Error('native transcript turns must be in non-decreasing order')
    }
  }
  const turnIds = [...new Set(ordered.map(event => event.turn))]
  if (turnIds.some(turn => !Number.isSafeInteger(turn) || turn < 0)) throw new Error('native transcript has an invalid turn')
  const events: SeedEvent[] = []
  for (const turn of turnIds) {
    const turnEvents = ordered.filter(event => event.turn === turn)
    if (turnEvents.length === 0) continue
    append(events, 'turn/start', timeOf(turnEvents[0]!), { turn })
    let step = 1
    let open = false
    let hasAssistant = false
    const pendingCalls = new Set<string>()
    const start = (time: number): void => {
      openStep(events, turn, step, time)
      open = true
      hasAssistant = false
      pendingCalls.clear()
    }
    const finish = (time: number): void => {
      if (!open) return
      if (pendingCalls.size > 0) throw new Error(`native turn ${turn} has unpaired tool calls: ${[...pendingCalls].join(', ')}`)
      closeStep(events, turn, step, time)
      open = false
      step += 1
    }
    for (let index = 0; index < turnEvents.length; index += 1) {
      const event = turnEvents[index]!
      const time = timeOf(event)
      if (event.kind === 'user') {
        if (open && hasAssistant) finish(time)
        if (!open) start(time)
        appendUser(events, event)
        continue
      }
      if (event.kind === 'assistant') {
        if (open && hasAssistant) finish(time)
        if (!open) start(time)
        const calls = appendAssistant(events, event, turn, step)
        for (const callId of calls) pendingCalls.add(callId)
        hasAssistant = true
        if (pendingCalls.size === 0) {
          const next = turnEvents[index + 1]
          if (next === undefined || next.kind !== 'tool-result') finish(time)
        }
        continue
      }
      if (!open || !hasAssistant || !pendingCalls.has(event.callId)) {
        throw new Error(`native tool result '${event.id}' does not match an open tool call`)
      }
      appendToolResult(events, event, turn, step)
      pendingCalls.delete(event.callId)
      const next = turnEvents[index + 1]
      if (pendingCalls.size === 0 && (next === undefined || next.kind !== 'assistant')) finish(time)
    }
    if (open) finish(timeOf(turnEvents.at(-1)!))
    append(events, 'turn/end', timeOf(turnEvents.at(-1)!), { turn, reason: { kind: 'completed' } })
  }
  return events as DshSessionEvent[]
}
