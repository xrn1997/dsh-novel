import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type ReactNode,
} from 'react'
import { useCopy } from '../copy/index.js'
import { closeMoyu, moyuStore } from '../moyu-store.js'
import { useStoreValue } from '../store.js'
import {
  MOYU_TICK_CHARS, MOYU_TICK_MS, actionMarkFor, chapterFileName, isMainLine, isPinnedToTail,
  nextPhase, projectLines, type MoyuParagraph, type MoyuPhase,
} from '../moyu-stream.js'
import { MOYU_CSS } from '../styles/moyu.js'
import { displayChapterTitle } from '../util.js'
import { chapterContentLines } from '../../shared/chapter-text.js'
import type { ReaderSession } from '../reader-session.js'
import { useDialogContract } from './dialog.js'

/** 最近滚动祖先：阅读器所在的宿主面板滚动端口；找不到（异常宿主）返回 null。 */
function nearestScrollport(el: HTMLElement): HTMLElement | null {
  let p: HTMLElement | null = el.parentElement
  while (p !== null) {
    const oy = window.getComputedStyle(p).overflowY
    if (oy === 'auto' || oy === 'scroll') return p
    p = p.parentElement
  }
  return null
}

/**
 * 摸鱼舞台：阅读器里无条件挂载、传 session 与书名（书名缺席时侧栏不显示根目录行）；
 * 在不在场由 moyu-store 决定。在场即挂载 MoyuLive——入场焦点、tick、键盘层全部
 * 随卸载收干净，Esc 走模态契约。
 */
export function MoyuStage({ session, title }: { session: ReaderSession; title?: string | undefined }): ReactNode {
  const on = useStoreValue(moyuStore, (s) => s.on)
  if (!on) return null
  return <MoyuLive session={session} title={title} />
}

/** 一章 = 一轮消息（已深度思考 + 读取文件 + 正文 + 完成行）。 */
interface TurnEntry {
  readonly key: number
  readonly title: string
  readonly file: string
  readonly parts: MoyuParagraph[]
  readonly live: boolean
  readonly done: boolean
  readonly count: number
}

/**
 * 流现场：固定拍速揭示 + 行型分层渲染 + 右侧章文件侧栏。滚动权全在用户——
 * 不自动贴尾、不自动连播，只有用户主动跳章（侧栏 / 翻页行）后一次性回底；
 * 章尾出「上一章 / 下一章」翻页行，边界置灰。
 */
