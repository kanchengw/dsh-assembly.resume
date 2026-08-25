import { describe, expect, it } from 'vitest'
import { TYPERT_REMOTE } from '../src/remote.ts'

describe('session-resume Remote descriptor', () => {
  it('publishes the standalone namespace and takeover operations', () => {
    expect(TYPERT_REMOTE.package).toBe('dsh-assembly.resume')
    expect(TYPERT_REMOTE.descriptors.map(descriptor => descriptor.method)).toEqual([
      'discover', 'takeOver', 'open', 'list', 'detach',
    ])
    expect(TYPERT_REMOTE.descriptors.find(descriptor => descriptor.method === 'discover')).toMatchObject({
      service: 'sessionResume',
      namespace: 'sessionResume',
    })
    expect(TYPERT_REMOTE.descriptors.find(descriptor => descriptor.method === 'discover')?.scope).toBeUndefined()
    for (const descriptor of TYPERT_REMOTE.descriptors.filter(descriptor => descriptor.method !== 'discover')) {
      expect(descriptor.scope).toEqual({ context: 'agent', wire: 'agentId' })
    }
  })
})
