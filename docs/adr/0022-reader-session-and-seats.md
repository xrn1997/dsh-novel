# 阅读会话是时序的唯一持有者；单章窗口 + 只往前接，明确不做往回翻页

Status: superseded by 0084

「目录 → 存档恢复 → 逐章懒加载 → 预取 → 进度落盘」的全部编排与时序住 `ReaderSession`，视图只渲染状态、实现 `ReaderPort` 测量、把 scroll/resize 事件喂进会话；会话不碰 DOM，时序第一次能被单测驱动。同一时刻只允许一章在途，滚动风暴与目录直达只记意图，刚失败过的同一章不自动重试。只渲染**已载**章，已载集裁到视口所在的连续区间，预取目标 = 视口章之后第一个未载章——「只渲染已载章」使滚动高度恒等于已读内容高，预取判据与进度锚点才成立，所以**完整的「往回翻页」判为不做，不是待排期**（要造占位高度或双向补载，整条不变量与真浏览器位置用例都要重证）；重开条件：实机真出现回翻需求时另开一轮，先答「不变量怎么办」再谈实现。呈现位只挂**全局面板**一个归属：侧栏图标行与中央 keyed 面板同批双注册；跨卸载要活的任务读数住 `shell.overlay` 常驻层（样式自带、条身自声明指针事件、z 序自判）。

锚点：`src/client/reader-session.ts`（`ReaderPort` / `inflight` / `pendingJump` / `settlePendingLoad` / `afterRender`）；`src/client/reader-load.ts` 头注；`src/client/progress.ts` 的 `locateChapter` / `anchorTop`；`src/client/index.tsx` 头注；`src/client/views/NovelStatusOverlay.tsx`；`tests/client/reader-session.test.ts`、`tests/client/panel-registration.test.tsx`。
