// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CityView } from '../../src/client/views/CityView.js'
import { cityStore } from '../../src/client/store.js'

/**
 * 书城分类页的接线钉子：进入即加载词表首项、记住上次、空词表不提交、失败条如实点名、
 * 换类、左栏本地筛选、点卡开选源抽屉，以及两条「分不清就会说谎」的判据——被停止的轮次、
 * 「还没有一轮」与「零源的一轮」。
 *
 * 假依赖只喂三条口：词表 / 轮次快照（同一函数按 URL 分流）/ 提交一轮。SSE 缺省推一帧**当前
 * 快照**（与生产同路：首帧就是 baseline）——提交落地后那一帧空态在一个微任务内被填回，用例
 * 不必拿墙钟等轮询；要显式走轮询兜底那条路就在用例里把 stream 换成连不上的假实现。
 */

const kinds = { kinds: [{ title: '玄幻', sources: 2 }, { title: '都市', sources: 1 }] }

/** 一轮已跑完的分类快照：一本书（一个 origin，源名只该在抽屉/失败条里出现）+ 一个坏源 */
const snap = {
  id: 'j1', kind: '玄幻', phase: 'done', cancelled: false, total: 2, done: 2,
  books: [{
    name: '剑起长安', author: '青衫客', kind: '玄幻', lastChapter: '第 412 章', sourceCount: 2,
    origins: [{ sourceId: 's1', sourceName: '笔趣阁', bookUrl: 'https://a/1', lastChapter: '第 412 章' }],
  }],
  failures: [{ sourceId: 's2', sourceName: '顶点', code: 'FetchError', message: '超时' }],
  startedAt: 1,
}

const submitted: string[] = []
/** 服务端此刻持有的一轮（用例可换；SSE 推的就是它；`null` = 服务端说没有这一轮） */
let current: unknown = snap

/** 一个用例的提交记录与轮次快照不串到下一个用例（两者都是模块级） */
beforeEach(() => { submitted.length = 0; current = snap })
afterEach(() => { cleanup(); cityStore.set({ kind: null }) })

const deps = {
  apiGet: async (path: string) => (path.includes('kinds') ? kinds : { job: current }),
  apiSend: async (_m: string, _p: string, body: { kind: string }) => {
    submitted.push(body.kind)
    return { jobId: 'j1' }
  },
  apiEventStream: async (_path: string, onFrame: (data: string) => void) => {
    onFrame(JSON.stringify({ job: current }))
  },
  apiUpload: async () => ({}), pushError: () => {}, pushOk: () => {},
} as never

/** 覆写若干口（键面与假依赖束一致；值不逐处 cast——与仓里 `fake-deps.ts` 的 Overrides 同口径） */
const withDeps = (over: Record<string, unknown>): never => ({ ...(deps as object), ...over }) as never

/** 连不上的 SSE：显式走「轮询是地基」那条路 */
const noStream = { apiEventStream: async () => { throw new Error('无 SSE') } }

describe('CityView', () => {
  it('进入即加载词表第一项（服务端顺序即源数降序），且书单来自服务端', async () => {
    const { container } = render(<CityView deps={deps} />)
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
    render(<CityView deps={deps} />)
    await waitFor(() => { expect(submitted).toEqual(['都市']) })
    expect(screen.getByRole('button', { name: /都市/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('库里没有源提供分类 → 空态（且不提交任何一轮，也不留轮次读数）', async () => {
    // 两条读面要分开喂：kinds 空、status 明说「还没有一轮」（否则读面会多报一条无关错误）
    current = null
    const d = withDeps({ apiGet: async (p: string) => (p.includes('kinds') ? { kinds: [] } : { job: current }) })
    const { container } = render(<CityView deps={d} />)
    await waitFor(() => { expect(screen.getByText(/还没有书源提供分类浏览/)).toBeTruthy() })
    expect(submitted).toEqual([])
    // 「还没有一轮」不该有轮次读数（判据是有没有轮次，不是文案空不空）
    expect(container.querySelector('.novel-city-foot')).toBeNull()
  })

  it('失败条如实说数量，坏源在摘要行里就点名（不藏在展开里）', async () => {
    render(<CityView deps={deps} />)
    await waitFor(() => { expect(screen.getByText('1 个源没响应')).toBeTruthy() })
    const who = screen.getByText(/顶点/)
    expect(who.className).toBe('novel-city-fail-who')              // 摘要行，不是展开区
    expect(screen.getByText(/超时/)).toBeTruthy()                  // 展开区给完整 message
  })

  it('换类：点左栏另一项即提交它并记住（切类零跳转）', async () => {
    render(<CityView deps={deps} />)
    await waitFor(() => { expect(submitted).toEqual(['玄幻']) })
    fireEvent.click(screen.getByRole('button', { name: /都市/ }))
    await waitFor(() => { expect(submitted).toEqual(['玄幻', '都市']) })
    expect(cityStore.get().kind).toBe('都市')
  })

  it('左栏筛选是本地的：不触网、不提交，也不改当前类', async () => {
    render(<CityView deps={deps} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: /玄幻/ })).toBeTruthy() })
    fireEvent.change(screen.getByLabelText('筛选分类'), { target: { value: '都' } })
    expect(screen.queryByRole('button', { name: /玄幻/ })).toBeNull()
    expect(screen.getByRole('button', { name: /都市/ })).toBeTruthy()
    expect(submitted).toEqual(['玄幻'])
    expect(cityStore.get().kind).toBe('玄幻')
  })

  it('点卡开选源抽屉（本任务只到打开态），关掉回到书单', async () => {
    render(<CityView deps={deps} />)
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
    // apiSend 抛：提交落不了地，视图态就停在恢复回来的那一轮（不必拿墙钟等一次轮询）
    current = { ...snap, phase: 'failed', cancelled: true, done: 1 }
    const d = withDeps({ apiSend: async () => { throw new Error('服务端不可用') } })
    render(<CityView deps={d} />)
    await waitFor(() => { expect(screen.getByText('已停止')).toBeTruthy() })
    expect(screen.queryByText(/已 1 \/ 2 源/)).toBeNull()           // 停止不是「跑到了 1/2」
  })

  it('零源的一轮仍是一轮：尾行读数在场（与「还没有一轮」不是同一种空）', async () => {
    current = { ...snap, phase: 'done', total: 0, done: 0, books: [], failures: [] }
    const { container } = render(<CityView deps={withDeps(noStream)} />)
    await waitFor(() => { expect(container.querySelector('.novel-city-foot')).not.toBeNull() })
  })

  it('挂载恢复不得盖掉刚落地的提交（旧的恢复读后到，新轮的空帧说了算）', async () => {
    // 闸门卡住「上一轮」的那次读：提交先落地、恢复读后到——没有闸就会拿旧轮的书单盖掉新轮
    const gate = { open: (): void => {} }
    current = {
      ...snap, id: 'old',
      books: [{ name: '上一轮的书', author: '甲', kind: '玄幻', sourceCount: 1, origins: [] }],
    }
    const d = withDeps({
      ...noStream,                                          // 让那一帧空态只能被恢复读改写（不受推送干扰）
      apiGet: async (p: string) => {
        if (p.includes('kinds')) return kinds
        await new Promise<void>((res) => { gate.open = res })
        return { job: current }
      },
    })
    render(<CityView deps={d} />)
    await waitFor(() => { expect(screen.getByText('正在启动分类抓取…')).toBeTruthy() })   // 新轮的空帧已落地
    gate.open()
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText('上一轮的书')).toBeNull()
    expect(screen.getByText('正在启动分类抓取…')).toBeTruthy()
  })
})
