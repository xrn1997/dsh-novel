/**
 * 引擎编辑抽屉的几何门（`DSH_BROWSER_GATE=1` 打开；默认整门跳过，`pnpm test` 不跑它）。
 * jsdom 量不到排版，而这条问题的形态只有真排版才现形：400px 确认框装数据表单时，长 URL 被
 * 单行 input 截断、JSON / 代码 textarea 挤成一条缝、登录态三格落在滚动区外看不见；铺满 680px
 * 宽档又会让输入框过长、贴到滚动条上。这里量 520px 表单档的几何与滚动条留缝。
 * 组件与样式都是**现物**：markup 由 `renderToStaticMarkup(EngineEditDialog)` 出，CSS 用发布用的
 * `NOVEL_CSS` 那一份——不在这里手抄类名结构。不起服务、不读站点。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Browser } from 'playwright'
import type { TtsEnginePublic } from '../../src/shared/wire.js'
import { EngineEditDialog } from '../../src/client/tts/EngineEditDialog.js'
import { NOVEL_CSS } from '../../src/client/styles.js'
import { BROWSER_GATE_ENABLED } from '../support/browser-gate.js'
import { must } from '../support/fixture.js'
import { launchBrowser } from './epub-host.js'

const ENABLED = BROWSER_GATE_ENABLED

/** 真实形状：长 URL、请求头与 JS 库都有值、且已保存登录态 */
const engine: TtsEnginePublic = {
  id: '1636018619114',
  name: '思必驰温柔',
  url: 'https://dds.dui.ai/runtime/v1/synthesize?voiceId=gqlanfp&text={{java.encodeURI(java.encodeURI(speakText))}}&speed=1&volume=100&audioType=wav',
  contentType: 'audio/mpeg',
  header: '{\n  "Authorization": "Bearer sk-xxxxxxxxxxxxxxxx",\n  "User-Agent": "Mozilla/5.0"\n}',
  jsLib: 'function sign(t) {\n  // 注释一行\n  return java.md5Encode(t)\n}',
  lastUpdateTime: 1,
  hasAuth: true,
}

interface Rect { x: number; y: number; w: number; h: number; bottom: number; right: number }
interface Metrics {
  viewport: { w: number; h: number }
  formStyle: { scrollbarGutter: string; paddingRight: number }
  modal: Rect
  form: Rect
  actions: Rect
  toggles: Array<{ text: string; expanded: string | null; rect: Rect }>
  fields: Rect[]
  areas: Array<Rect & { cw: number; sw: number; rows: number }>
  inputs: Array<Rect & { cw: number; sw: number }>
  docOverflowX: boolean
  modalOutOfViewport: boolean
}

const PROBE = `(() => {
  const r = (el) => {
    const b = el.getBoundingClientRect()
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom), right: Math.round(b.right) }
  }
  const modal = document.querySelector('.novel-modal')
  const form = document.querySelector('.novel-tts-edit-form')
  const mr = r(modal)
  const fs = getComputedStyle(form)
  return JSON.stringify({
    formStyle: { scrollbarGutter: fs.scrollbarGutter, paddingRight: parseFloat(fs.paddingRight) || 0 },
    viewport: { w: innerWidth, h: innerHeight },
    modal: mr,
    form: r(form),
    actions: r(document.querySelector('.novel-modal-actions')),
    toggles: [...document.querySelectorAll('.novel-tts-edit-group-toggle')].map((b) => ({ text: b.textContent, expanded: b.getAttribute('aria-expanded'), rect: r(b) })),
    fields: [...document.querySelectorAll('.novel-tts-edit-field')].map((f) => r(f)),
    areas: [...document.querySelectorAll('.novel-textarea')].map((a) => ({ ...r(a), cw: a.clientWidth, sw: a.scrollWidth, rows: a.rows })),
    inputs: [...document.querySelectorAll('.novel-input')].map((i) => ({ ...r(i), cw: i.clientWidth, sw: i.scrollWidth })),
    docOverflowX: document.documentElement.scrollWidth > innerWidth,
    modalOutOfViewport: mr.y < 0 || mr.bottom > innerHeight,
  })
})()`

