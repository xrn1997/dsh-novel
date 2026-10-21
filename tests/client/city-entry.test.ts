import { describe, expect, it } from 'vitest'
import { decideCityEntry, rememberedSelection } from '../../src/client/city-entry.js'
import type { CityEntryInput } from '../../src/client/city-entry.js'
import type { ExploreSources } from '../../src/shared/wire.js'

/** 书城进入判据的钉子：一张动作表说完「源清单 / 记住的源与分类 / 恢复读是否已定 / 自动那条路是否
 *  已经走过 / 服务端此刻那一轮」到唯一动作的映射。纯函数、零 React、零 DOM——不再靠卡 promise +
 *  sleep 问竞态（那条竞态的接线面仍由 `city-view.test.tsx` 守）。
 *
 *  手点路径刻意不在判据里：`CityView` 的 `pick` 不等恢复读、恒提交（切源/切类必须马上有反应）。
 *  这条语义的钉子住在 `city-view.test.tsx` 的「手点当前这一类也照旧提交」——判据只回答自动那条路
 *  该不该动，把「手点恒 submit」折进来会让判据多一枚没人传的入参。 */

type Source = ExploreSources['sources'][number]

const source = (over: Partial<Source> & Pick<Source, 'id'>): Source =>
  ({ name: over.id, groups: [], status: 'unverified', kinds: [], ...over })

/** 可选源清单的现物形状：s1 声明两类、s2 只声明一类 */
const list: ExploreSources['sources'] = [
  source({ id: 's1', name: '半夏小说', groups: ['通常书源'], kinds: ['现代情感', '穿越重生'] }),
  source({ id: 's2', name: '多看阅读', groups: ['快速书源'], status: 'verified', kinds: ['玄幻'] }),
]

const noneRemembered = { sourceId: null, kind: null }

describe('rememberedSelection（记住的源/分类回落）', () => {
  it('源清单未到或为空：没有可落的选择', () => {
    expect(rememberedSelection(null, { sourceId: 's1', kind: '现代情感' })).toBeNull()
    expect(rememberedSelection([], { sourceId: 's1', kind: '现代情感' })).toBeNull()
  })

  it('没记住过：落第一项源的第一个分类', () => {
    expect(rememberedSelection(list, noneRemembered)).toEqual({ sourceId: 's1', kind: '现代情感' })
  })

  it('记住的源与分类都还在场：原样沿用', () => {
    expect(rememberedSelection(list, { sourceId: 's2', kind: '玄幻' })).toEqual({ sourceId: 's2', kind: '玄幻' })
    expect(rememberedSelection(list, { sourceId: 's1', kind: '穿越重生' })).toEqual({ sourceId: 's1', kind: '穿越重生' })
  })

  it('记住的源失效：回落第一项；记住的分类若第一项也声明了就沿用，否则落它的第一个分类', () => {
    // 记住的分类不在回落源（s1）的声明里 → 落 s1 的第一个分类
    expect(rememberedSelection(list, { sourceId: 'gone', kind: '玄幻' }))
      .toEqual({ sourceId: 's1', kind: '现代情感' })
    // 回落后仍按「这个源声明的分类」判一次：记住的分类恰好也在第一项的声明里就沿用
    expect(rememberedSelection(list, { sourceId: 'gone', kind: '穿越重生' }))
      .toEqual({ sourceId: 's1', kind: '穿越重生' })
    const echoing = [source({ id: 's0', kinds: ['玄幻', '都市'] }), ...list]
    expect(rememberedSelection(echoing, { sourceId: 'gone', kind: '玄幻' }))
      .toEqual({ sourceId: 's0', kind: '玄幻' })
  })

  it('记住的分类不在该源声明里：落这个源的第一个分类（不跨源借分类）', () => {
    expect(rememberedSelection(list, { sourceId: 's2', kind: '现代情感' }))
      .toEqual({ sourceId: 's2', kind: '玄幻' })
  })

  it('被选中的源声明零分类：返回 null——没有可逛的分类，不拿别的源的分类冒充它', () => {
    const noKinds = [source({ id: 's1', kinds: [] }), source({ id: 's2', kinds: ['玄幻'] })]
    expect(rememberedSelection(noKinds, noneRemembered)).toBeNull()
    // 记住的源失效、回落到第一项——第一项零分类同样是 null，不跳过它去借 s2 的分类
    expect(rememberedSelection(noKinds, { sourceId: 'gone', kind: '玄幻' })).toBeNull()
  })
})

/** 判据输入的缺省桩：源清单到手、恢复读已定、自动那条路还没走过、服务端手里没有轮次 */
const entry = (over: Partial<CityEntryInput> = {}): CityEntryInput => ({
  sources: list,
  remembered: noneRemembered,
  restored: true,
  asked: false,
  round: null,
  ...over,
})

const submit = (sourceId: string, kind: string) =>
  ({ type: 'select', sourceId, kind, action: 'submit' })

describe('decideCityEntry（自动那条路的一步决策）', () => {
  it('源清单未到 → wait：此刻说「没有」是编的，别的闸都拦不住这条', () => {
    expect(decideCityEntry(entry({ sources: null }))).toEqual({ type: 'wait' })
    expect(decideCityEntry(entry({ sources: null, restored: false, asked: true })))
      .toEqual({ type: 'wait' })
  })

  it('空清单 → none：库里没有源提供分类浏览，不提交任何一轮', () => {
    expect(decideCityEntry(entry({ sources: [] }))).toEqual({ type: 'none' })
  })

  it('被选中的源声明零分类 → none：没有可逛的分类', () => {
    expect(decideCityEntry(entry({ sources: [source({ id: 's1' })] }))).toEqual({ type: 'none' })
  })

  it('挂载恢复读未定 → none：那时 round 恒为 null 是「还没问过」，抢跑会杀掉服务端那一轮', () => {
    expect(decideCityEntry(entry({ restored: false }))).toEqual({ type: 'none' })
  })

  it('已经由任一入口起过一轮（asked）→ none：手点不会追加自动提交，当前轮匹配与否都不动', () => {
    expect(decideCityEntry(entry({ asked: true }))).toEqual({ type: 'none' })
    expect(decideCityEntry(entry({ asked: true, round: { sourceId: 's1', kind: '现代情感' } })))
      .toEqual({ type: 'none' })
  })

  it('服务端此刻没有轮次 → submit（选中的源+类就是这一轮要起的东西）', () => {
    expect(decideCityEntry(entry())).toEqual(submit('s1', '现代情感'))
  })

  it('当前轮是另一个源或另一个类 → submit：不是这一对就等于没有', () => {
    expect(decideCityEntry(entry({ round: { sourceId: 's2', kind: '玄幻' } })))
      .toEqual(submit('s1', '现代情感'))
    expect(decideCityEntry(entry({ round: { sourceId: 's1', kind: '穿越重生' } })))
      .toEqual(submit('s1', '现代情感'))
  })

  it('当前轮正是选中的源+类 → follow：回来看它跑完，重提会杀掉它', () => {
    expect(decideCityEntry(entry({ round: { sourceId: 's1', kind: '现代情感' } })))
      .toEqual({ type: 'select', sourceId: 's1', kind: '现代情感', action: 'follow' })
  })

  it('回落后再比对当前轮：定格在回落后那一对上，不按失效的源去提交', () => {
    expect(decideCityEntry(entry({
      remembered: { sourceId: 'gone', kind: '玄幻' },
      round: { sourceId: 's1', kind: '现代情感' },
    }))).toEqual({ type: 'select', sourceId: 's1', kind: '现代情感', action: 'follow' })
  })
})
