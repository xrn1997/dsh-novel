// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Browser } from 'playwright'
import { NovelConfigPageView } from '../../src/client/config-page.js'
import { zhTranslate } from '../../src/client/copy/index.js'
import { must, pick } from '../support/fixture.js'
import { BROWSER_GATE_ENABLED } from '../support/browser-gate.js'
import { launchBrowser } from './epub-host.js'

/**
 * 配置页几何门（`DSH_BROWSER_GATE=1` 打开，旧名 `DSH_EPUB_BROWSER` 仍认；默认整门跳过，`pnpm test` 不跑它）。
 *
 * 为什么这道门非开不可：这一页的行是本仓自绘的，几条主张在 jsdom 里都只是**字符串在场**——
 *   · 每个字段只有一条 30px 的框，单位与回读在框内（不占第二行、不跑到框右）；
 *   · 两列配对、行行同轴，最后一个单数字段占整行（不留半格空位）；
 *   · 说明挂在标签后的问号上、默认 `display:none`，悬浮才浮出来——不参与布局，行高不变；
 *   · 工具条贴卡片顶边、保存条贴卡片底边——保存钮只在列表末尾的话，长列表就得滚回去找它。
 *
 * markup 由 `renderToStaticMarkup(NovelConfigPageView)` 出，CSS 是发布用的那一份
 * （组件自带 `<NovelStyles/>`，不在这里手抄样式）。不起服务、不读站点。
 */

const ENABLED = BROWSER_GATE_ENABLED

const ok = { text: '5', overridden: false, invalid: false, dirty: false }
/** 截图里那一屏的真值：209715200 与 52428800 是出厂缺省，正是要被读成人话的那两个数。 */
const fields = {
  searchTimeoutMs: { text: '15000', overridden: false, invalid: false, dirty: false },
  searchParallel: ok,
  jsTimeoutMs: { text: '15000', overridden: false, invalid: false, dirty: false },
  exportDelayMs: { text: '300', overridden: false, invalid: false, dirty: false },
  cacheMaxBytes: { text: '209715200', overridden: false, invalid: false, dirty: false },
  localImportMaxBytes: { text: '52428800', overridden: true, invalid: false, dirty: false },
  proxyUrl: { text: 'http://127.0.0.1:7897', overridden: false, invalid: false, dirty: false },
  ttsDefaultEngine: { text: 'builtin:baidu', overridden: false, invalid: false, dirty: false },
  ttsDefaultRate: { text: '1.2', overridden: false, invalid: false, dirty: false },
  ttsDefaultVolume: { text: '0.8', overridden: false, invalid: false, dirty: false },
  ttsCacheMaxBytes: { text: '134217728', overridden: false, invalid: false, dirty: false },
  ttsPrefetchParagraphs: { text: '10', overridden: false, invalid: false, dirty: false },
}
const actions = { onEdit: () => {}, onReset: () => {}, onSave: () => {}, onDiscard: () => {} }

interface Rect { left: number; right: number; top: number; width: number; height: number }
interface RowRead {
  name: string
  row: Rect
  input: Rect
  label: Rect
  field: Rect
  unit: Rect | null
  read: Rect | null
  preset: Rect | null
  tip: Rect | null
  bubble: Rect | null
  bubbleShown: boolean
  rowScroll: number
  rowClient: number
}
interface Read {
  rows: RowRead[]
  groups: Rect[]
  toolbar: Rect
  savebar: Rect
  card: Rect
}

