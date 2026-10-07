/**
 * 书籍详情浮层的几何门（`DSH_EPUB_BROWSER=1` 打开；默认整门跳过，`pnpm test` 不跑它）。
 * jsdom 量不到排版，而这条 bug 只在真排版下现形：本源那一行放不下时，被挤走的是**两颗动作钮**
 * （挤出浮层就是点不到）与**源名**（挤没就是这一行不知道自己是谁）。故读数取真浏览器的 rect。
 *
 * 组件与样式都是**现物**：markup 由 `renderToStaticMarkup(CityBookSheet)` 出，CSS 用发布用的
 * `NOVEL_CSS` 那一份——不在这里手抄类名结构，抄来的形状只会绿给自己看。不起服务、不读站点。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Browser } from 'playwright'
import type { ExploreBook } from '../../src/shared/wire.js'
import { CityBookSheet } from '../../src/client/views/CityBookSheet.js'
import { NOVEL_CSS } from '../../src/client/styles.js'
import { makeCoreDeps } from '../client/fake-deps.js'
import { launchBrowser } from './epub-host.js'

const ENABLED = process.env.DSH_EPUB_BROWSER === '1'

/** 真机取回的那一条：章名带打赏尾巴，长到会顶满一行 */
const book: ExploreBook = {
  name: '我加载了武道破限面板', author: null, bookUrl: 'https://example/bk/1',
  coverUrl: null, kind: '玄幻小说', lastChapter: '第919章 不立危墙 问道天河！（谢WII2万币打赏！）',
  intro: null, wordCount: null,
}

/** 一次量到的读数：本源那一行的几何 + 整层浮层里「最新」被说了几次 */
interface RowRects {
  drawerRight: number
  rowScroll: number
  rowClient: number
  whoWidth: number
  whoNeed: number
  pillW: number
  pillNeed: number
  pillH: number
  pillNeedH: number
  lastCount: number
  btn: Array<{ right: number; width: number }>
}

const probe = `(() => {
  const num = (v) => (typeof v === 'number' ? v : -1)
  const row = document.querySelector('.novel-city-srclist .novel-city-srcrow')
  const who = row.querySelector('.novel-city-srcrow-who')
  const pill = document.querySelector('.novel-city-tag')
  return JSON.stringify({
    drawerRight: num(document.querySelector('.novel-city-drawer').getBoundingClientRect().right),
    rowScroll: num(row.scrollWidth), rowClient: num(row.clientWidth),
    whoWidth: num(who.getBoundingClientRect().width), whoNeed: num(who.scrollWidth),
    pillW: num(pill.getBoundingClientRect().width), pillNeed: num(pill.scrollWidth),
    pillH: num(pill.getBoundingClientRect().height), pillNeedH: num(pill.scrollHeight),
    lastCount: [...document.querySelectorAll('.novel-city-drawer *')]
      .filter((e) => e.childElementCount === 0 && /^最新/.test(e.textContent ?? '')).length,
    btn: [...row.querySelectorAll('button')].map((b) => ({
      right: num(b.getBoundingClientRect().right), width: num(b.getBoundingClientRect().width),
    })),
  })
})()`

describe.skipIf(!ENABLED)('浏览器几何：书籍详情浮层的本源那一行', () => {
  let browser: Browser

  beforeAll(async () => { browser = await launchBrowser() }, 90_000)
  afterAll(async () => { await browser?.close() })

  async function measure(b: ExploreBook): Promise<RowRects> {
    const markup = renderToStaticMarkup(
      <CityBookSheet book={b} sourceId="s9" sourceName="笔趣阁" deps={makeCoreDeps()} onClose={() => {}} />,
    )
    const page = await (await browser.newContext({ viewport: { width: 1000, height: 800 } })).newPage()
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>${NOVEL_CSS}</style></head>` +
      `<body><div class="novel-root"><div data-novel-view="city"><div class="novel-city">${markup}</div></div></div></body></html>`,
    )
    const out = JSON.parse(await page.evaluate(probe)) as RowRects
    await page.context().close()
    return out
  }

  /** 四条一起量：行不溢出、两颗钮还在浮层里、源名整句在场、「最新」全浮层只说一次且由头部说完 */
  function expectRowFits(m: RowRects): void {
    expect(m.btn.length, '行内两颗钮都在场').toBe(2)
    expect.soft(m.rowScroll, `本源那一行横向溢出 ${m.rowScroll - m.rowClient}px`).toBeLessThanOrEqual(m.rowClient)
    for (const b of m.btn) {
      expect.soft(b.right, '钮的右缘不许越过浮层右边界（越界即被裁，点不到）').toBeLessThanOrEqual(m.drawerRight)
      expect.soft(b.width, '钮不许被压窄到字折行').toBeGreaterThan(40)
    }
    expect.soft(m.whoWidth, '「笔趣阁」是这一行的身份，一个字都不许被省略号吃掉').toBeGreaterThanOrEqual(m.whoNeed)
    expect.soft(m.lastCount, '「最新」在浮层里只说一次').toBe(1)
    expect.soft(m.pillW, '那一句改由头部那颗 tag 整句说：宽度不许缺').toBeGreaterThanOrEqual(m.pillNeed)
    expect.soft(m.pillH, '那一句改由头部那颗 tag 整句说：高度不许缺（换行也要量够）').toBeGreaterThanOrEqual(m.pillNeedH)
  }

  it('短章名本来就放得下（对照组：长文本才是触发条件，不是这一行天生装不下）', async () => {
    expectRowFits(await measure({ ...book, lastChapter: '第919章 不立危墙' }))
  })

  it('长章名不许把两颗动作钮挤出浮层，也不许把源名挤没', async () => {
    expectRowFits(await measure(book))
  })
})
