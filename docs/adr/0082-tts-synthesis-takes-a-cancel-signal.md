# 听书合成有取消位：调用方不要的那一发，上游也要停

Status: accepted

`TtsService.synthesize` 收调用方的 `signal` 并逐跳下传：HTTP 支交给 fetcher 的取消位，宿主朗读服务支交给 `SpeechRequest.signal`；浏览器断连与播放层的停止 / 换参数 / 换章落整趟的取消位，跳段 / 章内滑杆只落当前段那一只（同章预取不受牵连）。取消是作废、不是上游失败——它不记连败、不写错误信封。

## 背景

本仓的长任务都有取消位：导出把浏览器关页接成 `AbortController`、搜索面与探针收工具面的 `exec.signal`、抓取层区分「取消 vs 超时」。听书这条链此前一个都没有：

- `POST /tts/synthesize` 不挂 `res.on('close')`，浏览器走了服务端照跑；
- `TtsService.synthesize` 的签名里没有 signal，抓取层那已有的取消位没人递；
- 宿主朗读服务支的 15 秒死线只拒本地 Promise，服务那一侧的上游合成照旧跑完——契约明写 `signal` 是宿主的取消入口；
- 播放层跳段 / 停止后，在途的合成与整章预取继续把字节算完。

后果是实打实的：**用户按了停止，上游还在为没人听的内容计费**。这不是性能问题，是「取消」这件事在本仓只兑现了一半。

## 决定

1. **取消位沿合成链逐跳下传**：`TtsService.synthesize(p, { signal })` → `TtsSynthesisPlan.produce(signal)` → HTTP 支进 `Fetcher.fetchPage` 的 `init.signal` / cordis 支进 `SpeechRequest.signal`。每一跳之前先问一次（已取消就一个请求都不发——合成有副作用，取消了还发等于说谎）。
2. **路由层把断连接成取消**：`POST /tts/synthesize` 挂 `res.on('close')`（与导出那条同一行先例）。断连那一发的结果没人读，错误信封无处可写，也不进日志：作废不是故障。
3. **死线连带中止服务**：适配器的守卫不再是「本地不等了」，而是一只 `AbortController`：调用方的取消与本支死线汇成一条信号递进去，两条腿任一先到都让服务那一侧收到取消。取消这条腿不依赖服务配合——认 `signal` 的服务自己终止上游，不认的也不会把播放层吊到死线为止。
4. **播放层两只控制器：整趟一只、当前段一只**：停止 / 复位 / 换参数 / 换章换整趟那一只（预取链挂在它上面）；跳段 / 章内滑杆只换当前段那只——没人再听的是这一段，同章预取暖的是接下来还要放的段，不能连坐。换一只是因为落定的 signal 回不来。暂停**不在其列**：续播要接的正是那一发，掐掉它等于把「暂停一下」变成「整段重合成」。
5. **取消不是失败**：播放层的失败径前先看取消位——自撤（换参数的重取、跳段、停止）落进 `segmentFailed` 会把「用户拖了一下滑杆」记成引擎连败，攒够阈值还会暂停播放。合成面同理：取消时抛调用方的 `reason`，不包成 `TTS_UPSTREAM`。
6. **理由的类型纪律**：`AbortSignal.reason` 是 `any`，而 Promise 拒绝理由与本仓「原话借来看」只认 `Error`——是 Error 就原样交回，不是也包成 Error。两支合成共用 `services/tts-cancel.ts` 的 `abortReasonOf` 这一个出口，不各自再包一次。

## 边界

- **不做播放端重试**：取消是调用方的意图，自动重发等于把「我不要了」改写成「再来一次」。
- **不改连败与跳段的既有语义**：单段失败仍只跳过，阈值仍只暂停；这篇只把「作废」从失败里摘出去（`ADR-0070` / 现有失败径不变）。
- **不做服务端任务队列**：合成仍是请求内的同步等待，取消只是让上游早点停（`ADR-0072` 的会话归浏览器不变）。
- **宿主死线与出站超时是两把尺**：cordis 支没有出站请求、耐心只能自己给（`CORDIS_SYNTHESIS_TIMEOUT_MS`）；HTTP 支的耐心归 fetcher 的请求超时。这篇不合并两者。

## 被否方案

- **只在路由层取消、不下传引擎**：浏览器断连能停，但播放层跳段 / 停止 / 换参数发生在客户端内部，根本不会断连——最常见的浪费恰好漏掉。
- **把 signal 塞进共享 promise**：同一段被两个读者等时会连累另一个，工具面早有一条同样形状的裁决（「不把 signal 塞进共享 promise」）。
- **取消也走错误信封**：断连后没有读者，往已关闭的响应写信封只会抛 `WriteAfterEnd`；而且作废是预期路径，不该按故障留痕。
- **暂停也 abort**：续播要靠那一发已经拿到的回执，掐掉它等于每次暂停都重新合成当前段。

## 后果

- `NormalizedSpeechSynthesis.synthesize` 多收 `opts.signal`；`TtsSynthesisPlan.produce` 的签名多带 `signal`（两支都得接）。
- 路由层多一个 `AbortController` 与一次 `res.off('close', …)`（判据只在自己的那一条路径上）。
- `PlayerRun` 多两枚控制器（`abort` 整趟、`segAbort` 当前段）；`receiptFor` 与预取链都从出发时的那一只取值（不是字段的当前值，中途换参数已经换成新的了）：主播放径给 `segAbort`，预取给 `abort`。
- 抓取层的「取消优先于超时」归类（`fetcher.ts` 已有）现在是听书链的实际行为，不再是只有搜索面享用的性质。

锚点：`src/services/tts.ts` 的 `TtsService.synthesize` / `TtsSynthesisPlan.produce` / `fetchHttp` / `synthesizeCordis`；`src/services/tts-cancel.ts` 的 `abortReasonOf`；`src/services/tts-cordis.ts` 的 `guardSynthesis`；`src/services/reading.ts` 的 `ttsSynthesize`；`src/api/dispatch.ts` 的 `ttsSynthesize` 臂；`src/client/tts/listen-session.ts` 的 `PlayerRun.abort` / `PlayerRun.segAbort` / `cancelInFlight` / `cancelCurrentSegment` / `seekParagraph` / `receiptFor`；`src/client/tts/player.ts` 的 `synthesize` 平台实现；`src/client/api.ts` 的 `apiSend`；`tests/services/tts.test.ts` 的「取消位下传到抓取层」与「取消理由的类型纪律」；`tests/services/tts-cordis.test.ts` 的三条取消用例；`tests/api/tts-routes.test.ts` 的「客户端断连 → 中止在途合成」；`tests/client/tts-session.test.ts` 的「跳段只作废当前段那一发」与「暂停不在取消位之列」；`docs/architecture.md` §4；`ADR-0077`。