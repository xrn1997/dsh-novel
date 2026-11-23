// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CSSProperties } from 'react'
import type { Browser } from 'playwright'
import { NovelStyles } from '../../src/client/styles.js'
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
  stage: Rect
  cover: Rect
  coverBox: { clientWidth: number; scrollWidth: number }
  shell: Rect
  edgeLeft: Rect
  edgeRight: Rect
  track: { clientWidth: number; scrollWidth: number; clientHeight: number; columnFill: string; columnCount: string }
  footer: Rect
  pageNum: string
}

function markup(): string {
  return renderToStaticMarkup(
    <div
      data-novel-scope
      style={{
        position: 'relative', width: '1200px', height: '800px',
        '--novel-paper': '#f7f3e8', '--novel-paper-ink': '#222222',
      } as CSSProperties}
    >
      <NovelStyles />
      <div className="novel-rdr is-paged" style={{ height: '100%' }}>
        <div className="novel-rdr-main" style={{ display: 'flex' }}>
          <div style={{ width: '1000px', height: '620px', display: 'flex' }}>
            <BookStage
              chapterIndex={0}
              totalChapters={2}
              chapterName="第一章"
              content={TEXT}
              loading={false}
              bookKey="book-geometry"
              fontSize={18}
              lineHeight={1.8}
              measure={36}
              animation="none"
              initialRatio={0}
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
        </div>
      </div>
    </div>,
  )
}

const PROBE = `() => {
  const rect = (el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
  }
  const stage = document.querySelector('.novel-book-stage')
  const cover = document.querySelector('.novel-book-cover')
  const shell = document.querySelector('.novel-book-shell')
  const edgeLeft = document.querySelector('.novel-book-edge-left')
  const edgeRight = document.querySelector('.novel-book-edge-right')
  const track = document.querySelector('.novel-book-track')
  const footer = document.querySelector('.novel-book-footer')
  const cs = getComputedStyle(track)
  return {
    layout: stage?.getAttribute('data-page-layout') ?? null,
    stage: rect(stage),
    cover: rect(cover),
    coverBox: { clientWidth: cover.clientWidth, scrollWidth: cover.scrollWidth },
    shell: rect(shell),
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
})