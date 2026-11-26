# 架构与形状

这份文档只回答两个问题：**系统分成哪几块、为什么这么切；某条语义的主人在谁头上**。它是 explanation——给读懂代码提供地图，不给代码充当副本。

别处的家：真机读数与欠账在 `tests/legado-coverage/matrix.ts` 的行 `note`；决策与被否方案在 `docs/adr/`；用户可见事实在 `README.md`；构建、门控与发版在 `docs/development.md`；提交与发版边界在 `CONTRIBUTING.md`；发布历史在 `CHANGELOG.md`；术语定义在 `CONTEXT.md`；「怎么做」在代码自己。这里不列读数。

## 设计词

- **module**：有 interface 与 implementation 的任何东西（函数、类、包、跨层切片）。
- **interface**：调用方要知道的全部——类型、不变量、顺序约束、错误形状、必需配置、性能特征。
- **implementation**：module 里面那具躯体。
- **seam**：可以不改这里就换掉行为的位置；module 的 interface 住在哪儿。
- **adapter**：满足某个 seam 上 interface 的具体东西。说**角色**，不说里面是什么。
- **depth**：interface 上的杠杆。薄 interface 后面压着一大坨行为 = **deep**；interface 几乎与 implementation 一样复杂 = **shallow**。
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

- 浏览器半是 CJS 单文件闭包工厂，经宿主的模块装载器进场，bundle 内每个 `require` 由宿主**冻结的平台模块表**解答——它不能带运行时依赖出去（`ADR-0021`）。
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

- **`api` 与 `tools` 各只拥有什么**：`api/dispatch.ts` 只做传输关注点（信封、流式与响应头、错误到状态码的落点）；路由身份的判定住 `api/routes.ts` 的 `matchRoute`（由 `shared/wire.ts` 的路由表派生，dispatch 拿 `Match` 查穷尽分发表，`ADR-0051`），body 形状判据是 wire 的 `readBodies`；`shelfPut` / `authRoute` 两处 body 分派的家写在 `dispatch.ts` 末尾那条注里，导出区间判据归 `services/reading.ts` 的 `exportRange`（`ADR-0052`）。`tools` 只 `import type` 门面，每个 `execute` 都是门面动词的调用；它拥有工具声明、render、搜索回执派生与缺键投影（见本文 §4）。
- **书内容读面**：门面 → `BookContent` → `LocalBooks` / `OnlineReading`；读动词只委托，分流与文字规约见本文 §4。
- **本地书副本 ⇄ 架位**：门面 → `LocalLifecycle` → `LocalBooks` / `Shelf`；次序与补偿由它拥有（见本文 §4）。
- **绕过门面在类型上不可表达**：门面的部件全是构造期的私有成员。
- 两处刻意破例：选项切分常量放引擎侧（桥不能 import 服务层）；`services/url.ts` 是 URL 纯工具的唯一住处（request 与 bridge 共用绝对化与 `,{option}` 后缀那一族）。
- 反向依赖的硬约束：`services` 不 import `api`；EPUB 子树不认识书架与 HTTP。
- 持久化模型不另立形状：`services/types.ts` 把状态枚举与书目形状反向 re-export 自 wire。

### 2.1 引擎：层间只走两种值

词法与文法（零 IO）→ 求值 → 宿主层（沙箱 / 协议表 / 纯工具 / DOM）。层间流通的只有 `EngineValue` 五态（miss / value / list / nodes / matches，定义单点在 `engine/types.ts`）与**带段级定位的错误**（格式化单点在 `engine/errors.ts`）。

一条不对称要记住：**面（`Facet`）不改变求值语义**，它只进错误定位与 trace；**用途（`RuleUsage`）改变形状**，且只有这一个轴被允许改变形状（`ADR-0007`）。

链语义是单点：一条链只有一份 generator，两个驱动器对链本身零知识；js 段是唯一需要跨 `await` / 跨线程的段，所以它是唯一的 `yield` 点（`ADR-0005`）。服务层跑脚本只走 `js-sandbox.ts` 的 `runScript` 一扇门，入参**就是 `EvalContext`**（逐字段抄一份，同一段脚本从这扇门进就会少能力）；超时预算一个缺省主人（`DEFAULT_JS_BUDGET_MS`）+ 两条派生闸（`ASYNC_GRACE_MS`、worker 内 RPC 死线）；用户正则另有独立预算（`ADR-0050`，单点 `engine/regex-guard.ts`）。递归求值口的用途判据只有 `engine/sub-rule.ts` 的 `subRuleOf` 一处（`ADR-0007`）。

文法区域（`{{…}}` / `@put:{…}` / `<js>`）先于任何切分被整体剥离，判据只住 `engine/grammar.ts`。构词与解析同属一处，方言拼串走 round-trip 自校验。脚本可见面只有一张清单（本文 §4）。引擎能离线跑：网络、二进制、UA 全是注入函数，解析面普查因此能拿真入口跑全库规则串。

## 3. 浏览器半：槽位贡献与可丢弃投影

- 槽位注册分两处：`src/client/index.tsx` 注册 `sidebar.panellist` 的面板行、`main` 同 id 同 key 的中央面板、`shell.overlay` 的全局状态层与听书迷你条（同一次 inject、两枚条目）；插件配置卡由 `config-page.tsx` 的 `registerConfigPage` 注册 `plugins.bundle.config`。**槽位只挂官方已声明的**；不注册 `conversation.view` 与 `settings.section`。
- **宿主 DOM 不碰**：样式的作用域只有 `.novel-root` 与 `[data-novel-scope]` 两棵树，不按宿主私有 `data-*` 去藏或改宿主布局；面板与 Conversation 的互斥由 `main` 的 keyed 语义保证。门是 `tests/client/host-dom-guard.test.ts`。
- **浏览器半没有 served 配置路由、也不需要 API base**：同源根相对 fetch，前缀由 wire 单点持有。运行时读数只有一处例外——听书缺省经来源链读时求值（`CONTEXT.md`「听书缺省」）：链序即优先级（宿主同步配置的 live ref > 设置面快照 > `shared/wire.ts` 的 `TTS_DEFAULTS`），每格独立取链上第一个读得出的；宿主那两条来源都是可选能力——同步配置逐格接管（缺格不牵连、晚出现下一读即见），设置面快照读一次首屏 + 配置页每次读到有效值补一发，缺席 / 读失败都落下一来源。
- **可丢弃投影**：书架读取面与落架账住 `src/client/panel-shelf.ts` 的 `panelShelf`（`NovelView` 卸载时清空），搜索轮次是 `src/client/search-job.ts` 的挂载期状态，任务快照住 `src/client/jobs.ts` 的模块级 store；三者都以 Node 半为真相。
- **模块级现场跨卸载存活**：现场语义住各自模块，订阅骨架住 `store.ts`，latest-wins 是各现场自持的 seq / 代际守卫；具体有哪些现场见 `docs/ui-spec.md` §1。
- **客户端可见文案单点**：`src/client/copy/` 的命名空间字典，slot 入口经 `inject` 拿 `t`、子树经 `CopyProvider`；宿主 locale 服务可选读，缺席回退中文（`ADR-0038`）。
- **界面现在长什么样住 `docs/ui-spec.md`**：本文只给归属与依赖方向，不抄状态清单；§4 只回答某条语义归谁。

