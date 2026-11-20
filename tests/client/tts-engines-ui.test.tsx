// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  BROWSER_TTS_ENGINE_ID, CORDIS_TTS_ENGINE_ID, TTS_DEFAULTS, bodies, paramOps, ROUTES,
} from '../../src/shared/wire.js'
import type {
  HostSpeechHealth, TtsEngineImportReceipt, RouteTarget, TtsEngineInput, TtsEnginePublic, TtsSourceInfo, WriteMethod,
} from '../../src/shared/wire.js'
import { apiGet, apiSend } from '../../src/client/api.js'
import { apply } from '../../src/client/index.js'
import { engineKindOf, engineLabelOf } from '../../src/client/tts/engine-rows.js'
import { EngineManager } from '../../src/client/tts/EngineManager.js'
import { NovelConfigPageView } from '../../src/client/config-page.js'
import { zhTranslate } from '../../src/client/copy/index.js'
import { must, pick } from '../support/fixture.js'
import type { Registration } from './fake-host.js'
import { fakeCtx, fakeHost, fakeRemoteSettings } from './fake-host.js'

/**
 * 配置卡「引擎管理」区：源清单四kind、导入两路（一次只走一条）、导出剥凭据、
 * 注册表引擎的编辑/删除与确认模态、失败可见（清单 503 不冒充空列表）。
 *
 * 接线以 `/novel-api` 的 mock 面钉：`apiGet` 两条读口（源清单 + 引擎投影）与
 * `apiSend` 三条写口（导入 / PUT / DELETE）都是同源读数；组件自己的现场不外泄。
 */
vi.mock('../../src/client/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/client/api.js')>()
  // 只替换两个网络动词：`describeError` 等真实现留给客户端自己的接线（草稿与错误原文同口径）；
  // 其余导出（事件流）也必须是真身——`apply` 的依赖表在模块加载时就要把它们取齐。
  return { ...actual, apiGet: vi.fn(), apiSend: vi.fn() }
})

const builtin: TtsSourceInfo = { id: 'builtin:baidu', kind: 'builtin' }
const browser: TtsSourceInfo = { id: 'browser:local', kind: 'browser' }

function httpEngine(over: Partial<TtsEnginePublic> = {}): TtsEnginePublic {
  return {
    id: 'http:edge',
    name: '微软 Edge 大声朗读',
    url: 'https://edge.example/tts',
    contentType: 'audio/mpeg',
    header: 'X-Static: 1',
    lastUpdateTime: 1,
    hasAuth: true,
    ...over,
  }
}

function httpSource(engine: TtsEnginePublic): TtsSourceInfo {
  return { id: engine.id, name: engine.name, kind: 'http' }
}

/** 没有订阅高级位（内容类型 / 静态请求头 / JS 库）的引擎：用来钉「高级组默认收起」。 */
function httpEngineWithoutAdvanced(over: Partial<TtsEnginePublic> = {}): TtsEnginePublic {
  const base = httpEngine(over)
  delete base.contentType
  delete base.header
  return base
}

let sources: TtsSourceInfo[]
let hostSpeech: HostSpeechHealth
let engines: TtsEnginePublic[]
let receipt: TtsEngineImportReceipt
let listFailure: Error | null

beforeEach(() => {
  vi.clearAllMocks()
  listFailure = null
  const edge = httpEngine()
  sources = [builtin, browser, httpSource(edge)]
  // 缺省：这台宿主没装语音服务（源清单里那行缺席，管理面合成一条「未检测到」）
  hostSpeech = { state: 'absent' }
  engines = [edge]
  receipt = { added: 1, updated: 0, failed: [] }

  vi.mocked(apiGet).mockImplementation(async (path: string) => {
    if (listFailure !== null) throw listFailure
    if (path === ROUTES.ttsSources.path) return { sources, hostSpeech }
    if (path === ROUTES.ttsEngines.path) return engines
    throw new Error(`unexpected GET ${path}`)
  })
  vi.mocked(apiSend).mockImplementation(async (target: RouteTarget<WriteMethod>) => {
    if (target.path === ROUTES.ttsEnginesImport.path) return receipt
    if (target.method === 'PUT' && target.path === paramOps.ttsEnginePut.at('http:edge').path) {
      return httpEngine({ name: '改名后的引擎' })
    }
    if (target.method === 'DELETE' && target.path === paramOps.ttsEngineDelete.at('http:edge').path) {
      return { removed: true }
    }
    throw new Error(`unexpected ${target.method} ${target.path}`)
  })
})

