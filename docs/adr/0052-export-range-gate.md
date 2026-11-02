# 导出区间判据归门面，路由只翻结局与搬流

Status: accepted

导出的区间语义（缺席 = 全本、越界裁剪、裁剪后倒置）与两条 422 曾住在 `api/dispatch.ts` 的 export 处理器里，`services/export.ts` 只能接「已裁好」的区间、再在越界时抛一条前置断言；现在它们收进 `services/reading.ts` 的 `exportRange`，由一次目录读数定案并交回 plan，路由保留参数形态校验、写头与流式机械。

## 背景

导出要做两件互相牵制的事：区间必须在**首包之前**定案（`x-novel-total-chapters` / `x-novel-range` 与 `content-disposition` 都要先写头），而流要在定案之后才组装。头是传输面的事，区间不是——缺省全本、越界裁到目录长度、裁剪后倒置报错，说的是同一件事：「[from, to] 是不是目录的一段」。把它放在路由，等于让传输层养一条业务判据，再让 `services/export.ts` 持半条前置断言；两个家各持半条，任何非 HTTP 的新调用方（工具面、离线导出）都得再抄一遍裁剪。

`ADR-0036` 曾把「导出区间的裁剪与那两条 422 的主人仍是路由层」和收口判据写在同一句里。它在「门面不抽转发壳」上成立，在**判据归属**上读错了：区间语义不是传输层的，它只是恰好要赶在写头之前算出来。

## 决定

1. **门面出 outcome 判别联合**：`exportRange` 返回 `empty-toc` / `bad-range` / `plan` 三态。门内一次 `getToc` 定案：空目录 → `empty-toc`；两端缺席时套「1 / 目录长」，给了数就裁进 `[1, 目录长]`；裁剪后起点越过终点 → `bad-range`，带**裁剪后**的两个数（路由的文案模板原样使用）。两条失败结局是值不是异常——门内不带 HTTP 语义，不写头、不碰状态码、不读配置。
2. **plan 自带流**：`plan` 交出区间两端、段内章数与由 `exportBook` 组装的 `stream`。`exportBook` 的 deps 注入原样保留，它自己的越界即抛仍是前置校验，防的是绕过门面的调用方，不是第二份裁剪策略。
3. **路由只做传输**：`parseEdge` 的整数校验（400）留在路由——那是参数**形态**；`exportDelayMs` 每次导出读一次、AbortController 挂响应的 close、写头、背压循环、中断标记与收尾也留路由。翻译只有两句：`empty-toc` → 422 `EmptyToc`、倒置 → 422 `BadRange`，文案逐字原样。

## 边界

- 门面不认 `http.ServerResponse`，也不接配置读数面：标题、节流与中断信号都是调用方交来的值。将来若有第二条导出通道，复用门面而不复用路由。
- 路由不重算区间，也不为「头要先写」在门面外套预检：plan 到手即写头，头仍先于首块。
- 目录抓取失败在写头之前从门面抛出，由路由走正常错误路径（502 信封）——门面不翻译它，错误分类仍归 `api/wire.ts`。

## 被否方案

- **门内一并写头与搬流**：把 `http.ServerResponse` 带进 `services/`，路由退化成一条转发壳（`ADR-0036` 判它出局），背压、断连与中断标记也全变成服务层的传输知识。
- **在 `exportBook` 里裁**：它首块就是 BOM，区间要到读过目录才知道；等它算出来，200 头已发，空目录与倒置只能靠错误文本冒充，两个 422 信封永远发不出去。
- **路由继续持判据、只把 generator 包成门面动词**：包出来的东西不拥有任何判据（deletion test 只剩转发），裁剪仍有两个家，路由也仍旧要为写头去读目录——本决定要消的正是这条读目录的理由。

## 后果

- 区间语义只剩一个家（`exportRange`）；路由对这一面只剩参数形态校验（`parseEdge` 的 400）与传输机械。
- `services/export.ts` 的「必须已裁剪」指门面 `exportRange`——它的越界即抛是给绕过门面的调用方的前置校验，不是第二份裁剪策略；`ExportOptions.from` 的前置条件与此同口径。
- 两条 422 的文案与状态码仍由路由翻译；`x-novel-*` 头仍在首块之前由路由写出；`exportDelayMs` 每次导出只读一次。`ADR-0036` 的导出条款以门面 `exportRange` 为主人（该篇的核心判据不变）。

锚点：`src/services/reading.ts` 的 `exportRange` / `ExportOutcome` / `ExportPlan`；`src/api/dispatch.ts` 的 `exportBook` handler；`src/services/export.ts` 的 `exportBook`；`tests/services/reading.test.ts` 的 exportRange outcome 用例；`tests/api/dispatch-export.test.ts`；`tests/services/export.test.ts`；`ADR-0036`。
