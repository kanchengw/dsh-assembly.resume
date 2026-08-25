import { useEffect, useMemo, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ExternalProvider, DiscoveredExternalSession, TakeOverResult } from '../types.ts'
import type { SessionResumeKey } from './locales.ts'
import { groupSessionsByProject } from './project-groups.ts'
import { claudeCodeIcon, codexIcon } from './provider-icons.ts'
import css from './ResumeSettingsSection.module.css'

export type ResumeSettingsSectionProps = PropsRuntime<'settings.plugin.item'> & PropsLocale<'sessionResume'> & {
  readonly discover: (input: { provider: ExternalProvider; query?: string }) => Promise<DiscoveredExternalSession[]>
  readonly takeOver: (input: { provider: ExternalProvider; externalSessionId: string }) => Promise<TakeOverResult>
  readonly openTarget: (sessionId: SessionId, projectPath: string | undefined) => Promise<void>
}
/** Settings page for importing a native transcript and handing the live conversation to DSH. */
export function ResumeSettingsSection({ t, discover, takeOver, openTarget }: ResumeSettingsSectionProps) {
  const [open, setOpen] = useState(false)
  const [provider, setProvider] = useState<ExternalProvider>('codex')
  const [query, setQuery] = useState('')
  const [sessions, setSessions] = useState<DiscoveredExternalSession[]>([])
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(new Set())

  const selected = useMemo(() => sessions.find(row => row.externalSessionId === selectedId), [sessions, selectedId])
  const lastUserMessage = selected?.lastUserMessage ?? selected?.firstUserMessage
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

  // A collapsed settings card should not discover local CLI history yet.
  useEffect(() => {
    if (open) void reload()
  }, [open, provider])

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
    if (selected === undefined || pending) return
    setPending(true)
    setError(undefined)
    try {
      const takeover = await takeOver({
        provider: selected.provider,
        externalSessionId: selected.externalSessionId,
      })
      await openTarget(takeover.dshSessionId, selected.projectPath)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <li className={open ? `${css.card} ${css.cardOpen}` : css.card}>
      <button
        type="button"
        className={css.cardHeader}
        aria-expanded={open}
        aria-controls="session-resume-card-body"
        aria-label={`${t(open ? 'collapse' : 'expand' as SessionResumeKey)}: ${t('nav' as SessionResumeKey)}`}
        onClick={() => { setOpen(previous => !previous) }}
      >
        <span className={css.cardHeadText}>
          <span className={css.cardName}>{t('nav' as SessionResumeKey)}</span>
          <span className={css.cardDescription}>{t('description' as SessionResumeKey)}</span>
        </span>
        <span className={open ? `${css.cardChevron} ${css.cardChevronOpen}` : css.cardChevron} aria-hidden="true" />
      </button>
      {open ? (
        <div id="session-resume-card-body" className={css.cardBody}>
          <div className={css.section}>
            <div className={css.subheading}>{t('agent' as SessionResumeKey)}</div>
            <div className={css.toolbar}>
        <div className={css.providerTabs} role="tablist" aria-label={t('provider' as SessionResumeKey)}>
          <button type="button" className={provider === 'codex' ? css.tabActive : css.tab} onClick={() => { setProvider('codex') }} role="tab" aria-selected={provider === 'codex'}>
            <img className={css.providerIconImage} src={codexIcon} alt="" />
            {t('codex' as SessionResumeKey)}
          </button>
          <button type="button" className={provider === 'claude-code' ? css.tabActive : css.tab} onClick={() => { setProvider('claude-code') }} role="tab" aria-selected={provider === 'claude-code'}>
            <img className={css.providerIconImage} src={claudeCodeIcon} alt="" />
            {t('claudeCode' as SessionResumeKey)}
          </button>
          <button type="button" className={provider === 'claude-code-desktop' ? css.tabActive : css.tab} onClick={() => { setProvider('claude-code-desktop') }} role="tab" aria-selected={provider === 'claude-code-desktop'}>
            <img className={css.providerIconImage} src={claudeCodeIcon} alt="" />
            {t('claudeCodeDesktop' as SessionResumeKey)}
          </button>
        </div>
            </div>
            <div className={css.sessionHeader}>
              <div className={css.subheading}>{t('session' as SessionResumeKey)}</div>
              <button type="button" className={css.refresh} onClick={() => { void reload() }} disabled={loading || pending}>{t('refresh' as SessionResumeKey)}</button>
            </div>
            <div className={css.searchRow}>
              <input className={css.search} value={query} onChange={event => { setQuery(event.target.value) }} onKeyDown={event => { if (event.key === 'Enter') void reload() }} placeholder={t('search' as SessionResumeKey)} aria-label={t('search' as SessionResumeKey)} />
              <button type="button" className={css.refresh} onClick={() => { void reload() }} disabled={loading || pending}>{t('searchAction' as SessionResumeKey)}</button>
            </div>
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
                  <span className={css.projectChevron} aria-hidden="true">{expanded ? '⌄' : '›'}</span>
                  <span className={css.projectInfo}>
                    <span className={css.projectName}>{groupTitle}</span>
                    {group.cwd === undefined ? null : <span className={css.muted}>{group.cwd}</span>}
                  </span>
                </span>
                <span className={css.projectCount}>{group.sessions.length} {t('sessionsCount' as SessionResumeKey)}</span>
              </button>
              {expanded && (
                <div id={projectId} className={css.projectSessions}>
                  {group.sessions.map(row => (
                    <button key={`${row.provider}:${row.externalSessionId}`} type="button" className={row.externalSessionId === selectedId ? css.rowActive : css.row} onClick={() => { setSelectedId(row.externalSessionId) }}>
                      <span className={css.rowTitle}>{row.title ?? row.externalSessionId}</span>
                      {(row.lastUserMessage ?? row.firstUserMessage) === undefined ? null : <span className={css.muted}>{row.lastUserMessage ?? row.firstUserMessage}</span>}
                      <code className={css.sessionId}>{row.externalSessionId}</code>
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
          {selected.projectPath === undefined ? null : <div className={css.metaRow}><span className={css.muted}>{t('workspace' as SessionResumeKey)}:</span><span className={css.metaValue}>{selected.projectPath}</span></div>}
          {lastUserMessage === undefined ? null : <div className={css.metaRow}><span className={css.muted}>{t('lastMessage' as SessionResumeKey)}:</span><span className={css.metaValue}>{lastUserMessage}</span></div>}
          <button type="button" className={css.primary} disabled={pending} onClick={() => { void runTakeover() }}>
            {pending ? t('takingOver' as SessionResumeKey) : t('takeOver' as SessionResumeKey)}
          </button>
        </div>
      )}
          </div>
        </div>
      ) : null}
    </li>
  )
}
