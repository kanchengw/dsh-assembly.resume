import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import {
  discoverNativeSessions,
  type NativeSessionDiscoveryConfig,
  type NativeSessionSummary,
} from 'dsh-assembly.core/native-session'
import type {
  DiscoveredExternalSession,
  DiscoverExternalSessionsInput,
  ExternalProvider,
  ExternalSessionId,
  NativeTranscriptSnapshot,
} from './types.ts'

/** Raised when a requested native session id is absent from provider storage. */
export class NativeSessionNotFoundError extends Error {
  constructor(provider: ExternalProvider, sessionId: ExternalSessionId) {
    super(`native ${provider} session '${sessionId}' was not found`)
    this.name = 'NativeSessionNotFoundError'
  }
}
import type { NativeContentBlock, NativeSemanticEvent, NativeToolCall } from './transcript.ts'

const MAX_FILE_BYTES = 32 * 1024 * 1024
// Bump when the semantic import contract changes so old seeded sessions are not reused.
const IMPORT_FINGERPRINT_VERSION = '8'

/** Environment and local-store options for the supported native surfaces. */
export type ProviderConfig = NativeSessionDiscoveryConfig

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

async function readJsonl(path: string, strict: boolean): Promise<{ rows: unknown[]; sourceRevision?: string }> {
  let source: string
  let fileSize: number
  let modifiedAt: number
  try {
    const file = await stat(path)
    fileSize = file.size
    modifiedAt = file.mtimeMs
    if (file.size > MAX_FILE_BYTES) {
      if (strict) throw new Error(`native transcript '${path}' exceeds ${MAX_FILE_BYTES} bytes`)
      return { rows: [] }
    }
    source = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if (strict) throw error
    return { rows: [] }
  }
  const rows: unknown[] = []
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) continue
    try {
      rows.push(JSON.parse(line) as unknown)
    } catch (error: unknown) {
      if (strict) throw new Error(`native transcript '${path}' has invalid JSON at line ${index + 1}`, { cause: error })
    }
  }
  const sourceRevision = createHash('sha256')
    .update(source)
    .update(`\0${fileSize}\0${modifiedAt}`)
    .digest('hex')
  return { rows, sourceRevision }
}

function textFromUnknown(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value.map(textFromUnknown).filter((part): part is string => part !== undefined)
    return parts.length === 0 ? undefined : parts.join('')
  }
  const object = record(value)
  if (object === undefined) return undefined
  for (const key of ['text', 'output_text', 'message', 'content', 'result', 'output', 'input']) {
    const text = textFromUnknown(object[key])
    if (text !== undefined) return text
  }
  return undefined
}

const CODEX_LEGACY_EXEC_TASK_PREFIX = 'Your task is to perform the following. Follow the instructions below exactly.'
const CODEX_AMBIENT_CONTEXT_OPEN = '<in-app-browser-context source="ambient-ui-state">'
const CODEX_AMBIENT_CONTEXT_CLOSE = '</in-app-browser-context>'
const CODEX_ATTACHMENT_ENVELOPE_OPEN = '# Files mentioned by the user:'
const CODEX_REQUEST_HEADINGS = ['## My request:', '## My request for Codex:'] as const

/** Extract the actual submitted request from a Codex desktop UserMessage envelope. */
function codexUserText(value: string): string | undefined {
  const leading = value.trimStart()
  const attachmentEnvelope = leading.startsWith(CODEX_ATTACHMENT_ENVELOPE_OPEN)
  const ambientEnvelope = leading.startsWith(CODEX_AMBIENT_CONTEXT_OPEN)
  if (!attachmentEnvelope && !ambientEnvelope) return value
  let requestOffset = Number.POSITIVE_INFINITY
  let requestHeading: string | undefined
  for (const heading of CODEX_REQUEST_HEADINGS) {
    const offset = leading.indexOf(heading)
    if (offset >= 0 && offset < requestOffset) {
      requestOffset = offset
      requestHeading = heading
    }
  }
  if (requestHeading !== undefined) return leading.slice(requestOffset + requestHeading.length).trim()
  if (attachmentEnvelope) return undefined
  const closeAt = leading.indexOf(CODEX_AMBIENT_CONTEXT_CLOSE, CODEX_AMBIENT_CONTEXT_OPEN.length)
  if (closeAt < 0) return undefined
  const remainder = leading.slice(closeAt + CODEX_AMBIENT_CONTEXT_CLOSE.length).trimStart()
  return remainder.trim().length === 0 ? undefined : remainder.trim()
}

