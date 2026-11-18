// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Browser } from 'playwright'
import { LOCAL_SOURCE_ID } from '../../src/shared/wire.js'
import type { ShelfEntry } from '../../src/shared/wire.js'
import { NovelStyles } from '../../src/client/styles.js'
import { ShelfView } from '../../src/client/views/ShelfView.js'
import { panelShelf } from '../../src/client/panel-shelf.js'
import { ttsPlayer } from '../../src/client/tts/player.js'
import { makeCoreDeps } from '../client/fake-deps.js'
import { BROWSER_GATE_ENABLED } from '../support/browser-gate.js'
import { launchBrowser } from './epub-host.js'

/**
 * 书架「正在听」徽标的几何门（`DSH_BROWSER_GATE=1` 打开，旧名 `DSH_EPUB_BROWSER` 仍认；默认整门跳过，`pnpm test` 不跑它）。
 *
 * 用户报的形状：徽标原本并排在卡片标题行里，把书名行吃掉一截 →「书名显示不全了」。对照探针钉住机制：
 * 徽标出流后书名行可用宽度**逐像素回到**无徽标时的读数，而 gap 归零只回几个像素、徽标缩字回得多但字
 * 不能读——省下的宽度等于徽标自己的宽度，是结构问题，不是字号问题。挪到封面底行后又量出第二条账：
 * 底行与来源 chip 抢同一排，长源名被挤到只剩两三个字。于是徽标落**顶左**：顶左只有多选态的勾选标记
 * 会来抢（徽标让位），底左那条槽位由来源 chip 与「本地」互斥共享，两边都吃满整宽。
 * jsdom 量不到排版（省略号吃掉多少、两角标叠没叠），故读数取真浏览器的 rect / scrollWidth。
 *
 * 组件与样式都是**现物**：markup 由 `renderToStaticMarkup(ShelfView)` 出（书架经 `panelShelf` 投影喂数据、
 * 播放态经 `ttsPlayer` 喂），CSS 是发布用的那一份。不起服务、不读站点、不手抄类名结构。
 *
 * 判据口径：徽标是**状态字**，两行文字都不该拿它换——书名行与来源 chip 的可用宽度都不因徽标而变小；
 * 同时徽标自己仍完整可见、待在卡内、不与任何角标或文字行叠。
 */

const ENABLED = BROWSER_GATE_ENABLED

/** 一行放得下、徽标一挂进流就放不下的真实形状书名（7 字） */
const LONG_TITLE = '全球高考倒计时'

/** 长到一排放不下的源名：徽标挪到顶左后，它不该再被徽标挤 */
const LONG_SOURCE = '某某书源·聚合搜索测试源ABCDEFGHIJKLMNOPQRSTUVWXYZ'

interface Box { width: number; height: number; left: number; right: number; top: number; bottom: number }

/** 角标 / 文字行一类：除几何外还带自己的省略号读数（超长时必须省略，不是溢出） */
interface Overlay extends Box { client: number; scroll: number; text: string }

interface Row {
  text: string
  title: Box
  /** 书名盒能摆下多少像素 / 排完需要多少像素：差值就是省略号吃掉的那一截 */
  titleClient: number
  titleScroll: number
  badge: Overlay | null
  cell: Box
  cellClient: number
  cellScroll: number
  cover: Box | null
  meta: Box | null
  srcTag: Overlay | null
  localTag: Overlay | null
}

