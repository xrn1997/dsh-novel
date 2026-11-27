# dsh-novel

在 DeepSeek Harness（DSH）里读网络小说的插件：导入 legado 书源 → 聚合搜索 → 书架 → 连续滚动阅读。

本文件是**领域词汇表**：只回答「这个词指什么、它的唯一实现在哪个符号」。这里不装口径论证——「为什么、被否决的方案、读数」住实现它的代码注释、矩阵行 `note` 与 `README.md`；本表只留判据与锚点。

## Language

### 书源与规则

**书源（book source）**:
一个 legado 规则包：某站点的搜索 / 详情 / 目录 / 正文取值规则与其登录态的载体。
_唯一实现_: `services/types.ts` 的 `NovelSource`（规范化形状）+ `shared/wire.ts`（跨半投影）。 _Avoid_: 站点、书站（书源是规则，不是站点本身）。

**源入库（source intake）**:
「书源进入系统」的唯一语义：normalize → 批内去重 → 按址去重 → add/replace；调用方只做呈现映射。
_唯一实现_: `services/intake.ts` 的 `SourceIntake`。 _Avoid_: 导入逻辑（导入是调用方）。

**方言（dialect）**:
书源导出的三种形态：legado 平铺 / legado 对象（`ruleSearch`、`ruleBookInfo`…）/ Native（android-ebook 原生格式）。 _唯一实现_: `services/normalize.ts`。 _Avoid_: 格式、模板。

**规则字段表（rule-field table）**:
书源规则字段的登记处：一个模型键一行，写明两方言容器与子字段路径（发现面条目字段没有路径列）、Native 隐式终端、覆盖模式、落位方式与行级登记（`pairWith`、`wholeSetGate`）。导入循环、方言映射、展平前要解析的容器集合、配对索引、发现面字段与指纹、存量段序都从它派生；测试侧名单独立写死。发现面条目的整套落位仍是 `normalize` 的显式分支，条目装配侧整套切换归 `bridge.hitRuleOf`。
_唯一实现_: `services/rule-fields.ts` 的 `RULE_FIELD_SPECS`（裁决见 `ADR-0044`）。 _Avoid_: 字段清单、规则映射（都只是这张表的投影）。

**存量收敛（stored-source rehydration）**:
已落盘书源按 raw 收敛到当前模型形状（rules 重推、enabled/type/groups/name 归一）的唯一机械；触发点只有 `SourceRegistry.load`，逐字段次序跟 raw 解释同住，覆盖策略由规则字段表的模式列登记。 _唯一实现_: `services/normalize.ts` 的 `rehydrateStoredSource`。 _Avoid_: 迁移脚本、启动修复。

**取值链（rule chain）**:
书源规则的形态：`||` 分支、组合符与终端（`@text` / `@href` / `@html`…）构成的链。
_Avoid_: 选择器链（选择器只是链的一段）。

**净化尾（replacement tail）**:
取值链尾部的 `##pattern##replacement` 文本净化段。
_Avoid_: 替换规则。

**规则文法（rule grammar）**:
规则串的构词法——分支、终端、净化尾、占位符如何组合成一条规则；构词与解析同属一处，方言拼串走 round-trip 自校验，越界当场进 warning。
_唯一实现_: `engine/grammar.ts`（`appendTail`/`withImplicitText` + `parseTails` + `isJsForm`/`splitVarExpr`）。 _Avoid_: 规则格式。

**搜索面（search face）**:
「书源搜索规则 + 关键词」到「命中条目 + 首条书名」的完整请求语义，聚合搜索与探针共用；参与集是**启用 ∧ 文本源**。
_唯一实现_: `services/search-face.ts`；参与判据住 `services/participation.ts`（`participates` / `exploreParticipates` / `aiParticipates`，后者见 `ADR-0097`）。 _Avoid_: 搜索服务。

**发现面（explore face / 书城）**:
「一个源 + 这个源自己声明的一个分类名 + 第几页」到「该分类这一页书目」的请求语义与整轮编排；浏览轴就这三样，没有跨源那一维（`ADR-0028`），用户可见名字是「书城」tab。参与集四条：启用 ∧ 文本源 ∧ 声明了分类入口 ∧ 没把发现关掉。
_唯一实现_: 单源抓取 `services/explore-face.ts` 的 `fetchKindPage`；单源一页执行体 `services/explore.ts` 的 `fetchExploreGroup`（**从不抛错**）；谓词 `services/participation.ts` 的 `exploreParticipates`（开关 raw 读口 `services/normalize.ts` 的 `rawExploreEnabled`）。 _Avoid_: 书城列表页、分类搜索。

**分类入口（explore kinds）**:
一个源「有哪些分类」的逐源声明（也叫**发现入口**）。两方言地址语义不同：原生 `ruleFind.kinds` 的地址是填进源级模板 `{{kind}}` 的值，legado `exploreUrl` 的地址本身就是那一类的完整模板；落位后统一成 `ruleExploreKinds`。脚本形态（`@js:` / `<js>`）不执行，声明它的源在书城没有分类。 _唯一实现_: `services/explore-url.ts` 的 `parseExploreKinds` / `exploreKindsFormOf`；落位 `services/normalize.ts` 的 `flattenDialect` / `flattenNative`。 _Avoid_: 分类词表（主人是 `deriveExploreSources`）、发现列表。

**相关性（relevance）**:
本轮关键词与一条命中的关系档位：`exact`（书名或作者整串等于规范化关键词）／`contains`（书名、作者、分类任一含关键词，或复合关键词的任一 token 被书名含）／`suspect`（都不含，不删，只移出默认视野）。空关键词＝这一维不生效；裁决只住 `ADR-0032`。
_唯一实现_: `shared/relevance.ts` 的 `relevanceOf` / `partitionByRelevance`（序读数 `RELEVANCE_RANK`）；形状 `Relevance` 在 `shared/wire.ts`。 _Avoid_: 过滤、降噪、二次搜索、相关性分数（只有三档枚举）。

**作品视图（按书）**:
一轮聚合搜索里「同一本（规范化书名 + 规范化作者）在若干家源上」的呈现轴：一本一行、逐源在下面可展开、可一次把这一本的各家逐条加架。它是**派生投影**，不是存储身份——架位凭 `bookKey`，进度不跨源搬。单位律三条身份：**条**＝一本书在一个源的那一行；**本**＝归并后的那一本；**家**＝去重后的源。
_唯一实现_: `shared/merge-by-book.ts` 的 `mergePartitioned`（形状 `MergedBook` / `MergedSource` 与上限 `SEARCH_BOOKS_CAP` 在 `shared/wire.ts`）；`mergeBooks` 只是 convenience。 _Avoid_: 跨源合并器（书城没有跨源轴）、同书去重、作品（不用它指存储实体）。

**搜索结果页派生（search view-model）**:
「一轮命中现场 → 轮级计数（条／本／家）、两条呈现轴的行身份与逐源回读」的唯一住址：判据在此，视图只接线与渲染。 _唯一实现_: `shared/round-summary.ts` 的 `summarizeRound`；`client/search-view-model.ts` 的 `deriveRound`（返回 `parts` / `summary` / `merged` 与 `groupViews` / `bookViews`）。 _Avoid_: 搜索结果状态（住 `client/search-job.ts`）、加架账（落架账住 `client/panel-shelf.ts` 的 `panelShelf`）。

**搜索落架（search landing）**:
搜索结果页的落架现场与加架排队：哪些架位已落过、哪一本的「都加架」还在途，逐条与整本两条入口共用面板期书架投影里的同一份账。回执只给数（加成 / 仍缺 / 无地址），措辞与通道住视图。 _唯一实现_: `client/search-landing.ts` 的 `useSearchLanding`（写口 `client/shelf-action.ts` 的 `addShelfSeat`）。 _Avoid_: 搜索结果状态、批量写口 / 加架事务、落架回执文案。

**面板书架投影（panel shelf projection）**:
面板存活期的一份可丢弃书架投影：书架读取面、落架账、筛选与关键字同住；挂载重取、加架并入落架账并作废旧读、删除对账，面板卸载即丢。阅读器问当前书时，在途刷新先等落地，投影缺这本书或上次读失败会重取一次再答；搜索结果页挂载时向同一条路要整份基线。真相仍在服务端。
_唯一实现_: `client/panel-shelf.ts` 的 `panelShelf` / `loadPanelShelf` / `ensurePanelShelf` / `readPanelShelf` / `markPanelShelfLanded` / `removePanelShelfBooks` / `resetPanelShelf` / `setPanelShelfFilter` / `setPanelShelfKeyword`。 _Avoid_: 书架真相（`services/shelf.ts` 的 `Shelf`）、搜索轮次。

