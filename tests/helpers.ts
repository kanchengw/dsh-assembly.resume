import type { StorageBackend, KvUnitDescriptor, KvUnit } from '@deepseek-ai/dsh-storage'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'

interface MemoryUnit {
  readonly descriptor: KvUnitDescriptor
  readonly records: Map<string, Map<string, unknown>>
  global: unknown
}

/** Small independent KV backend used only to exercise Cordis composition. */
export class MemoryBackend implements StorageBackend {
  readonly units = new Map<string, MemoryUnit>()

  readonly kv = {
    open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
      const existing = this.units.get(descriptor.name)
      if (existing !== undefined && existing.descriptor.version !== descriptor.version) {
        throw new Error('memory backend version mismatch')
      }
      const unit = existing ?? {
        descriptor,
        records: new Map(descriptor.tables.map(table => [table, new Map<string, unknown>()])),
        global: null,
      }
      this.units.set(descriptor.name, unit)
      let closed = false
      const assertOpen = () => {
        if (closed) throw new Error('memory unit closed')
      }
      return {
        loadAll: async () => {
          assertOpen()
          return {
            tables: Object.fromEntries([...unit.records].map(([name, values]) => [name, Object.fromEntries(values)])),
            global: unit.global,
          }
        },
        putRecord: async (table, key, value) => {
          assertOpen()
          unit.records.get(table)?.set(key, structuredClone(value))
        },
        deleteRecord: async (table, key) => {
          assertOpen()
          unit.records.get(table)?.delete(key)
        },
        setGlobal: async value => {
          assertOpen()
          unit.global = structuredClone(value)
        },
        close: async () => { closed = true },
      }
    },
  }

  async close(): Promise<void> {}
}

/** Small DSH Agent factory double: it records seed/create/resume calls without running a model. */
export class FakeDshAgentRuntime {
  readonly agents = new Map<string, Agent>()
  readonly created: CreateAgentOptions[] = []
  readonly resumed: ResumeAgentOptions[] = []

  get(id: string): Agent | undefined {
    return this.agents.get(id)
  }

  async create(options: CreateAgentOptions): Promise<AgentHandle> {
    this.created.push(options)
    const agent = this.make(options.sessionId, options.agentOptions ?? {}, options.seed ?? [])
    this.agents.set(String(options.sessionId), agent)
    return {
      agent,
      dispose: async () => { this.agents.delete(String(options.sessionId)) },
    }
  }

  async resume(options: ResumeAgentOptions): Promise<AgentHandle> {
    this.resumed.push(options)
    const existing = this.agents.get(String(options.resumeSessionId))
    const agent = existing ?? this.make(options.resumeSessionId, options.agentOptions ?? {}, [])
    this.agents.set(String(options.resumeSessionId), agent)
    return {
      agent,
      dispose: async () => { this.agents.delete(String(options.resumeSessionId)) },
    }
  }

  controller(id = 'controller', options: Agent['options'] = {}): Agent {
    return this.make(SessionId(id), options, [])
  }

  private make(id: SessionId, options: Agent['options'], events: readonly unknown[]): Agent {
    const runtime = this
    return {
      id,
      options,
      status: 'idle',
      inbox: undefined as never,
      session: { id, header: { cwd: process.cwd() }, events: [...events] } as never,
      ctx: { agents: runtime } as never,
      send: (() => {}) as never,
      followup: (() => {}) as never,
      steer: (() => ({ outcome: Promise.resolve({ status: 'rejected' }) })) as never,
      inject: (() => {}) as never,
      cancel: (() => {}) as never,
      runMaintenance: (task => task(new AbortController().signal)) as never,
      whenIdle: (() => Promise.resolve()) as never,
    }
  }
}
