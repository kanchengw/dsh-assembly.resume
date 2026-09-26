import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
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
export const inject = ['slots', 'locale', 'remote', 'sessions', 'workspaces', 'uiWorkspace']

function createSectionProps(ctx: Context) {
  const remote = (): SessionResumeRemote => getSessionResumeRemote(ctx)
  const sessions = ctx.get('sessions') as unknown as Pick<ISessions, 'create'>
  const workspaces = ctx.get('workspaces') as IWorkspaces
  const uiWorkspace = ctx.get('uiWorkspace') as UiWorkspace
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
    chooseWorkspace: (): Promise<string | null> => uiWorkspace.pickDirectory(),
    openTarget: (targetSessionId: SessionId, projectPath: string | undefined): Promise<OpenDshTargetResult> => {
      return openDshTargetSession(workspaces, {
        open: (id) => { uiWorkspace.openSession(id) },
        create: (options) => sessions.create(options),
      }, targetSessionId, projectPath)
    },
  }
}

/** Mount the Remote contribution and register the native-session Plugins card. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-resume: dictionaries')
  const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE)
  function ResumeCard(props: PropsRuntime<'settings.plugins.tab'> & PropsLocale<'sessionResume'>) {
    return createElement(ResumeSettingsSection, { ...props, ...createSectionProps(ctx) })
  }

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'session-resume',
    order: 100,
    label: () => ctx.locale.bind(NS)('nav'),
    locale: NS,
    inject: () => createSectionProps(ctx),
  }, ResumeCard))
  return disposeRemote
}

export { ResumeSettingsSection } from './ResumeSettingsSection.tsx'
