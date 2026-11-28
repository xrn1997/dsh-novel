// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Browser } from 'playwright'
import { DEFAULT_PREFS } from '../../src/client/store.js'
import type { ReaderScene } from '../../src/client/reader-scene.js'
import type { ReaderSceneState } from '../../src/client/reader-scene.js'
import type { ReaderSession } from '../../src/client/reader-session.js'
import type { ReaderSessionState } from '../../src/client/reader-session.js'
import { NovelStyles } from '../../src/client/styles.js'
import { MoyuStage, measureMoyuStageRect } from '../../src/client/views/MoyuStage.js'
import { BROWSER_GATE_ENABLED } from '../support/browser-gate.js'
import { launchBrowser } from './epub-host.js'

const ENABLED = BROWSER_GATE_ENABLED

const state: ReaderSessionState = {
  toc: [
    { name: '第一章', url: 'u1' },
    { name: '第二章', url: 'u2' },
    { name: '第三章', url: 'u3' },
  ],
  navigation: null,
  chapters: [
    { kind: 'text', text: '第一段正文。\n第二段正文。' },
    { kind: 'text', text: '第二章正文。' },
    { kind: 'text', text: '第三章正文。' },
  ],
  loadingIdx: null,
  error: null,
  domRevision: 0,
  currentChapter: 0,
  returnDepth: 0,
}

const sceneState: ReaderSceneState = {
  surface: null,
  note: null,
  askShelf: false,
  joinBusy: false,
  joinError: null,
  mask: false,
  escOwner: 'none',
}

function markup(width = 1280, height = 900, left = 200, top = 40, dockOpen = true): string {
  const session = { requestJump: () => {}, retry: () => {} } as unknown as ReaderSession
  const scene = { toggle: () => {}, exitToShelf: () => {} } as unknown as ReaderScene
  return renderToStaticMarkup(
    <div data-novel-scope style={{ display: 'flex', width: `${width}px`, height: `${height}px` }}>
      <div style={{ width: `${left}px`, height: `${height}px` }} />
      <div data-novel-main style={{ position: 'relative', width: `${width - left}px`, height: `${height - top}px`, marginTop: `${top}px` }}>
        <NovelStyles />
        <MoyuStage
          session={session}
          sourceId="s1"
          bookKey="k1"
          title="几何样本书"
          state={state}
          prefs={{ ...DEFAULT_PREFS, readingMode: 'moyu', moyuReveal: 'instant' }}
          scene={scene}
          sceneState={sceneState}
          listen={{ showing: false, active: false, busy: false, chapterIndex: 0, paragraphIndex: 0 }}
          importNotesCount={0}
          onOpenExport={() => {}}
          onListen={() => {}}
          onClose={() => {}}
          onNavigate={() => {}}
          onTtsError={() => {}}
          apiGet={async () => { throw new Error('no api in layout gate') }}
          defaultDockOpen={dockOpen}
        />
      </div>
    </div>,
  )
}

interface Rect { left: number; right: number; top: number; bottom: number; width: number; height: number }
interface Read {
  stage: Rect
  stagePosition: string
  stageZ: string
  header: Rect
  titleRow: Rect
  tabsRow: Rect
  dock: Rect | null
  dockSep: Rect | null
  main: Rect
  column: Rect | null
  composerCard: Rect | null
  composerSeat: Rect | null
  dockStrip: Rect | null
  filesHeader: Rect | null
  treeRow: Rect | null
  iconFill: string
  iconStroke: string
  sendFill: string
  sendStroke: string
}

const PROBE = `() => {
  const rect = (el) => {
    if (el === null) return null
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
  }
  const q = (sel) => document.querySelector(sel)
  const styleOf = (el) => (el === null ? { fill: null, stroke: null } : getComputedStyle(el))
  const icon = q('.novel-moyu-files-actions svg')
  const send = q('.novel-moyu-send svg')
  const iconStyle = styleOf(icon)
  const sendStyle = styleOf(send)
  return {
    stage: rect(q('.novel-moyu-stage')),
    stagePosition: getComputedStyle(q('.novel-moyu-stage')).position,
    stageZ: getComputedStyle(q('.novel-moyu-stage')).zIndex,
    header: rect(q('.novel-moyu-header')),
    titleRow: rect(q('.novel-moyu-title-row')),
    tabsRow: rect(q('.novel-moyu-tabs-row')),
    dock: rect(q('.novel-moyu-dock')),
    dockSep: rect(q('.novel-moyu-dock-sep')),
    main: rect(q('.novel-moyu-main')),
    column: rect(q('.novel-moyu-column')),
    composerCard: rect(q('.novel-moyu-composer-card')),
    composerSeat: rect(q('.novel-moyu-composer-seat')),
    dockStrip: rect(q('.novel-moyu-dock-strip')),
    filesHeader: rect(q('.novel-moyu-files-header')),
    treeRow: rect(q('.novel-moyu-files-tree .novel-moyu-tree-row')),
    iconFill: iconStyle.fill,
    iconStroke: iconStyle.stroke,
    sendFill: sendStyle.fill,
    sendStroke: sendStyle.stroke,
  }
}`

