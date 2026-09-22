// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { createElement, StrictMode } from 'react'
import { ApiClientError } from '../../src/client/api.js'
import { ProbePane } from '../../src/client/views/SettingsSection.js'
import { SettingsSection } from '../../src/client/views/SettingsSection.js'
import { NovelView } from '../../src/client/views/NovelView.js'
import { ReaderView } from '../../src/client/views/ReaderView.js'
import { ShelfView } from '../../src/client/views/ShelfView.js'
import { SearchView } from '../../src/client/views/SearchView.js'
import { resetSourceInboxUi } from '../../src/client/source-inbox-ui.js'
import { resetJobSurface, useJobPolling } from '../../src/client/jobs.js'
import { navigate, routeStore } from '../../src/client/store.js'
import { ROUTES, queries } from '../../src/shared/wire.js'
import type { SearchJobSnapshot } from '../../src/shared/wire.js'
import { makeCoreDeps, makeDeps, makeReaderDeps } from './fake-deps.js'
import type { CoreDepsOverrides, FakeCoreDeps, FakeReaderDeps, FakeSettingsDeps, ReaderDepsOverrides, SettingsDepsOverrides } from './fake-deps.js'
import type { JobState, SourcePublic } from '../../src/client/views/types.js'

/**
 * 接线层交互测试·第二梯队：
  * deps seam 此前只盖设置区——书架/搜索的接线（陈旧回调、乐观删除、误导性空态）
 * 与试跑器（失败假死）仍是 bug 巢穴且无 seam。本文件用核心依赖束（ClientCoreDeps）
 * 驱动这些历史 bug 形态，逐条钉死。桩工厂统一到 fake-deps.ts。
 */

const coreDeps = (over: CoreDepsOverrides): FakeCoreDeps => makeCoreDeps(over)

afterEach(cleanup)

describe('ProbePane：失败显式呈现（历史 bug：.then(setResult) 无 rejection handler → 永久「探针执行中…」）', () => {
  const probeDeps = (apiSend: unknown): FakeSettingsDeps => makeDeps({ apiSend })

  it('请求失败 → 显示错误卡，不再假死在执行中', async () => {
    const deps = probeDeps(vi.fn(() => Promise.reject(new Error('路由 404（请重启 DSH）'))))
    render(createElement(ProbePane, { sourceId: 's1', onBack: () => {}, deps }))
    // 初始：执行中（请求在途）
    expect(screen.getByText(/探针执行中/)).toBeTruthy()
    // 失败落地：错误显式呈现（不再永久执行中）
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

  it('加载失败 → 显示错误而非「书架空空」误导性空态（历史 bug 钉死）', async () => {
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
    fireEvent.click(document.querySelector('.novel-modal-mask')!)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(deps.apiSend).not.toHaveBeenCalled()
  })

  /** 来源投影（服务端读取时 join 出 sourceName）：卡片显示源名；源被删 → 灰字「来源已删除」；
   *  本地书不出 chip（本地身份已由封面「本地」与角标承担）。 */
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
    const localCell = [...document.querySelectorAll('.novel-cell')]
      .find((c) => c.textContent?.includes('本地书'))!
    expect(localCell.querySelector('.novel-src-tag')).toBeNull()
  })

  /** 本地 TXT 导入：上传是异步的，落地那一刻用户可能已经不在书架（切 tab / 去书源管理）。 */
  const txtFile = (): File => new File(['第一章\n正文'], '斗罗.txt', { type: 'text/plain' })
  const imported = { bookKey: 'local:u1', title: '斗罗', sourceId: '__local__' }

  it('本地 TXT 导入：仍在书架时，成功即进阅读器（既有行为回归钉）', async () => {
    navigate({ name: 'shelf' })
    const deps = coreDeps({
      apiGet: vi.fn(async () => []),
      apiUpload: vi.fn(async () => imported),
    })
    render(createElement(ShelfView, { deps }))
    fireEvent.change(document.querySelector('.novel-file-hidden')!, { target: { files: [txtFile()] } })
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
    fireEvent.change(document.querySelector('.novel-file-hidden')!, { target: { files: [txtFile()] } })
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
    fireEvent.change(document.querySelector('.novel-file-hidden')!, { target: { files: [txtFile()] } })
    view.unmount()
    reject(new Error('文件读不动'))
    await new Promise((r) => setTimeout(r, 20))
    expect(pushError).toHaveBeenCalledWith(expect.stringContaining('文件读不动'))
    navigate({ name: 'shelf' })
  })
})

/** 命中分组桩（`SearchGroup` 的最小可渲染形态）。
 *  `sourceId` 一轮内必须一源一个：服务端 `searchProgressive` 对每个源只 `emit` 一组，分组在
 *  `SearchView` 里按 `key={g.sourceId}` 渲染——同一轮塞两个同 id 的桩等于造出对面协议给不出的形状
 *  （React 会报 duplicate key）。多组用例显式传第二个 id。 */
const hitGroup = (title: string, sourceId = 's1') => ({
  sourceId, sourceName: 'S', status: 'verified' as const,
  hits: [{ title, author: null, url: 'https://s.com/book/1', coverUrl: null, intro: null, lastChapterName: null, kind: null, wordCount: null }],
})

/** 后台搜索任务快照桩：默认「已结束、一家源、零增量」，各用例只覆写自己在意的那几项 */
const snap = (over: Partial<SearchJobSnapshot> = {}): SearchJobSnapshot => ({
  id: 'j1', keyword: '斗罗', phase: 'done', cancelled: false, total: 1, done: 1, added: [], next: 0, startedAt: 0, ...over,
})

