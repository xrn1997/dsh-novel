import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

/**
 * `globals` 包用布尔值编码只读 / 可写（`false` = 只读）；flat config 只认字符串档位，
 * 布尔 `false` 会被当成 `off`（于是 `no-undef` 把 Node 全局全报成未定义）。这里统一翻译。
 */
const flatGlobals = (set) => Object.fromEntries(
  Object.entries(set).map(([name, access]) => [
    name,
    access === true || access === 'writable' ? 'writable' : 'readonly',
  ]),
)

/**
 * 本仓的机器门。
 *
 * 分工：`tsc` 管类型形状与可赋值性（`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、
 * `erasableSyntaxOnly` 都已进 tsconfig），ESLint 管 tsc 看不见的那一类——显式 `any`、
 * 从边界渗进来的 `any`、悬浮 Promise、非空断言。所以用**类型感知**规则集：`no-unsafe-*`
 * 拿不到类型信息就没有意义。
 *
 * 上一版这里只有 `react-hooks`，注释主张「其余主张由 tsc 档位与三扇门各管自己那部分」。
 * 那个理由对格式与风格成立，对 `any` **不成立**——`tsc` 从不拒绝显式 `any`，于是它一路
 * 长到了测试面的 300 多处。这条归属错配是本次升级的直接原因。
 *
 * 不写格式类规则：格式主张归格式化工具（仓内暂无），ESLint 代替它立规只会和既有排版打架。
 * `no-confusing-void-expression` 一并关掉——它只改写法、不挡缺陷类（逐处改法就是给箭头简写
 * 加大括号，改完可观察行为不变）。
 */
export default tseslint.config(
  { ignores: ['lib/**', 'node_modules/**', '.qoder/**', '.task-scratch/**', '.superpowers/**', 'docs/**'] },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,

  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',

      // 点名写出这两条：已由 strictTypeChecked 隐含打开，写出来是为了让「本仓的门」
      // 在配置里现查得到，而不是靠读者记住某个预设集包含哪些规则。
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',

      // 数字插值是本仓既有写法：错误信息里带偏移、段号、字节数、页码。strict 档默认关掉它，
      // 代价是把这些正当读数改成 String(x) 噪音。
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],

      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-meaningless-void-operator': 'off',
    },
  },

  {
    // 一次性脚本与配置入口不进产物、不承载运行时不变量；开着类型感知只会让 lint 自己的
    // 配置文件把整条命令跑崩（它不在 tsconfig 内）。必须排在最后：flat config 后者覆盖前者。
    // `scripts/**` 是 Node 脚本（`node:http` / `fetch` / `process`），globals 按 Node 声明——
    // 不声明时 js recommended 的 `no-undef` 会把每个宿主全局都当成拼错的变量。
    // 预设自带的 `languageOptions`（关类型感知用的 parserOptions）要显式并进来：它整块替换，
    // 不是深合并。
    ...tseslint.configs.disableTypeChecked,
    files: ['**/*.js', '**/*.mjs', 'tsdown.config.ts', 'vitest.config.ts', 'vitest.*.config.ts'],
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: flatGlobals(globals.node),
    },
  },

  {
    // 测试替身里 `vi.fn(async (…) => fixture)` 的 `async` 就是为了回一个 Promise，
    // 体内没有 await 是正确形态。生产代码保持这条规则在线。
    files: ['tests/**/*.{ts,tsx}'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
)
