// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ApiClientError } from '../../src/client/api.js'
import { CityView } from '../../src/client/views/CityView.js'
import { cityStore, routeStore, useStore } from '../../src/client/store.js'
import { paramRoutes } from '../../src/shared/wire.js'
import { makeCoreDeps } from './fake-deps.js'
import type { CoreDepsOverrides } from './fake-deps.js'

/** 当前路由渲成一段可断言文本（走公开 API，不引入 testid 这套仓里没有的约定） */
function RouteProbe(): ReactNode {
  const { route } = useStore(routeStore)
  return <span>{route.name === 'reader' ? `reader|${route.sourceId}|${route.bookKey}` : route.name}</span>
}

/**
 * 书城分类页的接线钉子：进入即加载（**仅在该分类没有轮次时**）、记住上次、空词表不提交、
 * 失败条如实点名、换类、左栏本地筛选、点卡开选源抽屉（源名只在这里出现、可读入口跳阅读器、
 * 无地址不给钮）、在途骨架卡，以及几条「分不清就会说谎」的判据——被停止的轮次、
 * 「还没有一轮」与「零源的一轮」、恢复读与提交的先后。
 *
 * 假依赖束走仓内唯一桩工厂 `tests/client/fake-deps.ts`（键面绑 `ClientCoreDeps`，主干加成员时
 * 这里跟着红）。只喂三条口：词表 / 服务端此刻持有的那一轮 / 提交一轮；SSE 缺省推一帧**当前
 * 快照**（与生产同路：首帧就是 baseline）。
 *
 * 「服务端此刻持有的那一轮」是本文件的模块级单点（`current`）：**缺省 null**——服务端手里没有
 * 轮次，视图因此要走提交那条路；已经持有同类的轮次时不提交（那是「离开再回来不重打」）。
 */
const kinds = { kinds: [{ title: '玄幻', sources: 2 }, { title: '都市', sources: 1 }] }

/** 一轮已跑完的分类快照：一本书（一个 origin，源名只该在抽屉/失败条里出现）+ 一个坏源。
 *  `page`/`hasMore` 取「跑完、且没有更多」——续页那组用例各自覆写。 */
const snap = {
  id: 'j1', kind: '玄幻', phase: 'done', cancelled: false, total: 2, done: 2, page: 1, hasMore: false,
  books: [{
    name: '剑起长安', author: '青衫客', kind: '玄幻', lastChapter: '第 412 章', sourceCount: 2,
    origins: [{ sourceId: 's1', sourceName: '笔趣阁', bookUrl: 'https://a/1', lastChapter: '第 412 章' }],
  }],
  failures: [{ sourceId: 's2', sourceName: '顶点', code: 'FetchError', message: '超时' }],
  startedAt: 1,
}

const submitted: string[] = []
/** 服务端此刻持有的一轮（用例可换；SSE 与 status 读的都是它；`null` = 服务端说没有这一轮） */
let current: unknown = null

/** 服务端为一个分类起的一轮（缺省立刻答完：多数用例只关心「词表 → 提交 → 出书」这条线） */
const serve = (kind: string): unknown => ({ ...snap, id: 'j1', kind })

beforeEach(() => { submitted.length = 0; current = null })
afterEach(() => { cleanup(); cityStore.set({ kind: null }); routeStore.set({ route: { name: 'shelf' } }) })

const depsOf = (over: CoreDepsOverrides = {}) => makeCoreDeps({
  apiGet: vi.fn(async (p: string) => (p.includes('kinds') ? kinds : { job: current })),
  apiSend: vi.fn(async (m: string, p: string, body: { kind: string }) => {
    if (p === 'explore/list/more') return { jobId: 'j1' }   // 续页：不是提交，也不动 current
    if (m === 'PUT') return {}                              // 入架：写的是书架，与这一轮的读面无关
    submitted.push(body.kind)                               // 提交落地即起一轮，之后各帧推的就是它
    current = serve(body.kind)
    return { jobId: 'j1' }
  }),
  apiEventStream: vi.fn(async (_p: string, onFrame: (data: string) => void) => {
    onFrame(JSON.stringify({ job: current }))
  }),
  ...over,
})