describe.skipIf(!ENABLED)('浏览器几何：摸鱼舞台', () => {
  let browser: Browser

  beforeAll(async () => { browser = await launchBrowser() }, 90_000)
  afterAll(async () => { await browser.close() }, 90_000)

  it('宽屏固定铺满插件主内容区，头 76px、坞初始 320px + 8px 分隔条、正文列与输入卡同轴', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${markup()}</body></html>`)
    const stage = await page.$('.novel-moyu-stage')
    if (stage === null) throw new Error('missing Moyu stage')
    const measured = await page.evaluate(measureMoyuStageRect, stage)
    if (measured === null) throw new Error('missing novel main rect')
    expect(measured).toEqual({ left: 200, top: 40, width: 1080, height: 860 })
    await page.evaluate(({ element, rect }) => {
      Object.assign(element.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` })
    }, { element: stage, rect: measured })
    const read = await page.evaluate<Read>(`(${PROBE})()`)
    await context.close()

    expect(read.stagePosition).toBe('fixed')
    expect(read.stage).toEqual({ left: 200, right: 1280, top: 40, bottom: 900, width: 1080, height: 860 })
    expect(Number(read.stageZ)).toBeGreaterThan(12)

    // 会话头：宿主 76px 两行（30px 标题行 + 10px 间距 + 25px 标签行，余量按 min-height 收）。
    expect(read.header.height).toBe(76)
    expect(Math.round(read.titleRow.height)).toBe(30)
    expect(Math.round(read.tabsRow.height)).toBe(25)
    expect(Math.round(read.tabsRow.top - read.header.top)).toBe(50)

    // 文件坞初始宽 320px（可拖：min 300 / 初始 320；拖拽与键盘调宽的行为归
    // tests/client/moyu-stage.test.tsx 的分隔条用例）。
    // 标签条 38 + 文件头 38 = 会话头 76，两条分隔线在列口对齐。
    if (read.dock === null) throw new Error('missing desktop dock')
    expect(read.dock.width).toBe(320)
    expect(read.dock.right).toBe(1280)
    if (read.dockSep === null) throw new Error('missing dock separator')
    expect(read.dockSep.width).toBe(8)
    expect(read.main.right).toBe(read.dockSep.left)
    expect(read.dockSep.right).toBe(read.dock.left)
    expect(read.dockStrip?.height).toBe(38)
    expect(read.filesHeader?.height).toBe(38)
    expect(read.treeRow?.height).toBeCloseTo(29.5, 1)

    // 正文列：64% 且夹在 680~920 之间；与输入卡同轴（滚动条槽会让二者一起比主栏中线略偏左）。
    if (read.column === null) throw new Error('missing chat column')
    expect(read.column.width).toBeGreaterThanOrEqual(680)
    expect(read.column.width).toBeLessThanOrEqual(920)
    if (read.composerCard === null) throw new Error('missing composer card')
    expect(Math.abs((read.column.left + read.column.right) / 2 - (read.composerCard.left + read.composerCard.right) / 2)).toBeLessThanOrEqual(1.5)

    // 输入卡与正文列同轴：卡宽 = 列宽 + 32（宿主 composer max-width 口径）。
    expect(Math.round(read.composerCard.width - read.column.width)).toBe(32)
    expect(read.composerCard.left).toBeGreaterThanOrEqual(read.main.left)
    expect(read.composerCard.right).toBeLessThanOrEqual(read.main.right + 1)

    // 坞内线稿图标 fill:none + stroke:currentColor；发送钮是宿主实心笔形（fill 上色、stroke 无）。
    expect(read.iconFill).toBe('none')
    expect(read.iconStroke).not.toBe('none')
    expect(read.sendFill).not.toBe('none')
    expect(read.sendStroke).toBe('none')
  })

  it('窄屏文件坞不渲染时，正文列与输入卡仍铺满可用宽度', async () => {
    const context = await browser.newContext({ viewport: { width: 420, height: 700 } })
    const page = await context.newPage()
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${markup(420, 700, 0, 0, false)}</body></html>`)
    const read = await page.evaluate<Read>(`(${PROBE})()`)
    await context.close()

    expect(read.stage.width).toBe(420)
    expect(read.main.width).toBe(420)
    expect(read.dock).toBeNull()
    expect(read.header.height).toBe(76)
    if (read.column === null) throw new Error('missing chat column')
    expect(read.column.width).toBeLessThanOrEqual(420)
    if (read.composerCard === null) throw new Error('missing composer card')
    expect(read.composerCard.left).toBeGreaterThanOrEqual(0)
    expect(read.composerCard.right).toBeLessThanOrEqual(421)
  })

  it('窄屏打开文件坞＝整栏覆盖舞台（覆盖抽屉，不挤正文列）', async () => {
    const context = await browser.newContext({ viewport: { width: 420, height: 700 } })
    const page = await context.newPage()
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${markup(420, 700, 0, 0, true)}</body></html>`)
    const read = await page.evaluate<Read>(`(${PROBE})()`)
    await context.close()

    expect(read.stage).toEqual({ left: 0, right: 420, top: 0, bottom: 700, width: 420, height: 700 })
    if (read.dock === null) throw new Error('missing narrow dock')
    expect(Math.round(read.dock.left)).toBe(0)
    expect(Math.round(read.dock.right)).toBe(420)
    expect(Math.round(read.dock.bottom)).toBe(700)
    if (read.column === null) throw new Error('missing chat column')
    expect(read.column.width).toBeGreaterThan(0)
  })
})