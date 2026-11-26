// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CSSProperties } from 'react'
import type { Browser } from 'playwright'
import { NovelStyles } from '../../src/client/styles.js'
import { TtsBar } from '../../src/client/tts/TtsBar.js'
import { ttsPlayer } from '../../src/client/tts/player.js'
import { BookStage } from '../../src/client/views/BookStage.js'
import type { ChapterContent } from '../../src/client/views/types.js'
import { BROWSER_GATE_ENABLED } from '../support/browser-gate.js'
import { launchBrowser } from './epub-host.js'

/**
 * 翻页阅读的真浏览器几何门（`DSH_BROWSER_GATE=1` 打开）。
 *
 * jsdom 量不到多栏是否真的溢出、页脚是否被舞台裁掉、书封/书页是否超出舞台——这三条正是
 * 翻页模式的骨架。markup 由 `renderToStaticMarkup` 出，CSS 是发布用的那一份，不起服务、不读站点。
 * SSR 不跑测量 effect，所以这里只量**静态骨架**；分页数学与交互归单测/接线用例。
 */

const ENABLED = BROWSER_GATE_ENABLED
const PAGE_VIEW = { width: 1280, height: 900 }

const TEXT: ChapterContent = {
  kind: 'text',
  text: Array.from({ length: 90 }, (_, i) =>
    `第 ${i + 1} 段正文，用来看多栏排版在固定页高下是否继续生成溢出栏。`).join('\n'),
}

interface Rect { left: number; right: number; top: number; bottom: number; width: number; height: number }
interface Read {
  layout: string | null
  rdr: Rect
  stage: Rect
  cover: Rect
  coverBox: { clientWidth: number; scrollWidth: number }
  shell: Rect
  viewport: Rect
  edgeLeft: Rect
  edgeRight: Rect
  track: { clientWidth: number; scrollWidth: number; clientHeight: number; columnFill: string; columnCount: string }
  footer: Rect
  footerStyle: { visibility: string; pointerEvents: string }
  ttsBar: (Rect & { position: string; scrollWidth: number; clientWidth: number }) | null
  pageNum: string
}

function markup(withTts = false, width = 1200, height = 800): string {
  const stageSize = { width, height: Math.max(240, height - 48) }
  return renderToStaticMarkup(
    <div
      data-novel-scope
      style={{
        position: 'relative', width: `${width}px`, height: `${height}px`,
        '--novel-paper': '#f7f3e8', '--novel-paper-ink': '#222222',
      } as CSSProperties}
    >
      <NovelStyles />
      <div
        className={withTts ? 'novel-rdr is-paged is-tts-open' : 'novel-rdr is-paged'}
        style={{ height: '100%' }}
      >
        <div className="novel-rdr-bar" style={{ minHeight: 48, flex: 'none' }} />
        <div className="novel-rdr-main" style={{ display: 'flex', flex: '1 1 0', minHeight: 0 }}>
          <BookStage
            chapterIndex={0}
            totalChapters={2}
            chapterName="第一章"
            content={TEXT}
            loading={false}
            bookKey="book-geometry"
            fontSize={18}
            lineHeight={1.8}
            measure={680}
            animation="none"
            initialRatio={0}
            initialStageSize={stageSize}
            listenParagraph={null}
            listenFollowing={false}
            keyboardBlocked={false}
            onNavigate={() => {}}
            onChangeChapter={() => {}}
            onReportRatio={() => {}}
            onUserIntent={() => {}}
            chapterRefs={{ current: [] }}
            bodyRef={{ current: null }}
          />
        </div>
        {withTts && (
          <TtsBar darkController={false} apiGet={async () => [] as never} pushError={() => {}} onLocate={() => {}} />
        )}
      </div>
    </div>,
  )
}

