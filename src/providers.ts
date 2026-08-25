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
// Bump when the semantic import contract changes so old seeded sessions are not reused.
const IMPORT_FINGERPRINT_VERSION = '7'

/** Environment and local-store options for the supported native surfaces. */
export interface ProviderConfig {
  readonly codexHome?: string
  readonly codexIndex?: string
  readonly codexNewChatRoot?: string
  readonly claudeHome?: string
  /** Claude Desktop's metadata-only session index root. */
  readonly claudeDesktopHome?: string
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

function isCodexSubagent(payload: Record<string, unknown> | undefined): boolean {
  return payload?.['thread_source'] === 'subagent' || record(payload?.['source'])?.['subagent'] !== undefined
}

async function filesUnder(root: string, suffix = '.jsonl'): Promise<string[]> {
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
      else if (entry.isFile() && path.endsWith(suffix)) result.push(path)
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

async function readJsonRecord(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const file = await stat(path)
    if (file.size > MAX_FILE_BYTES) return undefined
    return record(JSON.parse(await readFile(path, 'utf8')) as unknown)
  } catch {
    return undefined
  }
}

interface DiscoveredSessionCandidate {
  readonly session: DiscoveredExternalSession
  readonly modifiedAt: number
}

/** Keep one canonical transcript when a provider retains copied session files. */
function deduplicateSessions(candidates: readonly DiscoveredSessionCandidate[]): DiscoveredExternalSession[] {
  const unique = new Map<string, DiscoveredSessionCandidate>()
  for (const candidate of candidates) {
    const key = `${candidate.session.provider}\0${candidate.session.externalSessionId}`
    const previous = unique.get(key)
    if (previous === undefined
      || candidate.modifiedAt > previous.modifiedAt
      || (candidate.modifiedAt === previous.modifiedAt && candidate.session.sourcePath > previous.session.sourcePath)) {
      unique.set(key, candidate)
    }
  }
  return [...unique.values()].map(candidate => candidate.session)
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

/** Parse Codex JSONL into model-visible semantic events. */
export function parseCodexTranscript(rows: readonly unknown[]): NativeSemanticEvent[] {
  const events: NativeSemanticEvent[] = []
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
    if (!isUser && !isAssistant) continue
    if (isUser || turn < 0) turn += 1
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
      // Native tool invocations are tied to the original Codex runtime and
      // cannot be resumed safely in DSH; import only visible conversation.
      continue
    }
    if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
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

function isoTime(value: unknown): string | undefined {
  const timestamp = eventTime(value, Number.NaN)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined
}

/** Read only Codex event shapes that represent an actual submitted user prompt. */
function codexPreviewText(row: Record<string, unknown>, meta: Record<string, unknown> | undefined): string | undefined {
  if (row['type'] !== 'event_msg') return undefined
  const payload = record(row['payload'])
  if (isCodexLegacyExecTask(payload, meta)) return undefined
  if (payload?.['type'] === 'user_message') {
    return bounded(codexUserContent(payload['message']).map(block => block.text).join(''))
  }
  const item = record(payload?.['item'])
  if (payload?.['type'] !== 'item_completed' || item?.['type'] !== 'UserMessage') return undefined
  return bounded(codexUserContent(item['content']).map(block => block.text).join(''))
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

async function discoverCodex(root: string, indexPath?: string, newChatRoot = join(homedir(), 'Documents', 'Codex')): Promise<DiscoveredExternalSession[]> {
  const result: DiscoveredSessionCandidate[] = []
  const index = indexPath === undefined ? new Map<ExternalSessionId, CodexIndexEntry>() : await readCodexIndex(indexPath)
  for (const path of await filesUnder(root)) {
    const rows = (await readJsonl(path, false)).rows
    const meta = rows.map(record).find(row => row?.['type'] === 'session_meta')
    const payload = record(meta?.['payload'])
    if (isCodexSubagent(payload)) continue
    const sessionId = sessionIdOf(payload?.['id'] ?? payload?.['session_id'])
    const cwd = cwdOf(payload?.['cwd'])
    if (sessionId === undefined || cwd === undefined) continue
    const users: string[] = []
    let hasLegacyExecTask = false
    for (const row of rows.map(record)) {
      if (row === undefined) continue
      const rowPayload = record(row['payload'])
      if (isCodexLegacyExecTask(rowPayload, payload)) hasLegacyExecTask = true
      const text = codexPreviewText(row, payload)
      if (text !== undefined) users.push(text)
    }
    if (users.length === 0 && hasLegacyExecTask) continue
    const file = await stat(path).catch(() => undefined)
    const indexEntry = index.get(sessionId)
    const title = indexEntry?.title ?? titleFromMessage(users[0])
    const lastUser = users.at(-1)
    const projectPath = codexProjectPath(cwd, newChatRoot)
    result.push({
      modifiedAt: file?.mtimeMs ?? 0,
      session: {
        provider: 'codex', externalSessionId: sessionId, cwd,
        ...(projectPath === undefined ? {} : { projectPath }), sourcePath: path,
        ...(typeof payload?.['timestamp'] === 'string' ? { createdAt: payload['timestamp'] } : {}),
        ...(indexEntry?.updatedAt !== undefined ? { updatedAt: indexEntry.updatedAt } : file === undefined ? {} : { updatedAt: file.mtime.toISOString() }),
        ...(title === undefined ? {} : { title }),
        ...(users[0] === undefined ? {} : { firstUserMessage: users[0] }),
        ...(lastUser === undefined ? {} : { lastUserMessage: lastUser }),
        resumable: true,
      },
    })
  }
  return deduplicateSessions(result)
}

async function discoverClaude(root: string): Promise<DiscoveredExternalSession[]> {
  const result: DiscoveredSessionCandidate[] = []
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
      modifiedAt: file?.mtimeMs ?? 0,
      session: {
        provider: 'claude-code', externalSessionId: sessionId, cwd, projectPath: cwd, sourcePath: path,
        ...(typeof firstRecord?.['timestamp'] === 'string' ? { createdAt: firstRecord['timestamp'] } : {}),
        ...(file === undefined ? {} : { updatedAt: file.mtime.toISOString() }),
        ...(title === undefined ? {} : { title }),
        ...(users[0] === undefined ? {} : { firstUserMessage: users[0] }),
        ...(lastUser === undefined ? {} : { lastUserMessage: lastUser }),
        resumable: true,
      },
    })
  }
  return deduplicateSessions(result)
}

