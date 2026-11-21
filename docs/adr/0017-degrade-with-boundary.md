# 留痕但不放大故障——以及这条口径的边界（它没有被放宽成「什么都吞」）

Status: accepted

三处**刻意的降级 + warn**：URL 选项不是合法 JSON → 无选项发出；`bookUrlPattern` 编译不过 → 按未声明处理；动态请求头规则求值抛错或产物不是 JSON 对象 → 回退静态头。**边界必须一起读**：辅助元数据五项（kind / wordCount / lastChapter / intro / coverUrl）按字段级吞错，**name / author / bookUrl / tocUrl 四项不吞**；逐章回退只服务「个别条目缺链接」，每一条都回退 = `ruleChapterUrl` 整体失效 → 抛错点名；零命中不得静默（正文规则取空文本抛并带落点、不写缓存），适用面由 `ADR-0031` 收窄到首屏；认不出的语法解析期抛，Miss 与空 List 绝不折叠。同族的不对称是刻意的：**详情页嗅探的结论按「猜测」对待**——`ruleBookInfo.init` 取空在搜索面 = 没有书目，在 `getDetail` = 必须抛；嗅探判定只有一份、住搜索面，且是**整串锚定**而非子串语义。探针侧同样分岔：`info ∧ via='pattern'` 才按详情规则判书名；`via='empty-list'` 与零条目同义。**磁盘侧失败不冒充站点判据**：批量验证里站点判据先记账、状态写回另接一手，`edit` 的落盘失败只进任务读数，不折成「这一家 broken」、不占 `counts.failed`。

锚点：`src/services/bridge.ts` 的 `metaFieldOf` / `detailFieldsOf` / `detailContextOf`；`src/services/source-eval.ts` 的 `resolveHeaders`；`src/services/search-face.ts` 的 `patternOf` / `canInfo`；`src/services/probe.ts` 的 `via` 分岔；`src/services/import-job.ts`；`src/services/online-reading.ts` 的 `OnlineReading`；`tests/services/reading.test.ts`、`tests/services/online-reading.test.ts`、`tests/services/import-job.test.ts`。
