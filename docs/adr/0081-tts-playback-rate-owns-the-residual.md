# 语速归谁：引擎做到多少算多少，播放端只补差额

Status: accepted

用户滑杆上的倍率是**请求**，字节里掺了多少由引擎能力决定。合成回执因此多带一格 `playbackRate`（播放端还要乘的倍率）；缓存侧车记的是**这份字节里引擎应用的那一档**（`appliedRate`），回执按「请求 ÷ 应用量」现算。能应用服务端语速参数的源按能力位发 `voiceRate`，不认语速参数的源一概补全额。

## 背景

听书有四个引擎源，语速这条参数在它们身上根本不是一件事：

- 内置朗读的公开合成口只收 `spd` 的 1–7 整数档，滑杆是映射过去的；
- 订阅引擎（legado HttpTTS）的语速绑定 `speakSpeed` 写不写在模板里由订阅数据决定——不写就是原速；
- 宿主朗读服务的 `voiceRate` 是可选的**服务端**参数，宿主契约把它限定在 0.5–2，且外部接管的提供方一律拒收；
- 浏览器本地语音的倍率由平台开口时应用。

只把用户要的倍率发给「能收的那几家」，剩下的源就成了**假控件**：滑杆摆在 1.5x，耳朵里是 1.0x，而屏上的读数照旧写 1.5x。这是本仓既定纪律「读数不撒谎」里最难看的一种——读数不是缺失，是错的。

## 决定

1. **回执带一格 `playbackRate`**：拿到这段字节后播放端还要乘的倍率，1 = 引擎已按用户要的语速念过。用户要的倍率 = 引擎真做的那档 × 这一格，两者乘回去必须等于请求里的 `rate`（按千分位收浮点尾巴）。
2. **判定材料来自各支的合成计划**：HTTP 支看**规则文本里有没有 `speakSpeed`**——写了就是请求里带着语速，没写就是原速的一段（判据是规则文本而不是比两次求值结果：JS 段可能有出站副作用，重求值不免费）。cordis 支看 `voiceRate` 到底发没发出去，发了就把实际发出的那档记成应用量。适配器（`services/tts-cordis.ts`）与 HTTP 支各产自己那一格 `appliedRate`（「我做了什么」），合成面按「请求 ÷ 这一格」算差额——两支不各自算补速，否则同一份字节会有两个口径。
3. **差额而不是全额**：服务端做到上限（宿主 0.5–2）之外的那一截仍由播放端补——用户滑杆的 0.5–3 是插件的域，宿主收的只是「这次请多快」。宁可让宿主朗读服务的原生韵律留着，也不为统一口径把服务端能力弃用。
4. **侧车存应用量，不存补速**：`appliedRate` 与 `mediaType` 一起进缓存侧车，命中路径按**这次请求**的倍率现算差额，不拿「此刻的引擎能力」重算。引擎之后换了口径，旧字节仍是旧那一份事实；而补速是 `(请求, 字节)` 的函数——模板不消费语速时键与倍率无关，同一份字节会被不同倍率重放，把第一次的差额当成字节属性，第二次播放就慢了或快了。侧车缺这一格（本批之前写下的）读作 miss：那一代没记录引擎真做了多少，猜 1 会在曾应用服务端语速的源上双重加速，重合成一次是唯一不撒谎的选项。
5. **上屏读数不变**：`1.5x` 仍表示用户要的倍率，不因为「引擎只做到 2.0 而播放端补 1.5」改写法——拆开来写是给用户看实现细节。
6. **换段与续播都重设倍率**：`Audio.playbackRate` 留在元素上的旧值会让下一段悄悄沿用上一段的速度；预载槽只接 `src`，不抢活槽的倍率。

## 边界

- **不做音高补偿**：`preservesPitch` 的缺省行为（音高不随倍率漂移）平台已给，本仓不动它，也不把它收进 `AudioSlot` 的窄镜像——没人读它的属性不该进契约。
- **不把倍率塞进缓存键**：语速决定的是同一段文本念多快，不是另一段内容。规约由各支的 identity 各自决定（HTTP 支的 `speakSpeed` 已经进了求值后的 URL / body），这一格只回答「怎么放」。
- **不改时间读数的口径**：段进度仍按**音频内**秒数计，答「这一段念到第几秒」，不答墙钟。倍率改变播放时长但不改变这个读数的含义；直出型没有计时介质、恒为零的那条既有裁决不变。

## 被否方案

- **一律在播放端应用语速**：最省事、缓存最省、读数绝对真，也是听书 App 的常规做法；代价是把宿主朗读服务已提供的 `voiceRate` 能力位晾着不用，中文长句的原生韵律会比变速播放自然得多。引擎明确支持时我们没理由替它降级。
- **只发服务端参数、不补差额**：就是改之前的样子——超出宿主值域的倍率被悄悄夹到边界，滑杆撒谎。
- **把补速反写成「引擎实际倍率」上屏**：把实现细节摊给用户，且当两个引擎的实际倍率不同时，同一本书换源会看到读数跳变。

## 后果

- `SynthesisReceipt` 多一格 `playbackRate`，`TtsAudioCache` 的侧车多存一格 `appliedRate`、`meta` 读口取代 `has`（回执要报这一格，只看「有没有字节」不够）。本批之前写下的侧车没有这一格：读作 miss，下一次播放重合成一次——那一代没记录「引擎真做了多少」，猜一个数就是在放错速。
- 语速不再参与「是否需要重新合成」（HTTP 支）：不消费服务端语速的源上，调滑杆只换播放倍率、复用同一份字节。这是本决定顺手赚到的：滑杆从「重新合成一章」变成「立即生效」。cordis 支维持原状——它的键仍按原始 `rate` 各存一份（键材料与映射同侧，映射换口径时要一起看），换倍率仍是一次新请求。
- 播放层多一次搬运（回执 → `BytesSegment.playbackRate` → `Audio.playbackRate`），两处写（换段与续播）都要设。

锚点：`src/shared/wire.ts` 的 `SynthesisReceipt.playbackRate`；`src/services/tts.ts` 的 `TtsService.synthesize` / `planHttp` / `synthesizeCordis` / `residualOf`；`src/services/tts-request.ts` 的 `ruleCarriesSpeechRate`；`src/services/tts-cordis.ts` 的 `voiceRateOf` / `normalizeSpeechSynthesis`；`src/services/tts-cache.ts` 的 `AudioMeta.appliedRate` / `TtsAudioCache.meta` / `readSidecar`；`src/client/tts/output-contract.ts` 的 `BytesSegment.playbackRate`；`src/client/tts/bytes-output.ts` 的 `AudioSlot.playbackRate` 与 `start` 的两条写点；`src/client/tts/listen-session.ts` 的 `ReceiptEntry` / `resumeListening`；`tests/services/tts.test.ts` 的「回执报告播放端要补的倍率」与「同一份字节跨倍率重放」；`tests/services/tts-cordis.test.ts` 的「回执报出播放端要补的倍率」；`tests/services/tts-cache.test.ts` 的「应用语速随条目定版」；`tests/client/tts-bytes-output.test.ts`；`tests/client/tts-session.test.ts` 的「回执报的补速原样交给出声层」；`CONTEXT.md` 的「播放补速」；`docs/ui-spec.md` §3.6；`ADR-0069`。