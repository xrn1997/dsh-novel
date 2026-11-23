# 下一章预取持独立取消位，进目标章时整份交接给新章

Status: accepted

章末预取下一章开头几段，本来就是为了「马上要进这一章」；旧实现却把这条链挂在整趟取消位上，换章先整趟作废，预取成果在真正要用它的那一刻被扔掉。决定：**下一章预取另持一只取消位，进目标章时把正文、回执与在途合成原样交给新章，并让它接任整趟取消位**；只有章号、参数、正文与取消状态全部对上才交接。

## 背景

章末预取原先与同章预取共用 `PlayerRun.abort`，换章入口 `cancelInFlight` 把整趟在途合成一并作废。于是跨章那一瞬：已就绪的回执被清掉、在途的第二段被掐断、新章正文还要再取一次——真正无缝的路径反而在章界多一次正文请求、一次首段合成与一次可听见的停顿。预取又是 fire-and-forget：用户跳去别的章、换参数或停止时必须能整体取消，所以不能简单改成「不可取消」。

## 决定

1. **独立承载与独立取消位**：下一章预取住 `NextChapterPrefetch`（`abort` 控制器 + `units` / `receipts` / `inFlight` / `prefetched`），不写 `run.receipts`；除 `keepNextChapter` 明确的换章入口外，`cancelInFlight` 一律 `cancelNextChapter`。
2. **交接判据**：`moveChapter` 进目标章时，只有章号一致、`paramsKey`（引擎 / 音色 / 语速）一致、取消位未作废、预取已取到正文且 `sameUnits(预取正文, 本次取到的正文)` 为真，才把回执、在途合成与已预取段号交给新章，并把预取控制器接任 `run.abort`；任一不满足就 abort 候选、按新章重取。
3. **正文以本次读数为准**：交接不拿预取正文顶替章正文；`fetchUnits` 仍是章正文的唯一来源，预取正文只用于「还是不是同一章正文」的验身。
4. **预载槽跟着交接**：目标段已有同参回执时保留出声预载槽，否则作废重挂（`syncNextAudioPreload` / `dropPreload`）。
5. **交接后仍可取消**：接任的控制器随下一次 `cancelInFlight` 作废；停止 / 换参数 / 跳往他章与普通预取同一路径。
6. **交接后交回同章窗口节制**：旧预取的串行暖缓存循环退出，后续段按同章自适应窗口交给 `pumpPrefetch`，不重复合成。

## 边界

- 预取只暖下一章开头 `prefetchParagraphs` 段（0 = 不发）；同章自适应预取、出声槽预载与 `prefetchParagraphs` 的档位语义不归这篇，住 `docs/architecture.md` §4 的听书行。
- 不预取更远的章，也不建跨章双向窗口；往回翻章仍按普通换章取消并重取。
- 交接不改变播放层「两只控制器」的对外语义：`segAbort` 仍是当前段自己的取消位，`run.abort` 仍是整趟的（只是交接时换成预取那一只）。

## 被否方案

- **进章即取消旧预取、按需重合成（旧行为）**：跨章必然多一次正文重取与首段合成，预取在最后一刻变成无用功——正是本篇要解决的问题。
- **让下一章预取直接写 `run.receipts`**：跨章段号会串，新章第 0 段读到旧章同号回执就会念错章；必须先独立承载、经判据交接。
- **只按章号交接，不做正文一致性判据**：源侧章节改版、分页漂移后旧回执可能落在别的文本上；正文一致是唯一的验身判据。
- **把预取链永久挂在 `run.abort` 上、用「跨章不 cancel」代替交接**：跳走 / 换参数时就无法只作废下一章预取，回执也没有一个独立的落点。

## 后果

- 播放层状态多一层「下一章预取现场」，生命周期终点并入 `cancelInFlight` / `cancelNextChapter`；`run.abort` 可以来自两处，读取消位的代码要按控制器而不是按创建点理解。
- 跨章衔接少一次正文重取与首段重合成；代价是预取的取消与交接两条径必须各自有用例，正文一致性判据失守就会念错章。
- 守护落在 `tests/client/tts-session.test.ts` 的跨章交接、正文不一致拒绝、预取失败退避与 0 档作废用例上。

锚点：`src/client/tts/listen-session.ts` 的 `NextChapterPrefetch` / `prefetchNextChapter` / `moveChapter` / `cancelNextChapter` / `syncNextAudioPreload` / `stillHereGuard`；`tests/client/tts-session.test.ts`；`ADR-0082`；`docs/architecture.md` §4。