**工具面披露三件套（searched / answered / filtered）**:
`dshnovel_search` 对「这一轮为什么给出这些」自报的三条计数：跑了多少家、多少家干净答话（答了零条也算）、多少行因不相关移出默认返回。另有 `eligible`（本轮 AI 候选源数）回答「为什么只搜了这些家」；为 0 时 render 给出去书源管理标记的行动指引（`ADR-0097`）。
_唯一实现_: `tools/tools.ts` 的 `dshnovel_search` execute（算式在 `shared/round-summary.ts` 的 `summarizeRound`；`eligible` 来自 `services/reading.ts` 的 `searchForAi`；`failed` / `truncated` 在 `tools/search-value.ts`；0 候选指引 `tools/render.ts` 的 `renderSearch`）。 _Avoid_: 有命中的源数（answered 数的是答话）。

**书籍详情浮层（book sheet）**:
书城右区一本**已经点名的源上的书**的落点：整段简介 + 本源两个动作（读这本 / 加入书架）+「在其他源找这本」那一次**手动**聚合搜索。逐源行列出是这一层的轴，**刻意不吃**搜索面的按书归并。
_唯一实现_: `client/views/CityBookSheet.tsx`（跨源那次复用搜索面；关键词构造 `client/city-view-model.ts` 的 `sheetKeyword`）。 _Avoid_: 选源、详情面板、规则求值的**详情面**。

**模态契约（dialog）**:
带遮罩浮层的行为口径：Esc 退出、入场焦点落 `data-dialog-initial` 的元素（未标则第一颗未禁用钮）、Tab 圈认面板内全部可聚焦件、关闭后焦点还给触发件、`role=dialog` / `aria-modal` 与遮罩点空退出；无遮罩但吃键盘的卡只复用键盘与焦点那一半。被否做法见 `ADR-0037`。
_唯一实现_: `client/views/dialog.tsx` 的 `Dialog` / `useDialogContract`。 _Avoid_: 弹窗工具、焦点 hook；也别与**阅读浮层**混称——那是阅读器里不带遮罩的角落面板，只管「此刻哪一面在场」。

**读页（list page read）**:
「一份已解析的页模板 + 变量 + 列表规则」到「条目上下文 + 落地地址 + 源级求值器」的唯一语义：建求值器、组装请求、抓取解码、列表求值。搜索面与发现面共用，两面只交模板来源、首页裁页与列表规则。
_唯一实现_: `services/list-page.ts` 的 `readListPage`（逐条目装配归 `services/bridge.ts` 的 `hitsOfContexts`）。 _Avoid_: 抓取、搜索面。

**请求组装（request assembly）**:
「URL 模板 + 变量 + baseUrl」到「可执行请求计划」的唯一语义解释——method 判定、body 插值、POST 默认头、charset、init 姿态全在一处。
_唯一实现_: `services/request.ts` 的 `assembleRequest` / `fetchInitOf`。 _Avoid_: 请求工具、fetch 封装。

**源请求（source request）**:
一次出站抓取的完整执行语义：动态头求值 → 限速 → webview/HTTP →（仅 HTTP）loginCheck（4xx/5xx 错误页也先交给脚本看正文），外加 webview 与 HTTP cookie jar 的双向桥接。解码不归本缝：归 `services/fetcher.ts` 的 `decodeBody`。
_唯一实现_: `src/services/source-request.ts` 的 `createSourceRequest` / `SourceRequest`（`fetcherFor` 给脚本出站）。 _Avoid_: 抓取工具、fetcher 包装；模板解析仍归请求组装。

**HTTP cookie jar**:
请求层那张域/路径/过期/`Secure` 感知的 cookie 表：响应 `Set-Cookie` 自动落库，请求缺省回带；一张表**跨源共享**。与脚本侧按源隔离的 cookie 垫片是两张表。裁决与公共后缀残留见 `ADR-0039`。
_唯一实现_: `src/services/cookies.ts` 的 `CookieJar`；吸收/回带归 `services/fetcher.ts`，浏览器桥归 `services/source-request.ts`。 _Avoid_: cookie 垫片、CookieManager。

**源状态会话（source session）**:
脚本可见的按源状态四张表：cookie 垫片、键值变量、单串槽、cache 垫片。接口面同步；生产实现把写先标脏、在求值边界或卸载时成批落盘到数据根 `source-state.json`，删源时按 baseUrl 清掉该源四张表。
_唯一实现_: `src/engine/session.ts` 的 `SourceSession`；`src/services/source-session.ts` 的 `FileSourceSession`（`forget` 是删源清理口）。 _Avoid_: 缓存（页面缓存归 `services/cache.ts`）、登录态（`SourceAuth` 归 `services/sources.ts`）。

### 面与段

**面（facet）**:
规则求值的上下文之一：rule / search / detail / toc / content / explore。
_Avoid_: 场景、模式；也别与「影响面」（`EpochImpact`）混称。

**段（segment）**:
取值链的一段。失败定位以「面 + 段序 + 段原文」表达，即段级定位。 _唯一实现_: `engine/types.ts` 的 `Segment` 与 `SegmentLoc`。 _Avoid_: 步骤。

**取值规约（reduction）**:
链上空态的裁决口径（判据句只住根 `AGENTS.md` 的「硬约束」，此处不抄第二份）。
_唯一实现_: `engine/select.ts` 的 `reducePicked`（选择段与取值段共用）；JSONPath 侧 `engine/jsonpath.ts` 同口径。 _Avoid_: 空结果（太泛）。

**过线原值（wire value）**:
引导层 `JSON.parse` 出来的脚本实参、脚本返回值与宿主响应载荷：类型面声明的形状不可信，按运行时原值处理。
_唯一实现_: `engine/js-utils.ts` 的 `textOf`（`String(v)` 的兜底口径）。 _Avoid_: 空值（`null` / `undefined` 是过线后的真实取值）。

**死线（regex deadline）**:
一条用户正则最多被允许占着主线程多久；到点判「这条规则跑不动」，**不**判「结果为空」。预算随工作量放宽并封顶——写死一个数会把大而合法的整页扫描误判成病态。
_唯一实现_: `engine/regex-guard.ts` 的 `deadlineFor`（超时抛 `RegexDeadlineError`；why 见 `ADR-0050`）。 _Avoid_: 超时（`jsTimeoutMs` 是脚本预算）、正则黑名单。

**值投影（value projection）**:
服务层把链尾 `EngineValue` 收成业务串的三种口径：单值文本位、URL 位、多值位。条目装配面只经读口消费投影——探针的 `fieldOf`、搜索面与发现面的 `listContextsOf`——不跨缝拿 `EngineValue`。
_唯一实现_: `services/bridge.ts` 的 `firstValue` / `firstUrlValue` / `listValue`（字段侧同名分家：`fieldOf`/`urlFieldOf` 不吞错，`auxFieldOf`/`auxUrlFieldOf` 读不出留空）。 _Avoid_: 取值规约（那是引擎层的空态裁决）。

**条目装配（一条命中）**:
「一个源 + 一个规则来源档 + 一个条目上下文 + 落地地址」收成**一条书目**的唯一语义。聚合搜索与发现面共用，三档档位（书名非空才算书目 / 作者与书地址是裸奔项 / 其余五项坏规则只丢该字段）只在这里说一次。
_唯一实现_: `services/bridge.ts` 的 `hitFieldsOf`（来源档 `HitRuleSource` 与字段位由 `services/rule-fields.ts` 的表派生；面恒 `'search'`、用途恒 `'value'`）。 _Avoid_: 逐字段解析、搜索面装配、命中构造器。

**取值用途（rule usage）**:
同一条规则串在两种用途下链尾未知词的语义不同，调用方显式声明：`'value'` → 未知词按 HTML 属性名；`'list'` → 未知词按 CSS。递归求值口的用途同样由调用方交。 _唯一实现_: `engine/parse.ts` 的 `classifyDefault`；子规则判据 `engine/sub-rule.ts` 的 `subRuleOf`。 _Avoid_: 模式、场景（这是「链尾未知词」的裁决轴）。

**属性终端（attr terminal）**:
取值用途下链尾的未知提取指令按 HTML 属性名取值：自身为空向下兜底第一个含该属性的后代。 _唯一实现_: `engine/select.ts` 的 `getValue`（`mode === 'attr'` 分支）。 _Avoid_: 自定义属性。

**模板字面段（literal segment）**:
规则段含 `{{expr}}`、`{$.path}` 或 URL 模板时整段按字面模板插值求值，产出 Value 而不报「认不出」。 _唯一实现_: `engine/literal.ts` 的 `isLiteralForm`/`splitLiteral`；求值 `engine/evaluate.ts` 的 `branchGen` literal 分支；模板态兜底口 `engine/parse.ts` 的 `classifyDefault`。 _Avoid_: URL 规则（任何含插值的字面段都是）。

