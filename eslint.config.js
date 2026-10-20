import tsParser from '@typescript-eslint/parser'
import reactHooks from 'eslint-plugin-react-hooks'

/** 这一层只放 `react-hooks`：它是本仓唯一「人已经在跳过、但没人机器复核」的规则集
 *  （`src/client` 里剩下的 `eslint-disable` 是存量豁免清单——它们仍会屏蔽规则，本 lint 只保证
 *  未豁免的依赖数组）。不引入格式类与风格类规则——那类主张由 tsc 档位与
 *  tests/{comment-altitude,copy-guard,docs-liveness} 三扇门各自管自己的那部分。 */
export default [
  { ignores: ['lib/**', 'node_modules/**', '.qoder/**', 'compat/**', 'docs/**'] },
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
]
