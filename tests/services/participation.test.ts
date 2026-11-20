import { describe, expect, it } from 'vitest'
import { aiParticipates, exploreParticipates, participates } from '../../src/services/participation.js'
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

  it('AI 搜索面：参搜 ∧ 用户标记（缺键按未标记；界面搜索不受影响）', () => {
    expect(aiParticipates(src())).toBe(false)                    // 导入缺省 false
    expect(aiParticipates(src({ aiSearch: true }))).toBe(true)
    expect(aiParticipates(src({ aiSearch: true, enabled: false }))).toBe(false)
    expect(aiParticipates(src({ aiSearch: true, type: 'audio' }))).toBe(false)
    // AI 标记只收窄工具面：同一源仍是普通聚合搜索的参与者
    expect(participates(src({ aiSearch: false }))).toBe(true)
  })

  it('发现面：再要求声明了分类入口', () => {
    expect(exploreParticipates(src())).toBe(false)
    const withKinds = src({ rules: { ruleExploreKinds: [{ title: '玄幻', url: 'xuanhuan' }] } as never })
    expect(exploreParticipates(withKinds)).toBe(true)
    expect(exploreParticipates(src({ enabled: false, rules: { ruleExploreKinds: [{ title: '玄幻', url: 'x' }] } as never }))).toBe(false)
  })

  it('发现面：显式 enabledExplore: false → 不进城（书源自己关了发现，分类入口仍在库里）', () => {
    const off = src({ raw: { enabledExplore: false }, rules: { ruleExploreKinds: [{ title: '玄幻', url: 'x' }] } as never })
    expect(exploreParticipates(off)).toBe(false)
  })

  it('发现面：显式 enabledExplore: true → 进城', () => {
    const on = src({ raw: { enabledExplore: true }, rules: { ruleExploreKinds: [{ title: '玄幻', url: 'x' }] } as never })
    expect(exploreParticipates(on)).toBe(true)
  })

  // 原生方言的 raw 根本不产这个键：「没写」不等于「把发现关掉」——读错的代价是整批原生源从书城消失
  it('发现面：raw 里没有 enabledExplore 这个键 → 进城（缺省是开）', () => {
    const native = src({ rules: { ruleExploreKinds: [{ title: '玄幻', url: 'x' }] } as never })
    expect(exploreParticipates(native)).toBe(true)
  })
})
