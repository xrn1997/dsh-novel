# legado 的发现入口只接声明式两档，脚本档后置

Status: accepted

legado 的 `exploreUrl` 接**声明式两档**：`标题::URL` 多行（条目分隔是 `(&&|\n)+`，每条按 `::` 切后只取前两段）与 JSON 条目数组（每项 `title` + `url`）。**脚本档（`@js:` / `<js>`）后置**：解析器如实返回空并把形态交回调用方，导入侧点名「该源在书城无分类入口」，不静默当成「这源没有分类」。条目规则 `ruleExplore` 沿用与原生 `ruleFind` 同一套覆盖口径：判据只看列表规则一条，缺席就**整套**改用通用搜索规则，在场就整套用它——不逐字段回落。两方言落位后是同一个形状，差别只在地址语义：原生地址是填进源级模板 `{{kind}}` 的值，legado 地址本身就是那一类的完整模板；「用哪份模板」「首页裁不裁页码」跟着模板主人走。被否决：三形态一次做完（脚本档要先裁「什么时候重算分类」，而本仓缓存口径是指纹入文件名、不设清缓存出口）；只做原生不动 legado；`ruleExplore` 逐字段回落；认 `{标题: URL}` 对象形态。**代价**：分类词表是各站自造词的并集，不造同义词表、不按声明源数设门槛；词表规模由按源浏览 + 词表筛选框承担。**重开条件**（脚本档）：出现一条真要靠脚本才拿得到分类的常用源，并且「什么时候重算分类、由谁触发」先单独裁下来。

锚点：`src/services/explore-url.ts` 的 `parseExploreKinds` / `exploreKindsFormOf`；`src/services/normalize.ts` 的 `flattenDialect` / `rawExploreFields`；`src/services/bridge.ts` 的 `hitRuleOf`；`src/services/explore-face.ts` 的 `fetchKindPage`；`src/services/participation.ts` 的 `exploreParticipates`；矩阵行 `c-explore-url`、`d-explore-three-forms`、`d-explore-fallback-search-rule`、`h-source-refresh-explore`。
