import { TYPERT_REMOTE } from './remote.ts'

/** Host Typert manifest consumed by the latest DSH Typert loader. */
export const TYPERT = {
  package: 'dsh-assembly.resume',
  face: 'host',
  schemas: [],
  invocations: TYPERT_REMOTE.descriptors,
  model: {
    services: [],
    events: [],
    objects: [],
  },
} as const

export default TYPERT
