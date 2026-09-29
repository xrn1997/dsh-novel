# 存证：dsh-context 官方 tsdown.config.ts（上游原文快照）

- 抓取时间：2026-09-14
- 来源：https://raw.githubusercontent.com/bowenliang123/dsh-context/main/tsdown.config.ts
- 用途：本仓 `tsdown.config.ts` 的双配置以本文为准（上游原文快照——升版后重新推导的基数）；改构建配置无需再联网。
- 本地互补证据：`dsh-plugin-api.md` §6/§7（编译产物形态）。

**对 dsh-novel 的四条关键启示（相对最初配置草稿的实质差异）：**

1. **三段式工厂是 banner / intro / footer 三键**——`intro` 单独承载 `var module = { exports: {} }; var exports = module.exports;`，不并进 banner 字符串。
2. **client 侧 external 用 `deps.neverBundle` / `deps.alwaysBundle` 函数**（tsdown 0.23 语义），不是顶层 `external` 数组：模块表能答的 require 留 import，其余全部 inline。host 侧同理：`@deepseek-ai/*` 留 import，npm 依赖 inline。
3. **`define` 四键**（`process.env`、`process.env.NODE_ENV`、`import.meta.env.MODE`、`import.meta.env`）缺一不可——inline 进来的 node 习惯依赖会在浏览器 boot 抛 ReferenceError。
4. **纯度门是构建期插件**（`resolveId` 里对非白名单 `@deepseek-ai/*` 直接 throw），不是构建后断言；type-only import 已被擦除、到不了这道门。

另注：官方 PLATFORM_MODULES 清单不含裸 `cordis`（只有 `@deepseek-ai/cordis`）——**本仓最终按这一条办**（2026-09-29：宿主 `0.2.0-rc.2` 的 web shell `staticModules()` 里也确实没有裸 `cordis`，见 `dsh-plugin-api.md` 同日复核）；官方配置还带 Tailwind/lightningcss 的 CSS 通道插件与 cssModules 虚拟模块——dsh-novel v1 用内联样式 + 主题变量，**不引入**这些通道。

## 第二数据点：dsh-better-sidebar tsdown.config.ts（互补差异）

- 抓取时间：2026-09-14；来源：https://raw.githubusercontent.com/omdsh-dev/DSH-better-sidebar/main/tsdown.config.ts
- 与 dsh-context 的差异（已并入本仓 `tsdown.config.ts`）：
  1. 其 CLIENT_EXTERNALS 用**裸 `'cordis'`**（无 `@deepseek-ai/cordis`、无 dsh-client-store）——两官方样例清单不一致。本仓**不取并集**：样例清单只代表它编译时那一代，运行时的模块表才是分母，并集里多出来的每一条都是纯度门的一次豁免（现行判据与理由写在 `tsdown.config.ts` 的 `PLATFORM_MODULES` 上）；
  2. 纯度门额外拦 **Node builtin**（`node:fs` 等闯进浏览器 bundle 直接 throw）；
  3. `define` 追加 `'import.meta.resolve': 'undefined'`（browser CJS 无 loader，防 stray 解析到 Node）；
  4. `inputOptions.resolve.conditionNames = ['browser','import','require','default']`——CJS 输出防传递依赖解析到 Node 入口；
  5. `noExternal: (id) => 外部清单含 id ? undefined : true`——「其余一切强制 inline」的双保险语义。
- 其余（三段式 banner/intro/footer、entryFileNames、codeSplitting: false、clean: false）与 dsh-context 一致，互证为官方 preset 形态。
- better-sidebar 的懒 chunk 机制（`globalThis.__dshChunks__`）dsh-novel v1 **不用**——无重依赖需要懒加载。

---

## 原文快照

