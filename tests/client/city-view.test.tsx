// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import type { ReactNode } from 'react'
import { ApiClientError } from '../../src/client/api.js'
import { CopyProvider, enTranslate } from '../../src/client/copy/index.js'
import { CityBookSheet } from '../../src/client/views/CityBookSheet.js'
import { CityView } from '../../src/client/views/CityView.js'
import { panelShelf, resetPanelShelf } from '../../src/client/panel-shelf.js'
import { cityStore } from '../../src/client/store.js'
import { ROUTES, paramOps } from '../../src/shared/wire.js'
import type { ExploreBook, SearchGroup, SearchJobSnapshot } from '../../src/shared/wire.js'
import { makeCoreDeps } from './fake-deps.js'
import type { DepsOverrides, FakeViewDeps } from './fake-deps.js'
import { rect, stubLayout } from './scroll-stub.js'

/**
 * 书城按源浏览（左栏一条源列表，选中的源就地展开自己的分类）的接线钉子：进入即默认第一源第一类、
 * 换源即换分类栏、展开节点唯一、换源的落位只滚左栏自己（装不下才动）、记住的源失效即回落、
 * 空源清单不提交、进入即加载（**仅在该源+该分类没有轮次时**）、换类、两栏本地筛选、在途骨架卡、
 * 封面失败键按行身份，以及几条「分不清就会说谎」的判据——被停止的轮次、这一页没回来、恢复读与提交
 * 的先后。文件后半是书籍详情浮层那一族：本源的两个动作、书地址缺席时零入口，以及跨源那一次各说各的
 * 那些形状（进行中 / 零命中 / 有源没响应 / 某一家答了而零条 / 一家都没被问到 / 被停止）。零命中
 * 只由**答复**作证——整列未响应时那句不许出现；那一列也只认**本层 POST 回来的 jobId**，挂载恢复带来的
 * 上一本书那一轮（哪怕关键词相同）不会被当成本书的结果。跨源那一列还吃相关性判据：无关条目不占该源唯一的代表行、只回无关条目的
 * 一家不许折成「这一家没有按这个书名搜到」，被折起来的那些展开后照旧可点。而这一列**不折叠成一本**：
 * 按书归并只进搜索面（结果页与工具面），浮层维持逐源轴——钉这条是为了挡将来的「顺手统一」。
 *
 * 假依赖束走仓内唯一桩工厂 `tests/client/fake-deps.ts`。只喂三条口：可选源清单 / 服务端此刻持有的
 * 那一轮 / 提交一轮；SSE 缺省推一帧当前快照（与生产同路：首帧就是 baseline）。
 *
 * 「服务端此刻持有的那一轮」是本文件的模块级单点（`current`）：**缺省 null**——服务端手里没有轮次，
 * 视图因此要走提交那条路；已持有同源同类的轮次时不提交（那是「离开再回来不重打」）。
 */

/** 可选源清单（`GET explore/kinds` 的现物形状）：s1 声明两类、s2 只声明一类 */
const sources = { sources: [
  { id: 's1', name: '半夏小说', groups: ['通常书源'], status: 'unverified', kinds: ['现代情感', '穿越重生'] },
  { id: 's2', name: '多看阅读', groups: ['快速书源'], status: 'verified', kinds: ['玄幻'] },
] }

/** 一轮已跑完的单源快照：一本书（`bookUrl` 就是这本在该源上的地址）+ 该源身份。
 *  `page`/`hasMore` 取「跑完、且没有更多」——续页那组用例各自覆写。 */
const snap = {
  id: 'j1', sourceId: 's1', sourceName: '半夏小说', kind: '现代情感', phase: 'done', cancelled: false,
  page: 1, hasMore: false,
  books: [{ name: '剑起长安', author: '青衫客', kind: '现代情感', bookUrl: 'https://a/1', lastChapter: '第 412 章' }],
  startedAt: 1,
}

const submitted: Array<[string, string]> = []
/** 服务端此刻持有的一轮（用例可换；SSE 与 status 读的都是它；`null` = 服务端说没有这一轮） */
let current: unknown = null

/** 服务端为一个源+分类起的一轮（缺省立刻答完：多数用例只关心「源清单 → 提交 → 出书」这条线） */
const serve = (sourceId: string, kind: string): unknown => ({
  ...snap, sourceId, sourceName: sources.sources.find((s) => s.id === sourceId)?.name ?? '', kind,
})

beforeEach(() => { submitted.length = 0; current = null; resetPanelShelf() })
afterEach(() => { cleanup(); cityStore.set({ sourceId: null, kind: null }) })

const depsOf = (over: DepsOverrides = {}) => makeCoreDeps({
  apiGet: vi.fn(async (p: string) => (p.includes('kinds') ? sources : { job: current })),
  apiSend: vi.fn(async (target: { method: string; path: string }, body: { sourceId: string; kind: string }) => {
    if (target.path === 'explore/list/more') return { jobId: 'j1' }   // 续页：不是提交，也不动 current
    if (target.method === 'PUT') return {}                              // 入架：写的是书架，与这一轮的读面无关
    submitted.push([body.sourceId, body.kind])              // 提交落地即起一轮，之后各帧推的就是它
    current = serve(body.sourceId, body.kind)
    return { jobId: 'j1' }
  }),
  apiEventStream: vi.fn(async (_p: string, onFrame: (data: string) => void) => {
    onFrame(JSON.stringify({ job: current }))
  }),
  ...over,
})

