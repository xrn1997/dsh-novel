import { cleanup, fireEvent, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import { resetPanelShelf } from '../../src/client/panel-shelf.js'
import { SearchView } from '../../src/client/views/SearchView.js'
import type { SearchHit } from '../../src/client/views/types.js'
import { ROUTES } from '../../src/shared/wire.js'
import type { SearchJobSnapshot } from '../../src/shared/wire.js'
import { makeCoreDeps } from './fake-deps.js'
import type { DepsOverrides, FakeViewDeps } from './fake-deps.js'

/**
 * 接线套件（`wiring-*`）的共享驱动：书架/搜索/试跑器的失败形态（陈旧回调、
 * 乐观删除、误导性空态、失败假死）由各组用核心依赖束（ClientCoreDeps）逐条钉死，本文件只放它们
 * 共用的 setup——依赖束工厂、调用记录读口、快照轮询账、清理钩子——以及搜索页的挂载、命中/快照桩
 * 与两条轴的读数取用。桩工厂统一到 fake-deps.ts；断言、时序与 DOM 查询各自留在自己的文件里。
 */

/** 每个接线文件的模块顶层调一次：`cleanup` 清 DOM、`resetPanelShelf` 复位面板期书架投影
 *  （后者是模块级现场，跨用例存活）。注册点恒在各组自己的 `beforeEach` 之前。 */
export const installWiringLifecycle = (): void => {
  afterEach(cleanup)
  beforeEach(resetPanelShelf)
}

/** 视图束（`FakeViewDeps`）工厂：`over` 覆写束成员，缺省全是确定性假实现（零网络） */
export const coreDeps = (over: DepsOverrides): FakeViewDeps => makeCoreDeps(over)

/** `apiSend` 桩的签名：两参（目标 + body）钉在泛型上——`mock.calls` 才能按下标取到 method/path/body，
 *  实现体则不必声明用不到的形参（这些用例只读调用记录，不读实参）。 */
export type ApiSendStub = (target: { method: string; path: string }, body?: unknown) => Promise<unknown>

/** 假依赖束里的 Mock 未参数化（见 fake-deps.ts 的收口说明）：调用记录在这里按桩签名读一次，
 *  之后 method / path / body 都是窄类型（读错字段即编译错，而不是 any 蒙过去）。 */
export type SentCall = [ { method: string; path: string }, unknown ]
export const sentCalls = (deps: { readonly apiSend: Mock }): SentCall[] => deps.apiSend.mock.calls as SentCall[]

/** 快照轮询的读数：搜索结果页挂载还会向投影问一次书架基线（`ADR-0046`），
 *  「本轮到底打了几发读取」按任务状态那一条路径数，别把基线那一发混进轮询账。 */
export const snapshotReads = (apiGet: unknown): number =>
  ((apiGet as ReturnType<typeof vi.fn>).mock.calls
    .filter((c) => String(c[0]).startsWith(`${ROUTES.searchJobStatus.path}?`)).length)

/**
 * 挂搜索页：整页形状只有「`SearchView` + 注入 deps」一种；要换字典的用例自己包 `CopyProvider`。
 */
export const mountSearch = (deps: FakeViewDeps): ReturnType<typeof render> =>
  render(createElement(SearchView, { deps }))

/** 命中行（`SearchHit`）：调用点只写自己在意的那几项，其余元数据一律 null——缺省形状与服务端
 *  给出的空字段同形。 */
export const hit = (over: Partial<SearchHit> & { title: string }): SearchHit => ({
  author: null, url: null, coverUrl: null, intro: null, lastChapterName: null, kind: null, wordCount: null, ...over,
})

/** 命中分组桩（`SearchGroup` 的最小可渲染形态）。
 *  `sourceId` 一轮内必须一源一个：服务端 `searchProgressive` 对每个源只 `emit` 一组，分组在
 *  `SearchView` 里按 `key={g.sourceId}` 渲染——同一轮塞两个同 id 的桩等于造出服务端给不出的形状
 *  （React 会报 duplicate key）。多组用例显式传第二个 id。
 *  相关性视野：`inView: false` 显式造一条会落 `suspect` 的标题（折叠语义有专门用例钉）；
 *  既有用例测的是游标与轮次身份、不是视野，默认不传——**但标题要带上本轮关键词**：
 *  不带就落 suspect、整行进折叠区，而 jsdom 没有浏览器 UA 样式表、查询打得进未展开的 details，
 *  于是「默认视野摆着它」这件事全靠这个巧合撑着，哪天折叠改成懒渲染就一片看不懂的蓝。
 *  注意：默认视野现在有两轴（按书在前、按源在页尾折叠），同一个标题在两轴各现一次，
 *  用例按容器取用（见 booksAxis / perSourceAxis）。 */
export const hitGroup = (title: string, sourceId = 's1', over: { inView?: boolean; url?: string } = {}) => ({
  sourceId, sourceName: 'S', status: 'verified' as const,
  hits: [hit({
    title: over.inView === false ? `与关键词无关的${title}` : title,
    url: over.url ?? 'https://s.com/book/1',
  })],
})

/** 后台搜索任务快照桩：默认「已结束、一家源、零增量」，各用例只覆写自己在意的那几项 */
export const snap = (over: Partial<SearchJobSnapshot> = {}): SearchJobSnapshot => ({
  id: 'j1', keyword: '斗罗', phase: 'done', cancelled: false, total: 1, done: 1, added: [], next: 0, startedAt: 0, ...over,
})

/** 结果页现在有两条轴（按书在前、按源在页尾折叠），同一个书名会在两轴各现一次；而 jsdom 没有
 *  浏览器 UA 样式表，收起的 `<details>` 里照样查得到——「唯一匹配」因此不是默认前提。
 *  用例一律按容器取用，并把「容器不在场」写成 thrown（waitFor 才会重试到超时并把它报出来）。 */
export const booksAxis = (): HTMLElement => {
  const el = document.querySelector('[data-novel-books]')
  if (el === null) throw new Error('按书那一档没渲染（本轮一条 kept 都没有时它本就不该在场）')
  return el as HTMLElement
}
export const perSourceAxis = (): HTMLElement => {
  const el = document.querySelector('[data-novel-per-source]')
  if (el === null) throw new Error('按源那一档没渲染——降级不等于删除，源好坏仍要各自可见')
  return el as HTMLElement
}
/** 读按源那一档**里面**的东西之前先把它展开。
 *  口径：这一档默认收着（收起/展开这两个 DOM 事实由「页尾那条按源折叠」用例钉住），而 jsdom 没有
 *  浏览器 UA 样式表、查询打得进收起的 `<details>`——不先展开就取用，证的是查询器不是界面，
 *  哪天折叠改成懒渲染或换到真浏览器就是一批看不懂的蓝。已开时不点（waitFor 里可重复调用）。 */
export const openPerSourceAxis = (): HTMLElement => {
  const axis = perSourceAxis()
  if (!(axis as HTMLDetailsElement).open) {
    const summary = axis.querySelector('summary')
    if (summary === null) throw new Error('按源那一档没有收口行：折叠形状没了')
    fireEvent.click(summary)
  }
  return axis
}
/** 读/点按书那一档**展开区里**的逐源行之前先展开：一行一本的展开区由行头主钮的 `aria-expanded`
 *  控制，收起时逐源行**根本不在 DOM 里**（不是藏在折叠后面）——不先展开就取用，拿到的是空集，
 *  于是断言静默地什么也没断（同 openPerSourceAxis 的口径；「收起不摆出来」那类钉收起态的用例不走这里）。
 *  已开的不重复点。 */
export const openBookFold = (): void => {
  for (const row of booksAxis().querySelectorAll('[data-novel-book]')) {
    const main = row.querySelector('.novel-book-main')
    if (main === null) throw new Error('书行没有行头主钮：一行一本的形状没了')
    if (main.getAttribute('aria-expanded') !== 'true') fireEvent.click(main)
  }
}
/** 按书那一档「行上」那一个书名：同一本书在行首与它的展开区各写一次，取行首那份才是在说「一行」 */
export const bookRow = (title: string): HTMLElement => {
  const row = [...document.querySelectorAll('[data-novel-books] [data-novel-book]')]
    .find((r) => r.querySelector('.novel-book-main strong')?.textContent === title)
  if (row === undefined) throw new Error(`按书视图没有「${title}」那一行`)
  return row as HTMLElement
}
