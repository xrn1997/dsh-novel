# 导出区间判据归门面，路由只翻结局与搬流

Status: accepted

导出的区间语义（缺席 = 全本、越界裁剪、裁剪后倒置）与两条 422 曾住在 `api/dispatch.ts` 的 export 处理器里，`services/export.ts` 只能接「已裁好」的区间。现在它们收进 `services/reading.ts` 的 `exportRange`，由一次目录读数定案并交回 plan，路由保留参数形态校验、写头与流式机械。理由：区间必须在**首包之前**定案（`x-novel-total-chapters` / `x-novel-range` 与 `content-disposition` 都要先写头），而流要在定案之后才组装；头是传输面的事，区间不是——放在路由等于让传输层养一条业务判据，再让 `services/export.ts` 持半条前置断言。`ADR-0036` 在「门面不抽转发壳」上成立，在**判据归属**上读错了。决定：`exportRange` 返回 `empty-toc` / `bad-range` / `plan` 三态（两条失败结局是值不是异常，门内不带 HTTP 语义）；`plan` 交出区间两端、段内章数与由 `exportBook` 组装的 `stream`；路由只做 `parseEdge` 的整数校验（400）、写头、背压、中断与把两条 422 逐字翻译。边界：门面不认 `http.ServerResponse`，也不接配置读数面；路由不重算区间；目录抓取失败在写头之前从门面抛出，走正常错误路径。被否决：门内一并写头与搬流；在 `exportBook` 里裁（首块是 BOM，等它算出来 200 头已发）；路由继续持判据。**后果**：区间语义只剩一个家；`ExportOptions.from` 的「必须已裁剪」是给绕过门面的调用方的前置校验。

锚点：`src/services/reading.ts` 的 `exportRange` / `ExportOutcome` / `ExportPlan`；`src/api/dispatch.ts` 的 `exportBook` handler；`src/services/export.ts` 的 `exportBook`；`tests/services/reading.test.ts`；`tests/api/dispatch-export.test.ts`；`tests/services/export.test.ts`；`ADR-0036`。
