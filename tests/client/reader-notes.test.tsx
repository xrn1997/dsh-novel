// @vitest-environment jsdom
import type { ReactElement, ReactNode } from 'react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { queries } from '../../src/shared/wire.js'
import type { ReaderDeps } from '../../src/client/deps.js'
import { ReaderNotes } from '../../src/client/views/ReaderNotes.js'
import type { SupplementTarget } from '../../src/client/views/ReaderNotes.js'
import type { ChapterContent, ContentNode } from '../../src/client/views/types.js'
import { makeReaderDeps } from './fake-deps.js'
import { rect, stubLayout } from './scroll-stub.js'

/**
 * 注释面板（ReaderNotes）的行为钉子。三条口径各自钉一半：
 *  ① **只读补充文档**：面板只请求 localDocument，关闭/跟随全程零 apiSend——主阅读进度是会话的东西，
 *     这里没有一处写书架；
 *  ② **内部栈**：补充→补充在面板里跟（含返回），主序列目标一律转交 onNavigate；
 *  ③ **两把锁**：seq 挡「后点的脚注先返回时被旧请求覆盖」，alive 挡「卸载后到达的响应做任何事」。
 *     alive 的正面证据只有一半可观测（成功那头 React 18 静默丢弃 setState）——所以卸载后**失败**
 *     转瞬态层那条是它的可观测面，不是顺手加的礼貌：本仓「两个半场都不许静默」（同 ShelfView）。
 */

const bookKey = 'local:b1'
const text = (t: string): ContentNode => ({ kind: 'text', text: t })
const doc = (nodes: ContentNode[], documentId = 'd1'): ChapterContent => ({ kind: 'rich', documentId, nodes })
const para = (id: string, t: string): ContentNode => ({
  kind: 'element', id, tag: 'p', children: [text(t)],
  rowSpan: null, colSpan: null, start: null, value: null,
})
const linkTo = (id: string, target: SupplementTarget, label: string): ContentNode =>
  ({ kind: 'link', id, target: { ...target }, role: 'noteref', children: [text(label)] })

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const t1: SupplementTarget = { kind: 'supplement', documentId: 'd1', anchorId: null }

function panel(
  deps: ReaderDeps, target: SupplementTarget = t1, onNavigate = vi.fn(), onClose = vi.fn(), requestSeq = 1,
): ReactElement {
  return (
    <ReaderNotes bookKey={bookKey} target={target} requestSeq={requestSeq} deps={deps}
      onNavigate={onNavigate} onClose={onClose} />
  )
}

afterEach(cleanup)

