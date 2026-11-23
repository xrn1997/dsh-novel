// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '../../src/client/api.js'
import { CopyProvider, enTranslate } from '../../src/client/copy/index.js'
import { loadPanelShelf, panelShelf } from '../../src/client/panel-shelf.js'
import { navigate, setPref } from '../../src/client/store.js'
import { NovelView } from '../../src/client/views/NovelView.js'
import { ReaderView } from '../../src/client/views/ReaderView.js'
import type {
  ChapterContent, ChapterEntry, ContentNode, LocalImportWarning, NavigationItem, ReadingTarget,
} from '../../src/client/views/types.js'
import { LOCAL_SOURCE_ID, ROUTES } from '../../src/shared/wire.js'
import { must, pick } from '../support/fixture.js'
import { makeReaderDeps } from './fake-deps.js'
import type { DepsOverrides, FakeReaderDeps } from './fake-deps.js'
import { readerRouteGetMock } from './reader-fakes.js'
import { installWiringLifecycle, sentCalls } from './wiring-harness.js'

/**
 * 阅读器与小说视图导航的接线：会话取数走注入 deps、入架一问与焦点/遮罩、范围导出、图文目录树
 * 与注释面板的互斥、排版复位，以及顶部 tab 的分支切换。阅读几何与渲染门归浏览器门。
 */

installWiringLifecycle()

