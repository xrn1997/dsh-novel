// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Browser } from 'playwright'
import { NovelStyles } from '../../src/client/styles.js'
import { ChapterBody } from '../../src/client/views/ChapterBody.js'
import { TtsBar } from '../../src/client/tts/TtsBar.js'
import { TtsMiniBar } from '../../src/client/tts/TtsMiniBar.js'
import { TtsSettingsPanel, TtsSettingsRows } from '../../src/client/tts/TtsSettings.js'
import { miniBarStore } from '../../src/client/tts/mini-bar-state.js'
import { ttsPlayer, ttsProgress } from '../../src/client/tts/player.js'
import { must } from '../support/fixture.js'
import { BROWSER_GATE_ENABLED } from '../support/browser-gate.js'
import { launchBrowser } from './epub-host.js'

/**
 * 听书面几何门（`DSH_BROWSER_GATE=1` 打开，旧名 `DSH_EPUB_BROWSER` 仍认；默认整门跳过，`pnpm test` 不跑它）。
 *
 * 为什么这道门非开不可：迷你条的两个完整形态、听书条的章内滑杆、跟读高亮的换字色与段首三角——
 * 「头行与动作行不叠」「章内滑杆吃满整行」「三角画得出来且高亮进出不动逐段几何」
 * 「浮层底跟宿主 token 走」这几句话在 jsdom 里都只是字符串在场，量不到真排版。
 * markup 由 renderToStaticMarkup 出，CSS 是发布用的那一份（NovelStyles 注入），不起服务、不读站点。
 * 滚动条只断言计算样式（width/color）：headless 的 overlay 滚动条不占几何宽，offsetWidth 差量不可靠。
 */

const ENABLED = BROWSER_GATE_ENABLED

interface Rect { left: number; right: number; top: number; bottom: number; width: number; height: number }
interface Read {
  viewport: { width: number; height: number }
  mini: Rect
  miniBackground: string
  head: Rect | null
  /** 边栏里渲染出来的图片数：封面位若回来必是 `<img>`，所以“不渲染封面”这条有可失败的正向读数 */
  miniImages: number
  /** 胶囊里的书名与段号盒子：两端落位（书名贴左、段号贴右）是布局判据，不是装饰 */
  miniTitle: Rect | null
  miniBadge: Rect | null
  body: Rect | null
  bodyFont: string
  titleFont: string
  foot: Rect | null
  edges: Array<Rect & { edge: string }>
  buttons: Rect[]
  inputs: Rect[]
  /** 浮窗里的进度滑杆条数：ADR-0075 之后只该有章内这一条 */
  miniRanges: number
  chapterBar: Rect | null
  chapterInput: Rect | null
  acts: Rect | null
  actButtons: Rect[]
  ring: Rect | null
  bar: Rect
  /** 听书条上的进度滑杆条数：只该有章内这一条（段内时间滑杆已退场） */
  ranges: number
  chapterRange: Rect
  live: Rect | null
  liveBackground: string
  plainBackground: string
  liveColor: string
  plainColor: string
  marker: Rect | null
  markerColor: string
  /** 高亮段内的元素个数：段内进度线若回来必是子元素，故“不画进度线”按 0 个子元素正读 */
  liveDescendants: number | null
  paragraphs: Rect[]
  /** 听书设置卡的头行读数：卡名与关闭钮的盒子（jsdom 量不到「X 左边是不是空白」） */
  settings: {
    panel: Rect; title: Rect; close: Rect; titleText: string
    /** 设置卡自己的 touch-action：外层浮窗是拖面（none），卡里的触屏滚动必须还回来 */
    touchAction: string
  } | null
  scrollerScrollbarWidth: string
  scrollerScrollbarColor: string
}

