// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Browser } from 'playwright'
import { NovelConfigCardView } from '../../src/client/config-page.js'
import { launchBrowser } from './epub-host.js'

/**
 * 配置页几何门（`DSH_EPUB_BROWSER=1` 打开；默认整门跳过，`pnpm test` 不跑它）。
 *
 * 为什么这道门非开不可：这一页的行是本仓自绘的，「单位落在框内」「数字框不再全幅」
 * 两句话在 jsdom 里都只是**字符串在场**——它量不到后缀有没有真的压在数字上、框有没有
 * 被 200px 轨限住。而那两条正是这次重做的全部主张。
 *
 * markup 由 `renderToStaticMarkup(NovelConfigCardView)` 出，CSS 是发布用的那一份
 * （组件自带 `<NovelStyles/>`，不在这里手抄样式）。**宿主壳不在这台的可及范围**：
 * `SettingsForm` 走的是 vitest alias 指到的替身，所以本门只量本仓画的行，不替宿主的
 * 保存条说话。不起服务、不读站点。
 */

const ENABLED = process.env.DSH_EPUB_BROWSER === '1'

const ok = { text: '5', overridden: false, invalid: false }
/** 截图里那一屏的真值：209715200 与 52428800 是出厂缺省，正是要被读成人话的那两个数。 */
const state = {
  available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false,
  searchTimeoutMs: { text: '15000', overridden: false, invalid: false },
  searchParallel: ok,
  jsTimeoutMs: { text: '15000', overridden: false, invalid: false },
  exportDelayMs: { text: '300', overridden: false, invalid: false },
  cacheMaxBytes: { text: '209715200', overridden: false, invalid: false },
  localImportMaxBytes: { text: '52428800', overridden: true, invalid: false },
  proxyUrl: { text: 'http://127.0.0.1:7897', overridden: false, invalid: false },
}
const actions = { save: () => {}, discard: () => {}, edit: () => {}, resetField: () => {} }

interface Rect { left: number; right: number; top: number; width: number; height: number }
interface RowRead {
  name: string
  input: Rect
  unit: Rect | null
  padRight: number
  rowScroll: number
  rowClient: number
  cardRight: number
  read: string | null
}
interface Read { rows: RowRead[]; groups: Rect[]; chips: Array<Rect & { label: string }> }

const probe = `(() => {
  const rect = (el) => { const b = el.getBoundingClientRect()
    return { left: b.left, right: b.right, top: b.top, width: b.width, height: b.height } }
  const rows = [...document.querySelectorAll('.novel-cfg-row')].map((row) => {
    const input = row.querySelector('input')
    const unit = row.querySelector('.novel-cfg-unit')
    return {
      name: input.id.replace('novel-config-', ''),
      input: rect(input),
      unit: unit === null ? null : rect(unit),
      padRight: parseFloat(getComputedStyle(input).paddingRight),
      rowScroll: row.scrollWidth, rowClient: row.clientWidth,
      cardRight: rect(row.closest('.novel-cfg-group')).right,
      read: row.querySelector('.novel-cfg-read')?.textContent ?? null,
    }
  })
  return JSON.stringify({
    rows,
    groups: [...document.querySelectorAll('.novel-cfg-group')].map(rect),
    chips: [...document.querySelectorAll('.novel-cfg-preset')].map((c) => ({ label: c.textContent, ...rect(c) })),
  })
})()`

