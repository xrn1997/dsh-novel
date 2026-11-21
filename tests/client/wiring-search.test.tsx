// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement, StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { CopyProvider, enTranslate } from '../../src/client/copy/index.js'
import { navigate, routeStore } from '../../src/client/store.js'
import { ReaderView } from '../../src/client/views/ReaderView.js'
import { SearchView } from '../../src/client/views/SearchView.js'
import type { SearchGroup } from '../../src/client/views/types.js'
import { ROUTES, SEARCH_BOOKS_CAP, paramOps, queries } from '../../src/shared/wire.js'
import type { SearchJobSnapshot } from '../../src/shared/wire.js'
import { makeReaderDeps } from './fake-deps.js'
import { must, pick } from '../support/fixture.js'
import {
  bookRow, booksAxis, coreDeps, hit, hitGroup, installWiringLifecycle, mountSearch, openBookFold,
  openPerSourceAxis, perSourceAxis, snap, snapshotReads,
} from './wiring-harness.js'
import type { ApiSendStub } from './wiring-harness.js'

/**
 * 搜索页接线：提交一轮后台任务，此后只读快照或收推送；两条轴（按书、按源折叠）的账与单位、
 * 落架账在面板期存活、陈旧快照防线、错误与中断的显式呈现，以及卸载只停看——结果由服务端持有。
 */

installWiringLifecycle()

