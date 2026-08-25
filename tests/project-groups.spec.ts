import { describe, expect, it } from 'vitest'
import type { DiscoveredExternalSession } from '../src/types.ts'
import { groupSessionsByProject, NEW_CHAT_GROUP_KEY } from '../src/client/project-groups.ts'

function session(input: Partial<DiscoveredExternalSession> & Pick<DiscoveredExternalSession, 'externalSessionId' | 'cwd'>): DiscoveredExternalSession {
  return {
    provider: 'codex',
    sourcePath: `${input.externalSessionId}.jsonl`,
    resumable: true,
    ...input,
  }
}

describe('project session groups', () => {
  it('groups sessions with the same workspace and exposes the project name', () => {
    const groups = groupSessionsByProject([
      session({ externalSessionId: 'one', cwd: 'E:\\projects\\demo', projectPath: 'E:\\projects\\demo', updatedAt: '2026-08-24T10:00:00.000Z' }),
      session({ externalSessionId: 'two', cwd: 'E:/projects/demo/', projectPath: 'E:/projects/demo/', updatedAt: '2026-08-24T09:00:00.000Z' }),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      key: 'e:/projects/demo',
      projectName: 'demo',
      cwd: 'E:\\projects\\demo',
    })
    expect(groups[0]?.sessions.map(row => row.externalSessionId)).toEqual(['one', 'two'])
  })

  it('merges Windows paths that differ only by casing', () => {
    const groups = groupSessionsByProject([
      session({ externalSessionId: 'one', cwd: 'C:\\Work\\App', projectPath: 'C:\\Work\\App' }),
      session({ externalSessionId: 'two', cwd: 'c:/work/app', projectPath: 'c:/work/app' }),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]?.key).toBe('c:/work/app')
    expect(groups[0]?.projectName).toBe('App')
  })

  it('sorts projects and sessions by most recent valid activity', () => {
    const groups = groupSessionsByProject([
      session({ externalSessionId: 'old', cwd: '/repo/old', projectPath: '/repo/old', updatedAt: '2026-08-24T08:00:00.000Z' }),
      session({ externalSessionId: 'newer', cwd: '/repo/new', projectPath: '/repo/new', updatedAt: '2026-08-24T11:00:00.000Z' }),
      session({ externalSessionId: 'newest', cwd: '/repo/new', projectPath: '/repo/new', updatedAt: '2026-08-24T12:00:00.000Z' }),
    ])

    expect(groups.map(group => group.projectName)).toEqual(['new', 'old'])
    expect(groups[0]?.latestUpdatedAt).toBe('2026-08-24T12:00:00.000Z')
    expect(groups[0]?.sessions.map(row => row.externalSessionId)).toEqual(['newest', 'newer'])
  })

  it('keeps empty and unusual paths usable and deterministic', () => {
    const groups = groupSessionsByProject([
      session({ externalSessionId: 'empty', cwd: '', projectPath: '' }),
      session({ externalSessionId: 'root', cwd: '/', projectPath: '/' }),
      session({ externalSessionId: 'invalid-date', cwd: '/repo/project', projectPath: '/repo/project', updatedAt: 'not-a-date' }),
    ])

    expect(groups.map(group => ({ key: group.key, projectName: group.projectName }))).toEqual([
      { key: '', projectName: 'untitled' },
      { key: '/', projectName: '/' },
      { key: '/repo/project', projectName: 'project' },
    ])
  })

  it('puts every session without a project association into one new-chat group', () => {
    const groups = groupSessionsByProject([
      session({ externalSessionId: 'one', cwd: 'C:\\Users\\user\\Documents\\Codex\\2026-08-24\\one' }),
      session({ externalSessionId: 'two', cwd: 'C:\\Users\\user\\Documents\\Codex\\2026-08-23\\two' }),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ key: NEW_CHAT_GROUP_KEY, isNewChat: true })
    expect(groups[0]?.cwd).toBeUndefined()
    expect(groups[0]?.sessions.map(row => row.externalSessionId)).toEqual(['one', 'two'])
  })
})
