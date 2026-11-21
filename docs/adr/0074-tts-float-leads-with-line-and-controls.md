# 听书浮窗以当前句与阅读控制为主，身份退为一行小字

Status: superseded by 0079

浮窗常驻时最该被读到的是正在念的那一句和手上的控制，而不是书目身份：封面退场、书名降为一行次要小字，当前句扩成两行主字阶，浮窗只留一条章内进度条，播放环收回紧凑档。两个形态、紧凑密度、进度不撒谎与自由落位不变。背景：旧版收起胶囊里封面首字占掉一截横向空间，书名与当前句同排一级；展开边栏把封面和书名放在第一眼，当前句只剩一行小字截断，还同时摆着段内时间滑杆与章内进度细线两条进度。决定：封面退场；书名降级为身份标签；当前句升为主位并固定两行高度；只留一条章内可拖进度条；播放环收到紧凑档；形态与位置不动。被否决：保留封面只缩书名；保留两条进度条；只删上面一条、底部留只读细线；正文铺三行或让浮窗可滚；把每颗控制件都做成大命中盒；去掉书名只留章段。

锚点：`src/client/tts/TtsMiniBar.tsx`；`src/client/tts/TtsMiniPanel.tsx`；`src/client/tts/mini-parts.tsx` 的 `ChapterSeek`；`src/client/styles/tts.ts`；`tests/client/tts-mini.test.tsx`；`tests/client/tts-seek.test.tsx`；`tests/browser/tts-layout.test.tsx`；`docs/ui-spec.md` §3.6；`ADR-0073`、`ADR-0075`。
