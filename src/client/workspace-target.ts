import type { IWorkspaces, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

type SessionPort = {
  open(id: SessionId): void
  create(options: { workspaceId?: WorkspaceView['workspaceId']; sessionId?: SessionId }): Promise<SessionId>
}

function normalizePath(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/\/+$/u, '')
  return /^[a-z]:\//iu.test(normalized) ? normalized.toLowerCase() : normalized
}

function workspaceAtPath(workspaces: readonly WorkspaceView[], path: string): WorkspaceView | undefined {
  const key = normalizePath(path)
  return workspaces.find(workspace => normalizePath(workspace.path) === key)
}

/** Attach a newly-created DSH takeover session to its native project and select it. */
export async function openDshTargetSession(
  workspaces: Pick<IWorkspaces, 'list' | 'create'>,
  sessions: SessionPort,
  sessionId: SessionId,
  projectPath: string | undefined,
): Promise<SessionId> {
  if (projectPath === undefined) {
    sessions.open(sessionId)
    return sessionId
  }

  const existingWorkspace = workspaceAtPath(workspaces.list.getSnapshot().items, projectPath)
  // DSH Host requires exact cwd strings when attaching an existing session.
  if (existingWorkspace !== undefined && existingWorkspace.path !== projectPath) {
    sessions.open(sessionId)
    return sessionId
  }

  const workspace = existingWorkspace ?? await workspaces.create({ path: projectPath })
  await sessions.create({ workspaceId: workspace.workspaceId, sessionId })
  sessions.open(sessionId)
  return sessionId
}
