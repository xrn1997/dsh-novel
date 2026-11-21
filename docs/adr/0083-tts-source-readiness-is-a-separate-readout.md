# 未就绪的源不进清单，但「为什么不在」要能查

Status: accepted

宿主朗读服务装了却没配好时，源清单不列这一行（清单的承诺是「列出的都在此刻可用」），合成按 `TTS_ENGINE_UNAVAILABLE` 具名失败；「这一行为什么不在」由同一条路由的 `hostSpeech` 健康读数回答（缺席 / 未就绪＋服务方原因码 / 就绪），管理面据此把「未安装」与「没配好」摆成两句不同的话。

## 背景

源清单的既有裁决（`ADR-0077`）是只列此刻可用的源，不摆灰行造禁用态。这个裁决对订阅引擎成立：订阅已落盘、源在，坏不坏是合成时才知道的事。但宿主朗读服务多了一格状态——装好了、但还没配好（缺密钥、音色不齐）。按旧实现，服务对象一旦在场就列行，于是用户看到「可用」，选了它，每一段都失败；或者反过来整行删掉，用户分不清「没装插件」与「装了没配」。

## 决定

1. **清单仍只列可用源**：`ready` 为假时 cordis 行不进源清单，`ADR-0077` 的承诺不变。
2. **健康读数与清单同出**：`GET /tts/sources` 的值从数组变成 `TtsSourcesView`（`sources` + `hostSpeech`）。两者由**同一次能力读数**算出，不分两次问。
3. **三态而不是两态**：`absent` / `not-ready`（在场但不可用，带服务方的稳定原因码）/ `ready`。「装没装」与「配没配」是两个主语，折叠成一个空会让用户去重装插件。读数本身抛错（服务在场、状态读不出）落 `not-ready`、不带原因码。
4. **原因码原样带、不翻译**：`api-key-not-configured` 这类码是服务方的稳定事实，客户端文案只包外层说明，不替它编本地词汇表。
5. **合成期先判就绪再发请求**：未就绪时直接抛 `TTS_ENGINE_UNAVAILABLE`（503），不拿一次注定失败的上游请求当报错。它与「引擎不存在」（400）是两个档；服务在场但读数抛错也走 503。
6. **读不出就按不可用**：能力清单里找不到有效供应商那一格时，`ready` 按假处理。

## 边界

- 不做客户端轮询：健康读数只在读清单时算一次。
- 不在选择面显示健康读数：引擎下拉只取清单那一半。
- 不做原因码的本地映射。

## 被否方案

- 灰行带原因（清单里保留不可用行）：与「清单只列此刻可用」直接冲突，且会让两个面对同一行的语义分叉。
- 只除名、不报原因：用户「按了没反应，也不知道该去哪儿」。
- 把原因码塞进清单行的自由文本：`TtsSourceInfo` 是跨半契约，插件自有源不投展示名，同理不投自由文本说明。

## 后果

- `GET /tts/sources` 的值形状变了（数组 → 对象）；仓内两个消费点同批改，`useTtsSources` 只取 `sources`。
- 错误分类学多一档 `tts-engine-unavailable`（503）：四处表都要登记，漏一处 tsc 红。
- 管理面多一句文案分叉：`descOf` 与新的 `statusLabelOf` 按 `host.state` 分「未检测到 / 未就绪」。

锚点：`src/shared/wire.ts` 的 `HostSpeechHealth` / `TtsSourcesView`；`src/services/tts.ts` 的 `TtsService.sourcesView` / `speechReadout` / `NormalizedSpeechSynthesis.ready`；`src/services/tts-cordis.ts` 的 `readinessOf` / `effectiveProviderId`；`src/services/errors.ts` 的 `TTS_ENGINE_UNAVAILABLE` / `TTS_CATEGORY_OF`；`src/api/wire.ts` 的 `STATUS_OF`；`src/services/search-face.ts` 的 `PROBE_CODE_OF`；`src/services/reading.ts` 的 `ttsSourcesView`；`src/api/dispatch.ts` 的 `ttsSources` 臂；`src/client/tts/engine-rows.ts` 的 `EngineRow.host` / `statusLabelOf` / `descOf`；`src/client/tts/EngineManager.tsx`；`src/client/tts/use-tts-sources.ts`；`src/client/copy/tts.ts`；`tests/services/tts-cordis.test.ts`；`tests/client/tts-engines-ui.test.tsx`；`tests/services/error-taxonomy.test.ts`；`docs/ui-spec.md` §3.6；`ADR-0077`。
