# HTTP cookie jar 以域为边界，不以源为边界

Status: accepted

HTTP 请求侧只有一张 `CookieJar`，按域/路径/过期/`Secure` 匹配；它属于 `ReadingService`，同一插件实例里的所有源共用。脚本侧 `SourceSession.cookieJar` 的按源键值表仍是另一张表，不并入；浏览器与 HTTP 的 cookie 桥也回灌这同一张表。**为什么不是 per-source**：站点级才是 cookie 的自然粒度，同一站点的两个源复用登录态正是应有行为；per-source 会让同站两个源各登录一次，且换源后登录态消失；单一真相还要求脚本面、HTTP 自动回带、真浏览器桥不各持一张。**代价与在册残留**：同注册域跨源可见是有意行为（恶意同站源能读到同站另一源的 cookie）；公共后缀表未接（只拒绝单标签 `Domain` 与控制字符，多标签公共后缀仍可能被跨源种 cookie）；重定向只见最终响应（中间 3xx 的 `Set-Cookie` 会漏）；容量闸按插入序淘汰最旧的，长驻会话里某个站的旧登录态可能被别的站挤掉且无提示（重开条件：真出现「被挤掉导致读不出」的源）。被否决：每个源一张 jar；全局一张表但不做域匹配；per-source jar + 域级合并层。**重开条件**：出现「两个源必须各自隔离 cookie」的真实需求，或接入公共后缀表。

锚点：`src/services/reading.ts` 的 `create`；`src/services/cookies.ts` 的 `CookieJar`；`src/services/source-request.ts`；`tests/services/cookies.test.ts`；矩阵行 `b-cookie-jar`。
