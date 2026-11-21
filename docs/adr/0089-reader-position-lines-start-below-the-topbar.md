# 阅读位置按「看得见的顶」算：顶条遮挡一份读数、夹取一份实现，存取落位探针同口径

Status: accepted

阅读器顶条是 sticky 覆盖层——它盖住视口最上面约一行，内容并不从它下面排起。阅读位置的**读**（进度与当前章）与**落**（恢复、跳章、排版复位、探针起播）从此吃同一个「让开顶条后的视口顶」：只让落位不让读数，每进一次阅读器位置就多漂一条条高；只让读数不让落位，听书恢复要念的那一段首正好藏进顶条里。

## 决定

- **遮挡读数只有一个来源**：`ReaderView` 的 `topInset` 现量 sticky 顶条的实际高，经会话依赖束、绑定选项与几何源注入。每次现量、不缓存——条高随排版与宿主缩放变。
- **夹取判据唯一实现**：遮挡进判据线前统一过 `client/viewport-top.ts` 的 `clampTopInset`（非负，缺席 = 0）；消费点不许再各自 `Math.max(0, …)` 抄一遍。
- **存与取是同一条算式的两头**：读数 = 滚动位 + 遮挡（`contentTop` 喂 `locateChapter`），落位 = 目标偏移 − 遮挡（恢复、`settleJump` 与目录/内链跳转同式）。两头同值时比例不产生漂移：恢复落位后的那次重读必须不再触发第二笔进度写。
- **导航高亮吃同一份**：`activeNavId` 的越过判据是 `off <= inset`——目标还压在遮挡带里不算滚过去。
- **数据路保持各自载体**：锚点路、节点 rect 路、块 rect 路各算各的；本篇统一的是「视口顶」读数的遮挡口径，不是三条路的采集方式。

## 被否方案

- 不吃遮挡（按裸视口顶算）：落盘读数落进被顶条盖住的那一行，听书从看不见的行起播。
- 只给恢复落位让位、不给读数让位：比例随之漂移，且每进一次阅读器多漂一条条高。
- 顶条改成参与布局：条高变化就是已载内容的布局位移，锚点重测、预取判据与进度锚点都要跟着重算。
- 各消费点各夹各的：判据出现第二份抄本的那一刻，翻案要改的就不止一处。

锚点：`src/client/viewport-top.ts` 的 `clampTopInset`；`src/client/reader-session.ts` 的 `topInset` / `contentTop` / `activeNavId` / `settleJump`；`src/client/views/ReaderView.tsx` 的 `topInset`；`src/client/reader-binding.ts` 与 `src/client/reader-geometry.ts` 的 `currentNodeOf`；`tests/client/viewport-top.test.ts`；`tests/client/reader-session.test.ts`；`docs/ui-spec.md` §3.5；`ADR-0084`。