const PROBE = `() => {
  const rect = (el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
  }
  const rdr = document.querySelector('.novel-rdr')
  const stage = document.querySelector('.novel-book-stage')
  const cover = document.querySelector('.novel-book-cover')
  const shell = document.querySelector('.novel-book-shell')
  const viewport = document.querySelector('.novel-book-viewport')
  const edgeLeft = document.querySelector('.novel-book-edge-left')
  const edgeRight = document.querySelector('.novel-book-edge-right')
  const track = document.querySelector('.novel-book-track')
  const footer = document.querySelector('.novel-book-footer')
  const tts = document.querySelector('.novel-tts-bar')
  const cs = getComputedStyle(track)
  return {
    layout: stage?.getAttribute('data-page-layout') ?? null,
    rdr: rect(rdr),
    stage: rect(stage),
    cover: rect(cover),
    coverBox: { clientWidth: cover.clientWidth, scrollWidth: cover.scrollWidth },
    shell: rect(shell),
    viewport: rect(viewport),
    edgeLeft: rect(edgeLeft),
    edgeRight: rect(edgeRight),
    track: {
      clientWidth: track.clientWidth,
      scrollWidth: track.scrollWidth,
      clientHeight: track.clientHeight,
      columnFill: cs.columnFill,
      columnCount: cs.columnCount,
    },
    footer: rect(footer),
    footerStyle: {
      visibility: getComputedStyle(footer).visibility,
      pointerEvents: getComputedStyle(footer).pointerEvents,
    },
    ttsBar: tts === null ? null : {
      ...rect(tts), position: getComputedStyle(tts).position,
      scrollWidth: tts.scrollWidth, clientWidth: tts.clientWidth,
    },
    pageNum: document.querySelector('[data-novel-page-num]')?.textContent ?? '',
  }
}`