describe('SearchView 接线：聚合搜索走后台任务（提交一次 + 游标读快照）', () => {
  it('提交 = POST search/job，此后只读 job-status——浏览器半不打批请求', async () => {
    let submitted = false
    const reads: string[] = []
    const deps = coreDeps({
      apiSend: vi.fn(async () => { submitted = true; return { jobId: 'j1' } }),
      apiGet: vi.fn(async (path: string) => {
        reads.push(path)
        if (path === ROUTES.shelf.path) return []      // 落架基线那一问（`ADR-0046`）
        return { job: submitted ? snap({ added: [hitGroup('斗罗后台命中')], next: 1 }) : null }
      }),
    })
    mountSearch(deps)
    fireEvent.change(screen.getByPlaceholderText('书名 / 作者'), { target: { value: '斗罗' } })
    fireEvent.submit(screen.getByRole('form'))
    await waitFor(() => expect(within(openPerSourceAxis()).getByText('斗罗后台命中')).toBeTruthy())
    // `lastChapterName` 是 `string | null`：判 `undefined` 的守卫永不生效，null 会渲染成字面「null」
    const sub = openPerSourceAxis().querySelector('.novel-hit-sub')
    expect(sub, '按源那一档的命中行副行未渲染').not.toBeNull()
    expect(must(sub, '按源那一档的命中行副行').textContent).toBe('')
    expect(deps.apiSend).toHaveBeenCalledWith(ROUTES.searchJob, { keyword: '斗罗' })
    // 全部读取只有两类：落架基线那一发（`ADR-0046`）与快照游标读——没有任何一次
    // search?keyword= 的批请求从浏览器半发出
    expect(reads.every((r) => r === ROUTES.shelf.path || r.startsWith(`${ROUTES.searchJobStatus.path}?`))).toBe(true)
  })

  it('挂载即恢复：服务端持有本轮结果 → 直接渲染且不重新提交', async () => {
    const deps = coreDeps({
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({ keyword: '上一轮', phase: 'done', added: [hitGroup('上一轮的命中')], next: 1 }),
      })),
    })
    mountSearch(deps)
    await waitFor(() => expect(bookRow('上一轮的命中')).toBeTruthy())
    expect(deps.apiSend).not.toHaveBeenCalled()          // 恢复不是重打：一轮都不必提交
    expect(screen.getByText(/本轮搜过/)).toBeTruthy()     // 收尾留痕同样从快照复算
    // 没折进任何东西时不摆两个数（组头单数、收口无括注）：负向钉住，防「相关 x · 共 y」无差别铺开
    // 单位：组头数的是这一家的**行**，所以是「1 条」不是「1 本」（律见 CONTEXT「作品视图（按书）」）。
    // 同形的「1 条」在收口也有一个，两条读数各钉各的：上面按那一档取（钉组头），下面读整句（钉收口）。
    expect(within(openPerSourceAxis()).getByText('1 条')).toBeTruthy()
    const summaryLine = screen.getByText(/本轮搜过/)
    expect(summaryLine.textContent).toContain('命中 1 条')
    // 加粗边界只到数字：只有数字进 b（含 failed=0 的结论），单位与 answered 是纯文本。
    expect([...summaryLine.querySelectorAll('b')].map((b) => b.textContent)).toEqual(['1', '1', '1', '0'])
    expect(summaryLine.textContent).not.toMatch(/其中相关/)
  })

  it('相关性档改变默认视野但不改账目：suspect 收进组内折叠，展开后仍是可点的命中行', async () => {
    const deps = coreDeps({
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({
          keyword: '斗罗', phase: 'done', next: 1, total: 1, done: 1,
          added: [{
            sourceId: 's1', sourceName: 'S', status: 'verified',
            hits: [
              hit({ title: '斗罗', author: '唐家', url: 'https://s.com/a' }),
              hit({ title: '完全无关的书', url: 'https://s.com/b' }),
            ],
          }],
        }),
      })),
    })
    mountSearch(deps)
    // 先等本轮落地：首帧之前两条轴都不在场，直接取容器就是把「还没加载」读成「没渲染」
    // 这一档默认收着，读它里面的东西先展开（口径见 openPerSourceAxis）
    await waitFor(() => expect(openPerSourceAxis().textContent).toContain('斗罗'))
    const perSource = perSourceAxis()
    // 默认视野不许摆那条无关的——钉 DOM 事实：疑似折叠区没开、kept 列表里没有它，
    // 条数不丢则由展开之后的那一条断言证（不靠 jsdom 能打进收起 details 这个巧合）。
    const fold = within(perSource).getByText(/疑似无关/)
    const details = fold.closest('details')
    expect(details, '折叠区必须在组内').not.toBeNull()
    expect(must(details, '折叠区').open, '默认视野：折叠区收着').toBe(false)
    const keptList = perSource.querySelector('.novel-list')
    expect(keptList, '按源那一档的 kept 列表未渲染').not.toBeNull()
    expect(must(keptList, '按源那一档的 kept 列表').textContent, '默认视野里不许摆那条疑似无关的').not.toContain('完全无关的书')
    fireEvent.click(fold)
    expect(must(details, '折叠区').open, '点收口行要真能展开').toBe(true)
    expect(must(details, '折叠区').textContent, '一条不丢：它就在折叠区里等着被展开').toContain('完全无关的书')
    expect(screen.getByText('完全无关的书')).toBeTruthy()
    const row = screen.getByText('完全无关的书').closest('button')
    expect(row, '判为疑似不夺走动作——展开后仍是可点的命中行').not.toBeNull()
    expect(screen.getByText(/相关 1 · 共 2/)).toBeTruthy()   // 计数两个数都在场（这一档不写单位，写了也不许是「本」）
    expect(screen.getByText(/其中相关 1 条/)).toBeTruthy()    // 收口行同样并报两个数，单位是条
    // 按书那一档收不进它（suspect 不参与归并），所以它不许出现在书行里——两边的账各归各
    expect(booksAxis().textContent).not.toContain('完全无关的书')
  })

  it('整组都被判 suspect：一条不丢——折叠区带着全部条数在案，不许读成「搜了没命中」', async () => {
    const deps = coreDeps({
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({ keyword: '斗罗', phase: 'done', next: 1, total: 1, done: 1, added: [hitGroup('命中', 's1', { inView: false })] }),
      })),
    })
    mountSearch(deps)
    await waitFor(() => expect(within(openPerSourceAxis()).getByText(/疑似无关/)).toBeTruthy())
    expect(screen.queryByText(/没有结果/)).toBeNull()       // 空态只属于「真的一个组都没有」
  })

  it('默认按书：同一本的多源收成一行，「读这本」只在展开后的逐源行里', async () => {
    const deps = coreDeps({
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({ keyword: '斗罗', phase: 'done', total: 2, done: 2, next: 2, added: [hitGroup('斗罗', 's1'), hitGroup('斗罗', 's2')] }),
      })),
    })
    mountSearch(deps)
    await waitFor(() => expect(screen.getByText(/2 家源/)).toBeTruthy())
    const books = booksAxis()
    expect(books.querySelectorAll('[data-novel-book]'), '两家答话的同一本收成一行').toHaveLength(1)
    const row = books.querySelector('[data-novel-book]') as HTMLElement
    const main = row.querySelector('.novel-book-main') as HTMLElement
    // 行头主钮只做「展开」这一件事：本仓没有能替用户选源的读数（探针 verified 只证搜索面），
    // 所以「读这本」永远在展开后的逐源行里，行上一颗都没有（裁决见 ADR-0033）
    expect(main.getAttribute('aria-expanded'), '默认收起').toBe('false')
    // 主钮的无障碍名来自内容拼接：它得把「N 条」那笔账带进名字（收起时行上唯一说得出条数的地方），
    // 又不许混进行以外的字——按 name 子串钉，抄整串会把排版空格也钉死。
    expect(within(row).getByRole('button', { name: /展开 2 条$/ }), '行头主钮：名字以条数收尾').toBeTruthy()
    expect(within(row).getAllByRole('button').map((b) => b.textContent.trim()),
      '收起态行上只有两颗钮：展开主钮与「都加架」').toEqual([
      expect.stringMatching(/展开 2 条/), '都加架'])
    expect(within(row).queryAllByLabelText('阅读 斗罗'), '收起不摆逐源行：整本的行不进 DOM').toHaveLength(0)
    fireEvent.click(main)
    expect(main.getAttribute('aria-expanded'), '点主钮要真能展开').toBe('true')
    expect(within(row).getAllByLabelText('阅读 斗罗'), '展开才把逐源行摆出来，两家各一条').toHaveLength(2)
    // 按源那一档降级不删：同一批读本页尾照旧摆着（读里面的东西先展开）
    expect(within(openPerSourceAxis()).getAllByLabelText('阅读 斗罗')).toHaveLength(2)
  })

  it('都加架：逐条走既有 PUT（幂等归服务端），每条带自己那个源，不开新写口', async () => {
    // 桩按 apiSend 的 arity（目标 + body）声明，mock.calls 才能按下标取到 method/path/body
    const apiSend = vi.fn<ApiSendStub>(async () => ({}))
    const deps = coreDeps({
      apiSend,
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({ keyword: '斗罗', phase: 'done', total: 2, done: 2, next: 2, added: [hitGroup('斗罗', 's1'), hitGroup('斗罗', 's2')] }),
      })),
    })
    mountSearch(deps)
    await waitFor(() => expect(screen.getByText(/2 家源/)).toBeTruthy())
    fireEvent.click(within(booksAxis()).getByRole('button', { name: '都加架' }))
    await waitFor(() => expect(apiSend).toHaveBeenCalledTimes(2))
    const key = paramOps.shelfPut.path('https://s.com/book/1')
    expect(apiSend).toHaveBeenCalledWith({ method: 'PUT', path: key }, expect.objectContaining({ title: '斗罗' }))
    // 两家给的是同一个地址 ⇒ 路径分不出谁是谁，只有 body 里的 sourceId 认得出「这条 PUT 是哪家那一行」
    expect(apiSend.mock.calls.map((c) => (c[1] as { sourceId: string }).sourceId),
      '逐条各带自己那个源（同址只落一个架位，署名就靠 body 里的 sourceId）').toEqual(['s1', 's2'])
    expect(apiSend.mock.calls.map((c) => [c[0].method, c[0].path]), '只复用 PUT shelf/:key 那一条既有路').toEqual([['PUT', key], ['PUT', key]])
  })

  it('作者串是整张配音表那种长度：行上只留前两位加「等」，全串归 title 与展开后的逐源行', async () => {
    // 有的源会把整张配音表塞进 author（一整个名单那么长）。这一串住在主钮的内容里，也就是它的
    // 无障碍名——不收，读屏每本念一遍名单，视觉上还把尾巴与「都加架」顶下两行。
    const longAuthor = '张沛,黑石稔,陈奕雯,高其昌,筱筝,鬼月'
    const deps = coreDeps({
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({
          keyword: '斗罗', phase: 'done', total: 1, done: 1, next: 1,
          added: [{
            sourceId: 's1', sourceName: 'S', status: 'verified',
            hits: [
              hit({ title: '斗罗', author: longAuthor, url: 'https://s.com/a' }),
            ],
          }],
        }),
      })),
    })
    mountSearch(deps)
    await waitFor(() => expect(screen.getByText(/1 家源/)).toBeTruthy())
    const who = bookRow('斗罗').querySelector('.novel-book-author') as HTMLElement
    expect(who, '行上少了作者那一段读数').not.toBeNull()
    expect(who.textContent, '只留前两位，其余由「等」承担').toBe('张沛,黑石稔 等')
    expect(who.getAttribute('title'), '全串不丢：hover 读的就是它').toBe(longAuthor)
    // 家数读数紧跟在作者后面，不许被同一把省略号吃掉尾巴
    expect(bookRow('斗罗').querySelector('.novel-book-sources')?.textContent, '家数是独立一段').toContain('1 家源')
    openBookFold()
    expect(bookRow('斗罗').querySelector('.novel-hit-sub')?.textContent,
      '展开后的逐源行仍给全串：收进行上的只是这一行的读数').toContain(longAuthor)
  })

  it('作者只有两位或那种空格分隔的角色表：一字不改（没有第三位可「等」，也不拿逗号去切）', async () => {
    const cases = ['天蚕土豆', '甲,乙', '萧炎：锦鲤 药老：北炎 美杜莎：常蓉珊']
    const deps = coreDeps({
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({
          keyword: '斗罗', phase: 'done', total: 1, done: 1, next: 1,
          added: [{
            sourceId: 's1', sourceName: 'S', status: 'verified',
            hits: cases.map((author, i) => hit({
              title: `斗罗${i}`, author, url: `https://s.com/${i}`,
            })),
          }],
        }),
      })),
    })
    mountSearch(deps)
    await waitFor(() => expect(booksAxis().querySelectorAll('[data-novel-book]')).toHaveLength(3))
    for (const author of cases)
      expect(bookRow(`斗罗${cases.indexOf(author)}`).querySelector('.novel-book-author')?.textContent,
        `「${author}」被改写了`).toBe(author)
  })

  it('都加架成功：按钮与每一条逐源行都记得落过架，再点不发第二发 PUT', async () => {
    // 症状：都加架把两条都写上了架，界面上却什么都没变——按钮仍「都加架」、
    // 两条仍「＋ 加书架」，于是用户再点一次，把重复写当成没生效的反馈。
    const releases: Array<() => void> = []
    const apiSend = vi.fn<ApiSendStub>(() => new Promise<void>((res) => { releases.push(res) }))
    const deps = coreDeps({
      apiSend,
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({ keyword: '斗罗', phase: 'done', total: 2, done: 2, next: 2, added: [hitGroup('斗罗', 's1'), hitGroup('斗罗', 's2')] }),
      })),
    })
    mountSearch(deps)
    await waitFor(() => expect(screen.getByText(/2 家源/)).toBeTruthy())
    const row = bookRow('斗罗')
    fireEvent.click(row.querySelector('.novel-book-main') as HTMLElement)   // 展开
    const putCount = (): number => apiSend.mock.calls.filter((c) => c[0].method === 'PUT').length
    fireEvent.click(within(row).getByRole('button', { name: '都加架' }))
    const busy = within(row).getByRole<HTMLButtonElement>('button', { name: '加架中…' })
    expect(busy.disabled, '在途要禁点，也要有个在途读数（只灰不改字＝没人知道点没点上）').toBe(true)
    releases.splice(0).forEach((r) => { r() })
    await waitFor(() => expect(putCount()).toBe(2))
    await waitFor(() => expect(within(row).queryAllByRole('button', { name: '＋ 加书架' })).toHaveLength(0))
    expect(within(row).getByRole('button', { name: '都在架' }), '批量动作的结果要在按钮上留下读数').toBeTruthy()
    expect(within(row).getAllByRole('button', { name: '已在书架' }), '逐源行也要记得：两条都落架了').toHaveLength(2)
    // 再点：一发都不该再出（禁点已被 label 换掉，这里连按路径也验一次）
    fireEvent.click(within(row).getByRole('button', { name: '都在架' }))
    expect(putCount(), '已落架的行不许再发').toBe(2)
  })

  it('先单加一条再点都加架：只补没落架的那一条，落架账不重复', async () => {
    const apiSend = vi.fn<ApiSendStub>(async () => ({}))
    const pushOk = vi.fn()
    const deps = coreDeps({
      apiSend, pushOk,
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({ keyword: '斗罗', phase: 'done', total: 2, done: 2, next: 2, added: [hitGroup('斗罗', 's1', { url: 'https://s.com/1' }), hitGroup('斗罗', 's2', { url: 'https://s.com/2' })] }),
      })),
    })
    mountSearch(deps)
    await waitFor(() => expect(screen.getByText(/2 家源/)).toBeTruthy())
    const row = bookRow('斗罗')
    fireEvent.click(row.querySelector('.novel-book-main') as HTMLElement)
    const putCount = (): number => apiSend.mock.calls.filter((c) => c[0].method === 'PUT').length
    fireEvent.click(pick(within(row).getAllByRole('button', { name: '＋ 加书架' }), 0))
    await waitFor(() => expect(putCount()).toBe(1))
    expect(within(row).getByRole('button', { name: '都加架' }), '只落了一条：整本还没齐').toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: '都加架' }))
    await waitFor(() => expect(putCount(), '已落架那条不该再发一遍').toBe(2))
    await waitFor(() => expect(pushOk).toHaveBeenCalledWith('已加 1 个架位：斗罗'))   // 这次只补了一条
    expect(within(row).getByRole('button', { name: '都在架' })).toBeTruthy()
  })

  it('单行加架失败：pushError 必须有回执，不许静默吞掉', async () => {
    // 症状：单行「＋ 加书架」的 PUT 失败被 catch(() => undefined) 咽掉——按钮还是「＋ 加书架」，
    // 也没有任何回执，用户点了一下界面什么也不说。
    const apiSend = vi.fn(async () => { throw new Error('disk') })
    const pushError = vi.fn()
    const deps = coreDeps({
      apiSend, pushError,
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({ keyword: '斗罗', phase: 'done', total: 1, done: 1, next: 1, added: [hitGroup('斗罗')] }),
      })),
    })
    mountSearch(deps)
    await waitFor(() => expect(screen.getByText(/1 家源/)).toBeTruthy())
    const row = bookRow('斗罗')
    fireEvent.click(row.querySelector('.novel-book-main') as HTMLElement)   // 展开逐源行
    fireEvent.click(within(row).getByRole('button', { name: '＋ 加书架' }))
    await waitFor(() => expect(pushError).toHaveBeenCalledWith('加入书架失败：disk'))
    expect(within(row).getByRole('button', { name: '＋ 加书架' }), '失败不许记成已落架').toBeTruthy()
  })

  it('点行阅读时加架失败：照样进阅读器，失败另有回执（导航不吞掉交代）', async () => {
    navigate({ name: 'shelf' })
    const apiSend = vi.fn(async () => { throw new Error('disk') })
    const pushError = vi.fn()
    const deps = coreDeps({
      apiSend, pushError,
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({ keyword: '斗罗', phase: 'done', total: 1, done: 1, next: 1, added: [hitGroup('斗罗')] }),
      })),
    })
    mountSearch(deps)
    await waitFor(() => expect(screen.getByText(/1 家源/)).toBeTruthy())
    const row = bookRow('斗罗')
    fireEvent.click(row.querySelector('.novel-book-main') as HTMLElement)   // 展开逐源行
    fireEvent.click(within(row).getByLabelText('阅读 斗罗'))
    await waitFor(() => expect(routeStore.get().route.name).toBe('reader'))
    await waitFor(() => expect(pushError).toHaveBeenCalledWith('加入书架失败：disk'))
    navigate({ name: 'shelf' })
  })

  // 回执自己抛错（pushError/onLanded 都来自壳层，行为不受本组件控制）：加架那一发的
  // rejection 必须被两处入口各自接住——点行阅读照旧导航，兄弟「＋ 加书架」也不许把 rejection
  // 漏成无人处理的一发（`void add()` 裸奔即回归）。
  it('加架回执自己抛错：点行阅读仍进阅读器，兄弟加架不漏 unhandled rejection', async () => {
    navigate({ name: 'shelf' })
    const apiSend = vi.fn(async () => { throw new Error('disk') })
    const pushError = vi.fn(() => { throw new Error('回执炸了') })
    const deps = coreDeps({
      apiSend, pushError,
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({ keyword: '斗罗', phase: 'done', total: 1, done: 1, next: 1, added: [hitGroup('斗罗')] }),
      })),
    })
    const escaped: unknown[] = []
    const onUnhandled = (reason: unknown): void => { escaped.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      mountSearch(deps)
      await waitFor(() => expect(screen.getByText(/1 家源/)).toBeTruthy())
      const row = bookRow('斗罗')
      fireEvent.click(row.querySelector('.novel-book-main') as HTMLElement)   // 展开逐源行
      fireEvent.click(within(row).getByRole('button', { name: '＋ 加书架' }))
      await waitFor(() => expect(pushError).toHaveBeenCalledTimes(1))
      await new Promise((r) => setTimeout(r, 40))          // 给 Node 的 unhandledRejection 判定留一拍
      expect(escaped, '兄弟加架的回执异常逃成了 unhandled rejection').toEqual([])
      fireEvent.click(within(row).getByLabelText('阅读 斗罗'))
      await waitFor(() => expect(routeStore.get().route.name).toBe('reader'))
      await waitFor(() => expect(pushError).toHaveBeenCalledTimes(2))
      await new Promise((r) => setTimeout(r, 40))
      expect(escaped, '点行阅读的 rejection 分支没接住').toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      navigate({ name: 'shelf' })
    }
  })

  it('收起再展开：已在架的行仍显示已在书架（账住在行之上，不在那一行自己肚子里）', async () => {
    // 展开区收起时不渲染（那是这一行的性能账），所以落架的账必须存在比这一行更长寿的地方。
    const apiSend = vi.fn<ApiSendStub>(async () => ({}))
    const deps = coreDeps({
      apiSend,
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({ keyword: '斗罗', phase: 'done', total: 2, done: 2, next: 2, added: [hitGroup('斗罗', 's1'), hitGroup('斗罗', 's2')] }),
      })),
    })
    mountSearch(deps)
    await waitFor(() => expect(screen.getByText(/2 家源/)).toBeTruthy())
    const main = (): HTMLElement => bookRow('斗罗').querySelector('.novel-book-main') as HTMLElement
    fireEvent.click(main())
    fireEvent.click(within(bookRow('斗罗')).getByRole('button', { name: '都加架' }))
    await waitFor(() => expect(within(bookRow('斗罗')).queryAllByRole('button', { name: '＋ 加书架' })).toHaveLength(0))
    fireEvent.click(main())                                        // 收起：展开区整块离开 DOM
    expect(bookRow('斗罗').querySelectorAll('.novel-hit-title')).toHaveLength(0)
    fireEvent.click(main())                                        // 再展开
    expect(within(bookRow('斗罗')).getAllByRole('button', { name: '已在书架' }), '收起再展开把账洗掉了').toHaveLength(2)
    expect(within(bookRow('斗罗')).getByRole('button', { name: '都在架' })).toBeTruthy()
  })

  it('切阅读器再回搜索：落架行仍显示已落（落架账在面板期投影里，不随视图卸载蒸发）', async () => {
    const apiSend = vi.fn(async () => ({}))
    const searchDeps = coreDeps({
      apiSend,
      apiGet: vi.fn(async (path: string) => {
        if (path === ROUTES.shelf.path) return []
        return { job: snap({ keyword: '斗罗', phase: 'done', total: 1, done: 1, next: 1, added: [hitGroup('斗罗')] }) }
      }),
    })
    const first = mountSearch(searchDeps)
    await waitFor(() => expect(screen.getByText(/1 家源/)).toBeTruthy())
    fireEvent.click(bookRow('斗罗').querySelector('.novel-book-main') as HTMLElement)
    fireEvent.click(within(bookRow('斗罗')).getByRole('button', { name: '＋ 加书架' }))
    await waitFor(() => expect(within(bookRow('斗罗')).getAllByRole('button', { name: '已在书架' })).toHaveLength(1))
    first.unmount()

    const readerApi = makeReaderDeps()
    const reader = render(createElement(ReaderView, {
      sourceId: 's1', bookKey: 'https://s.com/book/1', title: '斗罗', deps: readerApi,
    }))
    await waitFor(() => expect(
      (readerApi.apiGet as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).startsWith(ROUTES.shelf.path)),
    ).toBe(true))
    reader.unmount()

    mountSearch(searchDeps)
    await waitFor(() => expect(screen.getByText(/1 家源/)).toBeTruthy())
    fireEvent.click(bookRow('斗罗').querySelector('.novel-book-main') as HTMLElement)
    expect(within(bookRow('斗罗')).getAllByRole('button', { name: '已在书架' }), '切去阅读器再回来把落架账洗掉了').toHaveLength(1)
    expect(within(bookRow('斗罗')).queryAllByRole('button', { name: '＋ 加书架' })).toHaveLength(0)
  })

  it('面板重开直接落在搜索页：投影先取服务端书架当基线，已在架的书不写成「＋ 加书架」', async () => {
    // routeStore 跨卸载存活、panelShelf 随面板卸载清空：只进过搜索页的面板重开时，基线不能指
    // 望书架 tab 或阅读器替它取（裁决与后果见 `ADR-0046`）。
    const onShelf = {
      bookKey: 'https://s.com/book/1', sourceId: 's1', title: '斗罗', addedAt: 1,
      progress: { chapterIndex: 0, offsetRatio: 0, updatedAt: 1 },
    }
    const deps = coreDeps({
      apiSend: vi.fn(async () => ({})),
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? [onShelf]
        : ({ job: snap({ keyword: '斗罗', phase: 'done', total: 1, done: 1, next: 1, added: [hitGroup('斗罗')] }) })),
    })
    mountSearch(deps)
    await waitFor(() => expect(bookRow('斗罗')).toBeTruthy())
    fireEvent.click(bookRow('斗罗').querySelector('.novel-book-main') as HTMLElement)
    expect(within(bookRow('斗罗')).getByRole('button', { name: '已在书架' }), '服务端在册的书又被写成「＋ 加书架」').toBeTruthy()
    expect(within(bookRow('斗罗')).getByRole('button', { name: '都在架' })).toBeTruthy()
    expect(deps.apiSend, '基线已在册：不该再为它们发幂等 PUT').not.toHaveBeenCalled()
  })

  it('一家给两行：家数报 1、都加架发两条、回执单位是「条」', async () => {
    // `searchOne` 不做源内去重，同一家可以合法给出装饰写法与裸写法两条：拿行数当家数会把
    // 「只有一家答话」念成两家，拿家数当回执数会把没上架的那条吞掉。
    const apiSend = vi.fn(async () => ({}))
    const pushOk = vi.fn()
    const deps = coreDeps({
      apiSend, pushOk,
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({
          keyword: '斗罗', phase: 'done', total: 1, done: 1, next: 1,
          added: [{
            sourceId: 's1', sourceName: 'S', status: 'verified',
            hits: [
              hit({ title: '斗罗', url: 'https://s.com/a' }),
              hit({ title: '《斗罗》', url: 'https://s.com/b' }),
            ],
          }],
        }),
      })),
    })
    mountSearch(deps)
    await waitFor(() => expect(screen.getByText(/1 家源/)).toBeTruthy())   // 家数按去重后的源计
    // 展开钮承诺的是行（条）不是家：一家两行时「N 家源」与「展开 N 条」必然分岔，
    // 单位口径（家=去重源、条=行、本=归并后书目）由此钉住，界面与 README 不能各说各话
    expect(booksAxis().querySelector('.novel-book-tail')?.textContent,
      '展开读的是条不是家').toContain('展开 2 条')
    // 单位律的另外两处读数同样数**行**：这一家给了两行、只归并出一本。负钉按**面**扫——
    // 数行的读数（组头计数、收口的命中条数）念成「本」就红；合法的「N 本」只有并书与超限两处，
    // 各另有正钉（整页扫会把它们误伤，故这条负钉按面扫）。
    expect(screen.getByText(/本轮搜过/).textContent, '收口报的是条不是本').toContain('命中 2 条')
    expect(screen.getByText(/本轮搜过/).textContent, '并书读数吃归并结果：两行并成一本').toContain('并成 1 本')
    expect(screen.getByText(/本轮搜过/).textContent.replace(/并成 [0-9]+ 本/, ''), '收口里数行的读数不许念成「本」')
      .not.toMatch(/[0-9] 本/)
    for (const muted of [...openPerSourceAxis().querySelectorAll('.novel-muted')])
      expect(muted.textContent, '组头数的是这一家的行，不许念成书').not.toMatch(/[0-9] 本/)
    expect(within(openPerSourceAxis()).getByText('2 条'), '组头数的是这一家的两行').toBeTruthy()
    fireEvent.click(within(booksAxis()).getByRole('button', { name: '都加架' }))
    await waitFor(() => expect(apiSend).toHaveBeenCalledTimes(2))           // 两条都在册：少发一条就是漏上架
    await waitFor(() => expect(pushOk).toHaveBeenCalledWith('已加 2 个架位：斗罗'))
    openBookFold()   // 这一句读的是展开区里的名字：先展开，证的才是「展开看得见」而不是 jsdom 打得进收起折叠
    expect(within(booksAxis()).getAllByText('《斗罗》'), '这一家把它叫作什么也要看得见').toHaveLength(1)
  })

  it('同一家同一地址的两行写法：PUT 照发行发行、回执按架位计——一个架位不许念成两个', async () => {
    // 架位口径住 `Shelf`（跨源同址同理）：同址两行各发一发幂等 PUT，落架只有一个架位。按成功 PUT 计数
    // 的回执会报「已加 2 个架位」——架上的账被夸大一条（变异：回执改回数 fulfilled 的条数即红）。
    const apiSend = vi.fn(async () => ({}))
    const pushOk = vi.fn()
    const pushError = vi.fn()
    const deps = coreDeps({
      apiSend, pushOk, pushError,
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({
          keyword: '斗罗', phase: 'done', total: 1, done: 1, next: 1,
          added: [{
            sourceId: 's1', sourceName: 'S', status: 'verified',
            hits: [
              hit({ title: '斗罗', url: 'https://s.com/a' }),
              hit({ title: '《斗罗》', url: 'https://s.com/a' }),
            ],
          }],
        }),
      })),
    })
    mountSearch(deps)
    await waitFor(() => expect(screen.getByText(/1 家源/)).toBeTruthy())
    expect(booksAxis().querySelector('.novel-book-tail')?.textContent,
      '行读数不因同址而缩：两条写法都在册').toContain('展开 2 条')
    fireEvent.click(within(booksAxis()).getByRole('button', { name: '都加架' }))
    await waitFor(() => expect(apiSend).toHaveBeenCalledTimes(2))           // 逐行照发：发不发是行的账，幂等归服务端
    await waitFor(() => expect(pushOk).toHaveBeenCalledWith('已加 1 个架位：斗罗'))
    expect(pushError, '一个架位落架即全数落架，不该有失败回执').not.toHaveBeenCalled()
  })

  it('两家源给同一个地址：两发 PUT 只落一个架位，回执与三条读数各归各', async () => {
    // 架位凭地址认（口径住 `Shelf`，词条见 CONTEXT 的「架位」）：两家各给一发幂等 PUT，架上只多一条。
    // 行读数照旧数两条、家数照旧报两家——三条读数不许因同址互相吃掉（单位律住「作品视图（按书）」）。
    // 变异：把架位算式退回 (源, 地址) 即报「已加 2 个架位」，架上的账被夸大一条。
    const apiSend = vi.fn(async () => ({}))
    const pushOk = vi.fn()
    const pushError = vi.fn()
    const deps = coreDeps({
      apiSend, pushOk, pushError,
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({ keyword: '斗罗', phase: 'done', total: 2, done: 2, next: 2, added: [hitGroup('斗罗', 's1', { url: 'https://s.com/a' }), hitGroup('斗罗', 's2', { url: 'https://s.com/a' })] }),
      })),
    })
    mountSearch(deps)
    await waitFor(() => expect(screen.getByText(/2 家源/)).toBeTruthy())
    expect(booksAxis().querySelector('.novel-book-tail')?.textContent,
      '同址不缩行读数：两家各一条，照数两条').toContain('展开 2 条')
    fireEvent.click(within(booksAxis()).getByRole('button', { name: '都加架' }))
    await waitFor(() => expect(apiSend).toHaveBeenCalledTimes(2))            // 逐行照发：发不发是行的账，幂等归服务端
    await waitFor(() => expect(pushOk).toHaveBeenCalledWith('已加 1 个架位：斗罗'))
    expect(pushError, '两发都成，不该有失败回执').not.toHaveBeenCalled()
    expect(within(booksAxis()).getByRole('button', { name: '都在架' }), '一个架位落定即整本齐').toBeTruthy()
  })

  it('都加架有失败：成功数与失败数各报一次（点了一下必须有个交代）', async () => {
    let calls = 0
    const apiSend = vi.fn(async () => { calls++; if (calls === 2) throw new Error('磁盘只读'); return {} })
    const pushOk = vi.fn()
    const pushError = vi.fn()
    const deps = coreDeps({
      apiSend, pushOk, pushError,
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({ keyword: '斗罗', phase: 'done', total: 2, done: 2, next: 2, added: [hitGroup('斗罗', 's1', { url: 'https://s.com/1' }), hitGroup('斗罗', 's2', { url: 'https://s.com/2' })] }),
      })),
    })
    mountSearch(deps)
    await waitFor(() => expect(screen.getByText(/2 家源/)).toBeTruthy())
    fireEvent.click(within(booksAxis()).getByRole('button', { name: '都加架' }))
    await waitFor(() => expect(pushOk).toHaveBeenCalledWith('已加 1 个架位：斗罗'))
    expect(pushError).toHaveBeenCalledWith('加入失败 1 个架位（共 2）')   // 只报成功数＝静默吞掉没加上的那条
  })

  it('都加架不替「没有地址」那一行发 PUT，也不把它算成失败', async () => {
    // 无 url 的命中在逐源行上本就不给动作（既进不了阅读器也加不了架）；书行的批量动作替它
    // 发一发空架位 PUT，就是写进一条没有书面的架位、还要回头报「已加」——两头谎。
    const apiSend = vi.fn<ApiSendStub>(async () => ({}))
    const pushOk = vi.fn()
    const pushError = vi.fn()
    const deps = coreDeps({
      apiSend, pushOk, pushError,
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({
          keyword: '斗罗', phase: 'done', total: 1, done: 1, next: 1,
          added: [{
            sourceId: 's1', sourceName: 'S', status: 'verified',
            hits: [
              hit({ title: '斗罗', url: 'https://s.com/a' }),
              hit({ title: '斗罗', url: null }),
            ],
          }],
        }),
      })),
    })
    mountSearch(deps)
    await waitFor(() => expect(screen.getByText(/1 家源/)).toBeTruthy())
    fireEvent.click(within(booksAxis()).getByRole('button', { name: '都加架' }))
    await waitFor(() => expect(pushOk).toHaveBeenCalledWith('已加 1 个架位：斗罗'))
    expect(apiSend).toHaveBeenCalledTimes(1)                     // 只发有地址那一行
    expect(pick(apiSend.mock.calls, 0)[0].path).toBe(paramOps.shelfPut.path('https://s.com/a'))
    expect(pushError).toHaveBeenCalledWith('1 条没有地址，加不了架')   // 没试过不是失败，点名说清
    expect(pushError.mock.calls.map((c) => String(c[0])).join(), '不许把没发的算进失败数').not.toMatch(/加入失败/)
  })

  it('都加架一物未加（整行都没有地址）：成功通道不响，交代只有「没有地址」那一句', async () => {
    // 撤掉「有加成才报成功」那道闸的变异就在这一条红：整行没有地址时 ok 恒 0，
    // 「已加 0 个架位：X」是给一次没发生的写入报喜——点了一下、什么都没加，成功 toast 却响了。
    // 架空与全部 PUT 失败读出来都是 0，两种结局挤进同一句成功话；零加成的交代改由错误通道给。
    const apiSend = vi.fn<ApiSendStub>(async () => ({}))
    const pushOk = vi.fn()
    const pushError = vi.fn()
    const deps = coreDeps({
      apiSend, pushOk, pushError,
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({
          keyword: '斗罗', phase: 'done', total: 1, done: 1, next: 1,
          added: [{
            sourceId: 's1', sourceName: 'S', status: 'verified',
            hits: [
              hit({ title: '斗罗', url: null }),
              hit({ title: '《斗罗》', url: null }),
            ],
          }],
        }),
      })),
    })
    mountSearch(deps)
    await waitFor(() => expect(screen.getByText(/1 家源/)).toBeTruthy())
    fireEvent.click(within(booksAxis()).getByRole('button', { name: '都加架' }))
    await waitFor(() => expect(pushError).toHaveBeenCalledWith('2 条没有地址，加不了架'))
    expect(pushOk, '零加成不许报成功').not.toHaveBeenCalled()
    expect(pushError).toHaveBeenCalledTimes(1)                     // 一句话只说一次：两条都在册，不拆成两声
    expect(apiSend).not.toHaveBeenCalled()                        // 一发都不出：空架位 PUT 写的是没有书面的架位
    fireEvent.click(must(bookRow('斗罗').querySelector('.novel-book-main'), '书行行头主钮'))
    expect(bookRow('斗罗').querySelectorAll('.novel-row-dead'), '同一家给两种写法仍是两行，不许收成一行').toHaveLength(2)
  })

  it('都加架全部失败：只有失败那一句，成功通道同样不响', async () => {
    // 与上一条是两种 0：这次每发都试了、每发都炸。共用「已加 0 个架位：X」就是把写失败的读数
    // 说成写成功了半边——回执的两条通道各管各的结局，才点得出差别。
    const apiSend = vi.fn(async () => { throw new Error('磁盘只读') })
    const pushOk = vi.fn()
    const pushError = vi.fn()
    const deps = coreDeps({
      apiSend, pushOk, pushError,
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({ keyword: '斗罗', phase: 'done', total: 2, done: 2, next: 2, added: [hitGroup('斗罗', 's1', { url: 'https://s.com/1' }), hitGroup('斗罗', 's2', { url: 'https://s.com/2' })] }),
      })),
    })
    mountSearch(deps)
    await waitFor(() => expect(screen.getByText(/2 家源/)).toBeTruthy())
    fireEvent.click(within(booksAxis()).getByRole('button', { name: '都加架' }))
    await waitFor(() => expect(pushError).toHaveBeenCalledWith('加入失败 2 个架位（共 2）'))
    expect(pushOk, '一条也没加上就不许报成功').not.toHaveBeenCalled()
    expect(pushError).toHaveBeenCalledTimes(1)
  })

  it('书行的动作不带第二份字段映射：加架发的还是那一份元数据（封面／简介／最新章回读本组命中）', async () => {
    // 归并只带「这一家把它叫作什么」与地址；按书成了默认视图之后，若这条 PUT 不回读命中本身，
    // 书架卡片就少一张封面——那是主路径的可见退化，不是「少带一个可选字段」。
    const apiSend = vi.fn<ApiSendStub>(async () => ({}))
    const deps = coreDeps({
      apiSend,
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({
          keyword: '斗罗', phase: 'done', total: 1, done: 1, next: 1,
          added: [{
            sourceId: 's1', sourceName: 'S', status: 'verified',
            hits: [
              hit({
                title: '斗罗', author: '甲', url: 'https://s.com/a', coverUrl: 'https://c/1.jpg',
                intro: '第一章就打架', lastChapterName: '第 9 章', kind: '玄幻', wordCount: '12 万字',
              }),
              hit({
                title: '斗罗', author: '甲', url: 'https://s.com/b', coverUrl: 'https://c/1.jpg',
                intro: '第一章就打架', lastChapterName: '第 9 章', kind: '玄幻', wordCount: '12 万字',
              }),
            ],
          }],
        }),
      })),
    })
    mountSearch(deps)
    await waitFor(() => expect(screen.getByText(/1 家源/)).toBeTruthy())
    const putBodies = (): unknown[] => apiSend.mock.calls.filter((c) => c[0].method === 'PUT').map((c) => c[1])
    // 展开后的逐源行走同一条接线：＋加书架 不许比都加架少带字段（先真展开：读的是展开区）
    openBookFold()
    fireEvent.click(pick(within(booksAxis()).getAllByRole('button', { name: '＋ 加书架' }), 0))
    await waitFor(() => expect(putBodies()).toHaveLength(1))
    // 再点都加架：已落架那一条不发，补的是第二条（同一份字段映射，两个入口）
    fireEvent.click(within(booksAxis()).getByRole('button', { name: '都加架' }))
    await waitFor(() => expect(putBodies()).toHaveLength(2))
    for (const body of putBodies())
      expect(body, '两个入口发的必须是同一份元数据').toMatchObject({
        sourceId: 's1', title: '斗罗', author: '甲', coverUrl: 'https://c/1.jpg',
        intro: '第一章就打架', lastChapterName: '第 9 章', kind: '玄幻', wordCount: '12 万字',
      })
  })

  it('同一家给两种写法：逐源行各回读各的元数据（地址参与行身份）', async () => {
    // 行身份少了地址，第二条就会顶用第一条的封面与最新章——两行看着都动了作，存的却是同一份元数据
    const apiSend = vi.fn<ApiSendStub>(async () => ({}))
    const pushOk = vi.fn()
    const deps = coreDeps({
      apiSend, pushOk,
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({
          keyword: '斗罗', phase: 'done', total: 1, done: 1, next: 1,
          added: [{
            sourceId: 's1', sourceName: 'S', status: 'verified',
            hits: [
              hit({ title: '斗罗', url: 'https://s.com/a', coverUrl: 'https://c/a.jpg', lastChapterName: '第 1 章' }),
              hit({ title: '《斗罗》', url: 'https://s.com/b', coverUrl: 'https://c/b.jpg', lastChapterName: '第 2 章' }),
            ],
          }],
        }),
      })),
    })
    mountSearch(deps)
    await waitFor(() => expect(screen.getByText(/1 家源/)).toBeTruthy())
    fireEvent.click(within(booksAxis()).getByRole('button', { name: '都加架' }))
    await waitFor(() => expect(pushOk).toHaveBeenCalledWith('已加 2 个架位：斗罗'))
    expect(apiSend.mock.calls.map((c) => (c[1] as { coverUrl: string }).coverUrl)).toEqual(['https://c/a.jpg', 'https://c/b.jpg'])
    expect(apiSend.mock.calls.map((c) => (c[1] as { title: string }).title)).toEqual(['斗罗', '《斗罗》'])
  })

  it('超出上限：那一行报出全量本数，不把「还有更多」吞成结束', async () => {
    const hits = Array.from({ length: SEARCH_BOOKS_CAP + 1 }, (_, i) => hit({
      title: `斗罗第${i}部`, url: `https://s.com/${i}`,
    }))
    const deps = coreDeps({
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({ keyword: '斗罗', phase: 'done', total: 1, done: 1, next: 1, added: [{ sourceId: 's1', sourceName: 'S', status: 'verified', hits }] }),
      })),
    })
    mountSearch(deps)
    await waitFor(() => expect(screen.getByText(new RegExp(`本轮共 ${SEARCH_BOOKS_CAP + 1} 本，只列前 ${SEARCH_BOOKS_CAP}`))).toBeTruthy())
    const books = booksAxis()
    expect(books.querySelectorAll('[data-novel-book]')).toHaveLength(SEARCH_BOOKS_CAP)   // 视图真按上限截断
    expect(books.textContent, '没列出来的那一本不许既不出现在视图里、也不出现在上限说明里').not.toContain(`斗罗第${SEARCH_BOOKS_CAP}部`)
  })

  it('整轮都被判 suspect：按书视图空着也不许读成「没有结果」——账在按源那一档里', async () => {
    const deps = coreDeps({
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({ keyword: '斗罗', phase: 'done', total: 1, done: 1, next: 1, added: [hitGroup('命中', 's1', { inView: false })] }),
      })),
    })
    mountSearch(deps)
    await waitFor(() => expect(screen.getByText(/按源看/)).toBeTruthy())
    expect(screen.queryByText(/没有结果/)).toBeNull()                 // 空态只属于「一个组都没回来」
    expect(screen.queryByText(/没有参与搜索的书源/)).toBeNull()
    expect(document.querySelector('[data-novel-books]')).toBeNull()  // 空视图不占版面
    // 收口那两个数与组头同源：按书视图空着的时候，「相关 0 条」这句还得说得出（单位是行不是本）
    expect(screen.getByText(/本轮搜过/).textContent).toContain('相关 0 条')
    expect(openPerSourceAxis().textContent).toContain('另有 1 条疑似无关')
  })

  it('页尾那条按源折叠：默认收着，点收口行才展开——降级不删，也不许顺手把折叠改回常摆', async () => {
    // 变异：把这一档的 <details> 换成 <div>（或删掉 summary）——整串用例只读文本，换掉照样绿，
    // 于是「降级成折叠」这条裁决可以在没人看见的地方被翻回去。钉的是 DOM 事实，不是文本在场。
    const deps = coreDeps({
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({ keyword: '斗罗', phase: 'done', total: 2, done: 2, next: 2, added: [hitGroup('斗罗', 's1'), hitGroup('斗罗', 's2')] }),
      })),
    })
    mountSearch(deps)
    await waitFor(() => expect(screen.getByText(/2 家源/)).toBeTruthy())
    const axis = perSourceAxis()
    expect(axis.tagName, '按源那一档必须是折叠件：常摆就把首屏还给两千屏列表').toBe('DETAILS')
    expect((axis as HTMLDetailsElement).open, '默认收起：页尾那一档不许抢按书的版面').toBe(false)
    const summary = axis.querySelector('summary')
    expect(summary, '折叠要有收口行，否则没人打得开它').not.toBeNull()
    fireEvent.click(summary as HTMLElement)
    expect((axis as HTMLDetailsElement).open, '点收口行要真能展开').toBe(true)
    // 展开的读数：那两家的账都在里面（降级不删）
    expect(within(axis).getAllByLabelText('阅读 斗罗')).toHaveLength(2)
    expect(String(summary?.textContent)).toContain('2 家')
  })

  it('按书行的 key 认名字不认位置：新一轮到达把书目重排后，展开的那一本还开着', async () => {
    // 流式轮次里组陆续到达，同档那一条子句按「家数降序」重排书目；纯下标 key 会把展开态
    // 串到别的书上（用户展开的是甲，重排后开的是乙）——那是「刚点的东西自己关了」的界面噪声。
    const frames: Array<(data: string) => void> = []
    const deps = coreDeps({
      apiSend: vi.fn(async () => ({ jobId: 'j1' })),
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({ job: null })),
      apiEventStream: vi.fn(async (_p: string, onFrame: (d: string) => void) => {
        frames.push(onFrame)
        return new Promise<void>(() => {})
      }),
    })
    mountSearch(deps)
    fireEvent.change(screen.getByPlaceholderText('书名 / 作者'), { target: { value: '斗罗' } })
    fireEvent.submit(screen.getByRole('form'))
    await waitFor(() => expect(frames.length).toBe(1))
    pick(frames, 0)(JSON.stringify({
      job: snap({ phase: 'running', total: 3, done: 2, next: 2, added: [hitGroup('斗罗甲', 's1'), hitGroup('斗罗乙', 's2')] }),
    }))
    await waitFor(() => expect(booksAxis().querySelectorAll('[data-novel-book]')).toHaveLength(2))
    const rowOf = (title: string): Element => {
      // 每次重新按容器取：重排之后拿旧 NodeList 的槽位找行，拿到的就是别人家的展开态
      const row = [...booksAxis().querySelectorAll('[data-novel-book]')]
        .find((r) => r.querySelector('strong')?.textContent === title)
      if (row === undefined) throw new Error(`没有「${title}」那一行`)
      return row
    }
    const expandedOf = (title: string): string | null =>
      rowOf(title).querySelector('.novel-book-main')?.getAttribute('aria-expanded') ?? null
    fireEvent.click(must(rowOf('斗罗甲').querySelector('.novel-book-main'), '书行行头主钮'))
    expect(expandedOf('斗罗甲')).toBe('true')

    pick(frames, 0)(JSON.stringify({ job: snap({ phase: 'done', total: 3, done: 3, next: 3, added: [hitGroup('斗罗乙', 's3')] }) }))
    await waitFor(() => expect(booksAxis().querySelectorAll('[data-novel-book]')).toHaveLength(2))
    expect([...booksAxis().querySelectorAll('[data-novel-book] > .novel-book-main strong')].map((s) => s.textContent),
      '乙现在两家答话，同档按家数降序排到前面').toEqual(['斗罗乙', '斗罗甲'])
    expect(expandedOf('斗罗甲'),
      '展开态跟着那一本走，不跟着位置走').toBe('true')
    expect(expandedOf('斗罗乙')).toBe('false')
  })

  it('逐源行的 key 认地址：换一轮搜同一本书、同一家给了新指向，新行不许顶用上一行的「已在书架」', async () => {
    // 变异：把这一行的 key 退回 (源, 下标)。地址不在 key 里 ⇒ 换轮之后同一家、同一下标、换了
    // 地址的那一行被 React 认成上一轮那一行，本地入架态跟着搬过来——界面写着「已在书架」，
    // 而架子上根本没有这一条地址，「读这本／＋架」两个动作点的是另一条书面。
    // 桩按服务端的形状给：一轮之内一家只发一组，换轮靠任务身份切换（累加器整体重读）。
    const groupWith = (url: string): SearchGroup[] => [{
      sourceId: 's1', sourceName: 'S', status: 'verified',
      hits: [hit({ title: '斗罗', url })],
    }]
    // 第二轮的基线只在身份切换后被读到（since=0）；没有任务身份时读回「还没有任务」
    let baseline: SearchJobSnapshot | null = null
    // POST search/job 要回 jobId（否则整轮被读成「任务已不可读」），PUT 的返回值没人读
    const apiSend = vi.fn<ApiSendStub>(async () => ({ jobId: 'j1' }))
    const frames: Array<(data: string) => void> = []
    const deps = coreDeps({
      apiSend,
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({ job: baseline })),
      apiEventStream: vi.fn(async (_p: string, onFrame: (d: string) => void) => {
        frames.push(onFrame)
        return new Promise<void>(() => {})
      }),
    })
    mountSearch(deps)
    fireEvent.change(screen.getByPlaceholderText('书名 / 作者'), { target: { value: '斗罗' } })
    fireEvent.submit(screen.getByRole('form'))
    await waitFor(() => expect(frames.length).toBe(1))
    pick(frames, 0)(JSON.stringify({ job: snap({ id: 'j1', phase: 'running', done: 1, total: 2, next: 1, added: groupWith('https://s.com/a') }) }))
    await waitFor(() => expect(bookRow('斗罗')).toBeTruthy())
    fireEvent.click(must(bookRow('斗罗').querySelector('.novel-book-main'), '书行行头主钮'))
    fireEvent.click(within(bookRow('斗罗')).getByRole('button', { name: '＋ 加书架' }))
    await waitFor(() => expect(within(bookRow('斗罗')).getByRole('button', { name: '已在书架' })).toBeTruthy())

    baseline = snap({ id: 'j2', phase: 'done', done: 2, total: 2, next: 2, added: groupWith('https://s.com/b') })
    pick(frames, 0)(JSON.stringify({ job: baseline }))          // 身份一变，客户端就按 since=0 重读整轮基线
    await waitFor(() => expect(within(bookRow('斗罗')).getByRole('button', { name: '＋ 加书架' })).toBeTruthy())
    expect(within(bookRow('斗罗')).queryByRole('button', { name: '已在书架' }),
      '换了指向就是新的一行：上一轮那一行的入架态不属于它').toBeNull()
    // 那一行确实活着（不是「查不到才看着像未加」）：点它，PUT 落在新地址上
    fireEvent.click(within(bookRow('斗罗')).getByRole('button', { name: '＋ 加书架' }))
    await waitFor(() => expect(within(bookRow('斗罗')).getByRole('button', { name: '已在书架' })).toBeTruthy())
    const puts = apiSend.mock.calls.filter((c) => c[0].method === 'PUT')
    expect(puts, '两轮各点各的：上一轮那一发不是这一行点的').toHaveLength(2)
    expect(pick(puts, 1)[0].path).toBe(paramOps.shelfPut.path('https://s.com/b'))
  })

  it('陈旧快照防线：第二轮落地后，第一轮的迟到响应不许污染结果', async () => {
    let posts = 0
    let resolveStale: (v: unknown) => void = () => {}
    const deps = coreDeps({
      apiSend: vi.fn(async () => { posts++; return { jobId: posts === 1 ? 'A' : 'B' } }),
      apiGet: vi.fn((path: string) => {
        if (path === ROUTES.shelf.path) return Promise.resolve([])       // 落架基线那一问不归本用例
        if (path !== `${ROUTES.searchJobStatus.path}?since=0`) return Promise.resolve({ job: null })
        if (posts === 0) return Promise.resolve({ job: null })                  // 挂载读：还没有任务
        if (posts === 1) return new Promise((res) => { resolveStale = res })     // 第一轮首拍挂起
        return Promise.resolve({                                               // 第二轮秒回且已终态
          job: snap({ id: 'B', keyword: '第二', added: [hitGroup('第二轮书')], next: 1 }),
        })
      }),
    })
    mountSearch(deps)
    const input = screen.getByPlaceholderText('书名 / 作者')
    fireEvent.change(input, { target: { value: '第一轮' } })
    fireEvent.submit(screen.getByRole('form'))
    await waitFor(() => expect(snapshotReads(deps.apiGet)).toBe(2))              // 挂载读 + 第一轮首拍
    fireEvent.change(input, { target: { value: '第二轮' } })
    fireEvent.submit(screen.getByRole('form'))
    await waitFor(() => expect(bookRow('第二轮书')).toBeTruthy())

    resolveStale({ job: snap({ id: 'A', keyword: '第一轮', added: [hitGroup('第一轮书')], next: 1 }) })
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText('第一轮书')).toBeNull()              // 迟到的上一轮在两轴都不许留痕
    expect(bookRow('第二轮书')).toBeTruthy()
  })

  it('空参与集与「搜了没命中」分得清：total=0 → 引导导入书源；total>0 零分组 → 换关键词', async () => {
    const view = mountSearch(coreDeps({
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path ? [] : ({ job: snap({ total: 0, done: 0, next: 0 }) })),
    }))
    await waitFor(() => expect(screen.getByText(/没有参与搜索的书源/)).toBeTruthy())
    view.unmount()
    mountSearch(coreDeps({
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path ? [] : ({ job: snap({ added: [], next: 0 }) })),
    }))
    await waitFor(() => expect(screen.getByText('没有结果')).toBeTruthy())
  })

  it('读面失败：显式「搜索中断」且不排下一次轮询（否则 spinner 到天荒地老）', async () => {
    let reads = 0
    const deps = coreDeps({
      apiGet: vi.fn(async (path: string) => {
        if (path === ROUTES.shelf.path) return []      // 落架基线那一问不归本用例
        reads++
        if (reads === 1) return { job: null }                 // 挂载读：还没有任务
        throw new Error('连接断了')                            // 提交后的首拍失败
      }),
      apiSend: vi.fn(async () => ({ jobId: 'j1' })),
    })
    mountSearch(deps)
    fireEvent.change(screen.getByPlaceholderText('书名 / 作者'), { target: { value: '斗罗' } })
    fireEvent.submit(screen.getByRole('form'))
    await waitFor(() => expect(screen.getByText(/搜索中断：搜索结果读取失败：连接断了/)).toBeTruthy())
    await new Promise((r) => setTimeout(r, 900))
    expect(reads).toBe(2)                                     // 读不到就收手：不刷屏
  })

  it('提交失败：如实报错，且不清掉已在手上的上一轮结果', async () => {
    const deps = coreDeps({
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({ job: snap({ keyword: '上一轮', added: [hitGroup('上一轮命中')], next: 1 }) })),
      apiSend: vi.fn(async () => { throw new Error('服务未挂载') }),
    })
    mountSearch(deps)
    await waitFor(() => expect(bookRow('上一轮命中')).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText('书名 / 作者'), { target: { value: '斗罗' } })
    fireEvent.submit(screen.getByRole('form'))
    await waitFor(() => expect(screen.getByText(/搜索提交失败：服务未挂载/)).toBeTruthy())
    expect(bookRow('上一轮命中')).toBeTruthy()        // 服务端没起新轮 → 旧结果仍是真相
  })

  it('停止搜索：跑着才有钮、点它只发 job-cancel、已搜出的命中留着且不报红条', async () => {
    const frames: Array<(data: string) => void> = []
    const deps = coreDeps({
      apiSend: vi.fn(async () => ({ jobId: 'j1' })),
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({ job: null })),
      apiEventStream: vi.fn(async (_p: string, onFrame: (d: string) => void) => {
        frames.push(onFrame)
        return new Promise<void>(() => {})              // 流一直开着：读数只可能来自帧
      }),
    })
    mountSearch(deps)
    expect(screen.queryByRole('button', { name: '停止搜索' })).toBeNull()   // 还没这一轮：不给死钮
    fireEvent.change(screen.getByPlaceholderText('书名 / 作者'), { target: { value: '斗罗' } })
    fireEvent.submit(screen.getByRole('form'))
    await waitFor(() => expect(frames.length).toBe(1))
    // 提交后立刻有钮（不必等第一帧）：用户随时可以说「别再往下搜了」
    expect(screen.getByRole('button', { name: '停止搜索' })).toBeTruthy()
    pick(frames, 0)(JSON.stringify({ job: snap({ phase: 'running', total: 3, done: 1, next: 1, added: [hitGroup('斗罗先回来的书')] }) }))
    await waitFor(() => expect(within(openPerSourceAxis()).getByText('斗罗先回来的书')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '停止搜索' }))
    expect(deps.apiSend).toHaveBeenLastCalledWith(ROUTES.searchJobCancel, {})
    pick(frames, 0)(JSON.stringify({ job: snap({ phase: 'failed', cancelled: true, error: '任务已取消：用户停止了搜索',
      total: 3, done: 2, next: 2, added: [hitGroup('斗罗停止前又回来一本', 's2')] }) }))
    await waitFor(() => expect(screen.getByText(/已停止 · 本轮搜过/)).toBeTruthy())
    // 收口数字只算**真搜完的**：计划 3 家、停止前只回来 2 组，就不许报「搜过 3 家」；
    // 进度条同理：停止的轮次不许倒填 100%——百分比按实际完成与计划之差算
    expect(screen.getByText(/本轮搜过/).textContent).toMatch(/本轮搜过 2 家/)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('67')
    expect(within(openPerSourceAxis()).getByText('斗罗先回来的书')).toBeTruthy()   // 停止 ≠ 放弃已经搜出来的
    expect(within(openPerSourceAxis()).getByText('斗罗停止前又回来一本')).toBeTruthy()
    expect(screen.queryByText(/搜索中断/)).toBeNull()                 // 自己按的停止不是错误
    expect(screen.queryByRole('button', { name: '停止搜索' })).toBeNull()   // 收口行不留死钮
    expect(screen.getByRole('button', { name: '搜索' })).toBeTruthy()       // 再搜是新一轮
  })

  it('推送可用时读数从帧里来：本轮零次快照轮询，终态帧自己关流', async () => {
    let closed = false
    const frames: Array<(data: string) => void> = []
    const deps = coreDeps({
      apiSend: vi.fn(async () => ({ jobId: 'j1' })),
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({ job: null })),                 // 只有挂载那一次读
      apiEventStream: vi.fn(async (_path: string, onFrame: (d: string) => void, signal: AbortSignal) => {
        frames.push(onFrame)
        await new Promise<void>((r) => signal.addEventListener('abort', () => { closed = true; r() }))
      }),
    })
    mountSearch(deps)
    fireEvent.change(screen.getByPlaceholderText('书名 / 作者'), { target: { value: '斗罗' } })
    fireEvent.submit(screen.getByRole('form'))
    await waitFor(() => expect(frames.length).toBe(1))
    pick(frames, 0)(JSON.stringify({ job: snap({ phase: 'running', total: 2, done: 1, next: 1, added: [hitGroup('斗罗推送来的书')] }) }))
    await waitFor(() => expect(within(openPerSourceAxis()).getByText('斗罗推送来的书')).toBeTruthy())
    await new Promise((r) => setTimeout(r, 900))                  // 越过两个 JOB_POLL_MS 节拍
    expect(snapshotReads(deps.apiGet)).toBe(1)                   // 一轮都没轮：流在，就不必问
    pick(frames, 0)(JSON.stringify({ job: snap({ phase: 'done', total: 2, done: 2, next: 2, added: [hitGroup('斗罗收尾的书', 's2')] }) }))
    await waitFor(() => expect(screen.getByText(/本轮搜过/)).toBeTruthy())
    expect(within(openPerSourceAxis()).getByText('斗罗收尾的书')).toBeTruthy()
    await waitFor(() => expect(closed).toBe(true))                // 终态帧后自己关流，不留着占连接
  })

  it('英文：搜索框占位与提交按钮', async () => {
    const deps = coreDeps({ apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path ? [] : ({ job: null })) })
    render(createElement(CopyProvider, { value: enTranslate, children: createElement(SearchView, { deps }) }))
    expect(screen.getByPlaceholderText('Book title / author')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy()
  })

  /** 收口行的相关数数的是**命中**（`RoundCounts.kept`），紧挨着它的「(from N sources」数的是源：
   *  英文若写成「N of them」就会被读成源数，单位必须跟着条数走。单复数两条键各钉一次。
   *  同时钉 from 子句的前导空格：少了它，英文会渲染成「2 books(from 2 sources…」。 */
  it('英文：收口汇总的相关数按命中条数报（单数）', async () => {
    const deps = coreDeps({
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({
          keyword: '斗罗', phase: 'done', next: 1, total: 1, done: 1,
          added: [{
            sourceId: 's1', sourceName: 'S', status: 'verified',
            hits: [
              hit({ title: '斗罗', author: '唐家', url: 'https://s.com/a' }),
              hit({ title: '完全无关的书', url: 'https://s.com/b' }),
            ],
          }],
        }),
      })),
    })
    render(createElement(CopyProvider, { value: enTranslate, children: createElement(SearchView, { deps }) }))
    const summaryText = (await screen.findByText(/This round searched/)).textContent
    expect(summaryText).toContain('1 book (from 1 source')
    expect(summaryText).toContain(', 1 relevant hit, the rest folded but expandable')
  })

  it('英文：收口汇总的相关数按命中条数报（复数）', async () => {
    const deps = coreDeps({
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({
          keyword: '斗罗', phase: 'done', next: 2, total: 2, done: 2,
          added: [
            {
              sourceId: 's1', sourceName: 'S', status: 'verified',
              hits: [
                hit({ title: '斗罗', author: '唐家', url: 'https://s.com/a' }),
                hit({ title: '完全无关的书', url: 'https://s.com/b' }),
              ],
            },
            {
              sourceId: 's2', sourceName: 'T', status: 'verified',
              hits: [
                hit({ title: '斗罗外传', url: 'https://t.com/a' }),
              ],
            },
          ],
        }),
      })),
    })
    render(createElement(CopyProvider, { value: enTranslate, children: createElement(SearchView, { deps }) }))
    expect((await screen.findByText(/This round searched/)).textContent)
      .toContain(', 2 relevant hits, the rest folded but expandable')
  })
})

