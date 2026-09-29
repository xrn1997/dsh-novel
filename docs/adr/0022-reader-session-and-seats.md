# 阅读会话是时序的唯一持有者；单章窗口 + 只往前接，明确不做往回翻页

**第一条**：「目录 → 存档恢复 → 逐章懒加载 → 预取 → 进度落盘」的全部编排与时序住 `ReaderSession`；视图只做三件事——渲染会话状态、把 DOM 测量实现成 `ReaderPort`、把 scroll/resize 事件喂进会话。真 bug（在途被占、两帧未落定、切章强制存与防抖互踩、陈旧闭包）全住在视图的 ref 协调里，抽纯函数只是挪走复杂度、没有 seam 可测；会话持有状态与策略之后时序第一次能被单测驱动，且会话不碰 DOM ⇒ 测时序不需要 jsdom。同一时刻只允许一章在途，滚动风暴与目录直达只记意图、在途释放后补拉；刚失败过的同一章不自动重试。

**第二条**：只渲染**已载**章（未载章不进 DOM），预取目标 = 视口章之后第一个未载章，已载集裁到视口所在的连续区间。于是跳章之后往上滚没有上一章，只能走目录——**「往回翻页」判为不做，不是待排期**。

为什么：「只渲染已载章」使滚动高度恒等于已读内容高，预取判据与进度锚点（章实测高度那一跨度）才成立。回翻要么给未载章造占位高度、要么双向补载，两条都直接动摇这条不变量——代价不是多写点组件，而是预取判据、进度锚点与真浏览器位置用例全部要重证。**重开条件**：实机真出现回翻需求时另开一轮，先回答「不变量怎么办」再谈实现。

**呈现位**（同属这条决策的形状）：小说入口只挂**全局面板**一个归属——侧栏图标行与中央 keyed 面板在 `apply` 内**同批**双注册（宿主契约：选一个不存在的 main entry 会抛而不改当前选中 ⇒ 不留半注册窗口），对话区 tab 与宿主设置页区块先后撤除，双入口等于双份现场必然漂移。跨卸载要活的任务读数住在 `shell.overlay` 常驻层，因为中央呈现座位一切走就卸载面板子树，而任务在服务端照跑。住在 overlay 的三处自足约束：样式层必须自带（与视图不同分支，切走视图样式层随之消失）、默认 click-through 所以条身自己声明指针事件、层级在所有列之上故 z 序要重判。

锚点：`src/client/reader-session.ts`（`ReaderPort` / `inflight` / `pendingJump` / `settlePendingLoad` / `settleJump`）；`src/client/reader-load.ts` 头注；`src/client/progress.ts` 的 `locateChapter` / `anchorTop`；`src/client/index.tsx` 头注；`src/client/views/NovelStatusOverlay.tsx`；`tests/client/reader-session.test.ts`、`tests/client/panel-registration.test.tsx`。
