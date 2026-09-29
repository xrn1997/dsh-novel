# 一条 `usage`（取值用途）轴贯穿全部分派，不许长出第二份判据

对面本来就是 `getString` / `getElements` 两条路，形状天然不同。本仓把它收成**一条由调用方显式声明的轴**（`ParsedRule.usage`，缺省 `'list'`），三处依赖它的语义都读同一个值：① 链尾未知词是 HTML 属性名还是 CSS 选择器；② 组合符 `&&` / `%%` 的合并形状与驱动长度；③ js 段 `result` 绑成元素集合还是字符串。链尾剩节点集在取值用途下逐元素 outerHTML 换行拼接（串化先于 `##` 替换），所以取值出口从不因「剩节点集」而失败。

动机：自建第三份判据（按值 kind 猜、或在 combine / sandbox 各写一份）会让同一个分派随链长与分支顺序漂移。列表用途下前一段零命中时 `result` **仍是空元素集**（`size()` / `toArray()` 照样在）——退化成原文字符串会让真源共用的 toc 模板第一行就抛沙箱错误，把「站点页面没有这个结构」这个**站点侧事实记成引擎侧失败**，污染判据分母。

被否决的方案：① 链尾未知词一律按属性终端（列表规则链尾的选择器会被打成属性）；② 组合符「谁有用取谁」跳过不匹配的一侧，或把字符串分支按 HTML 解析成节点再合并（混形状在对面没有对应语义，静默丢一侧正是最高罪）；③ 中链把节点集串化（串化只在链尾一处）；④ 服务层值投影抛「结果不是取值而是节点集」（该抛错零测试、把合法规则记成引擎失败，现降级为误用闸口）；⑤ 链首裸取值终端用 `$('*')`（每个祖先各出一份文本，真源 `chapterName: "text"` 实测章名三遍）。

锚点：`src/engine/types.ts` 的 `RuleUsage`；`classifyDefault`；`src/engine/combine.ts` 的 `CombineOpts.usage`；`src/engine/evaluate.ts` 的 `finalize` / `jsHostOf`；`src/engine/js-sandbox.ts` 的 `wrapElems`；矩阵行 `a-rule-usage-axis`、`h-result-binding`、`h-list-context-collection`。
