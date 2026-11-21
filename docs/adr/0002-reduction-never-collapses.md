# Miss 与空 List 是两种值，任何一处都不许折叠

Status: accepted

链上「没取到」与「取到空集合」不可折叠：**取位失败 → Miss（可继续向右，`||` 的短路建立在它之上）；解析到空集合 → 空 List（合法零条目）**。判定只在 `src/engine/select.ts` 的 `reducePicked` 一处，选择段与取值段都从它取结论，JSONPath 侧同口径；任何一处互换都算回归。若把「取到空」当失败，`||` 的兜底分支会连带失效并静默拉回错误内容。被否决：选择段切片裁空给空 List（空 List 不是节点集，中链必抛）；取值段自持空态逻辑（同一规则两种结果）；中链 JSONPath 按「合并后条目数为零」判 Miss；`&&` / `%%` 用 Miss 冒充合并失败（改抛 `UnsupportedRuleError`）。多条目取位按写入序。

锚点：`reducePicked` / `applyIndex` / `getValue`；`src/engine/jsonpath.ts` 头注；`tests/engine/reduce.test.ts`；矩阵行 `a-reduction-contract`（判据与出处住那一行的 `note`）。