/** 可手动喂帧的 SSE：帧由用例决定（在途骨架那一组要看「同一轮跑完」的下一帧） */
const pushable = (): { over: DepsOverrides; frame: (job: unknown) => void } => {
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
  it('进入书城：默认选中第一个可选源与它的第一个分类，并提交这一轮', async () => {
    render(<CityView deps={depsOf()} />)
    await waitFor(() => expect(submitted).toEqual([['s1', '现代情感']]))
    expect(screen.getByRole('heading', { name: '现代情感' })).toBeTruthy()
    expect(screen.getByText('半夏小说 · 通常书源')).toBeTruthy()   // 头行副标题报的是源，不再是「N 个源收录」
  })

  it('StrictMode 双 effect：自动进入的提交只发一次（one-shot 必须同步可见）', async () => {
    render(<StrictMode><CityView deps={depsOf()} /></StrictMode>)
    await waitFor(() => expect(submitted).toEqual([['s1', '现代情感']]))
  })

  it('换源：分类栏跟着换成新源声明的那几条，并提交新源的第一个分类', async () => {
    render(<CityView deps={depsOf()} />)
    await waitFor(() => expect(submitted).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: /^多看阅读/ }))
    await waitFor(() => expect(submitted).toEqual([['s1', '现代情感'], ['s2', '玄幻']]))
    expect(screen.getByRole('button', { name: '玄幻' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '现代情感' })).toBeNull()
  })

  it('记住的源失效（被禁用/删掉）时回落第一项，不留指向不存在源的选中态', async () => {
    cityStore.set({ sourceId: 'gone', kind: '玄幻' })
    render(<CityView deps={depsOf()} />)
    await waitFor(() => expect(submitted).toEqual([['s1', '现代情感']]))
    expect(cityStore.get().sourceId).toBe('s1')
  })

  it('没有任何源带分类入口：说清依赖的是书源声明的分类入口，且不提交任何一轮（也不留轮次读数）', async () => {
    const d = depsOf({ apiGet: vi.fn(async (p: string) => (p.includes('kinds') ? { sources: [] } : { job: null })) })
    const { container } = render(<CityView deps={d} />)
    await waitFor(() => expect(screen.getByText(/还没有书源提供分类浏览/)).toBeTruthy())
    expect(submitted).toEqual([])
    expect(container.querySelector('.novel-city-foot')).toBeNull()
  })

  it('记住的上次源与分类仍在场 → 加载它，而不是榜首', async () => {
    cityStore.set({ sourceId: 's1', kind: '穿越重生' })
    render(<CityView deps={depsOf()} />)
    await waitFor(() => expect(submitted).toEqual([['s1', '穿越重生']]))
    expect(screen.getByRole('button', { name: '穿越重生' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('恢复回来的是同一源同类 → 一个提交都不发（服务端那一轮就是它的家，回来看它跑完）', async () => {
    // 恢复读故意后到（源清单先到、选中已定而 round 还是 null）——这一段正是最容易白提交的窗口：
    // 没有 restored 那道闸，视图会在这里把服务端正持有的那一轮杀掉，书单白闪一帧再从头抓
    const gate = { open: (): void => {} }
    current = snap                                      // 服务端已持有 s1/现代情感 这一轮
    const d = depsOf({
      apiGet: vi.fn(async (p: string) => {
        if (p.includes('kinds')) return sources
        await new Promise<void>((res) => { gate.open = res })
        return { job: current }
      }),
    })
    render(<CityView deps={d} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: '现代情感' }).getAttribute('aria-pressed')).toBe('true') })
    await new Promise((r) => setTimeout(r, 20))
    expect(submitted).toEqual([])                       // 恢复读还在飞：此刻提交就是把那一轮杀掉
    gate.open()
    await waitFor(() => { expect(screen.getByText('剑起长安')).toBeTruthy() })   // 恢复读落地，看的就是它
    expect(submitted).toEqual([])
  })

  it('恢复回来的是另一类 → 提交想要的那一类（有轮次但不是这一类的，等于没有）', async () => {
    current = { ...snap, id: 'j9', kind: '穿越重生', books: [] }
    render(<CityView deps={depsOf()} />)
    await waitFor(() => expect(submitted).toEqual([['s1', '现代情感']]))
  })

  it('换类：点左栏另一类即提交它并记住（切类零跳转）', async () => {
    render(<CityView deps={depsOf()} />)
    await waitFor(() => expect(submitted).toEqual([['s1', '现代情感']]))
    fireEvent.click(screen.getByRole('button', { name: '穿越重生' }))
    await waitFor(() => expect(submitted).toEqual([['s1', '现代情感'], ['s1', '穿越重生']]))
    expect(cityStore.get().kind).toBe('穿越重生')
  })

  // 手点不进 `city-entry.ts` 的判据：自动那条路遇到「当前轮正是这一对」会给 follow（不重提），
  // 而手点是「再点一次」的意思，恒走 submit——把这条折进判据就得给纯函数多一枚只有视图知道的入参。
  it('手点当前这一类也照旧提交：判据只管自动那条路，手点恒走 submit', async () => {
    render(<CityView deps={depsOf()} />)
    await waitFor(() => expect(submitted).toEqual([['s1', '现代情感']]))
    fireEvent.click(screen.getByRole('button', { name: '现代情感' }))
    await waitFor(() => expect(submitted).toEqual([['s1', '现代情感'], ['s1', '现代情感']]))
  })

  it('左栏分类筛选是本地的：不触网、不提交，也不改当前类', async () => {
    render(<CityView deps={depsOf()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: '现代情感' })).toBeTruthy())
    fireEvent.change(screen.getByLabelText('筛选分类'), { target: { value: '穿' } })
    expect(screen.queryByRole('button', { name: '现代情感' })).toBeNull()
    expect(screen.getByRole('button', { name: '穿越重生' })).toBeTruthy()
    expect(submitted).toEqual([['s1', '现代情感']])
    expect(cityStore.get().kind).toBe('现代情感')
  })

  it('左栏源筛选是本地的：不触网、不提交，也不改当前源', async () => {
    render(<CityView deps={depsOf()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /^半夏小说/ })).toBeTruthy())
    fireEvent.change(screen.getByLabelText('搜索书源'), { target: { value: '多看' } })
    expect(screen.queryByRole('button', { name: /^半夏小说/ })).toBeNull()
    expect(screen.getByRole('button', { name: /^多看阅读/ })).toBeTruthy()
    expect(submitted).toEqual([['s1', '现代情感']])
    expect(cityStore.get().sourceId).toBe('s1')
  })

  it('分类只长在选中的源下面：整栏一个展开节点，未选中的源是收着的', async () => {
    const { container } = render(<CityView deps={depsOf()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: '现代情感' })).toBeTruthy())
    expect(container.querySelectorAll('.novel-city-kids')).toHaveLength(1)
    expect(screen.getByRole('button', { name: /^半夏小说/ }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: /^多看阅读/ }).getAttribute('aria-expanded')).toBe('false')
    // s2 声明了「玄幻」，但它没收着就没人替它列出来——一栏两列分类是旧形状
    expect(screen.queryByRole('button', { name: '玄幻' })).toBeNull()
  })

  it('换源的落位只滚左栏自己：展开串装不下才把头行抬到框顶，装得下一动不动', async () => {
    // 几何由用例按元素给（jsdom 无排版引擎），钉的是**策略**：越界才写一次 scrollTop，且绝不借
    // scrollIntoView——那个 API 会连可滚祖先一起滚（本仓落位的统一口径，见 util.ts）
    const layout = stubLayout((el) => {
      const c = el.classList
      if (c?.contains('novel-city-rail')) return rect(0, 300)
      if (c?.contains('novel-city-source') && c.contains('on')) return rect(260, 28)
      if (c?.contains('novel-city-kids')) return rect(288, 200)      // 底边 488 > 框底 300：装不下
      return null
    })
    try {
      const { container } = render(<CityView deps={depsOf()} />)
      await waitFor(() => expect(submitted).toEqual([['s1', '现代情感']]))
      expect(layout.scrolls.map((s) => s.to)).toEqual([260])
      expect(layout.scrolls[0].el).toBe(container.querySelector('.novel-city-rail'))
      expect(layout.into, '落位不许碰 scrollIntoView').toEqual([])
    } finally { layout.restore() }
  })

  it('展开串本来就放得下：一次 scrollTop 都不写（点完看见整列跳一格就是这条）', async () => {
    const layout = stubLayout((el) => {
      const c = el.classList
      if (c?.contains('novel-city-rail')) return rect(0, 600)
      if (c?.contains('novel-city-source') && c.contains('on')) return rect(20, 28)
      if (c?.contains('novel-city-kids')) return rect(48, 200)       // 底边 248 < 框底 600：放得下
      return null
    })
    try {
      render(<CityView deps={depsOf()} />)
      await waitFor(() => expect(submitted).toEqual([['s1', '现代情感']]))
      expect(layout.scrolls).toEqual([])
    } finally { layout.restore() }
  })

  it('卡片上没有跨源角标：整屏不出现「N 源」字样', async () => {
    const { container } = render(<CityView deps={depsOf()} />)
    await waitFor(() => expect(screen.getByText('剑起长安')).toBeTruthy())
    // 反向断言防的是归并那层的残影：旧版卡片角标正是 `2 源`，改回跨源计数这条就红
    expect(container.textContent).not.toMatch(/\d+ 源/)
  })

  it('在途骨架卡：本轮还在跑时铺到网格的形状，轮次一终态就撤（活过轮次的骨架是谎）', async () => {
    const { over, frame } = pushable()
    // 只回了 1 本，源还在往回送。`hasMore` 显式写 false：服务端一批在途时它必为假
    // （公式里那一条 `phase !== 'running'`），**这就是真的在途帧**，钮该整颗不在场。
    current = { ...snap, phase: 'running', hasMore: false }
    const { container } = render(<CityView deps={depsOf(over)} />)
    // 上界 8 张：1 本书 + 7 张骨架（无界的骨架铺法会把「还在等」画成「有这么多」）
    await waitFor(() => { expect(container.querySelectorAll('.novel-city-sk')).toHaveLength(7) })
    expect(container.querySelectorAll('button.novel-city-card')).toHaveLength(1)   // 骨架不是钮
    // 在途 = 没有钮（不是「钮在但禁用」）：显隐只认 hasMore，写成 `hasMore || running` 就会在这一
    // 段把一颗点了必然撞 409 的钮亮出来。禁用态另有一条真实窗口（本地按下即加载中，见下面那条）。
    expect(screen.queryByRole('button', { name: /加载更多/ })).toBeNull()
    act(() => { frame({ ...snap, phase: 'done' }) })
    await waitFor(() => { expect(container.querySelectorAll('.novel-city-sk')).toHaveLength(0) })
    expect(screen.getByText('剑起长安')).toBeTruthy()              // 撤的是骨架，不是内容
  })

  it('封面失败的键按行身份（地址优先）：同名同作者而地址不同的两条不互相拖累，也不撞 React key', async () => {
    current = {
      ...snap,
      books: [
        { name: '剑起长安', author: '甲', bookUrl: 'https://a/broken', coverUrl: 'https://a/broken' },
        { name: '剑起长安', author: '乙', bookUrl: 'https://a/ok', coverUrl: 'https://a/ok' },
        // 服务端按**地址**去重，所以这一对是真给得出来的形状：名字一模一样、入口是两个。
        // 只按名字记 key 会让它们撞车——React 直接丢一行，坏封面还顺带降级另一条。
        { name: '同名同作者', author: '同一人', bookUrl: 'https://a/x1', coverUrl: 'https://a/x1' },
        { name: '同名同作者', author: '同一人', bookUrl: 'https://a/x2', coverUrl: 'https://a/x2' },
      ],
    }
    const { container } = render(<CityView deps={depsOf()} />)
    await waitFor(() => { expect(container.querySelectorAll('img.novel-city-cover')).toHaveLength(4) })
    fireEvent.error(container.querySelectorAll('img.novel-city-cover')[0])
    await waitFor(() => { expect(container.querySelectorAll('img.novel-city-cover')).toHaveLength(3) })
    expect(container.querySelectorAll('.novel-city-cover:not(img)')).toHaveLength(1)   // 只有那一条降级成首字块
  })

  it('换轮即清空封面失败表：新一轮里那张图要重来（不该一次坏封面永久降级）', async () => {
    const book = { name: '剑起长安', author: '青衫客', bookUrl: 'https://a/1', coverUrl: 'https://a/1' }
    const { over, frame } = pushable()
    current = { ...snap, phase: 'running', books: [book] }
    const { container } = render(<CityView deps={depsOf(over)} />)
    await waitFor(() => { expect(container.querySelectorAll('img.novel-city-cover')).toHaveLength(1) })
    fireEvent.error(container.querySelector('img.novel-city-cover')!)
    await waitFor(() => { expect(container.querySelectorAll('img.novel-city-cover')).toHaveLength(0) })
    act(() => { frame({ ...snap, id: 'j2', phase: 'running', books: [book] }) })
    await waitFor(() => { expect(container.querySelectorAll('img.novel-city-cover')).toHaveLength(1) })
  })

  it('被停止的轮次说「已停止」——不许长得像跑完的一轮', async () => {
    current = { ...snap, phase: 'failed', cancelled: true, page: 2 }
    render(<CityView deps={depsOf()} />)
    await waitFor(() => { expect(screen.getByText('已停止')).toBeTruthy() })
    expect(screen.queryByText(/第 \d+ 页/)).toBeNull()            // 停止不是「翻到了第 2 页」
  })

  it('这一页没回来：一条失败横幅 + 已到的书单保留 + 「加载更多」照旧可点', async () => {
    current = { ...snap, phase: 'failed', page: 2, hasMore: true, error: '站点甲：这一页没回来' }
    const { container } = render(<CityView deps={depsOf()} />)
    await waitFor(() => {
      expect(container.querySelector('.novel-err')?.textContent).toContain('站点甲：这一页没回来')
    })
    expect(screen.getByText('剑起长安')).toBeTruthy()               // 失败的一页不许划掉已经看到的那批书
    expect(screen.getByRole('button', { name: '加载更多（已 2 页）' })).toBeTruthy()   // 重试的机会留给用户
    expect(screen.getByText('第 2 页 · 累计 1 本')).toBeTruthy()      // 尾行只报这一轮跑到哪儿，错误归横幅
    expect(container.querySelectorAll('.novel-err')).toHaveLength(1)   // 同一句错误不在两处各说一遍
  })

  it('hasMore 为真：尾行给「加载更多（已 N 页）」，点一次发一次续页 POST（在途时钮禁用）', async () => {
    current = { ...snap, hasMore: true }
    const { over, frame } = pushable()
    const more: string[] = []
    let release: () => void = () => {}
    const deps = depsOf({
      apiSend: vi.fn(async (target: { path: string }) => {
        if (target.path === 'explore/list/more') { more.push(target.path); await new Promise<void>((r) => { release = r }) }   // 卡住这一页，看「在途」那一小段
        return { jobId: 'j1' }
      }),
      ...over,
    })
    render(<CityView deps={deps} />)
    fireEvent.click(await screen.findByRole('button', { name: '加载更多（已 1 页）' }))
    await waitFor(() => { expect(more).toHaveLength(1) })
    // 本页已回到 running（本地按下即加载中），钮据此禁用：这一小段窗口不许再发一次
    expect(screen.getByRole('button', { name: '加载更多（已 1 页）' }).hasAttribute('disabled')).toBe(true)
    act(() => { release() })
    await waitFor(() => { expect(deps.apiEventStream).toHaveBeenCalled() })                    // 续页后重新盯住这一轮
    act(() => { frame({ ...snap, page: 2, hasMore: true }) })                                 // 新一页回来：页码与钮都跟上服务端
    await waitFor(() => { expect(screen.getByRole('button', { name: '加载更多（已 2 页）' })).toBeTruthy() })
    expect(more).toHaveLength(1)
  })

  it('hasMore 为假：钮收掉、读数照旧（服务端说没了就真没了，不留一个点了没反应的饼）', async () => {
    current = snap                                        // 跑完且没有更多
    const { container } = render(<CityView deps={depsOf()} />)
    await waitFor(() => { expect(screen.getByText('第 1 页 · 这一页 1 本')).toBeTruthy() })
    expect(container.querySelector('.novel-city-foot')).not.toBeNull()
    expect(screen.queryByText(/加载更多/)).toBeNull()
  })

  it('续页撞 409（此刻没得可加载）：钮收掉、不报红条——没得加载不是故障', async () => {
    current = { ...snap, hasMore: true }
    const deps = depsOf({
      apiSend: vi.fn(async (target: { path: string }) => {
        if (target.path === 'explore/list/more') throw new ApiClientError('Conflict', 409, '没有更多了')
        return { jobId: 'j1' }
      }),
    })
    const { container } = render(<CityView deps={deps} />)
    fireEvent.click(await screen.findByRole('button', { name: '加载更多（已 1 页）' }))
    await waitFor(() => { expect(screen.queryByRole('button', { name: /加载更多/ })).toBeNull() })
    expect(container.querySelector('.novel-err')).toBeNull()
  })

  it('挂载恢复不得盖掉刚落地的提交（旧的恢复读后到，新轮的空帧说了算）', async () => {
    // 闸门卡住「上一轮」的那次恢复读。抢在恢复读之前提交的通道是**用户手点**（自动那条要等
    // 恢复读落地才决定），没有 submitted 闸，后到的旧帧就会拿上一轮的书单盖掉刚落下的新轮
    const gate = { open: (): void => {} }
    const stale = { ...snap, id: 'old', kind: '穿越重生',
      books: [{ name: '上一轮的书', author: '甲', bookUrl: 'https://a/x' }] }
    const d = depsOf({
      apiGet: vi.fn(async (p: string) => {
        if (p.includes('kinds')) return sources
        await new Promise<void>((res) => { gate.open = res })
        return { job: stale }
      }),
      apiEventStream: vi.fn(async () => { throw new Error('无 SSE') }),   // 那一帧空态只能被恢复读改写
    })
    render(<CityView deps={d} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: '穿越重生' })).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '穿越重生' }))
    await waitFor(() => { expect(screen.getByText('正在启动分类抓取…')).toBeTruthy() })   // 新轮的空帧已落地
    gate.open()
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText('上一轮的书')).toBeNull()
    expect(screen.getByText('正在启动分类抓取…')).toBeTruthy()
  })
})

