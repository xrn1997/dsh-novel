# Miss 与空 List 是两种值，任何一处都不许折叠

链上「没取到」与「取到空集合」在对面的读法里是两个不同的值：**取位失败 → Miss（可继续向右，`||` 的短路建立在它之上）；解析到空集合 → 空 List（合法零条目）**。我们决定这条判定只在 `src/engine/select.ts` 的 `reducePicked` 一处，选择段与取值段都从它取结论，JSONPath 侧同口径；任何一处把两者互换都算回归。若把「取到空」也当失败，`||` 的兜底分支会连带失效并静默拉回错误内容。

被否决的方案：① 选择段切片裁空给空 List（空 List 不是节点集，中链必抛「上游结果不是节点集」）；② 取值段自持一份空态逻辑（同一规则 `@text.5:9` 与 `.5:9@text` 给两种结果）；③ 中链 JSONPath 用「合并后条目数为零」判 Miss（把上游空 List 改口成 Miss，`||` 兜底随链长漂移）；④ `&&` / `%%` 用 Miss 冒充合并失败（改抛 `UnsupportedRuleError`）。

多条目取位按**写入序**，与对面的插入序同形。

锚点：`reducePicked` / `applyIndex` / `getValue`；`src/engine/jsonpath.ts` 头注；`tests/engine/reduce.test.ts`；矩阵行 `a-reduction-contract`（这条规约的判据与出处住那一行的 `note`）。