const probe = `(() => {
  const rect = (el) => { const b = el.getBoundingClientRect()
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height } }
  const mini = document.querySelector('[data-novel-tts-mini]')
  const bar = document.querySelector('.novel-tts-bar')
  const live = document.querySelector('.novel-tts-live')
  const plain = document.querySelector('.novel-body p:not(.novel-tts-live)')
  const scroller = document.querySelector('[data-probe-scroll]')
  const scrollerStyle = getComputedStyle(scroller)
  return JSON.stringify({
    viewport: { width: innerWidth, height: innerHeight },
    mini: rect(mini),
    miniBackground: getComputedStyle(mini.querySelector('.novel-tts-mini-panel, .novel-tts-mini-capsule')).backgroundColor,
    head: mini.querySelector('.novel-tts-mini-head') === null ? null : rect(mini.querySelector('.novel-tts-mini-head')),
    miniImages: mini.querySelectorAll('img').length,
    miniTitle: mini.querySelector('.novel-tts-mini-title') === null ? null : rect(mini.querySelector('.novel-tts-mini-title')),
    miniBadge: mini.querySelector('.novel-tts-mini-badge') === null ? null : rect(mini.querySelector('.novel-tts-mini-badge')),
    body: mini.querySelector('.novel-tts-mini-body') === null ? null : rect(mini.querySelector('.novel-tts-mini-body')),
    bodyFont: mini.querySelector('.novel-tts-mini-body') === null ? '' : getComputedStyle(mini.querySelector('.novel-tts-mini-body')).fontSize,
    titleFont: mini.querySelector('.novel-tts-mini-title') === null ? '' : getComputedStyle(mini.querySelector('.novel-tts-mini-title')).fontSize,
    foot: mini.querySelector('.novel-tts-mini-foot') === null ? null : rect(mini.querySelector('.novel-tts-mini-foot')),
    edges: [...mini.querySelectorAll('.novel-tts-mini-edge')].map((el) => ({ edge: el.dataset.edge, ...rect(el) })),
    buttons: [...mini.querySelectorAll('button')].map(rect),
    inputs: [...mini.querySelectorAll('input')].map(rect),
    miniRanges: mini.querySelectorAll('input[type="range"]').length,
    chapterBar: mini.querySelector('.novel-tts-mini-chapseek') === null ? null : rect(mini.querySelector('.novel-tts-mini-chapseek')),
    chapterInput: mini.querySelector('.novel-tts-mini-chapseek-range') === null ? null : rect(mini.querySelector('.novel-tts-mini-chapseek-range')),
    acts: mini.querySelector('.novel-tts-mini-acts') === null ? null : rect(mini.querySelector('.novel-tts-mini-acts')),
    actButtons: [...mini.querySelectorAll('.novel-tts-mini-acts button')].map(rect),
    ring: mini.querySelector('.novel-tts-ringplay') === null ? null : rect(mini.querySelector('.novel-tts-ringplay')),
    bar: rect(bar),
    ranges: bar.querySelectorAll('input[type="range"]').length,
    chapterRange: rect(bar.querySelector('.novel-tts-chapter-seek input')),
    live: live === null ? null : rect(live),
    liveBackground: live === null ? '' : getComputedStyle(live).backgroundColor,
    plainBackground: getComputedStyle(plain).backgroundColor,
    liveColor: live === null ? '' : getComputedStyle(live).color,
    plainColor: getComputedStyle(plain).color,
    // 段首三角：::before 没有独立可量盒，按 border-left 实心 + absolute 在场判「画得出来」
    marker: (() => {
      if (live === null) return null
      const b = getComputedStyle(live, '::before')
      if (b.display === 'none' || b.content === 'none') return null
      if (!/^rgb/.test(b.borderLeftColor) || b.position !== 'absolute') return null
      return { left: 0, right: 0, top: 0, bottom: 0, width: parseFloat(b.borderLeftWidth), height: parseFloat(b.borderTopWidth) }
    })(),
    markerColor: live === null ? '' : getComputedStyle(live, '::before').borderLeftColor,
    liveDescendants: live === null ? null : live.querySelectorAll('*').length,
    paragraphs: [...document.querySelectorAll('.novel-body p')].map(rect),
    settings: (() => {
      const panel = document.querySelector('.novel-tts-panel')
      if (panel === null) return null
      const title = panel.querySelector('.novel-tts-panel-title')
      const close = panel.querySelector('.novel-tts-panel-close')
      if (title === null || close === null) return null
      return {
        panel: rect(panel), title: rect(title), close: rect(close), titleText: title.textContent,
        touchAction: getComputedStyle(panel).touchAction,
      }
    })(),
    scrollerScrollbarWidth: scrollerStyle.scrollbarWidth,
    scrollerScrollbarColor: scrollerStyle.scrollbarColor,
  })
})()`

