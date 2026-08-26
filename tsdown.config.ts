import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { defineConfig } from 'tsdown'

const PACKAGE_ID = 'dsh-assembly.resume'

function cssModulePlugin() {
  return {
    name: 'dsh-assembly.resume-css-modules',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css') || importer === undefined) return undefined
      return `${resolve(dirname(importer), source)}?dsh-css-module`
    },
    load(id: string) {
      if (!id.endsWith('?dsh-css-module')) return undefined
      const emittedPath = id.slice(0, -'?dsh-css-module'.length)
      const sourcePath = emittedPath.replace(`${sep}lib${sep}types${sep}`, `${sep}src${sep}`)
      const path = existsSync(emittedPath) ? emittedPath : sourcePath
      const css = readFileSync(path, 'utf8')
      const classes = Object.fromEntries([...css.matchAll(/\.([A-Za-z_$][\w$-]*)\s*\{/gu)].map(match => [match[1], match[1]]))
      return `const css = ${JSON.stringify(css)}; if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css=${JSON.stringify(PACKAGE_ID)}]')) { const tag = document.createElement('style'); tag.dataset.plugin = ${JSON.stringify(PACKAGE_ID)}; tag.dataset.pluginCss = ${JSON.stringify(PACKAGE_ID)}; tag.textContent = css; document.head.appendChild(tag); } export default ${JSON.stringify(classes)};`
    },
  }
}

function moduleLoaderPlugin() {
  return {
    name: 'dsh-assembly.resume-module-loader',
    renderChunk(code: string) {
      const factory = `window.__ModuleLoader__.load({id:${JSON.stringify(PACKAGE_ID)},factory:(require)=>{var module={exports:{}};var exports=module.exports;${code};return module.exports;}});`
      return { code: factory, map: null }
    },
  }
}

export default defineConfig([
  {
    entry: {
      index: 'lib/types/index.js',
      invariant: 'lib/types/invariant.js',
      remote: 'lib/types/remote.js',
      'typert.host': 'lib/types/typert.host.js',
      'typert.remote-client': 'lib/types/typert.remote-client.js',
    },
    outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false,
  },
  {
    entry: { client: 'lib/types/client/index.js' },
    outDir: 'lib', format: ['cjs'], platform: 'browser', target: 'es2022', fixedExtension: false, dts: false, clean: false,
    outExtensions: () => ({ js: '.js' }),
    deps: {
      neverBundle: (specifier: string) => /^@deepseek-ai\//u.test(specifier) || /^react(?:\/|$)/u.test(specifier),
    },
    plugins: [cssModulePlugin(), moduleLoaderPlugin()],
  },
])