## 4. 唯一主人清单

某条语义"该去哪改"的对照表。写第二份之前先查这里。

| 语义 | 唯一主人 | 它不回答什么 |
| --- | --- | --- |
| 路由身份（method + path）/ 值形状 / body 形状（`Route` / `ROUTES` / `paramOps` / `bodies` + `readBodies` / `queries`；api 侧匹配器由表派生，参数路由的 `:id` 模板仍在 `api/routes.ts` 的 `PARAM_PATTERN_PATHS` 手写、漂移由 `tests/api/routes.test.ts` 现形，`ADR-0051`） | `shared/wire.ts` | 业务判据 |
| 书目元数据字段集 | `shared/wire.ts` 的 `SHELF_META` + `pickShelfMeta` | 读取面投影（`sourceName` 刻意不进表）、数值位归一化（归 `Shelf`） |
| 架位（书架上的一条记录，凭 `bookKey` 认） | `services/shelf.ts` 的 `Shelf`；客户端算式 `client/search-view-model.ts` 的 `shelfSeats` / `isSeatLanded` / `newlyLandedSeats` / `addAllReceipt` | 逐源行怎么认（那是 `rowId`）、元数据字段集（`SHELF_META`） |
| 工具面书架投影（字段、schema、picker） | `tools/shelf-item.ts` 的 `SHELF_ITEM_FIELDS` / `SHELF_ITEM_EXCLUDED` / `pickShelfItem` | 书目字段集、缺键投影（`tools/project.ts`） |
| 工具声明（一工具一声明、一 action 一行） | `tools/tools.ts` 的 `buildTools`（`shelfRows` / `sourceRows` 派生 enum 与描述）+ `tools/render.ts` 的纯 render | 业务判据、缺键投影、书架字段集 |
| 工具面搜索回执的三条派生（未答话源逐家点名 / 超上限说明 / AI 候选为 0 的配置指引） | `tools/search-value.ts` 的 `failedSources` / `truncationNotice` + `tools/render.ts` 的 `renderSearch` | 轮级计数与分区（`shared/round-summary.ts`）、按书归并、相关性判据、AI 候选数（`services/reading.ts`）、披露三件套的组装（`dshnovel_search` execute） |
| 加架动作（路径 + body + 成败形状） | `src/client/shelf-action.ts` 的 `addShelfSeat`（`ShelfSeatInput` / `ShelfAddOutcome`；路径与 body 由 `paramOps.shelfPut.path` + `bodies.shelfAdd` 给） | 回执位置与措辞（各视图；阅读器的成败泳道归 `client/reader-scene.ts`，`ADR-0045`）、加架排队（`client/search-landing.ts`）、落架账（`client/panel-shelf.ts`）、架位真相与字段集 |
| 规则求值三段：整条规则模式 / 段识别与切分次序 / 空态裁决 | `engine/mode.ts` 的 `isJsonRule`（入口 `engine/evaluate.ts`）；`engine/parse.ts` 的 `classifySegment`；`engine/select.ts` 的 `reducePicked` | 组合符语义（`engine/combine.ts`）、服务层的值收口 |
| 规则文法（构词 + 解析 + 区域） | `engine/grammar.ts` | 求值 |
| 判定用的子树文本（含脚本/样式文本、不含注释） | `engine/dom.ts` 的 `rawTextOf`（消费点：`select.ts` 的 `textOf` / `extract` 与 `xpath.ts` 的谓词文本） | 正文产出文本（`nodeText`）、直系文本（`directText`） |
| 组合符形状与驱动长度 | `engine/combine.ts`（读 `usage`） | 链衔接 |
| 子规则求值用途（`java.getString*` / 模板 `{{…}}` / `@put` 的 value/list 判据） | `engine/sub-rule.ts` 的 `subRuleOf`（`SubRule`；取值终端判据 `engine/select.ts` 的 `isValueTerminal`）；入口 `engine/evaluate.ts` 的 `evaluateRef` / `interpolateTemplate` / `engine/js-protocol.ts` 的 `evalRule` | 主链用途（`classifyDefault` / `ParsedRule.usage`）、组合符语义 |
| 行模板的判定与绑定 | `engine/regex-row.ts`（同一份文法的两面） | 模板字面段 |
| 用户正则的死线求值 | `engine/regex-guard.ts` 的 `deadlineFor` 与五条 `vm.Script`（`ADR-0050`） | 规则语法解析、超时落成哪条带定位的错误（各调用点转 `RuleEvalError`，见 `engine/errors.ts` 的 `RegexDeadlineError` 归属）、js 沙箱那条预算（`config.ts` 的 `jsTimeoutMs`） |
| `EngineValue → 单串` | `engine/js-utils.ts` 的 `engineValueToString` | 业务字段语义 |
| 宿主方法面与两条影子面（元素 `__elem.*` / 包 `__pkg.*`） | `engine/js-protocol.ts` 的协议表（async 行另带 `bridge`；`ADR-0004` / `ADR-0005`）；`engine/host-surface-elem.ts` 的 `ELEM_OPS` / `elemHostOp` / `elemWrapperSource`；`engine/host-surface-pkg.ts` 的 `PKG_OPS` / `pkgHostOp` / `pkgWrapperSource` | 真实网络；协议表与影子面的次序 |
| 脚本可见面（`EvalContext` 字段 → init 键 → 全局名 / excluded） | `engine/script-surface.ts` 的 `SCRIPT_FIELDS` / `scriptInitOf` / `scriptGlobals`（消费点 `js-sandbox.ts` 的 `initOf` 与 BOOTSTRAP） | `result` / `mounts` 等求值期字段、book/chapter/source 的自定义物化 |
| 引擎进程内缓存上限与 `__host` 描述符 | `engine/stores.ts` 的 `createFileStore`（条数 + 单文件字节两道闸；消费点 `js-protocol.ts`）；`engine/host-object.ts` 的 `ResponseHost`（`__host:'map'` 由 BOOTSTRAP 内部物化） | 按源隔离的状态四表、jsLib URL 缓存、宿主函数直接过界 |
| 选项语义（模板 → 请求计划）与出站（超时 / 代理 / 解码 / 状态） | `services/request.ts` 的 `assembleRequest` + `fetchInitOf`；`services/fetcher.ts`（`@js` 复用同一出口） | 网络与解码细节、缓存与业务 |
| 源请求执行（动态头 / 限速 / webview / loginCheck / cookie 桥；只按计划选 charset） | `services/source-request.ts` 的 `createSourceRequest` / `SourceRequest`；loginCheck 判据归 `services/login-check.ts` 的 `applyLoginCheck` | 模板解析、解码（`services/fetcher.ts` 的 `decodeBody`）、动态头求值（`resolveHeaders`）、探针判据 |
| 调用方取消（工具/任务的 `AbortSignal`） | `src/tools/tools.ts` 的 `ToolExec` / `checkAbort`；`services/fetcher.ts` 的 `FetchInit.signal` 分支；`services/reading.ts` 的 `searchProgressive` / `probe`；`source-request.ts` 的 `ReadFetchOptions` | 超时预算、任务停止与终态词汇（`shouldStop` / `HostTie`，`ADR-0018`）、浏览器导航执行期中断 |
| 源脚本求值（能力面装配 / 动态头 / 非递归与回退 / `book` 镜像） | `services/source-eval.ts` 的 `createSourceEval` / `engineContextOf` / `resolveHeaders` / `bookMirrorOf` | 面枚举与 `EvalContext` 形状、抓取与限速、逐面身份字段与 `chapter` 形状（调用方） |
| HTTP cookie jar（域/路径/过期/Secure/容量闸；跨源共享） | `services/cookies.ts` 的 `CookieJar`；Set-Cookie 吸收/回带归 `services/fetcher.ts` | 脚本侧按源 cookie 垫片、浏览器 cookie 桥；跨源共享裁决见 `ADR-0039` |
| 源状态会话（脚本可见四张按源表；写只标脏，求值边界与卸载成批落盘；删源当场落盘且此后在途句柄不再写回） | `services/source-session.ts` 的 `FileSourceSession`（`forget` / `flush`）；接口 `engine/session.ts` 的 `SourceSession` | 页面缓存、登录态 `SourceAuth`；同步写例外见 `ADR-0013` |
| 真浏览器运行时（启动 Edge/Chrome、上下文、超时、关闭）与源级限速 | `services/webview.ts` 的 `WebViewRuntime`；`services/rate-limit.ts` 的 `parseConcurrentRate` / `RateLimiter` | 限速与 cookie 桥、规则求值、出站时序与按源装配 |
| 探针 verdict → status 的写回 | `services/probe.ts` 的 `applyProbeResult`：门面 `services/reading.ts` 的 `probe` 交 `ProbeOutcome`，两个投影面只翻/投影——`api/dispatch.ts` 写 `result`、`tools/tools.ts` 投影 `status` | 探针判据与关键词、verdict→status 的算式（不在投影面第二遍） |
| 一次搜索请求的完整语义（含嗅探） | `services/search-face.ts` | 聚合与游标 |
| 读一页条目（模板 + 变量 + 列表规则 → 条目上下文；搜索面与发现面共用） | `services/list-page.ts` 的 `readListPage` | 模板来源与规则缺失判据（各面）、抓取执行、逐条装配（`bridge.hitsOfContexts`） |
| `searchUrl` 的 JS 形态模板（`@js:` / `<js>`）求值 | `services/search-template.ts` 的 `resolveSearchTemplate` | 一次搜索的编排与嗅探、URL 模板通用组装（`request.ts`） |
| 值投影（`EngineValue` → 业务串） | `services/bridge.ts` 的三种投影 | 空态判定；条目装配面怎么消费 |
| 文字输出 | `services/content.ts`（HTML→文本收口）+ `shared/chapter-text.ts`（正文投影与行规约） | 图文排版 |
| 缓存「放在哪」与容量账 | `services/cache.ts` 的 `PageCache`；字节账 `services/size-ledger.ts` 的 `SizeLedger`（`PageCache` 与 `TtsAudioCache` 共用） | 何时有效（`cache-epoch.ts`）、每种缓存自己的上限与目录 |
| 进程内有界 LRU 的读升与淘汰次序 | `services/lru.ts` 的 `lruGet` / `lruSet`（上限由调用方给） | 磁盘缓存字节账、跨重启的源状态 |
| 缓存「还有效吗」 | `services/cache-epoch.ts`（代际 + 槽位），消费点 `services/online-reading.ts` 的 `OnlineReading` | 清理策略 |
| 在线目录 / 正文管线（进程内目录缓存、磁盘缓存优先、目录在途去重、翻页跟进、subContent、空正文异常） | `services/online-reading.ts` 的 `OnlineReading`（`toc` / `chapterText`） | 本地/在线分流（`book-content.ts`）、本地书目录/正文、缓存有效性算式、翻页判据、出站执行 |
| 导入失败的半径与后果表 | `services/epub/findings.ts` 的 `FINDING_RADII`（痕按名字发、投影 `warningListOf`）；`item` 级剪除由 `services/epub/package.ts` 的 `parseSpine` / `pruneDeadTargets` 执行，其余后果由 `services/epub/import.ts` 执行；整本拒的出口 `services/epub/errors.ts` 的 `rejectBook` / `bookError`（`ADR-0061` / `ADR-0063`） | 包结构与归档读取、本地书落盘与入架、运行期读到损坏产物 |
| 本地书读取面的进程内缓存（元数据表与 TXT 全文各一张、按书 LRU；元数据读取在途去重，删书即失效） | `services/localbooks.ts` 的 `LocalBooks`（`metaOf` / `metaCache` / `textCache`） | 落盘形状与版本读 codec（`local-meta.ts`）、导入发布、原子写、元数据有效性算式、EPUB 包内解析 |
| 本地书生命周期（一本本地书 = 磁盘副本 + 一个架位） | `services/local-lifecycle.ts` 的 `LocalLifecycle`（适配 `LocalBooks` 与 `Shelf`，`copies` 缺席时落 `LocalNotMountedError`） | 副本发布与回收、架位真相与落盘调度、本地/在线分流、门面的一行委托 |
| 本地导入的书目投影与旧条目补数 | `services/local-lifecycle.ts` 的 `importBook`（`totalChapters` 由 `chapterCount` 投影，作者/封面来自 `LocalImportResult.book`）与 `backfillChapterCounts` | 导入结果本身（`LocalBookMeta`）、字段名与落盘归一化（`SHELF_META` / `applyPatch`） |
| 书内容读面（目录 / 导航 / 正文的本地与在线分流 + 文字规约 + 一章文字面读的编排） | `services/book-content.ts` 的 `BookContent`；文字规约 `shared/chapter-text.ts` 的 `normalizeChapterText` | 在线缓存/翻页/空正文、EPUB 包内解析、图文结构投影、越界错误归类、门面一行委托 |
| 朗读引擎订阅注册表与可编辑字段集（合成链真正消费的三格：`contentType` / `header` / `jsLib`） | `services/tts-engines.ts` 的 `TtsEngineRegistry`（`list` / `get` / `put` / `remove` / `importJson`；保留 id 判据 `isReservedTtsEngineId`）；`shared/wire.ts` 的 `TTS_ENGINE_TEXT_FIELDS`（`TtsEngineTextField` 由它派生） | 合成请求求值（`tts-request.ts`）、音频缓存、对外投影形状、降级后果（`requireEngines`，`ADR-0077`）、各字段值域与落盘整体替换、`voices` 的「缺席 = 保留」特例 |
| 段合成（缓存命中即回执；未命中同键在途合并后按引擎源分流：内置 / 订阅走声明式 HTTP 模板，宿主语音服务走归一形状） | `services/tts.ts` 的 `TtsService`（`synthesize` / `coalescedProduce` / `sourcesView` / `openAudio`；内置表 `BUILTIN_TTS_ENGINES`）与 `TtsSynthesisPlan`——identity 与 produce 同住一支 adapter；取消位沿合并槽下传：调用方 `signal` 只决定这一员加入 / 退场，最后一员退场才中止上游（`ADR-0082`）；`appliedRate` 由各支产出（`ADR-0081`） | 请求模板与「响应必须是音频」判据（`tts-request.ts`）、宿主语音服务适配（`tts-cordis.ts`）、订阅注册表、音频缓存、浏览器直出（`client/tts/direct-output.ts`） |
| 宿主朗读服务健康（不在场 / 在场未就绪＋原因码 / 就绪；与源清单同出一次能力读数） | 形状 `shared/wire.ts` 的 `HostSpeechHealth` / `TtsSourcesView`；读数 `services/tts-cordis.ts` 的 `readinessOf`（有效供应商 `effectiveProviderId`）与 `services/tts.ts` 的 `TtsService.sourcesView`；路由 `api/dispatch.ts` 的 `ttsSources` 臂 | 源清单本身、合成期具名失败（`TTS_ENGINE_UNAVAILABLE`）、管理面文案分叉（`client/tts/engine-rows.ts`）、原因码本身（`ADR-0083`） |
| 段音频缓存（键 = 引擎 + 实际请求 identity + 文本；headers 不入键（`ADR-0069`）；数据根 `cache/tts`；先字节后侧车；侧车存 `appliedRate`；容量账共用 `SizeLedger`） | `services/tts-cache.ts` 的 `TtsAudioCache` / `ttsCacheKey` / `AudioMeta`（`ADR-0081`） | 合成与上游请求、页面缓存、浏览器直出（无缓存） |
| 听书播放层（模块级常驻状态机：播放单元推进、同段回执合流、同章自适应预取与出声槽预载、跨章预取交接、定时、连败暂停、两条出声分支、位置落盘、在途合成取消位）与段进度 | `client/tts/listen-session.ts` 的 `ListenSession`（`ListenPlatform` 注入；`modeOf` 分流；`readerPresent` 决定是否补 `progress`，`ADR-0093`；`startFromReadingPosition` / `startSession`，`ADR-0095`；`receiptFor` / `syncNextAudioPreload` / `pumpPrefetch` / `prefetchNextChapter` / `moveChapter`；`NextChapterPrefetch` 的独立取消位与交接判据，`ADR-0102`；`PlayerRun.abort` / `cancelInFlight` / `cancelNextChapter`，`ADR-0082`）；两条分支策略与生命周期归 `client/tts/playback-branches.ts` 的 `BytesBranch` / `DirectBranch`（契约 `client/tts/output-contract.ts` 的 `PlaybackBranch` / `ListenBranches`，介质经 `BytesOutput` / `DirectOutput`）；生产单例 `client/tts/player.ts` 的 `ttsPlayer`；生命周期终点 `ListenSession.dispose`（`client/index.tsx` 调用 `disposeTtsPlayer`，`ADR-0092`）；段进度 store 经 `ttsProgress` 再导出 | 播放单元切分（`shared/chapter-text.ts` 的 `splitParagraphs`）、听书细节轨形状（`ListenState`）、共用消费位置与阅读时序、可见文案、出站请求自己的取消、浮窗进度环与章内进度条呈现 |
| 听书上屏读数（段读数 / 定时读数 / 章内进度算式 / 语速读数 / 整块上屏投影：可否暂停、连败停因、有无段读数、段内进度是否真读数、音色面） | `client/tts/listen-readout.ts` 的 `listenFaceOf` / `isPlayBusy` / `segmentLabel` / `miniSegmentLabel` / `timerReadout` / `chapterProgressOf` / `rateLabel` / `lineOf`；停因由 `client/tts/listen-session.ts` 的 `halt` 发布 | 计时现场与落盘 |
| 跟读高亮与视口跟随（命中块换字色并在段首画小三角；跟随开启时播放推进带视口，读者手动滚动 / 导航让位，定位按钮重新接上） | 起段号 `shared/chapter-text.ts` 的 `playUnitStarts` / `playUnitStartsByNode`；命中判据 `client/reader-paragraph.ts` 的 `paragraphSlotOf` / `listenParagraphElement`；跟随策略 `client/tts/follow-controller.ts` 的 `createFollowController` / `onPlayback` / `onLocate` / `onUserIntent` / `onRelocation`；视图接线 `client/views/ReaderView.tsx` 的 `takeOverReading` / `locateListen` / `followBottomInset`；精确落位 `client/reader-session.ts` 的 `reveal` / `settleReveal` 与 `client/reader-geometry.ts` 的 `targetOffsetOfParagraph`；呈现 `ChapterBody.tsx` 的 `listenParagraph` 与 `styles/reader.ts` 的 `.novel-tts-live`（`ADR-0096` / `ADR-0076`） | 滚动与共用位置落盘、位置落盘（阅读器在场时 `progress` 归阅读会话；播放层只写 `listen`，不在场时补 `progress`） |
| 正文选区起播（选中正文 →「从本段听」浮钮 → 从该段起播；章身份取最近的 `[data-chapter]`、段号取块上的 `[data-pidx]`） | `client/views/listen-from-selection.ts` 的 `useListenFromSelection`；浮钮与接线 `client/views/ReaderView.tsx` | 段号口径、起播动作（`client/tts/player.ts` 的 `startFromReadingPosition`）、正文渲染（`ChapterBody.tsx`） |
| 共用消费位置与听书细节（章 + 章内比例；段号 + 引擎 / 音色 / 语速 / 音量） | 形状 `shared/wire.ts` 的 `ShelfProgress` / `ListenState`；服务端写口 `services/reading.ts` 的 `shelfSaveProgress` / `shelfSaveListen` → `services/shelf.ts` 的 `Shelf.updateProgress` / `Shelf.updateListen`；客户端写者 `client/reader-session.ts` 的 `commit` 与 `client/tts/listen-session.ts` 的 `writePosition`；读口谓词 `shared/reading-position.ts` 的 `hasProgress` | 段内计时现场（`ttsProgress`）、播放队列（`client/tts/player.ts`）、书架卡片展示（`client/shelf-view-model.ts` 的 `shelfCardMeta`） |
| 迷你条浮窗现场（两形态共享块中心；位置与尺寸记意图、呈现时夹取不回写；近边吸附、视口变化后贴边继续贴；落位以**可达区**为界 = 视口减宿主窗控带，夹取 / 吸附 / 缺省落位 / 尺寸上限 / 弹层余量共用同一把尺；偏好落 localStorage） | `client/tts/mini-bar-state.ts`（指针会话与视口对账归 `createMiniBarController`；`miniBarStore` / `miniBarLayout` / `miniBarCenterOf` / `resolvedMiniBarSize` / `setMiniBarCenter` / `snapMiniBarToEdge` / `setMiniBarSize` / `clampMiniBarIntoReachableArea` 同住；窗控带读数 `frameTopInsetOf` 随 `readViewport` 一起取，`ADR-0100`） | 两个形态的呈现（`TtsMiniBar.tsx` / `TtsMiniPanel.tsx`）、播放会话与读数、在场判据（`reader-presence.ts`）、阅读器顶条的遮挡读数（`ReaderView.tsx` 的 `topInset`） |
| 听书路由面的传输落点（源清单＋健康 / 段合成 / 音频读口 / 订阅 CRUD 的回包、错误码与二进制头；合成臂把断连接成取消位） | `api/dispatch.ts` 的 `ttsSources` / `ttsSynthesize` / `ttsAudio` / `ttsEngines` / `ttsEnginesImport` / `ttsEnginePut` / `ttsEngineDelete` 臂 | 路由身份与 body 形状、合成业务、音频缓存、取消语义（`ADR-0082`） |
| 章节范围导出的区间语义（缺省全本 / 越界裁剪 / 裁剪后倒置，以及两条 422 的来源） | `services/reading.ts` 的 `exportRange`（`ExportOutcome` / `ExportPlan`：一次目录读数定案，plan 自带流） | 逐章抓取、章间节流与失败即停（`services/export.ts`）、参数形态校验（`dispatch.ts` 的 `parseEdge`）、422 文案与状态码、写头/背压/中断标记 |
| 删书顺序（单删 / 批删 / 本地删共用「先删本地副本，失败则架位保留可重试」） | `services/local-lifecycle.ts` 的 `LocalLifecycle`（`removeBook` / `removeBooks` / `removeLocalBook` 共用私有顺序；`removeLocalBook` 是「不在架也清副本」的唯一例外） | 本地副本删除（`localbooks.ts` 的 `remove`）、架位移除（`shelf.ts`） |
| tocUrl 规则求值（null 回退 bookUrl / 静态短路 / 详情上下文过引擎） | `services/online-reading.ts` 的 `tocUrlOf` | 静态短路与上下文求值判据（`bridge.ts`）、详情页抓取（`source-request.ts`） |
| 入库规则（什么算同一本书源） | `services/intake.ts` | 呈现与计数 |
| 源清单与落盘调度（变更口 / 防抖 / 阈值 / flush 失败） | `services/sources.ts` 的注册表（`edit` / `flush`；写失败移交 `retainWriteFailure`）；`services/storage.ts` 的 `createDebouncedWriter`（`SourceRegistry` / `Shelf` / `TtsEngineRegistry` 各持一只；窗口 `PERSIST_WINDOW_MS`） | 任务节流；阈值住 `services/sources.ts` 的 `PERSIST_EVERY`；`Shelf` 只经私有 `edit(recipe)` 排写 |
| AI 搜索源标记（与启停正交的用户偏好：导入缺省关闭、重导入保留、存量缺键收敛为关闭） | `services/sources.ts` 的注册表（`setAiSearch` / `toPublic` 的 `aiSearch`）与 `services/normalize.ts` 的 `rehydrateStoredSource` 迁移 | 参与集判据（`participation.ts` 的 `aiParticipates`）、AI 工具搜索（`reading.ts` 的 `searchForAi`）、书源管理界面、工具面写口 |
| 存量收敛（已落盘源按 raw 收敛） | `services/normalize.ts` 的 `rehydrateStoredSource`（触发点只有 `SourceRegistry.load`） | 何时加载 / 何时落盘 |
| 规则字段集（模型键 × 两方言路径（发现面族除外）× 隐式终端 × 落位方式 × 存量覆盖模式 × 配对目标 / 整套闸 / 段序） | `services/rule-fields.ts` 的 `RULE_FIELD_SPECS`（导入循环、两方言映射、配对索引、发现面字段与指纹、存量段序都由它派生；`legadoContainersOf` 从方言映射派生展平前的容器集） | 方言判别与展平、发现面整套落位/展平、条目装配侧整套切换（`bridge.hitRuleOf`）、值怎么收口、缓存代际按字段的影响面 |
| 原子写与 JSON 读的两分判别 | `services/storage.ts` | domain 的合并写策略 |
| 翻页何时停 | `services/pagination.ts` 的 `followPages` | 站点结构解析 |
| 本地书身份（`bookKey` 的 `local:<uuid>` 形态） | `services/localbooks.ts` 的 `BOOK_KEY_RE` / `isLocalBookKey`（`LOCAL_SOURCE_ID` 归 `shared/wire.ts`） | 本地/在线内容分流、EPUB 包内解析 |
| 聚合搜索的参与集 | `services/participation.ts` 的 `participates`（界面）、`exploreParticipates`（发现面）、`aiParticipates`（AI 工具面） | 源清单读写、AI 标记写口与呈现 |
| 写动词的缺席语义（按 key 点的目标不存在：更新动词里是错误、删除动词里是幂等成功） | 更新路径：`services/errors.ts` 的 `BookNotOnShelfError`（`classify` → 400）与 `services/reading.ts` 的三个书架更新动词；删除路径：`services/reading.ts` 的 `removeSource` 与本地删的计数 | HTTP 状态与可行动文案（`api/dispatch.ts` 的 `shelfUpdate` / `NOT_ON_SHELF`）、幂等回执形状、探针 outcome |
| 错误类目 → HTTP，与同源 fence 的四步判据（远端 → Host → Origin → Referer）及本机 Host 名单 | `services/errors.ts` + `api/wire.ts`；`api/wire.ts` 的 `fenceDenialOf` / `fenceAllowlist` / `LOOPBACK_HOSTNAMES`；追加别名 `config.ts` 的 `apiAllowHosts`；403 措辞 `dispatch.ts` 的 `fenceDenialMessage`（`ADR-0016`） | 路由自检错误、路由身份与 body 形状、错误 → 状态码的两分法、cookie 串解析 |
| 调用者身份（谁可以调 `/novel-api`：带凭据只放 owner，无凭据按本机调用） | `src/index.ts` 的 `identityVerdict` / `connectionOf`（宿主 `ctx.connection.admit` 的窄镜像，`ADR-0103`） | 来源判据（上一行）、错误 → 状态码的两分法、路由身份与 body 形状 |
| 听书缺省（四格生效值的来源裁决：链序 = 优先级、读时求值、判读单点、逐格失败半径） | `src/client/tts/tts-defaults.ts` 的 `createTtsDefaults`（判读 `READABLE` 同住，`ADR-0104`）；宿主名字表与两个来源 adapter `src/client/tts/tts-defaults-host.ts` | 播放层回退链的前两环（起播处的 `??` 链）、值域（schema / 播放层 clamp）、草稿（`config-draft`） |
| cookie 串的 `k=v;` 解析（登录脚本产出与登录面板手工输入同一条语法） | `shared/cookies.ts` 的 `parseCookieString` | 登录态往哪落盘（`reading.ts` 的 `saveAuth` / `login`） |
| 登录执行（run-login：源存在性、loginUrl 形态判别、脚本执行 → outcome 判别联合） | `services/reading.ts` 的 `login`（`LoginOutcome` 单点；`loginPlan` / `runLogin` 是门内私有构件） | 登录态落盘形状与应用、按钮动作、body 形状、outcome → 状态码与文案的翻译（`dispatch.ts` 的 `authRoute`） |
| 日志前缀与级别出口 | `services/log.ts` 的 `log` / `setLogSink`（console + `ctx.logger` 双腿）；例外：`engine/rejection-guard.ts` 的 `consoleGuardSink` 自持前缀；未处理 rejection 分档与守卫生命周期同住（`ADR-0059`） | 日志往哪投 |
| 任务过程行与「本轮状态变了」信号 | 缓冲与偏移读 `services/job-tail.ts` 的 `JobTail` / `readFrom`；宿主登记机械 `services/job-holder.ts` 的 `HostTie`；信号 `ChangeSignal`（只发信号不发数据） | 整轮结果与业务明细（各持有者快照读面）、状态形状与槽政策、快照形状与游标推进 |
| 浏览器半任务观察通道的仪式（timer / SSE 优先 + 轮询兜底 / 任一时刻只一条通道 / 撤通道连 timer / 代际作废在途帧） | `client/job-channel.ts` 的 `createJobChannel`（三个消费点：`client/search-job.ts`、`client/explore-job.ts`、`client/jobs.ts`） | 快照形状、累积器与游标、整帧替换、身份判据与恢复策略的内容、节拍与文案 |
| 搜索的整轮结果 / 轮的开始与归属 | 整轮结果 `services/search-job.ts`（Node 半持有）；开始与归属 `client/search-job.ts` 的 `submit`（返回本轮 `jobId`；书籍详情浮层按 id 认领，搜索结果页跟随最近一轮） | wire 形状、服务端单槽与跟随最近一轮（`ADR-0046`）、轮级派生 |
| 搜索呈现派生：跨源归并（作品视图判同）/ 轮级计数与分区 / 结果页行身份与架位 | `shared/merge-by-book.ts` 的 `mergePartitioned`（形状与上限 `MergedBook`／`MergedSource`／`SEARCH_BOOKS_CAP`）；`shared/round-summary.ts` 的 `summarizeRound`（`RoundPartition` / `RoundCounts`；answered 数答了话的家）；`client/search-view-model.ts` 的 `deriveRound`（`groupViews` / `bookViews`） | 不替用户判该用哪家读、不服务书籍详情浮层、不改架位与进度（`ADR-0033`）；轮次累积与游标、加架排队、落架账 |
| 搜索落架排队（逐本「都加架」在途、两条加架入口的排队；`landed` 读面板期投影） | `client/search-landing.ts` 的 `useSearchLanding`（`landed` / `adding` / `isLanded` / `add` / `addAll`；写口注入，生产是 `addShelfSeat`） | 落架账与书架读取面、书架真相、写口语义、架位与回执算式、回执措辞与通道 |
| 相关性判据（一条命中与本轮关键词的关系档位） | 形状 `Relevance` 在 `shared/wire.ts`；判据与三档序 `shared/relevance.ts` 的 `relevanceOf` / `partitionByRelevance` / `RELEVANCE_RANK`（三个落点加只收 `kept` 的归并面都只吃这一份） | 不判书架、不判发现面 |
| 分类浏览：`exploreUrl` 形态判据与入口解析 / 一次分类页请求 / 分类清单 / 单源一页执行 | `services/explore-url.ts` 的 `exploreKindsFormOf` / `parseExploreKinds` / `usableKind`；`services/explore-face.ts` 的 `fetchKindPage`（回落判据归 `bridge.hitRuleOf`）；`services/explore.ts` 的 `deriveExploreSources`（分类清单）与 `fetchExploreGroup`（抓 → 写回 → 出一个组，从不抛错） | 落位与平铺优先、这次用哪份模板、整轮编排与快照写回、点名与页码、轮次状态与终态 |
| 整轮分类结果 | `services/explore-job.ts`（Node 半持有，读面给全量快照） | wire 形状 |
| 书城进入判据（自动那条路的源/分类回落与提交决策） | `client/city-entry.ts` 的 `decideCityEntry` / `resolveCitySelection` | 分类轮次持有与续页、分类清单派生、手点提交 |
| 书城选中态（源 + 分类 + 本挂载 one-shot） | `client/city-selection.ts` 的 `useCitySelection` / `rememberedCitySelection`（`select` 只写 `cityStore`，视图读投影） | 进入判据、分类轮次、提交回包闸（`client/explore-job.ts` 的 `submitted`） |
| 跨源那一次的关键词构造（有作者就带作者） | `client/city-view-model.ts` 的 `sheetKeyword`（消费者只有书籍详情浮层，链路复用搜索面） | 是不是同一本书（判同在搜索面归并那一行）；浮层维持逐源轴、不吃归并 |
| 逐条目取值装配（源 + 规则来源档 + 一个条目上下文 → 一条命中） | `services/bridge.ts` 的 `hitRuleOf` / `hitFieldsOf`（搜索面与发现面共用） | 读不出来归成哪类错（各自调用侧） |
| 分类快照的存放与时效 | `services/explore-cache.ts` 的 `KindCache` + `services/cache-epoch.ts` 的 `exploreEpoch` | 目录 / 正文文件缓存 |
| 配置口径（名字 / 类型 / 缺省 / 值域 / 是否活值）与插件页表单 | `config.ts` 的 `CONFIG_FIELDS` / `resolveConfig` / `VOLATILE_CONSUMERS`；插件页表单 `client/config-page.tsx` 的 `registerConfigPage` / `NovelConfigCard`；设置面命名空间键 `ENTRY_ID`、describe 形状 `SettingsDescribeValue` 与草稿机归 `client/config-draft.ts`；筛选/分区/折叠现场归 `client/config-index.ts` | 运行时环境探测（如系统代理读取）；启动期 `dataDir`、HTTP 路由 |
| 缺省值 | 各消费模块一个主人（`tests/services/defaults.test.ts` 钉常量） | 第二处字面量 |
| 浏览器视图内路由与跨卸载现场 | `client/store.ts` + 各模块级现场 store | 业务真相 |
| 面板期书架投影（书架读取面 + 落架账 + 筛选/关键字） | `client/panel-shelf.ts` 的 `panelShelf`（`NovelView` 卸载时清空） | 搜索轮次与任务快照、书架真相 |
| 模态契约（Esc / 入场焦点 / Tab 圈 / 关后还焦 / scrim 与 dialog 标记） | `client/views/dialog.tsx` 的 `Dialog` 与 `useDialogContract` | 几何档位（样式层）、标题与动作行文案（各调用点） |
| 客户端可见文案与错误展示 | `client/copy/index.tsx` 的 `ZH` / `EN` / `createTranslate` / `zhTranslate` / `CopyProvider` / `useCopy` + `client/copy/search.ts` + `client/copy/search-summary.ts` 的 `searchSummarySegments` + `client/api.ts` 的 `describeError` / `NetworkReason` | 服务端错误原文、AI 工具描述、插件卡片的 `locale` 元信息 |
| 阅读时序（视口喂入合帧 `feedViewport`、排版前采点与复位 `applyTypesetRelocation`、提交信号 `state.domRevision`） | `client/reader-session.ts` | DOM 测量、监听安装、帧泵与端口刷新（`client/reader-binding.ts`）、视图标记结构与纯 UI 策略 |
| 阅读器几何（`ReaderPort` 的纯几何实现：锚点/视口偏移/目标偏移/当前节点） | `client/reader-geometry.ts` 的 `createReaderGeometry` / `currentNodeOf`（坐标换算 `client/scrollport.ts`；落项判据 `client/viewport-top.ts` 的 `crossedIndex`） | 阅读时序、事件监听安装与端口刷新、合帧判据 |
| 翻页阅读（单/双页几何与分栏模式、页码、点击区、键盘/滚轮/触摸翻页、跨章落位、段落锚定重排、页内探针与纯 CSS 动效） | 几何与页码 `client/reader-pagination.ts` 的 `computeSpreadLayout` / `computePageCount` / `classifyClickZone` / `firstParagraphInSpread` / `DOUBLE_PAGE_MIN_WIDTH` / `DOUBLE_PAGE_FORCE_MIN_WIDTH` / `DOUBLE_PAGE_COLUMN_SCALE`；分栏偏好 `client/store.ts` 的 `PageColumns`；舞台与交互 `client/views/BookStage.tsx`；会话 paged 路径 `client/reader-session.ts` 的 `setPaged` / `scrollToSavedPosition` / `reportPosition` / `prefetchChapter`；视图接线 `client/views/ReaderView.tsx` 的 `isPaged` / `takeOverReading`（`ADR-0101` / `ADR-0105`） | 滚动阅读的锚点/回补/拍点（`reader-session` / `reader-binding`）、听书播放层、可见文案与像素档位 |
| 阅读渲染后拍点（落位 → 重测锚点 → 结算滚动补偿 → 预取/回溯补载） | `client/reader-session.ts` 的 `afterRender`（`client/reader-binding.ts` 在测量帧里调它：先刷新端口 → `afterRender` → 拍点后回调；触发判据 `state.domRevision`） | DOM 测量、滚动/排版事件、单次提交的测量排帧 |
| 阅读浮层在场与互斥（至多一角、换角退场语义、哪面带遮罩、模态同场时 Esc 归谁） | `client/reader-surfaces.ts`（`openSurface` / `closeAll` / `dismissSurface` / `maskFor` / `escOwner`；阅读场景的 `surface` / `mask` / `escOwner` 都是投影） | 阅读位置与返回栈、带遮罩模态 |
| 阅读场景（当场面与注释载荷、返回句柄、Esc 命令、离开一问与入架写入） | `client/reader-scene.ts` 的 `ReaderScene`（命令面 `toggle` / `openNote` / `close` / `handleEsc` / `dismissAsk` / `openTarget` / `bodyLink` / `panelLink` / `exitToShelf` / `joinAndBack`；写口以 `addSeat` 注入） | 阅读时序、至多一角纯判据、模态契约与焦点、DOM 测量与滚动事件、导出编排、文案 |
| 章节窗口的向前判据（边界哨兵 + 两屏 → 视口章之后第一个未载章） | `client/reader-load.ts` 的 `nextLoadTarget` / `nextChapterIndex` | 会话状态；已载窗口保留深度、滚动补偿与回溯补载 |
| 章内位置 codec（像素 / 段数）与段落号 ⇄ 屏上块 | `client/progress.ts`：measured `locateChapter` / `ratioWithin` / `anchorTop`；uniform `paragraphRatio` / `estimateParagraphIndex`；`client/reader-paragraph.ts` 的 `paragraphSlotOf` / `listenParagraphElement`（`client/tts/reading-position.ts` 只再导出） | 落盘时机、三条数据路各自的读数采集；段号口径归 `shared/chapter-text.ts` 的 `playUnitStarts` |
| 视口顶判据（给定有序起点与视口顶，谁是当前项）与顶条遮挡读数 | `client/viewport-top.ts` 的 `crossedIndex`（消费点：`progress.ts` 的 `locateChapter`、`reader-geometry.ts` 的 `currentNodeOf`、`tts/reading-position.ts` 的 `readingPositionAt`）与 `clampTopInset`（两条遮挡读数都从这里过尺：阅读器顶条取 `ReaderView.tsx` 的 `topInset`，每次现量；听书浮窗的宿主窗控带取 `tts/mini-bar-state.ts` 的 `frameTopInsetOf`，随窗口读数取，语义见「窗控带与安全顶」；`ADR-0089`） | 三条数据路的采集与性能取舍、顶条标记结构与高度测量、落位与落盘时序 |
| 视觉 token 与标度 | `client/styles/tokens.ts` 的 `TOKENS_CSS`（配色契约、named 标度与 `--novel-*` 缺省定义）；暗层 `.novel-dark` 在 `client/styles/shell.ts`；`client/styles.tsx` 只是拼装点 | 视图局部布局（各块）、块间次序（次序即行为） |
| 兼容读数与裁决 | `tests/legado-coverage/matrix.ts` 的行 | 复述进文档 |
| 已知桥缺口名册（脚本在调、本仓没挂的 `java.*` 名字与归属行） | `tests/legado-coverage/bridge-gaps.ts` 的 `KNOWN_BRIDGE_GAPS` | 源侧新名字的发现（`DSH_PARSE_CENSUS`）、该记在哪一行（矩阵行） |

