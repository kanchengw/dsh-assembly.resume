import { z } from 'zod'
import type {
  InvocationDescriptor,
  RemoteResult,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  DiscoveredExternalSession,
  DiscoverExternalSessionsInput,
  ExternalSessionRecord,
  ExternalSessionRecordId,
  TakeOverExternalSessionInput,
  TakeOverResult,
} from './types.ts'

const json = (typeSymbol: string, schema: { parse(value: unknown): unknown }) => ({
  mode: 'strict' as const,
  typeSymbol,
  schema,
})

const provider = z.union([z.literal('codex'), z.literal('claude-code')])
const discovered = z.object({
  provider,
  externalSessionId: z.string(),
  cwd: z.string(),
  projectPath: z.string().optional(),
  sourcePath: z.string(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  title: z.string().optional(),
  firstUserMessage: z.string().optional(),
  lastUserMessage: z.string().optional(),
  resumable: z.boolean(),
})
const discoverInput = z.object({
  provider: provider.optional(),
  cwd: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().int().positive().optional(),
})
const record = z.object({
  recordId: z.string(), provider, externalSessionId: z.string(), dshSessionId: z.string(), cwd: z.string(),
  projectPath: z.string().optional(), title: z.string().optional(), sourcePath: z.string(), importFingerprint: z.string(),
  status: z.string(), createdAt: z.string(), updatedAt: z.string(), lastError: z.unknown().optional(),
})
const takeoverInput = z.object({ provider, externalSessionId: z.string(), agentOptions: z.object({ provider: z.string().optional(), model: z.string().optional(), maxTokens: z.number().int().positive().optional() }).optional() })
const takeoverResult = z.object({ record, dshSessionId: z.string(), reused: z.boolean() })
const agentId = json('@deepseek-ai/dsh-session/types#SessionId', z.string())

function scopeDescriptor(method: string, parameters: InvocationDescriptor['parameters'], result: InvocationDescriptor['result']): InvocationDescriptor {
  return {
    id: `dsh-assembly.resume#sessionResume/${method}`, service: 'sessionResume', namespace: 'sessionResume', method,
    invocation: { kind: 'direct' }, scope: { context: 'agent', wire: 'agentId' }, parameters, result,
  }
}

const descriptors: readonly InvocationDescriptor[] = [
  {
    id: 'dsh-assembly.resume#sessionResume/discover', service: 'sessionResume', namespace: 'sessionResume', method: 'discover',
    invocation: { kind: 'direct' },
    parameters: [{ name: 'input', wire: 'input', source: 'json', codec: json('dsh-assembly.resume#DiscoverExternalSessionsInput', discoverInput) }],
    result: json('dsh-assembly.resume#DiscoveredExternalSession[]', z.array(discovered)),
  },
  scopeDescriptor('takeOver', [
    { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: agentId },
    { name: 'input', wire: 'input', source: 'json', codec: json('dsh-assembly.resume#TakeOverExternalSessionInput', takeoverInput) },
  ], json('dsh-assembly.resume#TakeOverResult', takeoverResult)),
  scopeDescriptor('open', [
    { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: agentId },
    { name: 'recordId', wire: 'recordId', source: 'json', codec: json('dsh-assembly.resume#ExternalSessionRecordId', z.string()) },
  ], json('dsh-assembly.resume#TakeOverResult', takeoverResult)),
  scopeDescriptor('list', [
    { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: agentId },
  ], json('dsh-assembly.resume#ExternalSessionRecord[]', z.array(record))),
  scopeDescriptor('detach', [
    { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: agentId },
    { name: 'recordId', wire: 'recordId', source: 'json', codec: json('dsh-assembly.resume#ExternalSessionRecordId', z.string()) },
  ], json('dsh-assembly.resume#ExternalSessionRecord', record)),
]

/** Generated-compatible Remote contribution for the standalone client face. */
export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: 'dsh-assembly.resume',
  descriptors,
}

export type SessionResumeRemote = {
  discover(input: DiscoverExternalSessionsInput): Promise<RemoteResult<readonly DiscoveredExternalSession[]>>
  takeOver(agentId: SessionId, input: TakeOverExternalSessionInput): Promise<RemoteResult<TakeOverResult>>
  open(agentId: SessionId, recordId: ExternalSessionRecordId): Promise<RemoteResult<TakeOverResult>>
  list(agentId: SessionId): Promise<RemoteResult<readonly ExternalSessionRecord[]>>
  detach(agentId: SessionId, recordId: ExternalSessionRecordId): Promise<RemoteResult<ExternalSessionRecord>>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'sessionResume/discover': SessionResumeRemote['discover']
    'sessionResume/takeOver': SessionResumeRemote['takeOver']
    'sessionResume/open': SessionResumeRemote['open']
    'sessionResume/list': SessionResumeRemote['list']
    'sessionResume/detach': SessionResumeRemote['detach']
  }
  interface TypertRemoteNamespaceMap {
    sessionResume: SessionResumeRemote
  }
}

export default TYPERT_REMOTE
