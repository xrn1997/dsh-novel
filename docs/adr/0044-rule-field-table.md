# 规则字段集收成一张描述表；覆盖策略按生产者数量分档

Status: accepted

加一个通用容器字段曾要在多处同步字段名单与派生读口。现在这类字段的模型键、两方言路径、Native 隐式终端标记、覆盖模式与落位方式都在 `rule-fields` 一张表里，导入、展平与存量收敛共用；展平前要解析的容器集合也从表的方言映射派生。

## 边界
- 特殊字段（`searchUrl`、`exploreUrl`、header 两形态（`header` / `headerRule`）、`ruleExploreKinds`、`jsLib`、章节 flag）的**落位实现**仍由 `normalize` 的显式分支处理；表只用 `placement: 'explicit'` 登记「不走平铺循环」这一事实，`SPECIAL` 是这一列的投影，平铺循环名单与它互为补集（`ruleExploreKinds` 是数组、不在这张表里）。
- 发现面条目字段（`ruleExplore*`）没有方言路径列：legado `ruleExplore` 与 Native `ruleFind` 的整套启用/展平落位仍住 `normalize`；表为它们登记模型键、隐式终端、覆盖模式、配对目标（`pairWith`）与整套闸（`wholeSetGate`），方言子字段名由配对目标的方言列反推。
- **展平前要解析的容器集合**由表派生：方言映射的键（表的投影）加上 `ruleExplore` 这个唯一具名特例（`EXPLORE_CONTAINER`），映射与容器清单同源——表加一个新容器不会只剩映射、容器解析静默落空。
- 覆盖模式保留 `always` / `vacant` / `missing` / `conditional` 四档（入库落位、存量不重推的字段记 `none`），不合并成一种「有值就写」。`vacant` / `missing` 的读口由表派生；`always` / `conditional` 的读口以表的键集做 Record——表加一行而读口没补，`tsc` 当场红。
- `pairWith` / `wholeSetGate` / `placement` 是**登记事实**而非实现：`pairWith`（同一事实的另一键，只登记在派生侧）、`wholeSetGate`（发现面整套启用的闸，`ruleExploreList` 唯一）与 `placement`（平铺循环 / 具名分支）登记在行上，`REHYDRATE_PHASE` 是表级段序登记（段序不是逐行事实，逐行重复就是 `rehydrateStoredSource` 的第二份抄本）。发现面的两方言子字段名经配对目标的方言列反推（`EXPLORE_LEGADO_SUBS` / `EXPLORE_NATIVE_SUBS`），表仍不为发现面行登记方言路径；整套切换的落位与展平实现仍住 `normalize` 的显式分支，条目装配侧的整套切换实现住 `bridge.hitRuleOf`——表只供判据。
- 「该标 `placement` 而未标」仍靠评审：`SPECIAL` 由列派生，抓不到自己的缺席；漏标的字段会静默走平铺循环。

## 被否方案
- 只用 TypeScript 类型生成表：类型推不出方言路径与覆盖模式。
- 把所有字段强行塞进同一形状：会逼特殊字段长出假路径，表反而成为第二份解释。

锚点：`src/services/rule-fields.ts` 的 `RULE_FIELD_SPECS` / `SPECIAL` / `dialectMapOf` / `legadoContainersOf` / `EXPLORE_CONTAINER`；`tests/services/rule-fields.test.ts`、`tests/services/normalize.test.ts`（落位集合与端到端落位）；`src/services/normalize.ts` 的 `normalizeSource` / `flattenDialect` / `rehydrateStoredSource`。
