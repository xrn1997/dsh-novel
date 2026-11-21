# 阅读器的渲染后拍点与 DOM 绑定归一个绑定 module，会话仍是时序唯一持有者

Status: accepted

阅读器的「什么时候算一次提交、测量排在哪个帧、测量前先刷新滚动端口、视口事件怎么装摘、阅读探针怎么注册、拍点后回调的次序」从视图搬进一个专门的绑定 module。会话仍拥有全部时序（目录 → 存档恢复 → 逐章懒加载 → 预取 → 进度落盘）且仍然不碰 DOM；视图只渲染会话状态、保留标记结构与纯 UI 策略，并在每次渲染后调一个无条件的门。此前拍点触发是视图的 `useEffect` 依赖数组，真正的规则只活在两个文件的注释里——任何影响布局的新状态不加进数组就静默漏拍。

## 决定

- **时序仍归会话**：`ReaderSession` 拥有章节窗口、落位与滚动补偿、预取与回溯补载、进度落盘的编排；`afterRender` 仍是它的一次拍点命令。会话不读 DOM、不认识事件。
- **提交判定与 DOM 绑定归绑定 module**：`client/reader-binding.ts` 拥有（a）这一帧要不要测量——比较 `state.domRevision` 与上次量过的版本；（b）帧泵（生产 rAF、测试手动泵；同版多帧合并成一次）；（c）帧体先找/刷新滚动端口，再让会话读视口；（d）scroll / resize / 内容尺寸变化并进 `feedViewport`；（e）挂载时注册、卸载时注销阅读探针；（f）拍点后回调在同一次测量里、`afterRender` 之后跑。
- **「什么算一次需要重测的提交」由会话定义**：`state.domRevision` 在章节窗口换版与置待定位目标时各 +1；清目标不推进。待定位目标不是公开渲染态。
- **视图的调用面是一道门**：每次渲染后调 `rendered(revision, after?)`，未挂载时只记版本、挂载那一步自己拍第一帧。
- **只渲染已载章、单章窗口、只往前接**：往回翻页仍是明确不做（「只渲染已载章」使滚动高度恒等于已读内容高，预取判据与进度锚点才成立）。
- **呈现位不变**：小说入口仍只挂全局面板一个归属；跨卸载要活的任务读数仍住 `shell.overlay` 常驻层。

## 被否方案

- 留在视图，把规则写进注释：漏一条影响布局的新状态不会以任何形式报错。
- 把绑定塞进会话：会话一旦碰 DOM，「测时序不需要 jsdom」这条性质就没了。
- 让视图显式列全所有影响布局的状态：枚举必漏，且「哪些状态影响布局」是会话自己的知识。
- 每次渲染都无条件测量：测量读几何、触发重排，滚动帧密集时开销不可接受。

## 边界

- 几何语义仍归 `client/reader-geometry.ts` 的 `ReaderPort`；绑定只负责刷新它的元素来源与端口。
- 阅读场景仍归 `client/reader-scene.ts`；浮层至多一角仍归 `client/reader-surfaces.ts`。
- 「视口顶落在哪一项」的判据归 `client/viewport-top.ts` 的 `crossedIndex`；顶条遮挡的读数裁决在 `ADR-0089`。

## 代价

多一层间接，且会话状态多一格 DOM 版本。绑定必须对「挂载前渲染」与「同版多帧渲染」都幂等。收益是拍点规则第一次有单一主人、可在无 jsdom 的假环境里钉住。

锚点：`src/client/reader-binding.ts` 的 `ReaderBinding` / `ReaderElementSource` / `ReaderFrameScheduler` / `ReaderDomTarget` / `ReaderBindingHost` / `rendered` / `mount` / `unmount`；`src/client/reader-session.ts` 的 `ReaderSessionState.domRevision` / `afterRender` / `feedViewport` / `ReaderPort`；`src/client/views/ReaderView.tsx`；`src/client/viewport-top.ts` 的 `crossedIndex`；`tests/client/reader-binding.test.ts`、`tests/client/viewport-top.test.ts`、`tests/client/reader-session.test.ts`；`ADR-0045`、`ADR-0091`。