afterEach(cleanup)

async function renderManager(): Promise<ReturnType<typeof render>> {
  const view = render(<EngineManager writable />)
  await screen.findByText('内置朗读')
  return view
}

function rowOf(container: HTMLElement, id: string): HTMLElement {
  return must(container.querySelector<HTMLElement>(`[data-novel-tts-engine="${id}"]`), `引擎行 ${id}`)
}

/** 编辑抽屉把高级位与登录态收进默认折叠的组：要碰这两组的字段先点开组标题（幂等）。 */
function openEditGroup(dialog: HTMLElement, name: RegExp): void {
  const toggle = within(dialog).getByRole('button', { name })
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle)
}

describe('引擎清单', () => {
  it('四源都列出；cordis 缺席合成灰行「未检测到」；凭据只上状态不上值', async () => {
    // 服务端投影本身不带凭据；这里故意塞运行时脏数据，证明列表不读、不外显任何凭据值。
    const hostile = {
      ...httpEngine(),
      auth: { cookies: { sid: 'session-secret' }, headers: { Authorization: 'Bearer secret' } },
      loginInfo: { password: 'login-secret' },
    }
    engines = [hostile]
    const { container } = await renderManager()

    const rows = [...container.querySelectorAll<HTMLElement>('[data-novel-tts-engine]')]
    expect(rows).toHaveLength(4)
    expect(rows.map((row) => row.getAttribute('data-novel-tts-engine-kind')))
      .toEqual(['builtin', 'browser', 'http', 'cordis'])

    const cordis = pick(rows, 3)
    expect(cordis.textContent).toContain('dsh-xiaomi-tts')
    expect(cordis.textContent).toContain('未检测到')
    expect(cordis.className).toContain('dim')

    const http = pick(rows, 2)
    expect(http.textContent).toContain('微软 Edge 大声朗读')
    expect(http.textContent).toContain('http:edge')
    expect(http.textContent).toContain('已配置登录态')

    expect(container.textContent).not.toContain('session-secret')
    expect(container.textContent).not.toContain('Bearer secret')
    expect(container.textContent).not.toContain('login-secret')

    // 只有注册表（http）引擎可编辑/删除：插件自有源不挂写钮。
    expect(within(pick(rows, 0)).queryByRole('button', { name: '编辑' })).toBeNull()
    expect(within(pick(rows, 1)).queryByRole('button', { name: '删除' })).toBeNull()
    expect(within(http).getByRole('button', { name: '编辑' })).toBeTruthy()
    expect(within(http).getByRole('button', { name: '删除' })).toBeTruthy()

    // 编辑表单的凭据位恒从空开始：投影读不回来，也绝不把脏数据回填上屏。
    fireEvent.click(within(http).getByRole('button', { name: '编辑' }))
    const dialog = await screen.findByRole('dialog')
    openEditGroup(dialog, /登录态（凭据）/)
    expect(within(dialog).getByLabelText<HTMLTextAreaElement>('Cookies（JSON 对象）').value).toBe('')
    expect(dialog.textContent).not.toContain('session-secret')
  })

  it('凭据状态位：未配置 / 已配置都上屏（TTS 没有登录面，不存在过期档）', async () => {
    engines = [httpEngine({ hasAuth: false })]
    const first = await renderManager()
    expect(within(rowOf(first.container, 'http:edge')).getByText(/未配置登录态/)).toBeTruthy()
    first.unmount()

    engines = [httpEngine({ hasAuth: true })]
    const second = await renderManager()
    expect(within(rowOf(second.container, 'http:edge')).getByText(/已配置登录态/)).toBeTruthy()
  })

  it('cordis 在场且可用时不合成第二行', async () => {
    sources = [...sources, { id: 'cordis:speech', kind: 'cordis' }]
    const { container } = await renderManager()
    const rows = [...container.querySelectorAll<HTMLElement>('[data-novel-tts-engine-kind="cordis"]')]
    expect(rows).toHaveLength(1)
    expect(pick(rows, 0).textContent).toContain('可用')
    expect(pick(rows, 0).className).not.toContain('dim')
  })

  it('装了但没配好：灰行说「未就绪」并带上服务方的原因码，不冒充「未检测到」', async () => {
    hostSpeech = { state: 'not-ready', reason: 'api-key-not-configured' }
    const { container } = await renderManager()
    const row = must(
      container.querySelector<HTMLElement>('[data-novel-tts-engine-kind="cordis"]'), '宿主服务那一行')
    // 「没装」与「装了没配」修法不同：一句笼统的「未检测到」会让人去重装插件
    expect(row.textContent).toContain('未就绪')
    expect(row.textContent).toContain('api-key-not-configured')
    expect(row.textContent).not.toContain('未检测到')
    expect(row.className).toContain('dim')
  })

  it('清单读失败（503）显示不可用提示，不渲染空列表', async () => {
    listFailure = new Error('registry unavailable (HTTP 503)')
    render(<EngineManager writable />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('读取朗读引擎清单失败')
    expect(alert.textContent).toContain('registry unavailable')
    expect(screen.queryByText('内置朗读')).toBeNull()
  })
})

describe('引擎 id 的显示身份（清单未到 / 现值不在清单这一档）', () => {
  it('按 id 判 kind 取显示名：自有源不手抄 id、不把机器串上屏，只有订阅 id 回落原始 id', () => {
    // 三枚身份字面量的主人在 wire：这里读常量而不是在用例里抄一份字符串
    expect(engineKindOf(TTS_DEFAULTS.engineId)).toBe('builtin')
    expect(engineKindOf(BROWSER_TTS_ENGINE_ID)).toBe('browser')
    expect(engineKindOf(CORDIS_TTS_ENGINE_ID)).toBe('cordis')
    expect(engineKindOf('http:edge')).toBe('http')

    expect(engineLabelOf(zhTranslate, TTS_DEFAULTS.engineId)).toBe('内置朗读')
    expect(engineLabelOf(zhTranslate, BROWSER_TTS_ENGINE_ID)).toBe('浏览器本地语音')
    expect(engineLabelOf(zhTranslate, CORDIS_TTS_ENGINE_ID)).toBe('dsh-xiaomi-tts')
    // 订阅 id 是数据：清单外认不出身份时才把它当名字（与清单行的回落同一条）
    expect(engineLabelOf(zhTranslate, 'http:edge')).toBe('http:edge')
  })
})

describe('导入与导出', () => {
  it('粘贴 JSON / URL 各走一条路径：一次只带一位、回执逐条留痕、成功后刷新', async () => {
    const { container } = await renderManager()
    const newSource: TtsSourceInfo = { id: 'http:new', kind: 'http', name: '新引擎' }
    const newEngine = httpEngine({ id: 'http:new', name: '新引擎', hasAuth: false })
    sources = [...sources, newSource]
    engines = [...engines, newEngine]
    receipt = { added: 1, updated: 0, failed: [{ index: 2, message: '缺 name（需为非空字符串）' }] }

    const json = '[{"name":"新引擎","url":"https://new.example/tts"}]'
    fireEvent.click(screen.getByRole('button', { name: '导入' }))
    fireEvent.change(screen.getByLabelText('粘贴 legado 朗读引擎订阅 JSON'), { target: { value: json } })
    // URL 位也填着：按「导入 JSON」时仍只发 json 一位（一次提交一条路径）。
    fireEvent.change(screen.getByLabelText('订阅地址'), { target: { value: '  https://feed.example/tts  ' } })

    fireEvent.click(screen.getByRole('button', { name: '导入 JSON' }))
    await waitFor(() => expect(apiSend).toHaveBeenCalledWith(
      ROUTES.ttsEnginesImport, bodies.ttsEnginesImport({ json })))
    const firstBody = must(vi.mocked(apiSend).mock.calls[0], '第一次导入调用')[1] as Record<string, unknown>
    expect(firstBody).not.toHaveProperty('url')

    // 回执：新增/更新读数与逐条失败。wire 的 index 是 0 基下标，上屏要转成序数：
    // 0 基的 2 是「第 3 条」，不是「第 2 条」（改回裸下标即红）。
    expect(await screen.findByText('新增 1 条')).toBeTruthy()
    expect(screen.getByText('更新 0 条')).toBeTruthy()
    expect(screen.getByText(/第 3 条：缺 name/)).toBeTruthy()
    expect(screen.queryByText(/第 2 条：缺 name/), '0 基下标直接上屏：错把第 3 条读成第 2 条').toBeNull()

    // 刷新后的清单里出现新引擎（导入成功后重读两面）
    expect(await within(container).findByText('新引擎')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '从 URL 导入' }))
    // 提交前 trim：首尾空白是输入习惯，不是地址的一部分（发出去的是归一后的串）。
    await waitFor(() => expect(apiSend).toHaveBeenLastCalledWith(
      ROUTES.ttsEnginesImport, bodies.ttsEnginesImport({ url: 'https://feed.example/tts' })))
    const secondBody = must(vi.mocked(apiSend).mock.calls[1], '第二次导入调用')[1] as Record<string, unknown>
    expect(secondBody).not.toHaveProperty('json')
  })

  it('导入失败在页面上留痕', async () => {
    await renderManager()
    vi.mocked(apiSend).mockRejectedValueOnce(new Error('subscription fetch failed'))
    fireEvent.click(screen.getByRole('button', { name: '导入' }))
    fireEvent.change(screen.getByLabelText('粘贴 legado 朗读引擎订阅 JSON'), { target: { value: '[]' } })
    fireEvent.click(screen.getByRole('button', { name: '导入 JSON' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('导入失败')
    expect(alert.textContent).toContain('subscription fetch failed')
  })

  it('导出 JSON 与公共投影同口径：凭据字段剥掉，静态 header 保留', async () => {
    // 运行时脏数据：导出必须自己剥，不依赖「服务端一定会剥」。
    const hostile = {
      ...httpEngine(),
      auth: { cookies: { sid: 'session-secret' }, headers: { Authorization: 'Bearer secret' } },
      cookies: { sid: 'session-secret' },
      headers: { Authorization: 'Bearer secret' },
      loginInfo: { password: 'login-secret' },
    }
    engines = [hostile]
    const { container } = await renderManager()

    fireEvent.click(screen.getByRole('button', { name: '导出' }))
    const out = screen.getByLabelText<HTMLTextAreaElement>('导出 JSON（已剥凭据）')
    expect(out.value).not.toContain('session-secret')
    expect(out.value).not.toContain('Bearer secret')
    expect(out.value).not.toContain('login-secret')

    const parsed: unknown = JSON.parse(out.value)
    expect(Array.isArray(parsed)).toBe(true)
    const keys = new Set<string>()
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(walk); return }
      if (value === null || typeof value !== 'object') return
      for (const [key, inner] of Object.entries(value)) { keys.add(key); walk(inner) }
    }
    walk(parsed)
    for (const forbidden of ['auth', 'cookies', 'headers', 'loginInfo']) {
      expect(keys.has(forbidden), `导出 JSON 不许含凭据字段 ${forbidden}`).toBe(false)
    }
    expect(keys.has('header'), '静态 header 是订阅数据，允许导出').toBe(true)
    expect(container.textContent).not.toContain('session-secret')
  })
})

