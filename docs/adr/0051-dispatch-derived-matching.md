# dispatch 由路由表派生匹配，handler 漏接即编译错

Status: accepted

`/novel-api` 的路由身份曾是两处声明：`shared/wire.ts` 的表给客户端，`dispatch.ts` 的 if 链自己再判一遍，两边靠扫描测试对齐；现在 dispatch 的匹配由 wire 表派生（`src/api/routes.ts` 的 `matchRoute`），分发是穷尽 Record——漏接在编译期就红，不等测试去撞。

## 背景

if 链时代，路径与方法的判据写在 dispatch 的分支里，与 `ROUTES` / `paramOps` 各持一份：表里加一条路由而链没接，只有 `tests/api/routes.test.ts` 的落点扫描会红；链接了而表里没有，客户端与服务端各说各的也没有编译期反馈。405 还有两套措辞并存（臂内守卫的不带前缀形、面出口的带前缀 + hint 形），同一个事实两种说法。

## 决定

1. **匹配由表派生**：`matchRoute(method, segs)` 住 `src/api/routes.ts`——静态表按 `path` 精确匹配、路径对上即定案（方法不符也不再往下看参数表）；参数模式按「段数 + 字面段全等 + `:` 段收任意值」、按表内声明序优先；静态优先于参数；两边都没认出回 null。判据写在函数头注释，表仍只住 `src/shared/wire.ts`。
2. **分发是穷尽 Record**：`src/api/dispatch.ts` 的 `HANDLERS` 键集由 `RouteName` 派生、`PARAM_HANDLERS` 键集由 `ParamRouteName` 派生，漏接与多接都是 tsc 红；405 的 `pathForMessage` 与匹配共用 `PARAM_PATTERN_PATHS` 同一份，消息不会与「匹配认什么」分叉。
3. **405 收成单点**：`methodMismatchError` 一句措辞承接全部 mismatch（带 `/novel-api` 前缀；health 的表内 path 是空串，渲染成前缀自己），面出口的 hint 退出。

## 被否方案

- **行式数组登记表**（每条路由一行 `method` + `path` + handler，循环比对）：数组可以少一行而不报错——类型逼不出穷尽；穷尽只有 Record 键集从 `keyof typeof ROUTES` 派生才成立。
- **转发壳**（把每条路由包一层统一注册再分发）：`ADR-0036` 已否——收口只抽机械，不抽转发壳。本决定抽的正是匹配机械本身，不是壳。

## 后果

- 漏接 = 编译错；落点扫描不再承担「对齐两处声明」的职责，`tests/api/routes.test.ts` 降级为烟雾 + 负对照（全表烟雾、405 全表扫描、matchRoute 单元、负对照与 SEG 孤儿检查）。
- 两处行为收紧（如实）：
  - 参数路由「路径认得、方法不对」从 404 未知路由改 405（`GET /sources/xyz` 需 DELETE）；
  - 带垃圾尾段的路径此前在若干臂上被忽略尾段照接（写口照执行），现在段数不等一律不认，落 404 未知路由。**例外**：垃圾尾段恰好凑成三段参数模式（如 `sources/<任意>/probe`）时它落参数路由——`<任意>` 不是已注册源是 404「源不存在」，方法不符则是 405；「未知路由」只属于任何表项都没认出的路径。
- 405 措辞统一：面出口的 hint（如「导入走 POST /sources/import」）消失，全部走「方法不允许: M（路径 需 Y）」一句；status 与 code 任何场景不变。

## 代价

- 匹配次序成了判据的一部分：改次序先改 `src/api/routes.ts` 的函数头注释与 `tests/api/routes.test.ts` 的 matchRoute 用例（两处一起，注释里已写明）。
- 参数路由的 405 消息显示模式路径（`sources/:id`）而非具体 id——调用方拿到的是「这条模式要什么方法」。

锚点：`src/api/routes.ts`（`matchRoute` / `PARAM_PATTERN_PATHS` / `Match`）；`src/api/dispatch.ts`（`HANDLERS` / `PARAM_HANDLERS` / `methodMismatchError`）；`src/shared/wire.ts`（`ROUTES` / `paramOps`）；`tests/api/routes.test.ts`；`tests/shared/wire-builders.test.ts`；`ADR-0009`、`ADR-0036`。