describe('SearchView 接线：聚合搜索走后台任务（提交一次 + 游标读快照）', () => {
  it('提交 = POST search/job，此后只读 job-status——浏览器半不再打批请求', async () => {
    let submitted = false
    const reads: string[] = []
    const deps = coreDeps({
      apiSend: vi.fn(async () => { submitted = true; return { jobId: 'j1' } }),
      apiGet: vi.fn(async (path: string) => {
        reads.push(path)
        return { job: submitted ? snap({ added: [hitGroup('后台命中')], next: 1 }) : null }
      }),
    })
    render(createElement(SearchView, { deps }))
    fireEvent.change(screen.getByPlaceholderText('书名 / 作者'), { target: { value: '斗罗' } })
    fireEvent.submit(screen.getByRole('form'))
    await waitFor(() => expect(screen.getByText('后台命中')).toBeTruthy())
    expect(deps.apiSend).toHaveBeenCalledWith('POST', ROUTES.searchJob.path, { keyword: '斗罗' })
    // 全部读取都是快照：没有任何一次 search?keyword= 的批请求从浏览器半发出
    expect(reads.every((r) => r.startsWith(`${ROUTES.searchJobStatus.path}?`))).toBe(true)
  })

  it('挂载即恢复：服务端持有本轮结果 → 直接渲染且不重新提交', async () => {
    const deps = coreDeps({
      apiGet: vi.fn(async () => ({
        job: snap({ keyword: '上一轮', phase: 'done', added: [hitGroup('上一轮的命中')], next: 1 }),
      })),
    })
    render(createElement(SearchView, { deps }))
    await waitFor(() => expect(screen.getByText('上一轮的命中')).toBeTruthy())
    expect(deps.apiSend).not.toHaveBeenCalled()          // 恢复不是重打：一轮都不必提交
    expect(screen.getByText(/本轮搜过/)).toBeTruthy()     // 收尾留痕同样从快照复算
  })

  it('陈旧快照防线：第二轮落地后，第一轮的迟到响应不许污染结果', async () => {
    let posts = 0
    let resolveStale: (v: unknown) => void = () => {}
    const deps = coreDeps({
      apiSend: vi.fn(async () => { posts++; return { jobId: posts === 1 ? 'A' : 'B' } }),
      apiGet: vi.fn((path: string) => {
        if (path !== `${ROUTES.searchJobStatus.path}?since=0`) return Promise.resolve({ job: null })
        if (posts === 0) return Promise.resolve({ job: null })                  // 挂载读：还没有任务
        if (posts === 1) return new Promise((res) => { resolveStale = res })     // 第一轮首拍挂起
        return Promise.resolve({                                               // 第二轮秒回且已终态
          job: snap({ id: 'B', keyword: '第二', added: [hitGroup('第二轮书')], next: 1 }),
        })
      }),
    })
    render(createElement(SearchView, { deps }))
    const input = screen.getByPlaceholderText('书名 / 作者')
    fireEvent.change(input, { target: { value: '第一轮' } })
    fireEvent.submit(screen.getByRole('form'))
    await waitFor(() => expect(deps.apiGet).toHaveBeenCalledTimes(2))            // 挂载读 + 第一轮首拍
    fireEvent.change(input, { target: { value: '第二轮' } })
    fireEvent.submit(screen.getByRole('form'))
    await waitFor(() => expect(screen.getByText('第二轮书')).toBeTruthy())

    resolveStale({ job: snap({ id: 'A', keyword: '第一轮', added: [hitGroup('第一轮书')], next: 1 }) })
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText('第一轮书')).toBeNull()
    expect(screen.getByText('第二轮书')).toBeTruthy()
  })

  it('空参与集与「搜了没命中」分得清：total=0 → 引导导入书源；total>0 零分组 → 换关键词', async () => {
    const view = render(createElement(SearchView, {
      deps: coreDeps({ apiGet: vi.fn(async () => ({ job: snap({ total: 0, done: 0, next: 0 }) })) }),
    }))
    await waitFor(() => expect(screen.getByText(/没有参与搜索的书源/)).toBeTruthy())
    view.unmount()
    render(createElement(SearchView, {
      deps: coreDeps({ apiGet: vi.fn(async () => ({ job: snap({ added: [], next: 0 }) })) }),
    }))
    await waitFor(() => expect(screen.getByText('没有结果')).toBeTruthy())
  })

  it('读面失败：显式「搜索中断」且不再排下一次轮询（历史形态：spinner 到天荒地老）', async () => {
    let reads = 0
    const deps = coreDeps({
      apiGet: vi.fn(async () => {
        reads++
        if (reads === 1) return { job: null }                 // 挂载读：还没有任务
        throw new Error('连接断了')                            // 提交后的首拍失败
      }),
      apiSend: vi.fn(async () => ({ jobId: 'j1' })),
    })
    render(createElement(SearchView, { deps }))
    fireEvent.change(screen.getByPlaceholderText('书名 / 作者'), { target: { value: '斗罗' } })
    fireEvent.submit(screen.getByRole('form'))
    await waitFor(() => expect(screen.getByText(/搜索中断：搜索结果读取失败：连接断了/)).toBeTruthy())
    await new Promise((r) => setTimeout(r, 900))
    expect(reads).toBe(2)                                     // 读不到就收手：不再刷屏
  })

  it('提交失败：如实报错，且不清掉已在手上的上一轮结果', async () => {
    const deps = coreDeps({
      apiGet: vi.fn(async () => ({ job: snap({ keyword: '上一轮', added: [hitGroup('上一轮命中')], next: 1 }) })),
      apiSend: vi.fn(async () => { throw new Error('服务未挂载') }),
    })
    render(createElement(SearchView, { deps }))
    await waitFor(() => expect(screen.getByText('上一轮命中')).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText('书名 / 作者'), { target: { value: '斗罗' } })
    fireEvent.submit(screen.getByRole('form'))
    await waitFor(() => expect(screen.getByText(/搜索提交失败：服务未挂载/)).toBeTruthy())
    expect(screen.getByText('上一轮命中')).toBeTruthy()        // 服务端没起新轮 → 旧结果仍是真相
  })

  it('停止搜索：跑着才有钮、点它只发 job-cancel、已搜出的命中留着且不报红条', async () => {
    const frames: Array<(data: string) => void> = []
    const deps = coreDeps({
      apiSend: vi.fn(async () => ({ jobId: 'j1' })),
      apiGet: vi.fn(async () => ({ job: null })),
      apiEventStream: vi.fn(async (_p: string, onFrame: (d: string) => void) => {
        frames.push(onFrame)
        return new Promise<void>(() => {})              // 流一直开着：读数只可能来自帧
      }),
    })
    render(createElement(SearchView, { deps }))
    expect(screen.queryByRole('button', { name: '停止搜索' })).toBeNull()   // 还没这一轮：不给死钮
    fireEvent.change(screen.getByPlaceholderText('书名 / 作者'), { target: { value: '斗罗' } })
    fireEvent.submit(screen.getByRole('form'))
    await waitFor(() => expect(frames.length).toBe(1))
    // 提交后立刻有钮（不必等第一帧）：用户随时可以说「别再往下搜了」
    expect(screen.getByRole('button', { name: '停止搜索' })).toBeTruthy()
    frames[0](JSON.stringify({ job: snap({ phase: 'running', total: 3, done: 1, next: 1, added: [hitGroup('先回来的书')] }) }))
    await waitFor(() => expect(screen.getByText('先回来的书')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '停止搜索' }))
    expect(deps.apiSend).toHaveBeenLastCalledWith('POST', ROUTES.searchJobCancel.path, {})
    frames[0](JSON.stringify({ job: snap({ phase: 'failed', cancelled: true, error: '任务已取消：用户停止了搜索',
      total: 3, done: 2, next: 2, added: [hitGroup('停止前又回来一本', 's2')] }) }))
    await waitFor(() => expect(screen.getByText(/已停止 · 本轮搜过/)).toBeTruthy())
    // 收口数字只算**真搜完的**：计划 3 家、停止前只回来 2 组，就不许报「搜过 3 家」；
    // 进度条同理，停止的轮次不倒填 100%（真机实测出的谎报：431 家计划 / 29 家实搜）
    expect(screen.getByText(/本轮搜过/).textContent).toMatch(/本轮搜过 2 家/)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('67')
    expect(screen.getByText('先回来的书')).toBeTruthy()               // 停止 ≠ 放弃已经搜出来的
    expect(screen.getByText('停止前又回来一本')).toBeTruthy()
    expect(screen.queryByText(/搜索中断/)).toBeNull()                 // 自己按的停止不是错误
    expect(screen.queryByRole('button', { name: '停止搜索' })).toBeNull()   // 收口行不留死钮
    expect(screen.getByRole('button', { name: '搜索' })).toBeTruthy()       // 再搜是新一轮
  })

  it('推送可用时读数从帧里来：本轮零次快照轮询，终态帧自己关流', async () => {
    let closed = false
    const frames: Array<(data: string) => void> = []
    const deps = coreDeps({
      apiSend: vi.fn(async () => ({ jobId: 'j1' })),
      apiGet: vi.fn(async () => ({ job: null })),                 // 只有挂载那一次读
      apiEventStream: vi.fn(async (_path: string, onFrame: (d: string) => void, signal: AbortSignal) => {
        frames.push(onFrame)
        await new Promise<void>((r) => signal.addEventListener('abort', () => { closed = true; r() }))
      }),
    })
    render(createElement(SearchView, { deps }))
    fireEvent.change(screen.getByPlaceholderText('书名 / 作者'), { target: { value: '斗罗' } })
    fireEvent.submit(screen.getByRole('form'))
    await waitFor(() => expect(frames.length).toBe(1))
    frames[0](JSON.stringify({ job: snap({ phase: 'running', total: 2, done: 1, next: 1, added: [hitGroup('推送来的书')] }) }))
    await waitFor(() => expect(screen.getByText('推送来的书')).toBeTruthy())
    await new Promise((r) => setTimeout(r, 900))                  // 越过两个 POLL_MS 节拍
    expect(deps.apiGet).toHaveBeenCalledTimes(1)                  // 一轮都没轮：流在，就不必问
    frames[0](JSON.stringify({ job: snap({ phase: 'done', total: 2, done: 2, next: 2, added: [hitGroup('收尾的书', 's2')] }) }))
    await waitFor(() => expect(screen.getByText(/本轮搜过/)).toBeTruthy())
    expect(screen.getByText('收尾的书')).toBeTruthy()
    await waitFor(() => expect(closed).toBe(true))                // 终态帧后自己关流，不留着占连接
  })
})

