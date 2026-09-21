# dsh-novel

在 DeepSeek Harness Web GUI 里读网络小说的插件：导入 legado 书源 → 聚合搜索 → 书架 → 连续滚动阅读。本文件是领域词汇表——写 spec / 改代码 / 命名新 module 时用这里的词，别自造。

词之外的**现状真相**（模块地图、关键口径与「为什么」、被否决的方案、已知开口）住三份子系统文档：`docs/design/engine.md`（规则引擎）、`docs/design/services.md`（服务层 / HTTP 面 / wire 契约 / 工具面）、`docs/design/client.md`（浏览器半）。

## Language

### 书源与规则

**书源（book source）**:
一个 legado 规则包：某站点的搜索 / 详情 / 目录 / 正文取值规则与其登录态的载体。
_Avoid_: 站点、书站（书源是规则，不是站点本身）

**源入库（source intake）**:
「书源进入系统」的唯一语义：normalize → 按址去重 → add/replace（`services/intake.ts` 的 SourceIntake）。调用方只做呈现映射（任务 counts/issues、工具 ImportOutcome 投影）。
_Avoid_: 导入逻辑（导入是调用方，不是规则本身）

**方言（dialect）**:
书源导出的三种形态——legado 平铺 / legado 对象（ruleSearch、ruleBookInfo…）/ Native（android-ebook 原生格式）。
_Avoid_: 格式、模板

**取值链（rule chain）**:
书源规则的形态：`||` 分支、组合符与终端（@text / @href / @html…）构成的链。
_Avoid_: 选择器链（选择器只是链的一段）

**净化尾（replacement tail）**:
取值链尾部的 `##pattern##replacement` 文本净化段。
_Avoid_: 替换规则

**规则文法（rule grammar）**:
规则串的构词法——分支、终端、净化尾、占位符如何组合成一条规则。构词与解析应同属一处：唯一实现在 `engine/grammar.ts`（构词 appendTail/withImplicitText + 解析 parseTails + 词法 isJsForm/splitVarExpr），normalize 的方言拼串走 appendTail 的 round-trip 自校验，越界当场进 warning。
_Avoid_: 规则格式

**搜索面（search face）**:
从「书源搜索规则 + 关键词」到「命中条目 + 首条书名」的完整请求语义；聚合搜索与探针共用同一份。
聚合搜索的参与集 = **启用 ∧ 文本源**（`type === 'text'`——本插件当前仅支持小说文本面；将来支持其他媒介只扩 reading 的 `participates` 谓词一处，不许散落第二处判别；非文本源留库、不删、不改启用态，只是不参搜。**未知形态 `unknown`** = `bookSourceType` 不是 legado 认得的整数值（0/-1/1/2/3 之外）：读不懂不等于文本，同样不参搜，导入预检点名拒绝（文案印成「类型 4（未知）」），存量由 `SourceRegistry.load` 按 raw 重推收敛。刻意**不写成 `status: 'broken'`**——探针按搜索面判 verified，坏源那条道会被下一次重验洗白）。
_Avoid_: 搜索服务

**请求组装（request assembly）**:
「URL 模板 + 变量 + baseUrl」到「可执行请求计划」的唯一语义解释——method 判定、body 插值、POST 表单默认头、charset、init 姿态全在一处（services/request.ts 的 assembleRequest / fetchInitOf）。
_Avoid_: 请求工具、fetch 封装（抓取与解码归守门 fetcher）

### 面与段

**面（facet）**:
规则求值的上下文之一：rule / search / detail / toc / content。
_Avoid_: 场景、模式（`EpochImpact`「影响面」是**另一条轴**——改一个规则字段会作废哪些面的缓存，刻意换个词，不是「面」的第二名，见「缓存代际」）

**段（segment）**:
取值链的一段。失败定位以「面 + 段序 + 段原文」表达（段级定位）。
_Avoid_: 步骤

**取值规约（reduction）**:
链上空态裁决口径（**取位失败 → Miss；解析到空集合 → 空 List**）。Miss = 失败：选择零命中 / 排除后空 / 下标越界 / 切片裁空——链中穿透；空 List = 合法零条目：元素在而取值全空，或键存在且值为空数组。选择段（default/css）与取值段（getValue）的取位/空态裁决唯一实现在 `engine/select.ts` 的 `reducePicked`（zero/excluded/oob/sliced 四态皆「取位失败」）；取值段的「元素在、取值全空 → 空 List」住 `getValue`。JSONPath（`engine/jsonpath.ts`）同口径：零命中/越界/切片裁空 → Miss，空数组 → 空 List；下标与切片均支持负数从尾数（与 `select.applyIndex` 一致）。
_Avoid_: 空结果（太泛——Miss 与空 List 是两种值）

