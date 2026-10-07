import { describe, expect, it } from 'vitest'
import { deriveExploreSources } from '../../src/services/explore.js'
import type { NovelSource } from '../../src/services/types.js'

const src = (id: string, kinds: Array<{ title: string; url: string }>, over: Partial<NovelSource> = {}): NovelSource => ({
  id, name: id, baseUrl: 'https://e.com', enabled: true, type: 'text', groups: ['通常书源'],
  raw: {}, rules: { ruleExploreKinds: kinds } as never, status: 'unverified', importedAt: 0, ...over,
})

describe('deriveExploreSources：按源列出分类标题', () => {
  it('只列有分类入口的源，标题按该源声明的原样顺序、不排序不跨源合并', () => {
    const out = deriveExploreSources([
      src('A', [{ title: '玄幻', url: 'a1' }, { title: '都市', url: 'a2' }, { title: '轻小', url: 'a3' }]),
      src('B', [{ title: '玄幻', url: 'b1' }]),
      src('C', []),
    ])
    expect(out).toEqual([
      { id: 'A', name: 'A', groups: ['通常书源'], status: 'unverified', kinds: ['玄幻', '都市', '轻小'] },
      { id: 'B', name: 'B', groups: ['通常书源'], status: 'unverified', kinds: ['玄幻'] },
    ])
  })
  it('顺序是源作者写的顺序，不是热度序（旧版那条按收录源数降序在单源下没有读数可排）', () => {
    expect(deriveExploreSources([src('A', [{ title: '乙', url: 'b' }, { title: '甲', url: 'a' }])])[0].kinds)
      .toEqual(['乙', '甲'])
  })
  it('同源内重复标题只留一次（一个源把同一类声明两遍不构成第二个入口）', () => {
    expect(deriveExploreSources([src('A', [{ title: '玄幻', url: 'a1' }, { title: '玄幻', url: 'a2' }])])[0].kinds)
      .toEqual(['玄幻'])
  })
  it('禁用 / 非文本 / 关掉发现的源不出现（参与判据只有一个主人 exploreParticipates）', () => {
    const kinds = [{ title: '玄幻', url: 'a1' }]
    expect(deriveExploreSources([
      src('off', kinds, { enabled: false }),
      src('comic', kinds, { type: 'image' }),
      src('no-explore', kinds, { raw: { enabledExplore: false } }),
    ])).toEqual([])
  })
})
