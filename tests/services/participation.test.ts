import { describe, expect, it } from 'vitest'
import { exploreParticipates, participates } from '../../src/services/participation.js'
import type { NovelSource } from '../../src/services/types.js'

const src = (over: Partial<NovelSource> = {}): NovelSource => ({
  id: 's1', name: 'S', baseUrl: 'https://e.com', enabled: true, type: 'text',
  groups: [], raw: {}, rules: { ruleExploreKinds: [] } as never, status: 'unverified', importedAt: 0,
  ...over,
})

describe('参与集谓词', () => {
  it('搜索面：启用 ∧ 文本源', () => {
    expect(participates(src())).toBe(true)
    expect(participates(src({ enabled: false }))).toBe(false)
    expect(participates(src({ type: 'audio' }))).toBe(false)
  })

  it('发现面：再要求声明了分类入口', () => {
    expect(exploreParticipates(src())).toBe(false)
    const withKinds = src({ rules: { ruleExploreKinds: [{ title: '玄幻', url: 'xuanhuan' }] } as never })
    expect(exploreParticipates(withKinds)).toBe(true)
    expect(exploreParticipates(src({ enabled: false, rules: { ruleExploreKinds: [{ title: '玄幻', url: 'x' }] } as never }))).toBe(false)
  })
})
