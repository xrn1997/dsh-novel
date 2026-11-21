# 跟读高亮只标记不滚动，定位是一次显式动作

Status: superseded by 0091

听书播放时在正文里标记正在被念的那一段（换字色 + 段首小三角），但**不自动滚动跟随**；要把视野带到正在念的段，由听书条上「定位到正在念的段」这颗显式按钮完成。自动跟随滚动会经阅读会话的滚动防抖把视口位置写成共用进度，与播放层自己的落盘节拍互相覆盖。定位只滚阅读滚动容器自己；目标章未载时先走一次显式跳章再居中。命中判据只有一份：段号 → 正文块归 `paragraphSlotOf`。被否决：自动滚动跟随播放；高亮时顺手写阅读进度；按句高亮（字节型音频没有句级时间戳，按字数比例切句是假精度）。

锚点：`src/client/views/ChapterBody.tsx` 的 `listenParagraph`；`src/client/tts/reading-position.ts` 的 `paragraphSlotOf` / `listenParagraphElement`；`src/client/views/ReaderView.tsx` 的 `locateListen`；`src/client/styles/reader.ts` 的 `.novel-tts-live`；`tests/client/tts-seek.test.tsx`；`docs/ui-spec.md` §3.6；`ADR-0070`、`ADR-0072`、`ADR-0076`、`ADR-0078`。
