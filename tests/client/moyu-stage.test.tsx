// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createStore } from '../../src/client/store.js'
import { closeMoyu, moyuStore, openMoyu } from '../../src/client/moyu-store.js'
import { MoyuStage } from '../../src/client/views/MoyuStage.js'
import { MOYU_TICK_MS } from '../../src/client/moyu-stream.js'
import type { ReaderSession } from '../../src/client/reader-session.js'

interface FakeState {
  toc: Array<{ name: string; url: string }>
  chapters: Array<{ kind: 'text'; text: string } | null>
  currentChapter: number
  error: { code?: string; message?: string } | null
  loadingIdx: number | null
}

/** 只取 Stage 消费面的会话桩：快照不可变（换引用），tick store 只当通知源。 */
function makeFakeSession(chapters: Array<{ name: string; text: string } | null>) {
  const tick = createStore({ n: 0 })
  let snap: FakeState = {
    toc: chapters.map((c, i) => ({ name: c?.name ?? '', url: `#c${i}` })),
    chapters: chapters.map((c) => (c === null ? null : { kind: 'text', text: c.text })),
    currentChapter: 0,
    error: null,
    loadingIdx: null,
  }
  const notify = () => { tick.set({ n: tick.get().n + 1 }) }
  const requestJump = vi.fn((index: number) => {
    snap = { ...snap, currentChapter: index }
    notify()
  })
  const prefetchChapter = vi.fn()
  const retry = vi.fn()
  const session = {
    subscribe: (cb: () => void) => tick.subscribe(cb),
    get state() { return snap },
    requestJump,
    prefetchChapter,
    retry,
  } as unknown as ReaderSession
  const put = (patch: Partial<FakeState>) => {
    snap = { ...snap, ...patch }
    notify()
  }
  return { session, requestJump, prefetchChapter, retry, put }
}

afterEach(() => {
  cleanup()
  moyuStore.set({ on: false })
  vi.useRealTimers()
})