/** Legacy exec sessions store their generated task envelope as a user_message. */
function isCodexLegacyExecTask(payload: Record<string, unknown> | undefined, meta: Record<string, unknown> | undefined): boolean {
  if (meta?.['source'] !== 'exec' || meta?.['history_mode'] !== 'legacy' || payload?.['type'] !== 'user_message') return false
  return textFromUnknown(payload['message'])?.trimStart().startsWith(CODEX_LEGACY_EXEC_TASK_PREFIX) === true
}

function nativeContent(value: unknown): NativeContentBlock[] {
  if (typeof value === 'string') return value.trim().length === 0 ? [] : [{ type: 'text', text: value }]
  if (!Array.isArray(value)) {
    const object = record(value)
    if (object === undefined) return []
    const type = typeof object['type'] === 'string' ? object['type'] : undefined
    if (type?.includes('thinking') || type?.includes('reasoning')) return []
    const text = textFromUnknown(object['text'] ?? object['output_text'])
    if (text !== undefined && text.trim().length > 0 && (type === undefined || type.includes('text'))) return [{ type: 'text', text }]
    return nativeContent(object['content'] ?? object['message'] ?? object['result'] ?? object['output'])
  }
  const blocks: NativeContentBlock[] = []
  for (const item of value) {
    const object = record(item)
    if (object !== undefined) {
      const type = typeof object['type'] === 'string' ? object['type'] : ''
      const text = textFromUnknown(object['text'] ?? object['output_text'] ?? object['thinking'])
      if (type.includes('thinking') || type.includes('reasoning')) continue
      if (text !== undefined && text.trim().length > 0 && (type === '' || type.includes('text') || type.includes('thinking') || type.includes('reasoning'))) {
        blocks.push({ type: 'text', text })
        continue
      }
    }
    blocks.push(...nativeContent(item))
  }
  return blocks
}

function codexUserContent(value: unknown): NativeContentBlock[] {
  const blocks = nativeContent(value)
  const serialized = blocks.map(block => block.text).join('')
  const text = codexUserText(serialized)
  if (text === undefined) return []
  if (text === serialized) return blocks
  return text.trim().length === 0 ? [] : [{ type: 'text', text }]
}

function eventTime(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value < 10_000_000_000 ? value * 1000 : value))
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function pushAssistant(events: NativeSemanticEvent[], event: Extract<NativeSemanticEvent, { kind: 'assistant' }>): void {
  const duplicate = events.some(existing => existing.kind === 'assistant'
    && existing.turn === event.turn
    && JSON.stringify(existing.content) === JSON.stringify(event.content)
    && JSON.stringify(existing.toolCalls ?? []) === JSON.stringify(event.toolCalls ?? []))
  if (duplicate) return
  events.push(event)
}

function codexModel(meta: Record<string, unknown> | undefined): { provider: string; model: string } {
  const provider = typeof meta?.['model_provider'] === 'string' && meta['model_provider'].length > 0
    ? meta['model_provider']
    : 'codex-native'
  const model = typeof meta?.['model'] === 'string' && meta['model'].length > 0
    ? meta['model']
    : 'codex-native'
  return { provider, model }
}

function codexToolArguments(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim().length === 0 ? undefined : value
  if (value === undefined) return undefined
  const serialized = JSON.stringify(value)
  return serialized === undefined || serialized.trim().length === 0 ? undefined : serialized
}

