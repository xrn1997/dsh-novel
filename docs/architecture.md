# 架构与形状

这份文档只回答两个问题：**系统分成哪几块、为什么这么切；某条语义的主人在谁头上**。它是 explanation——给读懂代码提供地图，不给代码充当副本。

不在这里的东西，各有各的家：**真机读数与欠账**在 `tests/legado-coverage/matrix.ts` 的行 `note`（那是唯一读数口）；**决策与它当初被否决的替代方案**在 `docs/adr/`；**用户可见的事实与产品命令**在 `README.md`；**贡献者的构建、门控与发版流程**在 `docs/development.md`，提交与发版边界在 `CONTRIBUTING.md`，发布历史在 `CHANGELOG.md`；**领域术语的定义**在 `CONTEXT.md`；本文用到的设计词见下；**"怎么做"**在代码自己。这里一条读数都不列——列了就是第二份抄本，且必然腐烂。

## 设计词

本文用这套词：

- **module**：有 interface 与 implementation 的任何东西（函数、类、包、跨层切片）。
- **interface**：调用方要知道的全部——类型、不变量、顺序约束、错误形状、必需配置、性能特征。
- **implementation**：module 里面那具躯体。
- **seam**：可以不改这里就换掉行为的位置；module 的 interface 住在哪儿。
- **adapter**：满足某个 seam 上 interface 的具体东西。说**角色**，不说里面是什么。
- **depth**：interface 上的杠杆。薄的 interface 后面压着一大坨行为 = **deep**；interface 几乎与 implementation 一样复杂 = **shallow**。
- **leverage**：调用方从 depth 得到的东西（一份实现，N 个调用点）。
- **locality**：维护者从 depth 得到的东西（改动、bug、知识、验证都集中在一处）。

## 1. 双半形态

同一个仓库产两半，运行在两个地方，靠一份契约对齐：

```
      浏览器（宿主前端）                     Node（宿主进程）
  ┌────────────────────────┐            ┌──────────────────────────┐
  │ src/client  全局面板   │  HTTP/JSON │  src/api    /novel-api   │
  │  书架 · 书城 · 书源管理 │ ─────────▶ │  src/tools  六个 agent 工具│
  │  只有视图与可丢弃投影   │            │  src/services domain 门面 │
  └────────────────────────┘            │  src/engine 规则引擎(纯)   │
           ▲                            └──────────────────────────┘
           │  值形状与路由名：src/shared/wire.ts（两半 import 同一份）
```

- 浏览器半是 CJS 单文件闭包工厂，经宿主的模块装载器进场，bundle 内每个 `require` 由宿主**冻结的平台模块表**解答——这决定了它不能带运行时依赖出去（`ADR-0021`）。
- Node 半是 Cordis 插件：入口导出配置 schema 与 `apply`，在 `apply` 里挂三条注册（prefix 路由、工具、常驻 effect）。装配声明与安装许可由宿主的兼容闸把关（`ADR-0020`）。
- 浏览器半的槽位、可丢弃投影与文案入口见本文 §3。
- 改动生效分两条路：浏览器半靠宿主的 HMR 热推；Node 半必须重启宿主。契约升级要**两半同批**上线（`ADR-0019`）。

## 2. Node 半的分层与依赖方向

```
engine/    规则串 → 值。纯函数、零 IO、零内部状态、段级定位；@js 沙箱在这层
   ▲
services/  domain 门面 + 部件：抓取 / 书源注册表 / 书架 / 缓存 / 本地书 / 后台任务
   ▲
api/  ·  tools/        ← 两个平行的**投影面**，不是上下两层
   ▲
index.ts 组合根：配置解析（config.ts）→ 部件装配 → 三条注册
```

- **`api` 与 `tools` 各只拥有什么**：`api/dispatch.ts` 只做传输关注点（信封、流式与响应头、错误到状态码的落点；路由身份的**判定**不在这层——它住 `api/routes.ts` 的 `matchRoute`，由 `shared/wire.ts` 的路由表派生，dispatch 只拿 `Match` 查穷尽分发表，裁决见 `ADR-0051`；body 的**形状**判据不在这层，它是 `shared/wire.ts` 的 `readBodies`），业务判据一律抛给门面动词——留在路由层的两处 body 形状分派（`shelfPut` / `authRoute`）各自的家写在 `dispatch.ts` 末尾那条注里，导出区间的判据归门面 `services/reading.ts` 的 `exportRange`（路由只留参数形态校验、写头与流式机械，见 `ADR-0052`）；`tools` 只 `import type` 门面，每个 `execute` 都是门面动词的调用，不在这层判业务——它拥有什么（工具声明、render、搜索回执派生、缺键投影）见本文 §4 的「工具声明」与「工具面搜索回执」两行。所以「UI、AI 工具、探针三个面共用同一条链路」不是口号而是 import 事实。
- **书内容读面**：门面 → `BookContent` → `LocalBooks` / `OnlineReading`；读动词只委托，分流与文字规约的归属见本文 §4。
- **绕过门面在类型上不可表达**：门面的部件全是构造期的私有成员，外部三面拿不到。
- 方向上的两处**刻意破例**都有理由，别当违规清理：选项切分常量放引擎侧（桥不能 import 服务层）；`services/url.ts` 存在的唯一理由是拆 request ↔ bridge 的环——所以绝对化与 `,{option}` 后缀那一族（`absUrl` / `splitUrlOption` / `absUrlKeepOption`）住这里，而不是 request。
- 反向依赖的硬约束：`services` 不 import `api`（服务层的错误类型由路由层映射成状态码）；EPUB 子树不认识书架与 HTTP。
- 持久化模型不另立形状：`services/types.ts` 把状态枚举与书目形状**反向 re-export** 自 wire——契约不是服务层的私有形状，是两半共用的那一份。

### 2.1 引擎：层间只走两种值

词法与文法（零 IO）→ 求值 → 宿主层（沙箱 / 协议表 / 纯工具 / DOM）。层间流通的只有 `EngineValue` 五态（miss / value / list / nodes / matches，定义单点在 `engine/types.ts`）与**带段级定位的错误**（格式化单点在 `engine/errors.ts`）。

一条不对称要记住：**面（`Facet`）不改变求值语义**，它只进错误定位与 trace；**用途（`RuleUsage`）改变形状**，且只有这一个轴被允许改变形状（`ADR-0007`）。把它们混为一谈会生出「面决定语义」的假口径。

链语义是单点：一条链只有一份 generator，两个驱动器对链本身零知识；js 段是唯一需要跨 `await` / 跨线程的段，所以它是唯一的 `yield` 点，也是唯一允许把宿主能力带进求值层的口子（`ADR-0005`）。服务层跑脚本只走 `js-sandbox.ts` 的 `runScript` 一扇门，而它的入参**就是 `EvalContext`**（能力清单不许在门外抄第二份——逐字段抄一份，同一段脚本从这扇门进就会少 `fetchPost`/`userAgent`/`book`/`chapter`）；超时预算一个缺省主人（`DEFAULT_JS_BUDGET_MS`，引擎缺省同值由对齐钉子守）+ 两条派生闸（worker 外层 race 的 `ASYNC_GRACE_MS` 加项、worker 内 RPC 死线 = 预算+宽限+余量）；用户正则另有独立预算（随工作量放宽，`ADR-0050`），它不在 js 预算那族里：轴是主线程被钉面积、不是脚本时长（单点 `engine/regex-guard.ts`，归属见本文 §4 的死线行）。递归求值口的用途判据同样只有一处（`engine/sub-rule.ts` 的 `subRuleOf`，归属见本文 §4 的子规则行；why 与被否方案见 `ADR-0007`）。