**受保护区（protected region）**:
规则串里三处「区内字符不属于本层文法」的区域：`<js>…</js>` 块、`{{…}}` 区、`@put:{…}` 值区。三处都不参与本层切分：本仓的做法是**就地跳过**——切 `##` 替换尾、切连接符、判 `$n` 行模板、判模板态，四处都只看区外字符。
_唯一实现_: 三区探测 `engine/grammar.ts`（`jsBlockEnd` / `putRegionEnd` / `braceRegion`；`jsRegionEnd` 另含 `@js:` 吃到串尾），消费点 `grammar.parseTails` 与 `parse.splitTop` / `splitElements` / `maskRegions`。 _Avoid_: 转义、豁免区；也别把它读成「先摘出去」——跳过与摘出对 `##` 之外那几轴等价，对「尾在前、js 块在后」的形状不等价（残留登记在矩阵 `a-js-block-after-tail`）。

**模板态（template mode）**:
支文本在受保护区**之外**含 `{{…}}` 或 `@get:{…}` 时的文法翻转：文本段按字面产出、`@` 不再是段界——插值先于切分。
_唯一实现_: `engine/parse.ts` 的 `ParseCtx.template`（`parseBranch` 设、`splitElements` 与 `classifyDefault` 消费）。 _Avoid_: 与「模板字面段」混称（本词是**整支的文法状态**，那个词是**一段的产物形态**）；也别叫「正则模式」——本形态不按正则求值，说的是插值先于切分。

**AllInOne 行模板（row template）**:
AllInOne 条目下字段规则的形态：支文本在受保护区**之外**出现 `$\d{1,2}` 时整支是行组引用模板，值 = 用当前行把 `$n` 绑好后的原文，不再按规则解析。
_唯一实现_: 判定 `engine/parse.ts`（`GROUP_TOKEN` 测 `maskRegions` 的结果），绑定 `engine/regex-row.ts` 的 `bindRegexRow`，求值 `engine/evaluate.ts` 的 regexRow 分支。 _Avoid_: 变量替换、`$n` 展开；与「模板字面段」按触发形态分家（矩阵 `a-allinone-group-zero`）。

**按文本选元素（text selection）**:
默认方言 `text.<串>`（带参数）是选择段：命中「直系文本包含该串」的元素；不带参数的 `text` 才是取值终端。 _唯一实现_: `engine/select.ts` 的 `evalDefault`（textContaining 分支）。 _Avoid_: 文本过滤。

**详情上下文初始化（ruleDetailInit）**:
legado `ruleBookInfo.init` 的内部名：详情面先求值，其产物**整体替换**后续详情规则与 tocUrl 模板的求值上下文与 html。init 非空但零命中 → 抛错点名，不拿整页冒充上下文。
_唯一实现_: `services/bridge.ts` 的 `detailContextOf`；七字段取值段 `detailFieldsFromContext`（`detailFieldsOf` 与 `detailReadOf` 共用回落链与档位）；tocUrl 静态短路与上下文求值分住 `staticTocUrl` / `tocUrlFromContext`。 _Avoid_: init 规则（与 fetch 的 init 姿态易混，交流用内部名）。

**纯 `@put` 的 init**:
整条规则只设变量时**不换根**——判据归引擎。
_唯一实现_: `engine/parse.ts` 的 `isPutOnlyRule`。

**规则变量表（`ctx.vars`）**:
`@put` / `@get` 与沙箱 `java.put`/`java.get` 共用的键值表；引擎零内部状态，表由调用方持有并跨规则共享。作用域主人是门面：一次详情调用一张表，跨面不传。
_读写实现_: `engine/variables.ts` 的 `evalPut`/`evalGetVar`。 _Avoid_: 变量池、缓存（`cache` 是另一套按源表）。

**源求值（source eval）**:
一条书源上的**一次**脚本 / 规则求值：能力位（fetch 族 / 浏览器 / cookie / device / 源实体字段）、动态头求值、非递归与回退、脚本可见的 `book` 镜像都从这一处装配；调用方只交规则与上下文（`chapter` 原样透传）。逐面 `book` 字段集由调用方给的 shelf 上下文塑形，不在这里统一成全集。 _唯一实现_: `services/source-eval.ts` 的 `createSourceEval` / `engineContextOf` / `resolveHeaders` / `bookMirrorOf`。 _Avoid_: 规则引擎、求值上下文。

**脚本可见面（script surface）**:
`EvalContext` 的每个字段在脚本里能看到什么、以什么 init 键与全局名出现，收在一张 `Record<keyof EvalContext, …>` 清单里；宿主能力与求值层内部字段显式标 `excluded`。BOOTSTRAP 的简单全局由清单生成，book/chapter/source 的自定义物化仍留在沙箱。 _唯一实现_: `engine/script-surface.ts` 的 `SCRIPT_FIELDS` / `scriptInitOf` / `scriptGlobals`（消费点 `engine/js-sandbox.ts`）。 _Avoid_: 能力清单、白名单。

**动态请求头（headerRule）**:
legado `header` 字段的 `@js:`/`<js>` 规则形态的内部名（与静态 JSON 形态互斥同源）。求值失败 → warn 后回退静态头，不吞请求也不炸整链。 _唯一实现_: `services/normalize.ts` 的 `jsHeaderCodeOf`；`services/source-eval.ts` 的 `resolveHeaders`。 _Avoid_: header 规则、动态 header。

**探针（probe）**:
对一个书源真发一次搜索请求，得出可用性实测结论。关键词序列第一位是源自带的校验词，其后才是通用词。 _唯一实现_: `services/probe.ts`（校验词来自 `rules.probeKeyword`）。 _Avoid_: 自测、健康检查。

### 身份与状态

**书源注册表（source registry）**:
书源清单的唯一载体（`sources.json`，含登录态，仅存本机）。 _唯一实现_: `services/sources.ts` 的 `SourceRegistry`。 _Avoid_: 源列表（UI 里的列表只是投影）。

**按址去重（dedup by address）**:
同一 baseUrl 已有**可用**源时保留已有（`skipped`）；已有**不可用**源时新条替换并清掉其余同键条目。以可用者为准，是新条目规则改进被丢弃的既定口径。 _唯一实现_: `services/intake.ts` 的 `SourceIntake`。 _Avoid_: URL 去重。

**启停（enable / disable）**:
停用的书源不参与聚合搜索；探针与试跑不受影响。停用 ≠ 删除，也 ≠ 免验。停用对界面搜索与 AI 工具搜索同时生效；「哪些源给 AI 用」是另一维标记。 _唯一实现_: `services/sources.ts` 的 `setEnabled`。 _Avoid_: 删除、隐藏。

**AI 搜索源（AI search source）**:
书源上的用户偏好标记，与启停正交：AI 工具面的聚合搜索只问「启用 + 文本 + 已标记」的源；界面搜索与发现面不吃这一位。导入缺省关闭、重导入保留、存量缺键收敛为关闭；显式 `sourceIds` 只能在已标记集合内收窄，空集合零请求并回报候选数。
_唯一实现_: `services/sources.ts` 的注册表（`setAiSearch`、`SourcePublic.aiSearch`）；参与集 `services/participation.ts` 的 `aiParticipates`；工具面 `services/reading.ts` 的 `searchForAi`（`ADR-0097`）。 _Avoid_: AI 启用、AI 开关。

**书源待办（source inbox）**:
书源管理 tab 的首屏任务面：全库源清单派生出「坏源 / 未验证」两集合，反常置顶成任务卡，任务收尾自动消解。只看状态、不看启停；加载失败不渲染待办。 _唯一实现_: `src/client/source-inbox.ts`（派生）+ `src/client/source-inbox-ui.ts`（忽略现场与失效判据）+ `src/client/views/SettingsSection.tsx`（渲染）。 _Avoid_: 舰队快照、状态总览 chips。

**换轮（round switch）**:
搜索观察者发现读面身份已变（快照 `job.id` ≠ 观察中的轮次 id）时的唯一裁决：旧累积整体丢弃、`since=0` 重读新轮基线、旧连接 abort、按新轮重建观察。 _唯一实现_: `src/client/search-job.ts` 的 `sameRound` + `rebaseline`；编排 `src/client/job-channel.ts` 的 `regain`。 _Avoid_: 重连（同一轮的通道恢复）、重置。

**整帧替换（full-frame replace）**:
发现面观察者的换轮裁决：读面是全量快照且**不设累积器**，故不比轮次身份——轮到谁就以谁的整帧为准，即「跟随最近一轮」。恒真身份判据在调用点显式声明，不是通道缺省。 _唯一实现_: `src/client/explore-job.ts` 的 `apply`。 _Avoid_: 换轮（搜索面的说法）。

