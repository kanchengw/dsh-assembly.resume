import { describe, expect, it, vi } from 'vitest'
import { getSessionResumeRemote } from '../src/client/remote-access.ts'

describe('client Remote namespace access', () => {
  it('reads the mounted namespace through Context.get', () => {
    const remote = { discover: vi.fn() }
    const ctx = { get: vi.fn(() => remote) }

    expect(getSessionResumeRemote(ctx)).toBe(remote)
    expect(ctx.get).toHaveBeenCalledWith('remote.sessionResume')
  })
})
