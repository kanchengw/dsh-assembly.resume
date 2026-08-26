import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import s from '@deepseek-ai/schemastery'
import type { Agent, AgentHandle, AgentOptions, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  sessionResumeDomainSpec,
  storedSessionRecordSchema,
} from './spec.ts'
import { SessionResumeError } from './errors.ts'
import type {
  DiscoveredExternalSession,
  DiscoverExternalSessionsInput,
  ExternalProvider,
  ExternalSessionRecord,
  ExternalSessionRecordId,
  ExternalSessionResumeService,
  ExternalSessionStatus,
  ExternalSessionUpdate,
  ExternalSessionWorkspaceTarget,
  FindExternalSessionQuery,
  InspectExternalSessionInput,
  NativeTranscriptSnapshot,
  SessionLease,
  SessionLeaseToken,
  SessionOwnerId,
  StoredExternalSessionRecord,
  TakeOverExternalSessionInput,
  TakeOverResult,
} from './types.ts'
import { buildDshSeed } from './transcript.ts'
import { discoverExternalSessions, inspectExternalSession, NativeSessionNotFoundError, type ProviderConfig } from './providers.ts'

type MutableStoredExternalSessionRecord = {
  -readonly [Key in keyof StoredExternalSessionRecord]: StoredExternalSessionRecord[Key]
}

export type * from './types.ts'
export { SessionResumeError } from './errors.ts'
export {
  externalSessionErrorSchema,
  externalSessionRecordSchema,
  sessionResumeDomainSpec,
  storedSessionLeaseSchema,
  storedSessionRecordSchema,
} from './spec.ts'
export { buildDshSeed } from './transcript.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionResume: SessionResumeService
  }
}

/** Settings namespace that enrolls this plugin's card in the Plugins configuration surface. */
export const SESSION_RESUME_SETTINGS_NAMESPACE = settingsNamespace('session-resume')

// The card has no mutable preference yet; the registered namespace is the
// Plugins surface's discovery mechanism for independently shipped cards.
const SessionResumeSettingsSchema = s.object({})

/** Plugin configuration for native source discovery and DSH Agent takeover. */
export interface Config {
  /** Recover abandoned storage leases on startup without launching an Agent. */
  readonly autoRecover?: boolean
  /** Override native session directories for deployment or unit tests. */
  readonly providers?: ProviderConfig
  /** Optional DSH route used when reopening a takeover binding. */
  readonly agentOptions?: AgentOptions
}

const ALLOWED_STATUS_TRANSITIONS: Readonly<Record<ExternalSessionStatus, readonly ExternalSessionStatus[]>> = {
  ready: ['running', 'stale', 'detached', 'failed', 'closed'],
  running: ['ready', 'stale', 'failed'],
  stale: ['ready', 'running', 'detached', 'failed', 'closed'],
  detached: ['ready', 'closed'],
  failed: ['ready', 'stale', 'closed'],
  closed: [],
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}

function snapshotRecord(stored: StoredExternalSessionRecord): ExternalSessionRecord {
  const copy = structuredClone(stored) as MutableStoredExternalSessionRecord
  delete copy.lease
  return deepFreeze(copy)
}

function snapshotLease(lease: SessionLease): SessionLease {
  return Object.freeze({ ...lease })
}

function parseStoredRecord(value: unknown): StoredExternalSessionRecord {
  try {
    return storedSessionRecordSchema.parse(value)
  } catch (error: unknown) {
    throw new SessionResumeError(
      'RESUME_BINDING_CORRUPT',
      'takeover binding does not satisfy the durable schema',
      undefined,
      { cause: error },
    )
  }
}

function now(): string {
  return new Date().toISOString()
}

function ownerIdOf(value: string): SessionOwnerId {
  if (value.trim() !== value || value.length === 0) throw new SessionResumeError('SESSION_OPERATION_ABORTED', 'session owner id must be non-blank')
  return value as SessionOwnerId
}

