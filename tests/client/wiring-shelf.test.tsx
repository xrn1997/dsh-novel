// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { navigate, routeStore } from '../../src/client/store.js'
import { ShelfView } from '../../src/client/views/ShelfView.js'
import { ProbePane } from '../../src/client/views/SettingsSection.js'
import type { LocalImportResponse, LocalImportWarning } from '../../src/client/views/types.js'
import { must } from '../support/fixture.js'
import { makeDeps } from './fake-deps.js'
import type { FakeSettingsDeps } from './fake-deps.js'
import { coreDeps, installWiringLifecycle } from './wiring-harness.js'

/**
 * 书架与试跑器的接线：加载/删除/导入的失败形态不许伪装成空态，导入回执的持久警告就地交代，
 * 落架账与封面失败表挂在视图之上而不是某一张卡里。依赖束全部走注入的 deps。
 */

installWiringLifecycle()

describe('ProbePane：失败显式呈现（缺 rejection handler 就永久停在「探针执行中…」）', () => {
  const probeDeps = (apiSend: unknown): FakeSettingsDeps => makeDeps({ apiSend })

  it('请求失败 → 显示错误卡，不许假死在执行中', async () => {
    const deps = probeDeps(vi.fn(() => Promise.reject(new Error('路由 404（请重启 DSH）'))))
    render(createElement(ProbePane, { sourceId: 's1', onBack: () => {}, deps }))
    // 初始：执行中（请求在途）
    expect(screen.getByText(/探针执行中/)).toBeTruthy()
    // 失败落地：错误显式呈现（执行中态不许留住）
    await waitFor(() => expect(screen.getByText(/探针请求失败/)).toBeTruthy())
    expect(screen.queryByText(/探针执行中/)).toBeNull()
  })

  it('成功路径不受影响：结果卡照常渲染', async () => {
    const deps = probeDeps(vi.fn(async () => ({ ok: true, itemCount: 3, firstTitle: '斗罗', probedAt: 1 })))
    render(createElement(ProbePane, { sourceId: 's1', onBack: () => {}, deps }))
    await waitFor(() => expect(screen.getByText(/命中 3 条/)).toBeTruthy())
  })
})