## 5. seam：可测性怎么落

- **纯函数面**直接单测，不造宿主替身：`parseRule`、`reducePicked`、`evalCss`、`evalXPath`、`evalJsonPath`、`applyReplaces`、`interpolateUrl`、`appendTail`、`bindRegexRow`、`engineValueToString`，以及客户端的 `source-list-view` / `shelf-view-model` / `city-view-model` / `city-entry` / `search-view-model` / `source-inbox` / `reader-load` / `progress`。
- **规则字段表的完备性**由 `tests/services/rule-fields.test.ts` 守：`satisfies` 抓漏键，运行时断言抓重复/多余行；两方言通用容器映射与隐式终端清单由同一批行派生；落位列是「进不进平铺循环」的唯一事实（`RULE_FIELDS` 与 `SPECIAL` 互为补集），展平入口按同一批表行现派生容器全集。派生读口的期望值在测试侧独立写死，另钉「实现派生 == 钉住字面」。
- **其余各自的门**：轮级派生预算值（`tests/client/search-view-model.test.ts`）、源求值缝的账（`tests/services/source-eval.test.ts`）、搜索落架排队（`tests/client/search-landing.test.tsx`）、面板书架投影（`tests/client/panel-shelf.test.ts`）、阅读器几何与视口顶（`tests/client/reader-geometry.test.ts` / `viewport-top.test.ts`）、绑定拍点（`tests/client/reader-binding.test.ts`）、工具 render（`tests/tools/render.test.ts`）、阅读场景交互律（`tests/client/reader-scene.test.ts`）。
- **注入垫片**是测试进出的口子（不是换模块替身）：引擎侧 `EvalContext` 的 fetch 族 / `evaluateRef` / `subEval` / `SourceSession` / 超时预算；服务侧 fetcher 与注入的时钟/目录；在线阅读管线用假 `SourceRequest` 驱动；客户端按读者分的依赖束 + `ReaderPort` + `ReaderBindingHost`，浏览器位置用例走仓内最小宿主壳。
- **两条求值路必须同口径**（主线程与 worker），由按 fetch 计数自证的跨路钉子守（`ADR-0005`）。
- 客户端的测试手法是**假 adapter 驱动真实组件**，不是渲染快照；服务端路由测试用真 HTTP server 承载。
- **门的分工别混**：解析面普查管「能不能解析」，重探只证搜索面，正文审计是报告不设通过率，compat 回放的分母是 fixture，真浏览器门只跑本机与本地书，安装门控不起宿主。各自承诺写在 `docs/development.md` 的「门（自动）」，不在这里复述。
- **回放数据住自己的家**：`tests/replay/fixtures` 与 `tests/replay/sources` 喂离线回放集（默认被 `vitest.config.ts` exclude；`sources` 是人工投放口，未脱敏的人类输入不进 `tests/`）。兼容判据不冻结外部格式快照（`ADR-0099`）。