/**
 * 卸载只意味着「没人看了」：轮询停掉，服务端那轮继续跑完并持有结果（批循环住 Node 半）。
 * 回归：卸载后不得再发请求，重挂载不得重打一整轮。
 */
describe('SearchView 离开界面：停看不停工（结果由服务端持有）', () => {
  it('卸载后不发任何请求；重挂载从 since=0 重读即恢复，且不重新提交一轮', async () => {
    const reads: string[] = []
    const deps = coreDeps({
      apiSend: vi.fn(async () => ({ jobId: 'j1' })),
      apiGet: vi.fn(async (path: string) => {
        if (path === ROUTES.shelf.path) return []        // 落架基线那一问不归本用例
        reads.push(path)
        return { job: snap({ phase: 'running', done: 0, next: 0 }) }   // 一直「在跑」：轮询不会自己收
      }),
    })
    const view = mountSearch(deps)
    fireEvent.change(screen.getByPlaceholderText('书名 / 作者'), { target: { value: '斗罗' } })
    fireEvent.submit(screen.getByRole('form'))
    await waitFor(() => expect(reads.length).toBeGreaterThan(0))
    const atUnmount = reads.length
    view.unmount()
    await new Promise((r) => setTimeout(r, 900))               // 越过 JOB_POLL_MS 节拍
    expect(reads).toHaveLength(atUnmount)                      // 卸载即停表：之后一条都不发

    reads.length = 0
    deps.apiGet.mockImplementation(async (path: string) => {
      if (path === ROUTES.shelf.path) return []          // 同上：基线那一问不进这条账
      reads.push(path)
      return { job: snap({ phase: 'done', done: 1, next: 1, added: [hitGroup('斗罗切走期间搜完的书')] }) }
    })
    mountSearch(deps)
    await waitFor(() => expect(bookRow('斗罗切走期间搜完的书')).toBeTruthy())
    expect(reads[0]).toBe(queries.searchJobStatus(0))          // 重挂载 = 从游标零点重读
    expect(deps.apiSend).toHaveBeenCalledTimes(1)              // 恢复不重打：第二轮都没提交
  })

  it('退出小说界面再进：route 仍带关键词的重挂载也只恢复，不重新提交（否则整轮从头重搜）', async () => {
    // 入口路径：书架搜索框带 keyword 进搜索页；routeStore 跨卸载存活，退出再进 = route 还带关键词
    // 重新挂载。挂载 effect 不得据此无条件 submit——那会 POST 替换单槽里在跑的同一轮，整轮从头重搜。
    navigate({ name: 'search', keyword: '斗罗' })
    const deps = coreDeps({
      apiSend: vi.fn(async () => ({ jobId: 'j1' })),
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({
        job: snap({ phase: 'running', done: 3, total: 10, next: 3, added: [hitGroup('斗罗切走前已搜到的书')] }),
      })),
    })
    const view = mountSearch(deps)
    await waitFor(() => expect(deps.apiSend).toHaveBeenCalledTimes(1))   // 从书架新鲜跳入：提交一轮
    view.unmount()                                                       // 退出小说界面（服务端那轮照跑）

    mountSearch(deps)                          // 再进小说界面
    await waitFor(() => expect(bookRow('斗罗切走前已搜到的书')).toBeTruthy())
    // 进度从服务端快照恢复不从零开始（已搜 3/10 被 <b> 拆元素，按 textContent 断言）
    expect(document.querySelector('.novel-prog-text')?.textContent ?? '').toMatch(/已搜 3\/10/)
    expect(deps.apiSend).toHaveBeenCalledTimes(1)                        // 恢复不重打：重挂载零提交
    navigate({ name: 'shelf' })
  })

  it('StrictMode 双挂载：两次恢复读只许落地一次（分组不重复累加）', async () => {
    let reads = 0
    const deps = coreDeps({
      apiGet: vi.fn(async (path: string) => {
        if (path === ROUTES.shelf.path) return []        // 落架基线那一问不归本用例
        reads++
        return { job: snap({ phase: 'done', done: 1, next: 1, added: [hitGroup('斗罗只该出现一次的书')] }) }
      }),
    })
    render(createElement(StrictMode, null, createElement(SearchView, { deps })))
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2))   // 同实例二次 effect：确实读了两次
    // 两轴各摆一份是形状本身；累加两遍就会在任一轴里多出第二行／第二条
    expect(booksAxis().querySelectorAll('[data-novel-book]')).toHaveLength(1)
    expect(within(openPerSourceAxis()).getAllByText('斗罗只该出现一次的书')).toHaveLength(1)
    expect(screen.getByText(/1 家源/)).toBeTruthy()                // 一本一行：没有第二行
  })

  it('服务端宣布任务已不可读（重启 / 过保留期）→ 如实说明，不伪装成「搜了没命中」', async () => {
    let reads = 0
    const deps = coreDeps({
      apiSend: vi.fn(async () => ({ jobId: 'j1' })),
      apiGet: vi.fn(async (path: string) => path === ROUTES.shelf.path
        ? []
        : ({ job: (++reads === 1 ? snap({ phase: 'running', done: 0, next: 0 }) : null) })),
    })
    mountSearch(deps)
    fireEvent.change(screen.getByPlaceholderText('书名 / 作者'), { target: { value: '斗罗' } })
    fireEvent.submit(screen.getByRole('form'))
    await waitFor(() => expect(screen.getByText(/后台搜索任务已不可读/)).toBeTruthy())
    expect(screen.queryByText('没有结果')).toBeNull()
  })
})