describe('只读补充文档', () => {
  it('打开即取那一份补充文档（路径归 wire 构造器：id=bookKey + documentId）', async () => {
    const apiGet = vi.fn(async () => doc([para('p1', '脚注正文')]))
    const deps = makeReaderDeps({ apiGet })
    render(panel(deps))
    await waitFor(() => expect(screen.getByText('脚注正文')).toBeTruthy())
    expect(apiGet).toHaveBeenCalledTimes(1)
    expect(apiGet).toHaveBeenCalledWith('local/document?id=local%3Ab1&documentId=d1')
  })

  it('落位只滚面板自己：按锚点几何滚 .novel-notes-body，绝不借 scrollIntoView', async () => {
    // 几何由本用例给出（jsdom 无排版）：p1 在面板体中心之上、a2 在下方很远，于是「写入的那个数」
    // 本身就证明落位瞄准的是 a2。真布局与「主滚动没被改」由 tests/browser 那两条钉。
    const stub = stubLayout((el) => el.classList.contains('novel-notes-body') ? rect(0, 400)
      : el.getAttribute('data-novel-node') === 'a2' ? rect(900, 20)
        : el.getAttribute('data-novel-node') === 'p1' ? rect(-300, 20) : null)
    try {
      const deps = makeReaderDeps({ apiGet: vi.fn(async () => doc([para('p1', '前段'), para('a2', '锚点段')])) })
      render(panel(deps, { kind: 'supplement', documentId: 'd1', anchorId: 'a2' }))
      await waitFor(() => expect(screen.getByText('锚点段')).toBeTruthy())
      // 锚点中心 910 − 面板体中心 200 = 710；除面板自身之外不许有第二次滚动
      await waitFor(() => expect(stub.scrolls.map((w) => [w.el.className, w.to])).toEqual([['novel-notes-body', 710]]))
      expect(stub.into, 'scrollIntoView 会连可滚祖先一起滚——那正是「开面板改写主阅读位置」的根因').toEqual([])
    } finally {
      stub.restore()
    }
  })

  it('目标比面板还高：顶对齐，不把它的开头藏到视口上方', async () => {
    // 长脚注（一个容器装着好几段）居中在面板里，第一段就跑到视口上方——实测 3066px 的目标在
    // 771px 的面板里从 scrollTop 1144 开始。装不下时露头：目标顶边贴容器顶边。
    const stub = stubLayout((el) => el.classList.contains('novel-notes-body') ? rect(0, 400)
      : el.getAttribute('data-novel-node') === 'a2' ? rect(900, 3000) : null)
    try {
      const deps = makeReaderDeps({ apiGet: vi.fn(async () => doc([para('a2', '长脚注正文')])) })
      render(panel(deps, { kind: 'supplement', documentId: 'd1', anchorId: 'a2' }))
      await waitFor(() => expect(screen.getByText('长脚注正文')).toBeTruthy())
      await waitFor(() => expect(stub.scrolls.map((w) => [w.el.className, w.to])).toEqual([['novel-notes-body', 900]]))
    } finally {
      stub.restore()
    }
  })

  it('关闭只通知外层：全程零 apiSend（面板不写主阅读进度）', async () => {
    const onClose = vi.fn()
    const deps = makeReaderDeps({ apiGet: vi.fn(async () => doc([para('p1', '脚注正文')])) })
    render(panel(deps, t1, vi.fn(), onClose))
    await waitFor(() => expect(screen.getByText('脚注正文')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(deps.apiSend).not.toHaveBeenCalled()
  })
})

describe('内部栈：补充→补充与返回', () => {
  const d2: SupplementTarget = { kind: 'supplement', documentId: 'd2', anchorId: 'a7' }
  const docs: Record<string, ChapterContent> = {
    d1: doc([para('p1', '脚注正文'), linkTo('l1', d2, '跳到附录')], 'd1'),
    d2: doc([
      para('p2', '附录正文'),
      linkTo('l2', { kind: 'supplement', documentId: 'd1', anchorId: null }, '回脚注'),
    ], 'd2'),
  }
  const apiGetFor = (): ReturnType<typeof vi.fn> =>
    vi.fn(async (p: string) => docs[p.includes('documentId=d2') ? 'd2' : 'd1'])

  it('跟到附录再返回脚注：根层没有返回钮，跟过一层才有', async () => {
    const apiGet = apiGetFor()
    const deps = makeReaderDeps({ apiGet })
    render(panel(deps))
    await waitFor(() => expect(screen.getByText('脚注正文')).toBeTruthy())
    expect(screen.queryByRole('button', { name: /返回/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '跳到附录' }))
    await waitFor(() => expect(screen.getByText('附录正文')).toBeTruthy())
    expect(apiGet).toHaveBeenLastCalledWith(queries.localDocument({ id: bookKey, documentId: 'd2' }))
    expect(deps.apiSend).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /返回/ }))
    await waitFor(() => expect(screen.getByText('脚注正文')).toBeTruthy())
    expect(apiGet).toHaveBeenLastCalledWith(queries.localDocument({ id: bookKey, documentId: 'd1' }))
    expect(screen.queryByRole('button', { name: /返回/ })).toBeNull()
  })

  it('同一条脚注被再点一次（外层重新指向）：栈重置，不继续显示期间跟到的那一份', async () => {
    // 实测缺陷：打开 A → 面板内跟到附录 B → 再点正文里的 A。目标值没变（同一个脚注引用），
    // 只比「目标值有没有变」的实现在这里跳过重置 → 面板继续显示 B。按打开意图的序号判就不漏。
    const apiGet = apiGetFor()
    const deps = makeReaderDeps({ apiGet })
    function Reopen(): ReactNode {
      const [n, setN] = useState(0)
      return (
        <>
          <button onClick={() => setN((v) => v + 1)}>再点引用</button>
          <ReaderNotes bookKey={bookKey} target={t1} requestSeq={n} deps={deps} onNavigate={vi.fn()} onClose={vi.fn()} />
        </>
      )
    }
    render(<Reopen />)
    await waitFor(() => expect(screen.getByText('脚注正文')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '跳到附录' }))
    await waitFor(() => expect(screen.getByText('附录正文')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: '再点引用' }))
    await waitFor(() => expect(screen.getByText('脚注正文')).toBeTruthy())
    expect(screen.queryByText('附录正文')).toBeNull()
    expect(screen.queryByRole('button', { name: /返回/ }), '栈回到根层：跟过一层才有返回钮').toBeNull()
  })

  it('主序列目标转交 onNavigate：面板不取主序列文档、不换文档、不写进度', async () => {
    const onNavigate = vi.fn()
    const chapterTarget = { kind: 'chapter', index: 4, anchorId: 'x2' } as const
    const apiGet = vi.fn(async () => doc([
      para('p1', '脚注正文'),
      { kind: 'link', id: 'l1', target: chapterTarget, role: 'backlink', children: [text('回第四章')] },
    ]))
    const deps = makeReaderDeps({ apiGet })
    render(panel(deps, t1, onNavigate))
    await waitFor(() => expect(screen.getByText('脚注正文')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '回第四章' }))
    expect(onNavigate).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledWith(chapterTarget, 'backlink')   // 角色必须透传：返回栈按它决定压不压
    expect(apiGet).toHaveBeenCalledTimes(1)                 // 没有顺手去取主序列文档
    expect(deps.apiSend).not.toHaveBeenCalled()             // 跳主序列也不由面板写进度
    expect(screen.getByText('脚注正文')).toBeTruthy()        // 面板留在原地
  })
})

