# 阅读场景是 session 外的命令式 controller

Status: accepted

surface、注释载荷、返回句柄、Esc 归属、离开一问与入架写入此前是 `ReaderView` 里互相咬合的一组 state 与闭包，证明这些律要整页渲染并伪造几何。现在它们归 `reader-scene` 的命令式 controller；视图只渲染与接线，阅读时序仍归 `ReaderSession`。

## 边界
- `ReaderSession` 仍独占目录→恢复→懒加载→预取→进度落盘的时序。
- `reader-surfaces` 仍独占「至多一角」与退场语义的纯判据。
- 带遮罩的入架一问仍走 `client/views/dialog.tsx` 的模态契约。

## 被否方案
- 把场景做成 reducer / 状态机框架：ADR-0037 已否决，真正的 bug 在判据住址，不在调度形式。
- 把浮层与场景塞进 `ReaderSession`：会话会为视图长出只有它用的格，时序与界面在场混成一份真相。

锚点：`src/client/reader-scene.ts` 的 `ReaderScene`；`tests/client/reader-scene.test.ts`；`src/client/views/ReaderView.tsx` 的 scene 接线。
