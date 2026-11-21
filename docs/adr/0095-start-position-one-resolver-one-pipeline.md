# 起播位置由一条解析链与一条起播管线决定

Status: accepted

pill、听书条「从阅读位置起播」与选区起播曾各自解析位置、各自取数：探针缺席时 pill 退当前章首段，听书条退书架比例；听书条还绕开 `startListening` 另走一条 seed 路径。决定：**位置解析收进 `startFromReadingPosition` 的一条链（显式 target → 探针 → 当前章 → 书架 progress），起播收进 `startSession` 的一条管线**。

## 背景

同一句「从阅读位置起播」在两个入口上有两套回退：pill 用 `readingProbeNow`，量不到退 `currentChapter` + 段 0；听书条的 `playFromReadingPosition` 量不到则读服务端书架 progress，用 `estimateParagraphIndex` 换成段号。后者还自己取目录与正文，把结果作为 seed 交给 `startSession`。两条路的参数、定时与失败行为也不同。`TTS_NOT_ON_SHELF` 是这条分叉的产物：只有「听书条无探针、只能靠书架比例」那一格才会遇到「书不在架」，于是它被写成用户错误。

## 决定

1. **唯一解析链**：`ListenSession.startFromReadingPosition` 按「显式 target（选区）→ 实时阅读探针 → 当前章（活动会话的 `chapterIndex` 或调用方给的 `fallbackChapter`）→ 书架 `progress`」解析章段。书架比例只在它指向同一章时用于段号估算，不跨章搬位置。
2. **唯一取数管线**：解析结果交给 `startListening` → `startSession`；`startSession` 取目录、书架与正文一次，不再接受 seed，也不再由调用方预取。`StartListeningInput` 增 `fallbackChapter` / `fallbackToShelfParagraph` 两个位置兜底位。
3. **参数与定时**：活动会话把当前引擎/音色/语速/音量带进新 run；没有活动会话时由 `startSession` 从本书 `listen` 存档与活动缺省回退。起播完成后按原到点时刻恢复定时。
4. **选区是显式 target**：`useListenFromSelection` 读出的章段作为 `target` 交给同一条链。
5. **退役 `TTS_NOT_ON_SHELF`**：没进架的书按当前章（或 0）起播，不再把「没有可换算的书架进度」冒充「不能起播」。
6. **`resume: 'archive'` 不变**：仍从本书 `listen` 存档续听，覆盖解析出的章段；生产仍无界面入口。

## 边界

- `startListening` 仍是底层入口：调用方已经拿准章段时直接用它，不经过探针链。
- 书架 progress 只作最后兜底，且只在同章时取段号比例。
- 活动会话的参数优先于 `listen` 存档；定时只在同一本书换起播点时恢复。
- 不新增「从上次听到处续听」的界面入口。

## 代价

- 书架 progress 若落后到另一章，解析链会优先当前章，段落退 0；更保守，但可能少一点续听精度。
- `startFromReadingPosition` 需要读一次平台探针与一次书架；书架本来就要为参数读一次，没有新增请求。
- 删掉 `TTS_NOT_ON_SHELF` 后，没进架的书不再被明确提示「没有阅读进度」。

## 被否方案

- 保留 pill 与听书条两套回退：同一 intent 两个答案，用户看到的位置取决于按了哪个钮。
- 保留 seed 路径：两条取数次序的参数、定时与失败半径已经分叉。
- 书架 progress 优先于当前章：旧比例可能指向另一章，会把正在看当前章的读者拽走。
- 继续用 `TTS_NOT_ON_SHELF` 拒绝起播：把「没有可换算的存档」当成「不能从当前章开始」。
- 只统一解析、不统一取数：解析结果仍要各自预取一遍。

锚点：`src/client/tts/listen-session.ts` 的 `startFromReadingPosition` / `startSession` / `StartFromReadingPositionInput` / `StartListeningInput.fallbackChapter`；`src/client/progress.ts` 的 `estimateParagraphIndex` / `paragraphRatio`；`src/client/tts/player.ts` 的 `startFromReadingPosition` / `playFromReadingPosition`；`src/client/views/ReaderView.tsx` 的 `startListeningAt` / `onListenPill` / `onListenFrom`；`src/client/views/listen-from-selection.ts` 的 `useListenFromSelection`；`tests/client/tts-player.test.ts`；`tests/client/tts-bar.test.tsx`；`docs/ui-spec.md` §3.6；`ADR-0093`、`ADR-0094`。