describe('乱序与卸载（两把锁）', () => {
  function Harness({ deps, first, next }: { deps: ReaderDeps; first: SupplementTarget; next: SupplementTarget }): ReactNode {
    const [t, setT] = useState(first)
    const [seq, setSeq] = useState(0)          // 外层每换一次指向就 +1（与 ReaderView 的打开意图序号同口径）
    return (
      <>
        <button onClick={() => { setT(next); setSeq((v) => v + 1) }}>换脚注</button>
        <ReaderNotes bookKey={bookKey} target={t} requestSeq={seq} deps={deps} onNavigate={vi.fn()} onClose={vi.fn()} />
      </>
    )
  }

  it('后点的脚注先返回时，旧请求不许覆盖新内容', async () => {
    const first = deferred<ChapterContent>()
    const second = deferred<ChapterContent>()
    const apiGet = vi.fn((p: string) => (p.includes('documentId=d2') ? second.promise : first.promise))
    const deps = makeReaderDeps({ apiGet })
    render(<Harness deps={deps} first={t1} next={{ kind: 'supplement', documentId: 'd2', anchorId: null }} />)
    expect(apiGet).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '换脚注' }))    // 第一条还在路上，用户点了第二条
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2))
    second.resolve(doc([para('p2', '第二条脚注')], 'd2'))
    await waitFor(() => expect(screen.getByText('第二条脚注')).toBeTruthy())

    first.resolve(doc([para('p1', '第一条脚注（迟到）')], 'd1'))
    await tick()
    expect(screen.getByText('第二条脚注')).toBeTruthy()
    expect(screen.queryByText('第一条脚注（迟到）')).toBeNull()
  })

  it('卸载后迟到的成功什么都不做（不冒充打开、不上瞬态层）', async () => {
    const d = deferred<ChapterContent>()
    // pushOk/pushError 都盖成假实现：缺省束的 pushOk 是生产真实现（写模块级瞬态 store）
    const deps = makeReaderDeps({ apiGet: vi.fn(() => d.promise), pushError: vi.fn(), pushOk: vi.fn() })
    const view = render(panel(deps))
    view.unmount()
    d.resolve(doc([para('p1', '迟到正文')]))
    await tick()
    expect(deps.pushError).not.toHaveBeenCalled()
    expect(deps.pushOk).not.toHaveBeenCalled()
    expect(screen.queryByText('迟到正文')).toBeNull()
  })

  it('卸载后迟到的失败不静默：转瞬态层（在场才就地重试）', async () => {
    const d = deferred<ChapterContent>()
    const deps = makeReaderDeps({ apiGet: vi.fn(() => d.promise) })
    const view = render(panel(deps))
    view.unmount()
    d.reject(new Error('脚注读取失败'))
    await tick()
    expect(deps.pushError).toHaveBeenCalledTimes(1)
    expect(String(deps.pushError.mock.calls[0][0])).toContain('脚注')
  })
})

describe('失败面（就地呈现 + 重试入口）', () => {
  it('失败留在面板里可重试，重试成功即显示正文（不上瞬态层）', async () => {
    const apiGet = vi.fn()
      .mockRejectedValueOnce(new Error('脚注读取失败'))
      .mockResolvedValueOnce(doc([para('p1', '脚注正文')]))
    const deps = makeReaderDeps({ apiGet })
    render(panel(deps))
    await waitFor(() => expect(screen.getByText(/脚注读取失败/)).toBeTruthy())
    expect(deps.pushError).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(screen.getByText('脚注正文')).toBeTruthy())
    expect(apiGet).toHaveBeenCalledTimes(2)
  })
})