/** 量几何的那一页（与 `measure` 的 context viewport 同尺）：静态 markup 在 Node 里渲染，
 *  没有活窗口可读，而浮窗的落位样式要按视口把缺省轴解析成像素——渲染时把这一页的视口给组件，
 *  量到的才是这一页上的真实落位（缺省贴右缘）。这里只补一个两字段的 window 形状，不是浏览器
 *  窗口替身：布局读数只读 innerWidth / innerHeight，量真排版仍靠后面的浏览器 context。 */
const PAGE_VIEW = { width: 1280, height: 800 }

function markup(listening = true, view = PAGE_VIEW): string {
  const host = globalThis as { window?: { innerWidth: number; innerHeight: number } | undefined }
  const prev = host.window
  host.window = { innerWidth: view.width, innerHeight: view.height }
  try {
    return renderToStaticMarkup(
      <div data-novel-scope style={{ position: 'relative', height: '100vh' }}>
        <NovelStyles />
        <div style={{ padding: 24, maxWidth: 720, margin: '0 auto' }}>
          <div style={{ position: 'absolute', top: 16, left: 16, width: 320 }}>
            <TtsSettingsPanel label="听书设置" onClose={() => {}}>
              <TtsSettingsRows sources={[{ id: 'builtin:baidu', kind: 'builtin' }]} surface="bar" />
            </TtsSettingsPanel>
          </div>
          <TtsBar darkController={false} apiGet={async () => [] as never} pushError={() => {}} onLocate={() => {}} />
          <ChapterBody
            content={{ kind: 'text', text: '第一段正文。\n第二段正文，正在被念的那一段。\n第三段正文。\n第四段正文。' }}
            bookKey="k1"
            onNavigate={() => {}}
            listenParagraph={listening ? 1 : null}
          />
          <div data-probe-scroll style={{ height: 40, overflowY: 'auto' }}>
            <div style={{ height: 200 }} />
          </div>
        </div>
        <TtsMiniBar withStyles={false} focusPanel={() => {}} />
      </div>,
    )
  } finally {
    host.window = prev
  }
}

const pageHtml = (listening = true, view = PAGE_VIEW): string =>
  '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">'
  + markup(listening, view) + '</body></html>'