文法区域（`{{…}}` / `@put:{…}` / `<js>`）先于任何切分被整体剥离，判据只住在 `engine/grammar.ts`——区域里的 `||`、`&&`、`@`、`$1` 是代码内容而不是文法记号。构词与解析同属一处，方言拼串走 round-trip 自校验。

脚本可见面只有一张清单，归属与消费点见本文 §4 的脚本可见面行。

引擎能离线跑，是这套切分的直接后果：网络、二进制、UA 全是注入函数，所以解析面普查可以拿真入口跑全库规则串，不需要站点也不需要宿主。

## 3. 浏览器半：槽位贡献与可丢弃投影

- 注册处只有一处：`src/client/index.tsx`——`sidebar.panellist` 的面板行、`main` 同 id 同 key 的中央面板、`shell.overlay` 的全局状态层。**槽位只挂官方已声明的**；不注册 `conversation.view` 与 `settings.section`（运行参数走插件详情页的配置卡）。
- **浏览器半不读运行时配置、也不需要 API base**：同源根相对 fetch，前缀由 wire 单点持有。宿主平台模块表冻结了可用的运行时 import，`src/shared/wire.ts` 因此保持零运行时依赖（裁决见 `ADR-0021`）。
- **可丢弃投影**：书架读取面与落架账住 `src/client/panel-shelf.ts` 的 `panelShelf`（`NovelView` 卸载时清空），搜索轮次是 `src/client/search-job.ts` 的挂载期状态（卸载即丢、重挂载从服务端重拉），任务快照住 `src/client/jobs.ts` 的模块级 store（由常驻状态层持有）；三者都以 Node 半为真相。
- **模块级现场跨卸载存活**：现场语义住各自模块，脚手架（订阅骨架、latest-wins）只住 `store.ts`；具体有哪些现场见 `docs/ui-spec.md` §1。
- **客户端可见文案单点**：`src/client/copy/` 的命名空间字典，slot 入口经 `inject` 拿 `t`、子树经 `CopyProvider`；宿主 locale 服务可选读，缺席回退中文（裁决见 `ADR-0038`）。
- **界面现在长什么样住 `docs/ui-spec.md`**：本文只给归属与依赖方向，不抄状态清单；§4 只回答某条语义归谁。

## 4. 唯一主人清单

某条语义"该去哪改"的对照表。写第二份之前先查这里。