function codexToolCall(payload: Record<string, unknown>): NativeToolCall {
  const callId = typeof payload['call_id'] === 'string' ? payload['call_id'] : undefined
  const name = typeof payload['name'] === 'string' ? payload['name'] : undefined
  const argumentsText = codexToolArguments(payload['type'] === 'custom_tool_call' ? payload['input'] : payload['arguments'])
  if (callId === undefined || callId.trim().length === 0 || name === undefined || name.trim().length === 0 || argumentsText === undefined) {
    throw new Error('Codex transcript contains an invalid tool call')
  }
  return { callId, name, arguments: argumentsText }
}

function codexToolResult(payload: Record<string, unknown>): { callId: string; content: NativeContentBlock[]; isError: boolean } {
  const callId = typeof payload['call_id'] === 'string' ? payload['call_id'] : undefined
  if (callId === undefined || callId.trim().length === 0) throw new Error('Codex transcript contains an invalid tool result')
  return { callId, content: nativeContent(payload['output']), isError: payload['is_error'] === true }
}

interface CodexToolBatch {
  readonly event: Extract<NativeSemanticEvent, { kind: 'assistant' }>
  readonly calls: NativeToolCall[]
}

/** Parse Codex JSONL into model-visible semantic events. */
export function parseCodexTranscript(rows: readonly unknown[]): NativeSemanticEvent[] {
  const events: NativeSemanticEvent[] = []
  const pendingToolCalls = new Map<string, CodexToolBatch>()
  let activeToolBatch: CodexToolBatch | undefined
  let turn = 0
  const meta = record(rows.map(record).find(row => row?.['type'] === 'session_meta')?.['payload'])
  const model = codexModel(meta)
  let ordinal = 0
  for (const raw of rows) {
    const row = record(raw)
    if (row === undefined) continue
    const payload = record(row['payload'])
    const timestamp = eventTime(row['timestamp'] ?? payload?.['timestamp'], ordinal++)
    const item = record(payload?.['item'])
    const isUser = (row['type'] === 'event_msg' && payload?.['type'] === 'user_message' && !isCodexLegacyExecTask(payload, meta))
      || (row['type'] === 'event_msg' && payload?.['type'] === 'item_completed' && item?.['type'] === 'UserMessage')
    const isAssistant = (row['type'] === 'event_msg' && payload?.['type'] === 'agent_message')
      || (row['type'] === 'response_item' && payload?.['type'] === 'message' && payload['role'] === 'assistant')
    const isToolCall = row['type'] === 'response_item'
      && (payload?.['type'] === 'function_call' || payload?.['type'] === 'custom_tool_call')
    const isToolResult = row['type'] === 'response_item'
      && (payload?.['type'] === 'function_call_output' || payload?.['type'] === 'custom_tool_call_output')
    if (!isUser && !isAssistant && !isToolCall && !isToolResult) continue
    if (isUser || turn < 0) turn += 1
    if (isUser || isAssistant) activeToolBatch = undefined
    if (row['type'] === 'event_msg' && payload?.['type'] === 'user_message') {
      const content = codexUserContent(payload['message'])
      if (content.length > 0) events.push({ kind: 'user', id: `codex-user-${events.length}`, turn, time: timestamp, content })
      continue
    }
    if (row['type'] === 'event_msg' && payload?.['type'] === 'agent_message') {
      const content = nativeContent(payload['message'])
      if (content.length > 0) pushAssistant(events, { kind: 'assistant', id: `codex-agent-${events.length}`, turn, time: timestamp, content, ...model })
      continue
    }
    if (row['type'] === 'event_msg' && payload?.['type'] === 'item_completed') {
      if (item?.['type'] !== 'UserMessage') continue
      const content = codexUserContent(item['content'])
      if (content.length > 0) events.push({ kind: 'user', id: typeof item['id'] === 'string' ? item['id'] : `codex-user-${events.length}`, turn, time: timestamp, content })
      continue
    }
    if (row['type'] !== 'response_item' || payload === undefined) continue
    const payloadType = payload['type']
    if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
      const toolCall = codexToolCall(payload)
      if (pendingToolCalls.has(toolCall.callId)) throw new Error(`Codex transcript contains a duplicate tool call '${toolCall.callId}'`)
      if (activeToolBatch === undefined || activeToolBatch.event.turn !== turn) {
        const calls: NativeToolCall[] = []
        const event: Extract<NativeSemanticEvent, { kind: 'assistant' }> = {
          kind: 'assistant',
          id: typeof payload['id'] === 'string' ? payload['id'] : `codex-tool-call-${events.length}`,
          turn,
          time: timestamp,
          content: [],
          toolCalls: calls,
          ...model,
        }
        activeToolBatch = { event, calls }
        events.push(event)
      }
      activeToolBatch.calls.push(toolCall)
      pendingToolCalls.set(toolCall.callId, activeToolBatch)
      continue
    }
    if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
      const result = codexToolResult(payload)
      const batch = pendingToolCalls.get(result.callId)
      if (batch === undefined) throw new Error(`Codex tool result '${result.callId}' does not match an open tool call`)
      pendingToolCalls.delete(result.callId)
      if (result.content.length === 0) {
        const callIndex = batch.calls.findIndex(call => call.callId === result.callId)
        if (callIndex >= 0) batch.calls.splice(callIndex, 1)
        if (batch.calls.length === 0) {
          const eventIndex = events.indexOf(batch.event)
          if (eventIndex >= 0) events.splice(eventIndex, 1)
        }
        if (![...pendingToolCalls.values()].some(pending => pending === batch)) activeToolBatch = undefined
        continue
      }
      events.push({
        kind: 'tool-result',
        id: typeof payload['id'] === 'string' ? payload['id'] : `codex-tool-result-${events.length}`,
        turn,
        time: timestamp,
        callId: result.callId,
        content: result.content,
        ...(result.isError ? { isError: true } : {}),
      })
      if (![...pendingToolCalls.values()].some(pending => pending === batch)) activeToolBatch = undefined
      continue
    }
    if (payloadType === 'message' && payload['role'] === 'assistant') {
      const content = nativeContent(payload['content'])
      if (content.length > 0) pushAssistant(events, { kind: 'assistant', id: typeof payload['id'] === 'string' ? payload['id'] : `codex-message-${events.length}`, turn, time: timestamp, content, ...model })
    }
  }
  return events
}