const probe = `(() => {
  const rect = (el) => { const b = el.getBoundingClientRect()
    return { left: b.left, right: b.right, top: b.top, width: b.width, height: b.height } }
  const maybe = (el) => el === null ? null : rect(el)
  const rows = [...document.querySelectorAll('.novel-cfg-row')].map((row) => {
    const input = row.querySelector('input')
    const bubble = row.querySelector('.novel-cfg-bubble')
    return {
      name: input.id.replace('novel-config-', ''),
      row: rect(row),
      input: rect(input),
      label: rect(row.querySelector('.novel-cfg-label')),
      field: rect(row.querySelector('.novel-cfg-field')),
      unit: maybe(row.querySelector('.novel-cfg-unit')),
      read: maybe(row.querySelector('.novel-cfg-read')),
      preset: maybe(row.querySelector('.novel-cfg-preset')),
      tip: maybe(row.querySelector('.novel-cfg-q')),
      bubble: bubble === null ? null : rect(bubble),
      bubbleShown: bubble !== null && getComputedStyle(bubble).display !== 'none',
      rowScroll: row.scrollWidth, rowClient: row.clientWidth,
    }
  })
  return JSON.stringify({
    rows,
    groups: [...document.querySelectorAll('.novel-cfg-group')].map(rect),
    toolbar: rect(document.querySelector('.novel-cfg-toolbar')),
    savebar: rect(document.querySelector('.novel-cfg-savebar')),
    card: rect(document.querySelector('.novel-cfg-card')),
  })
})()`