| 语义 | 唯一主人 | 它不回答什么 |
| --- | --- | --- |
| 路由身份（method + path）/ 值形状 / body 形状（`Route` / `ROUTES` / `paramOps` / `bodies` 构造 + `readBodies` 读口 / `queries`；api 侧匹配器由这份表派生，见 `ADR-0051`） | `shared/wire.ts` | 业务判据 |
| 书目元数据字段集 | `shared/wire.ts` 的 `SHELF_META` + `pickShelfMeta` | 读取面投影（`sourceName` 刻意不进表）、数值位归一化（归 `Shelf`） |
| 架位（书架上的一条记录，凭 `bookKey` 认） | `services/shelf.ts` 的 `Shelf`（按 `bookKey` 单键认）；客户端算式 `client/search-view-model.ts` 的 `shelfSeats` / `isSeatLanded` / `newlyLandedSeats` / `addAllReceipt` | 逐源行怎么认（那是 `rowId`，两把键不许混）、元数据字段集（`SHELF_META`） |
| 工具面书架投影（字段、schema、picker） | `tools/shelf-item.ts` 的 `SHELF_ITEM_FIELDS` / `SHELF_ITEM_EXCLUDED` / `pickShelfItem` | 书目字段集（`shared/wire.ts` 的 `SHELF_META`）、缺键投影（`tools/project.ts`） |
| 工具声明（一工具一声明、一 action 一行：说明 / 缺参 / 执行 / render 同住一行） | `tools/tools.ts` 的 `buildTools`（`shelfRows` / `sourceRows` 派生 enum 与描述）+ `tools/render.ts` 的纯 render | 业务判据（门面动词）、缺键投影（`tools/project.ts`）、书架字段集（`tools/shelf-item.ts`） |
| 工具面搜索回执的两句派生（未答话源逐家点名 / 超上限时的如实说明） | `tools/search-value.ts` 的 `failedSources` / `truncationNotice`（纯投影，只吃已归并的那一份） | 轮级计数与分区（`shared/round-summary.ts` 的 `summarizeRound`）、按书归并（`shared/merge-by-book.ts`）、相关性判据（`shared/relevance.ts`）、披露三件套的组装（`tools/tools.ts` 的 `dshnovel_search` execute） |
| 加架动作（一条命中落进书架：路径 + body + 成败形状） | `src/client/shelf-action.ts` 的 `addShelfSeat`（`ShelfSeatInput` / `ShelfAddOutcome`；路径与 body 仍由 `paramOps.shelfPut.path` + `bodies.shelfAdd` 给） | 回执位置与措辞（搜索行上报错误、书城走成功/失败泳道留在各视图；阅读器的成败泳道选择归 `client/reader-scene.ts`——失败内联模态、成功走全局条并跳书架，见 ADR-0045）、搜索页的加架排队（`client/search-landing.ts` 的 `useSearchLanding`）与落架账（`client/panel-shelf.ts` 的 `panelShelf`）、架位真相（`services/shelf.ts` 的 `Shelf`）与元数据字段集（`SHELF_META`） |
| 规则文法（构词 + 解析 + 区域） | `engine/grammar.ts` | 求值 |
| 整条规则模式（JSON 内容 → JSONPath；显式前缀不接管） | `engine/mode.ts` 的 `isJsonRule`（求解入口 `engine/evaluate.ts` 调用） | 段级前缀分类（`engine/parse.ts` 的 `classifySegment`） |
| 段识别与切分次序（含隐式 CSS 回落） | `engine/parse.ts` | 空态裁决 |
| 空态裁决（Miss vs 空 List） | `engine/select.ts` 的 `reducePicked` | 服务层的值收口 |
| 判定用的子树文本（本仓口径：含脚本/样式文本、不含注释；实现借 cheerio 的 `.text()` 取文本） | `engine/dom.ts` 的 `rawTextOf`（消费点：`select.ts` 的 `textOf` / `extract` 与 `xpath.ts` 的谓词文本） | 正文产出文本（`dom.ts` 的 `nodeText`，块级边界落 `\n`）、直系文本（`select.ts` 的 `directText`） |
| 组合符形状与驱动长度 | `engine/combine.ts`（读 `usage`） | 链衔接 |
| 子规则求值用途（`java.getString*` / 模板 `{{…}}` / `@put` 的 value/list 判据） | `engine/sub-rule.ts` 的 `subRuleOf`（文本 + 用途绑成 `SubRule`；取值终端判据 `engine/select.ts` 的 `isValueTerminal`）；求值入口 `engine/evaluate.ts` 的 `evaluateRef` / 模板插值 `interpolateTemplate` / `engine/js-protocol.ts` 的 `evalRule` | 主链用途（`engine/parse.ts` 的 `classifyDefault` / `ParsedRule.usage`）、组合符语义（`engine/combine.ts`） |
| 行模板的判定与绑定 | `engine/regex-row.ts`（同一份文法的两面） | 模板字面段 |
| 用户正则的死线求值（时间预算算式、批量一趟且批内每条独立的口径、超时把 `lastIndex` 归零、跨 realm 返回值的实情） | `engine/regex-guard.ts` 的 `deadlineFor` 与五条 `vm.Script`（取舍与被否方案见 `ADR-0050`） | 规则语法解析（`engine/grammar.ts`）、超时落成哪条带定位的错误（各调用点转 `RuleEvalError`，见 `engine/errors.ts` 的 `RegexDeadlineError` 归属）、js 沙箱那条预算（`config.ts` 的 `jsTimeoutMs`） |
| `EngineValue → 单串` | `engine/js-utils.ts` 的 `engineValueToString` | 业务字段语义 |
| 宿主方法面（名字 / 挂载 / 分派 / async 桥） | `engine/js-protocol.ts` 的协议表（async 行另带 `bridge` 判别：壳形态、挂载名、路由探针与路由分支；桥壳源码与 `g.java` 挂载由表生成，worker 路由谓词 `SYNC_WORKER_RE` 也由表拼出——全局松散支 + 各 async 行的 `routePattern`，生成文本插进 `js-sandbox.ts` 的 `BOOTSTRAP` 串——沙箱边界见 `ADR-0004`，主线程与 worker 同口径见 `ADR-0005`）。加一个 **sync** 方法 = 表加一行；加一个 **async** 方法 = 表加一行 + 一个 `bridge`；且它读的 `ctx.*` 能力位必须由 `services/source-eval.ts` 的 `engineContextOf` 供出——桥壳 / 挂载 / 路由与能力位都有机器闸（`tests/engine/js-protocol.test.ts` 的 async 行闸） | 真实网络 |
| 脚本可见面（`EvalContext` 字段 → init 键 → 脚本全局名 / excluded） | `engine/script-surface.ts` 的 `SCRIPT_FIELDS`（`Record<keyof EvalContext, …>`：加字段时 `tsc` 逼你选归属）/ `scriptInitOf` / `scriptGlobals`（消费点 `js-sandbox.ts` 的 `initOf` 与 BOOTSTRAP 简单全局） | `result` / `mounts` 等求值期字段（`js-sandbox.ts` 的 `initOf`）、book/chapter/source 的自定义物化（BOOTSTRAP） |
| 引擎进程级缓存的上限与淘汰（`downloadFile` 暂存表） | `engine/stores.ts` 的 `createFileStore`（条数 + 单文件字节两道闸；消费点 `js-protocol.ts` 的 `storeFile` / `readTxtFile`） | 按源隔离的状态四表（归 `SourceSession`）、jsLib URL 缓存（已自带上限，仍住 `js-sandbox.ts`） |
| JS 宿主对象描述符（`__host`） | `engine/host-object.ts` 的 `ResponseHost`（宿主→沙箱的响应描述符）；`__host:'map'` 由 `engine/js-sandbox.ts` 的 BOOTSTRAP 内部物化，不跨宿主边界 | 宿主函数/对象直接过界（`__host_call__` 是唯一入口） |
| 选项语义（模板 → 请求计划） | `services/request.ts` 的 `assembleRequest` + `fetchInitOf` | 网络与解码 |
| 出站（超时 / 代理 / 解码 / 状态） | `services/fetcher.ts`，`@js` 复用同一出口 | 缓存与业务 |
| 源请求执行（动态头 / 限速 / webview / loginCheck（含 4xx、5xx 错误页）/ cookie 桥；只按计划**选 charset**——解码本身归 `services/fetcher.ts` 的 `decodeBody`） | `src/services/source-request.ts` 的 `createSourceRequest` / `SourceRequest`（`fetcherFor` 给脚本求值面 `ScriptEvalSurface`：HTTP 已过 loginCheck、浏览器走 `webview`、动态头只经 init 带入；读面 `fetchText` / `fetchPage` 自带浏览器形态与 loginCheck） | 模板解析与选项语义（归 `services/request.ts` 的 `assembleRequest`）、解码（`decodeBody`）、动态头规则本身的求值（归 `services/source-eval.ts` 的 `resolveHeaders`）、缓存与业务判据、探针判据 |
| 调用方取消（工具/任务的 `AbortSignal`） | 工具入口与落写前的检查：`src/tools/tools.ts` 的 `ToolExec` / `checkAbort`；「已取消不发请求、在途中止抛 `signal.reason`」：`services/fetcher.ts` 的 `FetchInit.signal` 分支；「中止不冒充失败/空结果」：`services/reading.ts` 的 `searchProgressive` / `probe`（与 `services/probe.ts` 的换词间检查同口径）；取消不下传 webView 导航的边界住 `source-request.ts` 的 `ReadFetchOptions` | 超时预算（fetcher 自己的 timeout）、任务停止与终态词汇（`shouldStop` / `HostTie`，见 `ADR-0018`）、浏览器导航的执行期中断（浏览器导航没有取消面） |
| 源脚本求值（能力面装配 / 动态头求值、非递归与回退 / 脚本可见的 `book` 镜像） | `services/source-eval.ts` 的 `createSourceEval` / `engineContextOf` / `resolveHeaders` / `bookMirrorOf` | 面枚举与 `EvalContext` 形状（`engine/types.ts`）、抓取与限速（`source-request`）、逐面给哪些身份字段与 `chapter` 的形状（调用方） |
| HTTP cookie jar（域/路径/过期/Secure/容量闸；跨源共享） | `services/cookies.ts` 的 `CookieJar`；Set-Cookie 自动吸收/回带归 `services/fetcher.ts` | 脚本侧按源隔离的 cookie 垫片（`SourceSession.cookieJar`）、浏览器 cookie 桥（`source-request`）；跨源共享的裁决见 `ADR-0039` |
| 源状态会话（脚本可见的四张按源表；写只标脏，求值边界与卸载成批同步落盘（`evalJs` 的 `finally`、`ReadingService.flush`、组合根 dispose），删源当场落盘且此后该源的在途句柄不再写回） | `services/source-session.ts` 的 `FileSourceSession`（`forget` / `flush`）；接口在 `engine/session.ts` 的 `SourceSession`（落盘缝是可选方法） | 页面缓存（`services/cache.ts`）、登录态 `SourceAuth`（`services/sources.ts`）；同步写的例外与理由见 `ADR-0013` |
| 真浏览器运行时（启动 Edge/Chrome、上下文、超时、关闭） | `services/webview.ts` 的 `WebViewRuntime` | 限速与 cookie 桥（`source-request`）、规则求值 |
| 源级限速（`concurrentRate` 解析与令牌桶） | `services/rate-limit.ts` 的 `parseConcurrentRate` / `RateLimiter` | 出站时序与按源装配（`source-request`） |
| 探针 verdict → status 的写回 | `services/probe.ts` 的 `applyProbeResult` | 探针判据与关键词（`services/probe.ts` 的 `probeSource`） |
| 一次搜索请求的完整语义（含嗅探） | `services/search-face.ts` | 聚合与游标 |
| 值投影（`EngineValue` → 业务串） | `services/bridge.ts` 的三种投影 | 空态判定；条目装配面怎么消费（不跨缝取 `EngineValue`） |
| 文字输出 | `services/content.ts` + `services/chapter-content.ts` | 图文排版 |
| 缓存「放在哪」与容量账（写后按落盘字节增量记账：估算超限立即全扫，否则按间隔实扫对账——外部增删只能靠实扫发现） | `services/cache.ts` 的 `PageCache`（`prune` / `scanFiles`） | 何时有效（`cache-epoch.ts`） |
| 进程内有界 LRU 的读升与淘汰次序（Map 迭代序 = 新旧序；只装派生数据） | `services/lru.ts` 的 `lruGet` / `lruSet`（上限由调用方给自己的那一格） | 磁盘缓存的字节账（`services/cache.ts`）、跨重启的源状态（`services/source-session.ts`） |
| 缓存「还有效吗」 | `services/cache-epoch.ts`（代际 + 槽位），在线目录 / 正文的消费点在 `services/online-reading.ts` 的 `OnlineReading` | 清理策略 |
| 在线目录 / 正文管线（进程内目录缓存（键含代际，refresh 绕过读、写回有序：晚到的旧目录不许盖掉刚刷新的那份）+ 磁盘缓存优先、目录在途去重（代际与 refresh 入身份）、全目录规范化地址集随目录缓存一次（串章闸的 `stopUrls`）、翻页跟进、subContent、空正文异常） | `services/online-reading.ts` 的 `OnlineReading`（`toc` / `chapterText`） | 书内容读面的本地/在线分流（`services/book-content.ts`）、本地书目录 / 正文（`services/localbooks.ts`）、缓存有效性算式（`cache-epoch`）、翻页判据（`pagination`）、出站执行（`source-request`） |
| 本地书读取面的进程内缓存（元数据表与 TXT 全文各一张、按书 LRU；元数据读取在途去重，删书即失效并按代际放弃在途写回） | `services/localbooks.ts` 的 `LocalBooks`（`metaOf` / `metaCache` / `textCache`；淘汰次序同 `services/lru.ts`） | 落盘形状与导入（同模块 `publishText` / `publishEpub`、`storage.ts`）、元数据有效性算式（本地书 key 自带 uuid，不参与 `cache-epoch`）、EPUB 包内解析（`services/epub/`） |
| 本地导入的书目投影（作者 / 封面 / 总章数怎么从导入结果变成 shelf.json 的字段，历史条目又怎么补） | `services/reading.ts` 的 `localImport`（`totalChapters` 由 `chapterCount` 投影，作者 / 封面来自 `LocalImportResult.book`）与 `backfillLocalChapterCounts`（启动时按本地 meta 的章数补缺字段的旧条目） | 导入结果本身（`services/localbooks.ts` 的 `LocalBookMeta` 与 `chapterCount`：作者取自书内元数据、封面走资源读口、章数取线性序列）、字段名与落盘归一化（`shared/wire.ts` 的 `SHELF_META`、`services/shelf.ts` 的 `applyPatch`） |
| 书内容读面（目录 / 导航 / 正文的本地与在线分流 + 正文文字规约 + 一章文字面读的编排） | `services/book-content.ts` 的 `BookContent`（适配器 `LocalBooks` / `OnlineReading`；`readChapter` 让章名与正文出自同一次目录读数；文字规约 `chapter-content.ts` 的 `normalizeChapterText`） | 在线缓存/翻页/空正文（`OnlineReading`）、EPUB 包内解析（`services/epub/`）、图文结构投影（`chapter-content.ts` 的 `chapterContentToText`）、越界错误归类（交回适配器各自的既有错误语义）、门面的一行委托（`services/reading.ts` 的 `readChapter`） |
| 章节范围导出的区间语义（缺省全本 / 越界裁剪 / 裁剪后倒置，以及两条 422 的来源） | `services/reading.ts` 的 `exportRange`（`ExportOutcome` / `ExportPlan`：一次目录读数定案，plan 自带流） | 逐章抓取、章间节流与失败即停（`services/export.ts` 的 `exportBook`）、参数形态校验（`api/dispatch.ts` 的 `parseEdge`）、422 文案与状态码、写头 / 背压 / 中断标记（`api/dispatch.ts` 的 export handler） |
| 删书顺序（单删 / 批删 / 本地删共用「先删本地副本，失败则架位保留可重试」） | `services/reading.ts` 的 `removeLocalCopies`（三条入口共用；单删与本地删再经 `removeShelfAndLocal` 移架位，批删由 `removeBooks` 在副本后调 `removeMany`） | 本地副本删除（`services/localbooks.ts` 的 `remove`）、架位移除（`services/shelf.ts`） |
| tocUrl 规则求值（null 回退 bookUrl / 静态短路 / 详情上下文过引擎） | `services/online-reading.ts` 的 `tocUrlOf` | 静态短路与上下文求值判据（`services/bridge.ts` 的 `staticTocUrl` / `tocUrlFromContext`）、详情页抓取（`services/source-request.ts` 的 `fetchSourceText`；门面 `getDetail` 与在线管线共用） |
| 入库规则（什么算同一本书源） | `services/intake.ts` | 呈现与计数 |
| 落盘调度机制（防抖 / 阈值计数 / flush 失败） | `services/storage.ts` 的 `createDebouncedWriter`（`SourceRegistry` 与 `Shelf` 只调用） | 阈值住 `services/sources.ts` 的 `PERSIST_EVERY`；窗口缺省住 `services/storage.ts` 的 `PERSIST_WINDOW_MS`，注册表引用它、书架用缺省；`Shelf` 的写动词只经私有 `edit(recipe)` 排写、何时触发迁移（`SourceRegistry.load`）、原子写低层与按文件名排队（`writeFileAtomic`） |
| 源清单与落盘 | `services/sources.ts` 的注册表（变更口 `edit` / `flush`；写失败移交 `retainWriteFailure`） | 任务节流、写调度（归 `createDebouncedWriter`） |
| 存量收敛（已落盘源按 raw 收敛） | `services/normalize.ts` 的 `rehydrateStoredSource`（触发点只有 `SourceRegistry.load`） | 何时加载 / 何时落盘（归 `SourceRegistry`） |
| 规则字段集（模型键 × 两方言路径（发现面族除外）× 隐式终端标记 × 存量覆盖模式 × 配对目标 / 整套闸 / 段序） | `services/rule-fields.ts` 的 `RULE_FIELD_SPECS`（导入循环的 `RULE_FIELDS`、两方言通用映射 `DIALECT_MAP` / `NATIVE_MAP`、隐式终端清单 `NATIVE_TEXT_FIELDS`、配对索引 `PAIR_OF`、整套闸 `WHOLE_SET_FIELD`、发现面两方言子字段名 `EXPLORE_LEGADO_SUBS` / `EXPLORE_NATIVE_SUBS`、回落九键 `EXPLORE_FALLBACK_FIELDS`、条目装配字段位 `HIT_FIELD_MODELS` 与整套映射 `EXPLORE_OF_GENERIC`、段序 `REHYDRATE_PHASES` 都由它派生） | 方言判别与展平、发现面整套切换的落位/展平与特殊字段的落位分支（`services/normalize.ts`）、条目装配侧的整套切换（`services/bridge.ts` 的 `hitRuleOf`）、值怎么收口（`services/bridge.ts`）、缓存代际按字段的影响面（`services/cache-epoch.ts`） |
| 原子写与 JSON 读的两分判别 | `services/storage.ts` | domain 的合并写策略 |
| 翻页何时停 | `services/pagination.ts` 的 `followPages` | 站点结构解析 |
| 本地书身份（`bookKey` 的 `local:<uuid>` 形态） | `services/localbooks.ts` 的 `BOOK_KEY_RE` / `isLocalBookKey`（`LOCAL_SOURCE_ID` 常量本身归 `shared/wire.ts`） | 本地/在线内容分流（`services/book-content.ts`）、EPUB 包内解析（`services/epub/`） |
| 聚合搜索的参与集 | `services/participation.ts` 的 `participates`（发现面谓词 `exploreParticipates` 同文件） | 源清单读写 |
| 错误类目 → HTTP | `services/errors.ts` + `api/wire.ts`（两分法） | 路由自检错误 |
| 同源 fence 的四步判据（远端 → Host → Origin → Referer）与本机 Host 名单 | `api/wire.ts` 的 `fenceDenialOf`（`isTrustedRequest` 只是它的布尔投影）/ `fenceAllowlist` / `LOOPBACK_HOSTNAMES`；追加别名的形状与缺省住 `config.ts` 的 `apiAllowHosts`，403 的可行动措辞住 `api/dispatch.ts` 的 `fenceDenialMessage`；为什么要这一闸与让渡了什么见 `ADR-0016` | 路由身份与 body 形状（`shared/wire.ts`）、错误 → 状态码的两分法（上一行） |
| cookie 串的 `k=v;` 解析（登录脚本产出与登录面板手工输入同一条语法） | `shared/cookies.ts` 的 `parseCookieString` | 登录态往哪落盘（`services/reading.ts` 的 `saveAuth` / `login`） |
| 登录执行（run-login：源存在性、loginUrl 形态判别、脚本执行 → outcome 判别联合） | `services/reading.ts` 的 `login`（`LoginOutcome` 单点；`loginPlan` / `runLogin` 是门内私有构件） | 登录态落盘形状与应用（`saveAuth` / `saveLoginInfo` / `SourceAuth`）、按钮动作（`runLoginAction`）、body 形状（`shared/wire.ts` 的 `readBodies.auth`）、outcome → 状态码与文案的翻译（`api/dispatch.ts` 的 `authRoute`） |
| 日志前缀与级别出口 | 唯一主人 `services/log.ts` 的 `log` / `setLogSink`（运行时 adapter = console + 宿主 `ctx.logger` 双腿，组合根卸载时复位 console）；**例外**：engine 防线的缺省 sink（`engine/js-sandbox.ts` 的 `consoleGuardSink`）自持一份前缀——依赖方向红线要求 engine 不得 import services，只有注入路径的前缀归缝。未处理 rejection 的级别分档（引擎错误与泄漏的 `RegexDeadlineError` 先于来源判定记 `error`；沙箱 realm 的其余 promise 记 `warn`；非沙箱来源记 `error` 并交回宿主）、致命语义的恢复判据与订阅生命周期住同一文件的 `unhandledGuardHandler` / `ensureUnhandledGuard`（判据与代价见 `ADR-0059`） | 日志往哪投（宿主日志面的去向归宿主） |
| 任务过程行 | 缓冲与偏移读：`services/job-tail.ts` 的 `JobTail` / `readFrom`；把拉源接到宿主 `JobSpec.output` 上的登记机械：`services/job-holder.ts` 的 `HostTie`（三个持有者共读这一份，`start()` 内同步取 hooks 的顺序只在这里记一次） | 整轮结果与业务明细（那归各持有者的快照读面，`ADR-0018`）；状态形状与槽政策 |
| 「本轮状态变了」信号 | `services/job-holder.ts` 的 `ChangeSignal`（只发信号不发数据；观察者自取快照、各持游标） | 快照形状、游标推进、换轮与整帧替换的裁决（那归浏览器半两个观察模块） |
| 整轮搜索结果 | `services/search-job.ts`（Node 半持有） | wire 形状 |
| 搜索轮的开始与归属 | `client/search-job.ts` 的 `submit`（返回本轮 `jobId`；需要认领自身轮次的调用方按 id 认领——书籍详情浮层如此，搜索结果页仍跟随最近一轮） | 服务端单槽与跟随最近一轮（`services/search-job.ts`、`ADR-0046`）、轮级派生（`client/search-view-model.ts`） |
| 跨源归并（作品视图）：搜索面「是不是同一本书」的判同 | `shared/merge-by-book.ts` 的 `mergePartitioned`（生产归并入口，吃 `shared/round-summary.ts` 的分区；`mergeBooks` 只是「一轮 → 归并」的 convenience，供测试与审计脚本；形状与上限 `MergedBook`／`MergedSource`／`SEARCH_BOOKS_CAP` 在 `shared/wire.ts`）——呈现层派生，消费点只有搜索结果页与工具面 | 不替用户判该用哪家读（动作不下放）、不服务书籍详情浮层、不改架位与进度（作品级身份与换源搬运另裁，见 `ADR-0033`） |
| 一轮搜索的轮级计数与分区（每源只分区一次） | `shared/round-summary.ts` 的 `summarizeRound`（形状 `RoundPartition` / `RoundCounts`；answered/kept/suspect 的名字即口径——answered 数答了话的家，零条也算） | 归并（`shared/merge-by-book.ts` 的 `mergePartitioned`）、行身份与架位（`client/search-view-model.ts`） |
| 搜索结果页的轮级派生（行身份与 React key、逐源回读、架位） | `client/search-view-model.ts`（`deriveRound` 一次给齐现场：`groupViews` / `bookViews` 把两档行与行 key、每本的逐源行与架位全集都预算在 memo 内，渲染只摆现成的；判据的「为什么」仍住 `CONTEXT.md` 的单位律词条与 `ADR-0032` / `ADR-0033`） | 轮次累积与游标（`client/search-job.ts`）、加架排队（`client/search-landing.ts` 的 `useSearchLanding`）与落架账（`client/panel-shelf.ts` 的 `panelShelf`）、轮级计数与分区（`shared/round-summary.ts`） |
| 搜索落架排队（逐本「都加架」在途、两条加架入口的排队；`landed` 读面板期投影） | `client/search-landing.ts` 的 `useSearchLanding`（`landed` / `adding` / `isLanded` / `add` / `addAll`；写口以 `addSeat` 注入，生产是 `client/shelf-action.ts` 的 `addShelfSeat`） | 落架账与书架读取面（`client/panel-shelf.ts` 的 `panelShelf`）、书架真相（`services/shelf.ts` 的 `Shelf`）、写口语义（`addShelfSeat`）、架位与回执算式（`client/search-view-model.ts` 的 `shelfSeats` / `isSeatLanded` / `newlyLandedSeats` / `addAllReceipt`）、回执措辞与通道（视图） |
| 相关性判据（一条命中与本轮关键词的关系档位） | 形状 `Relevance` 声明在 `shared/wire.ts`；判据与三档序 `shared/relevance.ts` 的 `relevanceOf` / `partitionByRelevance` / `RELEVANCE_RANK`——决定 `suspect` 去处的三个消费点（`client/views/SearchView.tsx` 的 `renderGroups`、`client/views/CityBookSheet.tsx` 的 `GroupRow`、`tools/tools.ts` 的 `searchBooks`）加只收 `kept` 的归并面（`shared/merge-by-book.ts`）都只吃这一份 | 不判书架、不判发现面（那两面没有关键词这一维） |
| `exploreUrl` 的形态判据与分类入口解析（js / JSON / `标题::URL` 三档怎么分、条目怎么取、什么算一条**可用**条目） | `services/explore-url.ts` 的 `exploreKindsFormOf` / `parseExploreKinds` / `usableKind` | 落位与平铺优先（`services/normalize.ts` 的 `flattenDialect`）、这次用哪份模板（`services/explore-face.ts` 的 `fetchKindPage`） |
| 一次分类页请求的完整语义（回落判据归 `bridge.hitRuleOf`，本行只管编排） | `services/explore-face.ts` 的 `fetchKindPage` | 整轮编排与快照写回 |
| 分类清单（哪个源自己声明了哪些分类） | `services/explore.ts` 的 `deriveExploreSources` | 站点侧分类的同义归并（本仓不造同义词表） |
| 单源一页的执行（查进程内快照 → 抓 → 写回 → 出一个组） | `services/explore.ts` 的 `fetchExploreGroup` | 点名与页码（门面 `services/reading.ts`）、轮次状态与终态 |
| 整轮分类结果 | `services/explore-job.ts`（Node 半持有，读面给全量快照） | wire 形状 |
| 书城进入判据（自动那条路的源/分类回落与提交决策） | `client/city-entry.ts` 的 `decideCityEntry` / `resolveCitySelection` | 分类轮次的持有与续页（`services/explore-job.ts`）、分类清单派生（`services/explore.ts`）、手点提交（`client/views/CityView.tsx`） |
| 书城选中态（源 + 分类 + 本挂载 one-shot） | `client/city-selection.ts` 的 `useCitySelection` / `rememberedCitySelection`（`select` 只写 `cityStore`，视图读投影） | 进入判据（`client/city-entry.ts`）、分类轮次（`services/explore-job.ts`）、提交回包闸（`client/explore-job.ts` 的 `submitted`） |
| 跨源那一次的关键词构造（有作者就带作者） | `client/city-view-model.ts` 的 `sheetKeyword`（消费者只有书籍详情浮层，链路复用搜索面） | 是不是同一本书——判同在搜索面归并那一行（`mergePartitioned`，按归并键）；书籍详情浮层维持逐源轴、不吃归并；两层的界面都不替他判该用哪家读 |
| 逐条目取值装配（源 + 规则来源档 + 一个条目上下文 → 一条命中） | `services/bridge.ts` 的 `hitRuleOf` / `hitFieldsOf`（规则来源档、槽序、书名非空尺、选项保留绝对化、简介净化、用途与面全在这一处；聚合搜索与发现面共用） | 读不出来归成哪类错（各自调用侧：搜索面按组、发现面按源） |
| 分类快照的存放与时效 | `services/explore-cache.ts` 的 `KindCache` + `services/cache-epoch.ts` 的 `exploreEpoch` | 目录 / 正文文件缓存（`rulesEpoch`） |
| 配置口径（名字 / 类型 / 缺省 / 值域 / 是否活值） | `config.ts` 的 `CONFIG_FIELDS` 一张表 + `resolveConfig`（schema 的 `.default()` 只引各消费模块常量，不写第二份字面量）+ `VOLATILE_CONSUMERS`（volatile 字段的消费桶：service-live / composition-root） | 运行时环境探测（如系统代理读取，在 `services/proxy.ts`） |
| 插件页运行参数表单与热更 | `client/config-page.tsx` 的 `registerConfigPage` / `NovelConfigCard`（表单）+ `config.ts` 的 `Config` volatile 字段与 `resolveConfig` getter（读数） | 启动期 `dataDir`、系统代理探测、HTTP 路由 |
| 缺省值 | 各消费模块一个主人（见 `tests/services/defaults.test.ts` 钉的常量） | 第二处字面量 |
| 浏览器视图内路由与跨卸载现场 | `client/store.ts` + 各模块级现场 store | 业务真相 |
| 面板期书架投影（书架读取面 + 落架账 + 筛选/关键字） | `client/panel-shelf.ts` 的 `panelShelf` / `loadPanelShelf` / `ensurePanelShelf` / `readPanelShelf` / `markPanelShelfLanded` / `removePanelShelfBooks` / `resetPanelShelf` / `setPanelShelfFilter` / `setPanelShelfKeyword`（`NovelView` 卸载时清空） | 搜索轮次与任务快照（`client/search-job.ts` / `jobs.ts`）、书架真相（`services/shelf.ts` 的 `Shelf`） |
| 模态契约（Esc / 入场焦点 / Tab 圈 / 关后还焦 / scrim 与 dialog 标记） | `client/views/dialog.tsx` 的 `Dialog`（五处带遮罩浮层共读这一份） | 几何档位的主人（样式层）与标题、动作行文案（各调用点） |
| 客户端可见文案与错误展示 | `client/copy/index.tsx` 的 `ZH` / `EN` / `createTranslate` / `zhTranslate` / `CopyProvider` / `useCopy`（字典与取词入口）+ `client/copy/search.ts`（搜索收口句的整句模板与子句键）+ `client/copy/search-summary.ts` 的 `searchSummarySegments`（按模板组装成段）+ `client/api.ts` 的 `describeError` / `NetworkReason`（客户端网络错误的翻译判据） | 服务端错误原文、AI 工具描述、插件卡片的 `locale` 元信息 |
| 阅读时序（视口喂入合帧 `feedViewport`（帧调度经 `ReaderViewportFeed` 注入）、排版前采点与复位算式 `applyTypesetRelocation`） | `client/reader-session.ts` | DOM 测量实现（`client/reader-geometry.ts`）、DOM 监听安装与帧调度实现（`ReaderView`） |
| 阅读器几何（`ReaderPort` 的纯几何实现：锚点/视口偏移/目标偏移（逐个与批量同读数，批量只建一次章内节点索引）/当前节点） | `client/reader-geometry.ts` 的 `createReaderGeometry` / `currentNodeOf`（底层坐标换算 `client/scrollport.ts`） | 阅读时序（`client/reader-session.ts`）、事件监听安装（`ReaderView`）与合帧判据（`client/reader-session.ts`） |
| 阅读渲染后拍点（落位 → 重测锚点 → 结算滚动补偿 → 预取/回溯补载；这一趟无条件重测——它是唯一知道新章块已提交进 DOM 的时刻，滚动帧那次可能量在提交之前） | `client/reader-session.ts` 的 `afterRender`（视图只 `refreshPort` 后调它） | DOM 测量（`client/reader-geometry.ts` 的 `ReaderPort`）、滚动/排版事件（`ReaderView`） |
| 阅读浮层在场与互斥（至多一角、换角退场语义、哪面带遮罩、模态同场时 Esc 归谁） | `client/reader-surfaces.ts`（`openSurface` / `closeAll` / `dismissSurface` / `maskFor` / `escOwner`；阅读场景的 `surface` / `mask` / `escOwner` 都是它的投影，视图只读投影） | 阅读位置与返回栈（`reader-session.ts`）、带遮罩模态（`client/views/dialog.tsx`） |
| 阅读场景（当场面与注释载荷、返回句柄、Esc 命令、离开一问与入架写入） | `client/reader-scene.ts` 的 `ReaderScene`（命令面 `toggle` / `openNote` / `close` / `handleEsc` / `dismissAsk` / `openTarget` / `bodyLink` / `panelLink` / `exitToShelf` / `joinAndBack`；写口以 `addSeat` 注入，生产是 `client/shelf-action.ts` 的 `addShelfSeat`；`mask` / `escOwner` 两枚投影与状态同一笔写入） | 阅读时序（`client/reader-session.ts`）、至多一角的纯判据（`client/reader-surfaces.ts`）、模态契约与焦点（`client/views/dialog.tsx`）、DOM 测量与滚动事件（`ReaderView`）、导出编排（`client/export-run.ts`）、文案（`client/copy/`） |
| 章节窗口的向前判据（边界哨兵 + 两屏 → 视口章之后第一个未载章） | `client/reader-load.ts` 的 `nextLoadTarget` / `nextChapterIndex` | 会话状态；已载窗口的保留深度、滚动补偿与回溯补载（归 `client/reader-session.ts`，见上「阅读时序」行与 `CONTEXT.md` 的「已载窗口」） |
| 阅读位置 ⇄ 像素 | `client/progress.ts`（两侧同跨度才互逆） | 落盘时机 |
| 视觉 token 与标度 | `client/styles/tokens.ts` 的 `TOKENS_CSS`（配色契约、named 标度与 `--novel-*` 缺省定义）；暗层重钉住 `client/styles/shell.ts` 的 `.novel-dark`；`client/styles.tsx` 只是拼装点（把十块按原次序连成 `NOVEL_CSS`，`NovelStyles` 注入） | 视图局部布局（归 `client/styles/` 各块）、块间次序（次序即行为，重排等于改样式） |
| 兼容读数与裁决 | `tests/legado-coverage/matrix.ts` 的行 | 复述进文档 |
| 已知桥缺口名册（脚本在调、本仓没挂的 `java.*` 名字与它的归属行） | `tests/legado-coverage/bridge-gaps.ts` 的 `KNOWN_BRIDGE_GAPS` | 源侧「新名字冒出来」的发现（归解析面普查 `DSH_PARSE_CENSUS`）、这名字该记在哪一行（归矩阵行） |