/** 书籍详情浮层：只挂浮层自己（它不依赖左栏现场，单独钉省掉一半夹具）。 */
function openSheet(node: ReactNode): ReturnType<typeof render> { return render(node) }
const noop = (): void => {}

/** 浮层里那本书：`bookUrl` 就是它在本源上的地址（书籍身份 = 读这本的入口） */
const aBook: ExploreBook = {
  name: '半城风月', author: '沈念', bookUrl: '/b/1', intro: '一段该在浮层里看全文的简介',
  kind: '现代情感', lastChapter: '第 30 章', coverUrl: null, wordCount: null,
}
/** 本源身份：浏览轴已收成按源，浮层拿到的书恒属于这一源（生产由 `CityView` 从轮次带来） */
const own = { sourceId: 's1', sourceName: '半夏小说' }

/** 一个搜索分组（`SearchGroup` 的最小可用形状：源身份 + 命中；命中只填在意的字段，其余按 wire
 *  的「可空即 null」补齐——桩的形状必须与契约同形，不能靠缺键蒙过类型） */
function group(sourceId: string, sourceName: string, hits: Array<{ title: string; author?: string; url?: string | null; lastChapterName?: string | null }>): SearchGroup {
  return {
    sourceId, sourceName, status: 'unverified',
    hits: hits.map((h) => ({
      title: h.title, author: h.author ?? null, url: h.url ?? null, coverUrl: null, intro: null,
      lastChapterName: h.lastChapterName ?? null, kind: null, wordCount: null,
    })),
  }
}

