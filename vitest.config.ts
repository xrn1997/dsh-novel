import { configDefaults, defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    // 常规集与 compat 回放集互斥（回放由 vitest.compat.config.ts / pnpm test:compat 驱动）；
    // packaging-build 需要先 pnpm build（由 pnpm test:pack 驱动）
    exclude: [...configDefaults.exclude, 'tests/replay/**', 'tests/packaging-build.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
  },
})