function MoyuLive({ session, title }: { session: ReaderSession; title?: string | undefined }): ReactNode {
  const t = useCopy()
  const st = useSyncExternalStore(session.subscribe, () => session.state, () => session.state)
  const { toc, chapters, currentChapter, error } = st
  const [revealed, setRevealed] = useState(0)
  const [phase, setPhase] = useState<MoyuPhase>('streaming')
  const [pinned, setPinned] = useState(true)
  const [seenMax, setSeenMax] = useState(currentChapter)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const sideRef = useRef<HTMLDivElement | null>(null)
  const tailWantedRef = useRef(false)

  useDialogContract({ panelRef, onClose: closeMoyu })

  const content = chapters[currentChapter] ?? null
  const lines = useMemo(
    () => content === null ? [] : chapterContentLines(content).map((l) => l.text),
    [content])
  const total = useMemo(() => lines.reduce((n, s) => n + Array.from(s).length, 0), [lines])
  const isLast = toc === null || currentChapter + 1 >= toc.length

  // 换章即归零重播；相位随后由推进 effect 重判——空章保持 streaming，停在加载态。
  useEffect(() => {
    setRevealed(0)
    setPhase('streaming')
  }, [currentChapter])

  useEffect(() => {
    setPhase(nextPhase(revealed, total, isLast))
  }, [revealed, total, isLast])

  // 本会话到过的最远章只进不退：侧栏「已修改」点的判定源。
  useEffect(() => {
    setSeenMax((m) => Math.max(m, currentChapter))
  }, [currentChapter])

  // 揭示步进：章未到 / 已收尾时静止；固定拍速，不分档。
  useEffect(() => {
    if (phase !== 'streaming' || content === null || total === 0) return
    const id = setInterval(() => { setRevealed((r) => Math.min(r + MOYU_TICK_CHARS, total)) }, MOYU_TICK_MS)
    return () => clearInterval(id)
  }, [phase, content, total])

  // 与阅读器同款预取：当前章到货就预热下一章，章间不断流。
  useEffect(() => {
    if (toc === null || content === null) return
    if (currentChapter + 1 < toc.length) session.prefetchChapter(currentChapter + 1)
  }, [toc, content, currentChapter, session])

  // 跳章后一次性回底：只有用户主动跳章（jumpTo）置旗；章正文到货即压到底并清旗。
  // 之后不再自动跟随——揭示前进时转录停在原处，滚动权全在用户手里。
  useEffect(() => {
    if (!tailWantedRef.current || content === null) return
    tailWantedRef.current = false
    const el = scrollerRef.current
    if (el !== null) {
      el.scrollTop = el.scrollHeight
      setPinned(true)
    }
  }, [currentChapter, content])

  // 揭示只长内容不动滚动：开场视角在转录顶部时，正文很快长出视口下沿，
  // 而滚动事件从未发生，pinned 停留在开场时的 true——「回到底部」浮钮
  // 在最需要它（离尾几千 px）时反而不出现。每个揭示步提交后按几何重判一次；
  // 已压底时重判仍为 true（setState 同值无渲染），跳章压底与手工滚动不受影响。
  useEffect(() => {
    const el = scrollerRef.current
    if (el !== null) setPinned(isPinnedToTail(el))
  }, [content, revealed])

  const onScroll = useCallback(() => {
    const el = scrollerRef.current
    if (el !== null) setPinned(isPinnedToTail(el))
  }, [])

  const toTail = useCallback(() => {
    const el = scrollerRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
    setPinned(true)
  }, [])

  const jumpTo = useCallback((index: number) => {
    if (toc === null || index === currentChapter || index < 0 || index >= toc.length) return
    tailWantedRef.current = true
    session.requestJump(index)
  }, [toc, currentChapter, session])

  // 覆盖层几何：sticky 兜底救不了开场视野——根的流内位置排在整卷正文之后，
  // 常规阅读位置下它在视口下方几千 px，点开即「看不见」。这里量最近滚动祖先
  // 的视口矩形，把根升级为 fixed 盖住当前可见切片：与外层滚动完全解耦，
  // 不动阅读器滚动、不污染阅读进度，退出后阅读器原位如初。量不到滚动祖先
  // 时留在 CSS 的 sticky 兜底上。侧栏开合 / 窗口缩放都会改滚动口，用
  // ResizeObserver + resize 重测；jsdom 无 ResizeObserver，typeof 守卫跳过。
  const applyViewportGeometry = useCallback(() => {
    const el = panelRef.current
    if (el === null) return
    const port = nearestScrollport(el)
    if (port === null) return
    const r = port.getBoundingClientRect()
    el.style.position = 'fixed'
    el.style.left = `${r.left}px`
    el.style.top = `${r.top}px`
    el.style.width = `${r.width}px`
    el.style.height = `${r.height}px`
  }, [])

  useLayoutEffect(() => {
    const el = panelRef.current
    applyViewportGeometry()
    const port = el !== null ? nearestScrollport(el) : null
    let ro: ResizeObserver | null = null
    if (port !== null && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(applyViewportGeometry)
      ro.observe(port)
    }
    window.addEventListener('resize', applyViewportGeometry)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', applyViewportGeometry)
    }
  }, [applyViewportGeometry])

  // 已载章即一轮消息：历史章全量展开，当前章按揭示进度截断。
  const entries = useMemo(() => {
    if (toc === null) return []
    const out: TurnEntry[] = []
    for (let i = 0; i <= currentChapter; i++) {
      const c = chapters[i] ?? null
      if (c === null) continue
      const ls = chapterContentLines(c).map((l) => l.text)
      const live = i === currentChapter && phase === 'streaming'
      out.push({
        key: i,
        title: displayChapterTitle(toc[i]?.name ?? '', i, t),
        file: chapterFileName(i, toc[i]?.name ?? ''),
        parts: i === currentChapter ? projectLines(ls, revealed) : projectLines(ls, Number.MAX_SAFE_INTEGER),
        live,
        done: i !== currentChapter || phase !== 'streaming',
        count: ls.reduce((n, s) => n + Array.from(s).length, 0),
      })
    }
    return out
  }, [toc, chapters, currentChapter, revealed, phase, t])

  // 侧栏文件清单与整棵侧栏子树都单独记忆化：揭示 tick 只重算转录列，
  // 不带着几百行文件清单重渲染。
  const files = useMemo(() => {
    if (toc === null) return []
    const out: Array<{ index: number; name: string }> = []
    for (let i = 0; i < toc.length; i++) {
      out.push({ index: i, name: chapterFileName(i, toc[i]?.name ?? '') })
    }
    return out
  }, [toc])

  const side = useMemo(() => {
    if (toc === null) return null
    return (
      <div ref={sideRef} className="novel-moyu-side" role="navigation" aria-label={t('reader.moyu.explorer')}>
        <div className="novel-moyu-side-head">{t('reader.moyu.explorer')}</div>
        {title !== undefined && (
          <div className="novel-moyu-side-folder">
            <span className="novel-moyu-side-twisty" aria-hidden="true">▾</span>
            <span className="novel-moyu-side-folder-name">{title}</span>
          </div>
        )}
        <div className="novel-moyu-side-file novel-moyu-side-file--static">{t('reader.moyu.readme')}</div>
        {files.map((f) => (
          <button key={f.index} type="button" className="novel-moyu-side-file"
            aria-current={f.index === currentChapter ? 'true' : undefined}
            data-done={f.index <= seenMax ? '' : undefined}
            title={f.name}
            onClick={() => { jumpTo(f.index) }}>
            {f.name}
          </button>
        ))}
      </div>
    )
  }, [toc, files, currentChapter, seenMax, t, title, jumpTo])

  // 当前章文件滚进侧栏视野（居中定位）：只动侧栏自己的 scrollTop——
  // scrollIntoView 会连着滚外层阅读器，污染阅读位置；侧栏 position:relative
  // 保证了 offsetTop 以它为基准。
  useEffect(() => {
    const box = sideRef.current
    if (box === null) return
    const active = box.querySelector<HTMLElement>("[aria-current='true']")
    if (active === null) return
    box.scrollTop = Math.max(0, active.offsetTop - box.clientHeight / 2)
  }, [currentChapter, side])

  const runningText = error !== null
    ? t('reader.moyu.error', { detail: error.message ?? '' })
    : content === null
      ? t('reader.moyu.loading')
      : phase === 'end'
        ? t('reader.moyu.finished')
        : phase === 'chapter-done' ? null : t('reader.moyu.thinking')

  const showSpin = error === null && (content === null || phase === 'streaming')

  return (
    <div ref={panelRef} className="novel-moyu-root" role="dialog" aria-modal="true"
      aria-label={t('reader.moyu.open')}>
      <style>{MOYU_CSS}</style>
      <div className="novel-moyu-main">
        {/* 入场焦点落在滚动容器上：模态契约缺省会聚焦面板内第一颗按钮（底部浮钮），
            把初始焦点让给浮钮不如给转录区——方向键/PgUp 立即可滚转录；
            tabIndex=-1 不进 Tab 圈。 */}
        <div ref={scrollerRef} className="novel-moyu-scroll" onScroll={onScroll}
          data-dialog-initial="" tabIndex={-1}>
          <div className="novel-moyu-col">
            {entries.map((e) => (
              <div key={e.key} className="novel-moyu-turn">
                <div className="novel-moyu-think">
                  <span className="novel-moyu-think-icon" aria-hidden="true">
                    <svg viewBox="0 0 16 16">
                      <path d="M2.5 3.5h11a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-5.5l-3 2.5v-2.5h-2.5a1 1 0 0 1-1-1v-5.5a1 1 0 0 1 1-1z" />
                      <path d="M5.5 7h.01M8 7h.01M10.5 7h.01" />
                    </svg>
                  </span>
                  <span className="novel-moyu-think-title">{t('reader.moyu.thought')}</span>
                  <span className="novel-moyu-think-sep" aria-hidden="true" />
                  <span className="novel-moyu-think-summary" data-streaming={e.live || undefined}>{e.title}</span>
                </div>
                <div className="novel-moyu-tool">
                  <span className="novel-moyu-tool-glyph" aria-hidden="true">⚙</span>
                  <span className="novel-moyu-tool-text">{t('reader.moyu.readFile', { file: e.file })}</span>
                </div>
                <div className="novel-moyu-body">
                  {e.parts.map((p, i) => {
                    const live = e.live && i === e.parts.length - 1
                    // 节奏规则（辉哥哥拍板）：每 4 行第 1 行 = 正常文字（内容字号、主色、无标记）；
                    // 其余 3 行 = 小字浅色 + 动作标记（运行命令 / 思考 / 读取 / 编辑，确定性轮换）。
                    const base = isMainLine(i) ? 'novel-moyu-p' : 'novel-moyu-p novel-moyu-p--small'
                    return (
                      <p key={i} className={live ? `${base} novel-moyu-live` : base}>
                        {isMainLine(i) ? null : (
                          <span className="novel-moyu-mark" aria-hidden="true">{actionMarkFor(i)}</span>
                        )}
                        {p.text}
                      </p>
                    )
                  })}
                </div>
                {e.done && (
                  <div className="novel-moyu-done">
                    <span aria-hidden="true">✓</span>
                    <span>{t('reader.moyu.doneLine', { n: e.count })}</span>
                  </div>
                )}
              </div>
            ))}
            {runningText !== null && (
              <div className="novel-moyu-running" role={error !== null ? 'alert' : undefined}>
                {showSpin && <span className="novel-moyu-spin" aria-hidden="true" />}
                <span className={error !== null ? 'novel-moyu-err' : undefined}>{runningText}</span>
                {error !== null && (
                  <button className="novel-moyu-fab" onClick={() => { session.retry() }}>
                    {t('reader.moyu.retry')}
                  </button>
                )}
              </div>
            )}
            {content !== null && phase !== 'streaming' && (
              <div className="novel-moyu-nav">
                <button type="button" className="novel-moyu-fab" disabled={currentChapter <= 0}
                  onClick={() => { jumpTo(currentChapter - 1) }}>
                  {t('reader.moyu.prev')}
                </button>
                <button type="button" className="novel-moyu-fab" disabled={isLast}
                  onClick={() => { jumpTo(currentChapter + 1) }}>
                  {t('reader.moyu.next')}
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="novel-moyu-fabs">
          {!pinned && (
            <button className="novel-moyu-fab" onClick={toTail}>{t('reader.moyu.toBottom')}</button>
          )}
          <button className="novel-moyu-fab" onClick={closeMoyu}>{t('reader.moyu.exit')}</button>
        </div>
      </div>
      {side}
    </div>
  )
}
