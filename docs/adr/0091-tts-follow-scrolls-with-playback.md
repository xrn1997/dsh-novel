# 跟读随播放推进带视口走，用户手动滚动即让位

Status: superseded by 0096

阅读器里听本书时，播放推进到新段 / 新章会把视口带到正在念的段；目标已在看得见的正文带里就不动，离开才居中。读者手动滚动（滚轮 / 触摸 / 滚动键 / 滚动条拖动）或点目录 / 内链后跟随让位，按听书条的「定位到正在念的段」重新接上。这翻掉 `ADR-0071` 的「只标记不滚动」。被否决：始终跟随、用户滚动后仍在下一段拽回；逐段无条件居中；新增「跟随听书」开关；平滑滚动动画；把跟随写进高亮。代价：跟随与播放各自触发一笔位置落盘，短时间内可能双写；视口每离开一次正文带就跳一次；让位后不会自己回来。

锚点：`src/client/tts/follow-controller.ts` 的 `createFollowController` / `onPlayback` / `onLocate` / `onUserIntent` / `onRelocation`；`src/client/views/ReaderView.tsx` 的 `takeOverReading` / `locateListen` / `followBottomInset`；`src/client/reader-session.ts` 的 `reveal` / `settleReveal` / `cancelJump`；`src/client/reader-binding.ts` 的 `ReaderViewportHandlers.intent` / `ReaderBindingOptions.onUserIntent`；`tests/client/tts-seek.test.tsx`；`tests/client/reader-session.test.ts`；`docs/ui-spec.md` §3.6；`ADR-0071`（被本篇取代）、`ADR-0076`、`ADR-0078`、`ADR-0096`（被本篇承接）。