describe.skipIf(!ENABLED)('浏览器几何：翻页阅读舞台', () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await launchBrowser()
  }, 90_000)
  afterAll(async () => { await browser.close() }, 90_000)

  it('宽屏双页骨架：多栏溢出、页脚在舞台内、书封不越界', async () => {
    const page = await (await browser.newContext({ viewport: { ...PAGE_VIEW } })).newPage()
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${markup()}</body></html>`)
    const read = await page.evaluate<Read>(`(${PROBE})()`)
    await page.context().close()

    expect(read.layout).toBe('spread')
    expect(read.track.columnFill).toBe('auto')
    expect(read.track.scrollWidth).toBeGreaterThan(read.track.clientWidth)   // 整章确实溢出成多栏
    expect(read.footer.bottom).toBeLessThanOrEqual(read.stage.bottom + 1)   // 页脚没有被舞台裁掉
    expect(read.cover.width).toBeLessThanOrEqual(read.stage.width + 1)      // 书封没有横向越界
    expect(read.shell.width).toBeLessThanOrEqual(read.stage.width + 1)
    expect(read.shell.right).toBeLessThanOrEqual(read.cover.right + 1)      // 书壳与左右书口不得溢出硬壳书封
    expect(read.edgeRight.right).toBeLessThanOrEqual(read.cover.right + 1)
    expect(read.edgeLeft.left).toBeGreaterThanOrEqual(read.cover.left - 1)
    expect(read.coverBox.scrollWidth).toBeLessThanOrEqual(read.coverBox.clientWidth + 1)
    expect(read.pageNum).toContain('页')
  })

  it('翻页模式挂载听书条：听书条出流悬浮，舞台/书封/多栏轨道零重排', async () => {
    const prev = ttsPlayer.get()
    ttsPlayer.set({
      active: true, bookKey: 'book-geometry', sourceId: 's1', title: '样本书',
      chapterIndex: 0, paragraphCount: 4, paragraphIndex: 1,
      paragraphText: '第一段正文。', playing: true,
      engineId: 'builtin:baidu', mode: 'bytes', chapterNames: ['第一章', '第二章'],
    })
    try {
      const ctxA = await browser.newContext({ viewport: { ...PAGE_VIEW } })
      const pA = await ctxA.newPage()
      await pA.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${markup(false)}</body></html>`)
      const withoutTts = await pA.evaluate<Read>(`(${PROBE})()`)
      await ctxA.close()

      const ctxB = await browser.newContext({ viewport: { ...PAGE_VIEW } })
      const pB = await ctxB.newPage()
      await pB.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${markup(true)}</body></html>`)
      const withTts = await pB.evaluate<Read>(`(${PROBE})()`)
      await ctxB.close()

      expect(withTts.layout).toBe('spread')
      expect(withTts.ttsBar).not.toBeNull()
      expect(withTts.ttsBar?.position).toBe('absolute')
      expect(withTts.ttsBar?.top).toBeGreaterThanOrEqual(withTts.viewport.bottom - 1)
      expect(withTts.ttsBar?.bottom).toBeLessThanOrEqual(withTts.rdr.bottom + 0.5)
      expect(withTts.footerStyle).toEqual({ visibility: 'hidden', pointerEvents: 'none' })
      expect(withTts.stage).toEqual(withoutTts.stage)
      expect(withTts.cover).toEqual(withoutTts.cover)
      expect(withTts.viewport).toEqual(withoutTts.viewport)
      expect(withTts.track).toEqual(withoutTts.track)

      // 连败提示态：浮岛紧凑单行出错提示仍不得压住正文底边
      ttsPlayer.set({ halt: { reason: 'consecutive-failures', failures: 3 }, playing: false, loading: false })
      const ctxFail = await browser.newContext({ viewport: { ...PAGE_VIEW } })
      const pFail = await ctxFail.newPage()
      await pFail.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${markup(true, 1200, 800)}</body></html>`)
      const withFailTts = await pFail.evaluate<Read>(`(${PROBE})()`)
      await ctxFail.close()
      expect(withFailTts.ttsBar).not.toBeNull()
      expect(withFailTts.ttsBar?.top).toBeGreaterThanOrEqual(withFailTts.viewport.bottom - 1)
      expect(withFailTts.ttsBar?.bottom).toBeLessThanOrEqual(withFailTts.rdr.bottom + 0.5)
      expect(withFailTts.stage).toEqual(withoutTts.stage)

      ttsPlayer.set({ halt: null, playing: true, loading: false })
      const ctxNarrowA = await browser.newContext({ viewport: { width: 420, height: 700 } })
      const pNarrowA = await ctxNarrowA.newPage()
      await pNarrowA.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${markup(false, 420, 700)}</body></html>`)
      const narrowWithoutTts = await pNarrowA.evaluate<Read>(`(${PROBE})()`)
      await ctxNarrowA.close()

      const ctxNarrowB = await browser.newContext({ viewport: { width: 420, height: 700 } })
      const pNarrowB = await ctxNarrowB.newPage()
      await pNarrowB.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${markup(true, 420, 700)}</body></html>`)
      const narrowWithTts = await pNarrowB.evaluate<Read>(`(${PROBE})()`)
      await ctxNarrowB.close()

      expect(narrowWithoutTts.layout).toBe('single')
      expect(narrowWithTts.layout).toBe('single')
      expect(narrowWithTts.ttsBar).not.toBeNull()
      expect(narrowWithTts.ttsBar?.position).toBe('absolute')
      expect(narrowWithTts.ttsBar?.top).toBeGreaterThanOrEqual(narrowWithTts.viewport.bottom - 1)
      expect(narrowWithTts.ttsBar?.bottom).toBeLessThanOrEqual(narrowWithTts.rdr.bottom + 0.5)
      expect(narrowWithTts.ttsBar?.height).toBeLessThanOrEqual(64)
      expect(narrowWithTts.ttsBar?.scrollWidth).toBeLessThanOrEqual((narrowWithTts.ttsBar?.clientWidth ?? 0) + 1)
      expect(narrowWithTts.footerStyle).toEqual({ visibility: 'hidden', pointerEvents: 'none' })
      expect(narrowWithTts.stage).toEqual(narrowWithoutTts.stage)
      expect(narrowWithTts.cover).toEqual(narrowWithoutTts.cover)
      expect(narrowWithTts.viewport).toEqual(narrowWithoutTts.viewport)
      expect(narrowWithTts.track).toEqual(narrowWithoutTts.track)
    } finally {
      ttsPlayer.set(prev)
    }
  })
})