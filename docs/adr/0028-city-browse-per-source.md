# 书城浏览轴从并集词表改成「先点名一个源、逛它自己的分类」

Status: accepted

书城的浏览轴从「各源分类入口的精确同名并集」改成「先点名一个源、逛它自己的分类」；跨源视野从浏览面撤走，改由书籍详情浮层里一次**手动**聚合搜索承担。并集词表不是没用的中间层，是读不了的一长串：本仓刻意不造同义词表，于是并集里绝大多数词条只挂一个源，左栏退化成没人读的清单，而「某一类到底是谁家的」得靠用户看计数反推；一个源的分类清单只有挂在这个源上才是答案。被否决：并集 + 按源数阈值裁切（把某一次导入的形状焊成规则）；并集 / 单源双档并存（同一个面板两套心智模型）；分组→源两级（每次换源多点一下，分组是书源包作者手写的、质不统一）；卡片直接进阅读（简介、加入书架、跨源三个动作无处放）。**代价**：「同一本书在几个源上」不再是浏览面的一等信息，变成一次要主动发起的搜索；服务端搜索槽只有一个，书城浮层发起的搜索会换掉搜索面持有的那一轮（既有「跟随最近一轮」的另一处落点）；发现面的跨源合成书单随轴下线，与 `ADR-0033` 在**搜索面**新建的呈现层归并不同面、不冲突。本篇不推翻 `ADR-0027`：那篇讲发现面接哪几种形态，本篇讲接进来之后按什么轴逛。

锚点：`src/shared/wire.ts` 的 `ExploreSources`；`src/services/explore.ts` 的 `deriveExploreSources`；`src/services/participation.ts` 的 `exploreParticipates`；`src/client/city-view-model.ts` 的 `sheetKeyword`；`src/client/views/CityView.tsx`；`src/client/views/CityBookSheet.tsx`；矩阵行 `c-explore-url`、`d-explore-three-forms`。