## 6. 数据与生命周期

- 运行时数据全部住数据根（默认 `$DSH_HOME/novel/`，未设置 `DSH_HOME` 时 `~/.dsh/novel/`；`dataDir` 可改）：源清单、书架与进度、页面缓存、本地书副本。构建产物 `lib/` 不入库；`tests/replay/report.md` 是跑门产物。
- 读面与写面：源清单与书架都是**内存活体 + 按文件名排队的原子写**；「不存在」与「损坏」绝不折叠（`ADR-0013`）；本地发布与入架之间不建跨文件事务（`ADR-0014`）。
- 缓存有效性靠指纹入名而不是删除式失效，所以**没有清缓存出口是设计而非缺失**（`ADR-0012`）。
- 任务生命周期：身份与终态在宿主注册表，业务明细与整轮结果在本仓持有者；写任务一槽、搜索一槽、分类轮次一槽（后提交即替换）；任务态不持久化（`ADR-0018`）。

## 7. 改动面 → 先读什么

表只指路，不复制口径：真正的主人在第 4 节、ADR 与代码注释。

| 改动面 | 先读 |
| --- | --- |
| 规则文法 / 求值 / 链语义 | 第 2.1 节；`ADR-0001`、`ADR-0002`、`ADR-0005`、`ADR-0006`、`ADR-0007`、`ADR-0029`；矩阵 `a-*` 行 |
| 脚本求值 / 动态头 / `book` 镜像 / 登录态投影 | 第 4 节的 `createSourceEval`、`engineContextOf`、`resolveHeaders`、`bookMirrorOf` 行；`ADR-0042`、`ADR-0015`；矩阵 `b-header-js`、`h-book-mirror-fields`、`h-source-entity-fields` 行 |
| 书源导入 / 两方言展平 / 存量收敛 | 第 4 节的 `RULE_FIELD_SPECS`、`rehydrateStoredSource` 行；`ADR-0044`；`services/normalize.ts`、`services/rule-fields.ts` |
| 请求组装 / 出站 / cookie / 限速 / webview | 第 4 节的 `assembleRequest`、`fetcher`、`CookieJar`、`RateLimiter`、`WebViewRuntime` 行；`ADR-0015`、`ADR-0016`、`ADR-0039`；矩阵 `b-*` 行 |
| wire / 路由 / 工具面 | 第 2 节；`ADR-0009`、`ADR-0019`；`shared/wire.ts` |
| 工具声明 / render | 第 4 节的工具声明行与工具面搜索回执行；`tools/tools.ts`、`tools/render.ts`、`tools/search-value.ts`；`tests/tools/render.test.ts` |
| 书架 / 存储 / 缓存 / 本地书 | 第 6 节；`ADR-0010`、`ADR-0011`、`ADR-0012`、`ADR-0013`、`ADR-0014`；`services/shelf.ts`、`services/storage.ts`、`services/cache.ts`、`services/localbooks.ts` |
| 书架读取面 / 落架账 / 筛选 | 第 4 节的面板期书架投影行；`ADR-0046`；`client/panel-shelf.ts`、`client/search-landing.ts`、`client/views/ShelfView.tsx`、`client/views/SearchView.tsx` |
| 聚合搜索 / 相关性 / 按书归并 | 第 4 节的 `services/search-face.ts`、`mergePartitioned`、`relevanceOf` 行；`ADR-0032`、`ADR-0033`；矩阵 `d-*` 行 |
| 书城 / 分类浏览 | 第 4 节的 `fetchKindPage`、`services/explore-job.ts`、`decideCityEntry` 行；`ADR-0027`、`ADR-0028`；`services/explore-face.ts`、`services/explore-job.ts` |
| 客户端视图 / 文案 / 模态 / 阅读浮层 | 第 4 节的 `client/copy/index.tsx`、`client/views/dialog.tsx`、`client/reader-surfaces.ts` 行；`ADR-0037`、`ADR-0038` |
| 阅读器 / 章节窗口 / 进度 / 阅读交互 | 第 4 节的 `client/reader-session.ts`、`client/reader-geometry.ts`、`client/reader-scene.ts`、`client/reader-load.ts`、`client/progress.ts` 行；`ADR-0022`、`ADR-0045` |
| 在线目录 / 正文 / 缓存有效性 | 第 4 节的 `OnlineReading`、`BookContent`、`tocUrlOf` 行；`ADR-0047`、`ADR-0012`；`services/online-reading.ts`、`services/book-content.ts`、`services/cache-epoch.ts`；矩阵 `c-toc-*` / `f-toc-*` / `g-content-*` 行 |
| 后台任务 / 过程行 / 宿主观察 | 第 4 节的 `HostTie`、`JobTail`、`ChangeSignal` 行；`ADR-0018`、`ADR-0034` |
| 宿主接入 / 打包 / 插件页 | 第 1 节；`ADR-0020`、`ADR-0021`、`ADR-0035`；`docs/development.md` 的「宿主兼容与实测名单」 |
| legado 兼容判据 / 新写法 | 先查 `tests/legado-coverage/matrix.ts` 有没有那一行；`ADR-0003`、`ADR-0099`、`ADR-0025`；`docs/development.md` 的「兼容判据与桥面自证」 |
| 文档 / ADR / 发布流程 | `docs/AGENTS.md`；`docs/adr/README.md`、`docs/adr/ADR-FORMAT.md`、`ADR-0098`、`ADR-0049`；`CONTRIBUTING.md`、`CHANGELOG.md`；`docs/development.md` |
