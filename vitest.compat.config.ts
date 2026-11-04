import { defineConfig } from 'vitest/config'

// compat 回放集（与常规集互斥：vitest.config.ts 已 exclude tests/replay/**）
// capture.test.ts 自带 COMPAT_CAPTURE 门控，默认 skip，故无需排除。
export default defineConfig({
  test: {
    include: ['tests/replay/**/*.test.{ts,tsx}'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
  },
})
