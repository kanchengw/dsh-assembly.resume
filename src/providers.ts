import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
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
const MAX_PREVIEW_CHARS = 400
const MAX_TITLE_CHARS = 80
const DEFAULT_LIMIT = 100

/** Environment and local-store options for the two native providers. */
export interface ProviderConfig {
  readonly codexHome?: string
  readonly codexIndex?: string
  readonly codexNewChatRoot?: string
  readonly claudeHome?: string
}

function bounded(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (normalized.length === 0) return undefined
  return normalized.length <= MAX_PREVIEW_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_PREVIEW_CHARS - 1)}…`
}

function titleFromMessage(value: string | undefined): string | undefined {
  const normalized = bounded(value)
  if (normalized === undefined) return undefined
  return normalized.length <= MAX_TITLE_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_TITLE_CHARS - 1)}…`
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function sessionIdOf(value: unknown): ExternalSessionId | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value as ExternalSessionId : undefined
}

function cwdOf(value: unknown): string | undefined {
  return typeof value === 'string' && isAbsolute(value) ? normalize(value) : undefined
}

function comparablePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/u, '')
  return /^[a-z]:\//iu.test(normalized) ? normalized.toLowerCase() : normalized
}

function isUnderPath(candidate: string, root: string): boolean {
  const child = comparablePath(candidate)
  const parent = comparablePath(root)
  return child === parent || child.startsWith(`${parent}/`)
}

function codexProjectPath(cwd: string, newChatRoot: string): string | undefined {
  if (isUnderPath(cwd, newChatRoot)) {
    const relative = comparablePath(cwd).slice(comparablePath(newChatRoot).length).replace(/^\/+|\/+$/gu, '')
    const [dateSegment] = relative.split('/')
    if (/^\d{4}-\d{2}-\d{2}$/u.test(dateSegment ?? '')) return undefined
  }
  const normalized = comparablePath(cwd)
  if (/\/AppData\/Roaming\/AionUi\/aionui\/conversations\/users\//iu.test(normalized)) return undefined
  return cwd
}

async function filesUnder(root: string): Promise<string[]> {
  const result: string[] = []
  const visit = async (directory: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && path.endsWith('.jsonl')) result.push(path)
    }
  }
  await visit(root)
  return result
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

interface CodexIndexEntry {
  readonly title?: string
  readonly updatedAt?: string
}

