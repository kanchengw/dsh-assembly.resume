import type { ClientContext, IWorkspaces, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '../remote.ts'
import { TYPERT_REMOTE, type SessionResumeRemote } from '../remote.ts'
import type { ExternalProvider, DiscoveredExternalSession, TakeOverResult } from '../types.ts'
import { ResumeSettingsSection } from './ResumeSettingsSection.tsx'
import { en, zh } from './locales.ts'
import { getSessionResumeRemote } from './remote-access.ts'
import { openDshTargetSession, type OpenDshTargetResult } from './workspace-target.ts'

const NS = 'sessionResume'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    sessionResume: import('./locales.ts').SessionResumeKey
  }
}

/** Services required by the independent browser half. */
export const inject = ['slots', 'locale', 'remote', 'sessions', 'workspaces']

function createSectionProps(ctx: ClientContext) {
  const remote = (): SessionResumeRemote => getSessionResumeRemote(ctx)
  const sessions = ctx.get('sessions') as unknown as Pick<ISessions, 'open'> & {
    create(options: { workspaceId?: string; sessionId?: SessionId }): Promise<SessionId>
  }
  const workspaces = ctx.get('workspaces') as IWorkspaces
  return {
    discover: async (input: { provider: ExternalProvider; query?: string }): Promise<DiscoveredExternalSession[]> => {
      const result = await remote().discover(input)
      if (!result.ok) throw new Error(result.error.message)
      return [...result.value]
    },
    takeOver: async (input: { provider: ExternalProvider; externalSessionId: string; targetWorkspacePath?: string }): Promise<TakeOverResult> => {
      const result = await remote().takeOverStandalone({ ...input, externalSessionId: input.externalSessionId as never })
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    chooseWorkspace: (): Promise<string | null> => workspaces.pickDirectory(),
    openTarget: (targetSessionId: SessionId, projectPath: string | undefined): Promise<OpenDshTargetResult> => {
      return openDshTargetSession(workspaces, sessions, targetSessionId, projectPath)
    },
  }
}

/** Mount the Remote contribution and register the native-session Plugins card. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-resume: dictionaries')
  const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE)
  function ResumeCard(props: PropsRuntime<'settings.plugin.item'> & PropsLocale<'sessionResume'>) {
    return createElement(ResumeSettingsSection, { ...props, ...createSectionProps(ctx) })
  }

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: 'session-resume',
    locale: NS,
    inject: () => createSectionProps(ctx),
  }, ResumeCard))
  return disposeRemote
}

export { ResumeSettingsSection } from './ResumeSettingsSection.tsx'