describe('SettingsSection 整壳接线（2026 调度台 IA：待办箱 + 弹层闭环；SettingsDeps 注入）', () => {
  const unverifiedSrc: SourcePublic = {
    id: 'u1', name: '未验源', baseUrl: 'https://u.com', enabled: true, groups: [],
    type: 'text', status: 'unverified', importedAt: 0, hasHeader: false, hasAuth: false, authExpired: false,
  }
  const brokenSrc: SourcePublic = {
    id: 'b1', name: '坏源甲', baseUrl: 'https://b.com', enabled: true, groups: [],
    type: 'text', status: 'broken', importedAt: 0, hasHeader: false, hasAuth: false, authExpired: false,
  }
  const doneImportJob: JobState = {
    id: 'imp1', kind: 'import', phase: 'done', total: 1, done: 1,
    counts: { ok: 1, failed: 0, dupSkipped: 0, replaced: 0 },
    issues: [], fileErrors: [], startedAt: 0,
  }
  const settingsDeps = (over: SettingsDepsOverrides = {}, sources: SourcePublic[] = [unverifiedSrc]): FakeSettingsDeps =>
    makeDeps({ apiGet: vi.fn(async (path: string) => (path === 'sources' ? sources : null)), ...over })

  // 忽略现场是模块级 store（source-inbox-ui.ts）：不复位会让上一个用例的「已忽略」漏进
  // 下一个用例的「卡该在」（先例 resetSourceListUi / resetTransient）；jobSurface 同理——
  // 本文件的验证编排用例经 useJobPolling 驱动真实轮询写镜像。
  beforeEach(() => { resetSourceInboxUi(); resetJobSurface() })

  it('源列表经 deps.apiGet 加载（整壳注入后子组件不吃 prodDeps 缺省）', async () => {
    const deps = settingsDeps()
    render(createElement(SettingsSection, { deps }))
    await waitFor(() => expect(document.querySelector('[data-novel-source-list]')).not.toBeNull())
    await waitFor(() => expect(screen.getAllByText('未验源').length).toBeGreaterThan(0))   // 名字同时在待办卡与表格行（多匹配属正常）
    expect(deps.apiGet).toHaveBeenCalledWith('sources')
  })

  it('批量启停成功后源列表按服务端重取数：行开关即刻翻转（实机 bug：界面停在旧态，须重开视图）', async () => {
    // 假服务端：启停写口真的改内存里的 enabled，取数口回读——只有客户端重新 GET 过，
    // 行开关的 aria-label 才会从「停用 X」变成「启用 X」。
    const server: SourcePublic[] = [{ ...unverifiedSrc }]
    const deps = makeDeps({
      apiGet: vi.fn(async (path: string) => (path === 'sources' ? server.map((s) => ({ ...s })) : null)),
      apiSend: vi.fn(async (_m: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) => {
        if (path === ROUTES.sourcesBatchEnabled.path) {
          const { ids, enabled } = body as { ids: string[]; enabled: boolean }
          for (const s of server) if (ids.includes(s.id)) s.enabled = enabled
        }
        return {}
      }),
    })
    render(createElement(SettingsSection, { deps }))
    await screen.findByRole('switch', { name: '停用 未验源' })          // 初始 enabled:true
    fireEvent.click(screen.getByText('编辑'))
    fireEvent.click(screen.getByLabelText('选择 未验源'))
    fireEvent.click(screen.getByText('停用所选'))
    await waitFor(() => expect(deps.apiSend).toHaveBeenCalledWith(
      'POST', ROUTES.sourcesBatchEnabled.path, { ids: ['u1'], enabled: false }))
    await screen.findByRole('switch', { name: '启用 未验源' })           // 服务端已停用 → 界面跟上
  })

  it('待办收件箱：坏源/未验证成任务卡（反常置顶，卡面不印计数）；「一键验证」走注入 deps', async () => {
    const deps = settingsDeps({}, [unverifiedSrc, brokenSrc])
    render(createElement(SettingsSection, { deps }))
    expect(await screen.findByText('? 未验证')).toBeTruthy()
    expect(screen.getByText('✗ 坏源')).toBeTruthy()
    // 读数只印一遍：卡标题带计数 = 与状态带各说各话（2026-09 读数唯一住址收敛到状态带）
    expect(screen.queryByText('✗ 坏源 1')).toBeNull()
    expect(screen.queryByText('? 未验证 1')).toBeNull()
    const brokenCard = document.querySelector('[data-novel-todo="broken"]')
    expect(brokenCard, '坏源任务卡未渲染').not.toBeNull()
    expect(within(brokenCard as HTMLElement).getByText('坏源甲')).toBeTruthy()   // 名单在卡内
    fireEvent.click(screen.getByText('一键验证'))
    await waitFor(() => expect(deps.startBatchProbeJob).toHaveBeenCalledWith(['u1']))
  })

  it('待办卡可忽略：卡收起而读数留在状态带；「重新显示」把忽略掉的卡全开回来（不留黑洞）', async () => {
    const deps = settingsDeps({}, [unverifiedSrc, brokenSrc])
    render(createElement(SettingsSection, { deps }))
    await screen.findByText('批量重验')
    fireEvent.click(screen.getByLabelText('忽略 坏源 提示'))
    expect(document.querySelector('[data-novel-todo="broken"]')).toBeNull()
    expect(screen.getByText('一键验证')).toBeTruthy()              // 只收起点的那一张
    expect(screen.getByText('坏源 1')).toBeTruthy()                // 提示能关，读数不能跟着消失
    expect(screen.getByText(/已忽略 1 张/)).toBeTruthy()           // 忽略态看得见
    fireEvent.click(screen.getByText('重新显示'))
    expect(document.querySelector('[data-novel-todo="broken"]')).not.toBeNull()
  })

  it('列表头状态带：五个读数按全库算，非 0 的 未验证/坏源 带语义色类', async () => {
    const deps = settingsDeps({}, [unverifiedSrc, brokenSrc, { ...unverifiedSrc, id: 'u2', name: '未验源二', enabled: false }])
    const { container } = render(createElement(SettingsSection, { deps }))
    const band = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('[data-novel-src-stats]')
      if (el === null) throw new Error('状态带未渲染')     // throw 而非 expect(null)：waitFor 的返回类型才收窄到 HTMLElement
      return el
    })
    expect(band.textContent).toContain('共 3 个源')
    expect(band.textContent).toContain('已启用 2')
    expect(band.textContent).toContain('已停用 1')
    expect(band.textContent).toContain('未验证 2')      // 停用源照旧计入（停用 ≠ 免验）
    expect(band.textContent).toContain('坏源 1')
    const brokenStat = [...band.querySelectorAll('span')].find((s) => s.textContent === '坏源 1')
    expect(brokenStat?.className).toContain('err')      // 非 0 → 吃 err 色
  })

  it('0 源（删光了）：列表头与「＋ 导入书源」必须在场，且能点开弹层', async () => {
    // 病史（2026-09 实机）：0 源时组件 early-return 一句「点右上『＋ 导入书源』」，而整个列表头
    // 连同那颗钮根本没渲染——提示在指一个不存在的控件（与 docs-pinned-copy 守的同一类罪）。
    // **先等取数落定再查按钮**：sources 还是 null 的首帧照样渲染完整列表头，边等边查会拿到
    // 一个随后被卸载的节点，点它没反应——那条假绿比这条红更贵。
    const deps = settingsDeps({}, [])
    render(createElement(SettingsSection, { deps }))
    await screen.findByText(/还没有书源/)
    const btn = screen.getByRole('button', { name: '＋ 导入书源' })
    fireEvent.click(btn)
    await waitFor(() => expect(screen.getByText(/选择或拖入 legado 书源文件/)).toBeTruthy())
  })

  it('取数失败：不把失败伪装成「还没有书源」，且同一句错误只说一遍、导入入口照样可达', async () => {
    const deps = settingsDeps({ apiGet: vi.fn(async () => { throw new Error('boom') }) })
    render(createElement(SettingsSection, { deps }))
    await waitFor(() => expect(screen.getByText(/源列表加载失败：boom/)).toBeTruthy())
    expect(screen.queryByText(/还没有书源/)).toBeNull()          // 失败不许伪装成空态（宁炸不猜）
    expect(screen.queryByText(/源列表暂时不可用/)).toBeNull()      // 同一个失败不在两处各抄一句
    expect(screen.getByRole('button', { name: '＋ 导入书源' })).toBeTruthy()
  })

  it('加载中（sources 仍为 null）不报读数：状态带不在场，也不许出现「共 0 个源」', async () => {
    const deps = makeDeps({ apiGet: vi.fn(() => new Promise<never>(() => {})) })
    const { container } = render(createElement(SettingsSection, { deps }))
    await new Promise((r) => setTimeout(r, 30))
    expect(container.querySelector('[data-novel-src-stats]')).toBeNull()
    expect(container.textContent).not.toContain('共 0 个源')      // 未知不冒充「0 个源」这条结论
    expect(container.querySelector('[data-novel-source-list]')).not.toBeNull()
  })

  it('全健康源 → 待办区整块不渲染（零待办不常驻；「查过了且没事」由状态带的 0 来说）', async () => {
    const healthy: SourcePublic = { ...unverifiedSrc, id: 'h1', name: '健康源', status: 'verified' }
    const deps = settingsDeps({}, [healthy])
    const { container } = render(createElement(SettingsSection, { deps }))
    await waitFor(() => expect(container.querySelector('[data-novel-src-stats]')).not.toBeNull())
    expect(container.querySelector('[data-novel-inbox]')).toBeNull()
    expect(screen.getByText('未验证 0')).toBeTruthy()
    expect(screen.getByText('坏源 0')).toBeTruthy()
  })

  it('顺序不变量：待办区在源列表表格之前（反常置顶）', async () => {
    const deps = settingsDeps({}, [unverifiedSrc, brokenSrc])
    const { container } = render(createElement(SettingsSection, { deps }))
    await screen.findByText('批量重验')
    // 顺序断言走 DOM 比较而非 innerHTML.indexOf——innerHTML 里 <style>（NovelStyles）注入的
    // CSS 文本先出现，字符串匹配会打到规则文本上（`.novel-table` 规则在 `.novel-inbox` 之前=假红）
    const inbox = container.querySelector('[data-novel-inbox]')
    const table = container.querySelector('.novel-table')
    expect(inbox, '待办区未渲染').not.toBeNull()
    expect(table, '表格未渲染').not.toBeNull()
    expect((inbox as Element).compareDocumentPosition(table as Element) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
  })

  it('「批量重验」= 坏源集合的处置动作（ids 经 source-inbox 纯派生，点击时快照）', async () => {
    const deps = settingsDeps({}, [unverifiedSrc, brokenSrc])
    render(createElement(SettingsSection, { deps }))
    fireEvent.click(await screen.findByText('批量重验'))
    await waitFor(() => expect(deps.startBatchProbeJob).toHaveBeenCalledWith(['b1']))
  })

  it('待办处置动作（三入口同口径）：提交成功即催任务读面；源列表等任务收尾才刷新', async () => {
    const fetchJobStatus = vi.fn(async () => null)
    const deps = settingsDeps({ fetchJobStatus }, [unverifiedSrc, brokenSrc])
    render(createElement(SettingsSection, { deps }))
    renderHook(() => useJobPolling({ fetchJobStatus }))    // 观测面：常驻层同款轮询驱动
    await waitFor(() => expect(fetchJobStatus).toHaveBeenCalledTimes(1))
    fireEvent.click(await screen.findByText('批量重验'))
    await waitFor(() => expect(deps.startBatchProbeJob).toHaveBeenCalledWith(['b1']))
    // 验证起任务 → 读任务：提交成功催读面（jobs.ts 领域动作缺省 refresh → 立刻重拉，不等 1s 拍）
    await waitFor(() => expect(fetchJobStatus).toHaveBeenCalledTimes(2))
    // 不就地重取源列表：源状态要等任务收尾（终态 reload 另有按 job.id 的记账，下方用例钉）
    expect(deps.apiGet.mock.calls.filter((c) => c[0] === 'sources').length).toBe(1)
  })

  it('任务终态 → 源列表刷新按 job.id 只记一次；同一终态轮询再多拍不重复 reload，新一轮终态再刷一次', async () => {
    let current: JobState | null = null
    const fetchJobStatus = vi.fn(async () => current)
    const deps = settingsDeps({ fetchJobStatus })
    const readsOf = (): number => deps.apiGet.mock.calls.filter((c) => c[0] === 'sources').length
    render(createElement(SettingsSection, { deps }))
    renderHook(() => useJobPolling({ fetchJobStatus }))
    await waitFor(() => expect(readsOf()).toBe(1))                    // 挂载 reload
    const doneProbe: JobState = {
      id: 'p1', kind: 'batch-probe', phase: 'done', total: 2, done: 2,
      counts: { ok: 2, failed: 0, dupSkipped: 0, replaced: 0 },
      issues: [], fileErrors: [], startedAt: 0,
    }
    current = doneProbe
    await waitFor(() => expect(readsOf()).toBe(2), { timeout: 4000 }) // 终态落地 → reload 恰一次
    current = { ...doneProbe }                                        // 同 id 终态再来几拍（轮询每拍写新对象）
    await new Promise((r) => setTimeout(r, 2500))
    expect(readsOf()).toBe(2)                                         // 记账不重复
    current = { ...doneProbe, id: 'p2' }                              // 新一轮终态 → 再刷一次
    await waitFor(() => expect(readsOf()).toBe(3), { timeout: 4000 })
  })

  it('导入弹层：默认关闭；「＋ 导入书源」打开（拖放区在场），Esc 收起', async () => {
    const deps = settingsDeps()
    render(createElement(SettingsSection, { deps }))
    await waitFor(() => expect(document.querySelector('[data-novel-source-list]')).not.toBeNull())
    expect(screen.queryByText(/选择或拖入 legado 书源文件/)).toBeNull()   // 弹层默认关（低频任务不常驻）
    fireEvent.click(screen.getByText('＋ 导入书源'))
    expect(screen.getByText(/选择或拖入 legado 书源文件/)).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText(/选择或拖入 legado 书源文件/)).toBeNull())
  })

  it('导入完成态「去验证」：弹层内回调 → startBatchProbeJob(未验证 ids) + 弹层收起（闭环）', async () => {
    const deps = settingsDeps({ lastImportJob: () => doneImportJob })
    render(createElement(SettingsSection, { deps }))
    fireEvent.click(await screen.findByText('＋ 导入书源'))
    fireEvent.click(await screen.findByText(/去验证 1 个未验证源/))
    await waitFor(() => expect(deps.startBatchProbeJob).toHaveBeenCalledWith(['u1']))
    await waitFor(() => expect(screen.queryByText('选择或拖入 legado 书源文件')).toBeNull())
  })

  it('提交导入 → 弹层自动关闭（onSubmitted 口径：任务在服务端继续，结果经待办回流）', async () => {
    const deps = settingsDeps()
    render(createElement(SettingsSection, { deps }))
    fireEvent.click(await screen.findByText('＋ 导入书源'))
    const input = document.querySelector('input[type="file"]')
    expect(input).not.toBeNull()
    const file = new File(['[{"bookSourceName":"A"}]'], 'a.json', { type: 'application/json' })
    fireEvent.change(input as Element, { target: { files: [file] } })
    await waitFor(() => expect(deps.startImportJob).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByText('选择或拖入 legado 书源文件')).toBeNull())
  })

  it('源列表加载失败 → 显式错误；待办箱不渲染（不拿未知当「✓ 全部良好」）', async () => {
    const deps = settingsDeps({ apiGet: vi.fn(async () => { throw new Error('boom') }) })
    render(createElement(SettingsSection, { deps }))
    await waitFor(() => expect(screen.getByText(/源列表加载失败：boom/)).toBeTruthy())
    expect(screen.queryByText('一键验证')).toBeNull()
    expect(screen.queryByText(/全部源状态良好/)).toBeNull()
  })

  it('「去验证」提交失败 → pushError 显式呈现（历史 bug：() => undefined 吞 rejection）', async () => {
    const deps = settingsDeps({
      lastImportJob: () => doneImportJob,
      startBatchProbeJob: vi.fn(async () => { throw new Error('网络失败') }),
    })
    render(createElement(SettingsSection, { deps }))
    fireEvent.click(await screen.findByText('＋ 导入书源'))
    fireEvent.click(await screen.findByText(/去验证 1 个未验证源/))
    await waitFor(() => expect(deps.pushError).toHaveBeenCalledWith(expect.stringContaining('启动验证失败')))
    expect(String(deps.pushError.mock.calls[0][0])).toContain('网络失败')
  })

  it('导入弹层焦点不被壳层重渲染劫持（useJobStatus 1s 轮询 tick → 新 onClose 闭包；mount-scoped 口径）', async () => {
    // 病史（审查 2026）：ImportModal 的焦点/Esc effect 依赖 [onClose]，而 onClose 是壳层
    // 每 render 新造的内联箭头；任务记录在场时 useJobStatus 每秒 setJob 新对象 → 壳层重渲染
    // → effect cleanup+重跑 → 用户焦点被每秒劫回「关闭」钮。挂载作用域化后焦点必须原地不动。
    const deps = settingsDeps()
    const { rerender } = render(createElement(SettingsSection, { deps }))
    fireEvent.click(await screen.findByText('＋ 导入书源'))
    const closeBtn = screen.getByText('关闭')
    expect(document.activeElement).toBe(closeBtn)        // 入场焦点在关闭钮
    const dropzone = document.querySelector('[data-novel-dropzone]') as HTMLElement
    expect(dropzone).not.toBeNull()
    dropzone.focus()                                     // 用户把焦点移进弹层内容
    rerender(createElement(SettingsSection, { deps }))   // 模拟轮询 tick 的壳层重渲染 ×2
    rerender(createElement(SettingsSection, { deps }))
    expect(document.activeElement).toBe(dropzone)        // 旧实现：每次重渲染都被劫回关闭钮
    fireEvent.keyDown(document, { key: 'Escape' })       // Esc 监听不因挂载作用域化丢注册（走 ref 调最新闭包）
    await waitFor(() => expect(screen.queryByText(/选择或拖入 legado 书源文件/)).toBeNull())
  })
})