describe('ReaderView 接线（ReaderDeps 注入 + 范围导出流经 export-run）', () => {
  const readerDeps = (over: DepsOverrides = {}, shelf: unknown[] = []): FakeReaderDeps => makeReaderDeps(over, shelf)

  const reader = (deps: FakeReaderDeps): ReturnType<typeof createElement> =>
    createElement(ReaderView, { sourceId: 's1', bookKey: 'k1', title: '斗罗', deps })

  it('英文：阅读器控制条与设置入口', async () => {
    const deps = readerDeps()
    const { container } = render(createElement(CopyProvider, { value: enTranslate, children: reader(deps) }))
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    expect(screen.getByRole('button', { name: 'Shelf' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reader settings' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Contents' })).toBeTruthy()
    // 设置抽屉的档位名也走字典：字号读数、行距、纸张色 swatch 的可访问名
    fireEvent.click(screen.getByRole('button', { name: 'Reader settings' }))
    const prefs = screen.getByRole('dialog', { name: 'Reader settings' })
    expect(within(prefs).getByText(/^Font size \(current \d+px\)$/)).toBeTruthy()
    expect(within(prefs).getByText('Line height')).toBeTruthy()
    expect(within(prefs).getByRole('button', { name: 'Cream' })).toBeTruthy()
  })

  it('空章名目录：顶条、章首分隔标题与目录抽屉统一兜底到「第 N 章」（中英文同路）', async () => {
    const blankToc: ChapterEntry[] = [
      { name: '', url: 'https://x/c/1' },
      { name: '   ', url: 'https://x/c/2' },
    ]
    const blankNav: NavigationItem[] = blankToc.map((c, i) => ({
      id: `t${i}`, label: c.name, target: { kind: 'chapter', index: i, anchorId: null }, children: [],
    }))
    const makeBlankDeps = (): FakeReaderDeps => readerDeps({
      apiGet: vi.fn(async (path: string) => {
        if (path.includes('navigation')) return { chapters: blankToc, items: blankNav }
        if (path.includes('chapter')) return { kind: 'text', text: '正文一段' }
        return []
      }),
    })

    const { container, unmount } = render(reader(makeBlankDeps()))
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    expect(container.querySelector('.novel-rdr-chap')?.textContent).toBe('第 1 章')
    expect(container.querySelector('h2.novel-rdr-mark')?.textContent).toBe('第 1 章')
    fireEvent.click(screen.getByRole('button', { name: '目录' }))
    const drawer = await screen.findByRole('dialog', { name: '目录' })
    expect(within(drawer).getByRole('button', { name: '第 1 章' })).toBeTruthy()
    expect(within(drawer).getByRole('button', { name: '第 2 章' })).toBeTruthy()
    unmount()

    const en = render(createElement(CopyProvider, { value: enTranslate, children: reader(makeBlankDeps()) }))
    await waitFor(() => expect(en.container.querySelector('[data-chapter="0"]')).not.toBeNull())
    expect(en.container.querySelector('.novel-rdr-chap')?.textContent).toBe('Chapter 1')
    expect(en.container.querySelector('h2.novel-rdr-mark')?.textContent).toBe('Chapter 1')
    fireEvent.click(screen.getByRole('button', { name: 'Contents' }))
    const enDrawer = await screen.findByRole('dialog', { name: 'Contents' })
    expect(within(enDrawer).getByRole('button', { name: 'Chapter 1' })).toBeTruthy()
    expect(within(enDrawer).getByRole('button', { name: 'Chapter 2' })).toBeTruthy()
  })

  it('翻页模式：舞台渲染、预取失败不弹错误条、切回滚动恢复正文列', async () => {
    const chapters: ChapterEntry[] = [
      { name: '第一章', url: 'u1' },
      { name: '第二章', url: 'u2' },
    ]
    const deps = readerDeps({
      apiGet: readerRouteGetMock({
        chapters: () => chapters,
        chapter: (i) => {
          if (i === 1) throw new Error('预取失败')
          return { kind: 'text', text: '第一章正文' }
        },
        shelf: () => [],
      }),
    })
    setPref({ readingMode: 'page' })
    try {
      const { container } = render(reader(deps))
      await waitFor(() => expect(container.querySelector('[data-novel-book-stage]')).not.toBeNull())
      expect(container.querySelector('[data-novel-page-num]')?.textContent).toContain('第 1')
      expect(container.querySelector('.novel-rdr-body')).toBeNull()

      // 预取下一章失败：用户还没翻到那一章，错误条不许出现（静默预取）。
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      expect(container.querySelector('[data-novel="error"]')).toBeNull()

      act(() => { setPref({ readingMode: 'scroll' }) })
      await waitFor(() => expect(container.querySelector('.novel-rdr-body')).not.toBeNull())
      expect(container.querySelector('[data-novel-book-stage]')).toBeNull()
    } finally {
      setPref({ readingMode: 'scroll', pageAnimation: 'flip' })
    }
  })

  it('阅读会话的网络取数走注入 deps（目录走 navigation 读面，不硬 import apiGet）', async () => {
    const deps = readerDeps()
    render(reader(deps))
    await waitFor(() => expect(deps.apiGet).toHaveBeenCalled())
    expect(String(pick(pick(deps.apiGet.mock.calls, 0), 0))).toContain('navigation')
  })

  it('换源即重开、改标题不重开：会话的键是「地址 + 源」，书名只是展示', async () => {
    // 这一条钉的是会话键的两侧：同址换一个源必须重新 open（否则阅读器还读着旧源的地址），
    // 而标题变化不得重开会话——重建会把目录与阅读位置一起丢一次，那是「换源保持进度」还没裁
    // 之前就不该先付的代价。变异：把 title 放回会话 memo 的依赖，第二段计数即变 2；
    // 把 sourceId 从 open 那条 effect 的依赖里摘掉，第三段等不到第二发。
    const deps = readerDeps()
    const navs = (): string[] => (deps.apiGet as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .filter((p) => p.includes('navigation'))
    const view = (over: { sourceId?: string; title?: string }): ReturnType<typeof createElement> =>
      createElement(ReaderView, {
        sourceId: over.sourceId ?? 's1', bookKey: 'k1', title: over.title ?? '斗罗', deps,
      })

    const { rerender } = render(view({}))
    await waitFor(() => expect(navs()).toHaveLength(1))

    rerender(view({ title: '《斗罗》' }))
    await waitFor(() => expect(screen.getByText('《斗罗》')).toBeTruthy())
    expect(navs(), '改标题不该重开会话').toHaveLength(1)

    rerender(view({ sourceId: 's2' }))
    await waitFor(() => expect(navs()).toHaveLength(2))
    expect(navs()[1], '重开那一发问的必须是新源').toContain('sourceId=s2')
  })

  // 从书城「读这本」进来的书不在架上（那一层刻意把入架与阅读分成两个动作，`ADR-0028`），
  // 而不在架的书进度 PUT 会被服务端判 `NOT_ON_SHELF` 并咽掉。离开那一跳因此先问一句。
  it('不在架的书：点「书架」先问要不要加入，确认后 PUT 的是这本书的架位并带上总章数', async () => {
    const pushOk = vi.fn()
    const deps = readerDeps({ pushOk })
    const { container } = render(reader(deps))
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '书架' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('还没加入书架')

    fireEvent.click(screen.getByRole('button', { name: /加入书架并返回/ }))
    await waitFor(() => expect(pushOk).toHaveBeenCalled())
    // 按 body 形状认这一发（阅读器还会发 progress / patch 两种 PUT，路径同一条）
    const add = must(sentCalls(deps).find((c) => c[0].method === 'PUT' && 'title' in (c[1] as object)), '按 body 形状认加入书架那一发')
    expect(add[0].path).toBe(`${ROUTES.shelf.path}/k1`)
    expect(add[1]).toMatchObject({ sourceId: 's1', title: '斗罗', totalChapters: 1 })
    expect(panelShelf.get().landed.has('k1'), '阅读器入架同样并入面板期落架账').toBe(true)
  })

  it('已在架的书：点「书架」直接走，不多问一句', async () => {
    // 只换「书架」那一支的读数：navigation/chapter 仍走缺省分流（整段复制缺省假实现会与缺省形脱钩）
    const deps = readerDeps({}, [
      { sourceId: 's1', bookKey: 'k1', title: '斗罗', addedAt: 0, progress: { chapterIndex: 0, offsetRatio: 0, updatedAt: 0 } },
    ])
    const { container } = render(reader(deps))
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '书架' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('书架读面失败：离开直接走——「问不到」不冒充「不在架」', async () => {
    const fallback = readerDeps()
    const deps = readerDeps({
      apiGet: vi.fn(async (path: string) => {
        if (path === ROUTES.shelf.path) throw new Error('书架读面挂了')
        return fallback.apiGet(path)
      }),
    })
    const { container } = render(reader(deps))
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '书架' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('投影停在加架前：阅读器为当前书重取一次，不误问加入', async () => {
    // 旧投影是空架（例如面板早先取过一次）；当前书在服务端已在架，阅读器必须重取再判。
    await loadPanelShelf({ apiGet: async () => [], describeError: String })
    const deps = readerDeps({}, [
      { sourceId: 's1', bookKey: 'k1', title: '斗罗', addedAt: 0, progress: { chapterIndex: 0, offsetRatio: 0, updatedAt: 0 } },
    ])
    const { container } = render(reader(deps))
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    expect(deps.apiGet.mock.calls.some((c) => String(c[0]) === ROUTES.shelf.path)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '书架' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  // 键盘接管的机械（Esc、Tab 圈、入场焦点、还焦）归模态契约，钉子住在 `tests/client/dialog.test.tsx`；
  // 这里只钉这一处浮层的两个现场事实：入场焦点落「安全的那一颗」、关后还焦给触发它的那颗「书架」钮。
  it('入架一问：入场焦点在「先不加入」，关闭后焦点还给「书架」钮', async () => {
    const deps = readerDeps()
    const { container } = render(reader(deps))
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    const shelfBtn = screen.getByRole('button', { name: '书架' })
    shelfBtn.focus()                                   // jsdom 的 click 不聚焦（真实浏览器会）——先显式聚焦
    fireEvent.click(shelfBtn)
    await screen.findByRole('dialog')
    const skip = screen.getByRole('button', { name: '先不加入' })
    const join = screen.getByRole('button', { name: /加入书架并返回/ })
    expect(document.activeElement).toBe(skip)          // 入场焦点 = 安全的那一颗
    join.focus()
    fireEvent.keyDown(document, { key: 'Escape' })     // Esc 归模态契约：收回这一问
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(shelfBtn)      // 关后还焦给触发件
  })

  // 「失败留在问它的那一层」的机械保证：若再给 joinAndBack 补一发 pushError，同一句失败话
  // 就有模态内联 + 全局条两个家（ShelfView 删书模态立的正是「失败留在框内、不散落页面流」）。
  it('加入失败：模态留原地可重试，失败话只住模态内（不弹全局条）', async () => {
    const pushError = vi.fn()
    const deps = readerDeps({
      pushError,
      apiSend: vi.fn(async (target: { method: string; path: string }, body?: unknown) => {
        if (target.method === 'PUT' && body !== null && typeof body === 'object' && 'title' in body) throw new Error('磁盘只读')
        return {}
      }),
    })
    const { container } = render(reader(deps))
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '书架' }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: /加入书架并返回/ }))
    await screen.findByText('加入书架失败：磁盘只读')
    expect(screen.getByRole('dialog')).toBeTruthy()          // 模态留着：可重试，也可先不走
    expect(pushError).not.toHaveBeenCalled()                 // 不散落页面流
  })

  // 同场时 Esc 归谁：判据在 `reader-surfaces.escOwner`（模态在场时浮层的 Esc 监听不安装），
  // 否则一次 Esc 既收回模态、又走 closeAll 把目录也收掉。
  it('目录开着 + 入架一问：Esc 只关模态，目录仍在场、进度不变', async () => {
    const deps = readerDeps()
    const { container } = render(reader(deps))
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: '目录' }))
    expect(screen.getByRole('button', { name: '目录' }).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '书架' }))
    await screen.findByRole('dialog', { name: '这本书还没加入书架，加入吗？' })
    const sent = deps.apiSend.mock.calls.length
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '这本书还没加入书架，加入吗？' })).toBeNull())
    expect(screen.getByRole('dialog', { name: '目录' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '目录' }).getAttribute('aria-expanded')).toBe('true')
    expect(deps.apiSend.mock.calls.length).toBe(sent)        // 关模态不连带走 closeAll、不写进度
    // 模态退场后浮层重新持有 Esc：下一次仍按 closeAll 的语义收场（依赖数组必须含 askShelf）
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '目录' })).toBeNull())
    expect(screen.getByRole('button', { name: '目录' }).getAttribute('aria-expanded')).toBe('false')
  })

  // 遮罩只在「点外面关掉它」的两面在场（判据住 `reader-surfaces.maskFor`，视图只读阅读场景的
  // `mask` 投影）。投影与面同笔落定归 `reader-scene.test.ts`，这里只钉「点 Aa 真的把它带到屏上、
  // 换目录真的收走」这条接线。
  it('遮罩随面：点 Aa 出遮罩，换到目录即没有', async () => {
    const deps = readerDeps()
    const { container } = render(reader(deps))
    await waitFor(() => expect(container.querySelector('[data-chapter="0"]')).not.toBeNull())
    expect(container.querySelector('[data-novel-ctrl-mask]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '阅读设置' }))
    expect(container.querySelector('[data-novel-ctrl-mask]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '目录' }))
    expect(container.querySelector('[data-novel-ctrl-mask]')).toBeNull()
  })

  it('正文首行与章名同句 → 呈现层剥掉它（章名只留 h2 那一份）', async () => {
    // 本项目输入的正文可能首行重复章名（「第1章 ××」那种）。判据是相等才丢，所以这里同时钉「其余行原序在」。
    const name = '第1章 夜航'
    const deps = readerDeps({
      apiGet: vi.fn(async (path: string) => {
        if (path.includes('navigation')) {
          return {
            chapters: [{ name, url: 'u1' }],
            items: [{ id: 't1', label: name, target: { kind: 'chapter', index: 0, anchorId: null }, children: [] }],
          }
        }
        if (path.includes('chapter')) return { kind: 'text', text: `${name}\n夜里挑灯看剑\n第二段正文` }
        return []
      }),
    })
    const { container } = render(reader(deps))
    await waitFor(() => expect(container.querySelector('[data-chapter="0"] p')).not.toBeNull())
    expect([...container.querySelectorAll('[data-chapter="0"] p')].map((p) => p.textContent))
      .toEqual(['夜里挑灯看剑', '第二段正文'])
    expect(container.querySelector('.novel-rdr-chap')?.textContent).toBe(name)
  })

  it('点条上「下载」→ 弹范围面板（此时不开流）；点面板「⤓ 下载」→ streamExport 在途，成功后 saveBlob 按书名落盘', async () => {
    const deps = readerDeps()
    render(reader(deps))
    await waitFor(() => expect(screen.getByText('1 / 1')).toBeTruthy())   // 目录未就绪时确认钮本就该禁用
    fireEvent.click(screen.getByRole('button', { name: '下载' }))
    expect(screen.getByRole('dialog', { name: '导出范围' })).toBeTruthy()   // 第一步只开面板
    expect(deps.streamExport).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('dialog', { name: '导出范围' })).getByText('⤓ 下载'))
    await waitFor(() => expect(deps.streamExport).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(deps.saveBlob).toHaveBeenCalledTimes(1))
    expect(String(pick(pick(deps.saveBlob.mock.calls, 0), 1))).toBe('斗罗.txt')
  })

  it('面板范围校验：输入倒置 → 确认钮禁用，改回合法才可点', async () => {
    const deps = readerDeps()
    render(reader(deps))
    await waitFor(() => expect(screen.getByText('1 / 1')).toBeTruthy())   // toc 就绪才有 total
    fireEvent.click(screen.getByRole('button', { name: '下载' }))
    const dlg = screen.getByRole('dialog', { name: '导出范围' })
    const inputs = within(dlg).getAllByRole('spinbutton')                  // type="number" → spinbutton
    fireEvent.change(pick(inputs, 0), { target: { value: '3' } })                // 3 > 1 倒置
    const confirm = within(dlg).getByText('⤓ 下载')
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(pick(inputs, 0), { target: { value: '1' } })
    expect((confirm as HTMLButtonElement).disabled).toBe(false)
    expect(deps.streamExport).not.toHaveBeenCalled()                       // 校验期零请求
  })

  it('导出失败：错误条呈现 code（导出错误与阅读链路 error 分家，各说各的）', async () => {
    const deps = readerDeps({
      streamExport: vi.fn(async () => { throw new ApiClientError('ExportFailed', 500, '服务端导出失败') }),
    })
    render(reader(deps))
    await waitFor(() => expect(screen.getByText('1 / 1')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '下载' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '导出范围' })).getByText('⤓ 下载'))
    await waitFor(() => expect(screen.getByText(/ExportFailed/)).toBeTruthy())
  })

  /** 导出是文字面：图文书里的插图只有占位文字（`chapterContentToText` 的投影），面板要先把这句话说清，
   *  否则用户以为下载下来的是原书图文。 */
  it('导出面板点明只有 TXT 文字、不含图片', async () => {
    const deps = readerDeps()
    render(reader(deps))
    await waitFor(() => expect(screen.getByText('1 / 1')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '下载' }))
    expect(within(screen.getByRole('dialog', { name: '导出范围' })).getByText('TXT 文字导出，不包含图片')).toBeTruthy()
  })
})

