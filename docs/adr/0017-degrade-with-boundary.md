# 留痕但不放大故障——以及这条口径的边界（它没有被放宽成「什么都吞」）

三处**刻意的降级 + warn**：① URL 选项不是合法 JSON → 无选项发出（URL 已无条件切分，站点至少还能答）；② `bookUrlPattern` 编译不过 → 按未声明处理，其余一切照旧（一条源自己写歪的正则不该让它的搜索面整体不可用）；③ 动态请求头规则求值抛错或产物不是 JSON 对象 → 回退静态头，不吞请求也不炸整条链。

**边界必须一起读**，否则这一条会被推成「什么都可以吞」：
- 辅助元数据五项（kind / wordCount / lastChapter / intro / coverUrl）按字段级吞错，**name / author / bookUrl / tocUrl 四项不吞**——求值失败上抛、整组报错。接入一个辅助字段反而造出欠账（一条坏简介规则让整页书目消失）是真实错配。
- 逐章回退只服务「个别条目缺链接」；**每一条都回退 = `ruleChapterUrl` 整体失效** → 抛错点名规则与回退条数（静默产出 N 条指向目录页自身的 toc 是拿合法形状冒充成功）。
- 零命中不得静默：正文规则取到空文本 → 抛并带落点，且不写缓存；缓存里的空正文一律当未命中。**适用面已由 `docs/adr/0031` 收窄到首屏**（跟进链上的续页取空按到底收手，不抛）。
- 认不出的语法解析期抛；Miss 与空 List 绝不折叠（见 `docs/adr/0001`、`docs/adr/0002`）。

同族的一条不对称，看起来像两处实现不一致，其实是刻意的：**详情页嗅探的结论按「猜测」对待**。`ruleBookInfo.init` 取空在搜索面（嗅探来的「这是详情页」）= **没有书目**，不把一次正常的「这个词没搜到」升级成整源错误；在 `getDetail`（用户真的在读书的详情面）= **必须抛**，不拿整页冒充上下文。嗅探判定只有一份、住在搜索面，两个 adapter 不各写一份；且判据是**整串锚定**而非 JS `RegExp.test` 的子串语义（子串会把搜索结果页误判成详情页）。探针侧同样分岔：`info ∧ via='pattern'` 才按详情规则判书名；`info ∧ via='empty-list'` 与零条目同义，照旧换词重试——把它当 verified 等于用一次空响应洗白一个坏源。

锚点：`src/services/bridge.ts` 的 `metaFieldOf` / `detailFieldsOf` / `detailContextOf` / `resolveHeaders`；`src/services/search-face.ts` 的 `patternOf` / `canInfo`；`src/services/probe.ts` 的 `via` 分岔；`src/services/reading.ts` 的 `getTocInner` / `getChapter`；`tests/services/reading.test.ts`。
