# 错误→HTTP 是两分法；同源 fence 必须看 Origin，无 Origin / 无 Referer 放行

① **domain 与引擎错误**走一个分类单点（`services/errors.classify` → `ErrorCategory` → 状态码表），分类权在**类型**上，不在中文文案上——`message.startsWith('源不存在')` 是历史形态，改个错别字就改了 HTTP 状态码。`RuleMissing` 这类类目在 HTTP 面与搜索面/探针必须是同一词汇（此前裸 Error → 500，用户看到「服务器内部错误」而不是「这源缺规则」）。
② **路由层自检错误**用自带 status/code 的 `ApiError` 直通，**不进分类学**（405 / 未知路由 404 / body 校验 400 / 非受信来源 403 / 非法百分号编码 400）。被否决：把所有状态码映射塞进同一张表——那会把路由自检错误拖进分类学，凭空发明一批 domain 错误类。路由侧不许再 inline 写状态码，那会成为第三面。

**同源 fence**：`/novel-api` 只放行 loopback，且 Origin 在场必须与 Host 同源、Referer 在场必须与 Host 同源；**无 Origin / 无 Referer 视为合法**——这是给本机工具与 curl 的显式承诺，不是漏洞。只看 Referer 不够：恶意页可用 `<meta name="referrer" content="no-referrer">` 让 Referer 缺席，而浏览器对跨源 POST **总是**发 Origin；不拒「Origin 存在且跨源」，则 `content-type: text/plain` 的 simple POST（不触发 preflight）就能 CSRF 打到导入 / 批量 / 登录路由。被否决：要求 Referer 必须在场（会打死本机 curl 与 agent 工具面）。

在册待裁：`tests/api/routes.test.ts` 仍以中文措辞「未知路由」为判据（钉措辞而非结构码，文案一改即整套误红）——要么给未知路由单独一个码并改判据（属契约面扩张：客户端消费 `code`，新码要在 UI 上有中文映射），要么维持现状加这条注记。

锚点：`src/services/errors.ts` 的 `classify` / `ErrorCategory`；`src/api/wire.ts` 的 `ApiError` / `isTrustedRequest` / `STATUS_OF` / `readCappedBody`；`src/api/dispatch.ts` 的 `createApiHandler`；`tests/api/wire.test.ts`。
