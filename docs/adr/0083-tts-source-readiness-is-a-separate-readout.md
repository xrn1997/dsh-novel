# 未就绪的源不进清单，但「为什么不在」要能查

Status: accepted

宿主朗读服务装了却没配好时，源清单不列这一行（清单的承诺是「列出的都在此刻可用」），合成按 `TTS_ENGINE_UNAVAILABLE` 具名失败；「这一行为什么不在」由同一条路由的 `hostSpeech` 健康读数回答（缺席 / 未就绪＋服务方原因码 / 就绪），管理面据此把「未安装」与「没配好」摆成两句不同的话。

## 背景

源清单的既有裁决（`ADR-0077`）是只列此刻可用的源，不摆灰行造禁用态。这个裁决对订阅引擎成立：订阅已落盘、源在，坏不坏是合成时才知道的事。但宿主朗读服务多了一格状态——**装好了、但还没配好**（缺密钥、音色不齐）。按旧实现，服务对象一旦在场就列行，于是：

- 用户看到「宿主朗读服务」可用，选了它，每一段都失败；
- 或者反过来，为了不撒谎把它整行删掉，用户就分不清「没装插件」与「装了没配」——两者的修法完全不同。

两种表现都让清单的承诺失真：前者列了不可用的源，后者让一个在场的事实隐身。

## 决定

1. **清单仍只列可用源**：`ready` 为假时 cordis 行不进源清单，`ADR-0077` 的承诺不变。
2. **健康读数与清单同出**：`GET /tts/sources` 的值从数组变成 `TtsSourcesView`（`sources` + `hostSpeech`）。两者由**同一次能力读数**算出，不分两次问——两次快照之间引擎换了口径，清单与健康就会各说一套。
3. **三态而不是两态**：`absent`（服务不在场）/ `not-ready`（在场但不可用，带服务方的稳定原因码）/ `ready`。「装没装」与「配没配」是两个主语，折叠成一个空会让用户去重装插件。读数本身抛错（服务在场、状态读不出）落 `not-ready`、不带原因码——那同样是「在场但此刻不可用」，不是缺席。
4. **原因码原样带、不翻译**：`api-key-not-configured` 这类码是服务方的稳定事实，客户端文案只包外层说明（「已安装但未就绪（…），到该插件里配好供应商」），不替它编一套本地词汇表——那会造出第二份错误码字典。
5. **合成期先判就绪再发请求**：未就绪时直接抛 `TTS_ENGINE_UNAVAILABLE`（503，`tts-engine-unavailable` 类目），不拿一次注定失败的上游请求当报错——既花钱也说不清是谁的问题。它与「引擎不存在」（400，调用方选错了）是两个档；服务在场但读数抛错也走这一档（503），不是 400。
6. **读不出就按不可用**：能力清单里找不到有效供应商那一格时，`ready` 按假处理。缺读不是可用——这是「缺席不是空表」「缺失不是支持」同一条纪律的第三次落地。

## 边界

- **不做客户端轮询**：健康读数只在读清单时算一次。服务中途被接管 / 改了配置，下一次打开面板就刷新；不为此挂监听（宿主有 `subscribeEngine`，但选择面不需要实时性）。
- **不在选择面显示健康读数**：引擎下拉只取清单那一半。往下拉里塞一个「未就绪」选项，等于把一个选了也合成不出的源摆到用户面前。
- **不做原因码的本地映射**：见决定 4。将来若某些码需要更可行动的引导，改的是服务方或文案外层，不是客户端造字典。

## 被否方案

- **灰行带原因（清单里保留不可用行）**：与 `ADR-0077` 的「清单只列此刻可用」直接冲突，且会让两个面（选择下拉、管理列表）对同一行的语义分叉。管理面那一条灰行是**客户端合成的本地说明**，不在清单里，这个区别要保住。
- **只除名、不报原因**：本仓硬约束里最接近的一条是「判不适用而不写理由，等于把裁决写成遗忘」；用户那边则是「按了没反应，也不知道该去哪儿」。
- **把原因码塞进清单行的自由文本**：`TtsSourceInfo` 是跨半契约，插件自有源不投展示名（否则英文 locale 会露中文）——同理不投自由文本说明。健康读数单开一格，语言归客户端。

## 后果

- `GET /tts/sources` 的值形状变了（数组 → 对象）。仓内两个消费点（引擎管理面、听书面读面 hook）同批改；`useTtsSources` 只取 `sources`，健康读数不进选择面。
- 错误分类学多一档 `tts-engine-unavailable`（503）：`ErrorCategory`、`TTS_CATEGORY_OF`、`STATUS_OF`、`PROBE_CODE_OF` 四处表都要登记（表即穷尽闸，漏一处 tsc 红）。
- 管理面多一句文案分叉：`descOf` 与新的 `statusLabelOf` 按 `host.state` 分「未检测到 / 未就绪」。
- 读数抛错（服务在场、状态读不出）时 `hostSpeech` 报 `not-ready`（无原因码），合成按 503 失败；`absent` 只留给 getter 返回 `undefined` 的那一半。

锚点：`src/shared/wire.ts` 的 `HostSpeechHealth` / `TtsSourcesView`；`src/services/tts.ts` 的 `TtsService.sourcesView` / `speechReadout` / `NormalizedSpeechSynthesis.ready`；`src/services/tts-cordis.ts` 的 `readinessOf` / `effectiveProviderId`；`src/services/errors.ts` 的 `TTS_ENGINE_UNAVAILABLE` / `TTS_CATEGORY_OF`；`src/api/wire.ts` 的 `STATUS_OF`；`src/services/search-face.ts` 的 `PROBE_CODE_OF`；`src/services/reading.ts` 的 `ttsSourcesView`；`src/api/dispatch.ts` 的 `ttsSources` 臂；`src/client/tts/engine-rows.ts` 的 `EngineRow.host` / `statusLabelOf` / `descOf`；`src/client/tts/EngineManager.tsx`；`src/client/tts/use-tts-sources.ts`；`src/client/copy/tts.ts` 的两条 not-ready 文案；`tests/services/tts-cordis.test.ts` 的就绪用例与「服务读数抛错」；`tests/client/tts-engines-ui.test.tsx` 的「装了但没配好」；`tests/services/error-taxonomy.test.ts`；`docs/ui-spec.md` §3.6；`ADR-0077`。