describe.skipIf(!ENABLED)('浏览器几何：插件页「运行参数」自绘的行', () => {
  let browser: Browser

  beforeAll(async () => { browser = await launchBrowser() }, 90_000)
  afterAll(async () => { await browser?.close() })

  /** 在给定容器宽度下量一次：配置页的退档按 `.novel-cfg` 自身宽度判定，所以限宽即限档。 */
  async function measure(px: number): Promise<Read> {
    const markup = renderToStaticMarkup(
      <NovelConfigCardView state={state as never} actions={actions as never} />,
    )
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
    await page.setContent(
      '<!doctype html><html><head><meta charset="utf-8"></head><body>'
      + `<div style="width:${px}px;margin:0 auto">${markup}</div></body></html>`,
    )
    const out = JSON.parse(await page.evaluate(probe)) as Read
    await page.context().close()
    return out
  }

  const row = (r: Read, name: string): RowRead => r.rows.find((x) => x.name === name)!

  it('宽档：单位在框内、数字框被限宽、回读成人话', async () => {
    const r = await measure(1000)
    expect(r.rows.length).toBe(7)

    for (const x of r.rows) {
      expect.soft(x.rowScroll, `${x.name} 这一行横向溢出 ${x.rowScroll - x.rowClient}px`)
        .toBeLessThanOrEqual(x.rowClient)
      if (x.unit === null) continue
      expect.soft(x.unit.right, `${x.name} 的单位后缀不许越过输入框右缘`).toBeLessThanOrEqual(x.input.right + 0.5)
      expect.soft(x.unit.left, `${x.name} 的单位后缀必须在框内`).toBeGreaterThanOrEqual(x.input.left)
      expect.soft(x.unit.top, `${x.name} 的单位后缀必须落在框的垂直范围内`)
        .toBeGreaterThanOrEqual(x.input.top - 0.5)
      // 内容区右界（= 框右缘 - 右内边距）必须在单位左缘之前：否则长数字会压在后缀底下
      expect.soft(x.input.right - x.padRight, `${x.name} 没给单位让出内边距`)
        .toBeLessThanOrEqual(x.unit.left)
    }

    const cache = row(r, 'cacheMaxBytes')
    expect.soft(cache.input.width, '数字框被 200px 轨限住，不再全幅').toBeLessThanOrEqual(220)
    expect.soft(cache.input.width, '但也不许窄到装不下九位数').toBeGreaterThanOrEqual(120)
    expect(cache.read, '209715200 要读得出 200 MB').toBe('200 MB')
    expect(row(r, 'localImportMaxBytes').read).toBe('50 MB')
    expect(row(r, 'searchTimeoutMs').read).toBe('15 秒')
    expect(row(r, 'exportDelayMs').read).toBe('300 毫秒')
    expect(row(r, 'proxyUrl').read, '文本位没有换算可给').toBeNull()

    // 分区在宽档并排成列：四个区叠成一列等于没有分区
    expect(row(r, 'searchParallel').cardRight).toBe(row(r, 'searchTimeoutMs').cardRight)
    expect(r.groups[1].top, '宽档下第 2 区应与第 1 区并排').toBe(r.groups[0].top)

    // 预设档是这一页省掉手敲的那只手：点得到（在卡片内）且够高（拇指/触屏）
    expect(r.chips.length).toBe(8)
    for (const c of r.chips) {
      expect.soft(c.height, `预设档「${c.label}」太矮，点不准`).toBeGreaterThanOrEqual(22)
      expect.soft(c.right, `预设档「${c.label}」不许越出卡片右边界`).toBeLessThanOrEqual(cache.cardRight + 0.5)
    }
  })

  it('窄档：行折成单列，回读与单位都还在，且谁都不溢出', async () => {
    const r = await measure(420)
    expect(r.groups[1].top, '窄档下四区应叠成一列').toBeGreaterThan(r.groups[0].top)
    for (const x of r.rows) {
      expect.soft(x.rowScroll, `${x.name} 在窄档溢出 ${x.rowScroll - x.rowClient}px`)
        .toBeLessThanOrEqual(x.rowClient)
      expect.soft(x.input.width, `${x.name} 在窄档被压扁`).toBeGreaterThanOrEqual(120)
      if (x.unit !== null) {
        expect(x.unit.right, `${x.name} 的单位后缀在窄档跑出框外`).toBeLessThanOrEqual(x.input.right + 0.5)
      }
    }
    expect(row(r, 'cacheMaxBytes').read).toBe('200 MB')
  })
})
