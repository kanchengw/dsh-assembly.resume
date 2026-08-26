import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { NativeSemanticEvent } from './transcript.ts'

/** Native coding-agent products supported by the first standalone release. */
export type ExternalProvider = 'codex' | 'claude-code' | 'claude-code-desktop'

/** Opaque native session identifier owned by an external provider. */
export type ExternalSessionId = Branded<'ExternalSessionId'>

/** Identifier of one durable takeover binding. */
export type ExternalSessionRecordId = Branded<'ExternalSessionRecordId'>

/** Identifier supplied by the DSH controller that owns a storage lease. */
export type SessionOwnerId = Branded<'SessionOwnerId'>

/** Opaque token proving the current storage lease generation. */
export type SessionLeaseToken = Branded<'SessionLeaseToken'>

/** Bounded metadata shown before a native session is selected. */
export interface DiscoveredExternalSession {
  readonly provider: ExternalProvider
  readonly externalSessionId: ExternalSessionId
  readonly cwd: string
  /** Absent for provider-native unscoped/new-chat sessions. */
  readonly projectPath?: string
  /** Whether the source project directory still exists. Absent for unscoped sessions. */
  readonly projectPathAvailable?: boolean
  readonly sourcePath: string
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly title?: string
  readonly firstUserMessage?: string
  readonly lastUserMessage?: string
  readonly resumable: boolean
}

/** Provider discovery filters accepted by the standalone UI and API. */
export interface DiscoverExternalSessionsInput {
  readonly provider?: ExternalProvider
  readonly cwd?: string
  readonly query?: string
  readonly limit?: number
}

/** Input for inspecting one selected native transcript. */
export interface InspectExternalSessionInput {
  readonly provider: ExternalProvider
  readonly externalSessionId: ExternalSessionId
}

/** Input for importing one native transcript into a DSH Agent session. */
export interface TakeOverExternalSessionInput extends InspectExternalSessionInput {
  /** Optional explicit DSH Agent route; omitted uses the host default. */
  readonly agentOptions?: { readonly provider?: string; readonly model?: string; readonly maxTokens?: number }
  /** Existing directory chosen to replace an unavailable source workspace. */
  readonly targetWorkspacePath?: string
}

/** Resolved DSH cwd and Workspace target, kept separate from source provenance. */
export type ExternalSessionWorkspaceTarget =
  | { readonly kind: 'source'; readonly activeCwd: string; readonly workspacePath?: string }
  | { readonly kind: 'replacement'; readonly activeCwd: string; readonly workspacePath: string }
  | { readonly kind: 'unbound' }

/** A complete validated semantic transcript snapshot from one native provider. */
export interface NativeTranscriptSnapshot {
  readonly session: DiscoveredExternalSession
  readonly sourceRevision: string
  readonly fingerprint: string
  readonly events: readonly NativeSemanticEvent[]
}

/** Result after the DSH Agent has been created or reopened. */
export interface TakeOverResult {
  readonly record: ExternalSessionRecord
  readonly dshSessionId: SessionId
  readonly reused: boolean
}

/** Lifecycle states of a takeover binding. */
export type ExternalSessionStatus = 'ready' | 'running' | 'stale' | 'detached' | 'closed' | 'failed'

/** Stable failure codes carried by durable takeover diagnostics. */
export type SessionResumeErrorCode =
  | 'RESUME_PROVIDER_UNAVAILABLE'
  | 'RESUME_NATIVE_SESSION_NOT_FOUND'
  | 'RESUME_TRANSCRIPT_INVALID'
  | 'RESUME_TRANSCRIPT_UNSUPPORTED'
  | 'RESUME_IMPORT_CONFLICT'
  | 'RESUME_DSH_SESSION_CREATE_FAILED'
  | 'RESUME_DSH_AGENT_START_FAILED'
  | 'RESUME_BINDING_NOT_FOUND'
  | 'RESUME_BINDING_CORRUPT'
  | 'RESUME_DSH_SESSION_MISSING'
  | 'RESUME_SESSION_BUSY'
  | 'SESSION_LEASE_LOST'
  | 'SESSION_OPERATION_ABORTED'

/** Provider failure information safe to retain as durable metadata. */
export interface ExternalSessionErrorData {
  readonly code: SessionResumeErrorCode
  readonly message: string
  readonly details?: Record<string, string>
}

/** Public immutable projection of one durable takeover binding. */
export interface ExternalSessionRecord {
  readonly recordId: ExternalSessionRecordId
  readonly provider: ExternalProvider
  readonly externalSessionId: ExternalSessionId
  readonly dshSessionId: SessionId
  readonly cwd: string
  readonly projectPath?: string
  /** Absent only on records written by releases before workspace-target tracking. */
  readonly workspaceTarget?: ExternalSessionWorkspaceTarget
  readonly title?: string
  readonly sourcePath: string
  readonly importFingerprint: string
  readonly status: ExternalSessionStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastError?: ExternalSessionErrorData
}

/** Durable ownership data retained inside the sidecar row. */
export interface StoredSessionLease {
  readonly ownerId: SessionOwnerId
  readonly token: SessionLeaseToken
  readonly acquiredAt: string
}

/** Internal row format used by the storage-domain table. */
export interface StoredExternalSessionRecord extends ExternalSessionRecord {
  readonly lease?: StoredSessionLease
}

/** Optional filters for durable takeover bindings. */
export interface FindExternalSessionQuery {
  readonly recordId?: ExternalSessionRecordId
  readonly provider?: ExternalProvider
  readonly externalSessionId?: ExternalSessionId
  readonly dshSessionId?: SessionId
  readonly status?: ExternalSessionStatus
}

/** Lease returned when a controller becomes the active owner of a binding. */
export interface SessionLease {
  readonly recordId: ExternalSessionRecordId
  readonly ownerId: SessionOwnerId
  readonly token: SessionLeaseToken
  readonly acquiredAt: string
}

/** Explicit changes committed while holding a lease. */
export interface ExternalSessionUpdate {
  readonly status?: ExternalSessionStatus
  readonly lastError?: ExternalSessionErrorData | null
}

/** Provider-neutral service consumed by the standalone UI and future assembly. */
export interface ExternalSessionResumeService {
  discover(input?: DiscoverExternalSessionsInput): Promise<DiscoveredExternalSession[]>
  inspect(input: InspectExternalSessionInput): Promise<NativeTranscriptSnapshot>
  /** Create a resumed DSH Agent without requiring an existing control session. */
  takeOverStandalone(input: TakeOverExternalSessionInput): Promise<TakeOverResult>
  takeOver(agent: Agent, input: TakeOverExternalSessionInput): Promise<TakeOverResult>
  open(agent: Agent, recordId: ExternalSessionRecordId): Promise<TakeOverResult>
  list(agent: Agent): Promise<ExternalSessionRecord[]>
  detach(agent: Agent, recordId: ExternalSessionRecordId): Promise<ExternalSessionRecord>
  get(recordId: ExternalSessionRecordId): Promise<ExternalSessionRecord | undefined>
  find(query?: FindExternalSessionQuery): Promise<ExternalSessionRecord[]>
  acquire(recordId: ExternalSessionRecordId, ownerId: string): Promise<SessionLease>
  release(lease: SessionLease): Promise<void>
  update(lease: SessionLease, update: ExternalSessionUpdate): Promise<ExternalSessionRecord>
}