/** 把搜索面的读面与写面按路径喂成给定的那一轮：浮层里那颗跨源钮走的就是这条既有链。
 *  游标语义照服务端的样子演：`added` 按请求带的 `since` 切片（不切就会把同一批命中累第二遍）。 */
function depsWithGroups(groups: SearchGroup[], job: Partial<SearchJobSnapshot> = {}): FakeViewDeps {
  const snap: SearchJobSnapshot = {
    id: 'sj1', keyword: '半城风月 沈念', phase: 'done', cancelled: false,
    total: 142, done: groups.length, added: groups, next: groups.length, startedAt: 1, ...job,
  }
  const sinceOf = (path: string): number => Number(new URLSearchParams(String(path).split('?')[1] ?? '').get('since') ?? '0')
  /** 快照按请求带的游标切片（与服务端同语义）：不切就会把同一批命中累第二遍 */
  const payload = (path: string): { job: SearchJobSnapshot } => ({ job: { ...snap, added: snap.added.slice(sinceOf(path)) } })
  return makeCoreDeps({
    apiSend: vi.fn(async (target: { path: string }) => (target.path === ROUTES.searchJob.path ? { jobId: snap.id } : {})),
    apiGet: vi.fn(async (path: string) => payload(path)),
    apiEventStream: vi.fn(async (path: string, onFrame: (data: string) => void) => { onFrame(JSON.stringify(payload(path))) }),
  })
}

