# 听书面的失败半径等于判据的主语：订阅注册表坏只降订阅那一格

Status: accepted

`tts-engines.json` 读不出时，`ReadingService.create` 不再把整个听书部件装配成缺席，而是换一份降级注册表（空表 + 原因）——源清单、内置合成与缓存读照常，只有订阅动词 503 带原因。理由：损坏只是**订阅数据**的坏法，判据的主语是那一格，半径跟着主语走。

## 背景

原来注册表加载抛错 → `TtsParts` 整体为 null → 听书面的全部动词落 503：不读订阅数据的内置引擎、浏览器直出行与已经落盘的段音频一起停摆，一个坏 JSON 关掉了开箱即用的功能。当时的宽半径没有 ADR——只活在一句代码注释和一条把 503 钉死的路由测试里。

## 决定

- **装配处恒给听书部件**：`create` 接住注册表加载失败，换 `TtsEngineRegistry.degraded(dir, reason)`——空表 + `degradedReason`；损坏照旧在 error 级留痕并点明后果。
- **源清单只列此刻可用的行**：内置 / 浏览器直出 / 宿主语音服务照常列，订阅行在降级时缺席；段合成与缓存读照常——订阅 id 得 `TTS_ENGINE_MISSING`（400），缓存命中的字节照常回执。
- **五个订阅动词按降级态抛具名错误**：经门面的 `requireEngines` 抛 `TtsEnginesDegradedError`，`classify` 归 `unavailable`（503），消息带原因。判据只有 `degradedReason` 一处。
- **缺席与降级是两个主语**：直装缝 `from` 不给听书面仍是 `TtsNotMountedError`（装配选择，不是坏格）。

## 边界

- 半径只到订阅注册表这一个判据：别的数据文件坏各归各家。
- 语义归属照旧：注册表本体住 `docs/architecture.md` §4 的「朗读引擎订阅注册表」行。
- 音色表进写契约与本篇同批但不同决定。

## 被否方案

- 维持全有或全无：半径大于判据的主语，内置、直出与缓存字节都不读那个文件，没有理由陪葬。
- 缺席也装配缺省件、翻既有 503 期望：把「部件根本没装配」与「订阅数据坏」两个主语搅成一件事。

## 代价

降级给注册表加了一个在场状态：空表从此有两种来路（首启 = 真没有订阅；降级 = 读不出），靠 `degradedReason` 在场与否区分。管理面在降级时读到 503、显示读失败，而不是一张会误导成「订阅被清空」的空表。

锚点：`src/services/tts-engines.ts` 的 `TtsEngineRegistry.degraded` / `degradedReason` / `load`；`src/services/reading.ts` 的 `ReadingService.create` 与 `requireEngines`；`src/services/errors.ts` 的 `TtsEnginesDegradedError`；`tests/api/tts-routes.test.ts`；`tests/services/tts-engines.test.ts`；`tests/services/error-taxonomy.test.ts`；`docs/architecture.md` §4「朗读引擎订阅注册表」行；`AGENTS.md` 硬约束。