describe('ReaderView 图文接线（目录树 / 正文内链返回 / 注释面板 / 排版复位）', () => {
  /** jsdom 的 window.scrollTo 是「未实现」桩（调用即往 stderr 灌一行 error）。
   *  本组的落位断言（排版复位）正是看它收到什么，所以直接换成确定性假实现——顺带保持输出干净。 */
  let scrollTo: ReturnType<typeof vi.spyOn>
  beforeEach(() => { scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined) })
  afterEach(() => { scrollTo.mockRestore() })

  /** 整组的确定性视口：第 1 段落在视口里、其余排在它下方（见下面那条「地基」用例的理由——
   *  零排版会让会话在挂载期落一笔伪进度，本组所有「不写主进度」的断言都站在它上面）。
   *  体内要**改**这套几何的两条用例（内链跨章的返回采点、排版复位的重排前后）自己换桩、
   *  并在 finally 还原到这一条，所以这里存的是真 jsdom 的实现、在 afterEach 统一收回。 */
  /** 基线桩用 spy 装/卸：真实现读 `this`，脱离原型单独持有它既过不了 unbound-method，
   *  预绑定一份又会让还原后的 `el.getBoundingClientRect()` 丢掉接收者。 */
  let rectSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element): DOMRect {
      const top = this.getAttribute('data-novel-node') === 'p1' ? -50 : 400
      return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) }
    })
  })
  afterEach(() => { rectSpy.mockRestore() })

  /**
   * 本组「不写主进度」断言的**地基**：
   * ① jsdom 无排版、rect 全 0，视口若按假几何采点会把「读到哪儿」认成最后一块 → 挂载期落伪进度，
   *    故整组固定视口（第 1 段在视口里）；
   * ② 固定视口消掉的是乱参数，不是「站定也写」的冗余 PUT——幽灵写若发生，会挂在防抖窗到期那一刻
   *    跨进观察窗，根因按「不写幽灵写」收在会话侧；
   * ③ 观察窗不必拿真墙钟买：防抖窗可注入（`ReaderDeps.saveDebounceMs`，jobs 轮询同款先例），
   * 此处收紧到 50ms——幽灵写若有必落在 50ms+双帧内，等 300ms 观察的是同一段语义。
   */
  it('挂载期不落任何进度：本组「零写」断言的地基（防抖窗整段零写）', async () => {
    const deps = richDeps({ saveDebounceMs: 50 })
    render(richReader(deps))
    await screen.findByText('第一章第一段')
    // 等过会话的帧调度（双 rAF）**与整个进度防抖窗**：要落的话就落在这个窗口里
    await act(async () => { await new Promise((r) => setTimeout(r, 300)) })
    expect(sentCalls(deps).map((c) => c[1])).toEqual([])
  })

  const chapters: ChapterEntry[] = [
    { name: '第一章', url: 'u0' }, { name: '第二章', url: 'u1' }, { name: '第三章', url: 'u2' },
  ]
  /** 目录树：一个分组 + 三条叶（分组标题没有可去的地方，不许渲染成点了没反应的按钮；
   *  「附录」指向补充文档——目录条目也能直接把读者送进注释面板） */
  const navItems: NavigationItem[] = [
    {
      id: 'g', label: '第一卷', target: null,
      children: [
        { id: 'n0', label: '第一章', target: { kind: 'chapter', index: 0, anchorId: null }, children: [] },
        { id: 'n1', label: '第二章', target: { kind: 'chapter', index: 1, anchorId: null }, children: [] },
        { id: 'n2', label: '附录', target: { kind: 'supplement', documentId: 's1', anchorId: null }, children: [] },
      ],
    },
  ]
  const t = (text: string): ContentNode => ({ kind: 'text', text })
  const para = (id: string, text: string, extra: ContentNode[] = []): ContentNode => ({
    kind: 'element', id, tag: 'p', children: [t(text), ...extra],
    rowSpan: null, colSpan: null, start: null, value: null,
  })
  const link = (id: string, target: ReadingTarget, role: 'normal' | 'noteref', label: string): ContentNode =>
    ({ kind: 'link', id, target, role, children: [t(label)] })
  /** 第一章：一条主序列内链 + 一条脚注引用（两条都从正文里出来）。p1/p2 是排版复位的可见节点锚。 */
  const rich0: ChapterContent = {
    kind: 'rich', documentId: 'd0', nodes: [
      para('p1', '第一章第一段'),
      para('p2', '第一章第二段', [
        link('l1', { kind: 'chapter', index: 1, anchorId: null }, 'normal', '见第二章'),
        link('l2', { kind: 'supplement', documentId: 's1', anchorId: 'f1' }, 'noteref', '脚注一'),
      ]),
    ],
  }
  const rich1: ChapterContent = {
    kind: 'rich', documentId: 'd1',
    nodes: [para('q1', '第二章正文', [
      // 第 2 章里也有一条脚注引用：用户路径（跟内链过去 → 在新章点脚注）要它才走得通
      link('l4', { kind: 'supplement', documentId: 's1', anchorId: 'f2' }, 'noteref', '脚注二'),
    ])],
  }
  // 第 3 章另给一份**不同**的正文：jsdom 视口处处为 0 ⇒ 哨兵恒在预取区，第 3 章也会被预取出来；
  // 若它与第 1 章同文，页面里就会出现两个「见第二章」按钮（用例要按角色取唯一元素）。
  const rich2: ChapterContent = { kind: 'rich', documentId: 'd2', nodes: [para('r1', '第三章正文')] }

  const richDeps = (over: DepsOverrides = {}): FakeReaderDeps => makeReaderDeps({
    apiGet: vi.fn(async (p: string) => {
      if (p.includes('navigation')) return { chapters, items: navItems }
      if (p.includes('local/document')) return { kind: 'text', text: '脚注正文' }
      if (p.includes('chapter')) {
        const index = Number(new URLSearchParams(p.split('?')[1] ?? '').get('index'))
        return index === 1 ? rich1 : index === 2 ? rich2 : rich0
      }
      return []
    }),
    ...over,
  })
  /** 本地书的源身份就是跨半契约常量（生产路径由 ShelfView 的导入回执带来）——桩也要用同一个值：
   *  阅读器按它判断「这本书有没有本地产物读口」（导入说明走 `local/warnings`，只有本地书有）。 */
  const richReader = (deps: FakeReaderDeps): ReturnType<typeof createElement> =>
    createElement(ReaderView, { sourceId: LOCAL_SOURCE_ID, bookKey: 'local:b1', title: '图文书', deps })
  /** 从第 `from` 条起的新 PUT 落在哪些章（去重保序）。jsdom 视口处处为 0，会话会发出几笔「跨章」
   *  读数噪声——本组只认**导航落到了哪一章**，不认总笔数（时序笔数归 reader-session.test.ts）。 */
  const jumpedTo = (deps: FakeReaderDeps, from: number): number[] => [...new Set(
    deps.apiSend.mock.calls.slice(from).map((c) => {
      const body = c[1] as { progress: { chapterIndex: number } }
      return body.progress.chapterIndex
    }),
  )]

  it('目录抽屉改用导航树：分组不可点、叶条目跳章（纯导航不押返回项）', async () => {
    const deps = richDeps()
    render(richReader(deps))
    await screen.findByText('第一章第一段')
    fireEvent.click(screen.getByRole('button', { name: '目录' }))
    const dlg = await screen.findByRole('dialog', { name: '目录' })
    expect(within(dlg).getByText('第一卷')).toBeTruthy()                     // 分组标题在场
    expect(within(dlg).queryByRole('button', { name: '第一卷' })).toBeNull() // 但不是「点了没反应」的按钮
    expect(dlg.querySelectorAll('.novel-nav .novel-nav')).toHaveLength(1)    // 层级靠嵌套列表（结构即层级）

    const before = deps.apiSend.mock.calls.length
    fireEvent.click(within(dlg).getByRole('button', { name: '第二章' }))
    expect(jumpedTo(deps, before)).toEqual([1])                              // 选中即落盘，落在第 2 章
    expect(await screen.findByText('第二章正文')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /返回原处/ })).toBeNull()    // 目录点击不是「链接跟随」
  })

  it('正文内链：跳走前采点 → 工具栏出现「返回原处」；返回回到来源章并消费掉那条栈', async () => {
    const deps = richDeps()
    render(richReader(deps))
    await screen.findByText('第一章第一段')
    const open = deps.apiSend.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: '见第二章' }))
    expect(jumpedTo(deps, open)).toEqual([1])                                // 章号意图即时落盘
    const back = await screen.findByRole('button', { name: /返回原处/ })      // 采点建立的那条返回项
    const returned = deps.apiSend.mock.calls.length
    fireEvent.click(back)
    expect(jumpedTo(deps, returned)).toEqual([0])                            // 回到来源章
    await waitFor(() => expect(screen.queryByRole('button', { name: /返回原处/ })).toBeNull())
  })

  it('脚注引用开注释面板：面板取 local/document，主阅读进度零写；关闭即回引用处（消费那条返回项）', async () => {
    const deps = richDeps()
    render(richReader(deps))
    await screen.findByText('第一章第一段')
    const before = deps.apiSend.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: '脚注一' }))
    expect(deps.apiSend.mock.calls.length).toBe(before)                      // 开面板不写主序列进度
    const panel = await screen.findByRole('dialog', { name: '注释' })
    await waitFor(() => expect(deps.apiGet.mock.calls.map((c) => String(c[0])).join('\n')).toContain('local/document'))
    expect(within(panel).getByText('脚注正文')).toBeTruthy()                  // 面板自己取补充文档
    // 正文内链跳走前采了返回点：脚注面板开着的这段时间也有「回引用处」可走（面板里能再点主序列）
    expect(await screen.findByRole('button', { name: /返回原处/ })).toBeTruthy()

    const closed = deps.apiSend.mock.calls.length
    fireEvent.click(within(panel).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '注释' })).toBeNull())
    expect(jumpedTo(deps, closed)).toEqual([0])                              // 回到引用处（同一章同一节点）
    await waitFor(() => expect(screen.queryByRole('button', { name: /返回原处/ })).toBeNull())
  })

  it('导入说明与脚注面板互斥：只收脚注面板、不消费返回项、不写主进度', async () => {
    // 两块面板同住右上角（同一套 `.novel-notes` 几何），同场谁也读不了。收脚注面板**不按关闭语义走**
    // （不消费返回项：消费是弹栈回引用处 + 落存档），「看一眼导入说明」是只读动作。
    const deps = withWarnings([degraded])
    render(richReader(deps))
    await screen.findByText('第一章第一段')
    fireEvent.click(screen.getByRole('button', { name: '脚注一' }))
    await screen.findByRole('dialog', { name: '注释' })
    const before = deps.apiSend.mock.calls.length
    fireEvent.click(await screen.findByRole('button', { name: '导入说明' }))
    const warnPanel = await screen.findByRole('dialog', { name: '导入说明' })
    expect(within(warnPanel).getByText(/导入说明（1 条）/)).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '注释' })).toBeNull())
    expect(deps.apiSend.mock.calls.length).toBe(before)                     // 不跳章、不写进度
    expect(await screen.findByRole('button', { name: /返回原处/ })).toBeTruthy()   // 返回项仍在，由工具栏承接
  })

  it('目录与脚注面板互斥：点目录收掉脚注面板（否则它盖住目录、条目点不动）', async () => {
    // 两块浮层同住右上角且脚注面板更宽：同场时命中测试打到面板头，目录条目根本点不动。
    // 与导入说明同一口径——只收面板、不消费返回项、不写主进度。
    const deps = richDeps()
    render(richReader(deps))
    await screen.findByText('第一章第一段')
    fireEvent.click(screen.getByRole('button', { name: '脚注一' }))
    await screen.findByRole('dialog', { name: '注释' })
    const before = deps.apiSend.mock.calls.length

    fireEvent.click(screen.getByRole('button', { name: '目录' }))
    const dlg = await screen.findByRole('dialog', { name: '目录' })
    expect(within(dlg).getByText('第一卷')).toBeTruthy()                     // 目录真的能读了
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '注释' })).toBeNull())
    expect(deps.apiSend.mock.calls.length).toBe(before)                     // 开目录不跳章、不写进度
    expect(await screen.findByRole('button', { name: /返回原处/ })).toBeTruthy()   // 返回项留在栈里
  })

  it('工具栏返回之后关面板：不许再替用户跳一次（面板的「回引用处」只认它打开时压入的那条）', async () => {
    // 用户路径：内链去第 2 章 → 点脚注 → 工具栏返回 → 关面板。关面板只认它打开时压入的那条
    // （按条目身份判）；按「面板是内链开的」弹栈会弹掉**更早那条**，主序列被送回上一章且写进存档。
    // jsdom 无排版，用**可切换**的 rect 桩顶替布局（第 1 章读 p1、第 2 章读 q1）。
    const proto = Element.prototype as unknown as { getBoundingClientRect: () => DOMRect }
    const original = proto.getBoundingClientRect
    let readingChapter2 = false
    proto.getBoundingClientRect = function (this: Element): DOMRect {
      const node = this.getAttribute('data-novel-node')
      const vis = readingChapter2 ? 'q1' : 'p1'
      const top = node === vis ? -50 : 400
      return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) }
    }
    try {
      const deps = richDeps()
      render(richReader(deps))
      await screen.findByText('第一章第一段')
      const atLink = deps.apiSend.mock.calls.length
      fireEvent.click(screen.getByRole('button', { name: '见第二章' }))         // ① 押下 E1（第 1 章那处）
      expect(jumpedTo(deps, atLink)).toEqual([1])                             // 内链跳章：意图即时落盘
      readingChapter2 = true                                                  // 视口已在第 2 章（真排版自己会表达这件事）
      fireEvent.click(await screen.findByRole('button', { name: '脚注二' }))     // ② 押下 E2（第 2 章）并开面板
      const panel = await screen.findByRole('dialog', { name: '注释' })
      const back = await screen.findByRole('button', { name: /返回原处/ })
      const atBack = deps.apiSend.mock.calls.length
      fireEvent.click(back)                                                   // ③ 工具栏返回：消费 E2
      expect(jumpedTo(deps, atBack)).toEqual([1])                             // 回到引用处（第 2 章）
      const atClose = deps.apiSend.mock.calls.length
      fireEvent.click(within(panel).getByRole('button', { name: '关闭' }))      // ④ 关面板
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '注释' })).toBeNull())
      // 返回动作的落位补写（settleJump 的同章比例确认）要等下一拍测量帧，可能晚于关面板才到。
      // 它记的仍是当前章，不是「替用户跳」——只钉「关面板之后出现别的章」；回归的旧形状是
      // 弹掉 E1、把主序列送回上一章（按章号断言，迟到确认不算数，CI 上不再谁先到谁说话）。
      expect(jumpedTo(deps, atClose).filter((i) => i !== 1)).toEqual([])
      expect(screen.getByRole('button', { name: /返回原处/ })).toBeTruthy()     // E1 还在（没被误消费）
    } finally {
      proto.getBoundingClientRect = original
    }
  })

  it('目录直接点进补充文档：开注释面板但不押返回项（没有引用处可回，关掉就只是关掉）', async () => {
    const deps = richDeps()
    render(richReader(deps))
    await screen.findByText('第一章第一段')
    fireEvent.click(screen.getByRole('button', { name: '目录' }))
    const dlg = await screen.findByRole('dialog', { name: '目录' })
    const before = deps.apiSend.mock.calls.length
    fireEvent.click(within(dlg).getByRole('button', { name: '附录' }))
    const panel = await screen.findByRole('dialog', { name: '注释' })
    await waitFor(() => expect(within(panel).getByText('脚注正文')).toBeTruthy())
    expect(deps.apiSend.mock.calls.length).toBe(before)                      // 目录导航不写进度
    expect(screen.queryByRole('button', { name: /返回原处/ })).toBeNull()     // 也不押「返回原处」

    fireEvent.click(within(panel).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '注释' })).toBeNull())
    expect(deps.apiSend.mock.calls.length).toBe(before)                      // 关掉不消费任何返回项、也不写进度
    expect(screen.queryByRole('button', { name: /返回原处/ })).toBeNull()
  })

  it('排版（字号）变化：按变化前的可见节点把视口拉回同一相对位置，同值再设不定位', async () => {
    // 接线钉：视图只剩「触发」——采点（`setPref` 的同步栈）与复位算式、miss/重采分支归
    // `reader-session.test.ts` 的「排版前采点与复位」族；这里钉的是排版 effect 真的把复位交到
    // 会话，且同值再设不重跑（effect 依赖仍是三个排版量）。jsdom 无排版：用**按读取次序改值**的
    // rect 桩顶替（第 1 次读=变化前、之后=重排后）；「字号变了正文停在同一句」只能由浏览器门证明。
    const proto = Element.prototype as unknown as { getBoundingClientRect: () => DOMRect }
    const original = proto.getBoundingClientRect
    let p1Reads = 0
    proto.getBoundingClientRect = function (this: Element): DOMRect {
      const node = this.getAttribute('data-novel-node')
      // 只有 p1/p2 给出有意义的 top；其余（链接等）排在视口之下就不会被当成「可见节点」
      const top = node === 'p1' ? (++p1Reads === 1 ? -50 : -70) : node === 'p2' ? 300 : 400
      return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) }
    }
    try {
      const deps = richDeps()
      render(richReader(deps))
      await screen.findByText('第一章第一段')
      scrollTo.mockClear()
      setPref({ fontSize: 22 })                                              // 采点在 setPref 的同步栈里发生
      await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(1))          // 重排后的复位
      expect(pick(pick(scrollTo.mock.calls, 0), 1)).toBe(-70 + 50)           // 重排后 -70，采点时为 -50
      setPref({ fontSize: 22 })                                              // 同值再设一次：不重排、不定位
      await new Promise((r) => setTimeout(r, 20))
      expect(scrollTo).toHaveBeenCalledTimes(1)
    } finally {
      proto.getBoundingClientRect = original
      setPref({ fontSize: 18 })
    }
  })

  /** 持久导入说明（`GET local/warnings`）：导入时落盘的 warnings 是这本书的真实状态，
   *  切走后回来看不到就等于没说过——入口随书取一次，有告警才出现（无警告不新增干扰），
   *  点开复用注释面板的浮层几何（.novel-notes，自带上限与内滚）。 */
  const degraded: LocalImportWarning = {
    code: 'epub-degraded-anchor', resource: 'OEBPS/ch1.xhtml',
    message: '正文链接的目标锚点随被剥离的内容（内联 SVG 等）一起消失，已降级成纯文本：OEBPS/ch1.xhtml#f1',
  }
  const withWarnings = (list: LocalImportWarning[]): FakeReaderDeps => richDeps({
    apiGet: vi.fn(async (p: string) => {
      if (p.includes('local/warnings')) return list
      if (p.includes('navigation')) return { chapters, items: navItems }
      if (p.includes('local/document')) return { kind: 'text', text: '脚注正文' }
      if (p.includes('chapter')) {
        const index = Number(new URLSearchParams(p.split('?')[1] ?? '').get('index'))
        return index === 1 ? rich1 : index === 2 ? rich2 : rich0
      }
      return []
    }),
  })

  it('导入说明：本地书有持久警告才出入口，点开可重看、可关掉', async () => {
    const deps = withWarnings([degraded])
    render(richReader(deps))
    await screen.findByText('第一章第一段')
    const before = deps.apiSend.mock.calls.length
    fireEvent.click(await screen.findByRole('button', { name: '导入说明' }))
    const panel = await screen.findByRole('dialog', { name: '导入说明' })
    expect(within(panel).getByText(/导入说明（1 条）/)).toBeTruthy()
    expect(within(panel).getByText(/已降级成纯文本/)).toBeTruthy()
    expect(within(panel).getByText('epub-degraded-anchor')).toBeTruthy()
    fireEvent.click(within(panel).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '导入说明' })).toBeNull())
    expect(deps.apiSend.mock.calls.length).toBe(before)                      // 看说明不写任何进度
  })

  it('导入说明：没有警告的本地书不出入口（正常无警告不新增干扰）', async () => {
    const deps = richDeps()                                                   // 缺省假实现把 local/warnings 答成 []
    render(richReader(deps))
    await screen.findByText('第一章第一段')
    await waitFor(() => expect(deps.apiGet.mock.calls.map((c) => String(c[0])).join('\n')).toContain('local/warnings'))
    expect(screen.queryByRole('button', { name: '导入说明' })).toBeNull()
  })
})