**任务观察通道（job channel）**:
浏览器半盯住一条服务端后台任务的通道仪式：timer 所有权、SSE 优先 + 快照轮询兜底、任一时刻只一条通道、撤通道连 timer 一起、代际作废在途帧。它**不**统一快照形状、累积器、整帧替换、身份与恢复策略、节拍与文案——那些是调用方交的回调（与 Node 半 `services/job-holder.ts` 同一条分界）。
_唯一实现_: `src/client/job-channel.ts` 的 `createJobChannel`（消费点 `client/search-job.ts` / `client/explore-job.ts` / `client/jobs.ts`）。 _Avoid_: 任务运行器、轮询器。

**bookKey**:
书籍身份：详情页 URL，**可带 `,{option}` 请求选项后缀**（URL 即请求规格）；本地书为 `local:<uuid>`。
_相关实现_: `services/url.ts` 的 `splitUrlOption` / `stripUrlOption` / `absUrlKeepOption`、`services/request.ts` 的 `assembleRequest`。 _Avoid_: id、url。

**架位（shelf seat）**:
书架上的一条记录（一个 `ShelfBook`，界面上一张卡），凭 `bookKey` 认：**同一地址不管从哪家源加进来只落一个架位**，`sourceId` 与 `title` 是元数据、不参与查找；一本被两家源各给一个地址就是两个架位、两份进度。「都加架」的三态与回执数的是架位，不数 PUT、也不数行。
_唯一实现_: `services/shelf.ts` 的 `Shelf`；客户端算式 `client/search-view-model.ts` 的 `shelfSeats` / `isSeatLanded` / `newlyLandedSeats` / `addAllReceipt`。 _Avoid_: 书架身份、座位、光杆「条目」。

**加架动作（shelf action）**:
「把一条命中落进书架」的唯一动作语义：架位路径 + body 形状 + 成功/失败两种结局（不抛）。回执位置与措辞不在这里。 _唯一实现_: `src/client/shelf-action.ts` 的 `addShelfSeat`（输入 `ShelfSeatInput`、结局 `ShelfAddOutcome`）。 _Avoid_: 入架按钮、书城加架；架位真相与字段集仍归 `Shelf` / `SHELF_META`。

**本地书（local book）**:
从本地文件导入的书，**TXT 与 EPUB 2/3 两支**：入口先认具名容器头（PDF / MOBI / UMD）与「名字声明 `.epub` 而内容不是 ZIP」的字节并拒收，之后按**内容**分流（ZIP 魔数走 EPUB，其余走 TXT 解码链），两条互不兜底；源身份固定 `__local__`。
_唯一实现_: `src/services/localbooks.ts`（身份、分流、发布、副本读写与删除）+ `src/services/local-meta.ts`（元数据存储形状与版本化读 codec）+ `src/services/local-lifecycle.ts`（副本 ⇄ 架位生命周期）+ `src/services/epub/`（解析与规范化）。 _Avoid_: 本地 TXT、上传文件。

**本地书生命周期（local book lifecycle）**:
一本本地书 = **磁盘副本 + 一个架位**，两者之间没有跨文件事务（`ADR-0014`）：导入即落架、入架失败回收本次副本；三条删入口共用「先删副本、失败则架位保留可重试」；启动补章数只补缺字段的旧条目、读不到副本就跳过（`ADR-0058`）。副本发布归 `LocalBooks`、架位归 `Shelf`，合起来的次序与补偿只在这里。
_唯一实现_: `src/services/local-lifecycle.ts` 的 `LocalLifecycle`。 _Avoid_: 本地书（格式与身份口径）、本地书缓存。

**文档级锚点（document-level anchor）**:
声明在 `<body>` 上的 `id`——源里确实存在这个锚点，而图文树没有 body 节点，所以它在树上的落点就是**该页开头**，与「无片段」等价：既不降级、也不告警、更不是坏书。 _唯一实现_: `services/epub/documents.ts` 的 `scanXhtml` / `XhtmlScan.documentAnchor`（绑定在 `services/epub/import.ts` 的 `lookupAnchor`）。 _Avoid_: 失效锚点、根锚点、页面锚点。

**阅读单元（reading unit）**:
留在阅读序列里的那一份主序列文档的书内位置——章号是「第几个留下的单元」，不是 `itemref` 在原文件里的序号：一条声明被剪，后面各条往前挪，不留洞；读不出正文的页照旧占号。 _唯一实现_: `services/epub/import.ts` 的 `EpubChapterRef`；剪哪一条由 `services/epub/package.ts` 的 `parseSpine` 决定。 _Avoid_: spine 项、章节序号。

**留空页（blank document）**:
一份主序列文档读不出任何正文时的落法：**照旧进阅读序列、照旧占章号、目录照旧有名，读出来是空白页**，另留一条点名的痕。**空白是可见性判据，不是空树**：转换出的结构照旧留在正文里，扫描期铸出的锚点因此仍有落点。它与「被剪条目」是两种事实，不折叠。
_唯一实现_: 半径 `services/epub/findings.ts` 的 `FINDING_RADII.blankDocument`；事实由 `services/epub/xml.ts` 的 `fail` 与 `services/epub/documents.ts` 的 `convertXhtml` 交回，落盘在 `services/epub/import.ts` 的主序列循环。 _Avoid_: 空章节冒充成功、跳过。

**被剪条目（pruned entry）**:
一条声明读不出它指的东西——spine 条目指不到文档、目录条目指向读不出的文档、正文链接指向不存在的文件——只丢**那一条**并留痕：阅读序列往前挪、目录的子条目上提、正文链接取消可点击性但文字一个字不丢。 _唯一实现_: 共享码 `services/epub/findings.ts` 的 `WARN_ITEM_PRUNED` 与半径 `FINDING_RADII.itemPruned`；三处后果分别在 `services/epub/package.ts` 的 `parseSpine` / `pruneDeadTargets` 与 `services/epub/import.ts` 的 `bindNav` / `bindLink`。 _Avoid_: 降级、失效链接。

**半径表（failure-radius table）**:
「这条事实有多大、坏到什么程度、编排层因此落哪一格后果」的唯一主人：发出方只交**名字**，半径与后果由表决定——所以「整本书读不出」这一格在表里**不存在**，那条路只能走书级出口。落盘的是拆开的事实清单，合并与句式在读面现算；动作句仍是导入时的原文。
_唯一实现_: `services/epub/findings.ts` 的 `FINDING_RADII` / `FindingLog` / `warningListOf`；书级出口同住 `services/epub/errors.ts` 的 `rejectBook` / `bookError`。 _Avoid_: 告警表、warn 名单；把 `scope`/`severity` 当调用点自填参数。

**后台任务（background job）**:
跑在服务端的耗时任务，四种 kind：`novel-import` / `novel-probe`（写，共用一槽）、`novel-search`（搜索一槽）与 `novel-explore`（分类轮次一槽，后提交即替换上一轮）。身份与生命周期登记给宿主 `ctx.jobs`；业务计数与明细归本仓持有者。**停止（cancel）不是失败也不是放弃**。
_唯一实现_: `services/import-job.ts` / `services/probe.ts` / `services/search-job.ts` / `services/explore-job.ts`；宿主登记机械 `services/job-holder.ts` 的 `HostTie` / `ChangeSignal`。 _Avoid_: 队列、前端任务、任务运行器。

**分类轮次（explore round）**:
一轮分类浏览的持有物：**一轮 = 一个源 + 一个类**，各页结果**跨页累积**住在 Node 半，读面给**全量快照**（整帧替换）；一次只留最近一轮，过了保留期读作「无任务」。**续页是这一轮里的事**（同 id 再打一页，不换轮）；快照上的 `page` / `hasMore` 是**动作契约**——`hasMore` 只说「此刻能不能点」。
_唯一实现_: `services/explore-job.ts` 的 `ExploreJobs`（`advance` / `absorb` / `snapshot` 的 `hasMore`）；门面入口 `services/reading.ts` 的 `loadMoreExploreJob`；跨半形状 `shared/wire.ts` 的 `ExploreSnapshot`。 _Avoid_: 分类任务队列、新一轮。

**书城进入判据（city entry）**:
书城自动那条路「该不该提交一轮分类浏览」的唯一判据：源与分类的回落、挂载恢复读是否已定、自动那条路是否已走过、服务端此刻那一轮的身份，一起算出一个动作（等待 / 不动 / 落选中并提交或跟随已有轮次）。「进入即加载」只在该源+该分类没有轮次时提交——重提会杀掉服务端那一轮；手点路径不进判据（切源/切类必须马上有反应，恒提交）。 _唯一实现_: `client/city-entry.ts` 的 `decideCityEntry` / `resolveCitySelection`。 _Avoid_: 进入逻辑（太泛）、自动加载开关（判据产出的是动作，不是可配开关）；也别与「分类轮次」混称——那个词指 Node 半的持有物，这里只是客户端的一次决策。