describe.skipIf(!ENABLED)('浏览器几何：听书条 / 迷你条 / 跟读高亮', () => {
  let browser: Browser

  beforeAll(async () => {
    ttsPlayer.set({
      active: true, bookKey: 'k1', sourceId: 's1', title: '样本书',
      chapterIndex: 1, paragraphCount: 4, paragraphIndex: 1,
      paragraphText: '第二段正文，正在被念的那一段。', playing: true,
      engineId: 'builtin:baidu', mode: 'bytes', chapterNames: ['第一章', '第二章'],
    })
    ttsProgress.set({ position: 5, duration: 20 })
    miniBarStore.set({ cx: null, cy: null, w: null, h: null, collapsed: false })
    browser = await launchBrowser()
  }, 90_000)
  // 冷启动的 Chromium 收尾可超过缺省 10s 钩子时限：只延这一颗，判据不动
  afterAll(async () => { await browser.close() }, 90_000)

  async function measure(listening = true, view = PAGE_VIEW): Promise<Read> {
    const page = await (await browser.newContext({ viewport: { ...view } })).newPage()
    await page.setContent(pageHtml(listening, view))
    const out = JSON.parse(await page.evaluate(probe)) as Read
    await page.context().close()
    return out
  }

  it('展开缺省 320×200：顶行 / 正文 / 运输行 / 底行竖排不叠，正文拿到剩余高度', async () => {
    const r = await measure()
    expect(r.mini.width, '缺省宽 320').toBeCloseTo(320, 0)
    expect(r.mini.height, '缺省高 200').toBeCloseTo(200, 0)
    expect(r.mini.right, '右缘贴合视口').toBeGreaterThanOrEqual(r.viewport.width - 0.5)
    expect(r.mini.left, '整块在屏内').toBeGreaterThanOrEqual(0)
    expect(r.miniImages, '边栏不渲染封面图').toBe(0)
    expect(r.miniRanges, '浮窗只剩章内一条进度滑杆').toBe(1)
    expect(must(r.body, '正文区').height, '正文拿到剩余高度').toBeGreaterThanOrEqual(40)
    expect(must(r.head, '顶行').bottom, '顶行与正文不叠').toBeLessThanOrEqual(must(r.body, '正文区').top + 0.5)
    expect(must(r.body, '正文区').bottom, '正文与运输行不叠').toBeLessThanOrEqual(must(r.acts, '运输行').top + 0.5)
    expect(must(r.acts, '运输行').bottom, '运输行与底行不叠').toBeLessThanOrEqual(must(r.foot, '底行').top + 0.5)
    expect(must(r.foot, '底行').bottom, '底行收在浮窗内').toBeLessThanOrEqual(r.mini.bottom + 0.5)
    for (const b of r.actButtons) {
      expect.soft(b.width, '动作钮够宽').toBeGreaterThanOrEqual(32)
      expect.soft(b.height, '动作钮够高').toBeGreaterThanOrEqual(32)
    }
    expect(must(r.ring, '进度环主钮').height, '环 44').toBeCloseTo(44, 0)
    expect(must(r.chapterInput, '章内进度滑杆').height, '滑杆命中带 ≥24').toBeGreaterThanOrEqual(24)
    const labels = r.edges.map((e) => e.edge).sort()
    expect(labels, '三条边 + 右下角，顶边不做把手').toEqual(['bottom', 'corner', 'left', 'right'])
    expect(r.bodyFont, '正文 13px').toBe('13px')
  })

  it('设置卡头行：可见卡名在左、关闭钮在右，同一行（X 左边不留空白）', async () => {
    const r = await measure()
    const s = must(r.settings, '设置卡头行')
    expect(s.titleText).toBe('听书设置')
    expect(s.title.width, '卡名有可见宽度').toBeGreaterThan(0)
    expect(s.title.right, '关闭钮在卡名右侧').toBeLessThanOrEqual(s.close.left + 0.5)
    const titleCenter = (s.title.top + s.title.bottom) / 2
    const closeCenter = (s.close.top + s.close.bottom) / 2
    expect(Math.abs(titleCenter - closeCenter), '同一行且垂直居中').toBeLessThanOrEqual(1.5)
    expect(s.close.right, '关闭钮收在卡内').toBeLessThanOrEqual(s.panel.right + 0.5)
    expect(s.title.left, '卡名在卡内').toBeGreaterThanOrEqual(s.panel.left)
    // 外层浮窗是拖面（touch-action: none）：设置卡自己必须能滚，否则触屏上六行卡滑不动
    expect(s.touchAction, '设置卡恢复触屏滚动').toBe('auto')
  })

  it('直出型不改行高：没有段内滑杆，底行与章内进度条仍在', async () => {
    const prev = ttsProgress.get()
    ttsProgress.set({ position: 0, duration: 0 })
    try {
      const r = await measure()
      expect(r.mini.height, '直出型仍是 200').toBeCloseTo(200, 0)
      expect(r.miniRanges, '直出型没有段内时间滑杆：浮窗只剩章内一条').toBe(1)
      expect(r.chapterBar, '章内进度条不依赖计时介质').not.toBeNull()
      expect(r.foot, '底行在场').not.toBeNull()
    } finally {
      ttsProgress.set(prev)
    }
  })

  it('最小档 260×162：正文 ≥ 一行、动作钮仍 ≥32，resize 带不压任何控件', async () => {
    miniBarStore.set({ cx: null, cy: null, w: 260, h: 162, collapsed: false })
    const r = await measure()
    miniBarStore.set({ cx: null, cy: null, w: null, h: null, collapsed: false })
    expect(r.mini.width, '最小宽 260').toBeCloseTo(260, 0)
    expect(r.mini.height, '最小高 162').toBeCloseTo(162, 0)
    expect(must(r.body, '正文区').height, '最小档正文 ≥ 一行').toBeGreaterThanOrEqual(20)
    for (const b of r.actButtons) {
      expect.soft(b.height, '最小档动作钮仍 ≥32').toBeGreaterThanOrEqual(32)
    }
    const overlaps = (a: Rect, b: Rect): boolean =>
      a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5
    for (const e of r.edges) {
      for (const c of [...r.buttons, ...r.inputs]) {
        expect(overlaps(e, c), `resize 带 ${e.edge} 压住了控件`).toBe(false)
      }
    }
  })

  it('现场改尺寸即生效；超界夹到 520×420', async () => {
    miniBarStore.set({ cx: null, cy: null, w: 380, h: 280, collapsed: false })
    const r = await measure()
    expect(r.mini.width).toBeCloseTo(380, 0)
    expect(r.mini.height).toBeCloseTo(280, 0)
    miniBarStore.set({ cx: null, cy: null, w: 900, h: 900, collapsed: false })
    const big = await measure()
    miniBarStore.set({ cx: null, cy: null, w: null, h: null, collapsed: false })
    expect(big.mini.width, '宽夹到 520').toBeCloseTo(520, 0)
    expect(big.mini.height, '高夹到 420').toBeCloseTo(420, 0)
  })

  it('视口夹取：500×450 视口下 520×420 呈现为 484×420 且仍在屏内', async () => {
    miniBarStore.set({ cx: null, cy: null, w: 520, h: 420, collapsed: false })
    const r = await measure(true, { width: 500, height: 450 })
    miniBarStore.set({ cx: null, cy: null, w: null, h: null, collapsed: false })
    expect(r.mini.width, '视口−16').toBeCloseTo(484, 0)
    expect(r.mini.height).toBeCloseTo(420, 0)
    expect(r.mini.right, '仍贴右缘').toBeGreaterThanOrEqual(r.viewport.width - 0.5)
    expect(r.mini.left).toBeGreaterThanOrEqual(0)
  })

  it('收起胶囊 208×44：身份 + 段号 + 进度细线，无正文区', async () => {
    miniBarStore.set({ cx: null, cy: null, w: null, h: null, collapsed: true })
    const r = await measure()
    miniBarStore.set({ cx: null, cy: null, w: null, h: null, collapsed: false })
    expect(r.mini.width, '胶囊宽 208').toBeCloseTo(208, 0)
    expect(r.mini.height, '胶囊高 44').toBeCloseTo(44, 0)
    expect(r.mini.right, '胶囊右缘贴合视口').toBeGreaterThanOrEqual(r.viewport.width - 0.5)
    expect(r.mini.left, '整颗在屏内').toBeGreaterThanOrEqual(0)
    expect(r.miniImages, '胶囊不渲染封面图').toBe(0)
    expect(r.body, '胶囊不带正文区').toBeNull()
    expect(r.head, '胶囊没有边栏顶行').toBeNull()
    expect(r.acts, '胶囊没有运输行').toBeNull()
    expect(must(r.ring, '进度环').height, '胶囊环 32').toBeCloseTo(32, 0)
    // 固定宽 208 的两端都要有落点：书名贴左、段号贴右。只贴左会让右边空出一大截
    const title = must(r.miniTitle, '胶囊书名')
    const badge = must(r.miniBadge, '胶囊段号')
    expect(badge.right, '段号贴右：右侧不留大空档').toBeGreaterThanOrEqual(r.mini.right - 16)
    expect(title.right, '书名在段号左侧').toBeLessThanOrEqual(badge.left + 0.5)
    expect(title.left, '书名从进度环右侧起排').toBeGreaterThan(r.mini.left + 32)
  })

  it('贴左缘：左缘贴合视口，整块在屏内', async () => {
    miniBarStore.set({ cx: 160, cy: null, w: null, h: null, collapsed: false })
    const r = await measure()
    miniBarStore.set({ cx: null, cy: null, w: null, h: null, collapsed: false })
    expect(r.mini.left, '左缘贴合视口').toBeLessThanOrEqual(0.5)
    expect(r.mini.right, '整块在屏内').toBeLessThanOrEqual(320 + 1)
  })

  it('自由落位：中心坐标 (640, 400) → 整块居中在 (640, 400)，不贴边', async () => {
    miniBarStore.set({ cx: 640, cy: 400, w: null, h: null, collapsed: false })
    const r = await measure()
    miniBarStore.set({ cx: null, cy: null, w: null, h: null, collapsed: false })
    expect(r.mini.left, '左缘 = 640-160').toBeCloseTo(480, 0)
    expect(r.mini.right, '右缘 = 640+160').toBeCloseTo(800, 0)
    expect(r.mini.top, '上缘 = 400-100').toBeCloseTo(300, 0)
    expect(r.mini.bottom, '下缘 = 400+100').toBeCloseTo(500, 0)
  })

  it('只落过纵向：横向仍贴右缘（缺省轴不被 X 位移推开）', async () => {
    miniBarStore.set({ cx: null, cy: 500, w: null, h: null, collapsed: false })
    const r = await measure()
    miniBarStore.set({ cx: null, cy: null, w: null, h: null, collapsed: false })
    expect(r.mini.right, '右缘仍贴合视口').toBeGreaterThanOrEqual(r.viewport.width - 0.5)
    expect(r.mini.top, '纵向中心落在 500').toBeCloseTo(500 - 100, 0)
  })

  it('浮层底跟宿主浮动钮 token：无 token 落暗底缺省，种上 token 即跟随', async () => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
    await page.setContent(pageHtml())
    const fallback = await page.evaluate(
      `getComputedStyle(document.querySelector('.novel-tts-mini-panel, .novel-tts-mini-capsule')).backgroundColor`,
    )
    expect(fallback, '宿主 token 缺席时落暗底缺省，不是透明').toBe('rgb(43, 43, 46)')
    await page.evaluate(
      `document.body.style.setProperty('--dsw-alias-button-floating-fill', '#ffffff')`,
    )
    const followed = await page.evaluate(
      `getComputedStyle(document.querySelector('.novel-tts-mini-panel, .novel-tts-mini-capsule')).backgroundColor`,
    )
    expect(followed, '宿主换浮层底即跟随（光态不再钉死暗底）').toBe('rgb(255, 255, 255)')
    await page.context().close()
  })

  it('听书条只留一条进度：章内滑杆吃满整行，本段滑杆不再渲染', async () => {
    const r = await measure()
    expect(r.chapterRange.width, '章内滑杆独占整行').toBeGreaterThan(r.bar.width - 48)
    expect(r.ranges, '条上只剩章内一条进度滑杆（ADR-0075）').toBe(1)
  })

  it('跟读高亮：换命中块字色 + 段首三角（无底色、无进度线），不改布局；滚动条走宿主档', async () => {
    const r = await measure()
    expect(r.liveColor, '命中段与素段的字色不同（ADR-0076）').not.toBe(r.plainColor)
    expect(r.liveBackground, '不加底色').toBe(r.plainBackground)
    expect(r.liveDescendants, '高亮段内不画进度线（0 个子元素）').toBe(0)
    // 纯换色在「正文与高亮同侧且都够读」的纸上感知差太小——字形标记是第二条腿，必须真画出来
    expect(must(r.marker, '段首三角画出来了（::before absolute + 实心 border-left）').width, '三角有宽').toBeGreaterThan(0)
    expect(r.markerColor, '三角跟着 currentColor 走（与 --novel-live-ink 同源）').toBe(r.liveColor)
    // 关掉高亮再量一遍：逐段几何必须一致——只换颜色 + 框外伪元素，不动盒模型（ADR-0071）
    const off = await measure(false)
    expect(r.paragraphs, '高亮进出不改布局').toEqual(off.paragraphs)
    expect(off.marker, '不在听的段没有三角').toBeNull()
    expect(r.scrollerScrollbarWidth, '滚动容器自己是 thin 档（不靠继承）').toBe('thin')
    expect(r.scrollerScrollbarColor, 'thumb / 轨读宿主滚动条 token 的缺省').toContain('0.18')
  })
})