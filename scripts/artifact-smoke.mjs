import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const rootArtifact = resolve('lib/index.js')
const invariantArtifact = resolve('lib/invariant.js')
await stat(rootArtifact)
await stat(invariantArtifact)

if (packageJson.exports['.'].default !== './lib/index.js') {
  throw new Error('package root export does not point to lib/index.js')
}
if (packageJson.exports['./invariant'].default !== './lib/invariant.js') {
  throw new Error('invariant export does not point to lib/invariant.js')
}

const rootSource = await readFile(rootArtifact, 'utf8')
if (!rootSource.includes('SessionResumeService as default')) {
  throw new Error('package root artifact does not contain the default service export')
}

const invariant = await import('dsh-assembly.resume/invariant')

if (typeof invariant.apply !== 'function' || invariant.name !== 'session-resume-invariant') {
  throw new Error('invariant subpath is not loadable through package exports')
}

const typert = await import('dsh-assembly.resume/typert')
if (typert.TYPERT?.package !== packageJson.name || typert.TYPERT?.face !== 'host') {
  throw new Error('Host Typert artifact is not owned by dsh-assembly.resume')
}
if (!typert.TYPERT.invocations.some((descriptor) => descriptor.method === 'discover')) {
  throw new Error('Host Typert artifact does not expose sessionResume/discover')
}

const remote = await import('dsh-assembly.resume/remote')
if (remote.TYPERT_REMOTE?.package !== packageJson.name) {
  throw new Error('Remote Typert artifact is not owned by dsh-assembly.resume')
}

console.log('dsh-assembly.resume package artifact smoke passed')