**书城选中态（city selection）**:
书城左栏当前源+分类的跨卸载现场与它的本挂载投影：唯一写口 `select` 只写 `cityStore`，hook 给出的 `selection` 就是 store 的投影；`isAsked` 是本挂载的 one-shot（自动那条路最多动作一次，卸载即重置），与分类轮次的提交闸不是同一条语义。 _唯一实现_: `client/city-selection.ts` 的 `useCitySelection` / `rememberedCitySelection`。 _Avoid_: 选中状态（太泛）；也别与「书城进入判据」混称——判据产出动作，这里只持有选中态。

**阅读会话（reader session）**:
「目录 → 存档恢复 → 逐章懒加载 → 预取 → 进度落盘」的时序持有者；DOM 测量经 `ReaderPort` 注入，视图只渲染与接线。同一时刻只允许一章在途（`inflight`），滚动风暴与目录直达只记意图（`pendingJump`），刚失败过的同一章不自动重试。重测触发看 `state.domRevision`，滚动 / resize 事件拨给 `feedViewport`。
_唯一实现_: `client/reader-session.ts`。 _Avoid_: 阅读器状态管理（视图里的 state 只是它的投影）；也别与**阅读场景**混称——那个词指浮层、注释载荷、Esc 归属与入架一问的交互现场。

**已载窗口（mounted window）**:
阅读器里真正在 DOM 里的那几章 = 视口章所属的**连续区间** ∩ 视口之前 `KEEP_BEHIND` 章的深度。裁它是防连续前读时 DOM 只增不减；窗口顶之外由 `checkBackfill` 按真实视口补回。 _唯一实现_: `client/reader-session.ts` 的 `pruneToViewport` / `checkBackfill`。 _Avoid_: 缓存、预取。

**滚动补偿（scroll fix）**:
裁掉视口上方的章、往窗口顶前插一章之后，让读者眼前正文**原地不动**的那笔账：DOM 提交前量不到新布局，所以只记账、在 `afterRender` 按实测高度结算。浏览器的自动锚定在阅读器子树整棵关掉。 _唯一实现_: `client/reader-session.ts` 的 `pendingScrollFixes` / `applyScrollFixes`（关锚定住 `client/styles/reader.ts`）。 _Avoid_: 锚点、进度恢复；也别叫「滚动锚定」。

**阅读浮层（reader surface）**:
阅读器右上角那一层的在场判据：Aa／目录／导出／注释／导入说明**至多一角在场**；换角时注释面板只收不消费，Esc 走「关闭」那条语义（`ADR-0037`）。
_唯一实现_: `client/reader-surfaces.ts`（`openSurface` / `closeAll` / `dismissSurface` / `maskFor` / `escOwner`）。 _Avoid_: 浮层状态管理、模态契约。

**键盘层序（key layer）**:
同场两层都要吃 Esc 时谁先吃：认领顺序 = 打开顺序，只有最上层执行 Esc 与 Tab 圈；底下那层被顺手关掉等于替用户丢现场。带遮罩的模态、无遮罩浮层卡片与阅读浮层的 surface 监听都到这一处认领。 _唯一实现_: `client/views/dialog.tsx` 的 `claimKeyLayer`（`useDialogContract` 内部认领，`ReaderView` 的 surface 监听同源认领）。 _Avoid_: 焦点归属、模态契约。

**阅读场景（reader scene）**:
阅读器里互相咬合的交互现场：当场面、注释面板的目标与**返回项句柄**、Esc 归属、离开时那一句入架询问与它的写入回执。视图只渲染它的投影并接线，阅读时序不在这里。
_唯一实现_: `client/reader-scene.ts` 的 `ReaderScene`（`toggle` / `openNote` / `close` / `handleEsc` / `dismissAsk` / `openTarget` / `bodyLink` / `panelLink` / `exitToShelf` / `joinAndBack`）。 _Avoid_: 阅读器状态、阅读浮层纯判据；DOM 测量与导出编排也不归它。

**判到底（翻页闸）**:
「下一页 / 下一目录页」何时停的唯一语义：next 规则按取值用途求值、结果按列表形状处理。停止判据次序与代码同序——防环 → 上限 → 零新增 → 回环；正文面另串章闸。 _唯一实现_: `services/pagination.ts` 的 `followPages`（`stoppedBy` 五态）；串章启发式 `services/chapter-page.ts` 的 `isSameChapterPage`。 _Avoid_: 翻页循环、重复过滤。

**消费位置（consumption position）**:
「这本书的消费位置」= 落盘的共用游标：章 + 章内比例（`{chapterIndex, offsetRatio}`），即书架记录里的 `ShelfProgress`。阅读与听书共写它，但同一时刻只有一个自动所有者：**本书阅读器子树在场时归阅读会话**（按真实视口 / 精确段写），播放层只写 `listen`；阅读器不在场时播放层才把段号换成比例补写 `progress`。工具面的 `save_progress` 与 HTTP 写口是显式写入口，不走自动节拍。书架卡片、最近阅读排序与开书恢复都读它。
_唯一实现_: `shared/wire.ts` 的 `ShelfProgress`；`client/reader-session.ts` 的 `commit`；`client/tts/listen-session.ts` 的 `writePosition`；`client/tts/reader-presence.ts` 的 `readerPresence`；`client/progress.ts` 的位置 codec；`shared/reading-position.ts` 的 `hasProgress`。 _Avoid_: 听书进度、进度（要区分元数据与消费位置）、scrollTop。

**阅读位置（reading position）**:
阅读器此刻看得见的位置：会话内存里的章 + 章内比例，以及从 DOM 几何量出的探针读数（章 + 段号）。它是**实时读数，不是落盘游标**：滚动 / 导航 / 存档恢复只修正它，提交时按 cause 决定写不写消费位置；听书起播从它换算起播段，换算不写盘。精确段落落位也读它，但走 `ReaderSession.reveal` 的段号 target，落点统一对齐到顶条下方的带顶（`ADR-0096`）。
_唯一实现_: `client/reader-session.ts` 的 `position` / `commit` / `reveal` / `settleReveal`；`client/tts/reading-position.ts` 的 `ReadingProbe` / `readingPositionAt` / `setReadingProbe`；`client/progress.ts` 的 `estimateParagraphIndex`；`client/reader-paragraph.ts` 的 `paragraphSlotOf` / `listenParagraphElement`。 _Avoid_: 消费位置、视口位置、听书段号。

**翻页阅读（paged reading）**:
阅读器的整章多栏切页模式：窄屏单页、宽屏双页，点击 / 键盘 / 滚轮 / 触摸翻页，跨章落位与按页位写进度（`ADR-0101`）。正文一次进多栏轨道、不复制 DOM；章内锚点不精确落位。 _唯一实现_: `client/reader-pagination.ts` 的 `computeSpreadLayout` / `computePageCount` / `spreadForRatio` / `ratioForSpread` / `classifyClickZone` / `firstParagraphInSpread`；舞台 `client/views/BookStage.tsx`；会话 `client/reader-session.ts` 的 `setPaged` / `reportPosition` / `prefetchChapter` / `scrollToSavedPosition`；视图 `client/views/ReaderView.tsx` 的 `isPaged` / `takeOverReading`。 _Avoid_: 分页器、PDF / 固定版式阅读（不接）。

**页位比例（page-position ratio）**:
翻页模式写进 `progress.offsetRatio` 的章内进度：当前屏在整章多栏轨道中的位置比例；与滚动模式共用同一个字段，但口径是页位而非文本比例，切模式时只做近似换算。 _唯一实现_: `client/reader-pagination.ts` 的 `ratioForSpread` / `spreadForRatio`；`client/views/ReaderView.tsx` 的 `onPagedReportRatio`。 _Avoid_: 阅读位置、文本进度；共用 `offsetRatio` 时要先说清是哪一种口径。

**阅读器几何（reader geometry）**:
`ReaderPort` 的纯几何实现：从滚动容器、章块与哨兵读出锚点、视口偏移、目标偏移与当前节点；两套坐标系（内容原点 / 视口顶）只在这里换算。视图只交 ref 读数，会话只读 port。
_唯一实现_: `client/reader-geometry.ts` 的 `createReaderGeometry` / `currentNodeOf` / `isFlowNovelNode`（底层坐标换算 `client/scrollport.ts`）。 _Avoid_: 阅读时序、滚动容器探测。