async function existingDirectory(path: string): Promise<string | undefined> {
  try {
    const canonical = await realpath(path)
    return (await stat(canonical)).isDirectory() ? canonical : undefined
  } catch {
    return undefined
  }
}

async function resolveWorkspaceTarget(
  session: DiscoveredExternalSession,
  replacement: string | undefined,
): Promise<ExternalSessionWorkspaceTarget> {
  if (replacement !== undefined) {
    const path = await existingDirectory(replacement)
    if (path === undefined) {
      throw new SessionResumeError('SESSION_OPERATION_ABORTED', `replacement workspace '${replacement}' is not an existing directory`)
    }
    return { kind: 'replacement', activeCwd: path, workspacePath: path }
  }
  if (session.projectPath !== undefined) {
    const path = await existingDirectory(session.projectPath)
    return path === undefined ? { kind: 'unbound' } : { kind: 'source', activeCwd: path, workspacePath: path }
  }
  const cwd = await existingDirectory(session.cwd)
  return cwd === undefined ? { kind: 'unbound' } : { kind: 'source', activeCwd: cwd }
}

function targetKey(target: ExternalSessionWorkspaceTarget): string {
  return target.kind === 'unbound' ? '\0' : `${target.activeCwd}\0${target.workspacePath ?? ''}`
}

function recordTarget(record: ExternalSessionRecord): ExternalSessionWorkspaceTarget {
  return record.workspaceTarget ?? {
    kind: 'source',
    activeCwd: record.cwd,
    ...(record.projectPath === undefined ? {} : { workspacePath: record.projectPath }),
  }
}

function tokenOf(value: string): SessionLeaseToken {
  return value as SessionLeaseToken
}

function recordIdOf(value: string): ExternalSessionRecordId {
  return value as ExternalSessionRecordId
}

function storedLeaseOf(lease: SessionLease): StoredExternalSessionRecord['lease'] {
  return { ownerId: lease.ownerId, token: lease.token, acquiredAt: lease.acquiredAt }
}

function providerOf(value: string): ExternalProvider {
  if (value === 'codex' || value === 'claude-code' || value === 'claude-code-desktop') return value
  throw new SessionResumeError('RESUME_BINDING_CORRUPT', `unsupported native provider '${value}'`)
}

function effectiveAgentOptions(owner: Agent, configured: AgentOptions, requested?: AgentOptions): AgentOptions {
  return { ...owner.options, ...configured, ...requested }
}

/** Durable binding and DSH Agent takeover service. */
export class SessionResumeService extends TypertRemoteService implements ExternalSessionResumeService {
  static inject = ['storageDomain', 'agents']

  static Config: s<Config> = s.object({
    autoRecover: s.boolean().default(true),
    providers: s.any().default({}),
    agentOptions: s.any().default({}),
  })

