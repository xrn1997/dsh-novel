# 规则字段集收成一张描述表；覆盖策略按生产者数量分档

Status: accepted

加一个通用容器字段曾要同步 `RULE_FIELDS`、两方言映射、Native 隐式文本清单与存量重推的四处分支。现在这类字段的模型键、两方言路径、Native 隐式终端标记与覆盖模式都在 `rule-fields` 一张表里，导入与存量收敛共用。

## 边界
- 特殊字段（`searchUrl`、`exploreUrl`、header 两形态（`header` / `headerRule`）、`ruleExploreKinds`、`jsLib`、章节 flag）仍由 `normalize` 的显式分支处理。
- 发现面条目字段（`ruleExplore*`）没有方言路径列：legado `ruleExplore` 与 Native `ruleFind` 的整套启用/展平判据仍住 `normalize`；表只为它们登记模型键、隐式终端与覆盖模式。
- 覆盖模式保留 `always` / `vacant` / `missing` / `conditional` 四档（入库落位、存量不重推的字段记 `none`），不合并成一种「有值就写」。`vacant` / `missing` 的读口由表派生；`always` / `conditional` 的读口以表的键集做 Record——表加一行而读口没补，`tsc` 当场红。

## 被否方案
- 只用 TypeScript 类型生成表：类型推不出方言路径与覆盖模式。
- 把所有字段强行塞进同一形状：会逼特殊字段长出假路径，表反而成为第二份解释。

锚点：`src/services/rule-fields.ts` 的 `RULE_FIELD_SPECS`；`tests/services/rule-fields.test.ts`；`src/services/normalize.ts` 的 `normalizeSource` / `rehydrateStoredSource`。
