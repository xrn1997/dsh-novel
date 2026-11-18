# 听书上屏读数是播放层成品事实的整块投影，判据不再住在各表面

Status: accepted

同一份会话状态被听书条、迷你条胶囊、展开边栏与设置面各自解释：段号换算、定时读数、章内进度与连败阈值各有一份算法，「可暂停」判据也在各组件里重复。决定把上屏读数的换算收进一个零 React 的投影 module，播放层只公布成品事实，表面只取成品、不比较计数与阈值。

## 决定

- **播放层公布成品事实**：`TtsPlayerState` 直接带 `halt`（连败停的可见读数）、`segmentProgress`（有没有段内计时介质）与 `voiceTable`（该露哪张音色表）——阈值比较、空章判断与模式分支的结论在播放层算一次，表面不再拿 `consecutiveFailures` 与阈值对比、也不拿模式猜。
- **读数是整块投影**：`listen-readout.ts` 的 `listenFaceOf` 一次交出 `busy` / `failedHint` / `hasSegments` / `hasProgress` / `voiceTable`；各表面与阅读器只读这一份。段读数、定时读数、章内进度、语速与当前句也各有唯一换算函数，表面不重算。
- **读数是叶子**：`listen-readout.ts` 零 React、零 store 读取、不读墙钟（`now` 由调用方注入），状态以结构子集入参，不 import `player.ts`——任何取读数的文件不必连带背上整台状态机。
- **「可暂停」只有一处判据**：`isPlayBusy` = 在放 ∨ 准备中；播放环、条按钮、键盘与阅读器 pill 共用它。

## 被否方案

- **每个表面各取所需、各自解释**：同一读数多套公式，改一处口径要逐表面找；连败阈值与空章判断各存一份，漂移时只表现为某一面说错了话。
- **让表面比较原始计数**：阈值是播放层的知识，表面拿到 `consecutiveFailures` 就会自己定线，终有一面先改。
- **把读数的状态子集换成整份 `TtsPlayerState`**：读数是播放层之外的叶子也要取的函数，整份类型会把播放层的 store 与状态机拖进依赖图。

## 边界

- 读数只消费播放层已经公布的成品事实；阈值、连败计数、空章与模式判据仍归 `listen-session.ts`（`segmentFailed` 公布 `halt`）。
- 表面仍拥有呈现结构与交互接线；「这一段怎么出声」归 `playback-branches.ts`（`ADR-0087`）。
- 定时读数的每秒节拍由各表面的呈现驱动注入 `now`，本模块不持有定时器。

## 代价

多一层投影与几个公布字段；换来的是一份读数口径只住一处，各表面与测试钉同一份映射。播放层新增一个上屏事实要先在状态里公布，不能由表面临时推导。

锚点：`src/client/tts/listen-readout.ts` 的 `listenFaceOf` / `isPlayBusy` / `ListenFace` / `ListenReadoutState`；成品事实的公布处 `src/client/tts/listen-session.ts` 的 `halt` / `segmentProgress` / `voiceTable` / `segmentFailed`；表面 `src/client/tts/TtsBar.tsx` / `TtsMiniBar.tsx` / `TtsMiniPanel.tsx` / `TtsSettings.tsx` / `mini-parts.tsx`；钉子 `tests/client/tts-readout.test.ts`、`tests/client/tts-mini.test.tsx`、`tests/client/tts-session.test.ts`；`ADR-0077`（失败半径）、`ADR-0087`（出声分支策略）。