  private table?: KvTable<ExternalSessionRecordId, StoredExternalSessionRecord>
  private operationTail: Promise<void> = Promise.resolve()
  private mutationAdmissionOpen = true
  private readonly providers: ProviderConfig
  private readonly defaultAgentOptions: AgentOptions
  private readonly autoRecover: boolean

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sessionResume')
    this.providers = config.providers ?? {}
    this.defaultAgentOptions = config.agentOptions ?? {}
    this.autoRecover = config.autoRecover ?? true
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.register(SESSION_RESUME_SETTINGS_NAMESPACE, SessionResumeSettingsSchema)
    })
  }

  /** Discover only bounded metadata; transcript bodies are read on selection. */
  @Remote('discover')
  discover(input?: DiscoverExternalSessionsInput): Promise<DiscoveredExternalSession[]> {
    return discoverExternalSessions(input ?? {}, this.providers)
  }

  /** Read and validate one complete semantic native transcript. */
  inspect(input: InspectExternalSessionInput): Promise<NativeTranscriptSnapshot> {
    return inspectExternalSession(input, this.providers).catch((error: unknown) => {
      if (error instanceof SessionResumeError) throw error
      if (error instanceof NativeSessionNotFoundError) {
        throw new SessionResumeError('RESUME_NATIVE_SESSION_NOT_FOUND', error.message, undefined, { cause: error })
      }
      throw new SessionResumeError('RESUME_TRANSCRIPT_INVALID', error instanceof Error ? error.message : String(error), undefined, { cause: error })
    })
  }

  /** Create a resumed DSH Agent directly from the standalone settings surface. */
  @Remote('takeOverStandalone')
  takeOverStandalone(input: TakeOverExternalSessionInput): Promise<TakeOverResult> {
    return this.takeOverWith(this.ctx.agents, this.defaultAgentOptions, input)
  }

  /** Import a native transcript and make a DSH Agent the live responder. */
  @Remote('takeOver')
  takeOver(agent: Agent, input: TakeOverExternalSessionInput): Promise<TakeOverResult> {
    return this.takeOverWith(agent.ctx.agents, effectiveAgentOptions(agent, this.defaultAgentOptions, input.agentOptions), input)
  }

  private async takeOverWith(agents: AgentRegistry, agentOptions: AgentOptions, input: TakeOverExternalSessionInput): Promise<TakeOverResult> {
    const snapshot = await this.inspect(input)
    const workspaceTarget = await resolveWorkspaceTarget(snapshot.session, input.targetWorkspacePath)
    const existing = (await this.find({ provider: input.provider, externalSessionId: input.externalSessionId }))
      .find(record => record.importFingerprint === snapshot.fingerprint
        && targetKey(recordTarget(record)) === targetKey(workspaceTarget)
        && record.status !== 'closed')
    if (existing !== undefined) {
      await this.ensureLiveAgent(agents, existing.dshSessionId, agentOptions)
      return { record: existing, dshSessionId: existing.dshSessionId, reused: true }
    }

    const dshSessionId = SessionId(`resume-${randomUUID()}`)
    let seed
    try {
      seed = buildDshSeed(snapshot.events)
    } catch (error: unknown) {
      throw new SessionResumeError('RESUME_TRANSCRIPT_INVALID', error instanceof Error ? error.message : String(error), undefined, { cause: error })
    }
    let handle: AgentHandle | undefined
    try {
      handle = await agents.create({
        sessionId: dshSessionId,
        seed,
        meta: workspaceTarget.kind === 'unbound' ? {} : { cwd: workspaceTarget.activeCwd },
        agentOptions,
      })
    } catch (error: unknown) {
      throw new SessionResumeError('RESUME_DSH_AGENT_START_FAILED', error instanceof Error ? error.message : String(error), undefined, { cause: error })
    }
    try {
      const record = await this.createBinding(snapshot, dshSessionId, workspaceTarget)
      return { record, dshSessionId, reused: false }
    } catch (error: unknown) {
      await handle?.dispose()
      throw error
    }
  }

  /** Reopen the DSH Agent that owns a previously imported DSH session. */
  @Remote('open')
  async open(agent: Agent, recordId: ExternalSessionRecordId): Promise<TakeOverResult> {
    const current = await this.get(recordId)
    if (current === undefined || current.status === 'closed') throw new SessionResumeError('RESUME_BINDING_NOT_FOUND', `takeover binding '${recordId}' was not found`)
    await this.ensureLiveAgent(agent.ctx.agents, current.dshSessionId, effectiveAgentOptions(agent, this.defaultAgentOptions, undefined))
    const record = current.status === 'ready' ? current : await this.updateStatus(recordId, 'ready')
    return { record, dshSessionId: current.dshSessionId, reused: true }
  }

  /** List bindings owned by the current DSH session. */
  @Remote('list')
  list(agent: Agent): Promise<ExternalSessionRecord[]> {
    return this.find({ dshSessionId: agent.session.id })
  }

  /** Detach the binding without touching the original native session. */
  @Remote('detach')
  async detach(agent: Agent, recordId: ExternalSessionRecordId): Promise<ExternalSessionRecord> {
    const current = await this.get(recordId)
    if (current === undefined || current.dshSessionId !== agent.session.id) throw new SessionResumeError('RESUME_BINDING_NOT_FOUND', `takeover binding '${recordId}' is not owned by the current DSH session`)
    return this.updateStatus(recordId, 'detached')
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(sessionResumeDomainSpec)
    this.ctx.effect(() => () => {
      this.mutationAdmissionOpen = false
      return domain.close()
    }, 'session-resume.domainClose')
    this.table = domain.table('sessions')
    if (this.autoRecover) await this.enqueue(() => this.recoverAbandonedOwnership())
  }

  private async createBinding(
    snapshot: NativeTranscriptSnapshot,
    dshSessionId: SessionId,
    workspaceTarget: ExternalSessionWorkspaceTarget,
  ): Promise<ExternalSessionRecord> {
    return this.enqueue(async () => {
      this.assertMutationAdmission()
      const timestamp = now()
      const raw: StoredExternalSessionRecord = {
        recordId: recordIdOf(`resume-${randomUUID()}`),
        provider: providerOf(snapshot.session.provider),
        externalSessionId: snapshot.session.externalSessionId,
        dshSessionId,
        cwd: snapshot.session.cwd,
        ...(snapshot.session.projectPath === undefined ? {} : { projectPath: snapshot.session.projectPath }),
        workspaceTarget,
        ...(snapshot.session.title === undefined ? {} : { title: snapshot.session.title }),
        sourcePath: snapshot.session.sourcePath,
        importFingerprint: snapshot.fingerprint,
        status: 'ready',
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      const stored = parseStoredRecord(raw)
      await this.requireTable().put(stored.recordId, stored)
      return snapshotRecord(stored)
    })
  }

  private async ensureLiveAgent(agents: AgentRegistry, dshSessionId: SessionId, agentOptions?: AgentOptions): Promise<void> {
    if (agents.get(dshSessionId) !== undefined) return
    try {
      await agents.resume({
        resumeSessionId: dshSessionId,
        ...(agentOptions === undefined ? {} : { agentOptions }),
      })
    } catch (error: unknown) {
      throw new SessionResumeError('RESUME_DSH_SESSION_MISSING', error instanceof Error ? error.message : String(error), undefined, { cause: error })
    }
  }

  get(recordId: ExternalSessionRecordId): Promise<ExternalSessionRecord | undefined> {
    return this.enqueue(async () => {
      const stored = this.requireTable().get(recordId)
      return stored === undefined ? undefined : snapshotRecord(stored)
    })
  }

  find(query: FindExternalSessionQuery = {}): Promise<ExternalSessionRecord[]> {
    return this.enqueue(async () => {
      const records = [...this.requireTable().entries()]
        .filter(([, record]) => query.recordId === undefined || record.recordId === query.recordId)
        .filter(([, record]) => query.provider === undefined || record.provider === query.provider)
        .filter(([, record]) => query.externalSessionId === undefined || record.externalSessionId === query.externalSessionId)
        .filter(([, record]) => query.dshSessionId === undefined || record.dshSessionId === query.dshSessionId)
        .filter(([, record]) => query.status === undefined || record.status === query.status)
        .map(([, record]) => snapshotRecord(record))
      return Object.freeze(records) as unknown as ExternalSessionRecord[]
    })
  }

  acquire(recordId: ExternalSessionRecordId, rawOwnerId: string): Promise<SessionLease> {
    return this.enqueue(async () => {
      this.assertMutationAdmission()
      const current = this.requireStored(recordId)
      if (current.status === 'closed') throw new SessionResumeError('RESUME_IMPORT_CONFLICT', `closed takeover binding '${recordId}' cannot be acquired`)
      if (current.lease !== undefined) throw new SessionResumeError('RESUME_SESSION_BUSY', `takeover binding '${recordId}' is already owned`)
      const lease: SessionLease = { recordId, ownerId: ownerIdOf(rawOwnerId), token: tokenOf(randomUUID()), acquiredAt: now() }
      const next = parseStoredRecord({ ...current, lease: storedLeaseOf(lease) })
      await this.requireTable().put(recordId, next)
      return snapshotLease(lease)
    })
  }

  release(lease: SessionLease): Promise<void> {
    return this.enqueue(async () => {
      const current = this.requireTable().get(lease.recordId)
      if (current?.lease?.token !== lease.token || current.lease.ownerId !== lease.ownerId) return
      const next = structuredClone(current) as MutableStoredExternalSessionRecord
      delete next.lease
      await this.requireTable().put(lease.recordId, parseStoredRecord(next))
    })
  }

  update(lease: SessionLease, update: ExternalSessionUpdate): Promise<ExternalSessionRecord> {
    return this.enqueue(async () => {
      this.assertMutationAdmission()
      const current = this.requireLease(lease)
      const next = this.applyUpdate(current, update)
      await this.requireTable().put(lease.recordId, next)
      return snapshotRecord(next)
    })
  }

  private updateStatus(recordId: ExternalSessionRecordId, status: ExternalSessionStatus): Promise<ExternalSessionRecord> {
    return this.enqueue(async () => {
      this.assertMutationAdmission()
      const current = this.requireStored(recordId)
      const next = this.applyUpdate(current, { status })
      await this.requireTable().put(recordId, next)
      return snapshotRecord(next)
    })
  }

  private applyUpdate(current: StoredExternalSessionRecord, update: ExternalSessionUpdate): StoredExternalSessionRecord {
    if (current.status === 'closed') throw new SessionResumeError('RESUME_IMPORT_CONFLICT', `closed takeover binding '${current.recordId}' cannot be changed`)
    const nextStatus = update.status ?? current.status
    if (nextStatus !== current.status && !ALLOWED_STATUS_TRANSITIONS[current.status].includes(nextStatus)) {
      throw new SessionResumeError('RESUME_IMPORT_CONFLICT', `takeover binding '${current.recordId}' cannot change from '${current.status}' to '${nextStatus}'`)
    }
    const next = structuredClone(current) as MutableStoredExternalSessionRecord
    next.status = nextStatus
    next.updatedAt = now()
    if (update.lastError === null) delete next.lastError
    else if (update.lastError !== undefined) next.lastError = structuredClone(update.lastError)
    return parseStoredRecord(next)
  }

  private requireStored(recordId: ExternalSessionRecordId): StoredExternalSessionRecord {
    const record = this.requireTable().get(recordId)
    if (record === undefined) throw new SessionResumeError('RESUME_BINDING_NOT_FOUND', `takeover binding '${recordId}' was not found`)
    return record
  }

  private requireLease(lease: SessionLease): StoredExternalSessionRecord {
    const current = this.requireStored(lease.recordId)
    if (current.lease?.token !== lease.token || current.lease.ownerId !== lease.ownerId) throw new SessionResumeError('SESSION_LEASE_LOST', `lease for takeover binding '${lease.recordId}' is no longer current`)
    return current
  }

  private async recoverAbandonedOwnership(): Promise<void> {
    const table = this.requireTable()
    for (const [recordId, current] of table.entries()) {
      if (current.lease === undefined) continue
      const next = structuredClone(current) as MutableStoredExternalSessionRecord
      delete next.lease
      if (current.status !== 'closed') {
        next.status = 'stale'
        next.lastError = { code: 'SESSION_OPERATION_ABORTED', message: 'the previous DSH owner disappeared before releasing this takeover binding' }
      }
      next.updatedAt = now()
      await table.put(recordId, parseStoredRecord(next))
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private assertMutationAdmission(): void {
    if (!this.mutationAdmissionOpen) throw new SessionResumeError('SESSION_OPERATION_ABORTED', 'session-resume service is disposing')
  }

  private requireTable(): KvTable<ExternalSessionRecordId, StoredExternalSessionRecord> {
    if (this.table === undefined) throw new Error('session-resume service is not initialized')
    return this.table
  }
}

export default SessionResumeService
