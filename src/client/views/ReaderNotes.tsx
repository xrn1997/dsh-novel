import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { queries } from '../../shared/wire.js'
import { describeError } from '../api.js'
import { useCopy, zhTranslate } from '../copy/index.js'
import type { Translate } from '../copy/index.js'
import type { ClientCoreDeps } from '../deps.js'
import { findNovelNode, centerInScroller } from '../util.js'
import { ChapterBody } from './ChapterBody.js'
import { ErrorBanner } from './bits.js'
import type { ChapterContent, LinkRole, ReadingTarget, SupplementTarget } from './types.js'

/**
 * 补充文档面板（脚注 / 附录）：只读 `localDocument`，只认 supplement 目标。面板自带浮层几何与
 * role=dialog；外层负责挂载、互斥与 Esc 关闭，关闭一律经 `onClose`——面板不自裁、不猜自己是第几层。
 *
 * 边界与两把锁：**不碰主阅读进度**（这里没有一处 apiSend；主序列目标转交 `onNavigate`，由会话跳章）；
 * **内部栈**（补充→补充继续跟，深度 > 1 才有「返回」；外层重新指向由 `requestSeq` 表达，栈按它重置）；
 * `seq` 让后点的脚注先返回时旧请求不覆盖新内容；`alive` 让卸载后到达的响应什么都不做——
 * 成功直接丢弃、失败转瞬态层（两个半场都不许静默）。
 */

type NotesState =
  | { phase: 'loading' }
  | { phase: 'ready'; content: ChapterContent }
  | { phase: 'error'; error: { code?: string; message: string } }

/** 失败载荷进 ErrorBanner：ApiClientError 的 code 带着；客户端网络错误按当前语言出话，服务端错误原文透传。 */
function asErrorLike(e: unknown, t: Translate = zhTranslate): { code?: string; message: string } {
  const message = describeError(e, t)
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code
    return typeof code === 'string' ? { code, message } : { message }
  }
  return { message }
}

/** 注释面板的依赖面：读一份文档 + 失败上报。不写进度、不观察任务，故不声明整个阅读区束。 */
type NotesDeps = Pick<ClientCoreDeps, 'apiGet' | 'pushError'>

export function ReaderNotes({ bookKey, target, requestSeq, deps, onNavigate, onClose, darkController = false }: {
  bookKey: string
  /** 用户点的那条脚注（supplement 分支）：面板打开即从它开始 */
  target: SupplementTarget
  /** 外层「重新指向」的次数（每次打开都 +1）：面板按它重置内部栈，见下方 effect */
  requestSeq: number
  deps: NotesDeps
  /** 面板里点到主序列目标：交外层导航（面板不自己跳、不写进度）。`role` 必须透传——外层要按它决定
   *  这条跳转是「从正文链接出发」（押返回项）还是「返回链接本身」（消费掉返回项）。 */
  onNavigate: (target: ReadingTarget, role: LinkRole) => void
  onClose: () => void
  darkController?: boolean
}): ReactNode {
  const t = useCopy()
  const [stack, setStack] = useState<SupplementTarget[]>(() => [target])
  const [state, setState] = useState<NotesState>({ phase: 'loading' })
  const [nonce, setNonce] = useState(0)                     // 重试：同一文档再取一次的显式触发
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const alive = useRef(true)
  const seq = useRef(0)
  // 栈永不为空（初值就是那个目标，`back` 只在长度大于 1 时裁）：栈顶缺席即等于「还停在开面板时那一条」
  const current = stack.at(-1) ?? target
  const docId = current.documentId

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  // 外层重新指向：栈重置为新目标。判据是**打开意图的序号**而不是目标值——同一个脚注被点第二次时
  // 目标值一模一样，而期间用户可能已在面板里跟到别的文档（只比目标值会漏掉重置）。
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
        if (!alive.current) { deps.pushError(t('reader.notesFailed', { detail: asErrorLike(e, t).message })); return }
        setState({ phase: 'error', error: asErrorLike(e, t) })
      },
    )
  }, [deps, bookKey, docId, nonce, t])

  // 落位：只滚面板自己的身体（借 scrollIntoView 会连主滚动一起拉走）；无锚点的新文档回到顶部。
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
    <div className={darkController ? 'novel-notes-slot novel-dark' : 'novel-notes-slot'}>
      <div className="novel-notes" role="dialog" aria-label={t('reader.notes')}>
        <div className="novel-toolbar novel-notes-head">
          {stack.length > 1 && <button type="button" className="novel-btn sm" onClick={back}>{t('reader.notesBack')}</button>}
          <span className="novel-notes-title">{t('reader.notes')}</span>
          <button type="button" className="novel-btn sm" onClick={onClose}>{t('common.close')}</button>
        </div>
        <div className="novel-notes-body" ref={bodyRef}>
          {state.phase === 'loading' && <div className="novel-muted novel-note-sm">{t('reader.notesLoading')}</div>}
          {state.phase === 'error' && <ErrorBanner error={state.error} onRetry={retry} />}
          {state.phase === 'ready' && <ChapterBody content={state.content} bookKey={bookKey} onNavigate={follow} />}
        </div>
      </div>
    </div>
  )
}