async function readCodexIndex(path: string): Promise<Map<ExternalSessionId, CodexIndexEntry>> {
  const entries = new Map<ExternalSessionId, CodexIndexEntry>()
  for (const row of (await readJsonl(path, false)).rows) {
    const value = record(row)
    const id = sessionIdOf(value?.['id'] ?? value?.['session_id'])
    if (id === undefined) continue
    const title = titleFromMessage(typeof value?.['thread_name'] === 'string'
      ? value['thread_name']
      : typeof value?.['title'] === 'string' ? value['title'] : undefined)
    const updatedAt = typeof value?.['updated_at'] === 'string' ? value['updated_at'] : undefined
    entries.set(id, { ...(title === undefined ? {} : { title }), ...(updatedAt === undefined ? {} : { updatedAt }) })
  }
  return entries
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

function nativeContent(value: unknown): NativeContentBlock[] {
  if (typeof value === 'string') return value.length === 0 ? [] : [{ type: 'text', text: value }]
  if (!Array.isArray(value)) {
    const object = record(value)
    if (object === undefined) return []
    const type = typeof object['type'] === 'string' ? object['type'] : undefined
    if (type?.includes('thinking') || type?.includes('reasoning')) return []
    const text = textFromUnknown(object['text'] ?? object['output_text'])
    if (text !== undefined && (type === undefined || type.includes('text'))) return [{ type: 'text', text }]
    return nativeContent(object['content'] ?? object['message'] ?? object['result'] ?? object['output'])
  }
  const blocks: NativeContentBlock[] = []
  for (const item of value) {
    const object = record(item)
    if (object !== undefined) {
      const type = typeof object['type'] === 'string' ? object['type'] : ''
      const text = textFromUnknown(object['text'] ?? object['output_text'] ?? object['thinking'])
      if (type.includes('thinking') || type.includes('reasoning')) continue
      if (text !== undefined && (type === '' || type.includes('text') || type.includes('thinking') || type.includes('reasoning'))) {
        blocks.push({ type: 'text', text })
        continue
      }
    }
    blocks.push(...nativeContent(item))
  }
  return blocks
}

function eventTime(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value < 10_000_000_000 ? value * 1000 : value))
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function turnKey(row: Record<string, unknown>): string | undefined {
  const payload = record(row['payload'])
  const internal = record(payload?.['internal_chat_message_metadata_passthrough'])
  const value = payload?.['turn_id'] ?? row['turn_id'] ?? internal?.['turn_id'] ?? row['promptId']
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

function turnNumber(
  row: Record<string, unknown>,
  state: { keys: Map<string, number>; next: number; anonymous?: number; anonymousUserSeen: boolean },
): number {
  const key = turnKey(row)
  if (key === undefined) {
    const payload = record(row['payload'])
    const isUser = row['type'] === 'event_msg' && payload?.['type'] === 'user_message'
    const isSemantic = isUser
      || (row['type'] === 'event_msg' && payload?.['type'] === 'agent_message')
      || (row['type'] === 'response_item' && ['message', 'function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output'].includes(String(payload?.['type'])))
    if (!isSemantic) return state.anonymous ?? Math.max(0, state.next - 1)
    if (state.anonymous === undefined) {
      state.anonymous = state.next
      state.next += 1
    } else if (isUser && state.anonymousUserSeen) {
      state.anonymous = state.next
      state.next += 1
    }
    if (isUser) state.anonymousUserSeen = true
    return state.anonymous
  }
  const existing = state.keys.get(key)
  if (existing !== undefined) return existing
  const value = state.next
  state.keys.set(key, value)
  state.next += 1
  return value
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

/** Parse Codex JSONL into model-visible semantic events. */
export function parseCodexTranscript(rows: readonly unknown[]): NativeSemanticEvent[] {
  const events: NativeSemanticEvent[] = []
  const state = { keys: new Map<string, number>(), next: 0, anonymousUserSeen: false }
  const meta = record(rows.map(record).find(row => row?.['type'] === 'session_meta')?.['payload'])
  const model = codexModel(meta)
  let ordinal = 0
  for (const raw of rows) {
    const row = record(raw)
    if (row === undefined) continue
    const payload = record(row['payload'])
    const timestamp = eventTime(row['timestamp'] ?? payload?.['timestamp'], ordinal++)
    const turn = turnNumber(row, state)
    if (row['type'] === 'event_msg' && payload?.['type'] === 'user_message') {
      const content = nativeContent(payload['message'])
      if (content.length > 0) events.push({ kind: 'user', id: `codex-user-${events.length}`, turn, time: timestamp, content })
      continue
    }
    if (row['type'] === 'event_msg' && payload?.['type'] === 'agent_message') {
      const content = nativeContent(payload['message'])
      if (content.length > 0) pushAssistant(events, { kind: 'assistant', id: `codex-agent-${events.length}`, turn, time: timestamp, content, ...model })
      continue
    }
    if (row['type'] !== 'response_item' || payload === undefined) continue
    const payloadType = payload['type']
    if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
      const callId = typeof payload['call_id'] === 'string' ? payload['call_id'] : undefined
      const name = typeof payload['name'] === 'string' ? payload['name'] : undefined
      const argumentsValue = typeof payload['arguments'] === 'string' ? payload['arguments'] : typeof payload['input'] === 'string' ? payload['input'] : undefined
      if (callId === undefined || name === undefined || argumentsValue === undefined) throw new Error('Codex transcript contains an invalid tool call')
      const toolCalls: NativeToolCall[] = [{ callId, name, arguments: argumentsValue }]
      pushAssistant(events, { kind: 'assistant', id: `codex-call-${callId}`, turn, time: timestamp, content: [], toolCalls, ...model })
      continue
    }
    if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
      const callId = typeof payload['call_id'] === 'string' ? payload['call_id'] : undefined
      if (callId === undefined) throw new Error('Codex transcript contains a tool output without call_id')
      const output = nativeContent(payload['output'])
      if (output.length === 0) throw new Error(`Codex tool output '${callId}' has no content`)
      events.push({ kind: 'tool-result', id: `codex-result-${callId}-${events.length}`, turn, time: timestamp, callId, content: output })
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
  state: { keys: Map<string, number>; next: number; anonymous?: number; anonymousUserSeen: boolean },
): number {
  const key = typeof row['promptId'] === 'string' ? row['promptId'] : undefined
  if (key === undefined) {
    if (state.anonymous === undefined) {
      state.anonymous = state.next
      state.next += 1
    } else if (row['type'] === 'user' && state.anonymousUserSeen) {
      state.anonymous = state.next
      state.next += 1
    }
    if (row['type'] === 'user') state.anonymousUserSeen = true
    return state.anonymous
  }
  const existing = state.keys.get(key)
  if (existing !== undefined) return existing
  const value = state.next
  state.keys.set(key, value)
  state.next += 1
  return value
}

/** Parse Claude Code JSONL into model-visible semantic events. */
export function parseClaudeTranscript(rows: readonly unknown[]): NativeSemanticEvent[] {
  const events: NativeSemanticEvent[] = []
  const state = { keys: new Map<string, number>(), next: 0, anonymousUserSeen: false }
  let ordinal = 0
  for (const raw of rows) {
    const row = record(raw)
    if (row === undefined || row['isMeta'] === true) continue
    const timestamp = eventTime(row['timestamp'], ordinal++)
    const turn = claudeTurn(row, state)
    const message = record(row['message'])
    if (row['type'] === 'user') {
      const blocks = Array.isArray(message?.['content']) ? message['content'] : message?.['content']
      if (Array.isArray(blocks) && blocks.some(item => record(item)?.['type'] === 'tool_result')) {
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
        if (content.length > 0) events.push({ kind: 'user', id: typeof row['uuid'] === 'string' ? row['uuid'] : `claude-user-${events.length}`, turn, time: timestamp, content })
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

async function discoverCodex(root: string, indexPath?: string, newChatRoot = join(homedir(), 'Documents', 'Codex')): Promise<DiscoveredExternalSession[]> {
  const result: DiscoveredExternalSession[] = []
  const index = indexPath === undefined ? new Map<ExternalSessionId, CodexIndexEntry>() : await readCodexIndex(indexPath)
  for (const path of await filesUnder(root)) {
    const rows = (await readJsonl(path, false)).rows
    const meta = rows.map(record).find(row => row?.['type'] === 'session_meta')
    const payload = record(meta?.['payload'])
    const sessionId = sessionIdOf(payload?.['session_id'] ?? payload?.['id'])
    const cwd = cwdOf(payload?.['cwd'])
    if (sessionId === undefined || cwd === undefined) continue
    const users: string[] = []
    for (const row of rows.map(record)) {
      if (row?.['type'] !== 'event_msg') continue
      const rowPayload = record(row['payload'])
      if (rowPayload?.['type'] === 'user_message') {
        const text = bounded(textFromUnknown(rowPayload['message']))
        if (text !== undefined) users.push(text)
      }
    }
    const file = await stat(path).catch(() => undefined)
    const indexEntry = index.get(sessionId)
    const title = indexEntry?.title ?? titleFromMessage(users[0])
    const lastUser = users.at(-1)
    const projectPath = codexProjectPath(cwd, newChatRoot)
    result.push({
      provider: 'codex', externalSessionId: sessionId, cwd,
      ...(projectPath === undefined ? {} : { projectPath }), sourcePath: path,
      ...(typeof payload?.['timestamp'] === 'string' ? { createdAt: payload['timestamp'] } : {}),
      ...(indexEntry?.updatedAt !== undefined ? { updatedAt: indexEntry.updatedAt } : file === undefined ? {} : { updatedAt: file.mtime.toISOString() }),
      ...(title === undefined ? {} : { title }),
      ...(users[0] === undefined ? {} : { firstUserMessage: users[0] }),
      ...(lastUser === undefined ? {} : { lastUserMessage: lastUser }),
      resumable: true,
    })
  }
  return result
}

async function discoverClaude(root: string): Promise<DiscoveredExternalSession[]> {
  const result: DiscoveredExternalSession[] = []
  for (const path of await filesUnder(root)) {
    const rows = (await readJsonl(path, false)).rows
    const first = rows.map(record).find(row => row?.['type'] === 'user')
    const firstRecord = record(first)
    const sessionId = sessionIdOf(firstRecord?.['sessionId'])
    const cwd = cwdOf(firstRecord?.['cwd'])
    if (sessionId === undefined || cwd === undefined) continue
    const slug = rows.map(record).map(row => row?.['slug']).find((value): value is string => typeof value === 'string')
    const users = rows.map(record).flatMap((row) => {
      if (row?.['type'] !== 'user') return []
      const text = bounded(textFromUnknown(record(row['message'])?.['content']))
      return text === undefined ? [] : [text]
    })
    const file = await stat(path).catch(() => undefined)
    const title = titleFromMessage(slug) ?? titleFromMessage(users[0])
    const lastUser = users.at(-1)
    result.push({
      provider: 'claude-code', externalSessionId: sessionId, cwd, projectPath: cwd, sourcePath: path,
      ...(typeof firstRecord?.['timestamp'] === 'string' ? { createdAt: firstRecord['timestamp'] } : {}),
      ...(file === undefined ? {} : { updatedAt: file.mtime.toISOString() }),
      ...(title === undefined ? {} : { title }),
      ...(users[0] === undefined ? {} : { firstUserMessage: users[0] }),
      ...(lastUser === undefined ? {} : { lastUserMessage: lastUser }),
      resumable: true,
    })
  }
  return result
}

/** Discover native sessions without loading complete transcripts into the API. */
export async function discoverExternalSessions(input: DiscoverExternalSessionsInput = {}, config: ProviderConfig = {}): Promise<DiscoveredExternalSession[]> {
  const codexRoot = config.codexHome ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex', 'sessions')
  const codexIndex = config.codexIndex ?? join(basename(codexRoot).toLowerCase() === 'sessions' ? dirname(codexRoot) : codexRoot, 'session_index.jsonl')
  const claudeRoot = config.claudeHome ?? process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude', 'projects')
  const providers = input.provider === undefined ? ['codex', 'claude-code'] as const : [input.provider]
  const rows = [
    ...(providers.includes('codex') ? await discoverCodex(codexRoot, codexIndex, config.codexNewChatRoot) : []),
    ...(providers.includes('claude-code') ? await discoverClaude(claudeRoot) : []),
  ]
  const query = input.query?.trim().toLowerCase()
  return rows
    .filter(row => input.cwd === undefined || normalize(row.cwd) === normalize(input.cwd))
    .filter(row => query === undefined || [row.title, row.firstUserMessage, row.lastUserMessage, row.cwd].some(value => value?.toLowerCase().includes(query)))
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    .slice(0, input.limit ?? DEFAULT_LIMIT)
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
  const fingerprint = createHash('sha256').update(`${input.provider}\0${input.externalSessionId}\0${sourceRevision}`).digest('hex')
  return { session, sourceRevision, fingerprint, events }
}
