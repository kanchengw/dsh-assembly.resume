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

async function mount(codexHome: string): Promise<{ ctx: Context; runtime: FakeDshAgentRuntime }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  const backend = new MemoryBackend()
  ctx.storage.backend.register('memory', backend)
  ctx.provide(storageBackendServiceKey('memory'), backend)
  await ctx.plugin(StorageDomain, { backend: 'memory' })
  const runtime = new FakeDshAgentRuntime()
  await ctx.plugin(SessionResumeService, { providers: { codexHome } })
  return { ctx, runtime }
}

async function createCodexSession(root: string): Promise<void> {
  const cwd = join(root, 'project')
  await mkdir(cwd, { recursive: true })
  await writeFile(join(root, 'session.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { session_id: 'native-1', cwd, model_provider: 'openai', model: 'gpt-5' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'inspect the failing test', turn_id: 'turn-1' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'I inspected it', turn_id: 'turn-1' } }),
  ].join('\n'))
}

describe('DSH takeover', () => {
  it('distinguishes a missing native session from an invalid transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-native-missing-'))
    const { ctx } = await mount(root)

    await expect(ctx.sessionResume.inspect({
      provider: 'codex',
      externalSessionId: 'native-missing' as never,
    })).rejects.toMatchObject({ code: 'RESUME_NATIVE_SESSION_NOT_FOUND' })
  })

  it('imports the native semantic transcript and makes the DSH Agent the live owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-takeover-'))
    await createCodexSession(root)
    const { ctx, runtime } = await mount(root)
    const controller = runtime.controller('controller', { provider: 'mock', model: 'mock' })

    const result = await ctx.sessionResume.takeOver(controller, {
      provider: 'codex',
      externalSessionId: 'native-1' as never,
    })

    expect(result.reused).toBe(false)
    expect(result.record).toMatchObject({ provider: 'codex', externalSessionId: 'native-1', status: 'ready' })
    expect(runtime.created).toHaveLength(1)
    expect(runtime.created[0]).toMatchObject({
      sessionId: result.dshSessionId,
      meta: { cwd: join(root, 'project') },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(runtime.created[0]?.seed?.map(event => event.type)).toEqual([
      'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
    ])
    expect(runtime.resumed).toHaveLength(0)
  })

  it('reuses the same DSH session for the same native source fingerprint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-idempotent-'))
    await createCodexSession(root)
    const { ctx, runtime } = await mount(root)
    const controller = runtime.controller('controller')
    const input = { provider: 'codex' as const, externalSessionId: 'native-1' as never }

    const first = await ctx.sessionResume.takeOver(controller, input)
    const second = await ctx.sessionResume.takeOver(controller, input)

    expect(second).toMatchObject({ reused: true, dshSessionId: first.dshSessionId })
    expect(runtime.created).toHaveLength(1)
    expect(runtime.resumed).toHaveLength(0)
  })

  it('reopens the DSH Agent from the persisted binding without a native resume command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-resume-open-'))
    await createCodexSession(root)
    const { ctx, runtime } = await mount(root)
    const controller = runtime.controller('controller')
    const first = await ctx.sessionResume.takeOver(controller, {
      provider: 'codex',
      externalSessionId: 'native-1' as never,
    })
    runtime.agents.delete(String(first.dshSessionId))

    const reopened = await ctx.sessionResume.open(controller, first.record.recordId)

    expect(reopened).toMatchObject({ reused: true, dshSessionId: first.dshSessionId })
    expect(runtime.resumed).toHaveLength(1)
    expect(runtime.resumed[0]?.resumeSessionId).toBe(first.dshSessionId)
  })
})