describe('ReaderView 接线（ReaderDeps 注入 + 范围导出流经 export-run）', () => {
  const readerDeps = (over: ReaderDepsOverrides = {}): FakeReaderDeps => makeReaderDeps(over)

  const reader = (deps: FakeReaderDeps): ReturnType<typeof createElement> =>
    createElement(ReaderView, { sourceId: 's1', bookKey: 'k1', title: '斗罗', deps })

  it('阅读会话的网络取数走注入 deps（toc 经 deps.apiGet，不再硬 import apiGet）', async () => {
    const deps = readerDeps()
    render(reader(deps))
    await waitFor(() => expect(deps.apiGet).toHaveBeenCalled())
    expect(String(deps.apiGet.mock.calls[0][0])).toContain('toc')
  })

  it('点「⤓ 下载」→ 弹范围面板（此时不开流）；点面板「下载」→ streamExport 在途，成功后 saveBlob 按书名落盘', async () => {
    const deps = readerDeps()
    render(reader(deps))
    await waitFor(() => expect(screen.getByText(/共 1 章/)).toBeTruthy())   // 目录未就绪时确认钮本就该禁用
    fireEvent.click(screen.getByText('⤓ 下载'))
    expect(screen.getByRole('dialog', { name: '导出范围' })).toBeTruthy()   // 第一步只开面板
    expect(deps.streamExport).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('dialog', { name: '导出范围' })).getByText('⤓ 下载'))
    await waitFor(() => expect(deps.streamExport).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(deps.saveBlob).toHaveBeenCalledTimes(1))
    expect(String(deps.saveBlob.mock.calls[0][1])).toBe('斗罗.txt')
  })

  it('面板范围校验：输入倒置 → 确认钮禁用，改回合法才可点', async () => {
    const deps = readerDeps()
    render(reader(deps))
    await waitFor(() => expect(screen.getByText(/共 1 章/)).toBeTruthy())   // toc 就绪才有 total
    fireEvent.click(screen.getByText('⤓ 下载'))
    const dlg = screen.getByRole('dialog', { name: '导出范围' })
    const inputs = within(dlg).getAllByRole('spinbutton')                  // type="number" → spinbutton
    fireEvent.change(inputs[0], { target: { value: '3' } })                // 3 > 1 倒置
    const confirm = within(dlg).getByText('⤓ 下载')
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(inputs[0], { target: { value: '1' } })
    expect((confirm as HTMLButtonElement).disabled).toBe(false)
    expect(deps.streamExport).not.toHaveBeenCalled()                       // 校验期零请求
  })

  it('导出失败：错误条呈现 code（导出错误与阅读链路 error 分家，历史形态：整段硬 import 零覆盖）', async () => {
    const deps = readerDeps({
      streamExport: vi.fn(async () => { throw new ApiClientError('ExportFailed', 500, '服务端导出失败') }),
    })
    render(reader(deps))
    await waitFor(() => expect(screen.getByText(/共 1 章/)).toBeTruthy())
    fireEvent.click(screen.getByText('⤓ 下载'))
    fireEvent.click(within(screen.getByRole('dialog', { name: '导出范围' })).getByText('⤓ 下载'))
    await waitFor(() => expect(screen.getByText(/ExportFailed/)).toBeTruthy())
  })
})

