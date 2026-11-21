# 请求组装与出站各只有一个门口；URL 即身份，`,{option}` 全程保留

Status: accepted

三件事一条链：① **选项语义的唯一主人**是 `services/request.ts` 的 `assembleRequest`（method / body 插值 / POST 默认表单头 / charset / `trimFirstPage`），init 姿态在 `fetchInitOf`；此前请求组装在搜索面与引擎桥各写一份。② **`new URL()` 之前必须切分**：它会吃掉换行并把 `{` 百分号编码。③ **落库与求值出口一律保留 `,{option}` 后缀**（书 URL、章节 URL、`tocUrl` 三个出口走同一构造器）——POST 型 API 源的 `book_id` 活在选项 body 里，剥掉后详情 / 目录 / 正文全链路 405；URL 即请求规格是 bookKey 的定义。**HTTP** 出站口只有一个：守门 fetcher 收口超时、网络层异常与 HTTP 非 2xx，分别类型化成 `FetchError`；真浏览器 WebView 是独立的浏览器运行时。`java.head` 与 `java.get` 走同一门口，但分别以 `fetchPage(…, { manual: true })` / `{ noFollow: true }` 放行；`loginCheckJs` 的 4xx/5xx 错误页先过脚本是另一条窄例外。缺省带浏览器 UA；有代理才走 `ProxyAgent`；解码四级优先，声明的 charset 解不出就报 `DecodeError`。被否决：两处各写 init 组装；选项 JSON 解析失败时把整串当纯 URL 发出；落库时 strip 选项；默认 UTF-8 硬解；守门之外再竞速一个不 abort 的定时器。

锚点：`src/services/request.ts`（`assembleRequest` / `parseUrlOption` / `absUrlKeepOption` / `canonUrl`）；`src/services/url.ts` 的 `absUrl`；`src/engine/template.ts` 的 `URL_OPTION_SPLIT`；`src/services/fetcher.ts`；`src/services/proxy.ts`；`src/services/engine-fetch.ts`；矩阵行 `b-split-unconditional`、`b-url-option-on-chapter-url`。