describe('CityBookSheet（书籍详情浮层：本源两动作 + 跨源那一次）', () => {
  it('本源那一行给「加入书架 / 读这本」，简介在浮层里给全文', async () => {
    openSheet(<CityBookSheet book={aBook} {...own} deps={depsWithGroups([])} onClose={noop} />)
    expect(screen.getAllByRole('button', { name: '读这本' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: '加入书架' })).toHaveLength(1)
    expect(screen.getByText('一段该在浮层里看全文的简介')).toBeTruthy()
  })

  it('没有书地址时一个按钮都不给（读与架共用这一条守卫），那一行照样交代「这个源收录了它」', async () => {
    openSheet(<CityBookSheet book={{ name: '无址', author: null, bookUrl: null,
      coverUrl: null, kind: null, lastChapter: null, intro: null, wordCount: null }} {...own} deps={makeCoreDeps()} onClose={noop} />)
    expect(screen.queryAllByRole('button', { name: '读这本' })).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: '加入书架' })).toHaveLength(0)
    expect(screen.getByText('半夏小说')).toBeTruthy()
  })

  // wire 上 `lastChapter` / `intro` 是**非可选的 `string | null`**：Miss 的值是 `null` 而不是缺键，
  // 守卫判 `undefined` 就永不生效，界面上会留一颗读不到内容的「最新 」空壳（缺的整段不出现，
  // 那条口径同住 `cityMeta`）。
  it('最新章与简介都是 null 时那两段整段不出现（不给空壳占位）', () => {
    openSheet(<CityBookSheet book={{ ...aBook, lastChapter: null, intro: null }} {...own}
      deps={depsWithGroups([])} onClose={noop} />)
    expect(screen.queryByText(/最新/)).toBeNull()
    const metas = Array.from(document.querySelectorAll('.novel-city-bookhead-meta'))
    expect(metas).toHaveLength(1)                          // 只剩元信息那一段，简介那段整段不走
    expect(metas[0].textContent).toContain('现代情感')       // 元信息没被误伤
  })

  it('本源那一行「加入书架」成功：走 PUT 架位并进成功泳道报书名', async () => {
    const deps = depsWithGroups([])
    openSheet(<CityBookSheet book={aBook} {...own} deps={deps} onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: '加入书架' }))
    await waitFor(() => expect(deps.pushOk).toHaveBeenCalledWith('已加入书架：半城风月'))
    expect(deps.apiSend).toHaveBeenCalledWith(paramOps.shelfPut.at('/b/1'), expect.objectContaining({
      sourceId: 's1', title: '半城风月',
    }))
    expect(panelShelf.get().landed.has('/b/1'), '书城加架与搜索行共用落架账').toBe(true)
    expect(deps.pushError, '成功不该走失败泳道').not.toHaveBeenCalled()
  })

  it('本源那一行「加入书架」失败：进错误泳道报错误原文，不静默', async () => {
    const deps = makeCoreDeps({
      apiGet: vi.fn(async () => ({ job: null })),
      apiSend: vi.fn(async () => { throw new Error('disk') }),
    })
    openSheet(<CityBookSheet book={aBook} {...own} deps={deps} onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: '加入书架' }))
    await waitFor(() => expect(deps.pushError).toHaveBeenCalledWith('加入书架失败：disk'))
    expect(deps.pushOk, '失败不该报成功').not.toHaveBeenCalled()
  })

  it('「在其他源找这本」提交的是书名 + 作者，走搜索面那条既有链（POST search/job）', async () => {
    const calls: Array<{ p: string; b: unknown }> = []
    const deps = makeCoreDeps({
      apiGet: vi.fn(async () => ({ job: null })),
      apiSend: vi.fn(async (target: { path: string }, b: unknown) => { calls.push({ p: target.path, b }); return { jobId: 'j9' } }),
    })
    openSheet(<CityBookSheet book={aBook} {...own} deps={deps} onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: /在其他源找这本/ }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({ p: 'search/job', b: { keyword: '半城风月 沈念' } })
  })

  it('跨源结果就地长在同一列：每组一行「读这本 / 加入书架」并带上该源自己的书名，出错那组只列名与错误码', async () => {
    openSheet(<CityBookSheet book={aBook} {...own} deps={depsWithGroups([
      group('s2', '顶点', [{ title: '半城风月（顶点叫法）', author: '沈念', url: 'https://v/9', lastChapterName: '第 12 章' }]),
      { ...group('s3', '坏源', []), error: { code: 'Timeout', message: '超时' } },
    ])} onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: /在其他源找这本/ }))
    await waitFor(() => expect(screen.getByText('顶点')).toBeTruthy(), { timeout: 2500 })
    expect(screen.getByText(/半城风月（顶点叫法）/)).toBeTruthy()   // 不替用户判是不是同一本书：两边的名字都在行上
    expect(screen.getByText(/最新：第 12 章/)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '读这本' })).toHaveLength(2)      // 本源 + 顶点（坏源那行没有钮）
    expect(screen.getAllByRole('button', { name: '加入书架' })).toHaveLength(2)
    expect(screen.getByText(/坏源/)).toBeTruthy()
    expect(screen.getByText(/Timeout/)).toBeTruthy()
  })

  it('跨源那一次按相关性收视野：无关条目进折叠区，展开后仍可点；本源那一行不受影响', async () => {
    openSheet(<CityBookSheet book={aBook} {...own} deps={depsWithGroups([
      group('s2', '顶点', [
        { title: '半城风月（顶点叫法）', author: '沈念', url: 'https://v/9', lastChapterName: '第 12 章' },
        { title: '与这本无关的推荐位', author: '他人', url: 'https://v/x', lastChapterName: null },
      ]),
    ])} onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: /在其他源找这本/ }))
    await waitFor(() => expect(screen.getByText('顶点')).toBeTruthy(), { timeout: 2500 })
    // 折叠判据只能钉 DOM 事实：jsdom 没有 UA 样式表，closed <details> 的内容照样查得到，
    // 用 queryByText(...).toBeNull() 既红得莫名其妙，又会在「实现真把条目删了」时假绿。
    const fold = document.querySelector('details')
    expect(fold, '该组要有折叠区').not.toBeNull()
    expect(fold!.open, '默认收起').toBe(false)
    expect(screen.getByText(/半城风月（顶点叫法）/).closest('details'), '相关那条不在折叠区里').toBeNull()
    expect(fold!.textContent).toContain('与这本无关的推荐位')
    fireEvent.click(fold!.querySelector('summary')!)
    expect(fold!.open, '点了要展开').toBe(true)
    expect(screen.getAllByRole('button', { name: '读这本' }).length).toBeGreaterThanOrEqual(2)
  })

  // 代表行取哪一条也是判据的事：站点先回来的常常是推荐位，按到达序取就是让无关条目占住这一源唯一的
  // 那一行——那条真结果则压根不上默认视野（这一层一行一个源，见 `GroupRow` 的三种来路）。
  it('无关那条不许占这一源的代表行：档首相关的那条上默认视野，无关那条留在折叠区里', async () => {
    openSheet(<CityBookSheet book={aBook} {...own} deps={depsWithGroups([
      group('s2', '顶点', [
        { title: '与这本无关的推荐位', author: '他人', url: 'https://v/x', lastChapterName: '第 1 章' },
        { title: '半城风月（顶点叫法）', author: '沈念', url: 'https://v/9', lastChapterName: '第 12 章' },
      ]),
    ])} onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: /在其他源找这本/ }))
    await waitFor(() => expect(screen.getByText('顶点')).toBeTruthy(), { timeout: 2500 })
    expect(screen.getByText(/最新：第 12 章/).closest('details'), '代表行是相关那一条（它的最新在默认视野）').toBeNull()
    expect(screen.getByText(/与这本无关的推荐位/).closest('details'), '无关那条要在折叠区里').not.toBeNull()
  })

  // 三种来路的读数是按**答复**长的，不是按默认视野长的：只回了疑似无关的一家既不是「这一家没搜到」
  // （它答了，条目都在折叠里），也不是「没有一家按这个书名搜到」（那是答复的总结）。
  it('某一家只回疑似无关：不折成「这一家没有按这个书名搜到」，折叠那一行点名这一家回了什么', async () => {
    openSheet(<CityBookSheet book={aBook} {...own} deps={depsWithGroups([
      group('s2', '顶点', [{ title: '与这本无关的推荐位', author: '他人', url: 'https://v/x', lastChapterName: null }]),
      group('s3', '书海', [{ title: '半城风月', author: '沈念', url: 'https://s/9', lastChapterName: null }]),
    ])} onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: /在其他源找这本/ }))
    await waitFor(() => expect(screen.getByText('书海')).toBeTruthy(), { timeout: 2500 })
    const fold = document.querySelector('details')
    expect(fold, '只回无关条目那组要有折叠区').not.toBeNull()
    // 回正标记按计数钉：疑似折叠恰一条（styles 里那条标记级规则认领的就是它，标记掉了规则成死规则；
    // 贴到别家折叠上则由下一条用例红）
    expect(fold!.hasAttribute('data-novel-city-suspect'), '疑似折叠要带标记：非故障的容器靠它回正线条与底色').toBe(true)
    expect(document.querySelectorAll('[data-novel-city-suspect]'),
      '标记只属于疑似折叠：这一轮一家疑似，恰一条').toHaveLength(1)
    expect(fold!.textContent).toContain('与这本无关的推荐位')
    expect(fold!.querySelector('summary')?.textContent).toContain('顶点')   // 默认视野只有这一行要说得出是谁家的
    expect(screen.queryByText(/这一家没有按这个书名搜到/)).toBeNull()
    expect(screen.queryByText(/没有一家按这个书名搜到/)).toBeNull()
  })

  it('跨源一条没搜到 ≠ 失败：说的是「没有一家按这个书名搜到」，不许挂红条', async () => {
    openSheet(<CityBookSheet book={aBook} {...own} deps={depsWithGroups([
      group('s2', '顶点', []), group('s3', '多看', []),
    ])} onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: /在其他源找这本/ }))
    await waitFor(() => expect(screen.getByText(/没有一家按这个书名搜到/)).toBeTruthy(), { timeout: 2500 })
    expect(screen.queryByText(/失败/)).toBeNull()
    expect(document.querySelector('.novel-err')).toBeNull()
  })

  // 口径④的那半边：**一个答复都没有**时不许说「没有一家按这个书名搜到」。未响应那组的命中列表本来就是
  // 空的，所以「组里没命中」这一条对整列失败照样成立（一条都没答时更是真空成立）——判据必须额外要
  // 「至少一家干净答了」，否则这条红绿的唯一区别就只剩运气。
  it('整列都在未响应：一个答复都没有时只出未响应，不冒充「都没有搜到」', async () => {
    openSheet(<CityBookSheet book={aBook} {...own} deps={depsWithGroups([
      { ...group('s2', '坏源甲', []), error: { code: 'Timeout', message: '超时' } },
      { ...group('s3', '坏源乙', []), error: { code: 'FetchError', message: '连不上' } },
    ])} onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: /在其他源找这本/ }))
    await waitFor(() => expect(screen.getAllByText(/未响应/)).toHaveLength(2), { timeout: 2500 })
    expect(screen.queryByText(/没有一家按这个书名搜到/)).toBeNull()
    expect(screen.queryByText(/这一家没有按这个书名搜到/)).toBeNull()
    expect(document.querySelectorAll('[data-novel-city-suspect]'),
      '未响应是真失败：不许蹭疑似折叠的回正标记，红框红底原样留着').toHaveLength(0)
  })

  it('零命中那句只由答复作证：一家答了、零条，另一家未响应——两句话各说各的', async () => {
    openSheet(<CityBookSheet book={aBook} {...own} deps={depsWithGroups([
      group('s2', '顶点', []),
      { ...group('s3', '坏源', []), error: { code: 'Timeout', message: '超时' } },
    ])} onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: /在其他源找这本/ }))
    await waitFor(() => expect(screen.getByText(/没有一家按这个书名搜到/)).toBeTruthy(), { timeout: 2500 })
    expect(screen.getByText(/未响应/)).toBeTruthy()          // 未响应那一行照旧摊开，不被零命中吞掉
    expect(screen.getByText(/这一家没有按这个书名搜到/)).toBeTruthy()
  })

  it('某一家答了、零条命中：那一行如实说「这一家没有按这个书名搜到」，空集合不折成「没响应」', async () => {
    openSheet(<CityBookSheet book={aBook} {...own} deps={depsWithGroups([group('s2', '顶点', [])])} onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: /在其他源找这本/ }))
    await waitFor(() => expect(screen.getByText('顶点')).toBeTruthy(), { timeout: 2500 })
    expect(screen.getByText(/这一家没有按这个书名搜到/)).toBeTruthy()
    expect(screen.queryByText(/未响应/)).toBeNull()
  })

  it('跨源进行中给进度与「停止」，停止不是失败', async () => {
    const deps = depsWithGroups([], { phase: 'running', total: 142, done: 3, next: 3 })
    openSheet(<CityBookSheet book={aBook} {...own} deps={deps} onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: /在其他源找这本/ }))
    await waitFor(() => expect(screen.getByText(/已问到 3 \/ 142 家/)).toBeTruthy(), { timeout: 2500 })
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(deps.apiSend).toHaveBeenLastCalledWith(ROUTES.searchJobCancel, {})
    expect(screen.queryByText(/失败/)).toBeNull()
    expect(document.querySelector('.novel-err')).toBeNull()
  })

  it('被停止的那一轮不许对结果下结论：说「已停止」，不说「没有一家按这个书名搜到」', async () => {
    openSheet(<CityBookSheet book={aBook} {...own} deps={depsWithGroups([], {
      phase: 'failed', cancelled: true, done: 0, next: 0, error: '任务已取消：用户停止了搜索',
    })} onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: /在其他源找这本/ }))
    await waitFor(() => expect(screen.getByText(/已停止：没问完的源不再往下问/)).toBeTruthy(), { timeout: 2500 })
    expect(screen.queryByText(/没有一家按这个书名搜到/)).toBeNull()
    expect(screen.queryByText(/失败/)).toBeNull()
    expect(document.querySelector('.novel-err')).toBeNull()
  })

  it('一家都没被问到（参与集为空）不冒充「搜了没命中」', async () => {
    openSheet(<CityBookSheet book={aBook} {...own} deps={depsWithGroups([], { total: 0, done: 0, next: 0 })} onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: /在其他源找这本/ }))
    await waitFor(() => expect(screen.getByText(/这一轮一家都没被问到/)).toBeTruthy(), { timeout: 2500 })
    expect(screen.queryByText(/没有一家按这个书名搜到/)).toBeNull()
  })

  // 搜索面只有一个槽、观察者跟随最近一轮（`docs/adr/0046`）：浮层挂载时的恢复读交回的很可能是
  // **另一本书**那一轮，而 `asked` 在点击瞬间即真——本次 POST 回包之前手上的就是它。
  // 那一列认的是本层 POST 回来的 jobId（关键词不是身份；也不替别人 cancel）。
  it('挂载恢复带来的「上一本书那一轮」不当成本书的结果：那一列不出现、也不报零命中', async () => {
    const stale: SearchJobSnapshot = {
      id: 'sj0', keyword: '上一本书 的作者', phase: 'done', cancelled: false, total: 1, done: 1, next: 1,
      added: [group('s9', '上一本书的源', [{ title: '上一本书', url: 'https://x/1' }])], startedAt: 1,
    }
    let release: (v: { jobId: string }) => void = () => {}
    const deps = makeCoreDeps({
      apiGet: vi.fn(async () => ({ job: stale })),
      apiSend: vi.fn(async () => new Promise<{ jobId: string }>((r) => { release = r })),
      apiEventStream: vi.fn(async () => { throw new Error('无 SSE') }),
    })
    openSheet(<CityBookSheet book={aBook} {...own} deps={deps} onClose={noop} />)
    await waitFor(() => expect(deps.apiGet).toHaveBeenCalled())        // 那一轮已挂到视图上
    fireEvent.click(screen.getByRole('button', { name: /在其他源找这本/ }))
    await new Promise((r) => setTimeout(r, 20))                        // POST 还在飞：正是那扇窗口
    expect(screen.queryByText('上一本书的源')).toBeNull()
    expect(screen.queryByText(/没有一家按这个书名搜到/)).toBeNull()
    release({ jobId: 'sj1' })
    await waitFor(() => expect(screen.getByText(/正在启动跨源搜索/)).toBeTruthy(), { timeout: 2500 })
    expect(screen.queryByText('上一本书的源')).toBeNull()               // 本轮自己还没有答复可列
  })

  it('同关键词的另一轮也不接管：浮层只认自己 POST 回来的 jobId', async () => {
    const stale: SearchJobSnapshot = {
      id: 'sj0', keyword: '半城风月 沈念', phase: 'done', cancelled: false, total: 1, done: 1, next: 1,
      added: [group('s9', '同关键词旧源', [{ title: '半城风月', url: 'https://x/1' }])], startedAt: 1,
    }
    let release: (v: { jobId: string }) => void = () => {}
    const deps = makeCoreDeps({
      apiGet: vi.fn(async () => ({ job: stale })),
      apiSend: vi.fn(async () => new Promise<{ jobId: string }>((r) => { release = r })),
      apiEventStream: vi.fn(async () => { throw new Error('无 SSE') }),
    })
    openSheet(<CityBookSheet book={aBook} {...own} deps={deps} onClose={noop} />)
    await waitFor(() => expect(deps.apiGet).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: /在其他源找这本/ }))
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText('同关键词旧源')).toBeNull()               // 关键词相同也不是身份
    release({ jobId: 'sj1' })
    await waitFor(() => expect(screen.getByText(/正在启动跨源搜索/)).toBeTruthy(), { timeout: 2500 })
    expect(screen.queryByText('同关键词旧源')).toBeNull()
  })

  it('重复点击按最后一次认领：挂住的那颗不闸重试，先回的新轮也不被迟到旧回包倒回', async () => {
    const releases: Array<(v: { jobId: string }) => void> = []
    const deps = makeCoreDeps({
      apiGet: vi.fn(async () => ({ job: null })),
      apiSend: vi.fn(async () => new Promise<{ jobId: string }>((r) => { releases.push(r) })),
      apiEventStream: vi.fn(async () => { throw new Error('无 SSE') }),
    })
    openSheet(<CityBookSheet book={aBook} {...own} deps={deps} onClose={noop} />)
    await waitFor(() => expect(deps.apiGet).toHaveBeenCalled())
    const button = screen.getByRole('button', { name: /在其他源找这本/ })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(deps.apiSend).toHaveBeenCalledTimes(2)                 // 第一颗挂着挡不住再点一次
    releases[1]({ jobId: 'mine' })                                // 后一次点击的回包先落地
    await waitFor(() => expect(screen.getByText(/正在启动跨源搜索/)).toBeTruthy(), { timeout: 2500 })
    releases[0]({ jobId: 'late' })                                // 旧回包后落地：不许把观察者倒回旧轮
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByText(/正在启动跨源搜索/)).toBeTruthy()
  })

  // 浮层维持逐源轴：这一层谈的**本来就是一本**，按书归并（`shared/merge-by-book.ts` 的 `mergeBooks`，
  // 只进搜索面）在这里买不到任何浓缩，却会吞掉三条既有读数——有命中／答了但零条／未响应，逐源各说各的。
  // 这条钉子不改行为，挡的是将来「顺手统一」把逐源轴拆了（裁决见 docs/adr/0033，本浮层刻意不吃归并）。
  it('浮层的跨源那一列不折叠成一本：三家答法各异，逐行各自可见', async () => {
    openSheet(<CityBookSheet book={aBook} {...own} deps={depsWithGroups([
      group('s2', '顶点', [{ title: '半城风月（顶点叫法）', author: '沈念', url: 'https://v/9', lastChapterName: null }]),
      group('s3', '书海', [{ title: '半城风月', author: '沈念', url: 'https://s/9', lastChapterName: null }]),
      group('s4', '轻读', [{ title: '半城风月（轻读叫法）', author: '沈念', url: 'https://q/9', lastChapterName: null }]),
    ])} onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: /在其他源找这本/ }))
    await waitFor(() => expect(screen.getByText('顶点')).toBeTruthy(), { timeout: 2500 })
    expect(screen.getAllByRole('button', { name: '读这本' })).toHaveLength(4)          // 本源 + 三家
    expect(screen.queryByText(/家源/)).toBeNull()                                       // 「N 家源」那一行属于搜索面
  })
})

it('英文：没有分类入口时的空态', async () => {
  const d = depsOf({ apiGet: vi.fn(async (p: string) => (p.includes('kinds') ? { sources: [] } : { job: null })) })
  render(<CopyProvider value={enTranslate}><CityView deps={d} /></CopyProvider>)
  await waitFor(() => expect(screen.getByText(/No book source provides category browsing/)).toBeTruthy())
})
