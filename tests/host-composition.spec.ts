import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SessionResumeService from '../src/index.ts'
import { MemoryBackend } from './helpers.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('host composition', () => {
  it('mounts the service over storage-domain and does not start a provider', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    const backend = new MemoryBackend()
    ctx.storage.backend.register('memory', backend)
    ctx.provide(storageBackendServiceKey('memory'), backend)
    await ctx.plugin(StorageDomain, { backend: 'memory' })
    await ctx.plugin(SessionResumeService)

    expect(ctx.sessionResume).toBeInstanceOf(SessionResumeService)
    await expect(ctx.sessionResume.find()).resolves.toEqual([])
    expect(backend.units.has('session_resume')).toBe(true)
  })

  it('rejects a malformed durable row when the domain is reopened', async () => {
    const backend = new MemoryBackend()
    const first = new Context()
    contexts.push(first)
    await first.plugin(Storage)
    first.storage.backend.register('memory', backend)
    first.provide(storageBackendServiceKey('memory'), backend)
    await first.plugin(StorageDomain, { backend: 'memory' })
    await first.plugin(SessionResumeService)
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    backend.units.get('session_resume')?.records.get('sessions')?.set('broken', {
      recordId: 'broken',
      provider: 'codex',
      externalSessionId: 'thread-broken',
      dshSessionId: 'dsh-broken',
      cwd: 'relative/repo',
      status: 'ready',
      createdAt: 'not-a-date',
      updatedAt: 'not-a-date',
      capabilities: [],
    })

    const second = new Context()
    contexts.push(second)
    await second.plugin(Storage)
    second.storage.backend.register('memory', backend)
    second.provide(storageBackendServiceKey('memory'), backend)
    await second.plugin(StorageDomain, { backend: 'memory' })
    await expect(second.plugin(SessionResumeService)).rejects.toMatchObject({
      code: 'invalid-record',
    })
  })
})
