import { describe, expect, it } from 'vitest'
import { TYPERT_REMOTE } from '../src/remote.ts'

type StrictCodec = {
  mode: 'strict'
  schema: unknown
  create?: () => { parse(value: unknown): unknown }
}

function assertStrictCreate(codec: StrictCodec) {
  expect(typeof codec.create).toBe('function')
  const created = codec.create!()
  expect(created).toBe(codec.schema)
  expect(typeof created.parse).toBe('function')
  expect(() => created.parse(Symbol('invalid'))).toThrow()
}

describe('session-resume Remote descriptor', () => {
  it('publishes the standalone namespace and takeover operations', () => {
    expect(TYPERT_REMOTE.package).toBe('dsh-assembly.resume')
    expect(TYPERT_REMOTE.descriptors.map(descriptor => descriptor.method)).toEqual([
      'discover', 'takeOverStandalone', 'takeOver', 'open', 'list', 'detach',
    ])
    expect(TYPERT_REMOTE.descriptors.find(descriptor => descriptor.method === 'discover')).toMatchObject({
      service: 'sessionResume',
      namespace: 'sessionResume',
    })
    expect(TYPERT_REMOTE.descriptors.find(descriptor => descriptor.method === 'discover')?.scope).toBeUndefined()
    expect(TYPERT_REMOTE.descriptors.find(descriptor => descriptor.method === 'takeOverStandalone')?.scope).toBeUndefined()
    for (const descriptor of TYPERT_REMOTE.descriptors.filter(descriptor => descriptor.method !== 'discover' && descriptor.method !== 'takeOverStandalone')) {
      expect(descriptor.scope).toEqual({ context: 'agent', wire: 'agentId' })
    }
  })

  it('provides a create factory on strict codecs for DSH typert-loader compatibility', () => {
    for (const descriptor of TYPERT_REMOTE.descriptors) {
      if (descriptor.result?.mode === 'strict') {
        assertStrictCreate(descriptor.result as StrictCodec)
      }
      for (const param of descriptor.parameters) {
        if (param.codec?.mode === 'strict') {
          assertStrictCreate(param.codec as StrictCodec)
        }
      }
    }

    const discover = TYPERT_REMOTE.descriptors.find(descriptor => descriptor.method === 'discover')!
    const discoverInput = (discover.parameters[0]!.codec as StrictCodec).create!()
    expect(discoverInput.parse({})).toEqual({})

    const discoverResult = (discover.result as StrictCodec).create!()
    expect(discoverResult.parse([])).toEqual([])
  })
})