```ts
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import { compile as compileTailwind } from '@tailwindcss/node'
import { Scanner } from '@tailwindcss/oxide'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'

// Read the manifest from cwd: the config file's own URL is not guaranteed to
// sit at the package root under every loader, and `pnpm run build` runs here.
const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))

// Mirrors packages/client/web/src/platform.ts in deepseek-harness: the shell
// seeds these specifiers into the frozen browser module table, so client
// bundles leave them to the injected `require` instead of inlining. (Since
// dsh 0.1.2 the preloaded-client-externals channel is gone —
// `@deepseek-ai/dsh-client-runtime` was deleted and `dsh-client-store` joined
// the platform baseline; bundles must require nothing beyond this list.)
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

// Mirrors the purity-gate allowances in packages/client/tsdown.client.ts:
// wire/type layers with no shared runtime identity may inline; every other
// @deepseek-ai/* value import is a build error (cross-plugin collaboration
// goes through cordis services). `util-workspace-path` is the browser-safe
// file-address layer (`fileAddressFor`) the right Sidebar's own file types
// inline too, so the preview addresses this plugin builds are the harness's.
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|file-reference|session|llm|tools|brand|util-workspace-path)(\/|$)/
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

const requested = new Set([
  ...PLATFORM_MODULES,
  ...(pkg.dsh?.client?.external ?? []),
])
const isRequested = (specifier: string): boolean => requested.has(specifier)

// Host half: a production dependency is on disk in a real install and stays
// an import; everything else inlines. Both halves are stated so moving a
// dependency between npm sections never silently re-bundles it.
const productionDeps = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
])
const escapeSpecifier = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const productionPatterns = [...productionDeps].map(name => new RegExp(`^${escapeSpecifier(name)}(/|$)`))
const isProductionDependency = (specifier: string): boolean =>
  productionPatterns.some(pattern => pattern.test(specifier))

const NODE_ENV = process.env.NODE_ENV ?? 'production'

// CSS channels, mirrored from packages/client/tsdown.client.ts. The virtual
// ids must NOT end in `.css` — tsdown's own css-pipeline guard matches on that
// suffix; the plugin's flat lc-* class namespace is the anti-collision rule.
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const GLOBAL_CSS_VIRTUAL_PREFIX = '\0dsh-global-css:'
const INLINE_CSS_VIRTUAL_PREFIX = '\0dsh-inline-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const INLINE_CSS_QUERY = '?inline'

function styleInjectionModule(
  id: string,
  fileId: string,
  css: string,
  classMap?: Readonly<Record<string, string>>,
): string {
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

function sourceAssetPath(source: string, importer: string): string {
  return resolvePath(dirname(importer), source)
}

// The one sheet whose Tailwind utilities are compiled (src/client/styles/tailwind.css):
// its @source directives name the scanned client sources, and the resolved sources
// drive the oxide scanner here. Every other sheet stays plain CSS.
const TAILWIND_ENTRY = 'tailwind.css'

interface WatchCapable {
  addWatchFile(file: string): void
}

async function compileTailwindSheet(loader: WatchCapable, fileId: string, source: string): Promise<string> {
  const compiler = await compileTailwind(source, {
    base: dirname(fileId),
    onDependency: (file) => { loader.addWatchFile(file) },
  })
  const scanner = new Scanner({ sources: compiler.sources })
  const candidates = scanner.scan()
  // Scanned sources feed the candidates, so a watch rebuild must also fire when
  // a component's class list changes, not just when a stylesheet does.
  for (const file of scanner.files) loader.addWatchFile(file)
  return compiler.build(candidates)
}

function cssChannels(id: string) {
  return [{
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(this: { addWatchFile(file: string): void }, virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      // The virtual id otherwise hides the physical stylesheet from the watch graph.
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      const exportEntries = Object.entries(cssExports ?? {})
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      for (const [local, exp] of exportEntries) classMap[local] = exp.name
      return styleInjectionModule(id, fileId, code.toString(), classMap)
    },
  }, {
    name: 'dsh-css-text-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith(`.css${INLINE_CSS_QUERY}`)) return null
      const stylesheet = source.slice(0, -INLINE_CSS_QUERY.length)
      const abs = importer !== undefined ? sourceAssetPath(stylesheet, importer) : stylesheet
      return INLINE_CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(this: { addWatchFile(file: string): void }, virtualId: string) {
      if (!virtualId.startsWith(INLINE_CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(INLINE_CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code } = transform({ filename: fileId, code: source, minify: true })
      return `export default ${JSON.stringify(code.toString())};`
    },
  }, {
    name: 'dsh-css-global-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.css') || source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
      return GLOBAL_CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(this: { addWatchFile(file: string): void }, virtualId: string) {
      if (!virtualId.startsWith(GLOBAL_CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(GLOBAL_CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const raw = await readFile(fileId)
      // The Tailwind entry compiles to a CSS string first; every other sheet
      // hands its Buffer straight to lightningcss. Either way the binding
      // reads the TypedArray, so the code must never arrive as a string.
      const code = basename(fileId) === TAILWIND_ENTRY
        ? Buffer.from(await compileTailwindSheet(this, fileId, raw.toString()))
        : raw
      const { code: css } = transform({ filename: fileId, code, minify: true })
      return styleInjectionModule(id, fileId, css.toString())
    },
  }]
}

export default defineConfig([
  {
    name: pkg.name,
    entry: { index: 'src/host/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    // The host half's Config/projection types are the integration contract
    // other plugins and tooling compile against; ship them next to the JS.
    dts: true,
    clean: true,
    deps: {
      neverBundle: isProductionDependency,
      alwaysBundle: (specifier: string) => !isBuiltin(specifier) && !isProductionDependency(specifier),
    },
  },
  {
    name: `${pkg.name}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    // dts would wrap the banner/footer into a .d.cts and break parsing;
    // browser profiling consumes the bundle's own sourcemap instead.
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      // A require() the module table cannot answer is a guaranteed runtime
      // throw: requested specifiers stay imports, everything else inlines.
      neverBundle: isRequested,
      alwaysBundle: (specifier: string) => !isRequested(specifier),
    },
    // Browser bundles inline node-idiom deps that read process.env.NODE_ENV
    // or probe import.meta.env(.MODE); without these substitutions the
    // factory throws ReferenceError at boot.
    define: {
      'process.env': '{}',
      'process.env.NODE_ENV': JSON.stringify(NODE_ENV),
      'import.meta.env.MODE': JSON.stringify(NODE_ENV),
      'import.meta.env': JSON.stringify({ MODE: NODE_ENV }),
      __DSH_CTX_VERSION__: JSON.stringify(pkg.version),
      __DSH_CTX_REPO__: JSON.stringify(
        String((pkg.repository && pkg.repository.url) || '').replace(/^git\+/, '').replace(/\.git$/, ''),
      ),
    },
    plugins: [{
      name: 'dsh-client-bundle-purity',      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (isRequested(source)) return null
        if (VENDORED_LIBRARY.test(source)) return null
        if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null
        throw new Error(
          `client bundle purity: "${source}" is not in the default client externals or ${pkg.name}'s dsh.client.external, an inline-safe wire layer, or a generated /remote contribution — `
          + 'cross-plugin value imports are forbidden; declare a non-default module request or collaborate through cordis services '
          + '(type-only imports are erased and never reach this gate)',
        )
      },
    }, ...cssChannels(pkg.name)],
    outputOptions: {
      entryFileNames: 'client.js',
      // The closure-factory handoff every `dsh.client` package's ./client
      // export must use; mirrors tsdown.client.ts banner/intro/footer.
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
```