**独立块带（flow band）**:
正文节点是否占一条独立纵向块带：段落内的短语级子元素（成员集住 `PHRASING_TAGS`）与 `br`、并排表格单元格不算独立块带——它们滚出视口后不得让父段被空档判据误翻；插图、链接内降级的块片段与块级链接仍占带（判据见 `isFlowNovelNode`）。短语词表与渲染降级共用同一份，几何采点与浏览器门同吃。 _唯一实现_: `client/reader-geometry.ts` 的 `isFlowNovelNode`（短语标签词表 `shared/content-tags.ts` 的 `PHRASING_TAGS`）。 _Avoid_: 行内元素过滤、可见节点、空档判据。

**视口顶判据（viewport-top）**:
给定一组按文档序排列的项区间（起点 / 块尾）与「视口顶」读数，判当前项：取**最后一条起点已越过判据线**的项（边界 `<=`；输入允许非单调，判据仍按文档序）；已越过项里只要还有块尾仍压线或跨线的（`>= 0`），线就被内容占着，不算空档——最后一条已越过项离线而更早的覆盖项还在时，完整落在覆盖项跨度内的子块缝归下一子项，覆盖项自己的尾巴归覆盖项；只有所有已越过项都整条离线（`< 0`）且其后又有未越过的项时，线才落在块间**空档**（无内容带：章间 / 段间 margin），归下一项。一条都没越过 → 文档序第一个非空项；没有可判项 → `-1`；空洞跳过。阅读侧三条数据路各自采集读数，判据只有这一份（`ADR-0106`）。 _唯一实现_: `client/viewport-top.ts` 的 `crossedIndex`。 _Avoid_: 当前节点 / 当前章、落项规则、缝归例外。

**顶条遮挡（top inset）**:
sticky 顶条盖住视口最上那一条的实测高；「看得见的顶」= 端口顶（或滚动位）加这份夹成非负的遮挡。存、取、落位、导航高亮与「从阅读位置起播」探针共吃同一个口径。 _唯一实现_: `client/viewport-top.ts` 的 `clampTopInset`（这把尺的两个进料口：阅读器顶条 = `client/views/ReaderView.tsx` 的 `topInset`，每次现量；宿主窗控带 = 见「窗控带与安全顶」，随窗口读数取）。 _Avoid_: 视口顶判据、顶条样式与高度常量。

**窗控带与安全顶（window chrome / safe top）**:
桌面壳画在 `shell.overlay` 之上的窗口控制栏（缩小 / 最大化 / 关闭，整条是窗口拖拽区）对视口顶的固定遮挡；带的下沿就是浮窗可达区的顶界「安全顶」（安全顶就是带的下沿、不带视觉余量；全屏与没有这条栏时为 0）。遮挡读数随窗口读数一起取，进判据线前过 `clampTopInset`。 _唯一实现_: `client/tts/mini-bar-state.ts` 的 `frameTopInsetOf`。 _Avoid_: 顶条遮挡（阅读器自己的 sticky 顶条）、视口边距、宿主 z 序。

**在线阅读（online reading）**:
一条在线书的目录与正文取值管线：目录读数先走一层进程内缓存（键含代际，refresh 绕过读；晚到的旧目录不许盖掉刚刷新的那份），其后是磁盘缓存优先、目录在途去重（身份含代际与 refresh）、翻页跟进、缓存写回，连同 tocUrl 解析、subContent 追加与空正文异常。**在途去重与进程内缓存都只服务目录**。**本地书不走这条线**（`ADR-0047`）。
_唯一实现_: `services/online-reading.ts` 的 `OnlineReading`（`toc` / `chapterText`；`tocUrlOf` 同住）。 _Avoid_: 阅读服务（门面）、抓取。

**书内容读面（book content read surface）**:
目录、导航与正文的本地/在线分流与文字规约：本地书与在线书是两个适配器，读动词（`toc` / `navigation` / `chapterContent` / `readChapter`）不再各自判 `__local__`，正文 text 出口统一过行规约；来源展示判据仍按本地源常量判来源身份。
_唯一实现_: `services/book-content.ts` 的 `BookContent`（适配器 `LocalBooks` / `OnlineReading`）；正文规约 `shared/chapter-text.ts` 的 `normalizeChapterText`。 _Avoid_: 阅读服务、在线阅读。

**正文文字规约（chapter text normalization）**:
纯文本正文的行规约：逐行 trim、去首尾空行、相邻空行折叠一个；只动空白与换行，不解释尖括号与实体。在线正文与本地 TXT 共用，幂等。
_唯一实现_: `shared/chapter-text.ts` 的 `normalizeChapterText`（`chapterContentToText` 的 text 分支过它）。 _Avoid_: 正文清理、HTML 转文本。

**缓存代际（epoch）**:
「这份目录 / 正文缓存还有效吗」的唯一算式：按面细分的规则指纹 + baseUrl，**入缓存文件名**而不是删除式失效。刻意不含 `auth`（登录态刷新会整源缓存全灭）。 _唯一实现_: `services/cache-epoch.ts` 的 `rulesEpoch`；消费点 `services/online-reading.ts` 的 `OnlineReading`。 _Avoid_: 版本号、缓存键。

**正文槽位（slot）**:
正文缓存文件名的有效性段 = 代际 + 章名：代际管「规则变了」，章名管「站点侧目录变了」。刻意**不含章节 url**（带时效 token 的站点每次刷目录都换 url）。 _唯一实现_: `services/cache-epoch.ts` 的 `contentSlot`（消费点 `services/online-reading.ts` 的 `chapterText`）。 _Avoid_: 正文键、章节 id。

### 听书

**播放单元（play unit）**:
听书一次交给合成服务（或一次交给平台开口）的最小正文单位：由正文投影按 `\n` 切段、逐段 trim，滤掉空段与纯空白 / 标点 / 符号段；超过上限（`PLAY_UNIT_MAX`，按 code point 计）的段再按全角句读二次切开，分隔符留在前一片末尾。切分只动边界不动字，`join` 回来等于原段。屏上「第 N 段」与这批单元的对位由同住一处的投影给出。
_唯一实现_: `shared/chapter-text.ts` 的 `splitParagraphs` / `PLAY_UNIT_MAX`；起段号 `playUnitStarts` / `playUnitStartsByNode`。 _Avoid_: 段落、句子、在视图里逐行数单元。

**听书位置（listening position）**:
按书记住的听书细节：段号、引擎标识、音色、语速、音量。它服务精确续听与播放参数记忆；**章 + 章内比例**的共用消费位置住 `progress`：阅读器在场时归阅读会话，播放层只写听书细节；不在场时两笔都写（`ADR-0093`）。
_唯一实现_: `shared/wire.ts` 的 `ListenState`；写路径 `services/reading.ts` 的 `shelfSaveListen` → `services/shelf.ts` 的 `Shelf.updateListen`。 _Avoid_: 阅读进度、播放队列。

**听书缺省（TTS defaults）**:
回退链第三环的四格活动缺省（引擎标识 / 语速 / 音量 / 预取段数）的生效值。来源链一条、链序即优先级：宿主同步配置的 live ref > 设置面快照 > `shared/wire.ts` 的 `TTS_DEFAULTS`（终端地板、不是来源）；每格独立取链上第一个读得出的，读时求值——谁赢由链序声明，与到达 / 刷新顺序无关。判读（空白引擎 id、非有限数、非整数或负数预取 = 读不出）全仓一份；一格读不出只落那一格。live ref 逐格接管：某格不是合法 ref 就那一格缺席，出现型晚到下一读即见。
_唯一实现_: `client/tts/tts-defaults.ts` 的 `createTtsDefaults`（判读 `READABLE` 同住）；宿主名字表与两个 adapter `client/tts/tts-defaults-host.ts`。 _Avoid_: 取值链（那是规则链）、缺省 merge、活动缺省袋、默认值。

**起播位置（start position）**:
「从阅读位置起播」解析出的章 + 段号。来源链只有一条：显式 target（选区）→ 实时阅读探针 → 当前章（活动会话的章或阅读器给的兜底章）→ 书架 `progress`；书架比例只在同章时用于段号估算。解析结果交给同一条取数与起播管线。
_唯一实现_: `client/tts/listen-session.ts` 的 `startFromReadingPosition` 与 `startSession`。 _Avoid_: 续听位置、起播点、从存档续听。

**引擎源（engine source）**:
听书可选的出声来源：内置（恰一条、开箱即用，没有音色表）、浏览器直出兜底、注册表里的每条订阅、宿主语音服务（服务在场**且自报就绪**才列出）。顺序即展示顺序；插件自有源不带展示名，订阅源的名字是订阅数据本身。清单只列此刻可用的源。
_唯一实现_: `services/tts-engines.ts` 的 `TtsEngineRegistry`；源清单归一与次序 `services/tts.ts` 的 `TtsService.sourcesView`。 _Avoid_: 书源、模型、把健康读数塞进源清单行。

