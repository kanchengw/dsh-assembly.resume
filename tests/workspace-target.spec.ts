import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import { openDshTargetSession } from '../src/client/workspace-target.ts'

function workspace(path: string, id: string): WorkspaceView {
  return {
    workspaceId: id as WorkspaceView['workspaceId'],
    path,
    title: path.split(/[\\/]/u).at(-1) ?? path,
    sessionIds: [],
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  }
}

describe('external session DSH target', () => {
  it('keeps an ungrouped takeover session without creating a workspace', async () => {
    const open = vi.fn()
    const create = vi.fn()
    const sessionCreate = vi.fn()
    const result = await openDshTargetSession({
      list: { getSnapshot: () => ({ items: [workspace('/repo/existing', 'w1')] }) },
      create,
    }, { open, create: sessionCreate }, 'session-native' as never, undefined)

    expect(result).toEqual({ sessionId: 'session-native', status: 'unbound' })
    expect(open).toHaveBeenCalledWith('session-native')
    expect(create).not.toHaveBeenCalled()
    expect(sessionCreate).not.toHaveBeenCalled()
  })

  it('creates a project workspace, attaches the existing takeover session, and opens it', async () => {
    const open = vi.fn()
    const create = vi.fn(async () => workspace('E:\\projects\\demo', 'w-new'))
    const sessionCreate = vi.fn(async () => 'session-project' as never)
    const result = await openDshTargetSession({
      list: { getSnapshot: () => ({ items: [] }) },
      create,
    }, { open, create: sessionCreate }, 'session-project' as never, 'E:\\projects\\demo')

    expect(result).toEqual({ sessionId: 'session-project', status: 'bound' })
    expect(create).toHaveBeenCalledWith({ path: 'E:\\projects\\demo' })
    expect(sessionCreate).toHaveBeenCalledWith({ workspaceId: 'w-new', sessionId: 'session-project' })
    expect(open).toHaveBeenCalledWith('session-project')
  })

  it('reuses an existing project with the exact native path without creating another one', async () => {
    const open = vi.fn()
    const create = vi.fn()
    const sessionCreate = vi.fn(async () => 'session-existing' as never)
    const result = await openDshTargetSession({
      list: { getSnapshot: () => ({ items: [workspace('E:\\projects\\demo', 'w-existing')] }) },
      create,
    }, { open, create: sessionCreate }, 'session-existing' as never, 'E:\\projects\\demo')

    expect(result).toEqual({ sessionId: 'session-existing', status: 'bound' })
    expect(create).not.toHaveBeenCalled()
    expect(sessionCreate).toHaveBeenCalledWith({ workspaceId: 'w-existing', sessionId: 'session-existing' })
    expect(open).toHaveBeenCalledWith('session-existing')
  })

  it('opens an ungrouped takeover when the matching Windows workspace has different path casing', async () => {
    const open = vi.fn()
    const create = vi.fn()
    const sessionCreate = vi.fn()
    const result = await openDshTargetSession({
      list: { getSnapshot: () => ({ items: [workspace('C:\\Windows\\System32', 'w-system32')] }) },
      create,
    }, { open, create: sessionCreate }, 'session-case-mismatch' as never, 'C:\\WINDOWS\\System32')

    expect(result).toMatchObject({ sessionId: 'session-case-mismatch', status: 'unbound' })
    expect(create).not.toHaveBeenCalled()
    expect(sessionCreate).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith('session-case-mismatch')
  })

  it('opens an imported session and reports an unbound result when workspace registration fails', async () => {
    const open = vi.fn()
    const create = vi.fn(async () => { throw new Error('workspace-invalid-path') })
    const sessionCreate = vi.fn()

    const result = await openDshTargetSession({
      list: { getSnapshot: () => ({ items: [] }) },
      create,
    }, { open, create: sessionCreate }, 'session-imported' as never, 'E:\\deleted')

    expect(result).toMatchObject({ sessionId: 'session-imported', status: 'unbound', reason: 'workspace-invalid-path' })
    expect(open).toHaveBeenCalledWith('session-imported')
    expect(sessionCreate).not.toHaveBeenCalled()
  })

  it('opens an imported session and reports an unbound result when workspace attachment fails', async () => {
    const open = vi.fn()
    const create = vi.fn()
    const sessionCreate = vi.fn(async () => { throw new Error('workspace-attach-failed') })

    const result = await openDshTargetSession({
      list: { getSnapshot: () => ({ items: [workspace('E:\\projects\\demo', 'w-existing')] }) },
      create,
    }, { open, create: sessionCreate }, 'session-imported' as never, 'E:\\projects\\demo')

    expect(result).toMatchObject({ sessionId: 'session-imported', status: 'unbound', reason: 'workspace-attach-failed' })
    expect(open).toHaveBeenCalledWith('session-imported')
    expect(create).not.toHaveBeenCalled()
  })
})