describe('ShelfView 接线（deps seam 驱动）', () => {
  const book = {
    bookKey: 'k1', sourceId: 's1', title: '斗罗', addedAt: 1,
    progress: { chapterIndex: 0, offsetRatio: 0, updatedAt: 1 },
  }

  /** EPUB 导入：上传面收 TXT 与 EPUB 两种格式，导入回执还要把**持久 warnings**
   *  交代出来——它们是这本书的真实状态（被剥离的活动内容、降级的锚点），跳过就等于吞掉。 */
  const epubFile = (): File => new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], '图文书.epub', { type: 'application/epub+zip' })
  const localImport = (over: Partial<LocalImportResponse> = {}): LocalImportResponse => ({
    bookKey: 'local:u1', sourceId: '__local__', title: '斗罗', addedAt: 1,
    progress: { chapterIndex: 0, offsetRatio: 0, updatedAt: 1 },
    chapterCount: 3, format: 'epub', encoding: null, warnings: [],
    ...over,
  })
  const svgWarning: LocalImportWarning = {
    code: 'epub-removed-inline-svg', resource: 'OEBPS/ch1.xhtml',
    message: '2 处：正文内联 SVG 已剥离（装饰图形不参与阅读）',
  }

  it('加载失败 → 显示错误而非「书架空空」误导性空态', async () => {
    const deps = coreDeps({ apiGet: vi.fn(() => Promise.reject(new Error('网络断了'))) })
    render(createElement(ShelfView, { deps }))
    await waitFor(() => expect(screen.getByText(/书架加载失败/)).toBeTruthy())
    expect(screen.queryByText(/书架空空/)).toBeNull()    // 失败不许伪装成空架
  })

  it('空架（真零本）仍显示引导空态', async () => {
    const deps = coreDeps({ apiGet: vi.fn(async () => []) })
    render(createElement(ShelfView, { deps }))
    await waitFor(() => expect(screen.getByText(/书架空空/)).toBeTruthy())
  })

  it('删除失败 → 卡片保留 + 错误呈现（乐观删除的回滚半场）', async () => {
    let call = 0
    const deps = coreDeps({
      apiGet: vi.fn(async () => [book]),
      apiSend: vi.fn(() => { call++; return Promise.reject(new Error('删不动')) }),
    })
    render(createElement(ShelfView, { deps }))
    await waitFor(() => expect(screen.getByText('斗罗')).toBeTruthy())
    fireEvent.click(screen.getByTitle('删除本书'))
    fireEvent.click(screen.getByText('确认删除'))
    await waitFor(() => expect(screen.getByText(/删除失败/)).toBeTruthy())
    expect(call).toBe(1)
    expect(screen.getByText('斗罗')).toBeTruthy()         // 卡片还在（本地过滤只在成功后）
  })

  it('删除确认是模态：✕ 弹对话框；Esc 取消关闭且不发 DELETE', async () => {
    const deps = coreDeps({ apiGet: vi.fn(async () => [book]), apiSend: vi.fn() })
    render(createElement(ShelfView, { deps }))
    await waitFor(() => expect(screen.getByText('斗罗')).toBeTruthy())
    fireEvent.click(screen.getByTitle('删除本书'))
    // 模态在场：role=dialog + 确认文案带书名（deleteBookCopy 口径）
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('删除《斗罗》？')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(deps.apiSend).not.toHaveBeenCalled()           // 取消不许发出删除请求
    expect(screen.getByText('斗罗')).toBeTruthy()
  })

  it('删除确认模态：点遮罩取消同样零请求', async () => {
    const deps = coreDeps({ apiGet: vi.fn(async () => [book]), apiSend: vi.fn() })
    render(createElement(ShelfView, { deps }))
    await waitFor(() => expect(screen.getByText('斗罗')).toBeTruthy())
    fireEvent.click(screen.getByTitle('删除本书'))
    fireEvent.click(must(document.querySelector('.novel-modal-mask'), '确认模态的遮罩'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(deps.apiSend).not.toHaveBeenCalled()
  })

  /** 来源投影（服务端读取时 join 出 sourceName）：卡片显示源名；源被删 → 灰字「来源已删除」；
   *  本地书不出 chip（本地身份归封面底左槽位的「本地」，见下一颗）。 */
  it('来源 chip：显示源名；join 不到 → 「来源已删除」；本地书不出 chip', async () => {
    const deps = coreDeps({
      apiGet: vi.fn(async () => [
        { ...book, bookKey: 'k1', title: '斗罗', sourceName: '笔趣阁' },
        { ...book, bookKey: 'k2', title: '剑来', sourceName: null },
        { ...book, bookKey: 'local:u1', title: '本地书', sourceId: '__local__', sourceName: null },
      ]),
    })
    render(createElement(ShelfView, { deps }))
    await waitFor(() => expect(screen.getByText('斗罗')).toBeTruthy())
    expect(screen.getByText('笔趣阁')).toBeTruthy()
    expect(screen.getByText('来源已删除')).toBeTruthy()
    const localCell = must([...document.querySelectorAll('.novel-cell')]
      .find((c) => c.textContent.includes('本地书')), '本地书那张卡片')
    expect(localCell.querySelector('.novel-src-tag')).toBeNull()
  })

  /** 封面底左槽位的机制钉（几何读数住 tests/browser/shelf-nowplaying-layout.test.tsx）：
   *  在线 = 来源 chip、本地 = 「本地」，同住 `.novel-cover-foot` 一层、由 shelfSourceTag 判据互斥。
   *  多选态只动顶左那一角（「正在听」让位给勾选标记），底左的出处身份照常在场——这条行为随
   *  「本地」从顶左挪到底左而变（挪之前它给勾选让位），所以必须钉住，不能让几何门独跑。 */
  it('「本地」与来源 chip 同住封面底左；多选态不撤出处身份', async () => {
    const deps = coreDeps({
      apiGet: vi.fn(async () => [
        { ...book, bookKey: 'k1', title: '斗罗', sourceName: '笔趣阁' },
        { ...book, bookKey: 'local:u1', title: '本地书', sourceId: '__local__', sourceName: null },
      ]),
    })
    render(createElement(ShelfView, { deps }))
    await waitFor(() => expect(screen.getByText('斗罗')).toBeTruthy())
    const cellOf = (title: string): Element => must([...document.querySelectorAll('.novel-cell')]
      .find((c) => c.textContent.includes(title)), `「${title}」那张卡片`)
    expect(must(cellOf('本地书').querySelector('.novel-cover-foot .novel-local-tag'),
      '本地书底左的「本地」').textContent).toBe('本地')
    expect(must(cellOf('斗罗').querySelector('.novel-cover-foot .novel-src-tag'),
      '在线书底左的来源 chip').textContent).toContain('笔趣阁')

    act(() => { fireEvent.click(screen.getByText('选择')) })
    expect(cellOf('本地书').querySelector('.novel-check'), '多选态：顶左归勾选标记').not.toBeNull()
    expect(cellOf('本地书').querySelector('.novel-cover-foot .novel-local-tag'),
      '多选态：底左出处身份不撤').not.toBeNull()

    act(() => { fireEvent.click(screen.getByText('退出')) })
    expect(cellOf('本地书').querySelector('.novel-cover-foot .novel-local-tag'),
      '退出多选态：照常在场').not.toBeNull()
  })

  /** 本地 TXT 导入：上传是异步的，落地那一刻用户可能已经不在书架（切 tab / 去书源管理）。 */
  const txtFile = (): File => new File(['第一章\n正文'], '斗罗.txt', { type: 'text/plain' })
  /** TXT 回执（无告警）：格式/章数/警告面都是服务端回执的一部分，桩要与 wire 同形 */
  const imported = localImport({ title: '斗罗', format: 'txt', chapterCount: 1, encoding: 'utf-8' })

  it('本地 TXT 导入：仍在书架时，成功即进阅读器（既有行为回归钉）', async () => {
    navigate({ name: 'shelf' })
    const deps = coreDeps({
      apiGet: vi.fn(async () => []),
      apiUpload: vi.fn(async () => imported),
    })
    render(createElement(ShelfView, { deps }))
    fireEvent.change(must(document.querySelector('.novel-file-hidden'), '上传入口'), { target: { files: [txtFile()] } })
    await waitFor(() => expect(routeStore.get().route.name).toBe('reader'))
    navigate({ name: 'shelf' })                       // 路由是模块级 store，测后必须复位
  })

  it('导入落地时用户已切走 → 不许越权把他拽进阅读器，改进 ok 泳道', async () => {
    navigate({ name: 'shelf' })
    let settle: (v: unknown) => void = () => {}
    const pushOk = vi.fn()
    const deps = coreDeps({
      apiGet: vi.fn(async () => []),
      apiUpload: vi.fn(() => new Promise((res) => { settle = res })),
      pushOk,
    })
    const view = render(createElement(ShelfView, { deps }))
    fireEvent.change(must(document.querySelector('.novel-file-hidden'), '上传入口'), { target: { files: [txtFile()] } })
    view.unmount()
    navigate({ name: 'sources' })                     // 用户自己去了别处
    settle(imported)
    await new Promise((r) => setTimeout(r, 20))
    expect(routeStore.get().route.name).toBe('sources')          // 不被强行拽进 reader
    expect(pushOk).toHaveBeenCalledWith(expect.stringContaining('斗罗'))  // 但成功要有交代
    navigate({ name: 'shelf' })
  })

  it('导入失败且用户已切走 → 错误进 error 泳道，不落空', async () => {
    navigate({ name: 'shelf' })
    let reject: (e: unknown) => void = () => {}
    const pushError = vi.fn()
    const deps = coreDeps({
      apiGet: vi.fn(async () => []),
      apiUpload: vi.fn(() => new Promise((_res, rej) => { reject = rej })),
      pushError,
    })
    const view = render(createElement(ShelfView, { deps }))
    fireEvent.change(must(document.querySelector('.novel-file-hidden'), '上传入口'), { target: { files: [txtFile()] } })
    view.unmount()
    reject(new Error('文件读不动'))
    await new Promise((r) => setTimeout(r, 20))
    expect(pushError).toHaveBeenCalledWith(expect.stringContaining('文件读不动'))
    navigate({ name: 'shelf' })
  })

  it('导入入口收 .txt 与 .epub（accept 是用户唯一的格式提示）', async () => {
    const deps = coreDeps({ apiGet: vi.fn(async () => []) })
    render(createElement(ShelfView, { deps }))
    const input = document.querySelector('.novel-file-hidden') as HTMLInputElement
    // 卡片随空架加载完成才渲染（加载中是骨架）
    await waitFor(() => expect(screen.getByText('导入 TXT / EPUB')).toBeTruthy())
    expect(input.accept).toContain('.txt')
    expect(input.accept).toContain('.epub')
  })

  it('导入带回持久警告：不自动跳阅读器，就地把服务端书名/作者与格式交代清楚', async () => {
    navigate({ name: 'shelf' })
    const deps = coreDeps({
      apiGet: vi.fn(async () => []),
      apiUpload: vi.fn(async () => localImport({ title: '图文书', author: '作者甲', warnings: [svgWarning] })),
    })
    render(createElement(ShelfView, { deps }))
    fireEvent.change(must(document.querySelector('.novel-file-hidden'), '上传入口'), { target: { files: [epubFile()] } })
    await waitFor(() => expect(screen.getByText(/图文书/)).toBeTruthy())
    expect(routeStore.get().route.name).toBe('shelf')                    // 跳走就把交代吞了
    expect(screen.getByText(/作者甲/)).toBeTruthy()                       // 服务端真相，不是本地猜的书名
    expect(screen.getByText(/EPUB · 3 章/)).toBeTruthy()                  // 格式来自服务端 format 字段
    expect(screen.getByText(/导入说明（1 条）/)).toBeTruthy()
    expect(screen.getByText(/正文内联 SVG 已剥离/)).toBeTruthy()
    fireEvent.click(screen.getByText('开始阅读'))                          // 交代完了，入口仍在
    expect(routeStore.get().route.name).toBe('reader')
    navigate({ name: 'shelf' })
  })

  it('无警告的导入一字不动：成功即进阅读器，且书架上不多一块提示', async () => {
    navigate({ name: 'shelf' })
    const deps = coreDeps({
      apiGet: vi.fn(async () => []),
      apiUpload: vi.fn(async () => localImport()),
    })
    render(createElement(ShelfView, { deps }))
    fireEvent.change(must(document.querySelector('.novel-file-hidden'), '上传入口'), { target: { files: [epubFile()] } })
    await waitFor(() => expect(routeStore.get().route.name).toBe('reader'))
    expect(screen.queryByText(/导入说明（/)).toBeNull()
    navigate({ name: 'shelf' })
  })

  it('导入回执的封面挂图 → 落「本地」占位（复用卡片的 imgFailed，不显破图）', async () => {
    navigate({ name: 'shelf' })
    const cover = '/novel-api/local/resource?id=local%3Au1&resourceId=r0'
    const deps = coreDeps({
      apiGet: vi.fn(async () => []),
      apiUpload: vi.fn(async () => localImport({ coverUrl: cover, warnings: [svgWarning] })),
    })
    render(createElement(ShelfView, { deps }))
    fireEvent.change(must(document.querySelector('.novel-file-hidden'), '上传入口'), { target: { files: [epubFile()] } })
    await waitFor(() => expect(screen.getByText(/导入说明（1 条）/)).toBeTruthy())
    const note = must(document.querySelector('.novel-import-note'), '导入回执行')
    const img = note.querySelector('img.novel-cover') as HTMLImageElement
    expect(img.getAttribute('src')).toBe(cover)
    // 资源文件被清掉 → img 挂图：回执与卡片同一条降级路（占位而不是破图）
    fireEvent.error(img)
    await waitFor(() => expect(note.querySelector('img.novel-cover')).toBeNull())
    expect(note.querySelector('.novel-cover-fallback')?.textContent).toBe('本地')
    navigate({ name: 'shelf' })
  })

  it('封面挂图后一次成功的书架重取 → 失败表清空、封面重试（一次瞬时失败不许永久降级）', async () => {
    navigate({ name: 'shelf' })
    const cover = '/novel-api/local/resource?id=local%3Au1&resourceId=r0'
    const shelfBook = { ...book, bookKey: 'local:u1', sourceId: '__local__', sourceName: null, title: '有封面', coverUrl: cover }
    const deps = coreDeps({
      apiGet: vi.fn(async () => [shelfBook]),
      // 带持久警告的导入留在本页 → 收尾会触发一次书架重取（这是唯一的第二次读面）
      apiUpload: vi.fn(async () => localImport({ title: '新书', warnings: [svgWarning] })),
    })
    render(createElement(ShelfView, { deps }))
    await waitFor(() => expect(screen.getByText('有封面')).toBeTruthy())
    const cellImg = (): HTMLImageElement | null => document.querySelector('.novel-cell img.novel-cover')
    fireEvent.error(must(cellImg(), '有封面那张卡的封面图'))   // 一次坏图 → 这张卡降级为首字块
    await waitFor(() => expect(cellImg()).toBeNull())
    fireEvent.change(must(document.querySelector('.novel-file-hidden'), '上传入口'), { target: { files: [txtFile()] } })
    // 读面成功（落点 = 'ok'）才清失败表；判据取「这一发的落点」而不是投影里的旧读数
    await waitFor(() => expect(cellImg(), '读面成功就该重试封面，而不是永久降级').not.toBeNull())
    navigate({ name: 'shelf' })
  })

  it('本地书有封面走已有封面 img 分支；无封面仍是本地占位（不发明第二条封面路）', async () => {
    const cover = '/novel-api/local/resource?id=local%3Au1&resourceId=r0'
    const deps = coreDeps({
      apiGet: vi.fn(async () => [
        { ...book, bookKey: 'local:u1', sourceId: '__local__', sourceName: null, title: '有封面', coverUrl: cover },
        { ...book, bookKey: 'local:u2', sourceId: '__local__', sourceName: null, title: '无封面' },
      ]),
    })
    render(createElement(ShelfView, { deps }))
    await waitFor(() => expect(screen.getByText('有封面')).toBeTruthy())
    const cells = [...document.querySelectorAll('.novel-cell')]
    const withCover = must(cells.find((c) => c.textContent.includes('有封面')), '有封面那张卡')
    const img = withCover.querySelector<HTMLImageElement>('img.novel-cover')
    expect(img?.getAttribute('src')).toBe(cover)
    expect(withCover.querySelector('.novel-cover-fallback')).toBeNull()   // 有封面就不写「本地」占位
    const noCover = must(cells.find((c) => c.textContent.includes('无封面')), '无封面那张卡')
    expect(noCover.querySelector('img.novel-cover')).toBeNull()
    expect(noCover.querySelector('.novel-cover-fallback')?.textContent).toBe('本地')
  })
})