describe('NovelView 顶部 tab 导航（书架|书城|书源管理 并列；settings.section 注册已撤，书源管理归属主界面）', () => {
  // routeStore 是模块级全局现场——本组每条测完复位 shelf，防止污染后续依赖默认路由的断言
  afterEach(() => { navigate({ name: 'shelf' }) })

  it('点 tab 切换分支：书城=占位空态；书源管理=原设置区块渲染在小说视图内；书架=回首页', async () => {
    render(createElement(NovelView))
    const tabs = (): ReturnType<typeof within> => within(screen.getByRole('group', { name: '小说视图导航' }))
    // 默认书架：tab 组在场（书架 tab 激活）+ 书架内容渲染（搜索框常驻，与加载态无关）
    expect(tabs().getByRole('button', { name: '书架' }).getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(screen.getByPlaceholderText(/搜书名/)).toBeTruthy())
    // 「搜索」提交钮在场：与搜索页同款口径（Enter 是隐藏交互，可见按钮才是显式入口）
    expect(screen.getByRole('button', { name: '搜索' })).toBeTruthy()
    // 书城：CityView 占位空态，书架内容已卸载
    fireEvent.click(tabs().getByRole('button', { name: '书城' }))
    await waitFor(() => expect(screen.getByText(/书城未上线/)).toBeTruthy())
    expect(screen.queryByPlaceholderText(/搜书名/)).toBeNull()
    // 书源管理：SettingsSection（原宿主设置「小说」区块整体）渲染在小说视图内
    fireEvent.click(tabs().getByRole('button', { name: '书源管理' }))
    await waitFor(() => expect(document.querySelector('[data-novel-view="sources"]')).not.toBeNull())
    expect(screen.queryByText(/书城未上线/)).toBeNull()
    // 回书架：首页内容回来
    fireEvent.click(tabs().getByRole('button', { name: '书架' }))
    await waitFor(() => expect(screen.getByPlaceholderText(/搜书名/)).toBeTruthy())
  })
})

