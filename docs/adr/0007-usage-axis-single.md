# 一条 `usage`（取值用途）轴贯穿全部分派，不许长出第二份判据

Status: accepted

取值与列表两个形状天然不同，本仓把它们收成**一条由调用方显式声明的轴**（`ParsedRule.usage`，缺省 `'list'`），三处依赖它的语义读同一个值：链尾未知词是 HTML 属性名还是 CSS 选择器；组合符 `&&` / `%%` 的合并形状与驱动长度；js 段 `result` 绑成元素集合还是字符串。链尾剩节点集在取值用途下逐元素 outerHTML 换行拼接（串化先于 `##` 替换），取值出口从不因「剩节点集」而失败。递归求值口（`java.getString*` / `getElements` / `getElement` / 模板 `{{…}}` / `@put` 的值）同样由求值体携带 usage，判据单点是 `engine/sub-rule.ts` 的 `subRuleOf`（`getElements` / `getElement` 恒 `'list'`）；分类器先在 `'value'` 形态解析一次，失败落 `'list'`，错误留给真正的求值入口。条目装配只走这条轴：`hitFieldsOf` 在门内把字段位用途显式定为 `'value'`；面（`facet`）只用于错误定位。**刻意收窄**：本仓把裸选择留在 `'list'`（若把 `@` 切分后的尾段一律当取值段，裸选择会被打成属性空值、仍按 CSS 认出的选择器会被串成 outerHTML，把出正文、出条目的源洗成空）。被否决：链尾未知词一律按属性终端；组合符「谁有用取谁」或把字符串分支按 HTML 解析成节点再合并；中链把节点集串化；服务层值投影抛「结果不是取值而是节点集」；链首裸取值终端用 `$('*')`；子规则一律按 `'value'` 收。

锚点：`src/engine/types.ts` 的 `RuleUsage`；`classifyDefault`；`src/engine/grammar.ts` 的 `stripChainPrefixes` / `hasListEntryMarker` / `hasExplicitValueHead`；`src/engine/combine.ts` 的 `CombineOpts.usage`；`src/engine/evaluate.ts` 的 `finalize` / `evaluateRef` / `interpolateTemplate`；`src/engine/sub-rule.ts` 的 `SubRule` / `subRuleOf`；`tests/engine/sub-rule-usage.test.ts`；矩阵行 `a-rule-usage-axis`、`h-result-binding`、`h-list-context-collection`、`h-get-string-recursive`、`h-sub-rule-usage`。
