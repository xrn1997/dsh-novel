/**
 * 源列表尾三轨的几何门（`DSH_BROWSER_GATE=1` 打开，旧名 `DSH_EPUB_BROWSER` 仍认；默认整门跳过，
 * `pnpm test` 不跑它）。jsdom 量不到排版，而这条 bug 只在真排版下现形：每个 `.novel-tr` 是独立
 * grid，`auto` 轨按各自内容算宽——表头是文字、表体是控件，宽度天然不同，尾列就会表头/表体错位
 * （修复前实测：操作列 25.5px，2026-11）。故读数取真浏览器的 rect：操作与启停按右缘、AI 列按
 * 中心（方形勾与表头都居中），列内读数差 ≤0.5px；定宽轨的取值口径归
 * `src/client/styles/controls.ts` 的 `.novel-tr.src`。
 *
 * 组件与样式都是**现物**：markup 由 `renderToStaticMarkup(SourceList)` 出，CSS 用发布用的
 * `NOVEL_CSS` 那一份——不在这里手抄类名结构，抄来的形状只会绿给自己看。不起服务、不读站点。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Browser } from 'playwright'
import type { SourcePublic } from '../../src/client/views/types.js'
import { SourceList } from '../../src/client/views/SettingsSourceList.js'
import { NOVEL_CSS } from '../../src/client/styles.js'
import { makeDeps } from '../client/fake-deps.js'
import { pick } from '../support/fixture.js'
import { BROWSER_GATE_ENABLED } from '../support/browser-gate.js'
import { launchBrowser } from './epub-host.js'

const ENABLED = BROWSER_GATE_ENABLED

/** 两行真实形状：一行全亮（AI 勾着、长名分组都有），一行停用 + 坏源——尾三格的内容各不相同，
 *  「行间也不许漂移」才有得量。 */
const src = (over: Partial<SourcePublic> & { id: string; name: string }): SourcePublic => ({
  baseUrl: `https://${over.id}.com`, enabled: true, aiSearch: false, groups: [],
  type: 'text', status: 'verified', importedAt: 0, hasHeader: false, hasAuth: false, authExpired: false, hasLoginUrl: false,
  ...over,
})
const ROWS: SourcePublic[] = [
  src({ id: 'a', name: '源A', aiSearch: true, groups: ['小说'] }),
  src({ id: 'b', name: '源B名字比较长一点', enabled: false, status: 'broken' }),
]

/** 一次量到的读数：操作/启停取右缘，AI 取中心（表头格与行内勾都居中） */
interface TailRects {
  head: { actions: number; ai: number; enabled: number }
  rows: Array<{ actions: number; ai: number; enabled: number }>
}

const probe = `(() => {
  const num = (v) => (typeof v === 'number' ? v : -1)
  const right = (el) => num(el.getBoundingClientRect().right)
  const center = (el) => { const r = el.getBoundingClientRect(); return num((r.left + r.right) / 2) }
  const head = document.querySelector('.novel-tr.src.head')
  const rows = [...document.querySelectorAll('.novel-tr.src')].filter((r) => !r.classList.contains('head'))
  const cells = head.children
  return JSON.stringify({
    head: { actions: right(cells[4]), ai: center(cells[5]), enabled: right(cells[6]) },
    rows: rows.map((r) => ({
      actions: right(r.querySelector('.novel-actions button')),
      ai: center(r.querySelector('[data-novel-ai-toggle]')),
      enabled: right(r.querySelector('.novel-switch')),
    })),
  })
})()`

describe.skipIf(!ENABLED)('浏览器几何：源列表尾三轨的表头/表体对齐（AI 列判中心）', () => {
  let browser: Browser

  beforeAll(async () => { browser = await launchBrowser() }, 90_000)
  // 四道浏览器门并行时，冷启动的 Chromium 收尾可超过缺省 10s 钩子时限：只延这一颗，判据不动
  afterAll(async () => { await browser.close() }, 90_000)

  async function measure(width: number): Promise<TailRects> {
    const markup = renderToStaticMarkup(
      <SourceList sources={ROWS} job={null} onChanged={() => {}} onProbe={() => {}} onImport={() => {}} deps={makeDeps()} />,
    )
    const page = await (await browser.newContext({ viewport: { width, height: 900 } })).newPage()
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>${NOVEL_CSS}</style></head>` +
      `<body><div class="novel-root"><div data-novel-scope>${markup}</div></div></body></html>`,
    )
    const out = JSON.parse(await page.evaluate(probe)) as TailRects
    await page.context().close()
    return out
  }

  /** 逐列判：操作/启停按右缘、AI 按中心（差 0.5px 内算同一条线）；行与行之间同判。 */
  function expectTailAligned(m: TailRects): void {
    expect(m.rows.length, '两行都在场').toBe(2)
    for (const key of ['actions', 'enabled'] as const) {
      for (const [i, r] of m.rows.entries()) {
        expect.soft(Math.abs(r[key] - m.head[key]), `第 ${i} 行 ${key} 列：表头与表体右缘错位 ${r[key] - m.head[key]}px`)
          .toBeLessThanOrEqual(0.5)
      }
      expect.soft(Math.abs(pick(m.rows, 1)[key] - pick(m.rows, 0)[key]), `${key} 列：行与行右缘错位`).toBeLessThanOrEqual(0.5)
    }
    for (const [i, r] of m.rows.entries()) {
      expect.soft(Math.abs(r.ai - m.head.ai), `第 ${i} 行 AI 列：表头与勾的中心错位 ${r.ai - m.head.ai}px`)
        .toBeLessThanOrEqual(0.5)
    }
    expect.soft(Math.abs(pick(m.rows, 1).ai - pick(m.rows, 0).ai), 'AI 列：行与行中心错位').toBeLessThanOrEqual(0.5)
  }

  it('宽档：操作/启停右缘、AI 中心逐列对齐', async () => {
    expectTailAligned(await measure(1200))
  })

  it('窄档（容器查询收掉地址列后）：同判据——列轨数变了，对齐义务不变', async () => {
    expectTailAligned(await measure(500))
  })
})
