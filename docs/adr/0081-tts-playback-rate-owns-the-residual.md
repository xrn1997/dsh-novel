# 语速归谁：引擎做到多少算多少，播放端只补差额

Status: accepted

用户滑杆上的倍率是**请求**，字节里掺了多少由引擎能力决定。合成回执因此多带一格 `playbackRate`（播放端还要乘的倍率）；缓存侧车记的是**这份字节里引擎应用的那一档**（`appliedRate`），回执按「请求 ÷ 应用量」现算。能应用服务端语速参数的源按能力位发 `voiceRate`，不认语速参数的源一概补全额。

## 背景

听书有四个引擎源，语速在它们身上不是一件事：内置朗读的公开合成口只收整数档；订阅引擎的 `speakSpeed` 写不写在模板里由订阅数据决定；宿主朗读服务的 `voiceRate` 是可选的**服务端**参数且值域由宿主限定；浏览器本地语音的倍率由平台开口时应用。只把用户要的倍率发给「能收的那几家」，剩下的源就成了**假控件**：滑杆摆在 1.5x，耳朵里是 1.0x，读数照旧写 1.5x。

## 决定

1. **回执带一格 `playbackRate`**：拿到这段字节后播放端还要乘的倍率，1 = 引擎已按用户要的语速念过。用户要的倍率 = 引擎真做的那档 × 这一格，两者乘回去等于请求里的 `rate`。
2. **判定材料来自各支的合成计划**：HTTP 支看规则文本里有没有 `speakSpeed`（判据是规则文本而不是比两次求值结果：JS 段可能有出站副作用）；cordis 支看 `voiceRate` 到底发没发出去。两支各产自己那一格 `appliedRate`，合成面按「请求 ÷ 这一格」算差额——不各自算补速。
3. **差额而不是全额**：服务端做到上限之外的那一截仍由播放端补；不统一口径弃用服务端能力。
4. **侧车存应用量，不存补速**：`appliedRate` 与 `mediaType` 一起进缓存侧车，命中路径按**这次请求**的倍率现算差额；引擎之后换了口径，旧字节仍是旧那一份事实。侧车缺这一格读作 miss：猜 1 会在曾应用服务端语速的源上双重加速。
5. **上屏读数不变**：`1.5x` 仍表示用户要的倍率，不拆成「引擎多少 + 补多少」。
6. **换段与续播都重设倍率**：`Audio.playbackRate` 留在元素上的旧值会让下一段沿用上一段的速度。

## 边界

- 不做音高补偿（平台缺省已给，不把它收进 `AudioSlot` 的窄镜像）。
- 不把倍率塞进缓存键：语速决定的是同一段文本念多快，不是另一段内容。
- 不改时间读数口径：段进度仍按音频内秒数计，直出型恒为零。

## 被否方案

- 一律在播放端应用语速：把宿主朗读服务已提供的 `voiceRate` 能力位晾着不用，中文长句的原生韵律会差很多。
- 只发服务端参数、不补差额：超出宿主值域的倍率被悄悄夹到边界，滑杆撒谎。
- 把补速反写成「引擎实际倍率」上屏：把实现细节摊给用户，换引擎会看到读数跳变。

## 后果

- `SynthesisReceipt` 多一格 `playbackRate`，`TtsAudioCache` 的侧车多存 `appliedRate`、`meta` 读口取代 `has`；本批之前写下的侧车读作 miss，下一次播放重合成一次。
- 语速不再参与「是否需要重新合成」（HTTP 支）：调滑杆只换播放倍率、复用同一份字节；cordis 支仍按原始 `rate` 各存一份。
- 播放层多一次搬运（回执 → `BytesSegment.playbackRate` → `Audio.playbackRate`），换段与续播两处都要设。

锚点：`src/shared/wire.ts` 的 `SynthesisReceipt.playbackRate`；`src/services/tts.ts` 的 `TtsService.synthesize` / `planHttp` / `synthesizeCordis` / `residualOf`；`src/services/tts-request.ts` 的 `ruleCarriesSpeechRate`；`src/services/tts-cordis.ts` 的 `voiceRateOf` / `normalizeSpeechSynthesis`；`src/services/tts-cache.ts` 的 `AudioMeta.appliedRate` / `TtsAudioCache.meta` / `readSidecar`；`src/client/tts/output-contract.ts` 的 `BytesSegment.playbackRate`；`src/client/tts/bytes-output.ts` 的 `AudioSlot.playbackRate`；`src/client/tts/listen-session.ts` 的 `ReceiptEntry` / `resumeListening`；`tests/services/tts.test.ts`；`tests/services/tts-cordis.test.ts`；`tests/services/tts-cache.test.ts`；`tests/client/tts-bytes-output.test.ts`；`tests/client/tts-session.test.ts`；`CONTEXT.md`「播放补速」；`docs/ui-spec.md` §3.6；`ADR-0069`。
