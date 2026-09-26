import { describe, expect, it } from 'vitest'
import { coverTintClass, sourceTintClass } from '../../src/client/util.js'
import { filterShelfBooks, localImportLabel, localImportNote, shelfCardMeta, shelfSourceTag } from '../../src/client/shelf-view-model.js'
import type { LocalImportResponse, ShelfBook, ShelfEntry } from '../../src/client/views/types.js'

/** 书架 view-model 钉子：筛选口径（reading/unread/local 正交）+ 卡片元信息/百分比唯一算式
 *  + 首字色块档位派生 + 来源投影（chip 文案与色点档位）。客户端逻辑层测试口径：
 *  纯函数、零 React（client.md 模块地图）。 */

const book = (over: Partial<ShelfBook>): ShelfBook => ({
  bookKey: 'k', sourceId: 's', title: '书', addedAt: 1,
  progress: { chapterIndex: 0, offsetRatio: 0, updatedAt: 1 },
  ...over,
} as ShelfBook)

/** 读取面条目：书架条目 + 服务端 join 出来的源名投影 */
const entry = (over: Partial<ShelfEntry>): ShelfEntry =>
  ({ ...book({}), sourceName: null, ...over } as ShelfEntry)

describe('filterShelfBooks（筛选口径）', () => {
  const list = [
    book({ bookKey: 'a', progress: { chapterIndex: 5, offsetRatio: 0.2, updatedAt: 1 } }),
    book({ bookKey: 'b' }),
    book({ bookKey: 'c', sourceId: '__local__', progress: { chapterIndex: 2, offsetRatio: 0, updatedAt: 1 } }),
  ]
  it('all 不过滤', () => expect(filterShelfBooks(list, 'all')).toEqual(list))
  it('reading = 有实质进度（含本地书）', () => expect(filterShelfBooks(list, 'reading').map((b) => b.bookKey)).toEqual(['a', 'c']))
  it('unread = 进度全零', () => expect(filterShelfBooks(list, 'unread').map((b) => b.bookKey)).toEqual(['b']))
  it('local = LOCAL_SOURCE_ID（正交维度）', () => expect(filterShelfBooks(list, 'local').map((b) => b.bookKey)).toEqual(['c']))
  it('不过滤时不共享底层数组（防调用方误改原书架态）', () => {
    const out = filterShelfBooks(list, 'all')
    out.pop()
    expect(list).toHaveLength(3)
  })
})

describe('shelfCardMeta（卡片元信息与百分比唯一算式）', () => {
  it('在读有总数 → 章数/百分比（chapterIndex 0 基、展示 1 基）', () => {
    expect(shelfCardMeta(book({ progress: { chapterIndex: 720, offsetRatio: 0, updatedAt: 1 }, totalChapters: 1162 })))
      .toEqual({ text: '721/1162 章 · 62%', pct: 62 })
  })
  it('未读 → 未开始 + 总章数；pct null（简约版口径：未读不出进度条）', () => {
    expect(shelfCardMeta(book({ totalChapters: 1280 }))).toEqual({ text: '未开始 · 1280 章', pct: null })
  })
  it('未读且缺总数 → 未开始', () => {
    expect(shelfCardMeta(book({}))).toEqual({ text: '未开始', pct: null })
  })
  /** 本地书不再点名格式：本地书现在有 TXT 与 EPUB 两种（格式不落书架条目——它是「可 patch 的书目字段」
   *  的反面，见 docs/design/client.md 的本地书导入节），卡片刻意只说「本地」；
   *  真实格式由导入回执与阅读器的导入说明显示（那里有从服务端拿到的 format 字段）。 */
  it('本地 → 「本地」不点名格式（格式不在书架条目上）', () => {
    expect(shelfCardMeta(book({ sourceId: '__local__', progress: { chapterIndex: 20, offsetRatio: 0.5, updatedAt: 1 }, totalChapters: 700 })))
      .toEqual({ text: '本地 · 3%', pct: 3 })
  })
  it('本地未读（缺总数）→ 「本地」，仍不出进度条', () => {
    expect(shelfCardMeta(book({ sourceId: '__local__' }))).toEqual({ text: '本地', pct: null })
  })
  it('缺 totalChapters → pct null，文案退章节文字', () => {
    expect(shelfCardMeta(book({ progress: { chapterIndex: 3, offsetRatio: 0, updatedAt: 1 } })))
      .toEqual({ text: '读至第 4 章', pct: null })
  })
  it('比例 clamp 到 100（存档越界不显示 120%）', () => {
    expect(shelfCardMeta(book({ progress: { chapterIndex: 990, offsetRatio: 0.9, updatedAt: 1 }, totalChapters: 900 })).pct).toBe(100)
  })
})

