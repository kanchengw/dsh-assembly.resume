import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ExternalProvider, DiscoveredExternalSession, TakeOverResult } from '../types.ts'
import type { SessionResumeKey } from './locales.ts'
import { groupSessionsByProject } from './project-groups.ts'
import css from './ResumeSettingsSection.module.css'

export type ResumeSettingsSectionProps = PropsRuntime<'settings.plugins.tab'> & PropsLocale<'sessionResume'> & {
  readonly discover: (input: { provider: ExternalProvider; query?: string }) => Promise<DiscoveredExternalSession[]>
  readonly takeOver: (sessionId: SessionId, input: { provider: ExternalProvider; externalSessionId: string }) => Promise<TakeOverResult>
  readonly openTarget: (sessionId: SessionId, projectPath: string | undefined) => Promise<void>
  readonly currentSession: SessionId | undefined
}

/** Settings page for importing a native transcript and handing the live conversation to DSH. */
export function ResumeSettingsSection({ t, discover, takeOver, openTarget, currentSession }: ResumeSettingsSectionProps) {
  const [provider, setProvider] = useState<ExternalProvider>('codex')
  const [query, setQuery] = useState('')
  const [sessions, setSessions] = useState<DiscoveredExternalSession[]>([])
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [result, setResult] = useState<TakeOverResult | undefined>()
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(new Set())

  const selected = useMemo(() => sessions.find(row => row.externalSessionId === selectedId), [sessions, selectedId])
  const projectGroups = useMemo(() => groupSessionsByProject(sessions), [sessions])
  const selectedProjectKey = selected === undefined
    ? undefined
    : projectGroups.find(group => group.sessions.some(row => row.externalSessionId === selected.externalSessionId))?.key

  const reload = async (): Promise<void> => {
    setLoading(true)
    setError(undefined)
    try {
      const discovered = await discover({ provider, ...(query.trim() === '' ? {} : { query: query.trim() }) })
      setSessions(discovered)
      setSelectedId(previous => discovered.some(row => row.externalSessionId === previous) ? previous : discovered[0]?.externalSessionId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void reload() }, [provider])

  useEffect(() => {
    setExpandedProjects(previous => {
      const available = new Set(projectGroups.map(group => group.key))
      const next = new Set([...previous].filter(key => available.has(key)))
      if (selectedProjectKey !== undefined) next.add(selectedProjectKey)
      if (next.size === 0 && projectGroups[0] !== undefined) next.add(projectGroups[0].key)
      return next
    })
  }, [projectGroups, selectedProjectKey])

  const runTakeover = async (): Promise<void> => {
    if (selected === undefined || currentSession === undefined || pending) return
    setPending(true)
    setError(undefined)
    setResult(undefined)
    try {
      const takeover = await takeOver(currentSession, {
        provider: selected.provider,
        externalSessionId: selected.externalSessionId,
      })
      await openTarget(takeover.dshSessionId, selected.projectPath)
      setResult(takeover)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className={css.section}>
      <div>
        <div className={css.detailTitle}>{t('title' as SessionResumeKey)}</div>
        <div className={css.muted}>{currentSession === undefined ? t('noCurrent' as SessionResumeKey) : t('ready' as SessionResumeKey)}</div>
      </div>
      <div className={css.toolbar}>
        <div className={css.providerTabs} role="tablist" aria-label={t('provider' as SessionResumeKey)}>
          <button type="button" className={provider === 'codex' ? css.tabActive : css.tab} onClick={() => { setProvider('codex') }} role="tab" aria-selected={provider === 'codex'}>{t('codex' as SessionResumeKey)}</button>
          <button type="button" className={provider === 'claude-code' ? css.tabActive : css.tab} onClick={() => { setProvider('claude-code') }} role="tab" aria-selected={provider === 'claude-code'}>{t('claudeCode' as SessionResumeKey)}</button>
        </div>
        <button type="button" className={css.refresh} onClick={() => { void reload() }} disabled={loading || pending}>{t('refresh' as SessionResumeKey)}</button>
      </div>
      <input className={css.search} value={query} onChange={event => { setQuery(event.target.value) }} onKeyDown={event => { if (event.key === 'Enter') void reload() }} placeholder={t('search' as SessionResumeKey)} aria-label={t('search' as SessionResumeKey)} />
      {error === undefined ? null : <div className={css.error} role="alert">{t('error' as SessionResumeKey)}: {error}</div>}
      <div className={css.list} aria-busy={loading}>
        {projectGroups.map((group, index) => {
          const expanded = expandedProjects.has(group.key)
          const projectId = `${provider}-project-${index}`
          const groupTitle = group.isNewChat ? t('newChats' as SessionResumeKey) : group.projectName ?? group.key
          return (
            <section key={group.key} className={css.projectGroup}>
              <button
                type="button"
                className={css.projectHeader}
                onClick={() => {
                  setExpandedProjects(previous => {
                    const next = new Set(previous)
                    if (next.has(group.key)) next.delete(group.key)
                    else next.add(group.key)
                    return next
                  })
                }}
                aria-expanded={expanded}
                aria-controls={projectId}
                aria-label={`${expanded ? t('collapseProject' as SessionResumeKey) : t('expandProject' as SessionResumeKey)}: ${groupTitle}`}
              >
                <span className={css.projectHeaderMain}>
                  <span className={expanded ? css.chevronOpen : css.chevron} aria-hidden="true" />
                  <span className={css.projectName}>{groupTitle}</span>
                  {group.cwd === undefined ? null : <span className={css.muted}>{group.cwd}</span>}
                </span>
                <span className={css.projectCount}>{group.sessions.length} {t('sessionsCount' as SessionResumeKey)}</span>
              </button>
              {expanded && (
                <div id={projectId} className={css.projectSessions}>
                  {group.sessions.map(row => (
                    <button key={`${row.provider}:${row.externalSessionId}`} type="button" className={row.externalSessionId === selectedId ? css.rowActive : css.row} onClick={() => { setSelectedId(row.externalSessionId); setResult(undefined) }}>
                      <span className={css.rowTitle}>{row.title ?? row.externalSessionId}</span>
                      <span className={css.muted}>{row.lastUserMessage ?? row.firstUserMessage ?? row.externalSessionId}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          )
        })}
        {sessions.length === 0 && !loading && <div className={css.muted}>{t('empty' as SessionResumeKey)}</div>}
      </div>
      {selected !== undefined && (
        <div className={css.detail}>
          <div className={css.detailTitle}>{t('selected' as SessionResumeKey)}: {selected.title ?? selected.externalSessionId}</div>
          {selected.projectPath === undefined ? null : <div className={css.metaRow}><span className={css.muted}>{t('workspace' as SessionResumeKey)}:</span><span className={css.muted}>{selected.projectPath}</span></div>}
          <div className={css.metaRow}><span className={css.muted}>{t('lastMessage' as SessionResumeKey)}:</span><span className={css.muted}>{selected.lastUserMessage ?? selected.firstUserMessage ?? ''}</span></div>
          <button type="button" className={css.primary} disabled={pending || currentSession === undefined} onClick={() => { void runTakeover() }}>
            {pending ? t('takingOver' as SessionResumeKey) : t('takeOver' as SessionResumeKey)}
          </button>
          {result !== undefined && <div className={css.response} role="status">{result.reused ? t('reopened' as SessionResumeKey) : t('imported' as SessionResumeKey)}</div>}
        </div>
      )}
    </div>
  )
}

/** Keep the current session selection reactive without coupling to a conversation slot. */
export function useCurrentSession(ctx: { get(key: string): unknown }): SessionId | undefined {
  const sessions = ctx.get('sessions') as {
    list: { getSnapshot(): { current: SessionId | undefined }; subscribe(listener: () => void): () => void }
  }
  return useSyncExternalStore(sessions.list.subscribe, () => sessions.list.getSnapshot().current)
}
