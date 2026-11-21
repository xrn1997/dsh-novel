# 搜索相关性取忽略大小写的 contains：分三档、只折叠不丢弃

Status: accepted

聚合搜索的默认视野只摆与本轮关键词有关系的命中，判据是忽略大小写的 contains。分三档：`exact`（书名或作者整串等于规范化关键词）／`contains`（书名、作者、分类任一含关键词，或复合关键词的任一 token 被书名含）／`suspect`（都不含）。`suspect` **只移出默认视野，一条不丢**：结果页收进组内「疑似无关」折叠，工具面不返回它们（模型会把疑似无关的长尾当候选推荐），书籍详情浮层那一次跨源搜索里档位决定谁当这一源的代表。**本仓多一层规范化**（NFKC、小写、剥空白与书名号类括号和标点）：contains 判据假定裸书名，而用户输入带《》；规范化只进比较，书目字段原样带出。**分类命中只放行、不升档**：`kind` 含关键词记 `contains`，不升 `exact`，所以排在任何书名/作者整串命中之后、同档仍按站点原序。**三档而非二值丢弃**：丢弃会把「整轮都被判掉」写成「搜了没命中」；降噪落在「档位 + 折叠」这一对，判据没有第二份。**已知不精确，刻意不补第四档**：空关键词规范化后为空串，`relevanceOf` 返回 `contains`——它说的是「这一维不生效」，失效方向安全（宁可整轮摆出，不把真命中判死）。被否决：自造相似度阈值；把档位做成字段进契约（档位是「这一轮关键词」的函数，写进快照就是陈旧真相）；全局「显示全部」开关；做成宿主配置项。**代价**：`contains` 有固有假阳；「少一个虚字」的书名落 `suspect`，不预设去虚字放行；每源 50 条截断仍在 Node 半按站点原序发生，截断先于判档。

锚点：`src/shared/relevance.ts` 的 `relevanceOf` / `partitionByRelevance` / `RELEVANCE_RANK`；形状 `Relevance` 在 `src/shared/wire.ts`；`suspect` 去处的三个落点 `src/client/views/SearchView.tsx` 的 `renderGroups`、`src/client/views/CityBookSheet.tsx` 的 `GroupRow`、`src/tools/tools.ts` 的 `searchBooks`；`src/shared/merge-by-book.ts` 的 `mergeBooks`（只收 `kept`）；`tests/shared/relevance.test.ts`；矩阵行 `d-search-relevance`、`d-match-mode`。