const probe = `(() => {
  const rect = (el) => { const b = el.getBoundingClientRect()
    return { width: b.width, height: b.height, left: b.left, right: b.right, top: b.top, bottom: b.bottom } }
  const box = (root, sel) => { const el = root.querySelector(sel)
    return el === null ? null : { ...rect(el), client: el.clientWidth, scroll: el.scrollWidth, text: el.textContent } }
  return JSON.stringify({
    rows: [...document.querySelectorAll('.novel-cell')].map((cell) => {
      const title = cell.querySelector('.novel-card-title')
      return {
        text: title === null ? '' : title.textContent,
        title: rect(title),
        titleClient: title.clientWidth,
        titleScroll: title.scrollWidth,
        badge: box(cell, '.novel-card-now'),
        cell: rect(cell),
        cellClient: cell.clientWidth,
        cellScroll: cell.scrollWidth,
        cover: box(cell, '.novel-cover-box'),
        meta: box(cell, '.novel-card-meta'),
        srcTag: box(cell, '.novel-src-tag'),
        localTag: box(cell, '.novel-local-tag'),
      }
    }),
  })
})()`

type Kind = 'online' | 'local'

function entry(title: string, kind: Kind): ShelfEntry {
  return {
    sourceId: kind === 'local' ? LOCAL_SOURCE_ID : 's1', bookKey: 'k1', title,
    sourceName: kind === 'local' ? null : LONG_SOURCE,
    progress: { chapterIndex: 1, offsetRatio: 0.5, updatedAt: 2 },
    addedAt: 0,
  }
}

function markup(title: string, playing: boolean, kind: Kind = 'online'): string {
  panelShelf.set({ books: [entry(title, kind)], error: null, filter: 'all', keyword: '' })
  ttsPlayer.set({
    active: true, bookKey: 'k1', sourceId: 's1', title,
    chapterIndex: 1, paragraphCount: 4, paragraphIndex: 1,
    paragraphText: '第二段正文。', playing,
    engineId: 'builtin:baidu', mode: 'bytes', chapterNames: ['第一章', '第二章'],
  })
  // 书架渲染路径不读 window（对照 tts-layout：那里是迷你条渲染时读 innerWidth 才需要垫）
  return renderToStaticMarkup(
    <div data-novel-scope style={{ position: 'relative', minHeight: '100vh' }}>
      <NovelStyles />
      <ShelfView deps={makeCoreDeps({ apiGet: async () => [entry(title, kind)] })} />
    </div>,
  )
}

const pageHtml = (title: string, playing: boolean, kind: Kind = 'online'): string =>
  '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">'
  + markup(title, playing, kind) + '</body></html>'

/** 两盒是否叠到一处（1px 容差：边框与亚像素取整不算叠） */
function overlap(a: Box, b: Box): boolean {
  return a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1
}

