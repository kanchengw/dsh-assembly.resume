import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SessionResumeService from '../src/index.ts'
import { FakeDshAgentRuntime, MemoryBackend } from './helpers.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function setup(): Promise<{ ctx: Context; runtime: FakeDshAgentRuntime; recordId: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-resume-lease-'))
  const cwd = join(root, 'project')
  await mkdir(cwd, { recursive: true })
  await writeFile(join(root, 'session.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { session_id: 'native-lease', cwd, model_provider: 'openai', model: 'gpt-5' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'lease task' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'lease answer' } }),
  ].join('\n'))
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  const backend = new MemoryBackend()
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  await ctx.plugin(StorageDomain, { backend: 'memory' })
  const runtime = new FakeDshAgentRuntime()
  await ctx.plugin(SessionResumeService, { providers: { codexHome: root } })
  const created = await ctx.sessionResume.takeOver(runtime.controller(), { provider: 'codex', externalSessionId: 'native-lease' as never })
  return { ctx, runtime, recordId: created.record.recordId }
}

describe('takeover binding ownership', () => {
  it('allows one owner and rejects a second owner', async () => {
    const { ctx, recordId } = await setup()
    const lease = await ctx.sessionResume.acquire(recordId as never, 'controller-a')

    expect(lease.ownerId).toBe('controller-a')
    await expect(ctx.sessionResume.acquire(recordId as never, 'controller-b')).rejects.toMatchObject({ code: 'RESUME_SESSION_BUSY' })
    await ctx.sessionResume.release(lease)
  })

  it('rejects blank owners without changing the binding', async () => {
    const { ctx, recordId } = await setup()
    await expect(ctx.sessionResume.acquire(recordId as never, ' ')).rejects.toMatchObject({ code: 'SESSION_OPERATION_ABORTED' })
    await expect(ctx.sessionResume.acquire(recordId as never, 'controller-a')).resolves.toBeDefined()
  })

  it('prevents a stale lease from updating a newer generation', async () => {
    const { ctx, recordId } = await setup()
    const stale = await ctx.sessionResume.acquire(recordId as never, 'controller-a')
    await ctx.sessionResume.release(stale)
    const current = await ctx.sessionResume.acquire(recordId as never, 'controller-b')

    await expect(ctx.sessionResume.update(stale, { status: 'running' })).rejects.toMatchObject({ code: 'SESSION_LEASE_LOST' })
    await expect(ctx.sessionResume.update(current, { status: 'running' })).resolves.toMatchObject({ status: 'running' })
  })

  it('serializes concurrent acquisition attempts', async () => {
    const { ctx, recordId } = await setup()
    const results = await Promise.allSettled([
      ctx.sessionResume.acquire(recordId as never, 'controller-a'),
      ctx.sessionResume.acquire(recordId as never, 'controller-b'),
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  })
})
