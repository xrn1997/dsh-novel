# dispatch 由路由表派生匹配，handler 漏接即编译错

Status: accepted

路由身份曾是两处声明：`shared/wire.ts` 的表给客户端，`dispatch.ts` 的 if 链自己再判一遍，两边靠扫描测试对齐；405 还有两套措辞并存。现在 dispatch 的匹配由 wire 表派生（`src/api/routes.ts` 的 `matchRoute`），分发是穷尽 Record。决定：① **匹配由表派生**：静态表按 `path` 精确匹配、路径对上即定案（方法不符也不再往下看参数表）；参数模式按「段数 + 字面段全等 + `:` 段收任意值」、按表内声明序优先；静态优先于参数；都没认出回 null。② **分发是穷尽 Record**：`HANDLERS` 键集由 `RouteName` 派生、`PARAM_HANDLERS` 由 `ParamRouteName` 派生，漏接与多接都是 tsc 红；405 的 `pathForMessage` 与匹配共用 `PARAM_PATTERN_PATHS`。③ **405 收成单点**：`methodMismatchError` 一句措辞承接全部 mismatch。被否决：行式数组登记表（少一行不报错）；转发壳（`ADR-0036` 只抽机械，不抽转发壳）。**后果**：漏接 = 编译错，落点扫描降级为烟雾 + 负对照；两处行为收紧——参数路由「路径认得、方法不对」从 404 改 405；带垃圾尾段的路径段数不等一律 404（凑成三段参数模式的例外落参数路由）。**代价**：匹配次序成了判据的一部分（改次序要同批改函数头注释与用例）；参数路由的 405 消息显示模式路径而非具体 id。

锚点：`src/api/routes.ts`（`matchRoute` / `PARAM_PATTERN_PATHS` / `Match`）；`src/api/dispatch.ts`（`HANDLERS` / `PARAM_HANDLERS` / `methodMismatchError`）；`src/shared/wire.ts`（`ROUTES` / `paramOps`）；`tests/api/routes.test.ts`；`tests/shared/wire-builders.test.ts`；`ADR-0009`、`ADR-0036`。
