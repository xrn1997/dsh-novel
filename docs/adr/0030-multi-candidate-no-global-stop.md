# 多候选翻页里「整页零新增」不是一条全局闸：队列点完才叫到底

Status: accepted

`followPages` 的 `zero-new` 与 `loop` 两闸只在**链式单候选**那侧生效；一次列出多个分页的**多候选**模式下，某一候选页零条目或整页与别页重复，只跳过它自己，队列里其余分页照常抓，`stoppedBy` 停回 `end`。**为什么**：多候选的语义是「这一页已经把同组各分页列全了」，而这一组里出现与入口页内容相同的页是常态（书籍详情页自己就列着第 1 页）；把链式那侧的「整页零新增 = 回环/软404」套过来，`break` 掉的是整个循环，第一个重复页把后面所有分页一起带走。**这不是放宽早停**：链式那侧两闸一字未动，改的只是适用范围——它们描述的是「下一页」这条链，不描述「同组分页清单」。被否决：给重复页加页数上限或「前 K 页容错」（拿参数冒充判据）；多候选也判 loop 但改成 `continue`（报 `loop` 会让读的人以为站点在发重复页）；抓取层比对两页正文相同就丢。**代价**：多候选模式下重复/空页不再提前收手，一轮目录会把规则列出的每个分页都打一遍，换来的是「少掉的章不靠运气」。

锚点：`src/services/pagination.ts` 的 `followPages` 与 `FollowResult.stoppedBy`；`src/services/online-reading.ts` 的 `followOrSingle`；`tests/services/pagination.test.ts` 的「多候选：某一候选与入口页整页重复 → 其余候选照抓」；矩阵行 `f-toc-paging`、`g-chapter-boundary-guard`。
