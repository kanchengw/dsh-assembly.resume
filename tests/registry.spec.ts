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

async function mount(backend: MemoryBackend, codexHome: string): Promise<{ ctx: Context; runtime: FakeDshAgentRuntime }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  await ctx.plugin(StorageDomain, { backend: 'memory' })
  const runtime = new FakeDshAgentRuntime()
  ctx.provide('agents', runtime as never)
  await ctx.plugin(SessionResumeService, { providers: { codexHome } })
  return { ctx, runtime }
}

async function nativeSession(root: string, id = 'native-registry'): Promise<void> {
  const cwd = join(root, 'project')
  await mkdir(cwd, { recursive: true })
  await writeFile(join(root, `${id}.jsonl`), [
    JSON.stringify({ type: 'session_meta', payload: { session_id: id, cwd, model_provider: 'openai', model: 'gpt-5' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'registry task', turn_id: 'turn-1' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'registry answer', turn_id: 'turn-1' } }),
  ].join('\n'))
}

describe('takeover binding registry', () => {
  it('persists an immutable native-to-DSH binding and supports filtered lookup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-registry-'))
    await nativeSession(root)
    const { ctx, runtime } = await mount(new MemoryBackend(), root)
    const result = await ctx.sessionResume.takeOver(runtime.controller(), {
      provider: 'codex',
      externalSessionId: 'native-registry' as never,
    })

    expect(Object.isFrozen(result.record)).toBe(true)
    await expect(ctx.sessionResume.get(result.record.recordId)).resolves.toEqual(result.record)
    await expect(ctx.sessionResume.find({ provider: 'codex' })).resolves.toEqual([result.record])
    await expect(ctx.sessionResume.find({ provider: 'claude-code' })).resolves.toEqual([])
  })

  it('keeps the binding across a cold service restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-registry-restart-'))
    await nativeSession(root)
    const backend = new MemoryBackend()
    const first = await mount(backend, root)
    const created = await first.ctx.sessionResume.takeOver(first.runtime.controller(), {
      provider: 'codex',
      externalSessionId: 'native-registry' as never,
    })
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await mount(backend, root)
    await expect(second.ctx.sessionResume.get(created.record.recordId)).resolves.toEqual(created.record)
  })

  it('creates a new DSH import when the native source revision changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-registry-revision-'))
    await nativeSession(root)
    const { ctx, runtime } = await mount(new MemoryBackend(), root)
    const controller = runtime.controller()
    const first = await ctx.sessionResume.takeOver(controller, { provider: 'codex', externalSessionId: 'native-registry' as never })
    await writeFile(join(root, 'native-registry.jsonl'), `${await import('node:fs/promises').then(fs => fs.readFile(join(root, 'native-registry.jsonl'), 'utf8'))}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'changed' } })}`)

    const second = await ctx.sessionResume.takeOver(controller, { provider: 'codex', externalSessionId: 'native-registry' as never })

    expect(second.reused).toBe(false)
    expect(second.dshSessionId).not.toBe(first.dshSessionId)
    await expect(ctx.sessionResume.find({ externalSessionId: 'native-registry' as never })).resolves.toHaveLength(2)
  })
})
