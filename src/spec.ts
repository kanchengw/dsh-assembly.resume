import { isAbsolute } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type {
  ExternalProvider,
  ExternalSessionErrorData,
  ExternalSessionId,
  ExternalSessionRecord,
  ExternalSessionRecordId,
  ExternalSessionStatus,
  SessionLeaseToken,
  SessionOwnerId,
  StoredExternalSessionRecord,
  StoredSessionLease,
  ExternalSessionWorkspaceTarget,
} from './types.ts'
import type { SessionResumeErrorCode } from './types.ts'

const nonBlankString = z.string().min(1).refine(value => value.trim() === value && value.length > 0, {
  message: 'value must be non-blank and have no surrounding whitespace',
})

const isoTimestamp = z.string().refine(value => {
  const epoch = Date.parse(value)
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value
}, { message: 'value must be a canonical ISO timestamp' })

const absolutePath = nonBlankString.refine(value => isAbsolute(value), {
  message: 'value must be an absolute path',
})

const provider = z.enum(['codex', 'claude-code', 'claude-code-desktop']) satisfies z.ZodType<ExternalProvider>
const status = z.enum(['ready', 'running', 'stale', 'detached', 'closed', 'failed']) satisfies z.ZodType<ExternalSessionStatus>
const errorCode = z.enum([
  'RESUME_PROVIDER_UNAVAILABLE',
  'RESUME_NATIVE_SESSION_NOT_FOUND',
  'RESUME_TRANSCRIPT_INVALID',
  'RESUME_TRANSCRIPT_UNSUPPORTED',
  'RESUME_IMPORT_CONFLICT',
  'RESUME_DSH_SESSION_CREATE_FAILED',
  'RESUME_DSH_AGENT_START_FAILED',
  'RESUME_BINDING_NOT_FOUND',
  'RESUME_BINDING_CORRUPT',
  'RESUME_DSH_SESSION_MISSING',
  'RESUME_SESSION_BUSY',
  'SESSION_LEASE_LOST',
  'SESSION_OPERATION_ABORTED',
]) satisfies z.ZodType<SessionResumeErrorCode>

const workspaceTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source'), activeCwd: absolutePath, workspacePath: absolutePath.optional() }).strict(),
  z.object({ kind: z.literal('replacement'), activeCwd: absolutePath, workspacePath: absolutePath }).strict(),
  z.object({ kind: z.literal('unbound') }).strict(),
]) as unknown as z.ZodType<ExternalSessionWorkspaceTarget>

export const externalSessionErrorSchema = z.object({
  code: errorCode,
  message: nonBlankString,
  details: z.record(z.string(), z.string()).optional(),
}).strict() as unknown as z.ZodType<ExternalSessionErrorData>

export const storedSessionLeaseSchema = z.object({
  ownerId: nonBlankString.transform(value => value as SessionOwnerId),
  token: nonBlankString.transform(value => value as SessionLeaseToken),
  acquiredAt: isoTimestamp,
}).strict() satisfies z.ZodType<StoredSessionLease>

const recordFields = {
  recordId: nonBlankString.transform(value => value as ExternalSessionRecordId),
  provider,
  externalSessionId: nonBlankString.transform(value => value as ExternalSessionId),
  dshSessionId: nonBlankString.transform(value => SessionId(value)),
  cwd: absolutePath,
  projectPath: absolutePath.optional(),
  workspaceTarget: workspaceTarget.optional(),
  title: nonBlankString.optional(),
  sourcePath: absolutePath,
  importFingerprint: nonBlankString,
  status,
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  lastError: externalSessionErrorSchema.optional(),
}

export const externalSessionRecordSchema = z.object(recordFields).strict() as unknown as z.ZodType<ExternalSessionRecord>

export const storedSessionRecordSchema = z.object({
  ...recordFields,
  lease: storedSessionLeaseSchema.optional(),
}).strict() as unknown as z.ZodType<StoredExternalSessionRecord>

export const sessionResumeDomainSpec = defineDomain({
  name: 'session_resume',
  version: 1,
  tables: {
    sessions: domainTable<ExternalSessionRecordId, StoredExternalSessionRecord>(storedSessionRecordSchema),
  },
})