describe.skipIf(!ENABLED)('浏览器几何：插件页「运行参数」的行与工具条', () => {
  let browser: Browser

  beforeAll(async () => { browser = await launchBrowser() }, 90_000)
  // 四道浏览器门并行时，冷启动的 Chromium 收尾可超过缺省 10s 钩子时限：只延这一颗，判据不动
  afterAll(async () => { await browser.close() }, 90_000)

  /** 在给定容器宽度下量一次：配置页的退档按 `.novel-cfg` 自身宽度判定，所以限宽即限档。 */
  async function measure(px: number, hoverTip = false): Promise<Read> {
    const markup = renderToStaticMarkup(
      <NovelConfigPageView
        t={zhTranslate}
        writable
        fields={fields}
        dirty={false}
        invalid={false}
        saving={false}
        failure={null}
        {...actions}
      />,
    )
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
    await page.setContent(
      '<!doctype html><html><head><meta charset="utf-8"></head><body>'
      + `<div style="width:${px}px;margin:0 auto">${markup}</div></body></html>`,
    )
    if (hoverTip) await page.locator('.novel-cfg-q').first().hover()
    const out = JSON.parse(await page.evaluate(probe)) as Read
    await page.context().close()
    return out
  }

  const row = (r: Read, name: string): RowRead => must(r.rows.find((x) => x.name === name), `行「${name}」`)
  /** 输入框左缘的取值集合：两列配对时应当恰好两个（每列一个）。 */
  const fieldLefts = (r: Read): number[] => [...new Set(r.rows.map((x) => Math.round(x.field.left)))].sort((a, b) => a - b)

  it('宽档：一条框装下值 + 单位 + 回读，两列配对且说明默认收起', async () => {
    const r = await measure(1000)
    expect(r.rows.length).toBe(12)

    for (const x of r.rows) {
      expect.soft(x.rowScroll, `${x.name} 这一行横向溢出 ${x.rowScroll - x.rowClient}px`)
        .toBeLessThanOrEqual(x.rowClient)
      // 值、单位、回读、预设钮全在同一条框内：不越出框右缘，也不压住户（input 的右缘之前）
      for (const [what, part] of [['单位', x.unit], ['回读', x.read], ['预设钮', x.preset]] as const) {
        if (part === null) continue
        expect.soft(part.right, `${x.name} 的${what}跑出了框外`).toBeLessThanOrEqual(x.field.right + 0.5)
        expect.soft(part.left, `${x.name} 的${what}压在输入区里`).toBeGreaterThanOrEqual(x.input.right - 0.5)
        expect.soft(part.top, `${x.name} 的${what}不在框的垂直范围内`).toBeGreaterThanOrEqual(x.field.top - 0.5)
        expect.soft(part.top + part.height, `${x.name} 的${what}不在框的垂直范围内`)
          .toBeLessThanOrEqual(x.field.top + x.field.height + 0.5)
      }
      // 说明挂在问号上：每行都有问号，默认不收任何一行的气泡（已覆盖的行也一样）
      expect.soft(x.tip, `${x.name} 没有说明入口（问号）`).not.toBeNull()
      expect.soft(x.bubbleShown, `${x.name} 的说明气泡默认是展开的`).toBe(false)
    }

    // 两列配对：输入框左缘恰好两个位置，且每一列内部同轴
    const lefts = fieldLefts(r)
    expect(lefts.length, `两列配对应当只有两个输入轨左缘，实测 ${lefts.join(' / ')}`).toBe(2)
    const leftCol = r.rows.filter((x) => Math.round(x.field.left) === pick(lefts, 0))
    const rightCol = r.rows.filter((x) => Math.round(x.field.left) === pick(lefts, 1))
    expect(leftCol.length + rightCol.length).toBe(12)
    for (const x of r.rows) {
      const expected = Math.round(x.field.left) === pick(lefts, 0) ? pick(lefts, 0) : pick(lefts, 1)
      expect.soft(Math.round(x.field.left), `${x.name} 的输入框没落在列轨道上`).toBe(expected)
    }
    // 最后一个单数字段（朗读预取段数）占整行：它的框比半列宽得多
    const last = row(r, 'ttsPrefetchParagraphs')
    expect.soft(last.field.width, '单数字段占整行，右侧不留半格空位').toBeGreaterThan(pick(lefts, 1) - pick(lefts, 0))

    // 12 行等高：说明不进布局，任何一行都不该比别的行高（行高差超过 1px 就是有东西在撑）
    const heights = r.rows.map((x) => Math.round(x.row.height))
    expect(Math.max(...heights) - Math.min(...heights), `行高不一致：${heights.join(' / ')}`).toBeLessThanOrEqual(1)

    // 卡片的上下两条常驻件：工具条在列表之上，保存条在列表之下（且都在卡片内）
    expect(r.toolbar.top, '工具条不在卡片顶部').toBeLessThan(row(r, 'searchTimeoutMs').field.top)
    expect(r.savebar.top, '保存条不在列表末尾').toBeGreaterThan(row(r, 'ttsPrefetchParagraphs').field.top)
    for (const part of [r.toolbar, r.savebar]) {
      expect.soft(part.left, '常驻件越出卡片左缘').toBeGreaterThanOrEqual(r.card.left - 0.5)
      expect.soft(part.right, '常驻件越出卡片右缘').toBeLessThanOrEqual(r.card.right + 0.5)
    }
  })

  it('说明气泡：悬浮问号才出现，且不改变任何一行的高度', async () => {
    const before = await measure(1000)
    const after = await measure(1000, true)
    const shown = after.rows.filter((x) => x.bubbleShown)
    expect(shown.length, '悬浮一行只该浮出一枚气泡').toBe(1)
    const hovered = must(shown[0], '悬浮行的气泡')
    expect(hovered.bubble, '气泡没有可量的位置').not.toBeNull()
    const bubble = must(hovered.bubble, '气泡')
    // 气泡在卡片内、盖在下方内容上（absolute），而不是把行撑开
    expect(bubble.left, '气泡越出卡片左缘').toBeGreaterThanOrEqual(after.card.left - 0.5)
    expect(bubble.right, '气泡越出卡片右缘').toBeLessThanOrEqual(after.card.right + 0.5)
    expect(bubble.top, '气泡没落在问号下方').toBeGreaterThanOrEqual(hovered.row.top)
    for (const x of before.rows) {
      const same = after.rows.find((y) => y.name === x.name)
      expect.soft(same?.row.height, `悬浮气泡后 ${x.name} 的行高变了（说明又挤进布局了）`)
        .toBeCloseTo(x.row.height, 1)
    }
  })

  it('窄档：两列折成一列，标签在上、输入在下，且谁都不溢出', async () => {
    const r = await measure(420)
    expect(fieldLefts(r).length, '窄档只剩一列').toBe(1)
    for (const x of r.rows) {
      expect.soft(x.label.top, `${x.name} 在窄档没有折到输入上面`).toBeLessThanOrEqual(x.field.top)
      expect.soft(x.rowScroll, `${x.name} 在窄档溢出 ${x.rowScroll - x.rowClient}px`)
        .toBeLessThanOrEqual(x.rowClient)
      expect.soft(x.input.width, `${x.name} 在窄档被压扁`).toBeGreaterThanOrEqual(120)
      if (x.unit !== null) {
        expect(x.unit.right, `${x.name} 的单位后缀在窄档跑出框外`).toBeLessThanOrEqual(x.field.right + 0.5)
      }
    }
    expect(row(r, 'cacheMaxBytes').read?.left ?? 0).not.toBe(0)
  })
})