/**
 * 「离开界面即完蛋」的正面解法（旧实测缺陷：卸载时 3 批、卸载后又发 2 批，结果清零、重挂载整轮重打）。
 * 批循环搬到 Node 半之后，卸载只意味着「没人看了」：轮询停掉，服务端那一轮继续跑完并持有结果。
 */
describe('SearchView 离开界面：停看不停工（结果由服务端持有）', () => {
  it('卸载后不再发任何请求；重挂载从 since=0 重读即恢复，且不再提交一轮', async () => {
    const reads: string[] = []
    const deps = coreDeps({
      apiSend: vi.fn(async () => ({ jobId: 'j1' })),
      apiGet: vi.fn(async (path: string) => {
        reads.push(path)
        return { job: snap({ phase: 'running', done: 0, next: 0 }) }   // 一直「在跑」：轮询不会自己收
      }),
    })
    const view = render(createElement(SearchView, { deps }))
    fireEvent.change(screen.getByPlaceholderText('书名 / 作者'), { target: { value: '斗罗' } })
    fireEvent.submit(screen.getByRole('form'))
    await waitFor(() => expect(reads.length).toBeGreaterThan(0))
    const atUnmount = reads.length
    view.unmount()
    await new Promise((r) => setTimeout(r, 900))               // 越过 POLL_MS 节拍
    expect(reads).toHaveLength(atUnmount)                      // 卸载即停表：一条都不再发

    reads.length = 0
    deps.apiGet.mockImplementation(async (path: string) => {
      reads.push(path)
      return { job: snap({ phase: 'done', done: 1, next: 1, added: [hitGroup('切走期间搜完的书')] }) }
    })
    render(createElement(SearchView, { deps }))
    await waitFor(() => expect(screen.getByText('切走期间搜完的书')).toBeTruthy())
    expect(reads[0]).toBe(queries.searchJobStatus(0))          // 重挂载 = 从游标零点重读
    expect(deps.apiSend).toHaveBeenCalledTimes(1)              // 恢复不重打：第二轮都没提交
  })

  it('退出小说界面再进：route 仍带关键词的重挂载也只恢复，不重新提交（真机 bug：整轮从头重搜）', async () => {
    // 真机路径：书架搜索框 navigate({name:'search', keyword}) 进搜索页；routeStore 是跨卸载
    // 存活的现场（store.ts），退出小说界面再进 = route 还带着关键词重新挂载。
    // 旧行为：挂载 effect 无条件 submit → POST 替换单槽里在跑的同一轮 → 整轮从头重搜（用户实测）。
    navigate({ name: 'search', keyword: '斗罗' })
    const deps = coreDeps({
      apiSend: vi.fn(async () => ({ jobId: 'j1' })),
      apiGet: vi.fn(async () => ({
        job: snap({ phase: 'running', done: 3, total: 10, next: 3, added: [hitGroup('切走前已搜到的书')] }),
      })),
    })
    const view = render(createElement(SearchView, { deps }))
    await waitFor(() => expect(deps.apiSend).toHaveBeenCalledTimes(1))   // 从书架新鲜跳入：提交一轮
    view.unmount()                                                       // 退出小说界面（服务端那轮照跑）

    render(createElement(SearchView, { deps }))                          // 再进小说界面
    await waitFor(() => expect(screen.getByText('切走前已搜到的书')).toBeTruthy())
    // 进度从服务端快照恢复不从零开始（已搜 3/10 被 <b> 拆元素，按 textContent 断言）
    expect(document.querySelector('.novel-prog-text')?.textContent ?? '').toMatch(/已搜 3\/10/)
    expect(deps.apiSend).toHaveBeenCalledTimes(1)                        // 恢复不重打：重挂载零提交
    navigate({ name: 'shelf' })
  })

  it('StrictMode 双挂载：两次恢复读只许落地一次（分组不重复累加）', async () => {
    let reads = 0
    const deps = coreDeps({
      apiGet: vi.fn(async () => {
        reads++
        return { job: snap({ phase: 'done', done: 1, next: 1, added: [hitGroup('只该出现一次的书')] }) }
      }),
    })
    render(createElement(StrictMode, null, createElement(SearchView, { deps })))
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2))   // 同实例二次 effect：确实读了两次
    expect(screen.getAllByText('只该出现一次的书')).toHaveLength(1)
  })

  it('服务端宣布任务已不可读（重启 / 过保留期）→ 如实说明，不伪装成「搜了没命中」', async () => {
    let reads = 0
    const deps = coreDeps({
      apiSend: vi.fn(async () => ({ jobId: 'j1' })),
      apiGet: vi.fn(async () => ({ job: (++reads === 1 ? snap({ phase: 'running', done: 0, next: 0 }) : null) })),
    })
    render(createElement(SearchView, { deps }))
    fireEvent.change(screen.getByPlaceholderText('书名 / 作者'), { target: { value: '斗罗' } })
    fireEvent.submit(screen.getByRole('form'))
    await waitFor(() => expect(screen.getByText(/后台搜索任务已不可读/)).toBeTruthy())
    expect(screen.queryByText('没有结果')).toBeNull()
  })
})

