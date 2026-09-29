# 请求组装与出站各只有一个门口；URL 即身份，`,{option}` 全程保留

三件事一条链：
1. **选项语义的唯一主人**是 `src/services/request.ts` 的 `assembleRequest`（method / body 插值 / POST 默认表单头 / charset / `trimFirstPage`），init 姿态在 `fetchInitOf`。此前请求组装在搜索面与引擎桥各写一份、靠「与对方同口径」的注释同步。
2. **`new URL()` 之前必须切分**：它会吃掉换行并把 `{` 百分号编码。绝对化是这条链上唯一会**静默改写**选项串形状的步骤。
3. **落库与求值出口一律保留 `,{option}` 后缀**（书 URL、章节 URL、`ruleBookInfo.tocUrl` 三个出口统一走同一构造器）。POST 型 API 源的 `book_id` 活在选项 body 里——剥掉之后详情 / 目录 / 正文全链路 405，再也发不出同一个请求。**URL 即请求规格**是 bookKey 的定义，不是巧合。

出站口只有一个：守门 fetcher 收口超时、网络层异常与 HTTP 非 2xx，分别类型化成 `FetchError`，**绝不把未分类异常漏给上层**；缺省带浏览器 UA（部分站点 WAF 无 UA 直接 403）；有代理才走 `ProxyAgent`（Node 的 fetch **不读系统代理**，「浏览器能开、插件打不开」的错位由此而来）；解码是四级优先级，声明的 charset 解不出就报 `DecodeError`——拿乱码冒充正文比报「这页解不出」坏。`@js` 里的 `java.ajax` 复用**同一个**出口，桥不自建 fetch。

被否决的方案：① 两处各写一份 init 组装；② 选项 JSON 解析失败时把整串（含 `,{…}`）当纯 URL 发出（听起来克制，实际把站点 404 当成了失败原因）；③ 落库时 strip 选项（API 型章节端点全部退化成裸 GET）；④ 默认 UTF-8 硬解；⑤ 在守门之外再竞速一个不 abort 的定时器（两套超时并存、错误文案一字不差）。

一条同族纪律：URL 与选项的分界式只有一个常量，放引擎侧是因为桥不能 import 服务层（曾两处各抄一份、漂移过一次）。

锚点：`src/services/request.ts`（`assembleRequest` / `parseUrlOption` / `absUrlKeepOption` / `canonUrl`）；`src/services/url.ts` 的 `absUrl`；`src/engine/template.ts` 的 `URL_OPTION_SPLIT`；`src/services/fetcher.ts`；`src/services/proxy.ts`；`src/services/engine-fetch.ts`；矩阵行 `b-split-unconditional`、`b-url-option-on-chapter-url`。