/** 导入回执文案（书架那块「有持久告警时才出现」的回执）：格式标签与「有几条导入说明」的唯一算式。
 *  格式只认**服务端回执的 format 字段**（它来自那次导入落盘的本地元数据），不按书名 / 后缀猜——
 *  按书名猜格式与「卡片写死本地 TXT」是同一族的造假。 */
describe('导入回执文案（localImportLabel / localImportNote）', () => {
  const receipt = (over: Partial<LocalImportResponse>): LocalImportResponse => ({
    bookKey: 'local:u1', sourceId: '__local__', title: '斗罗', addedAt: 1,
    progress: { chapterIndex: 0, offsetRatio: 0, updatedAt: 1 },
    chapterCount: 3, format: 'epub', encoding: null, warnings: [],
    ...over,
  })
  it('格式 + 章数取自服务端回执（epub / txt 两支；书名不参与）', () => {
    expect(localImportLabel(receipt({ format: 'epub', chapterCount: 3, title: '这本.txt' }))).toBe('EPUB · 3 章')
    expect(localImportLabel(receipt({ format: 'txt', chapterCount: 42 }))).toBe('TXT · 42 章')
  })
  it('无告警 → 补白为空串；有告警 → 点名条数', () => {
    expect(localImportNote(receipt({}))).toBe('')
    expect(localImportNote(receipt({
      warnings: [
        { code: 'epub-removed-inline-svg', resource: 'OEBPS/ch1.xhtml', message: 'x' },
        { code: 'epub-degraded-anchor', resource: null, message: 'y' },
      ],
    }))).toBe('，有 2 条导入说明')
  })
})

describe('coverTintClass（首字色块四档派生）', () => {
  it('空标题回 t1（与 coverFallbackChar「书」同防）', () => expect(coverTintClass('')).toBe('novel-cover-t1'))
  it('只认首字符档位、恒定可复现', () => {
    expect(coverTintClass('诡秘之主')).toBe(coverTintClass('诡秘之主'))
  })
  it('不同书可落不同档（四档真的被用起来）', () => {
    const set = new Set(['诡秘之主', '剑来', '赤心巡天', '道诡异仙', '深海余烬'].map(coverTintClass))
    expect(set.size).toBeGreaterThan(1)
  })
})

describe('shelfSourceTag（来源 chip 展示口径）', () => {
  it('在线书：源名直出、非「已删」态', () => {
    expect(shelfSourceTag(entry({ sourceId: 's1', sourceName: '笔趣阁' })))
      .toEqual({ text: '笔趣阁', deleted: false })
  })
  it('源已被删（服务端 join 不到）→ 灰字「来源已删除」', () => {
    expect(shelfSourceTag(entry({ sourceId: 'gone', sourceName: null })))
      .toEqual({ text: '来源已删除', deleted: true })
  })
  it('本地书 → null（本地身份由封面「本地」与角标承担，不重复出 chip）', () => {
    expect(shelfSourceTag(entry({ sourceId: '__local__', sourceName: null }))).toBeNull()
  })
})

describe('sourceTintClass（来源色点四档派生）', () => {
  it('空 id 回 t1（与 coverTintClass 同防）', () => expect(sourceTintClass('')).toBe('novel-src-t1'))
  it('同源恒同档、可复现', () => {
    expect(sourceTintClass('s1')).toBe(sourceTintClass('s1'))
    expect(sourceTintClass('https://a.com')).toBe(sourceTintClass('https://a.com'))
  })
  it('不同源可落不同档（四档真的被用起来）', () => {
    const set = new Set(['s1', 's2', 's3', 's4', 's5', 's6'].map(sourceTintClass))
    expect(set.size).toBeGreaterThan(1)
  })
})