describe('编辑与删除', () => {
  it('编辑只对注册表引擎开放：保存调 ttsEnginePut，成功后关模态并刷新', async () => {
    const { container } = await renderManager()
    fireEvent.click(within(rowOf(container, 'http:edge')).getByRole('button', { name: '编辑' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('编辑引擎')
    const name = within(dialog).getByLabelText<HTMLInputElement>('名称')
    expect(name.value).toBe('微软 Edge 大声朗读')
    fireEvent.change(name, { target: { value: '改名后的引擎' } })
    openEditGroup(dialog, /登录态（凭据）/)
    fireEvent.change(within(dialog).getByLabelText('Cookies（JSON 对象）'), {
      target: { value: '{"sid":"abc"}' },
    })

    engines = [httpEngine({ name: '改名后的引擎' })]
    sources = [builtin, browser, httpSource(httpEngine({ name: '改名后的引擎' }))]

    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    const expected: TtsEngineInput = {
      name: '改名后的引擎',
      url: 'https://edge.example/tts',
      contentType: 'audio/mpeg',
      header: 'X-Static: 1',
      auth: { cookies: { sid: 'abc' } },
    }
    await waitFor(() => expect(apiSend).toHaveBeenCalledWith(
      paramOps.ttsEnginePut.at('http:edge'), bodies.ttsEnginePut(expected)))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await within(container).findByText('改名后的引擎')).toBeTruthy()
  })

  it('编辑抽屉走表单档并分区：常用两格在首屏，高级与登录态默认收起、点开才出现', async () => {
    // 没有订阅自带内容的引擎：高级组无值，默认收起
    engines = [httpEngineWithoutAdvanced()]
    sources = [builtin, browser, httpSource(must(engines[0], '刚换上的订阅引擎'))]
    const { container } = await renderManager()
    fireEvent.click(within(rowOf(container, 'http:edge')).getByRole('button', { name: '编辑' }))
    const dialog = await screen.findByRole('dialog')

    // 数据表单走 520px 表单档（400px 确认框装不下长地址与 JSON / 代码，680px 宽档又太长）
    expect(dialog.className, '引擎编辑是 form 档模态').toContain('form')
    expect(dialog.className, '不是宽档').not.toContain('wide')
    expect(within(dialog).getByLabelText('名称')).toBeTruthy()
    expect(within(dialog).getByLabelText('接口地址')).toBeTruthy()

    const advanced = within(dialog).getByRole('button', { name: /高级选项/ })
    expect(advanced.getAttribute('aria-expanded')).toBe('false')
    expect(advanced.textContent).toContain('未设置')
    expect(within(dialog).queryByLabelText('JS 库'), '收起时组内字段不渲染').toBeNull()

    openEditGroup(dialog, /高级选项/)
    expect(advanced.getAttribute('aria-expanded')).toBe('true')
    expect(within(dialog).getByLabelText('JS 库')).toBeTruthy()
    expect(within(dialog).getByText(/留空 = 不校验响应类型/)).toBeTruthy()

    const auth = within(dialog).getByRole('button', { name: /登录态（凭据）/ })
    expect(auth.getAttribute('aria-expanded'), '登录态默认收起').toBe('false')
    expect(auth.textContent, '状态位在组标题上，不展开也知道有没有').toContain('已配置登录态')
    expect(within(dialog).queryByLabelText('Cookies（JSON 对象）')).toBeNull()
  })

  it('高级组有订阅自带的值时组标题报已填项数（默认仍收起）', async () => {
    // 缺省 httpEngine 带 contentType 与 header 两格
    const { container } = await renderManager()
    fireEvent.click(within(rowOf(container, 'http:edge')).getByRole('button', { name: '编辑' }))
    const dialog = await screen.findByRole('dialog')

    const advanced = within(dialog).getByRole('button', { name: /高级选项/ })
    expect(advanced.textContent).toContain('已填 2 项')
    expect(advanced.getAttribute('aria-expanded'), '默认收起，有值只报数').toBe('false')
    expect(within(dialog).queryByLabelText('静态请求头')).toBeNull()
    openEditGroup(dialog, /高级选项/)
    expect(within(dialog).getByLabelText<HTMLInputElement>('静态请求头').value).toBe('X-Static: 1')
  })

  it('接口地址走多行 textarea：legado 规则里的换行编辑保存不吞', async () => {
    const url = 'https://tts.example/audio,{\n  "method": "POST",\n  "body": "text={{speakText}}"\n}'
    const edge = httpEngineWithoutAdvanced({ url })
    engines = [edge]
    sources = [builtin, browser, httpSource(edge)]
    const { container } = await renderManager()
    fireEvent.click(within(rowOf(container, 'http:edge')).getByRole('button', { name: '编辑' }))
    const dialog = await screen.findByRole('dialog')

    const urlField = within(dialog).getByLabelText<HTMLTextAreaElement>('接口地址')
    expect(urlField.tagName, '接口地址是多行 textarea').toBe('TEXTAREA')
    expect(urlField.value).toBe(url)

    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(apiSend).toHaveBeenCalledWith(
      paramOps.ttsEnginePut.at('http:edge'), bodies.ttsEnginePut({ name: edge.name, url })))
  })

  it('jsLib / header 走多行 textarea：编辑保存不吞换行（单行 input 会把多行代码压成一行）', async () => {
    const jsLib = 'function f() {\n  // 注释\n  return 1\n}'
    const header = '{\n  "X-Static": "1"\n}'
    const edge = httpEngine({ jsLib, header })
    engines = [edge]
    sources = [builtin, browser, httpSource(edge)]
    const { container } = await renderManager()
    fireEvent.click(within(rowOf(container, 'http:edge')).getByRole('button', { name: '编辑' }))
    const dialog = await screen.findByRole('dialog')

    openEditGroup(dialog, /高级选项/)
    const jsLibField = within(dialog).getByLabelText<HTMLTextAreaElement>('JS 库')
    expect(jsLibField.tagName, 'jsLib 是多行 textarea，不是单行 input').toBe('TEXTAREA')
    expect(jsLibField.value, '多行代码的换行原样回读').toBe(jsLib)
    expect(within(dialog).getByLabelText<HTMLTextAreaElement>('静态请求头').tagName, 'header 也是多行').toBe('TEXTAREA')

    const next = 'function g() {\n  return 2\n}'
    fireEvent.change(jsLibField, { target: { value: next } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    const expected: TtsEngineInput = {
      name: edge.name, url: edge.url, contentType: 'audio/mpeg', header, jsLib: next,
    }
    await waitFor(() => expect(apiSend).toHaveBeenCalledWith(
      paramOps.ttsEnginePut.at('http:edge'), bodies.ttsEnginePut(expected)))
  })

  it('登录态 JSON 非法时拦在表单里，不发 PUT', async () => {
    const { container } = await renderManager()
    fireEvent.click(within(rowOf(container, 'http:edge')).getByRole('button', { name: '编辑' }))
    const dialog = await screen.findByRole('dialog')
    openEditGroup(dialog, /登录态（凭据）/)
    fireEvent.change(within(dialog).getByLabelText('Cookies（JSON 对象）'), { target: { value: 'not json' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    expect(await within(dialog).findByText(/登录态字段需为 JSON 对象/)).toBeTruthy()
    expect(apiSend).not.toHaveBeenCalled()
  })

  it('保存失败留在表单里显示服务端理由', async () => {
    const { container } = await renderManager()
    fireEvent.click(within(rowOf(container, 'http:edge')).getByRole('button', { name: '编辑' }))
    const dialog = await screen.findByRole('dialog')
    vi.mocked(apiSend).mockRejectedValueOnce(new Error('put rejected'))
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    expect(await within(dialog).findByText(/保存失败：put rejected/)).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('删除走确认模态：确认前零写口，确认后调 DELETE 并刷新', async () => {
    const { container } = await renderManager()
    fireEvent.click(within(rowOf(container, 'http:edge')).getByRole('button', { name: '删除' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('删除引擎「微软 Edge 大声朗读」？')
    expect(apiSend).not.toHaveBeenCalled()

    sources = [builtin, browser]
    engines = []
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(apiSend).toHaveBeenCalledWith(paramOps.ttsEngineDelete.at('http:edge')))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(container.querySelector('[data-novel-tts-engine="http:edge"]')).toBeNull())
    expect(apiGet).toHaveBeenCalledTimes(4)
  })

  it('删除失败留在模态里：错误可见，清单不被清空', async () => {
    const { container } = await renderManager()
    fireEvent.click(within(rowOf(container, 'http:edge')).getByRole('button', { name: '删除' }))
    const dialog = await screen.findByRole('dialog')
    vi.mocked(apiSend).mockRejectedValueOnce(new Error('delete exploded'))
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))
    expect(await within(dialog).findByText(/删除失败：delete exploded/)).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(rowOf(container, 'http:edge')).toBeTruthy()
  })
})

describe('导入覆盖既有订阅要先确认', () => {
  const overlap = '[{"id":"http:edge","name":"覆盖版","url":"https://edge.example/tts2"}]'
  const fresh = '[{"id":"http:new","name":"新引擎","url":"https://new.example/tts"}]'

  async function openImport(json: string): Promise<void> {
    fireEvent.click(screen.getByRole('button', { name: '导入' }))
    fireEvent.change(screen.getByLabelText('粘贴 legado 朗读引擎订阅 JSON'), { target: { value: json } })
    fireEvent.click(screen.getByRole('button', { name: '导入 JSON' }))
  }

  it('粘贴 JSON 命中既有 id：先出确认条，一个写口都不发；确认后才提交', async () => {
    await renderManager()
    await openImport(overlap)
    // 服务端 upsert 对文本位是整体替换：这一下会静默清掉盘上的 header / jsLib / contentType
    expect(apiSend).not.toHaveBeenCalled()
    const bar = screen.getByRole('alert')
    expect(bar.textContent).toContain('将覆盖 1 条既有订阅')
    expect(bar.textContent).toContain('静态请求头')
    expect(bar.textContent).toContain('JS 库')
    expect(bar.textContent).toContain('内容类型')

    // 取消：确认条收起，仍然一个写口都没发
    fireEvent.click(within(bar).getByRole('button', { name: '取消' }))
    expect(apiSend).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()

    // 再来一次并确认：提交的就是那段原文
    fireEvent.click(screen.getByRole('button', { name: '导入 JSON' }))
    const confirm = await screen.findByRole('alert')
    fireEvent.click(within(confirm).getByRole('button', { name: '确认覆盖并导入' }))
    await waitFor(() => expect(apiSend).toHaveBeenCalledWith(
      ROUTES.ttsEnginesImport, bodies.ttsEnginesImport({ json: overlap })))
  })

  it('id 对不上 / JSON 解不开：不拦，直接交给服务端回执点名', async () => {
    await renderManager()
    await openImport(fresh)
    await waitFor(() => expect(apiSend).toHaveBeenCalledTimes(1))
    expect(vi.mocked(apiSend).mock.calls[0]?.[1]).toEqual(bodies.ttsEnginesImport({ json: fresh }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('URL 来路没有预览：回执里的「更新」补一句覆盖含义', async () => {
    receipt = { added: 0, updated: 2, failed: [] }
    await renderManager()
    fireEvent.click(screen.getByRole('button', { name: '导入' }))
    fireEvent.change(screen.getByLabelText('订阅地址'), { target: { value: 'https://feed.example/tts' } })
    fireEvent.click(screen.getByRole('button', { name: '从 URL 导入' }))
    expect(await screen.findByText(/整条覆盖/)).toBeTruthy()
    expect(screen.getByText('更新 2 条')).toBeTruthy()
  })
})

describe('清单的读数与失败半径', () => {
  const fresh = '[{"id":"http:new","name":"新引擎","url":"https://new.example/tts"}]'

  it('「N 源」只数此刻可用的行：灰显的合成行不是源', async () => {
    // 源清单只列此刻可用的源；注册表里这一条没被清单报出，于是补成灰显行
    sources = [builtin]
    engines = [httpEngine()]
    const { container } = await renderManager()
    const rows = [...container.querySelectorAll('[data-novel-tts-engine]')]
    expect(rows).toHaveLength(3)
    expect(screen.getByText('1 源')).toBeTruthy()
    expect(screen.queryByText('3 源')).toBeNull()
  })

  it('刷新失败不清掉已就绪的清单：错误横幅与旧行共存，重试仍有出口', async () => {
    const { container } = await renderManager()
    listFailure = new Error('registry unavailable (HTTP 503)')
    fireEvent.click(screen.getByRole('button', { name: '导入' }))
    fireEvent.change(screen.getByLabelText('粘贴 legado 朗读引擎订阅 JSON'), { target: { value: fresh } })
    fireEvent.click(screen.getByRole('button', { name: '导入 JSON' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('读取朗读引擎清单失败')
    expect(alert.textContent).toContain('registry unavailable')
    // 旧读数还在：失败的是「这次没读到」，不是「清单空了」
    expect(rowOf(container, 'builtin:baidu')).toBeTruthy()
    expect(rowOf(container, 'http:edge')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
  })

  it('成功导入后撤掉旧通知：通知说的是上一份清单的事', async () => {
    const { container } = await renderManager()
    fireEvent.click(within(rowOf(container, 'http:edge')).getByRole('button', { name: '删除' }))
    const dialog = await screen.findByRole('dialog')
    sources = [builtin, browser]
    engines = []
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))
    expect(await screen.findByText(/已删除「微软 Edge 大声朗读」/)).toBeTruthy()

    sources = [builtin, browser, { id: 'http:new', kind: 'http', name: '新引擎' }]
    engines = [httpEngine({ id: 'http:new', name: '新引擎', hasAuth: false })]
    fireEvent.click(screen.getByRole('button', { name: '导入' }))
    fireEvent.change(screen.getByLabelText('粘贴 legado 朗读引擎订阅 JSON'), { target: { value: fresh } })
    fireEvent.click(screen.getByRole('button', { name: '导入 JSON' }))
    await waitFor(() => expect(screen.queryByText(/已删除「微软 Edge 大声朗读」/)).toBeNull())
  })
})

describe('登录态的清除', () => {
  it('已保存登录态时给「清除」入口：勾上后提交空凭据组（服务端按空凭据 = 删）', async () => {
    const { container } = await renderManager()
    fireEvent.click(within(rowOf(container, 'http:edge')).getByRole('button', { name: '编辑' }))
    const dialog = await screen.findByRole('dialog')
    openEditGroup(dialog, /登录态（凭据）/)
    const clear = within(dialog).getByLabelText<HTMLInputElement>('清除已保存的登录态')
    expect(clear.checked).toBe(false)
    // 文案要点名会丢什么：cookies / 请求头 / 登录信息
    expect(dialog.textContent).toContain('cookies')
    expect(dialog.textContent).toContain('请求头')
    expect(dialog.textContent).toContain('登录信息')

    fireEvent.click(clear)
    // 勾上后三格凭据禁用：这次写的是删除意图，不是替换
    expect(within(dialog).getByLabelText<HTMLTextAreaElement>('Cookies（JSON 对象）').disabled).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    const expected: TtsEngineInput = {
      name: '微软 Edge 大声朗读',
      url: 'https://edge.example/tts',
      contentType: 'audio/mpeg',
      header: 'X-Static: 1',
      auth: { cookies: {} },
    }
    await waitFor(() => expect(apiSend).toHaveBeenCalledWith(
      paramOps.ttsEnginePut.at('http:edge'), bodies.ttsEnginePut(expected)))
  })

  it('没有已保存登录态时不摆「清除」入口（假控件比没有更坏）', async () => {
    engines = [httpEngine({ hasAuth: false })]
    sources = [builtin, browser, httpSource(httpEngine({ hasAuth: false }))]
    const { container } = await renderManager()
    fireEvent.click(within(rowOf(container, 'http:edge')).getByRole('button', { name: '编辑' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByLabelText('清除已保存的登录态')).toBeNull()
  })
})

describe('模态契约与只读部署', () => {
  it('编辑抽屉的第一格带入场焦点标记：模态打开即落名称输入框', async () => {
    const { container } = await renderManager()
    fireEvent.click(within(rowOf(container, 'http:edge')).getByRole('button', { name: '编辑' }))
    const dialog = await screen.findByRole('dialog')
    const nameField = within(dialog).getByLabelText('名称')
    // 模态契约优先把入场焦点交给带 data-dialog-initial 的元素（行为住 views/dialog.tsx）：
    // 落到动作行的「取消」上时，填完第一格按回车就把整张表单丢了。
    expect(nameField.getAttribute('data-dialog-initial')).not.toBeNull()
    expect(document.activeElement).toBe(nameField)
  })

  it('只读部署：配置页把 writable 传进管理区，编辑 / 删除 / 导入禁用，导出照常', async () => {
    const h = fakeHost({ remoteSettings: fakeRemoteSettings({ writable: false }) })
    apply(fakeCtx(h) as never)
    const reg: Registration = must(
      h.registrations.find((candidate) => candidate.name === 'plugins.bundle.config'),
      'bundle.config 注册',
    )
    const props = (reg.options.inject as () => Record<string, unknown>)()
    const view = render(createElement(reg.component as never, props))
    // 对象数据管理区默认收起：点开才挂载（引擎清单是网络读面）
    fireEvent.click(await screen.findByRole('button', { name: /朗读引擎与订阅/ }))
    await screen.findByText('内置朗读')

    const http = rowOf(view.container, 'http:edge')
    expect(within(http).getByRole<HTMLButtonElement>('button', { name: '编辑' }).disabled).toBe(true)
    expect(within(http).getByRole<HTMLButtonElement>('button', { name: '删除' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '导入' }).disabled).toBe(true)
    // 导出与清单是读面：不受只读影响
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '导出' }).disabled).toBe(false)
    expect(screen.getByText('本部署的配置为只读。')).toBeTruthy()
  })
})

describe('配置页挂载槽', () => {
  const field = { text: '1', overridden: false, invalid: false, dirty: false }
  const fields = {
    searchTimeoutMs: field, searchParallel: field, jsTimeoutMs: field, exportDelayMs: field,
    cacheMaxBytes: field, localImportMaxBytes: field, proxyUrl: field, ttsDefaultEngine: field,
    ttsDefaultRate: field, ttsDefaultVolume: field, ttsCacheMaxBytes: field, ttsPrefetchParagraphs: field,
  }
  const actions = { onEdit: () => {}, onReset: () => {}, onSave: () => {}, onDiscard: () => {} }

  it('管理区落在听书组内；静态渲染（不传槽）不挂任何管理器', () => {
    const props = {
      t: zhTranslate, writable: true, fields, dirty: false, invalid: false,
      saving: false, failure: null, ...actions,
    }
    const withSlot = render(
      <NovelConfigPageView {...props} engineManager={<div data-testid="engine-manager" />} />,
    )
    const tts = must(
      withSlot.container.querySelector<HTMLElement>('.novel-cfg-group:last-child'),
      '听书组',
    )
    // 管理区默认收成一行（引擎清单是网络读面）：点开这一行才挂载槽里的节点。
    fireEvent.click(within(tts).getByRole('button', { name: /朗读引擎与订阅/ }))
    expect(within(tts).getByTestId('engine-manager')).toBeTruthy()
    expect(tts.textContent).toContain('听书')
    withSlot.unmount()

    const plain = render(<NovelConfigPageView {...props} />)
    expect(plain.queryByTestId('engine-manager')).toBeNull()
  })

  it('槽里的节点不参与静态渲染的取数：静态渲染没有引擎标题', () => {
    const plain = render(<NovelConfigPageView
      t={zhTranslate} writable fields={fields} dirty={false} invalid={false}
      saving={false} failure={null} {...actions}
    />)
    expect(plain.queryByText('引擎管理')).toBeNull()
  })
})