function claudeTurn(
  row: Record<string, unknown>,
  state: { current: number; lastUserPromptId: string | undefined },
  startsUserTurn: boolean,
): number {
  if (startsUserTurn) {
    const promptId = typeof row['promptId'] === 'string' ? row['promptId'] : undefined
    if (state.current < 0 || promptId === undefined || promptId !== state.lastUserPromptId) state.current += 1
    state.lastUserPromptId = promptId
  } else if (state.current < 0) {
    state.current = 0
  }
  return state.current
}

/** Parse Claude Code JSONL into model-visible semantic events. */
export function parseClaudeTranscript(rows: readonly unknown[]): NativeSemanticEvent[] {
  const events: NativeSemanticEvent[] = []
  const state: { current: number; lastUserPromptId: string | undefined } = { current: 0, lastUserPromptId: undefined }
  let ordinal = 0
  for (const raw of rows) {
    const row = record(raw)
    if (row === undefined || row['isMeta'] === true) continue
    const timestamp = eventTime(row['timestamp'], ordinal++)
    const message = record(row['message'])
    if (row['type'] === 'user') {
      const blocks = Array.isArray(message?.['content']) ? message['content'] : message?.['content']
      if (Array.isArray(blocks) && blocks.some(item => record(item)?.['type'] === 'tool_result')) {
        const turn = claudeTurn(row, state, false)
        for (const item of blocks) {
          const block = record(item)
          if (block?.['type'] !== 'tool_result') continue
          const callId = typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : undefined
          const content = nativeContent(block['content'])
          if (callId === undefined || content.length === 0) throw new Error('Claude transcript contains an invalid tool result')
          events.push({ kind: 'tool-result', id: typeof row['uuid'] === 'string' ? row['uuid'] : `claude-result-${events.length}`, turn, time: timestamp, callId, content })
        }
      } else {
        const content = nativeContent(blocks)
        if (content.length > 0) {
          const turn = claudeTurn(row, state, true)
          events.push({ kind: 'user', id: typeof row['uuid'] === 'string' ? row['uuid'] : `claude-user-${events.length}`, turn, time: timestamp, content })
        }
      }
      continue
    }
    if (row['type'] !== 'assistant' || message === undefined) continue
    const rawBlocks = Array.isArray(message['content']) ? message['content'] : [message['content']]
    const toolCalls: NativeToolCall[] = []
    const visible: NativeContentBlock[] = []
    for (const item of rawBlocks) {
      const block = record(item)
      if (block?.['type'] === 'tool_use') {
        const callId = typeof block['id'] === 'string' ? block['id'] : undefined
        const name = typeof block['name'] === 'string' ? block['name'] : undefined
        const input = JSON.stringify(block['input'] ?? {})
        if (callId === undefined || name === undefined) throw new Error('Claude transcript contains an invalid tool call')
        toolCalls.push({ callId, name, arguments: input })
      } else visible.push(...nativeContent(item))
    }
    if (visible.length === 0 && toolCalls.length === 0) continue
    const turn = claudeTurn(row, state, false)
    const model = typeof message['model'] === 'string' && message['model'].length > 0 ? message['model'] : 'claude-code-native'
    pushAssistant(events, {
      kind: 'assistant',
      id: typeof row['uuid'] === 'string' ? row['uuid'] : `claude-assistant-${events.length}`,
      turn,
      time: timestamp,
      content: visible,
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
      provider: 'claude-code-native',
      model,
    })
  }
  return events
}