describe.skipIf(!ENABLED)('浏览器几何：书架「正在听」徽标 vs 书名行与来源 chip', () => {
  let browser: Browser

  beforeAll(async () => { browser = await launchBrowser() }, 90_000)
  // 冷启动的 Chromium 收尾可超过缺省 10s 钩子时限：只延这一颗，判据不动
  afterAll(async () => { await browser.close() }, 90_000)

  async function measure(title: string, playing: boolean, width = 1280, kind: Kind = 'online'): Promise<Row[]> {
    const page = await (await browser.newContext({ viewport: { width, height: 800 } })).newPage()
    await page.setContent(pageHtml(title, playing, kind))
    const out = JSON.parse(await page.evaluate(probe)) as { rows: Row[] }
    await page.context().close()
    return out.rows
  }

  /** 取那一本有书名的卡（网格末位还有导入引导卡） */
  function book(rows: Row[]): Row {
    const row = rows.find((r) => r.text === LONG_TITLE)
    if (row === undefined) throw new Error(`书架网格里没有「${LONG_TITLE}」这一张卡：${JSON.stringify(rows.map((r) => r.text))}`)
    return row
  }

  it('徽标不占书名行：无徽标时排得下的书名，挂上徽标后仍排得下（逐档视口）', async () => {
    // 侧栏可拖窄、网格按列数重排，卡片宽度随之变——判据在每一档视口上都得成立，不是只在缺省档。
    for (const width of [1280, 900, 640, 420]) {
      const bare = book(await measure(LONG_TITLE, false, width))
      const tagged = book(await measure(LONG_TITLE, true, width))
      expect(tagged.badge?.text, `${width}px：徽标在场（这本此刻在播放）`).toBe('正在听')
      expect(bare.titleScroll - bare.titleClient, `${width}px：前提是无徽标时这一行本来排得下`).toBeLessThanOrEqual(0.5)
      // 判据：徽标不许拿书名换它——书名行的可用宽度不因徽标而变小（差分 = 0 才算改到根）
      expect(tagged.titleClient, `${width}px：书名行可用宽度（挂徽标 vs 不挂）`).toBeCloseTo(bare.titleClient, 0)
      expect(tagged.titleScroll - tagged.titleClient, `${width}px：省略号吃掉的那一截`).toBeLessThanOrEqual(0.5)
    }
  })

  it('徽标也不挤来源 chip：长源名的可用宽度不因徽标而变小', async () => {
    const bare = book(await measure(LONG_TITLE, false))
    const tagged = book(await measure(LONG_TITLE, true))
    const bareChip = bare.srcTag
    const taggedChip = tagged.srcTag
    if (bareChip === null || taggedChip === null) throw new Error('在线书的封面底左没有来源 chip')
    expect(taggedChip.client, '来源 chip 可用宽度（挂徽标 vs 不挂）').toBeCloseTo(bareChip.client, 0)
    expect(taggedChip.scroll - taggedChip.client, '超长源名照样是省略号（全名走 title），不是溢出').toBeGreaterThan(0)
    expect(tagged.cellScroll - tagged.cellClient, '卡片不横向溢出（撑破列宽就没有省略号而是滚动条）').toBeLessThanOrEqual(0.5)
  })

  it('徽标自己不许被挤：完整可见、待在卡内、不与书名行 / 进度行 / 任何角标叠', async () => {
    for (const kind of ['online', 'local'] as const) {
      const tagged = book(await measure(LONG_TITLE, true, 1280, kind))
      const badge = tagged.badge
      if (badge === null) throw new Error(`${kind} 卡上没有「正在听」徽标——状态字退场了`)
      const cover = tagged.cover
      if (cover === null) throw new Error('卡片没有封面盒，徽标无处可钉')
      expect(badge.scroll - badge.client, `${kind}：徽标自身文字不能被省略号吃掉`).toBeLessThanOrEqual(0.5)
      expect(badge.width, `${kind}：徽标可见宽度够放三个字`).toBeGreaterThanOrEqual(30)
      expect(badge.left, `${kind}：徽标左边在卡内`).toBeGreaterThanOrEqual(tagged.cell.left - 0.5)
      expect(badge.right, `${kind}：徽标右边在卡内`).toBeLessThanOrEqual(tagged.cell.right + 0.5)
      expect(badge.top, `${kind}：徽标顶边在卡内`).toBeGreaterThanOrEqual(tagged.cell.top - 0.5)
      expect(badge.bottom, `${kind}：徽标底边在卡内`).toBeLessThanOrEqual(tagged.cell.bottom + 0.5)
      expect(overlap(badge, tagged.title), `${kind}：徽标与书名不叠`).toBe(false)
      if (tagged.meta !== null) expect(overlap(badge, tagged.meta), `${kind}：徽标与进度行不叠`).toBe(false)
      // 底左那条槽位：在线 = 来源 chip，本地 = 「本地」——徽标在顶左，两者不该照面
      for (const corner of [tagged.srcTag, tagged.localTag]) {
        if (corner === null) continue
        expect(overlap(badge, corner), `${kind}：徽标与底左角标不叠`).toBe(false)
        expect(corner.left, `${kind}：底左角标不出封面左缘`).toBeGreaterThanOrEqual(cover.left - 0.5)
        expect(corner.right, `${kind}：底左角标不出封面右缘`).toBeLessThanOrEqual(cover.right + 0.5)
      }
      if (kind === 'local') {
        expect(tagged.srcTag, '本地书不出来源 chip').toBeNull()
        expect(tagged.localTag?.text, '本地书的出处身份仍在底左').toBe('本地')
      }
    }
  })
})
