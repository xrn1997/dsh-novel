# 听书缺省的生效值用来源链读时求值，三个写者不再推可变袋

Status: accepted

听书缺省（引擎 / 语速 / 音量 / 预取段数）的生效值曾经由三个写者（宿主同步配置的 live ref、宿主设置面快照、配置页保存回执）逐格 merge 进 `ListenSession` 的可变袋，谁赢由调用顺序决定。决定：**改成一条来源链读时求值——每格取链序里第一个读得出的来源，链序即优先级；三个写者降级为来源 adapter，彼此没有顺序关系**（`CONTEXT.md`「听书缺省」）。

## 背景

可变袋 + 逐格 merge（`undefined` 不写）把「谁赢」留给调用顺序，出过三种症状：

1. **last-writer-wins 盖值**：live ref 的订阅回调整份重推四格，会把配置页刚保存的快照值按顺序盖回旧值；保存是否可见取决于推送时机。
2. **缺格陪绑**：同步配置四格里缺任何一格就整段不接管，另外三格的活值热更一并放弃。
3. **晚到永不认领**：接管判据只在接入时判一次，宿主后发布的值不会被采纳；判读判据（「什么算读得出」）还抄用在 UI 层。

消费点其实早已是读时求值（起播 `p ?? stored ?? defaults`、预取现读），坏的是「defaults 从哪来」这一段。

## 决定

1. **一条规则**：每格生效值 = 按来源顺序第一个读得出的值，读时求值；链序即优先级（live ref > 设置面快照 > wire 的 `TTS_DEFAULTS`），谁赢与到达 / 刷新 / 订阅先后无关。
2. **`TTS_DEFAULTS` 是终端地板、不是来源**：全链读不出的格由它兜底，`effective()` 四格总有值、永不抛。
3. **判读单点**：空白引擎 id / 非有限数 / 非整数或负数预取 = 读不出，判据只住 `createTtsDefaults` 一处；一格读不出只落那一格（失败半径 = 判据的主语）。
4. **通知无载荷、无仲裁**：来源只发「变了」的信号，链子重算后仅在生效值真变化时转发；重算是纯函数，幂等重推天然 no-op。
5. **逐格接管**：同步配置某格不是合法 ref 就那一格缺席，不牵连他格；`read` 现读（晚出现的 ref 下一读即见）。接入时不特判「live ref 已占满四格就跳过首屏 `describe`」——多读一发无害，少一条特判。

## 边界

- 播放层回退链的前两环（显式入参 > 本书 listen 存档）不动，仍是起播处的 `??` 链；本链只管第三环从哪来。
- 值域不在此裁决：上下界归 schema，播放层仅在交互写口与播放音量处做 `clampNumber` 夹取。
- 草稿不跨 seam：只有生效值进来源 adapter（配置页 `onEffectiveValue`），草稿住 `config-draft`。
- 宿主词汇（`ttsDefaultEngine` 之类名字表、`SyncedConfigRefLike` 窄镜像，`ADR-0020`）只住 `tts-defaults-host.ts`，来源链不认识宿主。

## 被否方案

- **push + 同源 diff 抑制**（只推变化格）：治标——merge 语义与可变袋还在，规则仍是两个写者各自的抄本。
- **静态位阶 + 认领表 + 令牌裁决的仲裁引擎**：为「不同源宿主」「乱序回执」等假设性场景造了七个新概念；乱序防护在设置面一侧已有 seq 票据（`config-draft`），不同源分歧的裁决一行链序就说得清，不值一套引擎。
- **按到达序的 last-writer-wins 修正版**：仍是顺序语义，测试必须用时序重演才能钉住行为。

## 后果

- 「订阅重推盖掉刚保存的值」失去发生条件：没有 push，就没有盖值。
- 同步配置半到场也逐格生效；宿主后发布的值下一读 / 下一信号即认领。
- 两条宿主来源缺席或读失败都落下一来源，最终由 wire 地板兜底——老宿主（无同步配置、无设置面）零额外概念。
- 接入时不做「跳过 `describe`」的特判（每格胜者由链序定，快照多读一发无害）。

锚点：`src/client/tts/tts-defaults.ts` 的 `createTtsDefaults` / `READABLE`；`src/client/tts/tts-defaults-host.ts` 的 `createLiveRefSource` / `createSettingsSnapshotSource` / `TTS_DEFAULT_KEYS`；接线 `src/client/index.tsx` 的 `pushSettingsSnapshot` 与 `src/client/tts/player.ts` 的 `installTtsDefaults`；测试 `tests/client/tts-defaults.test.ts`、`tests/client/tts-defaults-host.test.ts`、`tests/client/config-page.test.tsx` 的「接入层读听书缺省」；语义归属 `docs/architecture.md` §4 的「听书缺省」行；词汇 `CONTEXT.md`「听书缺省」。
