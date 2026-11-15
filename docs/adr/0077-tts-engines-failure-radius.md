# 听书面的失败半径等于判据的主语：订阅注册表坏只降订阅那一格

Status: accepted

导语：`tts-engines.json` 读不出时，`ReadingService.create` 不再把整个听书部件装配成缺席，而是换一份降级注册表（空表 + 原因）——源清单、内置合成与缓存读照常，只有订阅动词 503 带原因。理由：损坏只是**订阅数据**的坏法，判据的主语是那一格，半径跟着主语走（`AGENTS.md` 的硬约束「失败半径等于判据的主语」）。

## 背景

原来注册表加载抛错 → `TtsParts` 整体为 null → 听书面的全部动词落 503：不读订阅数据的内置引擎、浏览器直出行与已经落盘的段音频一起停摆，一个坏 JSON 关掉了开箱即用的功能。这与本仓硬约束相反，而当时的宽半径没有 ADR——只活在一句代码注释和一条把 503 钉死的路由测试里，翻它需要一次显式裁决，而不是改测试代答。

## 决定

- **装配处恒给听书部件**：`create` 接住注册表加载失败（`readJson` 的 `CorruptJsonError` 等），换 `TtsEngineRegistry.degraded(dir, reason)`——空表 + `degradedReason`；`TtsParts` 不再有「损坏即缺席」这条来路。损坏照旧在 error 级留痕并点明后果，绝不静默吞。
- **源清单只列此刻可用的行**：内置 / 浏览器直出 / 宿主语音服务照常列，订阅行在降级时缺席（清单承诺「列出的都在此刻可用」不变）；段合成与缓存读照常——订阅 id 得 `TTS_ENGINE_MISSING`（400），缓存命中的字节照常回执（字节是既定事实，与订阅无关）。
- **五个订阅动词按降级态抛具名错误**：`ttsEngineList` / `ttsEngineImport` / `ttsEngineImportFromUrl` / `ttsEnginePut` / `ttsEngineRemove` 经门面的 `requireEngines` 抛 `TtsEnginesDegradedError`，`classify` 归 `unavailable`（503），消息带原因。判据只有 `degradedReason` 一处，门面不写第二份「坏没坏」。
- **缺席与降级是两个主语**：直装缝 `from` 不给听书面仍是 `TtsNotMountedError`（那是装配选择，不是坏格）——两条半径各有各的闸，不合并成一个状态。

## 边界

- 半径只到订阅注册表这一个判据：别的数据文件坏各归各家，听书面不替它们兜底，也不因为它们坏而降级。
- 语义归属照旧：注册表本体（含降级态与保留 id 的落盘过滤）住 `docs/architecture.md` §4 的「朗读引擎订阅注册表」行；本篇只记 why。
- 音色表进写契约（导入携带、put 整组替换）与本篇同批但不同决定，语义住 `shared/wire.ts` 的 `TtsEngineInput` 与 `services/tts-engines.ts` 的 `upsert`。

## 被否方案

- **维持全有或全无**（坏一个文件 → 听书面整体 503）：半径大于判据的主语，直接违背 `AGENTS.md` 硬约束；内置、直出与缓存字节都不读那个文件，没有理由陪葬，用户也不该为一个 JSON 失去全部听书。
- **缺席也装配缺省件、翻既有 503 期望**（把直装缝的缺席一并消掉）：把「部件根本没装配」与「订阅数据坏」两个主语搅成一件事——缺席是装配选择（直装缝与测试的接线方式），不是坏格；为收口半径去翻缺席用例的期望，换不来任何半径收益，只让两个概念互相冒充。

## 代价

降级给注册表加了一个在场状态：空表从此有两种来路（首启 = 真没有订阅；降级 = 读不出），靠 `degradedReason` 在场与否区分。管理面在降级时读到 503、显示读失败，而不是一张会误导成「订阅被清空」的空表——这个区分由测试钉住，别让后来者把降级折回空表。

锚点：`src/services/tts-engines.ts` 的 `TtsEngineRegistry.degraded` / `TtsEngineRegistry.degradedReason` / `TtsEngineRegistry.load`；`src/services/reading.ts` 的 `ReadingService.create` 与 `requireEngines`；`src/services/errors.ts` 的 `TtsEnginesDegradedError`（`classify` → `unavailable`）；`tests/api/tts-routes.test.ts` 的降级用例；`tests/services/tts-engines.test.ts` 的降级注册表用例；`tests/services/error-taxonomy.test.ts` 的分类表行；`docs/architecture.md` §4「朗读引擎订阅注册表」行；`AGENTS.md` 硬约束「失败半径等于判据的主语」。