**宿主服务健康（host speech health）**:
宿主朗读服务此刻的三态读数：`absent` / `not-ready`（在场但不可用，带服务方的稳定原因码；读数本身抛错时按未就绪报、不带原因码）/ `ready`。它与源清单同出一次能力读数。管理面据此把「没装」与「装了没配」摆成两句不同的话；选择面不读它。
_唯一实现_: 形状 `shared/wire.ts` 的 `HostSpeechHealth` / `TtsSourcesView`；读数 `services/tts-cordis.ts` 的 `readinessOf` 与 `services/tts.ts` 的 `TtsService.sourcesView` / `speechReadout`。 _Avoid_: 源清单、失败、客户端自己编原因码字典。

**播放补速（playback rate）**:
拿到一段字节后播放端还要乘的语速倍率（1 = 引擎已按用户要的语速念过）。用户滑杆上的倍率是**请求**，字节里掺了多少由引擎能力决定：规则写了 `speakSpeed` 的 HTTP 源与发了 `voiceRate` 的服务源算「已应用」，差额归播放端；不认语速参数的源一概补全额。侧车随字节定版的是**引擎应用的那一档**（`appliedRate`），补速按这次请求现算。
_唯一实现_: 回执 `shared/wire.ts` 的 `SynthesisReceipt.playbackRate`；补速算式 `services/tts.ts` 的 `residualOf`；应用量由 `services/tts-request.ts` 的 `ruleCarriesSpeechRate` 与 `services/tts-cordis.ts` 的 `voiceRateOf` 各自产出；落地 `client/tts/output-contract.ts` 的 `BytesSegment.playbackRate` → `client/tts/bytes-output.ts` 的 `AudioSlot.playbackRate`；随字节定版 `services/tts-cache.ts` 的 `AudioMeta.appliedRate`。 _Avoid_: 语速读数、段进度、把倍率塞进缓存键。

**音色绑定（speakVoice）**:
HttpTTS 模板求值的第三个绑定（前两个是 `speakText` / `speakSpeed`）：本段音色 id，缺省空串；`{{speakVoice}}` 可作纯占位，也可在 JS 表达式里读。内置引擎不消费它；订阅模板写了它才生效。音色 id 不跨引擎互通：换引擎时播放层清空本书记住的旧 id。音色表来自订阅数据或源能力。 _唯一实现_: `services/tts-request.ts` 的 `planTtsRequest`。 _Avoid_: 音色表。

**段音频缓存键（audio cache key）**:
按「引擎标识 + **实际请求** + 文本」算出的 md5。HTTP 源的实际请求是求值后的 `method` / `url` / `body`；宿主语音服务是服务身份 + 音色 + 语速。请求没变就复用；实际请求由各支合成计划在知道请求内容的地方产出，headers 不入键。
_唯一实现_: `services/tts-cache.ts` 的 `ttsCacheKey`；identity 由 `services/tts.ts` 的 `planHttp` 与 `services/tts-cordis.ts` 的 `cordisCacheIdentity` 产出。 _Avoid_: 原始参数键。

**直出型 / 字节型（direct-output / byte playback）**:
播放层的两条出声分支。直出型 = 浏览器本地语音（`BROWSER_TTS_ENGINE_ID`）：逐段交给平台开口，无合成请求、无预取、无缓存；字节型 = 其余引擎：先 POST 合成拿缓存键，再按音频读口出声，带同章预取与磁盘缓存。两种共用同一个状态机、同一份听书位置与同一条失败径；**每条分支自己的策略**、生命周期与起播资格住分支实现。静音另一条的时序 = 新分支**出声那一刻**（字节型等合成回执落地）：换槽接替、绝不叠音，合成等待里旧声音继续、不给死腔；起播失败由失败径当场收口——读数写「不在放」就不许还有声音。
_唯一实现_: 分流 `client/tts/listen-session.ts` 的 `modeOf` 与 `ListenOutput`；分支契约 `client/tts/output-contract.ts` 的 `PlaybackBranch` / `ListenBranches` 与两条实现 `client/tts/playback-branches.ts` 的 `BytesBranch` / `DirectBranch`；介质适配器 `client/tts/bytes-output.ts` / `client/tts/direct-output.ts`（`BROWSER_TTS_ENGINE_ID` 字面量主人在 `shared/wire.ts`）。 _Avoid_: 在线 / 离线、流式 / 非流式、把分支判据散回状态机。

**段进度（segment progress）**:
当前播放单元已出声的秒数与总秒数：字节型由活 Audio 槽的计时推进（预载槽的读数不投），直出型没有计时介质、恒为零。它是瞬时现场——暂停续播原地接上、换段归零、不落盘；落盘的听书位置仍是段粒度。独立一只 store，高频读数不进主 store。
_唯一实现_: `client/tts/listen-session.ts` 的段进度 store（视图经 `client/tts/player.ts` 的 `ttsProgress` 再导出）。 _Avoid_: 听书位置、章进度。

**听书读数（listen readout）**:
上屏读数的唯一换算处：段读数、定时读数、章内进度算式、语速读数与当前句取值，以及**整块上屏投影**（可否暂停 / 连败停因 / 有没有段读数 / 段内进度是否真读数 / 当前引擎露哪张音色表）——听书条、迷你条胶囊、展开边栏、设置面与阅读器只取成品，不各自比较计数与阈值。
_唯一实现_: `client/tts/listen-readout.ts` 的 `listenFaceOf` / `isPlayBusy` / 各读数函数；停因由 `client/tts/listen-session.ts` 的 `halt` 发布。 _Avoid_: 段进度、听书位置、在各表面手写换算。

**跟读高亮（listen-along highlight）**:
听书时正文里正在被念的那一段的就地标记：命中块换文字色，并在段首框外画一枚 currentColor 小三角——纯换色在部分纸色下认不出；不铺底色、不加竖条、不画段内进度线（`ADR-0076`）。命中判据 = 最后一个 ≤ 段号的起段号，与「从本段听」同口径。只标记、不写位置。
_唯一实现_: `client/views/ChapterBody.tsx` 的 `listenParagraph`（命中判据 `client/reader-paragraph.ts` 的 `paragraphSlotOf` / `listenParagraphElement`）。 _Avoid_: 把高亮当位置写入口、让高亮负责滚动。

**跟读跟随（listen-along follow）**:
阅读器里听本书时，播放推进到新段 / 新章会把视口带到当前段：起播首拍、跨章、回退、拖动滑杆这类显式跳转一律把目标顶对齐到带顶；同一章的自然推进只在目标成为当前可见的最后一段、且落在带的下半部时翻页。读者手动滚动或点目录 / 内链 / 返回原处后让位，按听书条的「定位到正在念的段」重新接上并顶对齐（`ADR-0096`）。
_唯一实现_: `client/tts/follow-controller.ts` 的 `createFollowController` / `onPlayback` / `onLocate` / `onUserIntent` / `onRelocation`；视图接线 `client/views/ReaderView.tsx` 的 `takeOverReading` / `locateListen` / `followBottomInset`；落位 `client/reader-session.ts` 的 `reveal` / `settleReveal`；用户意图装线 `client/reader-binding.ts`；接管时撤销在途落位 `client/reader-session.ts` 的 `cancelJump`。 _Avoid_: 无让位的自动跟随、逐段无条件滚动 / 居中、新增「跟随」开关、把跟随写进高亮。

**听书迷你条（listening mini bar）**:
宿主 `shell.overlay` 常驻层上的两个完整听书浮窗形态：缺省是身份胶囊（进度环 + 书名 + 段号 + 章内进度细线），展开是能读整段的边栏。位置与尺寸自由：现场记块中心与展开态宽高，松手时离可达区边够近的边才贴齐（可达区 = 视口减窗控带，见「窗控带与安全顶」），尺寸呈现时夹取不回写（`ADR-0100` / `ADR-0080`）。落位样式与 `side` / `flush` 由 `miniBarLayout` 一次给全；没有半隐或抽屉形态。在场判据 = 会话在 ∧ 阅读器在场书键集合里没有会话本书。
_唯一实现_: `client/tts/TtsMiniBar.tsx` 的 `TtsMiniBar`；展开面 `client/tts/TtsMiniPanel.tsx` 的 `TtsMiniPanel`；现场 `client/tts/mini-bar-state.ts` 的 `miniBarStore` / `miniBarLayout` / `miniBarCenterOf` / `resolvedMiniBarSize` / `setMiniBarCenter` / `snapMiniBarToEdge` / `setMiniBarSize`；共享设置行 `client/tts/TtsSettings.tsx` 的 `TtsSettingsRows`。 _Avoid_: 阅读器听书条、状态泳道、半隐 / 抽屉形态。

### 客户端文案