**取值用途（rule usage）**:
同一条规则串在两种用途下**链尾未知词**语义不同，调用方按用途显式声明（`evaluate`/`SubRuleEval` 的 `usage` 参数，缺省 `'list'`）：`'value'`（legado getString 口径）链尾未知提取指令 = **HTML 属性名**（属性终端）；`'list'`（legado getElements 口径）链尾未知选择器 = **CSS**。唯一实现在 `engine/parse.ts` 的 `classifyDefault`（`ctx.usage === 'value' && isLast && isAttrName(name)`）。
_Avoid_: 模式、场景（太泛——这是「链尾未知词」的裁决轴）

**属性终端（attr terminal）**:
取值用途链尾的未知提取指令按 HTML 属性名取值（legado AnalyzeByJSoup.getResultLast 的 `else -> element.attr(rule)`）：自身属性为空向下兜底第一个含该属性的后代（html/body 包装不兜底），空值丢弃 + 去重。唯一实现在 `engine/select.ts` 的 `getValue` `mode === 'attr'` 分支。真实源 `ruleBookUrl: tag.div@onclick`、`@value`、`@_src` 全靠它。
_Avoid_: 自定义属性（太泛——这是链尾语义，不是属性语法）

**模板字面段（literal segment）**:
规则段里出现 `{{expr}}`（JS 表达式或规则递归——以 `@`/`$.`/`$[`/`//` 开头按规则求值）、`{$.path}`（单括号 JSONPath 内嵌）或 `http(s)://` URL 模板 → 整段是字面模板：插值后产出 Value（legado SourceRule 的 `else -> rule` 字面返回 + makeUpRule 插值）。识别与切分唯一实现在 `engine/literal.ts`（`isLiteralForm`/`splitLiteral`，`{{}}` 平衡括号感知）；求值在 `engine/evaluate.ts` 的 `branchGen` literal 分支（js 部分经沙箱、`{{result}}` 引用链值）。
_Avoid_: URL 规则（太泛——不只 URL，任何含插值的字面段都是）

**按文本选元素（text selection）**:
默认方言 `text.<串>`（**带参数**）= 选择段：命中「直系文本包含该串」的元素（legado getElementsContainingOwnText；`ownText.<串>` 对称取「后代文本包含」）。不带参数的 `text` 才是取值终端（全部后代文本）。唯一实现在 `engine/select.ts` 的 `evalDefault` textContaining 分支。真实源 `text.下一页@href`、`text.章节目录@href` 全靠它。
_Avoid_: 文本过滤（太泛——判据是「含文本的元素」，链上位置是选择段）

**详情上下文初始化（ruleDetailInit）**:
legado `ruleBookInfo.init` 的内部名：详情面先求值，其结果**整体替换**后续详情规则与 tocUrl 模板的求值上下文**与 html**（legado `setContent(init 产物)` 是 content 单点全换：JSON 产物 → html 与 `ctx.json` 同步换根，`{{result.articleid}}` 这类模板的 `result`/`pageText` 与 jsonpath 同源；非 JSON 产物 → 作为 html 上下文）；唯一实现 `services/reading.ts` 的 `detailContextOf`（init 非空但零命中 → `RuleEvalError` 点名 ruleDetailInit——宁炸不猜，不拿整页冒充上下文）。tocUrl 模板 `{{$.…}}` 在换根后的上下文上过引擎插值（`tocUrlOf`：静态 URL 直答，其余一律经详情上下文求值；插值段 Miss → 回退 bookUrl，不发残 URL）。
_Avoid_: init 规则（与 fetch 的 init 姿态易混，交流用内部名）

**动态请求头（headerRule）**:
legado `header` 字段的 `@js:`/`<js>` 规则形态的内部名（与静态 JSON 形态互斥同源——同一 raw.header 二选一）：请求前经沙箱求值得到 JSON 头表，叠加 auth/cookie 后发出（device-id 逐请求刷新）；求值失败 → warn 后回退静态头，不吞请求也不炸整链（legado `BaseSource.getHeaderMap` 的 try/catch 口径）。唯一求值点 `services/bridge.ts` 的 `resolveHeaders`；存量由 `SourceRegistry.load` 第七条迁移按 raw 重推。
_Avoid_: header 规则、动态 header（说内部名）

**探针（probe）**:
对一个书源真发一次搜索请求，得出可用性实测结论。
_Avoid_: 自测、健康检查

### 身份与状态

**书源注册表（source registry）**:
书源清单的唯一载体（sources.json，含登录态，仅存本机）。
_Avoid_: 源列表（UI 里的列表只是它的投影）