## 5. seam：可测性怎么落

- **纯函数面**直接单测，不造宿主替身：`parseRule`、`reducePicked`、`evalCss`、`evalXPath`、`evalJsonPath`、`applyReplaces`、`interpolateUrl`、`appendTail`、`bindRegexRow`、`engineValueToString`，以及客户端的 `source-list-view` / `shelf-view-model` / `city-view-model` / `city-entry` / `search-view-model` / `source-inbox` / `reader-load` / `progress`。
- **规则字段表的完备性**由 `tests/services/rule-fields.test.ts` 守：覆盖面字面量的 `satisfies` 让编译器抓漏键，运行时断言抓重复行与多余行；两方言**通用容器**映射与隐式终端清单由同一批行派生。`always` / `vacant` 两档各有一条档位钉子（清单类型是表派生的键集，多一键少一键都当场红，运行时再对表取一次数）——`vacant` 那份就是 `rawExploreFields` 铺给发现面的键集，表改档而名单没跟，书城整族读空而 `tsc` 不响，红在这里。发现面条目字段的两方言子字段名经 `pairWith` 派生（配对目标是通用搜索面的同名行），整套闸由 `wholeSetGate` 行登记，落位与展平的**实现**仍在 `normalize` 的显式分支（`flattenDialect` / `nativeExploreFields`），条目装配侧的整套切换在 `bridge.hitRuleOf`——表不为它们登记方言路径。`cache-epoch` 的发现面指纹两组名单同由表的 `vacant` 档与配对列派生，指纹次序即表行序。派生读口的期望值在测试侧**独立写死**（派生即同义反复），另钉一条「实现派生 == 钉住字面」。
- **轮级派生的预算值**由 `tests/client/search-view-model.test.ts` 守：`deriveRound` 的 `groupViews` / `bookViews` 里行、行 key 与架位全集是同一批值，视图只消费不再重算——行身份与架位算式因此只有一条不用起 DOM 的钉子。
- **源求值缝自己的账**由 `tests/services/source-eval.test.ts` 钉：`book` 镜像的逐面字段集（搜索面只给身份、目录/正文面再补 `tocUrl`、架位字段按调用方给的形状出现）、动态头与静态头的次序，以及登录面投影的优先级（表单录入赢过源 auth、过期 auth 整个键缺席、空 headers 不算一份登录头）。能力位覆盖不在这里列名单——`tests/engine/js-protocol.test.ts` 那条闸从协议表现造一份 `engineContextOf` 上下文、逐个 `d.ctx.*` 验供得出，名单由协议表派生。
- **搜索落架排队**由 `tests/client/search-landing.test.tsx` 用假 `addSeat` 驱动 `useSearchLanding`：落成的架位进面板期账并按地址认、整本只补还没落过的行（同址两行各发一发，回执按架位分三笔）、零加成不给成功回执、在途读数逐本记；回执的措辞/通道不在这层，仍由 `tests/client/views-wiring.test.tsx` 在整页里钉。
- **面板书架投影**由 `tests/client/panel-shelf.test.ts` 钉：load 成功/失败、落架账 seed 与在途合并、删除对账与删前快照作废、`ensure` 的缺书/失败重取与在途先等（带当前书与只问基线两条各钉一次）、卸载代际丢弃；落架账跨挂载保留由 `tests/client/search-landing.test.tsx` 的卸载重挂用例钉，搜索结果页的基线与阅读器对缺书/读面失败的处理由 `tests/client/views-wiring.test.tsx` 钉。
- **阅读器几何**由 `tests/client/reader-geometry.test.ts` 用假元素钉：锚点偏移与高度、sentinelOffset、targetOffset、targetOffsets（批量与逐个同读数）、currentNode；整页用例只证接线，不再改写 DOM 原型量几何。
- **工具 render** 由 `tests/tools/render.test.ts` 直接喂规范值钉：六工具 / 两套 action 的文案（截断、缺键、未答话、去重回执）不靠起服务层的整条用例。
- **阅读场景的交互律**由 `tests/client/reader-scene.test.ts` 用假会话驱动 `ReaderScene`：至多一角、注释返回句柄的消费与不消费、Esc 归属、在架/不在架/问不到的离开、入架成功与失败，全都不起 DOM、不伪造滚动几何；整页接线（模态焦点归还、目录与入架一问同场时 Esc 只关模态、正文内链的返回栈）仍由 `tests/client/views-wiring.test.tsx` 钉。
- **注入垫片**是测试进出的口子（不是换模块替身）：引擎侧 `EvalContext` 的 fetch 族 / `evaluateRef` / `subEval` / `SourceSession` / 超时预算；服务侧 fetcher 与注入的时钟/目录（`ReadingService.from()` 只读注入物：jar 必须由构造方给同一实例，门面不兜底、不写回）；服务侧的源脚本求值缝由 `services/source-eval.ts` 的 `createSourceEval` 构造，能力位闸在 `tests/engine/js-protocol.test.ts` 里从 `engineContextOf` 现造上下文，逐个 `d.ctx.*` 验供得出；**在线阅读管线用假 `SourceRequest` 驱动**（`tests/services/online-reading.test.ts` 只拼 `OnlineReading` 的五件部件，不起 HTTP 门面），书内容读面的双适配器与文字规约由 `tests/services/book-content.test.ts` 钉、门面委托另有一条冒烟；客户端**按读者分的依赖束**（核心 / 观察通道 / 带观察的视图 / 书架 / 设置 / 阅读器）+ `ReaderPort`，其中观察通道的节拍与阅读器的防抖窗各留一格注入位；大轮次 UI 的大数合并拍**不在**这一格里（`client/search-job.ts` 的模块常量，用例用假计时器钉，见 `tests/client/search-job-coalesce.test.tsx`）；浏览器位置用例走仓内最小宿主壳，它只证明「卸载与重挂」那一半契约。**束切到读者，也要切到读者里面的行**：行内动作只声明 `RowActionDeps`（一发写请求 + 两句上报），注释面板只声明 `apiGet` + `pushError`——interface 的宽度就是那条用例的固定成本。
- **两条求值路必须同口径**（主线程与 worker），由按 fetch 计数自证的跨路钉子守——这是 `ADR-0005` 的产物。
- 客户端的测试手法是**假 adapter 驱动真实组件**，不是渲染快照；服务端的路由测试用真 HTTP server 承载（`api/dispatch.ts` 不依赖 Cordis，纯构造器）。
- **门的分工别混**：解析面普查管「能不能解析」，重探只证搜索面，正文审计是**报告**不设通过率，compat 回放的分母是 fixture，真浏览器门只跑本机与本地书，安装门控不起宿主。各自承诺什么写在 `docs/development.md` 的「门（自动）」，不在这里复述。
- **回放数据住自己的家**：`tests/replay/fixtures` 与 `tests/replay/sources` 喂离线回放集（默认被 `vitest.config.ts` exclude，`sources` 还是人工投放口——未脱敏的人类输入不进 `tests/`）。兼容判据不冻结外部格式快照：矩阵的证据与能力单元归属由 `status-evidence` / `inventory-coverage` 自证，桥面名册与需求读数绑定由 `bridge-surface` / `demand-keys` 自证，格式字段与宿主方法的现量覆盖读数走 `DSH_PARSE_CENSUS` 报告（`ADR-0054`）。

