# 搜索相关性取对面那条忽略大小写的 contains：分三档、只折叠不丢弃

聚合搜索的默认视野只摆「与本轮关键词有关系」的命中，判据照对面：忽略大小写的 contains。分三档——`exact`（书名或作者整串等于规范化关键词）／`contains`（书名、作者、分类任一含关键词，或「书名 作者」这类复合关键词的任一 token 被书名含）／`suspect`（都不含）。`suspect` **只移出默认视野，一条不丢**：结果页收进组内「疑似无关」折叠，展开照旧可点；工具面 `dshnovel_search` 不返回它们——模型拿到疑似无关的长尾会当候选推荐，这正是本轮要治的症状，而折叠区随时能再问。书籍详情浮层那一次跨源搜索每源一行，档位决定谁当这一源的代表。

**补了一层对面没有的规范化**（NFKC、小写、剥空白与书名号类括号和标点）：对面假定关键词是裸书名，本仓用户输入的关键词带《》——不剥这层，contains 一条都命不中，判据形同虚设。规范化只进比较，书目字段原样带出（不净化书名/作者——矩阵行 `d-name-author-cleanup` 记的正是这条口径）。

**分类命中只放行、不升档**：`kind` 含关键词记 `contains`，不因此升成 `exact`——所以它排在任何书名/作者整串命中之后，同档之内仍按站点原序（钉子 `tests/shared/relevance.test.ts`）。这条保证是**档位级**的，不是「每个书名命中都靠前」：同档里一条分类命中完全可以排在另一条书名命中之前，那是站点给的序，本仓不替用户重排。对面把分类那一桶排在书名 contains 之前（这条偏离的读数住矩阵行 `d-search-relevance`）。本仓反过来：「玄幻」这类泛词当关键词时，按对面的序会把首屏换成整屏噪声。

**三档而非二值丢弃**：对面的过滤把不匹配的条目直接删掉，另有一个两档开关门控哪些桶留（该开关在本仓的裁决与理由住矩阵行 `d-match-mode`，本篇不复述）。本仓恒「一条不丢」：丢弃语义会把「整轮都被判掉」写成「搜了没命中」，而空结果冒充失败是本仓定的最高罪；「看到全部」的口由折叠区给，不需要一个模式输入。降噪全部落在「档位 + 折叠」这一对上，判据没有第二份：共用 `relevanceOf` / `partitionByRelevance` 的调用方里，**决定 `suspect` 去处的是三个落点**（见文末锚点段）；归并面 `mergeBooks` 也读同一份分区但只收 `kept`，不替 `suspect` 定去处。「为什么判据只许有一份」住 `src/shared/relevance.ts` 的文件头注释。

**已知不精确，刻意不补第四档**：空关键词规范化后为空串，`relevanceOf` 此时返回 `contains`——它说的不是「命中」，是「这一维不生效」（`partitionByRelevance` 把整轮全归默认视野）。后来人若想把这「一档两用」修准、加第四个值，先读这一段：不加。空串只在调用方没给关键词时出现，为它单开一档会让「没有这一维」与三种真实关系平起平坐，排序面、折叠面、工具面都得为它写分支；而现状的失效方向是安全侧——宁可整轮摆出，不把真命中判死。现状由 `tests/shared/relevance.test.ts` 钉住。

被否决的做法：

- **自造相似度阈值**（判据换成「像不像」的分数）：一个没人认领的魔法数，而对面那条 contains 已是可回查的在册判据（读数住矩阵行 `d-search-relevance`）——在册判据在场，本仓就不该另立一个量出来的数；三档枚举因此没有阈值可调。
- **把档位做成字段进契约**（`SearchHit`/`SearchGroup` 加 `relevance`）：档位是「这一轮关键词」的函数，不是命中的属性——写进快照，换词重算时上一轮的携带值就是陈旧真相。而这两个形状并不是只有搜索面在用：发现面的单源执行体与快照缓存用的正是它们（`src/services/explore.ts` 的 `fetchExploreGroup` 返回 `SearchGroup`，其下 `src/services/explore-face.ts` 的 `KindPageResult` 成功支交回 `SearchHit[]`，`src/services/explore-cache.ts` 的 `KindCache` 存的也是 `SearchGroup`），那条链却没有关键词这一维；换成刻意另立的 `ExploreBook` 要等到交进浏览器半的那一次投影（唯一主人 `src/services/explore-job.ts` 的 `booksOf`；两份形状为什么不许并成一份，口径住 `src/shared/wire.ts` 的 `ExploreBook` 注释）。字段一进，这条链就得回答「没有关键词时那一格填什么」。且 `tests/tools/schema-contract.test.ts` 编译期绑着的是 `SearchHit`/`SearchGroup` 这两份字段清单（`ExploreBook` 不在绑定的清单里），加字段＝两半同批的契约升级（`docs/adr/0019`）。判据现算即得、零成本，没有理由把答案存起来。
- **全局「显示全部」开关**：组内折叠已经是那一个口；出现第二个主人，两处口径迟早分叉。
- **cordis 配置项**：把一次呈现裁决焊成持久配置，要动 `src/config.ts` 的 schema 与 `defaults.test.ts`——把本已归一的那一处判据再交给一个持久主人。

**代价**：

- `contains` 有固有假阳：蹭名的不同书留在默认视野。本期判据不解决「像不像同一本书」——那是按书归并的事，第二批另裁。
- 「少一个虚字」的书名形态落 `suspect`（关键词「冰魔女的契约」对站点书名「冰魔女契约」即此型）。本期不预设去虚字放行；要裁，先等 `DSH_SEARCH_FILTER_AUDIT` 出读数。
- 每源 50 条截断仍在 Node 半按站点原序发生，不因相关性改——截断先于判档，档位只决定摆哪儿。

锚点：判据与档序 `src/shared/relevance.ts` 的 `relevanceOf`／`partitionByRelevance`／`RELEVANCE_RANK`／`RANKED`；形状 `Relevance` 声明在 `src/shared/wire.ts`；决定 `suspect` 去处的三个落点 `src/client/views/SearchView.tsx` 的 `renderGroups`、`src/client/views/CityBookSheet.tsx` 的 `GroupRow`、`src/tools/tools.ts` 的 `searchBooks`（工具名 `dshnovel_search`）；`partitionByRelevance` 的另一处消费方是归并面 `src/shared/merge-by-book.ts` 的 `mergeBooks`（只收 `kept`，不是第四个落点）；钉子 `tests/shared/relevance.test.ts`；矩阵行 `d-search-relevance`、`d-match-mode`（对面语义的读数与两条偏离的证据只在那两行，本篇不复述）。
