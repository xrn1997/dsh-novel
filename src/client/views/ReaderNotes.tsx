import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { queries } from '../../shared/wire.js'
import type { ReaderDeps } from '../deps.js'
import { findNovelNode, centerInScroller } from '../util.js'
import { ChapterBody } from './ChapterBody.js'
import { ErrorBanner } from './bits.js'
import type { ChapterContent, LinkRole, ReadingTarget } from './types.js'

/**
 * 补充文档面板（脚注 / 附录）：只读 `localDocument`，只认 supplement 目标。
 * 面板自带浮层几何与 role=dialog（见 styles 的 .novel-notes）：外层只负责挂载、互斥与 Esc 关闭，
 * 关闭一律经 `onClose`——面板不自裁，也不猜自己是第几层浮层。
 *
 * 边界与两把锁：
 *  - **不碰主阅读进度**：这里没有一处 apiSend。关闭只通知外层（`onClose`）；遇到主序列目标
 *    转交 `onNavigate`，由会话去跳章——面板自己跳就等于绕过会话的在途槽与返回栈。
 *  - **内部栈**：补充→补充在面板里继续跟（栈深度 > 1 才有「返回」）。主序列内的脚注不走这里。
 *    外层每次重新指向都由 `requestSeq` 表达，栈按它重置（只比目标值会漏掉「同一条被再点一次」）。
 *  - `seq`（请求代号）：后点的脚注先返回时，先发出的请求一律不许覆盖新内容；
 *  - `alive`（在场闸）：卸载后到达的响应什么都不做——成功直接丢弃（React 18 的 setState 在
 *    卸载后本就静默，这条钉的是「不做任何外部动作」），失败转瞬态层（本仓口径：两个半场都不许静默，
 *    与 ShelfView 的异步导入同款）。
 */

/** 注释面板的入参目标（supplement 分支）：主序列目标在类型上就进不来 */
export type SupplementTarget = Extract<ReadingTarget, { kind: 'supplement' }>

type NotesState =
  | { phase: 'loading' }
  | { phase: 'ready'; content: ChapterContent }
  | { phase: 'error'; error: { code?: string; message: string } }

/** 失败载荷进 ErrorBanner：ApiClientError 的 code 带着（有 code 就显 code），其他异常按普通错误 */
function asErrorLike(e: unknown): { code?: string; message: string } {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code
    return typeof code === 'string' ? { code, message: e.message } : { message: e.message }
  }
  return { message: String(e) }
}

export function ReaderNotes({ bookKey, target, requestSeq, deps, onNavigate, onClose }: {
  bookKey: string
  /** 用户点的那条脚注（supplement 分支）：面板打开即从它开始 */
  target: SupplementTarget
  /** 外层「重新指向」的次数（每次打开都 +1）：面板按它重置内部栈，见下方 effect */
  requestSeq: number
  deps: ReaderDeps
  /** 面板里点到主序列目标：交外层导航（面板不自己跳、不写进度）。
   *  `role` 必须透传：外层要按它决定这条跳转是「从正文链接出发」（押返回项）还是
   *  「返回链接本身」（消费掉返回项）——面板丢掉的正是这个判据。 */
  onNavigate: (target: ReadingTarget, role: LinkRole) => void
  onClose: () => void
}): ReactNode {
  const [stack, setStack] = useState<SupplementTarget[]>(() => [target])
  const [state, setState] = useState<NotesState>({ phase: 'loading' })
  const [nonce, setNonce] = useState(0)                     // 重试：同一文档再取一次的显式触发
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const alive = useRef(true)
  const seq = useRef(0)
  const current = stack[stack.length - 1]
  const docId = current.documentId

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // 外层重新指向（正文里换了引用、或又把读者送回同一条脚注）：栈重置为新目标，不续上一次的浏览历史。
  // 判据是**打开意图的序号**而不是目标值：同一个脚注被点第二次时目标值一模一样（`lastTargetKey`
  // 那种比法会跳过重置），而期间用户可能已经在面板里跟到了别的文档——实测「打开 A → 面板内跟到 B →
  // 再点正文里的 A」会让面板继续显示 B。序号一变就重置，「同一条被再点一次」与「换了一条」同一种处理。
  useEffect(() => {
    setStack([target])
  }, [requestSeq, target])

  // 取正文：只在**文档**变化时请求（同文档换锚点不重打）；路径归 wire 构造器
  useEffect(() => {
    const my = ++seq.current
    setState({ phase: 'loading' })
    void deps.apiGet<ChapterContent>(queries.localDocument({ id: bookKey, documentId: docId })).then(
      (content) => {
        if (!alive.current || my !== seq.current) return
        setState({ phase: 'ready', content })
      },
      (e: unknown) => {
        if (my !== seq.current) return                       // 已被更晚的请求接管：这条永远闭嘴
        if (!alive.current) { deps.pushError(`注释读取失败：${asErrorLike(e).message}`); return }
        setState({ phase: 'error', error: asErrorLike(e) })
      },
    )
  }, [deps, bookKey, docId, nonce])

  // 落位：只滚面板自己的身体（`centerInScroller` 的口径与理由见 util.ts——借 scrollIntoView 会连
  // 主滚动一起拉走，那是实测过的缺陷）。无锚点的新文档回到顶部，免得停在上一条内容的中段。
  useEffect(() => {
    if (state.phase !== 'ready') return
    const root = bodyRef.current
    if (root === null) return
    const anchor = findNovelNode(root, current.anchorId)
    if (anchor === null) { root.scrollTop = 0; return }
    centerInScroller(root, anchor)
  }, [state, current.anchorId])

  const follow = (t: ReadingTarget, role: LinkRole): void => {
    if (t.kind === 'supplement') { setStack((s) => [...s, t]); return }
    onNavigate(t, role)
  }
  const back = (): void => { setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)) }
  const retry = (): void => { setNonce((n) => n + 1) }

  return (
    <div className="novel-notes-slot">
      <div className="novel-notes" role="dialog" aria-label="注释">
        <div className="novel-toolbar novel-notes-head">
          {stack.length > 1 && <button type="button" className="novel-btn sm" onClick={back}>‹ 返回</button>}
          <span className="novel-notes-title">注释</span>
          <button type="button" className="novel-btn sm" onClick={onClose}>关闭</button>
        </div>
        <div className="novel-notes-body" ref={bodyRef}>
          {state.phase === 'loading' && <div className="novel-muted novel-note-sm">注释加载中…</div>}
          {state.phase === 'error' && <ErrorBanner error={state.error} onRetry={retry} />}
          {state.phase === 'ready' && <ChapterBody content={state.content} bookKey={bookKey} onNavigate={follow} />}
        </div>
      </div>
    </div>
  )
}