## 6. 数据与生命周期

- 运行时数据全部住数据根（默认 `$DSH_HOME/novel/`，未设置 `DSH_HOME` 时 `~/.dsh/novel/`；`dataDir` 可改）：源清单、书架与进度、页面缓存、本地书副本。构建产物 `lib/` 不入库；`tests/replay/report.md` 是跑门产物。
- 读面与写面：源清单与书架都是**内存活体 + 按文件名排队的原子写**；「不存在」与「损坏」绝不折叠（`ADR-0013`）；本地发布与入架之间不建跨文件事务，接受的窗口写进 `ADR-0014`。
- 缓存有效性靠指纹入名而不是删除式失效，所以**没有清缓存出口是设计而非缺失**（`ADR-0012`）。
- 任务生命周期：身份与终态在宿主注册表，业务明细与整轮结果在本仓持有者；写任务一槽、搜索另开一槽；任务态不持久化（`ADR-0018`）。

## 7. 改动面 → 先读什么

表只指路，不复制口径：真正的主人在第 4 节、ADR 与代码注释。

| 改动面 | 先读 |
| --- | --- |
| 规则文法 / 求值 / 链语义 | 第 2.1 节；`ADR-0001`、`ADR-0002`、`ADR-0005`、`ADR-0006`、`ADR-0007`、`ADR-0029`；矩阵 `a-*` 行 |
| 脚本求值 / 动态头 / `book` 镜像 / 登录态投影 | 第 4 节的 `createSourceEval`、`engineContextOf`、`resolveHeaders`、`bookMirrorOf` 行；`ADR-0042`、`ADR-0015`；矩阵 `b-header-js`、`h-book-mirror-fields`、`h-source-entity-fields` 行 |
| 书源导入 / 两方言展平 / 存量收敛 | 第 4 节的 `RULE_FIELD_SPECS`、`normalizeSource`、`rehydrateStoredSource` 行；`ADR-0044`；`services/normalize.ts`、`services/rule-fields.ts` |
| 请求组装 / 出站 / cookie / 限速 / webview | 第 4 节的 `assembleRequest`、`fetcher`、`CookieJar`、`RateLimiter`、`WebViewRuntime` 行；`ADR-0015`、`ADR-0016`、`ADR-0039`；矩阵 `b-*` 行 |
| wire / 路由 / 工具面 | 第 2 节；`ADR-0009`、`ADR-0019`；`shared/wire.ts` |
| 工具声明 / render | 第 4 节的工具声明行与工具面搜索回执行；`tools/tools.ts`、`tools/render.ts`、`tools/search-value.ts`；`tests/tools/render.test.ts` |
| 书架 / 存储 / 缓存 / 本地书 | 第 6 节；`ADR-0010`、`ADR-0011`、`ADR-0012`、`ADR-0013`、`ADR-0014`；`services/shelf.ts`、`services/storage.ts`、`services/cache.ts`、`services/localbooks.ts` |
| 书架读取面 / 落架账 / 筛选 | 第 4 节的面板期书架投影行；`ADR-0046`；`client/panel-shelf.ts`、`client/search-landing.ts`、`client/views/ShelfView.tsx`、`client/views/SearchView.tsx` |
| 聚合搜索 / 相关性 / 按书归并 | 第 4 节的 `services/search-face.ts`、`mergePartitioned`、`relevanceOf` 行；`ADR-0032`、`ADR-0033`；矩阵 `d-*` 行 |
| 书城 / 分类浏览 | 第 4 节的 `fetchKindPage`、`ExploreJobs`、`decideCityEntry` 行；`ADR-0027`、`ADR-0028`；`services/explore-face.ts`、`services/explore-job.ts` |
| 客户端视图 / 文案 / 模态 / 阅读浮层 | 第 4 节的 `client/copy/index.tsx`、`client/views/dialog.tsx`、`client/reader-surfaces.ts` 行；`ADR-0037`、`ADR-0038` |
| 阅读器 / 章节窗口 / 进度 / 阅读交互 | 第 4 节的 `client/reader-session.ts`、`client/reader-geometry.ts`、`client/reader-scene.ts`、`client/reader-load.ts`、`client/progress.ts` 行；`ADR-0022`、`ADR-0045` |
| 在线目录 / 正文 / 缓存有效性 | 第 4 节的 `OnlineReading`、`BookContent`、`tocUrlOf` 行；`ADR-0047`、`ADR-0012`；`services/online-reading.ts`、`services/book-content.ts`、`services/cache-epoch.ts`；矩阵 `c-toc-*` / `f-toc-*` / `g-content-*` 行 |
| 后台任务 / 过程行 / 宿主观察 | 第 4 节的 `HostTie`、`JobTail`、`ChangeSignal` 行；`ADR-0018`、`ADR-0034` |
| 宿主接入 / 打包 / 插件页 | 第 1 节；`ADR-0020`、`ADR-0021`、`ADR-0035`；`docs/development.md` 的「宿主兼容与实测名单」 |
| legado 兼容判据 / 新写法 | 先查 `tests/legado-coverage/matrix.ts` 有没有那一行；`ADR-0003`、`ADR-0054`、`ADR-0025`；`docs/development.md` 的「兼容判据与桥面自证」 |
| 文档 / ADR / 发布流程 | `docs/AGENTS.md`；`docs/adr/README.md`、`docs/adr/ADR-FORMAT.md`、`ADR-0048`、`ADR-0049`；`CONTRIBUTING.md`、`CHANGELOG.md`；`docs/development.md` |