**文案字典（copy dictionary）**:
客户端可见文案的唯一住址：`ZH` 是真源，`EN` 逐键镜像；组件经 `useCopy` 取词、slot 子树经 `CopyProvider` 注入，宿主 locale 服务缺席时 `zhTranslate` 兜底。
_唯一实现_: `src/client/copy/index.tsx` 的 `ZH` / `EN` / `createTranslate` / `zhTranslate` / `CopyProvider` / `useCopy`；搜索收口句按模板组装 `src/client/copy/search-summary.ts` 的 `searchSummarySegments`。 _Avoid_: 文案表、外挂 i18n 资源、视图里拼句序。

**错误展示（error display）**:
上屏错误的一句话归谁出：客户端自造的网络错误按 `reason` 走当前语言；服务端错误原文透传（与书源数据同一条边界），错误码与段级定位原样呈现。 _唯一实现_: `src/client/api.ts` 的 `describeError` / `NetworkReason`（只翻客户端自造的三条）。 _Avoid_: 按 message 前缀判来源（`ADR-0016`）。

### 跨半契约

**书目字段集（shelf metadata field-set）**:
书架条目元数据的「名称 × 类型判别」唯一主人；加字段只改这张表。数值位的落盘归一化（非负整数）不在这张表里——归 `services/shelf.ts` 的 `Shelf`。
_唯一实现_: `shared/wire.ts` 的 `SHELF_META` + `pickShelfMeta`。 _Avoid_: 逐字段 typeof 筛键。

**来源投影（source projection）**:
书架读取面上由服务端 join 出的源名 `ShelfEntry.sourceName`。它是**读取面投影、不是书目字段**——不可 patch、不落盘，故刻意不进 `SHELF_META`。
_唯一实现_: `services/reading.ts` 的 `sourceNameOf`（读面入口 `shelfList`）。 _Avoid_: 来源字段、来源快照（同址替换会复用 sourceId）。

**分类词表（kind vocabulary）**:
书城那份可看清单的**按源**形状：一个源自己声明了哪些分类标题，按该源声明的原样顺序给、同源内去重。**不造同义词表**，跨源合并同名也不做（`ADR-0028`）。
_唯一实现_: `services/explore.ts` 的 `deriveExploreSources`；跨半形状 `shared/wire.ts` 的 `ExploreSources`。 _Avoid_: 分类目录、分类计数。

**wire 契约（wire contract）**:
`/novel-api` 规范 JSON 的值形状、路由身份（method + path）与**写路由的 body 形状**——Node 半与浏览器半之间的唯一真相。body 的两半成对住这里（`bodies` 构造器给浏览器半、`readBodies` 读口给 Node 半），键名只有一处字面量（`BODY`，与 query 同名的业务键沿用 `PARAMS`）。静态路由的 `Route` 与参数操作的 `paramOps.*` 都自带方法，写口只接受 `WriteMethod`（GET 走 `apiGet` / SSE）。
_唯一实现_: `shared/wire.ts` 的 `Route` / `ROUTES` / `paramOps` / `bodies` / `readBodies`。 _Avoid_: API 文档、body 校验。

**缺键投影（missing-key projection）**:
工具面把空值字段从规范值中整键省略的投影——工具输出既要能读回又要不撒谎，故刻意与 wire 的 `| null` 口径分歧（`ADR-0019`）。
_唯一实现_: `tools/project.ts`。 _Avoid_: 字段过滤。

**规范值（canonical value）**:
工具输出的完整 JSON 值；render 只是它的文本投影。
_唯一实现_: `tools/render.ts` 的纯 render 函数（投影侧）与 `tools/project.ts` 的 `project`（缺键省略侧）。 _Avoid_: 渲染结果。

**工具声明（tool declaration）**:
一工具一声明、一 action 一行：action 的说明、缺参清单、执行体与纯 render 同住一行；action enum 与工具描述从行派生。render 是模型唯一读到的文案，纯函数可直接喂规范值测。
_唯一实现_: `tools/tools.ts` 的 `buildTools` + `tools/render.ts`。 _Avoid_: 工具描述、缺键投影。

**语义覆盖矩阵（legado coverage matrix）**:
「本插件对 legado 书源格式做到哪一步」的唯一读数口：一行一条 legado 语义，归属只能是 实现 / 环境不适用 / 待拍板 三态（不设「未知」）。
_唯一实现_: `tests/legado-coverage/matrix.ts`；面 D 键表 `tests/legado-coverage/demand-keys.ts`（解析面普查读它，不进默认门）。 _Avoid_: 兼容性清单、TODO 表。

**环境不适用（not-applicable）**:
一条 legado 语义被判为**不接**的归属；理由写在该矩阵行的 `note` 里（「输入里带了那个键，但本仓没有承载它的交互或可配字段」一族也归这里）。
_Avoid_: 不支持、做不了。

**构建期纯度门（bundle purity gate）**:
client bundle 的构建期守卫：平台模块表之外的 `@deepseek-ai/*` **值** import、或 Node 内建闯进浏览器 bundle → 构建立刻失败。后果：`src/shared/wire.ts` 必须零运行时依赖。
_唯一实现_: `tsdown.config.ts` 的 `dsh-novel-bundle-purity` 插件 + 平台模块表 `PLATFORM_MODULES`。 _Avoid_: external / noExternal 配置。

## 基础设施与装配

**同源 fence（origin fence）**:
`/novel-api` 的进入判据四步：远端是 loopback → `Host` 在本机名单（`localhost` / `127.0.0.1` / `[::1]`，可经 `apiAllowHosts` 追加别名）→ Origin 在场必须同源 → Referer 在场必须同源。钉 Host 防 DNS rebinding；无 Origin / 无 Referer 放行是给本机工具与 curl 的承诺。
_唯一实现_: `api/wire.ts` 的 `fenceDenialOf` 与 `fenceAllowlist`；403 措辞在 `api/dispatch.ts` 的 `fenceDenialMessage`；`apiAllowHosts` 是配置键（静态、需重启）。 _Avoid_: CORS、鉴权、只比 Referer。

**配置缝（config seam）**:
原始 cordis 配置 → 类型 / schema / 缺省 / 值域的唯一边界；缺省字面量的主人仍是各消费模块的 `DEFAULT_*` 常量。volatile 字段的消费桶 `VOLATILE_CONSUMERS` 同住 `config.ts`：键集由 `VolatileConfigFieldName` 钉死，新增 volatile 字段忘归桶是编译错。
_唯一实现_: `config.ts` 的 `CONFIG_FIELDS` 与 `resolveConfig`。 _Avoid_: DEFAULTS / assertConfig 抄本、在装配处再写一份缺省字面量。

**运行参数（活配置，runtime config）**:
可在插件页编辑、保存后立即生效的十二项配置；`dataDir` 不在其中（启动期读一次）。
_唯一实现_: `config.ts` 的 `CONFIG_FIELDS` 里标了 `volatile` 的行（类型面即 `VolatileConfigFieldName`）与 `resolveConfig` 的 getter。 _Avoid_: 设置（宿主设置页是另一处）、热更新。

**插件页配置页（plugin config page）**:
挂在宿主「插件」页 `plugins.bundle.config` 槽上的「运行参数」表单，按 bundle 包名 `@xrn1997/dsh-novel` 注册。值与写协议走宿主设置面 `ctx.remote.settings`（`describe` / `mutate`）；壳与每行几何归本仓。
_唯一实现_: `client/config-page.tsx` 的 `registerConfigPage` / `NovelConfigCard` / `NovelConfigPageView`。 _Avoid_: 设置页、设置面板。

**活值读数（value source）**:
服务消费配置的取值形态：纯值（测试 / 直装）与 getter（volatile 活配置）同收，消费方在**每次操作时**读一次当前值，不把装配期的快照抄成副本。
_唯一实现_: `services/value-source.ts` 的 `ValueSource` / `readValue`。 _Avoid_: 配置快照、缓存值。

**日志缝（log seam）**:
Node 半留痕的前缀与级别出口唯一家；组合根装 console + `ctx.logger` 双腿，卸载时复位 console。engine 防线的缺省 sink 是文档化例外（依赖方向不允许 engine import services）。
_唯一实现_: `services/log.ts` 的 `log` / `setLogSink`。 _Avoid_: 逐调用点手写前缀、另开 console 出口。

**任务过程行（job progress tail）**:
宿主 job 输出面的**偏移可读**缓冲：有界、只装过程行，每个读者各持字节游标；整轮结果与业务明细归各持有者的快照读面。
_唯一实现_: `services/job-tail.ts` 的 `JobTail`（缓冲、上限与 `readFrom`）；`services/job-holder.ts` 的 `HostTie`（接成宿主 `JobSpec.output` 的拉源）。 _Avoid_: 把整轮结果塞进 job_output、把过程行当业务快照、hooks 上的 readOutput 输出面。
