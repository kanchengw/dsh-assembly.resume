import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import ts from 'typescript'

const dshRoot = resolve('..', '..', 'deepseek-harness-latest')
const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m

function standardDecoratorPlugin() {
  return {
    name: 'session-resume-standard-decorators',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          jsx: file.endsWith('x') ? ts.JsxEmit.ReactJSX : undefined,
          sourceMap: true,
        },
      })
      return {
        code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      }
    },
  }
}

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  resolve: {
    alias: {
      '@deepseek-ai/cordis': resolve(dshRoot, 'vendor/cordis/src'),
      '@deepseek-ai/cosmokit': resolve(dshRoot, 'vendor/cosmokit/src'),
      '@deepseek-ai/schemastery': resolve(dshRoot, 'vendor/schemastery/src'),
      '@deepseek-ai/dsh-brand': resolve(dshRoot, 'packages/util/brand/src'),
      '@deepseek-ai/dsh-agent': resolve(dshRoot, 'packages/core/agent/src'),
      '@deepseek-ai/dsh-invariants': resolve(dshRoot, 'packages/runtime-diagnostics/invariants/src'),
      '@deepseek-ai/dsh-llm': resolve(dshRoot, 'packages/llm/llm/src'),
      '@deepseek-ai/dsh-llm/message': resolve(dshRoot, 'packages/llm/llm/src/message.ts'),
      '@deepseek-ai/dsh-llm/types': resolve(dshRoot, 'packages/llm/llm/src/types.ts'),
      '@deepseek-ai/dsh-session': resolve(dshRoot, 'packages/core/session/src'),
      '@deepseek-ai/dsh-scope': resolve(dshRoot, 'packages/core/scope/src'),
      '@deepseek-ai/dsh-timeout': resolve(dshRoot, 'packages/util/timeout/src'),
      '@deepseek-ai/dsh-storage': resolve(dshRoot, 'packages/storage/storage/src'),
      '@deepseek-ai/dsh-storage-domain': resolve(dshRoot, 'packages/storage/storage-domain/src'),
      '@deepseek-ai/dsh-typert-protocol': resolve(dshRoot, 'packages/typert/protocol/src'),
    },
  },
  ssr: {
    noExternal: true,
  },
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
