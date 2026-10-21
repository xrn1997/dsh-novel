# HTTP cookie jar 以域为边界，不以源为边界

Status: accepted

**裁决**：HTTP 请求侧只有一张 `CookieJar`，按域/路径/过期/`Secure` 匹配；它属于 `ReadingService`，同一个插件实例里的所有源共用。脚本侧 `SourceSession.cookieJar` 的按源键值表仍是另一张表，不并入；浏览器与 HTTP 的 cookie 桥也回灌这同一张表。

**为什么不是 per-source**：上游 `CookieStore` 的粒度本来就是站点级——同一站点的两个源复用登录态，正是它的可观测行为；per-source 会让同站两个源各登录一次，且登录态从 A 源换到 B 源就消失。另一个理由是单一真相：HTTP 自动回带、脚本面 `CookieManager/CookieStore`、真浏览器桥如果各持一张，脚本读到的 cookie 与实际发出去的不是一份。

**被否决的做法**：

- **每个源一张 jar**：隔离更干净，但与上游的站点级粒度分叉，同站源要重复登录；本仓没有「按源隔离 cookie」的真实需求方。
- **全局一张表但不做域匹配**：跨站串 cookie，连「同站共享」都不是，直接否决。
- **per-source jar + 域级合并层**：两套真相，合并时机又要在请求前重算；需求面为零。

**代价与在册残留**：

- **同注册域跨源可见**是有意行为，不是泄漏事故；代价是恶意/错误的同站源能读到同站另一源的 cookie。
- **公共后缀表未接**：只拒绝单标签 `Domain`（如 `Domain=com`）与控制字符，多标签公共后缀（如 `co.uk`）仍可能被同后缀源跨源种 cookie。已知安全残留，读数与测试锚见矩阵行 `b-cookie-jar`。
- **重定向只见最终响应**：自动跟随时中间 3xx 的 `Set-Cookie` 会漏；已知限制，未做逐跳吸收（读数见矩阵行 `b-cookie-jar`）。

**重开条件**：出现「两个源必须各自隔离 cookie」的真实需求，或接入公共后缀表；前者按那条源改粒度，后者只改 `CookieJar` 的域判据，不动共享裁决。

锚点：`src/services/reading.ts` 的 `create`（一张 jar 装配给 fetcher 与 `SourceRequest`）；`src/services/cookies.ts` 的 `CookieJar`（域/路径/过期/`Secure` 判据）；`src/services/source-request.ts`（浏览器 cookie 桥）；`tests/services/cookies.test.ts`；矩阵行 `b-cookie-jar`。
