import type { ClientContext, IWorkspaces, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '../remote.ts'
import { TYPERT_REMOTE, type SessionResumeRemote } from '../remote.ts'
import type { ExternalProvider, DiscoveredExternalSession, TakeOverResult } from '../types.ts'
import { ResumeSettingsSection, useCurrentSession } from './ResumeSettingsSection.tsx'
import { en, zh } from './locales.ts'
import { getSessionResumeRemote } from './remote-access.ts'
import { openDshTargetSession } from './workspace-target.ts'

const NS = 'sessionResume'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    sessionResume: import('./locales.ts').SessionResumeKey
  }
}

/** Services required by the independent browser half. */
export const inject = ['slots', 'locale', 'remote', 'sessions', 'workspaces']

function createSectionProps(ctx: ClientContext, sessionId: SessionId | undefined) {
  const remote = (): SessionResumeRemote => getSessionResumeRemote(ctx)
  const sessions = ctx.get('sessions') as unknown as ISessions & {
    create(options: { workspaceId?: string; sessionId?: SessionId }): Promise<SessionId>
  }
  const workspaces = ctx.get('workspaces') as IWorkspaces
  return {
    currentSession: sessionId,
    discover: async (input: { provider: ExternalProvider; query?: string }): Promise<DiscoveredExternalSession[]> => {
      const result = await remote().discover(input)
      if (!result.ok) throw new Error(result.error.message)
      return [...result.value]
    },
    takeOver: async (id: SessionId, input: { provider: ExternalProvider; externalSessionId: string }): Promise<TakeOverResult> => {
      const result = await remote().takeOver(id, { ...input, externalSessionId: input.externalSessionId as never })
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    openTarget: async (targetSessionId: SessionId, projectPath: string | undefined): Promise<void> => {
      await openDshTargetSession(workspaces, sessions, targetSessionId, projectPath)
    },
  }
}

/** Mount the Remote contribution and register the native-session Plugins tab. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-resume: dictionaries')
  const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE)
  const t = ctx.locale.bind(NS)
  function SectionHost(props: PropsRuntime<'settings.plugins.tab'> & PropsLocale<'sessionResume'>) {
    const sessionId = useCurrentSession(ctx)
    return createElement(ResumeSettingsSection, { ...props, ...createSectionProps(ctx, sessionId) })
  }

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'session-resume',
    order: 20,
    label: () => t('nav'),
    locale: NS,
    inject: () => createSectionProps(ctx, undefined),
  }, SectionHost))
  return disposeRemote
}

export { ResumeSettingsSection } from './ResumeSettingsSection.tsx'
