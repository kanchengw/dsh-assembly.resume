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

async function mount(backend: MemoryBackend, root: string, autoRecover = true): Promise<{ ctx: Context; runtime: FakeDshAgentRuntime }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  await ctx.plugin(StorageDomain, { backend: 'memory' })
  const runtime = new FakeDshAgentRuntime()
  await ctx.plugin(SessionResumeService, { autoRecover, providers: { codexHome: root } })
  return { ctx, runtime }
}

async function nativeSession(root: string): Promise<void> {
  const cwd = join(root, 'project')
  await mkdir(cwd, { recursive: true })
  await writeFile(join(root, 'session.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { session_id: 'native-recovery', cwd, model_provider: 'openai', model: 'gpt-5' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'recovery task' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'recovery answer' } }),
  ].join('\n'))
}

describe('takeover recovery', () => {
  it('keeps an explicitly released binding ready across service restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-recovery-ready-'))
    await nativeSession(root)
    const backend = new MemoryBackend()
    const first = await mount(backend, root)
    const created = await first.ctx.sessionResume.takeOver(first.runtime.controller(), { provider: 'codex', externalSessionId: 'native-recovery' as never })
    const lease = await first.ctx.sessionResume.acquire(created.record.recordId, 'controller-a')
    await first.ctx.sessionResume.release(lease)
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await mount(backend, root)
    await expect(second.ctx.sessionResume.get(created.record.recordId)).resolves.toMatchObject({ status: 'ready' })
  })

  it('marks a stranded owner stale without launching a native process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-recovery-stale-'))
    await nativeSession(root)
    const backend = new MemoryBackend()
    const first = await mount(backend, root, false)
    const created = await first.ctx.sessionResume.takeOver(first.runtime.controller(), { provider: 'codex', externalSessionId: 'native-recovery' as never })
    await first.ctx.sessionResume.acquire(created.record.recordId, 'dead-controller')
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await mount(backend, root)
    await expect(second.ctx.sessionResume.get(created.record.recordId)).resolves.toMatchObject({
      status: 'stale',
      lastError: { code: 'SESSION_OPERATION_ABORTED' },
    })
    expect(second.runtime.created).toHaveLength(0)
    expect(second.runtime.resumed).toHaveLength(0)
  })

  it('detaches a binding without changing the native source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-recovery-detach-'))
    await nativeSession(root)
    const { ctx, runtime } = await mount(new MemoryBackend(), root)
    const controller = runtime.controller()
    const created = await ctx.sessionResume.takeOver(controller, { provider: 'codex', externalSessionId: 'native-recovery' as never })
    const owner = runtime.get(String(created.dshSessionId))!

    await expect(ctx.sessionResume.detach(owner, created.record.recordId)).resolves.toMatchObject({ status: 'detached' })
    await expect(ctx.sessionResume.open(owner, created.record.recordId)).resolves.toMatchObject({ dshSessionId: created.dshSessionId })
  })

  it('reports a missing binding without creating durable state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-recovery-missing-'))
    const { ctx } = await mount(new MemoryBackend(), root)
    await expect(ctx.sessionResume.acquire('missing' as never, 'controller-a')).rejects.toMatchObject({ code: 'RESUME_BINDING_NOT_FOUND' })
    await expect(ctx.sessionResume.find()).resolves.toEqual([])
  })
})