**按址去重（dedup by address）**:
书源入库规则：同一 baseUrl 已有**可用**源时保留已有、不新增（`skipped`）；同一 baseUrl 已有**不可用**源时用新条替换，并在替换时顺带清掉其余同键条目。唯一实现在 `services/intake.ts`（SourceIntake：normalize → 批内留首条 → 按址去重 → add/replace）——同步导入（工具面）与后台导入任务同一条路。
_Avoid_: URL 去重

**启停（enable / disable）**:
停用的书源不参与聚合搜索；探针与试跑不受影响。停用不等于删除。
_Avoid_: 删除、隐藏

**书源待办（source inbox）**:
书源管理 tab 的首屏任务面：全库源清单派生出的「坏源 / 未验证」两集合，反常置顶成任务卡（处置动作：批量重验 / 一键验证），任务收尾自动消解。待办**只看状态、不看启停**（停用只是不参与聚合搜索，停用的坏源/未验证照样置顶——停用 ≠ 免验）；加载失败不渲染待办（不拿未知当「全部良好」）。
_Implementation_: `src/client/source-inbox.ts`（派生）+ `src/client/views/SettingsSection.tsx`（`SourceInbox` 渲染）
_Avoid_: 舰队快照（黑话，已否决）、状态总览 chips（读数与过滤混杂，已退役）

**换轮（round switch）**:
搜索观察者发现读面身份已变（快照 `job.id` ≠ 观察中的轮次 id——服务端单槽，别的观察者提交了新一轮）时的唯一裁决：旧累积整体丢弃、`since=0` 重读新轮完整基线、旧连接 abort、按新轮重建观察；旧观察者**跟随最近一轮**。唯一实现 `src/client/search-job.ts` 的 `apply` 身份闸 + `rebaseline`。
_Avoid_: 重连（重连是同一轮的通道恢复；换轮是身份变了）、重置（太泛）

**bookKey**:
书籍身份：详情页 URL，**可带 `,{option}` 请求选项后缀**（legado 嗅探语义：URL 即请求规格——米读类 POST API 源的 book_id 在选项 body 里；搜索面 `absUrlKeepOption` 保留、抓取时 `assembleRequest` 解释、引擎解析 base 与比对口径 `canonUrl` 各自剥选项）；本地书为 `local:<uuid>`。
_Avoid_: id、url（太泛）

**本地书（local book）**:
从本地 TXT 导入的书，源身份固定 `__local__`，与在线书源正交。

**后台任务（background job）**:
跑在服务端的耗时任务，三种 kind：`novel-import` / `novel-probe`（写，共用一个槽、运行中互斥）与 `novel-search`（读，**另开一槽**——搜索不该挡住导入）。结果保留到下一个同类任务开始（搜索另有 30 分钟保留期），关页面、切界面都不影响它跑完。身份与生命周期登记给宿主的 `ctx.jobs`（`<kind>-N`、协作式取消、随服务卸载而终止），**停止（cancel）不是失败也不是放弃**：本轮立即进终态、不再开新的源，已搜出的结果留在读面。业务计数与明细仍归本仓的持有者（`SourceJobs` / `SearchJobs`）——宿主只有 `label` 与一行 `detail`，装不下 642 源的失败分桶，也装不下整轮搜索结果。
_Avoid_: 队列（不是队列，是单槽）、前端任务（在途循环不在浏览器半）

**阅读会话（reader session）**:
「目录 → 存档恢复 → 逐章懒加载 → 预取 → 进度落盘」的时序编排持有者（client/reader-session.ts）；DOM 测量经 ReaderPort 注入，视图只渲染与接线。
_Avoid_: 阅读器状态管理（视图里的 state 只是它的投影）

**判到底（翻页闸）**:
「下一页 / 下一目录页」何时停的唯一语义，唯一实现 `services/pagination.ts` 的 `followPages`（`stoppedBy` 五态）。next 规则按**列表语义**求值（legado getStringList(isUrl=true)）：1 个候选链式跟进（每页继续求值 next）；多个候选全部抓取但**不递归翻页**（legado getNextPageUrl=false）。停止判据次序：**URL 防环**（候选地址已抓过不入队，legado nextUrlList 口径）→ **零新增闸**（本页提取 0 条 → 空页之后的页不可信）→ **回环闸**（本页有条目但 0 新增——整页全是见过的条目 = 到底/软404；**部分重复不停**，legado 目录翻页只按 URL 防环、条目去重，站点页间重叠是常态）→ **上限闸**（`maxPages`：目录 200 / 正文 50）。正文面串章闸：候选「下一页」== 目录里**其他章节 URL** → 停（legado「下一页 == 下一章 URL 即 break」的正判据，`stopUrls` 目录知识）；无目录知识时才回退路径启发式（`services/chapter-page.ts` 的 `isSameChapterPage`，判不准时宁漏页不串章）。
_Avoid_: 翻页循环、重复过滤（太泛——判据是「本页零新增」与「URL 已见」，不是「出现重复就停」）

