import { beforeEach, describe, expect, it } from 'vitest'
import { inboxCards, inboxIds, signatureOf, signaturesOf, sourceInbox, visibleInboxCards } from '../../src/client/source-inbox.js'
import { inboxUi, muteInboxCard, pruneInboxMuted, resetSourceInboxUi } from '../../src/client/source-inbox-ui.js'
import type { SourcePublic } from '../../src/client/views/types.js'

const src = (over: Partial<SourcePublic> & { id: string }): SourcePublic => ({
  name: over.id, baseUrl: `https://${over.id}.com`, enabled: true, groups: [],
  type: 'text', status: 'verified', importedAt: 0, hasHeader: false, hasAuth: false, authExpired: false,
  ...over,
})

describe('sourceInbox（书源待办派生）', () => {
  it('broken/unverified 按状态分集合；健康源不进待办，停用源只看 status 照旧归队', () => {
    const sources = [
      src({ id: 'ok1', status: 'verified' }),
      src({ id: 'b1', status: 'broken' }),
      src({ id: 'u1', status: 'unverified' }),
      // 停用只摘掉「参与聚合搜索」，不改状态归属（2026-09 裁定：停用 ≠ 免验）——
      // 停用的坏源仍进坏源集合、停用的未验证仍进未验证集合（一键验证覆盖得到它）
      src({ id: 'off-ok', status: 'verified', enabled: false }),
      src({ id: 'off-broken', status: 'broken', enabled: false }),
      src({ id: 'off-unverified', status: 'unverified', enabled: false }),
    ]
    const inbox = sourceInbox(sources)
    expect(inbox.broken.map((s) => s.id)).toEqual(['b1', 'off-broken'])
    expect(inbox.unverified.map((s) => s.id)).toEqual(['u1', 'off-unverified'])
  })

  it('空库/全健康 → 两个集合都空（零待办 = 待办区不渲染，读数归列表头状态带）', () => {
    expect(sourceInbox([])).toEqual({ broken: [], unverified: [] })
    expect(sourceInbox([src({ id: 'a' }), src({ id: 'b', enabled: false })])).toEqual({ broken: [], unverified: [] })
  })

  it('inboxIds：处置动作的作用对象 id 集（点击时快照语义的取数口）', () => {
    const inbox = sourceInbox([src({ id: 'b1', status: 'broken' }), src({ id: 'u1', status: 'unverified' })])
    expect(inboxIds(inbox, 'broken')).toEqual(['b1'])
    expect(inboxIds(inbox, 'unverified')).toEqual(['u1'])
  })
})

/** 待办卡的「忽略」语义（2026-09 用户裁定）：待办是**提示**，不是工单分派——关掉一张卡 =
 *  这批成员我不再需要被提醒，但成员集一变（新坏源 / 新导入未验证）提示就该回来。
 *  故静音记录按**成员签名**（排序后的 id 串）记账，不认人也不认脸。 */
describe('inboxCards / visibleInboxCards：卡 = 成员非空的一种待办 + 成员签名', () => {
  const inbox = sourceInbox([
    src({ id: 'b1', status: 'broken' }), src({ id: 'b2', status: 'broken' }),
    src({ id: 'u1', status: 'unverified' }), src({ id: 'ok', status: 'verified' }),
  ])

  it('成员为空的 kind 不出卡；卡的 signature 与源序无关（勾选顺序/服务端回包序不该影响记账）', () => {
    const cards = inboxCards(inbox)
    expect(cards.map((c) => c.kind)).toEqual(['broken', 'unverified'])
    expect(cards[0].signature).toEqual(signatureOf(['b2', 'b1']))
    expect(inboxCards(sourceInbox([src({ id: 'u1', status: 'unverified' })]))
      .map((c) => c.kind)).toEqual(['unverified'])
  })

  it('静音命中签名的卡进 hidden；同 kind 之外的卡不受影响', () => {
    const cards = inboxCards(inbox)
    const muted = { broken: cards[0].signature }
    const { shown, hidden } = visibleInboxCards(cards, muted)
    expect(hidden.map((c) => c.kind)).toEqual(['broken'])
    expect(shown.map((c) => c.kind)).toEqual(['unverified'])
  })

  it('成员集一变即自动复现：多一个坏源 / 少一个坏源都不再命中旧签名', () => {
    const sig = inboxCards(inbox)[0].signature
    const later = sourceInbox([
      src({ id: 'b1', status: 'broken' }), src({ id: 'b2', status: 'broken' }),
      src({ id: 'b3', status: 'broken' }), src({ id: 'u1', status: 'unverified' }),
    ])
    expect(visibleInboxCards(inboxCards(later), { broken: sig }).hidden).toEqual([])
    const fewer = sourceInbox([src({ id: 'b1', status: 'broken' }), src({ id: 'u1', status: 'unverified' })])
    expect(visibleInboxCards(inboxCards(fewer), { broken: sig }).hidden).toEqual([])
  })

  it('空集合的 signature 是空串（不是 undefined）——prune 要能区分「这一类现在没人」', () => {
    expect(signatureOf([])).toBe('')
    expect(signaturesOf(sourceInbox([]))).toEqual({ broken: '', unverified: '' })
  })
})

describe('pruneInboxMuted：静音记录只在其仍能遮住当前卡时存活（幽灵记录钉子）', () => {
  beforeEach(resetSourceInboxUi)

  it('成员集变空后记录作废——删光再导入同一批 id 时提示会回来，不继承「已看过」', () => {
    const one = sourceInbox([src({ id: 'b1', status: 'broken' })])
    muteInboxCard('broken', inboxCards(one)[0].signature)
    expect(inboxUi.get().muted).toEqual({ broken: signatureOf(['b1']) })

    pruneInboxMuted(sourceInbox([]))                       // 源被删光：这一类现在没有成员
    expect(inboxUi.get().muted).toEqual({})                // 遮不住任何东西的记录 = 幽灵，清掉

    const again = inboxCards(sourceInbox([src({ id: 'b1', status: 'broken' })]))
    expect(visibleInboxCards(again, inboxUi.get().muted).hidden).toEqual([])   // 重新导入 → 提示回来
  })

  it('集合没变时 prune 不动记录（每次取数都会跑，不能把有效静音擦掉）', () => {
    const inbox = sourceInbox([src({ id: 'b1', status: 'broken' }), src({ id: 'u1', status: 'unverified' })])
    muteInboxCard('broken', inboxCards(inbox)[0].signature)
    pruneInboxMuted(sourceInbox([src({ id: 'u1', status: 'unverified' }), src({ id: 'b1', status: 'broken' })]))
    expect(inboxUi.get().muted).toEqual({ broken: signatureOf(['b1']) })
  })
})
