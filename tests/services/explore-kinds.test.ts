import { describe, expect, it } from 'vitest'
import { kindsOf, sourcesOfKind } from '../../src/services/explore.js'
import type { NovelSource } from '../../src/services/types.js'

// 桩必须带返回类型注解：`type: 'text'` 在无注解的对象字面量里拓宽成 string，
// 而 NovelSource.type 是字面量联合（同 tests/services/participation.test.ts 的桩）。
const src = (id: string, kinds: Array<{ title: string; url: string }>, enabled = true): NovelSource => ({
  id, name: id, baseUrl: 'https://e.com', enabled, type: 'text', groups: [], raw: {},
  rules: { ruleExploreKinds: kinds } as never, status: 'unverified', importedAt: 0,
})

describe('分类词表', () => {
  it('精确同名合并并计数；不同词各自成条', () => {
    const out = kindsOf([
      src('A', [{ title: '玄幻', url: 'xuanhuan' }, { title: '都市', url: 'dushi' }]),
      src('B', [{ title: '玄幻', url: 'xuanhuan' }, { title: '轻小', url: 'qing' }]),
    ])
    expect(out).toEqual([
      { title: '玄幻', sources: 2 }, { title: '都市', sources: 1 }, { title: '轻小', sources: 1 },
    ])
  })

  it('排序按来源数降序，同数保持首次出现序', () => {
    const out = kindsOf([
      src('A', [{ title: '甲', url: 'a' }, { title: '乙', url: 'b' }]),
      src('B', [{ title: '乙', url: 'b' }]),
    ])
    expect(out.map((k) => k.title)).toEqual(['乙', '甲'])
  })

  it('停用源与没有分类的源都进城不参与', () => {
    expect(kindsOf([src('A', [{ title: '玄幻', url: 'x' }], false), src('B', [])])).toEqual([])
  })

  it('sourcesOfKind 给回（源 + 该源上这一类的 url），同名才匹配', () => {
    const out = sourcesOfKind([src('A', [{ title: '玄幻', url: 'xuanhuan' }]), src('B', [{ title: '玄幻 ', url: 'df' }])], '玄幻')
    expect(out.map((x) => [x.source.id, x.kindUrl])).toEqual([['A', 'xuanhuan']])
  })

  // brief 之外补的一条：上一条只钉住匹配规则，没有区分力去杀「sourcesOfKind 里漏掉参与集判据」——
  // 没有分类的源本就被 `find` 挡住，只有停用源能区分（漏判会让停用源也进请求清单）。
  it('sourcesOfKind 与词表同一参与集：停用源不出现在结果里', () => {
    const out = sourcesOfKind([
      src('A', [{ title: '玄幻', url: 'xuanhuan' }], false),
      src('B', [{ title: '玄幻', url: 'xh' }]),
    ], '玄幻')
    expect(out.map((x) => x.source.id)).toEqual(['B'])
  })

  // 计数与清单都按**源**算：角标读的是「N 源」，同源重复声明不是第二个源；取源侧同一个源
  // 也只能产出一次目标（否则同一源会被抓两遍）。故这一条同时钉住两个函数的源内去重。
  it('同源重复声明同一分类：只算一个源、只产出一条目标（首条声明胜）', () => {
    const sources = [
      src('A', [{ title: '玄幻', url: 'a' }, { title: '玄幻', url: 'b' }]),
      src('B', [{ title: '玄幻', url: 'c' }]),
    ]
    expect(kindsOf(sources)).toEqual([{ title: '玄幻', sources: 2 }])
    expect(sourcesOfKind(sources, '玄幻').map((x) => [x.source.id, x.kindUrl])).toEqual([['A', 'a'], ['B', 'c']])
  })
})