interface ClaudeDesktopMetadata {
  readonly sessionId: ExternalSessionId
  readonly cliSessionId: ExternalSessionId
  readonly cwd?: string
  readonly title?: string
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly archived: boolean
  readonly importedFromCli: boolean
  readonly modifiedAt: number
}

function defaultClaudeDesktopRoots(): string[] {
  if (process.platform === 'win32') {
    const roaming = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming')
    const roots = [join(roaming, 'Claude', 'claude-code-sessions')]
    const local = process.env['LOCALAPPDATA']
    if (local !== undefined) roots.push(join(local, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions'))
    return roots
  }
  if (process.platform === 'darwin') return [join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions')]
  return []
}

async function readClaudeDesktopMetadata(roots: readonly string[]): Promise<ClaudeDesktopMetadata[]> {
  const result = new Map<ExternalSessionId, ClaudeDesktopMetadata>()
  for (const root of roots) {
    for (const path of await filesUnder(root, '.json')) {
      const value = await readJsonRecord(path)
      const sessionId = sessionIdOf(value?.['sessionId'])
      const cliSessionId = sessionIdOf(value?.['cliSessionId'])
      if (sessionId === undefined || cliSessionId === undefined || !sessionId.startsWith('local_')) continue
      const file = await stat(path).catch(() => undefined)
      const cwd = cwdOf(value?.['cwd'] ?? value?.['originCwd'])
      const title = titleFromMessage(typeof value?.['title'] === 'string' ? value['title'] : undefined)
      const createdAt = isoTime(value?.['createdAt'])
      const updatedAt = isoTime(value?.['lastActivityAt'] ?? value?.['lastFocusedAt'])
      const metadata: ClaudeDesktopMetadata = {
        sessionId,
        cliSessionId,
        ...(cwd === undefined ? {} : { cwd }),
        ...(title === undefined ? {} : { title }),
        ...(createdAt === undefined ? {} : { createdAt }),
        ...(updatedAt === undefined ? {} : { updatedAt }),
        archived: value?.['isArchived'] === true,
        importedFromCli: sessionId === `local_${cliSessionId}`,
        modifiedAt: file?.mtimeMs ?? 0,
      }
      const previous = result.get(sessionId)
      if (previous === undefined || metadata.modifiedAt > previous.modifiedAt) result.set(sessionId, metadata)
    }
  }
  return [...result.values()]
}

function discoverClaudeDesktop(metadata: readonly ClaudeDesktopMetadata[], transcripts: readonly DiscoveredExternalSession[]): DiscoveredExternalSession[] {
  const byCliSessionId = new Map(transcripts.map(session => [session.externalSessionId, session]))
  return metadata.flatMap((entry) => {
    if (entry.archived || entry.importedFromCli) return []
    const transcript = byCliSessionId.get(entry.cliSessionId)
    if (transcript === undefined) return []
    const cwd = entry.cwd ?? transcript.cwd
    return [{
      ...transcript,
      provider: 'claude-code-desktop' as const,
      externalSessionId: entry.sessionId,
      cwd,
      projectPath: cwd,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      ...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
      ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
    }]
  })
}

/** Discover native sessions without loading complete transcripts into the API. */
export async function discoverExternalSessions(input: DiscoverExternalSessionsInput = {}, config: ProviderConfig = {}): Promise<DiscoveredExternalSession[]> {
  const codexRoot = config.codexHome ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex', 'sessions')
  const codexIndex = config.codexIndex ?? join(basename(codexRoot).toLowerCase() === 'sessions' ? dirname(codexRoot) : codexRoot, 'session_index.jsonl')
  const claudeRoot = config.claudeHome ?? process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude', 'projects')
  const claudeDesktopRoots = config.claudeDesktopHome === undefined ? defaultClaudeDesktopRoots() : [config.claudeDesktopHome]
  const providers = input.provider === undefined ? ['codex', 'claude-code', 'claude-code-desktop'] as const : [input.provider]
  const wantsClaude = providers.includes('claude-code') || providers.includes('claude-code-desktop')
  const claudeSessions = wantsClaude ? await discoverClaude(claudeRoot) : []
  const desktopMetadata = wantsClaude ? await readClaudeDesktopMetadata(claudeDesktopRoots) : []
  const nativeDesktopCliIds = new Set(desktopMetadata.filter(entry => !entry.importedFromCli).map(entry => entry.cliSessionId))
  const rows = [
    ...(providers.includes('codex') ? await discoverCodex(codexRoot, codexIndex, config.codexNewChatRoot) : []),
    ...(providers.includes('claude-code') ? claudeSessions.filter(session => !nativeDesktopCliIds.has(session.externalSessionId)) : []),
    ...(providers.includes('claude-code-desktop') ? discoverClaudeDesktop(desktopMetadata, claudeSessions) : []),
  ]
  const query = input.query?.trim().toLowerCase()
  return rows
    .filter(row => input.cwd === undefined || normalize(row.cwd) === normalize(input.cwd))
    .filter(row => query === undefined || [row.externalSessionId, row.title, row.firstUserMessage, row.lastUserMessage, row.cwd].some(value => value?.toLowerCase().includes(query)))
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
  const fingerprint = createHash('sha256').update(`${IMPORT_FINGERPRINT_VERSION}\0${input.provider}\0${input.externalSessionId}\0${sourceRevision}`).digest('hex')
  return { session, sourceRevision, fingerprint, events }
}
