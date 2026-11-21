# 阅读器听书条也只留章内一条进度，段内时间滑杆退场

Status: accepted

听书条底部的两条进度里，段内时间滑杆只回答「这一句念到哪」，却要读者先分辨哪条能拖；听书的位置与导航本来就是段粒度，一条章内段滑杆就够。段内时间滑杆从阅读器条退场，段内定位这项能力随之不做。

## 决定

- **阅读器听书条只留章内段滑杆**：末行整宽，拖到任意段即起播，空章不渲染；与浮窗的章内进度条同粒度。
- **段内时间滑杆从条上退场**：`SegmentSeek`、`.novel-tts-seek` 一族样式与「本段进度」文案一并删除；没有入口的 `seekWithinParagraph` 也一并删除。
- **段进度读数不删**：浮窗的进度环与章内进度条仍读 `ttsProgress`；条上不再显示 `m:ss` 读数，正文也不再画段内细线。

## 边界

- 段内 seek 从界面退场。暂停续播仍在段内原地接上——那是播放层的现场，不是用户导航；要从长段中间听起只能整段跳过去。
- 章内进度条仍是段粒度，不冒充段内计时；听书位置仍按段落盘。

## 代价

长段里想从中间听起时只能整段跳。段内进度已由浮窗的进度环与章内进度条表达，不需要在条上再养一条可拖的轴。

## 被否方案

- 只在阅读器条保留段内时间滑杆：两条并排，读者仍要先分辨哪条能拖。
- 把段内时间滑杆调细或缩窄：问题不在粗细，而在它是另一套粒度。
- 保留只读的 `m:ss` 读数：没有导航能力，只是多一行数字。
- 让章内段滑杆兼任段内定位：同一条控件两种刻度，读者又要先判断当前刻度。

锚点：`src/client/tts/TtsBar.tsx` 的 `TtsBar`；`src/client/tts/player.ts` 的 `ttsProgress` / `seekParagraph`；`src/client/tts/mini-parts.tsx` 的 `RingPlay` / `ChapterSeek`；`src/client/styles/tts.ts` 的 `.novel-tts-chapter-seek`；`tests/client/tts-seek.test.tsx`；`tests/browser/tts-layout.test.tsx`；`docs/ui-spec.md` §3.6；`ADR-0074`。
