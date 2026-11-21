# 规则字段集收成一张描述表；覆盖策略按生产者数量分档

Status: accepted

加一个通用容器字段曾要在多处同步字段名单与派生读口。现在这类字段的模型键、两方言路径、Native 隐式终端标记、覆盖模式与落位方式都在 `rule-fields` 一张表里，导入、展平与存量收敛共用；展平前要解析的容器集合也从表的方言映射派生（`legadoContainersOf`）。边界：特殊字段（`searchUrl`、`exploreUrl`、`header` 两形态、`ruleExploreKinds`、`jsLib`、章节 flag）的落位实现仍由 `normalize` 的显式分支处理，表只用 `placement: 'explicit'` 登记「不走平铺循环」，`SPECIAL` 是这一列的投影；发现面条目字段（`ruleExplore*`）没有方言路径列，整套启用/展平的落位仍住 `normalize`，表登记模型键、隐式终端、覆盖模式、`pairWith` 与 `wholeSetGate`（`ruleExploreList` 唯一）；覆盖模式保留 `always` / `vacant` / `missing` / `conditional` 四档（存量不重推的记 `none`），读口以表的键集做 Record，表加一行而读口没补 `tsc` 当场红；`REHYDRATE_PHASE` 是表级段序登记。被否决：只用 TS 类型生成表；把所有字段强行塞进同一形状。发现面的两方言子字段名经配对目标的方言列反推（`EXPLORE_LEGADO_SUBS` / `EXPLORE_NATIVE_SUBS`），表仍不为发现面行登记方言路径；整套切换的落位与展平实现仍住 `normalize` 的显式分支。「该标 `placement` 而未标」仍靠评审（`SPECIAL` 抓不到自己的缺席）。

锚点：`src/services/rule-fields.ts` 的 `RULE_FIELD_SPECS` / `SPECIAL` / `dialectMapOf` / `legadoContainersOf` / `EXPLORE_CONTAINER`；`tests/services/rule-fields.test.ts`、`tests/services/normalize.test.ts`；`src/services/normalize.ts` 的 `normalizeSource` / `flattenDialect` / `rehydrateStoredSource`。
