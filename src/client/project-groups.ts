import type { DiscoveredExternalSession } from '../types.ts'

export interface ProjectSessionGroup {
  readonly key: string
  readonly projectName?: string
  readonly cwd?: string
  readonly isNewChat: boolean
  readonly sessions: readonly DiscoveredExternalSession[]
  readonly latestUpdatedAt?: string
}

export const NEW_CHAT_GROUP_KEY = '__dsh_new_chat__'

function normalizeWorkspacePath(cwd: string): string {
  const value = cwd.trim().replaceAll('\\', '/')
  if (value === '') return ''

  const isWindowsPath = /^[a-z]:\//iu.test(value) || value.startsWith('//')
  const normalized = value.length > 1 && !/^[a-z]:\/$/iu.test(value)
    ? value.replace(/\/+$/u, '')
    : value
  return isWindowsPath ? normalized.toLowerCase() : normalized
}

function projectNameFromPath(cwd: string): string {
  const path = cwd.trim().replaceAll('\\', '/')
  if (path === '') return 'untitled'
  if (path === '/' || /^[a-z]:\/$/iu.test(path)) return path
  return path.replace(/\/+$/u, '').split('/').at(-1) || path
}

function timestamp(value: string | undefined): number {
  if (value === undefined) return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

function compareSessions(left: DiscoveredExternalSession, right: DiscoveredExternalSession): number {
  const activity = timestamp(right.updatedAt) - timestamp(left.updatedAt)
  if (activity !== 0) return activity
  return left.externalSessionId.localeCompare(right.externalSessionId)
}

function compareGroups(left: ProjectSessionGroup, right: ProjectSessionGroup): number {
  const activity = timestamp(right.latestUpdatedAt) - timestamp(left.latestUpdatedAt)
  if (activity !== 0) return activity
  return left.key.localeCompare(right.key)
}

/** Group the already-filtered discovery result by its native workspace. */
export function groupSessionsByProject(sessions: readonly DiscoveredExternalSession[]): ProjectSessionGroup[] {
  const grouped = new Map<string, DiscoveredExternalSession[]>()
  for (const session of sessions) {
    const key = session.projectPath === undefined ? NEW_CHAT_GROUP_KEY : normalizeWorkspacePath(session.projectPath)
    const rows = grouped.get(key)
    if (rows === undefined) grouped.set(key, [session])
    else rows.push(session)
  }

  return [...grouped.entries()].map(([key, rows]) => {
    const ordered = [...rows].sort(compareSessions)
    const latest = ordered.find(row => timestamp(row.updatedAt) > 0)?.updatedAt
    const isNewChat = key === NEW_CHAT_GROUP_KEY
    const projectPath = rows[0]?.projectPath
    const base = { key, isNewChat, sessions: ordered }
    if (isNewChat) return latest === undefined ? base : { ...base, latestUpdatedAt: latest }
    return {
      ...base,
      projectName: projectNameFromPath(projectPath ?? key),
      cwd: projectPath ?? key,
      ...(latest === undefined ? {} : { latestUpdatedAt: latest }),
    }
  }).sort((left, right) => {
    if (left.isNewChat !== right.isNewChat) return left.isNewChat ? 1 : -1
    return compareGroups(left, right)
  })
}
