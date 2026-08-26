import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

describe('session-resume settings entry', () => {
  it('registers inside the Plugins configuration card list', async () => {
    const register = vi.fn()
    const inject = vi.fn((_name: string, factory: () => unknown) => factory())
    const disposeRemote = vi.fn()
    const ctx = {
      effect: vi.fn(),
      locale: { register: vi.fn(), bind: vi.fn(() => (key: string) => key) },
      remote: { $mount: vi.fn(async () => disposeRemote) },
      slots: { inject, register },
    }

    await apply(ctx as never)

    expect(inject).toHaveBeenCalledWith('settings.plugin.item', expect.any(Function))
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'settings.plugin.item',
      key: 'session-resume',
    }), expect.any(Function))
    expect(register).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'settings.section' }), expect.any(Function))
    expect(register).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'settings.plugins.tab' }), expect.any(Function))
  })

  it('uses a collapsible peer-card shell rather than exposing controls in the list', () => {
    const source = readFileSync(resolve('src/client/ResumeSettingsSection.tsx'), 'utf8')

    expect(source).toContain('css.cardOpen')
    expect(source).toContain('aria-expanded={open}')
    expect(source).toContain('{open ? (')
    expect(source).toContain('className={css.cardBody}')
  })

  it('hides an absent recent-user-message field and gives a present value a block layout', () => {
    const component = readFileSync(resolve('src/client/ResumeSettingsSection.tsx'), 'utf8')
    const styles = readFileSync(resolve('src/client/ResumeSettingsSection.module.css'), 'utf8')

    expect(component).toContain('lastUserMessage === undefined ? null')
    expect(component).toContain('className={css.metaValue}')
    expect(styles).toContain('.metaValue')
    expect(styles).toContain('overflow-wrap: anywhere')
  })

  it('shows the immutable external session ID so visually matching sessions remain distinguishable', () => {
    const component = readFileSync(resolve('src/client/ResumeSettingsSection.tsx'), 'utf8')

    expect(component).toContain('<code className={css.sessionId}>{row.externalSessionId}</code>')
  })

  it('does not render the session ID as a fake recent-user-message preview', () => {
    const component = readFileSync(resolve('src/client/ResumeSettingsSection.tsx'), 'utf8')

    expect(component).toContain('{row.lastUserMessage ?? row.firstUserMessage}</span>')
  })

  it('explains the searchable session fields and gives projects visible disclosure markers', () => {
    const component = readFileSync(resolve('src/client/ResumeSettingsSection.tsx'), 'utf8')
    const styles = readFileSync(resolve('src/client/ResumeSettingsSection.module.css'), 'utf8')

    expect(zh.search).toBe('按标题、最近用户消息或会话 ID 搜索')
    expect(en.search).toBe('Search title, latest user message, or session ID')
    expect(component).toContain("{expanded ? '⌄' : '›'}")
    expect(styles).toContain('.projectChevron')
  })

  it('brands the plugin card as Assembly.Resume in both locales', () => {
    expect(zh.nav).toBe('Assembly.Resume - 会话转接')
    expect(en.nav).toBe('Assembly.Resume - Session Handoff')
  })

  it('separates agent and session selection with clear localized headings', () => {
    const component = readFileSync(resolve('src/client/ResumeSettingsSection.tsx'), 'utf8')
    const styles = readFileSync(resolve('src/client/ResumeSettingsSection.module.css'), 'utf8')

    expect(zh.description).toBe('将本地其他 Agent 会话导入到DeepSeek Harness。')
    expect(zh.empty).toBe('没有找到可转接的会话')
    expect(en.description).toBe('Import local sessions from other agents into DeepSeek Harness.')
    expect(zh.agent).toBe('选择 Agent')
    expect(zh.session).toBe('选择会话')
    expect(zh.takeOver).toBe('导入到 DSH 会话列表')
    expect(component).toContain("t('agent' as SessionResumeKey)")
    expect(component).toContain("t('session' as SessionResumeKey)")
    expect(styles).toContain('.subheading')
  })

  it('places refresh beside the session heading and provides a search button', () => {
    const component = readFileSync(resolve('src/client/ResumeSettingsSection.tsx'), 'utf8')
    const styles = readFileSync(resolve('src/client/ResumeSettingsSection.module.css'), 'utf8')

    expect(component).toContain('className={css.sessionHeader}')
    expect(component).toContain("t('searchAction' as SessionResumeKey)")
    expect(styles).toContain('.searchRow')
  })

  it('stacks each project path below a wrapping project name', () => {
    const component = readFileSync(resolve('src/client/ResumeSettingsSection.tsx'), 'utf8')
    const styles = readFileSync(resolve('src/client/ResumeSettingsSection.module.css'), 'utf8')

    expect(component).toContain('className={css.projectInfo}')
    expect(styles).toContain('.projectInfo')
    expect(styles).toContain('overflow-wrap: anywhere')
  })

  it('shows distinct Codex and Claude Code marks in the agent selector', () => {
    const component = readFileSync(resolve('src/client/ResumeSettingsSection.tsx'), 'utf8')
    const styles = readFileSync(resolve('src/client/ResumeSettingsSection.module.css'), 'utf8')

    expect(component).toContain("from './provider-icons.ts'")
    expect(component).toContain('src={codexIcon}')
    expect(component).toContain('src={claudeCodeIcon}')
    expect(styles).toContain('.providerIconImage')
    expect(styles).toMatch(/\.tabActive\s*\{[^}]*color: var\(--dsw-alias-label-on-fill\)[^}]*background: var\(--dsw-alias-state-business-primary\)/)
  })

  it('names the supported local agent surfaces precisely', () => {
    const component = readFileSync(resolve('src/client/ResumeSettingsSection.tsx'), 'utf8')
    const locales = readFileSync(resolve('src/client/locales.ts'), 'utf8')

    expect(locales).toContain("codex: 'Codex CLI / Desktop'")
    expect(locales).toContain("claudeCode: 'Claude Code CLI'")
    expect(locales).toContain("claudeCodeDesktop: 'Claude Desktop'")
    expect(component).toContain("setProvider('claude-code-desktop')")
    expect(component).toContain("t('claudeCodeDesktop' as SessionResumeKey)")
  })

  it('offers a replacement workspace without treating a missing source path as an error', () => {
    const component = readFileSync(resolve('src/client/ResumeSettingsSection.tsx'), 'utf8')
    const styles = readFileSync(resolve('src/client/ResumeSettingsSection.module.css'), 'utf8')

    expect(zh.workspaceMissing).toBe('原工作区已不存在')
    expect(zh.workspaceMissingHint).toBe('会话仍可导入。不选择目录时，会话将以未绑定状态导入；也可以选择一个本地目录作为新的工作区。')
    expect(zh.chooseWorkspace).toBe('绑定本地目录为工作区')
    expect(zh.changeWorkspace).toBe('更换本地目录')
    expect(zh.replacementWorkspace).toBe('新工作区目录')
    expect(zh.replacementWorkspaceHint).toBe('该目录将注册或复用为 DSH 工作区，并绑定到导入会话。')
    expect(zh.workspaceAutoBind).toBe('将自动绑定')
    expect(component).toContain('selected.projectPathAvailable !== false')
    expect(component).toContain("'chooseWorkspace'")
    expect(component).toContain("t('replacementWorkspaceHint' as SessionResumeKey)")
    expect(component).toContain('className={css.notice}')
    expect(styles).toContain('.notice')
    expect(styles).toContain('@media (max-width: 600px)')
  })

  it('lets an unscoped native session bind a local directory before import', () => {
    const component = readFileSync(resolve('src/client/ResumeSettingsSection.tsx'), 'utf8')

    expect(zh.noOriginalWorkspace).toBe('原会话未关联工作区')
    expect(zh.noOriginalWorkspaceHint).toBe('可以直接以未绑定状态导入，也可以绑定一个本地目录作为工作区。')
    expect(component).toContain("t('noOriginalWorkspace' as SessionResumeKey)")
    expect(component).toContain("t('noOriginalWorkspaceHint' as SessionResumeKey)")
  })
})