describe('NovelView 顶部 tab 导航（书架|书城|书源管理 并列；不注册 settings.section，书源管理归属主界面）', () => {
  // routeStore 是模块级全局现场——本组每条测完复位 shelf，防止污染后续依赖默认路由的断言
  afterEach(() => { navigate({ name: 'shelf' }) })

  it('点 tab 切换分支：书城=分类浏览页；书源管理=设置区块渲染在小说视图内；书架=回首页', async () => {
    render(createElement(NovelView))
    const tabs = () => within(screen.getByRole('group', { name: '小说视图导航' }))
    // 默认书架：tab 组在场（书架 tab 激活）+ 书架内容渲染（搜索框常驻，与加载态无关）
    expect(tabs().getByRole('button', { name: '书架' }).getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(screen.getByPlaceholderText(/搜书名/)).toBeTruthy())
    // 「搜索」提交钮在场：与搜索页同款口径（Enter 是隐藏交互，可见按钮才是显式入口）
    expect(screen.getByRole('button', { name: '搜索' })).toBeTruthy()
    // 书城：CityView 分类浏览页（左栏一条源列表，源筛选框常驻），书架内容已卸载
    fireEvent.click(tabs().getByRole('button', { name: '书城' }))
    await waitFor(() => expect(screen.getByPlaceholderText('搜索书源')).toBeTruthy())
    expect(screen.queryByPlaceholderText(/搜书名/)).toBeNull()
    // 书源管理：SettingsSection（书源管理整块）渲染在小说视图内
    fireEvent.click(tabs().getByRole('button', { name: '书源管理' }))
    await waitFor(() => expect(document.querySelector('[data-novel-view="sources"]')).not.toBeNull())
    expect(screen.queryByPlaceholderText('搜索书源')).toBeNull()
    // 回书架：首页内容回来
    fireEvent.click(tabs().getByRole('button', { name: '书架' }))
    await waitFor(() => expect(screen.getByPlaceholderText(/搜书名/)).toBeTruthy())
  })
})
