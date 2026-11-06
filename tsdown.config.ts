import { builtinModules } from 'node:module'
import { defineConfig } from 'tsdown'

/** 平台模块表（镜像宿主 web shell 的 `staticModules()`：它把这些 specifier 种进冻结浏览器模块表，
 *  client bundle 一律留给注入的 require，不得 inline）。
 *  **收录判据是「我们声明兼容的每一代宿主都答得上」（交集）**，且**只收产物真的 require 到的**：
 *  - `react` / `react/jsx-runtime`：视图与 JSX 运行时，跨代都在。
 *  - **宿主 client 包一条都不收**：配置页的值与写协议走 `ctx.remote.settings`（编目契约
 *    `settingsController` 的 `describe` / `mutate`），页面/面板零宿主包 import（页面校验清单，
 *    `ADR-0067`）。原语只当它是「服务之上的表单模型」，本页自己持有草稿与保存态。
 *  - 也不收 `react-dom` / `react-dom/client` / `@deepseek-ai/cordis` / `@deepseek-ai/dsh-client-store`
 *    / `@deepseek-ai/dsh-client-ui-slots` / `@deepseek-ai/dsh-client-ui-primitives`：产物一条都没
 *    require（store 自持见 `ADR-0055`；cordis 全为 type-only import，编译期已擦除）。
 *  这个方向错了，纯度门就从守卫变成共犯：它证明的从来不是「宿主表长这样」，而是「我们只 require 这些」。 */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime',
]
const isRequested = (s: string): boolean => PLATFORM_MODULES.includes(s)
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((id) => `node:${id}`)])
const NODE_ENV = process.env.NODE_ENV ?? 'production'

export default defineConfig([
  {
    // host 半：ESM node，peerDeps 留 import（真实安装里在盘上），npm 依赖 inline；声明不在这里出（见下面 dts）
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    // 声明由 `tsc -p tsconfig.build.json` 出到 `lib/types/`：tsdown 的 dts 会加载
    // rolldown-plugin-dts → yuku 原生模块，构建期不需要它，也不该被 AV 盯上。
    dts: false,
    clean: true,
    deps: {
      // 归属已由 neverBundle/alwaysBundle 全量表定，onlyBundle 关闭其白名单过滤并消掉构建期 hint
      onlyBundle: false,
      neverBundle: (s) => s.startsWith('@deepseek-ai/') || s === 'playwright-core',
      alwaysBundle: (s) => !s.startsWith('@deepseek-ai/') && s !== 'playwright-core',
    },
  },
  {
    // client 半：CJS 单文件闭合工厂（三段式 banner/intro/footer——宿主 ./client 导出契约）
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    // target 必须显式写否则认错运行时：这份产物由宿主在浏览器侧加载，不是 Node 包。省掉它
    // tsdown 会拿 package.json 的 engines.node 推出 Node 运行时，于是按「给现代 Node 发 CJS」
    // 的判据套上来，打一条「建议改用 ESM」的假阳性 WARN——CJS 恰恰是 ./client
    // 闭合工厂契约的要求，不该按 Node 库计。
    target: 'baseline-widely-available',
    // 这份产物是**发给浏览器**的：注释、缩进与长标识符全是要用户下载与解析的字节。
    // 保留 sourcemap 作为可调试性补偿（宿主按 `//# sourceMappingURL` 取图谱），
    // 所以「压缩了但还能查」两头都在。构建期纯度门与 banner/footer 不受影响；
    // 产物自检（`tests/packaging-build.test.ts`）按**行为**钉注册壳与 require 集合，
    // 不按压缩后的文本形状——否则一开压缩，静态扫文本的门就自己睡着了。
    minify: true,
    dts: false,                 // dts 会把 banner/footer 包进 .d.cts 弄坏解析
    sourcemap: true,
    clean: false,               // host 已 clean；两个配置同写 lib/
    deps: {
      onlyBundle: false,                      // 归属已由下面两个谓词全量表定；关闭白名单过滤，消掉构建期 hint
      neverBundle: isRequested,               // 模块表能答的 require 留 import
      alwaysBundle: (s) => !isRequested(s),   // 其余全 inline（npm 依赖）
    },
    define: {
      // 四键缺一，inline 的 node 习惯依赖在浏览器 boot 抛 ReferenceError
      'process.env': '{}',
      'process.env.NODE_ENV': JSON.stringify(NODE_ENV),
      'import.meta.env.MODE': JSON.stringify(NODE_ENV),
      'import.meta.env': JSON.stringify({ MODE: NODE_ENV }),
      // browser CJS 无模块加载器——杜绝 stray 引用解析到 Node loader
      'import.meta.resolve': 'undefined',
    },
    // CJS 输出会让部分传递依赖解析到它们的 Node 入口——浏览器条件导出必须权威
    inputOptions: {
      resolve: { conditionNames: ['browser', 'import', 'require', 'default'] },
    },
    // （noExternal 双保险不需要——deps.alwaysBundle 已是全量 inline 语义，noExternal 与之互斥，
    //   两者同时给会让构建直接报错）
    plugins: [{
      // 构建期纯度门：@deepseek-ai/* 值 import 不在平台表 → 构建失败
      //（type-only import 已被擦除，到不了这道门）；Node builtin 闯进浏览器 bundle 同理必炸
      name: 'dsh-novel-bundle-purity',
      resolveId(source: string) {
        if (NODE_BUILTINS.has(source)) {
          throw new Error(`client bundle purity: Node 内建 "${source}" 不能进浏览器模块表——选依赖的 browser 导出或提供浏览器实现`)
        }
        if (!source.startsWith('@deepseek-ai/')) return null
        if (isRequested(source)) return null
        throw new Error(
          `client bundle purity: "${source}" 不在平台模块表——跨插件值 import 被禁；跨插件协作走 cordis 服务（type-only import 不受此门限制）`,
        )
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      // dsh.client 包 ./client 导出必须用的闭合工厂（官方三段式）
      // id 必须等于 package.json 的 name（scoped 包同款：@anionex/dsh-vision-toolkit 的 banner 即全名）
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify('@xrn1997/dsh-novel')}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