describe('MoyuStage', () => {
  it('store 关闭时舞台为空；打开后浮层以 dialog 在场', () => {
    const { session } = makeFakeSession([{ name: '第一章', text: '正文' }])
    const { container } = render(<MoyuStage session={session} />)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    act(() => { openMoyu() })
    expect(screen.getByRole('dialog')).toBeTruthy()
    act(() => { closeMoyu() })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('Esc 经模态契约关闭浮层', () => {
    const { session } = makeFakeSession([{ name: '第一章', text: '正文' }])
    const { container } = render(<MoyuStage session={session} />)
    act(() => { openMoyu() })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('退出钮关闭浮层', () => {
    const { session } = makeFakeSession([{ name: '第一章', text: '正文' }])
    const { container } = render(<MoyuStage session={session} />)
    act(() => { openMoyu() })
    fireEvent.click(screen.getByText('退出摸鱼'))
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('正文按固定拍揭示；章完成后停住，点「下一章」才跳章并预取', () => {
    vi.useFakeTimers()
    const chapters = [{ name: '第一章', text: '甲乙丙丁' }, { name: '第二章', text: '戊己' }]
    const { session, requestJump, prefetchChapter } = makeFakeSession(chapters)
    render(<MoyuStage session={session} />)
    act(() => { openMoyu() })
    // 每拍 6 字：一拍后 4 字章全量
    act(() => { vi.advanceTimersByTime(MOYU_TICK_MS) })
    expect(screen.getByText('甲乙丙丁')).toBeTruthy()
    expect(prefetchChapter).toHaveBeenCalledWith(1)
    // 完成行在场；揭示完成后不再有任何自动跳章
    expect(screen.getByText('本章完成 · 4 字')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(5000) })
    expect(requestJump).not.toHaveBeenCalled()
    // 手动点「下一章」才跳
    fireEvent.click(screen.getByText('下一章'))
    expect(requestJump).toHaveBeenCalledWith(1)
  })

  it('末章揭示完后停住：显示读完态、下一章置灰、点击无效', () => {
    vi.useFakeTimers()
    const { session, requestJump } = makeFakeSession([{ name: '末章', text: '甲乙' }])
    render(<MoyuStage session={session} />)
    act(() => { openMoyu() })
    act(() => { vi.advanceTimersByTime(MOYU_TICK_MS * 3) })
    expect(screen.getByText('已读完本书最新章节')).toBeTruthy()
    const next = screen.getByText<HTMLButtonElement>('下一章')
    expect(next.disabled).toBe(true)
    fireEvent.click(next)
    expect(requestJump).not.toHaveBeenCalled()
  })

  it('章未到时显示加载文案，不揭示、不翻页也不跳章', () => {
    vi.useFakeTimers()
    const { session, requestJump } = makeFakeSession([null])
    render(<MoyuStage session={session} />)
    act(() => { openMoyu() })
    expect(screen.getByText('正在加载章节')).toBeTruthy()
    expect(screen.queryByText('上一章')).toBeNull()
    act(() => { vi.advanceTimersByTime(MOYU_TICK_MS * 10) })
    expect(requestJump).not.toHaveBeenCalled()
  })

  it('上滚脱离跟随后浮出回底钮，回底后重新跟随', () => {
    const { session } = makeFakeSession([{ name: '第一章', text: '甲乙丙丁' }])
    render(<MoyuStage session={session} />)
    act(() => { openMoyu() })
    expect(screen.queryByText('回到底部')).toBeNull()
    const scroller = document.querySelector('.novel-moyu-scroll') as HTMLElement
    // jsdom 没有布局：直接盖写几何读数再派发 scroll（writable 严格模式赋值才不炸）
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 300 })
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: 100 })
    fireEvent.scroll(scroller)
    expect(screen.getByText('回到底部')).toBeTruthy()
    fireEvent.click(screen.getByText('回到底部'))
    expect(screen.queryByText('回到底部')).toBeNull()
  })

  it('流式揭示中视角停在顶部不动时，正文长出视口后仅凭几何重判就浮出回底钮', () => {
    vi.useFakeTimers()
    const { session } = makeFakeSession([{ name: '第一章', text: '甲乙丙丁戊己庚辛' }])
    render(<MoyuStage session={session} />)
    act(() => { openMoyu() })
    expect(screen.queryByText('回到底部')).toBeNull()
    // 开场视角在转录顶部：离尾远、且全程不派发 scroll 事件——旧实现里
    // pinned 停留在初始 true，回底钮在最需要它时永不出现。
    const scroller = document.querySelector('.novel-moyu-scroll') as HTMLElement
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 300 })
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: 0 })
    // 揭示步进提交后按几何重判：离尾 1700px → 浮钮出现（不依赖滚动事件）
    act(() => { vi.advanceTimersByTime(MOYU_TICK_MS) })
    expect(screen.getByText('回到底部')).toBeTruthy()
    // 点回底：压到尾 + 重新跟随 → 浮钮消失
    fireEvent.click(screen.getByText('回到底部'))
    expect(screen.queryByText('回到底部')).toBeNull()
  })

  it('会话报错时行内显示错误与重试钮', () => {
    const { session, retry, put } = makeFakeSession([{ name: '第一章', text: '甲' }])
    render(<MoyuStage session={session} />)
    act(() => {
      openMoyu()
      put({ error: { code: 'X', message: '网络超时' } })
    })
    expect(screen.getByText('章节读取失败：网络超时')).toBeTruthy()
    fireEvent.click(screen.getByText('重试'))
    expect(retry).toHaveBeenCalled()
  })

  it('每章投影为「已深度思考」行 + 章名摘要 + 读取文件工具行', () => {
    const { session } = makeFakeSession([{ name: '第一章', text: '甲乙丙丁' }])
    render(<MoyuStage session={session} />)
    act(() => { openMoyu() })
    expect(screen.getByText('已深度思考')).toBeTruthy()
    expect(screen.getByText('第一章')).toBeTruthy()
    expect(screen.getByText('读取 chapters/0001_第一章.ts')).toBeTruthy()
    expect(screen.getByText('深度思考中')).toBeTruthy()
  })

  it('流式段带 live 扫光类；整章揭示完后摘除', () => {
    vi.useFakeTimers()
    const { session } = makeFakeSession([{ name: '第一章', text: '甲乙丙丁戊己庚辛' }])
    const { container } = render(<MoyuStage session={session} />)
    act(() => { openMoyu() })
    expect(container.querySelector('.novel-moyu-live')).toBeNull()
    act(() => { vi.advanceTimersByTime(MOYU_TICK_MS) })
    const live = container.querySelector('.novel-moyu-live')
    expect(live).toBeTruthy()
    expect(live?.textContent).toBe('甲乙丙丁戊己')
    act(() => { vi.advanceTimersByTime(MOYU_TICK_MS) })
    expect(container.querySelector('.novel-moyu-live')).toBeNull()
    expect(screen.getByText('甲乙丙丁戊己庚辛')).toBeTruthy()
  })

  it('节奏规则：每 4 行第 1 行正常无标记，其余小字浅色带动作标记', () => {
    vi.useFakeTimers()
    const text = '夜色沉下来，远处的火光一点点暗了下去，营地里无人说话。\n第二行正文内容。\n第三行正文内容。\n第四行正文内容。'
    const { session } = makeFakeSession([{ name: '第一章', text }])
    const { container } = render(<MoyuStage session={session} />)
    act(() => { openMoyu() })
    act(() => { vi.advanceTimersByTime(MOYU_TICK_MS * 10) })
    const paras = container.querySelectorAll('.novel-moyu-p')
    expect(paras.length).toBe(4)
    // 第 1 行 = 正常行：内容字号、主色、无动作标记
    expect(paras.item(0).className).toBe('novel-moyu-p')
    expect(paras.item(0).textContent).toBe('夜色沉下来，远处的火光一点点暗了下去，营地里无人说话。')
    // 第 2~4 行 = 小字行：小一号、浅色、行首带动作标记（▸ » ⇣ 按池轮换）
    expect(paras.item(1).className).toBe('novel-moyu-p novel-moyu-p--small')
    expect(paras.item(1).textContent).toBe('▸第二行正文内容。')
    expect(paras.item(2).className).toBe('novel-moyu-p novel-moyu-p--small')
    expect(paras.item(2).textContent).toBe('»第三行正文内容。')
    expect(paras.item(3).className).toBe('novel-moyu-p novel-moyu-p--small')
    expect(paras.item(3).textContent).toBe('⇣第四行正文内容。')
    const marks = container.querySelectorAll('.novel-moyu-mark')
    expect(Array.from(marks, (m) => m.textContent)).toEqual(['▸', '»', '⇣'])
    expect(screen.getByText('本章完成 · 51 字')).toBeTruthy()
  })

  it('小字行动作标记在周期间滚动（▸ » ⇣ ✎ …），正常行恒无标记', () => {
    vi.useFakeTimers()
    const line = '甲乙丙丁戊己庚辛壬癸'
    const text = Array.from({ length: 9 }, () => line).join('\n')
    const { session } = makeFakeSession([{ name: '第一章', text }])
    const { container } = render(<MoyuStage session={session} />)
    act(() => { openMoyu() })
    act(() => { vi.advanceTimersByTime(MOYU_TICK_MS * 17) })
    const paras = container.querySelectorAll('.novel-moyu-p')
    expect(paras.length).toBe(9)
    // 正常行（每周期第 1 行）与它的文本：无动作标记
    expect([0, 4, 8].map((i) => paras.item(i).className)).toEqual(['novel-moyu-p', 'novel-moyu-p', 'novel-moyu-p'])
    expect(paras.item(0).textContent).toBe(line)
    // 小字行标记：第一周期 ▸ » ⇣，第二周期从 ✎ 接着滚——周期间不重头
    const marks = container.querySelectorAll('.novel-moyu-mark')
    expect(Array.from(marks, (m) => m.textContent)).toEqual(['▸', '»', '⇣', '✎', '▸', '»'])
  })

  it('右侧栏渲染资源管理器：书名根目录、README 与章文件，当前章高亮', () => {
    const { session } = makeFakeSession([{ name: '第一章', text: '甲' }, { name: '第二章', text: '乙' }])
    render(<MoyuStage session={session} title="汉兴" />)
    act(() => { openMoyu() })
    const side = document.querySelector('.novel-moyu-side') as HTMLElement
    expect(side).toBeTruthy()
    expect(screen.getByText('资源管理器')).toBeTruthy()
    expect(screen.getByText('汉兴')).toBeTruthy()
    expect(screen.getByText('README.md')).toBeTruthy()
    expect(screen.getByText('0001_第一章.ts')).toBeTruthy()
    expect(screen.getByText('0002_第二章.ts')).toBeTruthy()
    const active = side.querySelector('[aria-current="true"]') as HTMLElement
    expect(active.textContent).toBe('0001_第一章.ts')
  })

  it('点侧栏章文件即跳章；修改点标到过的章；书名缺席时不渲染根目录行', () => {
    const { session, requestJump } = makeFakeSession([
      { name: '第一章', text: '甲' }, { name: '第二章', text: '乙' }, { name: '第三章', text: '丙' }])
    render(<MoyuStage session={session} />)
    act(() => { openMoyu() })
    expect(document.querySelector('.novel-moyu-side-folder')).toBeNull()
    fireEvent.click(screen.getByText('0003_第三章.ts'))
    expect(requestJump).toHaveBeenCalledWith(2)
    expect(document.querySelectorAll('[data-done]').length).toBe(3)
    const active = document.querySelector('[aria-current="true"]') as HTMLElement
    expect(active.textContent).toBe('0003_第三章.ts')
  })

  it('翻页行边界置灰：首章上一章置灰，末章下一章置灰且点击无效', () => {
    vi.useFakeTimers()
    const { session, requestJump } = makeFakeSession([{ name: '第一章', text: '甲' }, { name: '第二章', text: '乙' }])
    render(<MoyuStage session={session} />)
    act(() => { openMoyu() })
    act(() => { vi.advanceTimersByTime(MOYU_TICK_MS) })
    expect(screen.getByText<HTMLButtonElement>('上一章').disabled).toBe(true)
    expect(screen.getByText<HTMLButtonElement>('下一章').disabled).toBe(false)
    fireEvent.click(screen.getByText('下一章'))
    expect(requestJump).toHaveBeenCalledWith(1)
    act(() => { vi.advanceTimersByTime(MOYU_TICK_MS) })
    expect(screen.getByText<HTMLButtonElement>('上一章').disabled).toBe(false)
    const next = screen.getByText<HTMLButtonElement>('下一章')
    expect(next.disabled).toBe(true)
    fireEvent.click(next)
    expect(requestJump).toHaveBeenCalledTimes(1)
  })
})
