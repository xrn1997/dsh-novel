import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'
export default defineConfig({
  // 宿主平台模块本仓不装（client bundle 留 external）；单测把它指到本地替身，
  // 配置页的接线才能在 vitest 里真跑。替身语义见 tests/client/ui-primitives-stub.tsx。
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(
        new URL('./tests/client/ui-primitives-stub.tsx', import.meta.url),
      ),
    },
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    // 常规集与 compat 回放集互斥（compat 由 vitest.compat.config.ts / pnpm test:compat 驱动）；
    // packaging-build 需要先 pnpm build（由 pnpm test:pack 驱动）
    exclude: [...configDefaults.exclude, 'tests/compat/**', 'tests/packaging-build.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
  },
})
