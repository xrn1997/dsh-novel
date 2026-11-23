# 听书合成有取消位：调用方不要的那一发，上游也要停

Status: accepted

`TtsService.synthesize` 收调用方的 `signal`；同缓存键的在途合成先并成一发（`coalescedProduce`），再把这一发的取消位逐跳下传：HTTP 支交给 fetcher 的取消位，宿主朗读服务支交给 `SpeechRequest.signal`；浏览器断连与播放层的停止 / 换参数 / 换章落整趟的取消位，跳段 / 章内滑杆只落当前段那一只（同章预取不受牵连）。取消是作废、不是上游失败——它不记连败、不写错误信封。

## 背景

本仓的长任务都有取消位（导出、搜索面、探针、抓取层），听书这条链此前一个都没有：`POST /tts/synthesize` 不挂 `res.on('close')`；`TtsService.synthesize` 的签名里没有 signal；宿主朗读服务支的死线只拒本地 Promise，服务那一侧的上游合成照旧跑完；播放层跳段 / 停止后，在途合成与整章预取继续把字节算完。后果是**用户按了停止，上游还在为没人听的内容计费**。

## 决定

1. **取消位沿合成链逐跳下传，同键在途先合流**：`synthesize(p, { signal })` 先把这一发交给合并槽（`coalescedProduce`）——同缓存键在途只发一发上游，每个调用方各持自己的取消位；`TtsSynthesisPlan.produce` 收到的是合并槽那一发的取消位，HTTP 支进 `Fetcher.fetchPage` 的 `init.signal` / cordis 支进 `SpeechRequest.signal`。每一跳之前先问一次（已取消就一个请求都不发）；只有最后一个等待方退场才中止上游，单方取消只摘自己那一票。
2. **路由层把断连接成取消**：`POST /tts/synthesize` 挂 `res.on('close')`；断连那一发的结果没人读，错误信封无处可写，也不进日志：作废不是故障。
3. **死线连带中止服务**：适配器的守卫改成一个 `AbortController`：调用方的取消与本支死线汇成一条信号递进去。取消这条腿不依赖服务配合。
4. **播放层两只控制器 + 下一章预取一只**：停止 / 复位 / 换参数 / 换章换整趟那一只（同章预取链挂在它上面）；跳段 / 章内滑杆只换当前段那只——没人再听的是这一段，同章预取不能连坐；下一章预取另持一只，进目标章时可整份交接（`ADR-0102`）。暂停不在其列：续播要接的正是那一发。
5. **取消不是失败**：播放层的失败径前先看取消位——自撤落进 `segmentFailed` 会把「用户拖了一下滑杆」记成引擎连败。合成面同理：取消时抛调用方的 `reason`，不包成 `TTS_UPSTREAM`。
6. **理由的类型纪律**：`AbortSignal.reason` 是 `any`，而拒绝理由只认 `Error`——是 Error 原样交回，不是也包成 Error；两支共用 `services/tts-cancel.ts` 的 `abortReasonOf`。

## 边界

- 不做播放端重试：取消是调用方的意图，自动重发等于把「我不要了」改写成「再来一次」。
- 不改连败与跳段的既有语义；不做服务端任务队列。
- 宿主死线与出站超时是两把尺：cordis 支自己给耐心（`CORDIS_SYNTHESIS_TIMEOUT_MS`），HTTP 支归 fetcher。

## 被否方案

- 只在路由层取消、不下传引擎：播放层的跳段 / 停止根本不会断连，最常见的浪费恰好漏掉。
- 把调用方的 signal 直接塞进共享 promise（先取消者作废整发）：同一段被两个读者等时会连累另一个。合并槽改为按等待方计数——取消只摘自己那一票，最后一票退场才动上游。
- 取消也走错误信封：断连后没有读者，往已关闭的响应写只会抛 `WriteAfterEnd`。
- 暂停也 abort：续播要靠那一发已经拿到的回执，掐掉等于每次暂停都重新合成当前段。

## 后果

- `NormalizedSpeechSynthesis.synthesize` 多收 `opts.signal`；`TtsSynthesisPlan.produce` 的签名多带 `signal`。
- 路由层多一个 `AbortController` 与一次 `res.off('close', …)`。
- `PlayerRun` 两枚控制器（`abort` 整趟、`segAbort` 当前段）；主播放径给 `segAbort`，同章预取给 `abort`，下一章预取给 `nextChapter.abort`（交接时接任 `run.abort`，`ADR-0102`）。
- 抓取层的「取消优先于超时」现在是听书链的实际行为。

锚点：`src/services/tts.ts` 的 `TtsService.synthesize` / `coalescedProduce` / `InFlightSynthesis` / `TtsSynthesisPlan.produce` / `fetchHttp` / `synthesizeCordis`；`src/services/tts-cancel.ts` 的 `abortReasonOf`；`src/services/tts-cordis.ts` 的 `guardSynthesis`；`src/services/reading.ts` 的 `ttsSynthesize`；`src/api/dispatch.ts` 的 `ttsSynthesize` 臂；`src/client/tts/listen-session.ts` 的 `PlayerRun.abort` / `PlayerRun.segAbort` / `cancelInFlight` / `cancelCurrentSegment` / `seekParagraph` / `receiptFor` / `NextChapterPrefetch` / `prefetchNextChapter` / `moveChapter` / `stillHereGuard`；`src/client/tts/player.ts` 的 `synthesize`；`src/client/api.ts` 的 `apiSend`；`tests/services/tts.test.ts`；`tests/services/tts-cordis.test.ts`；`tests/api/tts-routes.test.ts`；`tests/client/tts-session.test.ts`；`docs/architecture.md` §4；`ADR-0077`；`ADR-0102`。
