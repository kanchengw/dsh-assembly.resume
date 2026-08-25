import type { SessionResumeRemote } from '../remote.ts'

/** Read the namespace after this plugin has mounted its own Remote contribution. */
export function getSessionResumeRemote(ctx: { get(key: string): unknown }): SessionResumeRemote {
  return ctx.get('remote.sessionResume') as SessionResumeRemote
}
