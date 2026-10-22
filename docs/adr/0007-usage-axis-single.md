# 一条 `usage`（取值用途）轴贯穿全部分派，不许长出第二份判据

Status: accepted

对面本来就是 `getString` / `getElements` 两条路，形状天然不同。本仓把它收成**一条由调用方显式声明的轴**（`ParsedRule.usage`，缺省 `'list'`），三处依赖它的语义都读同一个值：① 链尾未知词是 HTML 属性名还是 CSS 选择器；② 组合符 `&&` / `%%` 的合并形状与驱动长度；③ js 段 `result` 绑成元素集合还是字符串。链尾剩节点集在取值用途下逐元素 outerHTML 换行拼接（串化先于 `##` 替换），所以取值出口从不因「剩节点集」而失败。

递归求值口（`java.getString*` / `getElements` / `getElement` / 模板 `{{…}}` / `@put` 的值）同样由调用方显式交 usage：java 桥与 `@put` 经求值层的 `evaluateRef`，模板插值直接定档；判据单点是 `engine/sub-rule.ts` 的 `usageOfSubRule`：每条非空分支都以**显式**取值尾（`@` 切出的属性终端与 `text` / `html` 那一类，或 js / 变量 / 字面段 / 行模板）收尾才用 `'value'`，其余用 `'list'`（单段默认尾只有在分支确实被 `@` 切成多段、或整条规则单分支且以显式 `@` 开头时才算显式；多分支里的单段 `@` 头不单独升级）；`getElements` / `getElement` 恒 `'list'`。判据自己先在 `'value'` 形态解析一次：解析失败就落 `'list'`，错误留给真正的求值入口带段级定位抛出（分类器不抢先判死）。链首 `+`（列表入口标记，value 用途不认）与 `@`（显式取值头）两判与 `parseRule` ③/③b 的剥除共读 `engine/grammar.ts` 那一份词法。

**这一条比对面窄，是刻意偏离**：对面 `AnalyzeByJSoup` 的取值口（`getResultList` → `getResultLast`）把 `@` 切分后的最后一段**无条件**当取值段——认不出就当属性名读，规则里没有 `@` 时整条规则就是那最后一段，所以对面 `java.getString("div.item")` 读出空白。本仓把裸选择留在 `'list'`，是因为这类子规则在既有读数里产出的是元素内容：全按对面收，单词形链尾会被打成属性空值、仍按 CSS 认出的选择器会被串成 outerHTML，把已经出正文、出条目的源洗成空。分档形状与后果记在矩阵行 `h-sub-rule-usage`，钉子是 `tests/engine/sub-rule-usage.test.ts`。

动机：自建第三份判据（按值 kind 猜、或在 combine / sandbox 各写一份）会让同一个分派随链长与分支顺序漂移。列表用途下前一段零命中时 `result` **仍是空元素集**（`size()` / `toArray()` 照样在）——退化成原文字符串会让真源共用的 toc 模板第一行就抛沙箱错误，把「站点页面没有这个结构」这个**站点侧事实记成引擎侧失败**，污染判据分母。

被否决的方案：① 链尾未知词一律按属性终端（列表规则链尾的选择器会被打成属性）；② 组合符「谁有用取谁」跳过不匹配的一侧，或把字符串分支按 HTML 解析成节点再合并（混形状在对面没有对应语义，静默丢一侧正是最高罪）；③ 中链把节点集串化（串化只在链尾一处）；④ 服务层值投影抛「结果不是取值而是节点集」（该抛错零测试、把合法规则记成引擎失败，现降级为误用闸口）；⑤ 链首裸取值终端用 `$('*')`（每个祖先各出一份文本，真源 `chapterName: "text"` 实测章名三遍）；⑥ 子规则一律按 `'value'` 收（对面尾段确实无条件走取值出口，但本仓的取值出口把剩节点集串成 outerHTML，等于把裸选择子规则从「读元素内容」洗成「读外层标签」，再把单词形链尾洗成属性空值——那是一次全量读数迁移，不是补轴）。

锚点：`src/engine/types.ts` 的 `RuleUsage`；`classifyDefault`；`src/engine/grammar.ts` 的 `stripChainPrefixes` / `hasListEntryMarker` / `hasExplicitValueHead`；`src/engine/combine.ts` 的 `CombineOpts.usage`；`src/engine/evaluate.ts` 的 `finalize` / `jsHostOf` / `evaluateRef` / 模板插值 `interpolateTemplate`；`src/engine/js-sandbox.ts` 的 `wrapElems` / `EvaluateRef`；`src/engine/js-protocol.ts` 的 `evalRule`；`src/engine/select.ts` 的 `isValueTerminal`；`src/engine/sub-rule.ts` 的 `usageOfSubRule`；`tests/engine/sub-rule-usage.test.ts`、`tests/engine/evaluate-sync-loop.test.ts`；矩阵行 `a-rule-usage-axis`、`h-result-binding`、`h-list-context-collection`、`h-get-string-recursive`、`h-sub-rule-usage`。