describe.skipIf(!ENABLED)('浏览器几何：引擎编辑抽屉', () => {
  let browser: Browser

  beforeAll(async () => { browser = await launchBrowser() }, 90_000)
  afterAll(async () => { await browser.close() }, 90_000)

  async function measure(viewport: { width: number; height: number }): Promise<Metrics> {
    const markup = renderToStaticMarkup(
      <EngineEditDialog engine={engine} onClose={() => {}} onSaved={() => {}} />,
    )
    const page = await (await browser.newContext({ viewport })).newPage()
    // 模态有入场动效（scale .98 起步）：关掉动效再量，否则 rect 取在动画中，读数随时刻漂
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.setContent(
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${NOVEL_CSS}</style></head>` +
      `<body><div class="novel-root" data-novel-view="settings">${markup}</div></body></html>`,
    )
    const out = JSON.parse(await page.evaluate(PROBE)) as Metrics
    await page.context().close()
    return out
  }

  /** 一起量：不越界、可换行不裁字；宽档下限只在桌面档给（窄档由视口夹住）。 */
  function expectFits(m: Metrics, minWidth = 0): void {
    expect.soft(m.docOverflowX, '页面不得出现横向溢出').toBe(false)
    expect.soft(m.modalOutOfViewport, '模态整块在视口内（底部动作行不许被挤出屏幕）').toBe(false)
    if (minWidth > 0) {
      expect.soft(m.modal.w, '数据表单走宽档：400px 确认框装不下长 URL 与 JSON').toBeGreaterThanOrEqual(minWidth)
    }
    expect.soft(m.form.w, '表单铺满表单档').toBeGreaterThanOrEqual(m.modal.w - 64)
    expect.soft(m.formStyle.scrollbarGutter, '滚动条出现前预留槽位，展开组不挤动布局、输入框不贴滚动条').toBe('stable')
    expect.soft(m.formStyle.paddingRight, '表单右缘留呼吸，输入框不贴滚动条').toBeGreaterThanOrEqual(4)
    // 每一格都不许越过表单右缘；URL / JSON / 代码走换行，不许横向被裁
    for (const field of m.fields) {
      expect.soft(field.right, '字段越过表单右缘').toBeLessThanOrEqual(m.form.right + 1)
    }
    for (const area of [...m.areas, ...m.inputs]) {
      expect.soft(area.right, '输入件越过表单右缘').toBeLessThanOrEqual(m.form.right + 1)
      expect.soft(area.sw, `输入件横向溢出 ${area.sw - area.cw}px（长规则被截）`).toBeLessThanOrEqual(area.cw + 1)
    }
    expect.soft(m.actions.bottom, '动作行不许越过模态底边').toBeLessThanOrEqual(m.modal.bottom)
  }

  it('桌面档：520px 表单档，长 URL 与 JSON 换行不裁，动作行在视口内', async () => {
    const m = await measure({ width: 1000, height: 800 })
    expectFits(m, 480)
    expect(m.modal.w, '表单档 520px：比 400px 确认框宽、比 680px 宽档窄').toBeLessThanOrEqual(560)
    // 常用两格常显，两组默认收起且组内字段不渲染（首屏只放常用位）
    expect(m.fields, '收起态只有名称与接口地址两格').toHaveLength(2)
    expect(m.toggles.map((t) => t.expanded)).toEqual(['false', 'false'])
    expect(must(m.toggles[0], '高级组标题').text).toContain('已填 3 项')
    expect(must(m.toggles[1], '登录态组标题').text).toContain('已配置登录态')
    expect(must(m.areas[0], '接口地址 textarea').rows).toBe(3)
  })

  it('窄档：模态宽度夹在视口内，长 URL 仍换行，动作行仍可点', async () => {
    const m = await measure({ width: 420, height: 800 })
    expectFits(m)
    expect(m.modal.w).toBeLessThanOrEqual(420 - 48 + 1)
    expect(m.modal.x).toBeGreaterThanOrEqual(0)
    expect(m.actions.bottom).toBeLessThanOrEqual(800)
  })
})