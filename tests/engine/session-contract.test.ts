import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (p: string): string => readFileSync(p, 'utf8')

describe('SourceSession 契约的 seam', () => {
  it('基础类型不再反向依赖沙箱实现', () => {
    const types = read('src/engine/types.ts')
    expect(types).toContain("from './session.js'")
    expect(types).not.toContain('js-sandbox')
  })
  it('契约 module 零 import，服务半经公共面取类型', () => {
    expect(read('src/engine/session.ts')).not.toMatch(/^import /m)
    expect(read('src/services/fetcher.ts')).toContain("from '../engine/index.js'")
    expect(read('src/services/source-session.ts')).toContain("from '../engine/index.js'")
  })
})