function toDiscoveredExternalSession(session: NativeSessionSummary): DiscoveredExternalSession {
  return {
    provider: session.provider,
    externalSessionId: session.nativeSessionId as unknown as ExternalSessionId,
    cwd: session.cwd,
    ...(session.projectPath === undefined ? {} : { projectPath: session.projectPath }),
    ...(session.projectPathAvailable === undefined ? {} : { projectPathAvailable: session.projectPathAvailable }),
    sourcePath: session.sourcePath,
    ...(session.createdAt === undefined ? {} : { createdAt: session.createdAt }),
    ...(session.updatedAt === undefined ? {} : { updatedAt: session.updatedAt }),
    ...(session.title === undefined ? {} : { title: session.title }),
    ...(session.firstUserMessage === undefined ? {} : { firstUserMessage: session.firstUserMessage }),
    ...(session.lastUserMessage === undefined ? {} : { lastUserMessage: session.lastUserMessage }),
    resumable: session.resumable,
  }
}

/** Discover native sessions without loading complete transcripts into the API. */
export async function discoverExternalSessions(input: DiscoverExternalSessionsInput = {}, config: ProviderConfig = {}): Promise<DiscoveredExternalSession[]> {
  const sessions = await discoverNativeSessions(input, config)
  return sessions
    .filter(session => session.provider !== 'codex' || session.codexSource !== 'appServer')
    .map(toDiscoveredExternalSession)
}

/** Read and normalize one selected native transcript. */
export async function inspectExternalSession(input: { provider: ExternalProvider; externalSessionId: ExternalSessionId }, config: ProviderConfig = {}): Promise<NativeTranscriptSnapshot> {
  const discovered = await discoverExternalSessions({ provider: input.provider }, config)
  const session = discovered.find(row => row.externalSessionId === input.externalSessionId)
  if (session === undefined) throw new NativeSessionNotFoundError(input.provider, input.externalSessionId)
  const source = await readJsonl(session.sourcePath, true)
  const events = input.provider === 'codex' ? parseCodexTranscript(source.rows) : parseClaudeTranscript(source.rows)
  if (events.length === 0) throw new Error(`native ${input.provider} session '${input.externalSessionId}' has no importable semantic history`)
  const sourceRevision = source.sourceRevision ?? createHash('sha256').update(session.sourcePath).digest('hex')
  const fingerprint = createHash('sha256').update(`${IMPORT_FINGERPRINT_VERSION}\0${input.provider}\0${input.externalSessionId}\0${sourceRevision}`).digest('hex')
  return { session, sourceRevision, fingerprint, events }
}
