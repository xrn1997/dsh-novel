/**
 * 听书范围的视图侧取数口：四格原语各订一次，拼进 `listen-scope.ts` 的纯函数一次算出。
 *
 * 为什么住单独模块：整店订阅会让每段推进 / 每档音量都重渲阅读器顶层，而 `useStoreValue`
 * 按引用比快照、不能新增对象型 selector；订阅这一半带上 React 与播放层单例，纯投影那一半
 * 因此保持零依赖——策略面（`follow-controller`）只 import 纯函数，不被拖进 UI 依赖。
 */
import { useStoreValue } from '../store.js'
import { listenScopeOf } from './listen-scope.js'
import type { ListenScope } from './listen-scope.js'
import { isPlayBusy } from './listen-readout.js'
import { ttsPlayer } from './player.js'

/** 本书当前的听书范围（`showing` / `busy` / 章段号）：视图唯一的取数口。 */
export function useListenScope(bookKey: string): ListenScope {
  // 活会话与它的书键今天在 listen-session 里同一次 state.set 成对变化，但契约上是**两格**
  // （`ListenScopeLive` 分开声明）：拿书键反推「有没有会话」会在书键未落的取数窗口里把
  // `active` 答成假，故两格各订各的，投影不替状态机猜耦合。
  const active = useStoreValue(ttsPlayer, (s) => s.active)
  const sessionBook = useStoreValue(ttsPlayer, (s) => s.bookKey)
  const playBusy = useStoreValue(ttsPlayer, isPlayBusy)
  const chapterIndex = useStoreValue(ttsPlayer, (s) => s.chapterIndex)
  const paragraphIndex = useStoreValue(ttsPlayer, (s) => s.paragraphIndex)
  return listenScopeOf({
    active,
    bookKey: sessionBook,
    chapterIndex,
    paragraphIndex,
    playBusy,
  }, bookKey)
}