**单在途槽（reader session）**:
阅读会话同一时刻只允许一个章节加载在途（`inflight`）；滚动风暴与目录直达都只记意图（`pendingJump`），在途释放后由 `settlePendingLoad()` 补拉（否则那次点击无声消失）。刚失败过的同一章不自动重试——等用户点「重试」。唯一实现 `client/reader-session.ts`。
_Avoid_: 请求去重（那是网络层语义；这是会话级时序）

**缓存代际（epoch）**:
「这份目录 / 正文缓存还有效吗」的唯一算式：按面细分的规则指纹 + baseUrl，**入缓存文件名**而不是删除式失效——换规则后旧代际的文件自然读不到，在途请求写的是它起飞时那个代际（旧在途写回自动无害）。唯一实现 `services/cache-epoch.ts` 的 `rulesEpoch`；裁决在 `services/reading.ts` 的 `getTocInner` / `getChapter`（读与写共用同一次算出的值）。刻意不含 `NovelSource.auth`（登录态刷新会整源缓存全灭）。
_Avoid_: 版本号（代际是规则指纹，不是自增版本）、缓存键（太泛——文件名还含 safeKey / 章序 / 槽位）

**正文槽位（slot）**:
正文缓存文件名的有效性段 = 代际 + 章名。代际管「规则变了」，章名管「站点侧目录变了」（站点前插一章 → 章序位移 → 旧文件端给读者**另一章**）；刻意**不含章节 url**（带时效 token 的站点每次刷目录都换 url，入键等于正文缓存永不命中）。唯一实现 `services/cache-epoch.ts` 的 `contentSlot`。
_Avoid_: 正文键、章节 id（槽位是「代际 × 章名」的指纹，既不是章序也不是 url）

### 跨半契约

**书目字段集（shelf metadata field-set）**:
书架条目 7 个元数据字段（sourceId/title/author/coverUrl/intro/lastChapterName/totalChapters）的「名称 × 类型判别 × 归一化」唯一主人：`shared/wire.ts` 的 `SHELF_META` 表 + `pickShelfMeta`。Shelf.applyPatch 遍历表保值覆盖，shelfBody 与 dispatch.shelfPut 都从 pick 派生；加字段只改这张表。
_Avoid_: 逐字段 typeof 筛键（那是这张表的抄本）

**来源投影（source projection）**:
书架读取面上由服务端 join 出的源名：`shared/wire.ts` 的 `ShelfEntry.sourceName`，算式唯一实现在 `services/reading.ts` 的私有 `sourceNameOf`（读面入口是同一文件的 `shelfList`）。源已被删（join 不到）与本地书都投影成 `null`，客户端分别落成灰字「来源已删除」与不出 chip。它是**读取面投影**、不是书目字段——不可 patch、不落盘，故刻意不进 `SHELF_META`（进表 = 变成能被 PUT 写进 shelf.json 的假元数据）。
_Avoid_: 来源字段（那是落盘书目字段的说法）、来源快照（加书那刻定死的旧名——本项目故意不要：同址替换会复用 sourceId，快照会静默陈旧）

**wire 契约（wire contract）**:
`/novel-api` 规范 JSON 的值形状与路由名——Node 半与浏览器半之间的唯一真相，代码只许有一个主人。
_Avoid_: API 文档（文档是它的抄本）

**缺键投影（missing-key projection）**:
工具面把空值字段从规范值中省略的投影——harness 的 lossless-JSON 约束下的职责，不是 wire 口径。
_Avoid_: 字段过滤

**规范值（canonical value）**:
工具输出的完整 JSON 值；render 只是它的文本投影。

**构建期纯度门（bundle purity gate）**:
client bundle 的构建期守卫：平台模块表之外的 `@deepseek-ai/*` **值** import、或 Node 内建闯进浏览器 bundle → 构建立刻失败（type-only import 已被擦除，到不了这道门）。唯一实现 `tsdown.config.ts` 的 `dsh-novel-bundle-purity` 插件（`resolveId` 直接 throw）+ 平台模块表 `PLATFORM_MODULES`（两份官方样例的并集）。后果：`src/shared/wire.ts` 必须零运行时依赖——它被整个 inline 进 client bundle。
_Avoid_: external / noExternal 配置（那是宿主侧 bundler 的事）