/** 可手动喂帧的 SSE：帧由用例决定（在途骨架那一组要看「同一轮跑完」的下一帧） */
const pushable = (): { over: CoreDepsOverrides; frame: (job: unknown) => void } => {
  const box: { push: (job: unknown) => void } = { push: () => {} }
  return {
    over: {
      apiEventStream: vi.fn(async (_p: string, onFrame: (data: string) => void, signal: AbortSignal) => {
        box.push = (job) => onFrame(JSON.stringify({ job }))
        await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }))
      }),
    },
    frame: (job) => box.push(job),
  }
}

describe('CityView', () => {
  it('进入即加载词表第一项（服务端顺序即源数降序），且书单来自服务端', async () => {
    const { container } = render(<CityView deps={depsOf()} />)
    await waitFor(() => { expect(screen.getByText('剑起长安')).toBeTruthy() })
    expect(submitted).toEqual(['玄幻'])
    expect(screen.getByText('青衫客 · 玄幻')).toBeTruthy()          // 元信息（缺字段不显示）
    // 来源角标只说数量（按类名点住卡片那一枚：左栏每项也带「N 源」）
    expect(screen.getByText('2 源', { selector: '.novel-city-src' })).toBeTruthy()
    expect(container.querySelectorAll('.novel-city-src')).toHaveLength(1)
    expect(screen.queryByText('笔趣阁')).toBeNull()                // 逛时源不可见
  })

  it('记住的上次分类还在词表里 → 加载它，而不是榜首', async () => {
    cityStore.set({ kind: '都市' })
    render(<CityView deps={depsOf()} />)
    await waitFor(() => { expect(submitted).toEqual(['都市']) })
    expect(screen.getByRole('button', { name: /都市/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('库里没有源提供分类 → 空态（且不提交任何一轮，也不留轮次读数）', async () => {
    // 两条读面要分开喂：kinds 空、status 明说「还没有一轮」（否则读面会多报一条无关错误）
    const d = depsOf({ apiGet: vi.fn(async (p: string) => (p.includes('kinds') ? { kinds: [] } : { job: null })) })
    const { container } = render(<CityView deps={d} />)
    await waitFor(() => { expect(screen.getByText(/还没有书源提供分类浏览/)).toBeTruthy() })
    expect(submitted).toEqual([])
    // 「还没有一轮」不该有轮次读数（判据是有没有轮次，不是文案空不空）
    expect(container.querySelector('.novel-city-foot')).toBeNull()
  })

  it('恢复回来的是同一类 → 一个提交都不发（服务端那一轮就是它的家，回来看它跑完）', async () => {
    // 恢复读故意后到（词表先到、分类已选中而 round 还是 null）——这一段正是最容易白提交的窗口：
    // 没有 restored 那道闸，视图会在这里把服务端正持有的那一轮杀掉，书单白闪一帧再从头抓
    const gate = { open: (): void => {} }
    current = snap                                      // 服务端已持有「玄幻」这一轮
    const d = depsOf({
      apiGet: vi.fn(async (p: string) => {
        if (p.includes('kinds')) return kinds
        await new Promise<void>((res) => { gate.open = res })
        return { job: current }
      }),
    })
    render(<CityView deps={d} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: /玄幻/ }).getAttribute('aria-pressed')).toBe('true') })
    await new Promise((r) => setTimeout(r, 20))
    expect(submitted).toEqual([])                       // 恢复读还在飞：此刻提交就是把那一轮杀掉
    gate.open()
    await waitFor(() => { expect(screen.getByText('剑起长安')).toBeTruthy() })   // 恢复读落地，看的就是它
    expect(submitted).toEqual([])
  })

  it('恢复回来的是另一类 → 提交想要的那一类（有轮次但不是这一类的，等于没有）', async () => {
    current = { ...snap, id: 'j9', kind: '都市', books: [] }
    render(<CityView deps={depsOf()} />)
    await waitFor(() => { expect(submitted).toEqual(['玄幻']) })
  })

  it('失败条如实说数量，坏源在摘要行里就点名（不藏在展开里）', async () => {
    current = snap
    render(<CityView deps={depsOf()} />)
    // 措辞只说「这一页没回来」：同样的字段也承载「已累积、只是这一页失败」的源（见 ExploreFailure）
    await waitFor(() => { expect(screen.getByText('1 个源这一页没回来')).toBeTruthy() })
    const who = screen.getByText(/顶点/)
    expect(who.className).toBe('novel-city-fail-who')              // 摘要行，不是展开区
    expect(screen.getByText(/超时/)).toBeTruthy()                  // 展开区给完整 message
  })

  it('换类：点左栏另一项即提交它并记住（切类零跳转）', async () => {
    render(<CityView deps={depsOf()} />)
    await waitFor(() => { expect(submitted).toEqual(['玄幻']) })
    fireEvent.click(screen.getByRole('button', { name: /都市/ }))
    await waitFor(() => { expect(submitted).toEqual(['玄幻', '都市']) })
    expect(cityStore.get().kind).toBe('都市')
  })

  it('左栏筛选是本地的：不触网、不提交，也不改当前类', async () => {
    render(<CityView deps={depsOf()} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: /玄幻/ })).toBeTruthy() })
    fireEvent.change(screen.getByLabelText('筛选分类'), { target: { value: '都' } })
    expect(screen.queryByRole('button', { name: /玄幻/ })).toBeNull()
    expect(screen.getByRole('button', { name: /都市/ })).toBeTruthy()
    expect(submitted).toEqual(['玄幻'])
    expect(cityStore.get().kind).toBe('玄幻')
  })

  it('在途骨架卡：本轮还在跑时铺到网格的形状，轮次一终态就撤（活过轮次的骨架是谎）', async () => {
    const { over, frame } = pushable()
    current = { ...snap, phase: 'running', done: 1, total: 4 }     // 只回了 1 本，源还在往回送
    const { container } = render(<CityView deps={depsOf(over)} />)
    // 4 列网格、两行上限：1 本书 + 7 张骨架卡（无界的骨架铺法会把「还在等」画成「有这么多」）
    await waitFor(() => { expect(container.querySelectorAll('.novel-city-sk')).toHaveLength(7) })
    expect(container.querySelectorAll('button.novel-city-card')).toHaveLength(1)   // 骨架不是钮
    act(() => { frame({ ...snap, phase: 'done' }) })
    await waitFor(() => { expect(container.querySelectorAll('.novel-city-sk')).toHaveLength(0) })
    expect(screen.getByText('剑起长安')).toBeTruthy()              // 撤的是骨架，不是内容
  })

  it('封面失败的键按行身份（书名 + 作者）：同名不同作者的两条不互相拖累', async () => {
    current = {
      ...snap,
      books: [
        { name: '剑起长安', author: '甲', sourceCount: 1, origins: [], coverUrl: 'https://a/broken' },
        { name: '剑起长安', author: '乙', sourceCount: 1, origins: [], coverUrl: 'https://a/ok' },
      ],
    }
    const { container } = render(<CityView deps={depsOf()} />)
    await waitFor(() => { expect(container.querySelectorAll('img.novel-city-cover')).toHaveLength(2) })
    fireEvent.error(container.querySelectorAll('img.novel-city-cover')[0])
    await waitFor(() => { expect(container.querySelectorAll('img.novel-city-cover')).toHaveLength(1) })
  })

  it('换轮即清空封面失败表：新一轮里那张图要重来（不该一次坏封面永久降级）', async () => {
    const book = { name: '剑起长安', author: '青衫客', sourceCount: 1, origins: [], coverUrl: 'https://a/1' }
    const { over, frame } = pushable()
    current = { ...snap, phase: 'running', books: [book] }
    const { container } = render(<CityView deps={depsOf(over)} />)
    await waitFor(() => { expect(container.querySelectorAll('img.novel-city-cover')).toHaveLength(1) })
    fireEvent.error(container.querySelector('img.novel-city-cover')!)
    await waitFor(() => { expect(container.querySelectorAll('img.novel-city-cover')).toHaveLength(0) })
    act(() => { frame({ ...snap, id: 'j2', phase: 'running', books: [book] }) })
    await waitFor(() => { expect(container.querySelectorAll('img.novel-city-cover')).toHaveLength(1) })
  })

  it('点卡开选源抽屉（本任务只到打开态），关掉回到书单', async () => {
    current = snap
    render(<CityView deps={depsOf()} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: /剑起长安/ })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: /剑起长安/ }))
    const drawer = screen.getByRole('dialog')
    expect(drawer.textContent).toContain('笔趣阁')                  // 到了「看到书」的阶段才点名
    expect(drawer.textContent).toContain('第 412 章')
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('剑起长安')).toBeTruthy()               // 书单留在原位
  })

  it('被停止的轮次说「已停止」——不许长得像跑完的一轮', async () => {
    current = { ...snap, phase: 'failed', cancelled: true, done: 1 }
    render(<CityView deps={depsOf()} />)
    await waitFor(() => { expect(screen.getByText('已停止')).toBeTruthy() })
    expect(screen.queryByText(/已 1 \/ 2 源/)).toBeNull()           // 停止不是「跑到了 1/2」
  })

  it('零源的一轮仍是一轮：尾行读数在场（与「还没有一轮」不是同一种空）', async () => {
    current = { ...snap, phase: 'done', total: 0, done: 0, books: [], failures: [] }
    const { container } = render(<CityView deps={depsOf()} />)
    await waitFor(() => { expect(container.querySelector('.novel-city-foot')).not.toBeNull() })
  })

  it('挂载恢复不得盖掉刚落地的提交（旧的恢复读后到，新轮的空帧说了算）', async () => {
    // 闸门卡住「上一轮」的那次恢复读。抢在恢复读之前提交的通道是**用户手点**（自动那条要等
    // 恢复读落地才决定），没有 submitted 闸，后到的旧帧就会拿上一轮的书单盖掉刚落下的新轮
    const gate = { open: (): void => {} }
    const stale = { ...snap, id: 'old', books: [{ name: '上一轮的书', author: '甲', kind: '玄幻', sourceCount: 1, origins: [] }] }
    const d = depsOf({
      apiGet: vi.fn(async (p: string) => {
        if (p.includes('kinds')) return kinds
        await new Promise<void>((res) => { gate.open = res })
        return { job: stale }
      }),
      apiEventStream: vi.fn(async () => { throw new Error('无 SSE') }),   // 那一帧空态只能被恢复读改写
    })
    render(<CityView deps={d} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: /都市/ })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: /都市/ }))
    await waitFor(() => { expect(screen.getByText('正在启动分类抓取…')).toBeTruthy() })   // 新轮的空帧已落地
    gate.open()
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText('上一轮的书')).toBeNull()
    expect(screen.getByText('正在启动分类抓取…')).toBeTruthy()
  })

  it('点卡开抽屉：列各源可读入口，且只有这里点名源；Esc 关闭', async () => {
    current = snap
    render(<CityView deps={depsOf()} />)
    await waitFor(() => { expect(screen.getByText('剑起长安')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: /剑起长安/ }))
    const drawer = await screen.findByRole('dialog')
    expect(drawer.getAttribute('aria-modal')).toBe('true')
    expect(drawer.textContent).toContain('笔趣阁')          // 到了「看到书」的阶段才点名
    expect(drawer.textContent).toContain('第 412 章')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('「读这本」跳到阅读器路由（bookKey 用该源的书地址）', async () => {
    current = snap
    render(<><CityView deps={depsOf()} /><RouteProbe /></>)
    await waitFor(() => { expect(screen.getByText('剑起长安')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: /剑起长安/ }))
    fireEvent.click(await screen.findByRole('button', { name: '读这本' }))
    await waitFor(() => { expect(screen.getByText('reader|s1|https://a/1')).toBeTruthy() })
  })

  it('没有可读地址的源照样列出来，但不给一个点了没反应的钮', async () => {
    current = {
      ...snap,
      books: [{
        name: '剑起长安', author: '青衫客', kind: '玄幻', sourceCount: 2,
        origins: [
          { sourceId: 's1', sourceName: '笔趣阁', bookUrl: 'https://a/1' },
          { sourceId: 's3', sourceName: '无址阁', bookUrl: null },
        ],
      }],
    }
    render(<CityView deps={depsOf()} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: /剑起长安/ })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: /剑起长安/ }))
    const drawer = await screen.findByRole('dialog')
    expect(drawer.textContent).toContain('无址阁')                        // 行还在：它是「这个源收录了它」的交代
    expect(screen.getAllByRole('button', { name: '读这本' })).toHaveLength(1)
  })

  it('有分类但这一类零结果 → 诚实的空结果，不冒充失败（也不进失败条）', async () => {
    current = { ...snap, books: [], failures: [] }
    render(<CityView deps={depsOf()} />)
    await waitFor(() => { expect(screen.getByText(/这一类还没有书/)).toBeTruthy() })
    expect(screen.queryByText(/个源这一页没回来/)).toBeNull()      // 零命中不是失败（服务端口径）
  })

  it('零源且已完成的一轮：尾行说「这一轮没有源参与」，且不对归类内容下结论', async () => {
    current = { ...snap, phase: 'done', total: 0, done: 0, books: [], failures: [] }
    render(<CityView deps={depsOf()} />)
    await waitFor(() => { expect(screen.getByText('这一轮没有源参与')).toBeTruthy() })
    // 没有任何源被问过 ⇒ 「这一类还没有书」是编的结论，这一态只许说轮次自己的形状
    expect(screen.queryByText(/这一类还没有书/)).toBeNull()
  })

  it('还在跑的一轮里零本 = 源还在往回送，不许先说成这一类的空结果', async () => {
    current = { ...snap, phase: 'running', done: 1, total: 4, books: [], failures: [] }
    render(<CityView deps={depsOf()} />)
    await waitFor(() => { expect(screen.getByText('已 1 / 4 源')).toBeTruthy() })
    expect(screen.queryByText(/这一类还没有书/)).toBeNull()
  })

  it('hasMore 为真：尾行给「加载更多（已 N 页）」，点一次发一次续页 POST（在途时钮禁用）', async () => {
    current = { ...snap, hasMore: true }
    const { over, frame } = pushable()
    const more: string[] = []
    let release: () => void = () => {}
    const deps = depsOf({
      apiSend: vi.fn(async (_m: string, p: string) => {
        if (p === 'explore/list/more') { more.push(p); await new Promise<void>((r) => { release = r }) }   // 卡住这一页，看「在途」那一小段
        return { jobId: 'j1' }
      }),
      ...over,
    })
    render(<CityView deps={deps} />)
    fireEvent.click(await screen.findByRole('button', { name: '加载更多（已 1 页）' }))
    await waitFor(() => { expect(more).toHaveLength(1) })
    // 本页已回到 running（服务端那轮如此），钮据此禁用：这一小段窗口不许再发一次
    expect(screen.getByRole('button', { name: '加载更多（已 1 页）' }).hasAttribute('disabled')).toBe(true)
    act(() => { release() })
    await waitFor(() => { expect(deps.apiEventStream).toHaveBeenCalled() })                    // 续页后重新盯住这一轮
    act(() => { frame({ ...snap, page: 2, hasMore: true }) })                                 // 新一页回来：页码与钮都跟上服务端
    await waitFor(() => { expect(screen.getByRole('button', { name: '加载更多（已 2 页）' })).toBeTruthy() })
    expect(more).toHaveLength(1)
  })

  it('在途（running）：钮仍在场但禁用——显隐只认 hasMore，禁用才认 running，不从 running 反推有没有更多', async () => {
    current = { ...snap, phase: 'running', done: 1, page: 2, hasMore: true }
    render(<CityView deps={depsOf()} />)
    const btn = await screen.findByRole('button', { name: '加载更多（已 2 页）' })
    expect(btn.hasAttribute('disabled')).toBe(true)
  })

  it('hasMore 为假：钮收掉、读数照旧（服务端说没了就真没了，不留一个点了没反应的饼）', async () => {
    current = snap                                        // 跑完且没有更多
    const { container } = render(<CityView deps={depsOf()} />)
    await waitFor(() => { expect(screen.getByText('已 2 / 2 源')).toBeTruthy() })
    expect(container.querySelector('.novel-city-foot')).not.toBeNull()
    expect(screen.queryByText(/加载更多/)).toBeNull()
  })

  it('续页撞 409（此刻没得可加载）：钮收掉、不报红条——没得加载不是故障', async () => {
    current = { ...snap, hasMore: true }
    const deps = depsOf({
      apiSend: vi.fn(async (_m: string, p: string) => {
        if (p === 'explore/list/more') throw new ApiClientError('Conflict', 409, '没有更多了')
        return { jobId: 'j1' }
      }),
    })
    const { container } = render(<CityView deps={deps} />)
    fireEvent.click(await screen.findByRole('button', { name: '加载更多（已 1 页）' }))
    await waitFor(() => { expect(screen.queryByRole('button', { name: /加载更多/ })).toBeNull() })
    expect(container.querySelector('.novel-err')).toBeNull()
  })

  it('抽屉每行可加入书架：一次 PUT 打到该行 bookKey，字段取该行与书、缺的一律缺席', async () => {
    current = snap
    const pushOk = vi.fn()
    const deps = depsOf({ pushOk })
    render(<CityView deps={deps} />)
    fireEvent.click(await screen.findByRole('button', { name: /剑起长安/ }))
    fireEvent.click(await screen.findByRole('button', { name: '加入书架' }))
    await waitFor(() => { expect(pushOk).toHaveBeenCalledWith('已加入书架') })
    const puts = deps.apiSend.mock.calls.filter((c) => c[0] === 'PUT')
    expect(puts).toHaveLength(1)                                    // 不多发一次「读一次书架」之类的
    expect(puts[0][1]).toBe(paramRoutes.shelfKey('https://a/1'))    // 书架身份 = 该源的书地址
    // 缺席即不由客户端补：coverUrl/intro/wordCount 这本书没有，body 里就不该有它们的空壳
    expect(puts[0][2]).toStrictEqual({
      sourceId: 's1', title: '剑起长安', author: '青衫客', kind: '玄幻', lastChapterName: '第 412 章',
    })
  })

  it('无地址的行两个钮都没有（与「读这本」同一条守卫）；有地址的行两个都在', async () => {
    current = {
      ...snap,
      books: [{
        name: '剑起长安', author: '青衫客', kind: '玄幻', sourceCount: 2,
        origins: [
          { sourceId: 's1', sourceName: '笔趣阁', bookUrl: 'https://a/1' },
          { sourceId: 's3', sourceName: '无址阁', bookUrl: null },
        ],
      }],
    }
    const { container } = render(<CityView deps={depsOf()} />)
    fireEvent.click(await screen.findByRole('button', { name: /剑起长安/ }))
    const rows = container.querySelectorAll('.novel-city-srcrow')
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelectorAll('button')).toHaveLength(2)      // 读这本 + 加入书架
    expect(rows[1].querySelectorAll('button')).toHaveLength(0)      // 没地址就没有入口，也没有入架口
  })

  it('入架字段取**这一行**的 origin：lastChapter 各行不同，缺失才回退书的', async () => {
    current = {
      ...snap,
      books: [{
        name: '剑起长安', author: '青衫客', kind: '玄幻', lastChapter: '第 412 章', sourceCount: 2,
        origins: [
          { sourceId: 's1', sourceName: '笔趣阁', bookUrl: 'https://a/1', lastChapter: '第 500 章' },
          { sourceId: 's3', sourceName: '顶点', bookUrl: 'https://a/2' },
        ],
      }],
    }
    const deps = depsOf()
    render(<CityView deps={deps} />)
    fireEvent.click(await screen.findByRole('button', { name: /剑起长安/ }))
    fireEvent.click((await screen.findAllByRole('button', { name: '加入书架' }))[1])
    await waitFor(() => { expect(deps.apiSend).toHaveBeenCalledTimes(1) })
    expect(deps.apiSend).toHaveBeenCalledWith('PUT', paramRoutes.shelfKey('https://a/2'), {
      sourceId: 's3', title: '剑起长安', author: '青衫客', kind: '玄幻',
      lastChapterName: '第 412 章',                                 // 这一行没写最新章 → 回退书的那条
    })
  })

  it('入架失败：进错误泳道，不许报喜（点了没反应比失败更糟）', async () => {
    current = snap
    const pushOk = vi.fn()
    const pushError = vi.fn()
    const deps = depsOf({ apiSend: vi.fn(async () => { throw new Error('书架写不动') }), pushOk, pushError })
    render(<CityView deps={deps} />)
    fireEvent.click(await screen.findByRole('button', { name: /剑起长安/ }))
    fireEvent.click(await screen.findByRole('button', { name: '加入书架' }))
    await waitFor(() => { expect(pushError).toHaveBeenCalledWith(expect.stringContaining('书架写不动')) })
    expect(pushOk).not.toHaveBeenCalled()
  })
})
