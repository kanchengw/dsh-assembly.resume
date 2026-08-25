import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  externalSessionRecordSchema,
  sessionResumeDomainSpec,
  storedSessionRecordSchema,
} from '../src/spec.ts'

const cwd = process.cwd()

const validRecord = {
  recordId: 'record-1',
  provider: 'codex',
  externalSessionId: 'thread-1',
  dshSessionId: SessionId('dsh-1'),
  cwd,
  projectPath: cwd,
  sourcePath: `${cwd}/session.jsonl`,
  importFingerprint: 'a'.repeat(64),
  status: 'ready' as const,
  createdAt: '2026-08-23T12:00:00.000Z',
  updatedAt: '2026-08-23T12:00:01.000Z',
}

describe('session resume durable schema', () => {
  it('declares one versioned sessions table and accepts a valid record', () => {
    expect(sessionResumeDomainSpec.name).toBe('session_resume')
    expect(sessionResumeDomainSpec.version).toBe(1)
    expect(storedSessionRecordSchema.parse(validRecord)).toMatchObject(validRecord)
    expect(externalSessionRecordSchema.parse(validRecord)).not.toHaveProperty('lease')
  })

  it.each([
    ['relative cwd', { cwd: 'repo' }],
    ['unknown status', { status: 'done' }],
    ['invalid timestamp', { updatedAt: 'later' }],
    ['malformed lease', { lease: { ownerId: 'owner' } }],
  ])('rejects %s at the durable boundary', (_label, patch) => {
    expect(() => storedSessionRecordSchema.parse({ ...validRecord, ...patch })).toThrow()
  })
})
