# dsh-novel

在 DeepSeek Harness（DSH）里读网络小说的插件：导入 legado 书源 → 聚合搜索 → 书架 → 连续滚动阅读。

本文件是**领域词汇表**：只回答「这个词指什么、它的唯一实现在哪个符号」。写 spec、改代码、命名新 module 之前先查这里——自造同义词会让同一概念长出第二份抄本。

**这里不装口径论证。** 每条口径的「为什么、被否决的方案、真机读数」的家：就地住实现它的代码注释，读数住 `tests/legado-coverage/matrix.ts` 的行 `note`，用户可见的事实住 `README.md`。本表只留一句判据和一个锚点；看到某条口径想追问「为什么这么定」，去实现它的那个符号头上读。

## Language

### 书源与规则

**书源（book source）**:
一个 legado 规则包：某站点的搜索 / 详情 / 目录 / 正文取值规则与其登录态的载体。
_唯一实现_: `services/types.ts` 的 `NovelSource`（规范化后的形状）+ `shared/wire.ts`（跨半投影）
_Avoid_: 站点、书站（书源是规则，不是站点本身）

**源入库（source intake）**:
「书源进入系统」的唯一语义：normalize → 批内去重 → 按址去重 → add/replace。调用方只做呈现映射。
_唯一实现_: `services/intake.ts` 的 `SourceIntake`
_Avoid_: 导入逻辑（导入是调用方，不是入库规则本身）

**方言（dialect）**:
书源导出的三种形态——legado 平铺 / legado 对象（`ruleSearch`、`ruleBookInfo`…）/ Native（android-ebook 原生格式）。
_唯一实现_: `services/normalize.ts`
_Avoid_: 格式、模板

**取值链（rule chain）**:
书源规则的形态：`||` 分支、组合符与终端（`@text` / `@href` / `@html`…）构成的链。
_Avoid_: 选择器链（选择器只是链的一段）

**净化尾（replacement tail）**:
取值链尾部的 `##pattern##replacement` 文本净化段。
_Avoid_: 替换规则

**规则文法（rule grammar）**:
规则串的构词法——分支、终端、净化尾、占位符如何组合成一条规则。判据：构词与解析同属一处，方言拼串走 round-trip 自校验，越界当场进 warning。
_唯一实现_: `engine/grammar.ts`（构词 `appendTail`/`withImplicitText` + 解析 `parseTails` + 词法 `isJsForm`/`splitVarExpr`）
_Avoid_: 规则格式

**搜索面（search face）**:
「书源搜索规则 + 关键词」到「命中条目 + 首条书名」的完整请求语义；聚合搜索与探针共用同一份。参与集判据：**启用 ∧ 文本源**。
_唯一实现_: `services/search-face.ts`；「谁参与」的判据同住 `services/participation.ts`——搜索面 `participates`（启用 ∧ 文本源），发现面 `exploreParticipates`（其上再要求声明了分类入口、且书源自己没把发现关掉）
_Avoid_: 搜索服务

**发现面（explore face / 书城）**:
「**一个源 + 这个源自己声明的一个分类名 + 第几页**」到「该分类在这个源上、这一页的书目」的完整请求语义与其整轮编排——浏览轴就是这三样，没有跨源那一维（裁决见 `docs/adr/0028`）；用户可见的名字是面板里的「书城」tab。参与集判据四条：**启用 ∧ 文本源 ∧ 声明了分类入口 ∧ 没把发现关掉**。
_唯一实现_: 单源一次抓取 `services/explore-face.ts` 的 `fetchKindPage`（页码由调用方给）；单源一页的执行体 `services/explore.ts` 的 `fetchExploreGroup`（**从不抛错**：抓取失败以带 `error` 的组交回）；「谁进城」的谓词 `services/participation.ts` 的 `exploreParticipates`（发现开关的 raw 读口 `services/normalize.ts` 的 `rawExploreEnabled`）
_Avoid_: 书城列表页、分类搜索（发现面是另一条链路，不是聚合搜索的第二次调用）

**分类入口（explore kinds）**:
一个源「有哪些分类」的逐源声明（用户面与 `docs/adr/0027` 里也叫**发现入口**，指同一件事）。**两方言的地址语义不同**：原生 `ruleFind.kinds` 里的地址是填进源级模板 `{{kind}}` 的值，legado `exploreUrl` 里的地址本身就是那一类的完整模板（自带页码位）；落位后统一成模型里的 `ruleExploreKinds` 一个形状。**「这次用哪份模板」先问源级模板在场吗，方言只决定兜底、不决定优先**——判据的主人是 `explore-face.fetchKindPage`（裁决见 `docs/adr/0027`），此处不复述。脚本形态（`@js:` / `<js>`）本期不执行，声明它的源在书城没有分类。
_唯一实现_: 解析与形态判定 `services/explore-url.ts` 的 `parseExploreKinds`（判据同住 `exploreKindsFormOf`）；落位在 `services/normalize.ts`——导入侧 `flattenDialect`（legado，条目尺同住 `parseExploreKinds`）与 `flattenNative`（原生，条目尺同住 `nativeExploreFields`），存量按 raw 补推同住 `rawExploreFields`（两方言跑的是同一个 flatten）
_Avoid_: 分类词表（那是一个源自己声明的分类标题摊开后的清单，主人是 `deriveExploreSources`）、发现列表

**书籍详情浮层（book sheet）**:
书城右区一本**已经点名的源上的书**的落点：整段简介（浮层里不夹行，卡片上才夹一行）+ 本源那两个动作（读这本 / 加入书架）+「在其他源找这本」那一次**手动**聚合搜索。源不在这层点名——浏览轴收成按源后，源在左栏第一层就点完名了（裁决见 `docs/adr/0028`）。跨源结果不替用户判是不是同一本书，按源一行行列出来他自己看。
_唯一实现_: `client/views/CityBookSheet.tsx`（跨源那一次复用搜索面，不新造第二条跨源遍历；关键词构造同住 `client/city-view-model.ts` 的 `sheetKeyword`）
_Avoid_: 选源（这一层不做这个动作，源已定）、详情面板（「面板」在本仓指宿主里那个全局面板，这层只是它内部的一层覆盖；也别与规则求值的那个**详情面**混为一谈——那是一条取值链路，不是一层界面）

**请求组装（request assembly）**:
「URL 模板 + 变量 + baseUrl」到「可执行请求计划」的唯一语义解释——method 判定、body 插值、POST 默认头、charset、init 姿态全在一处。
_唯一实现_: `services/request.ts` 的 `assembleRequest` / `fetchInitOf`
_Avoid_: 请求工具、fetch 封装（抓取与解码归守门 fetcher）

### 面与段

**面（facet）**:
规则求值的上下文之一：rule / search / detail / toc / content。
_Avoid_: 场景、模式；也别与「影响面」（`EpochImpact`，缓存那一轴）混称

**段（segment）**:
取值链的一段。失败定位以「面 + 段序 + 段原文」表达，即段级定位。
_唯一实现_: `engine/types.ts` 的 `Segment` 与 `SegmentLoc`
_Avoid_: 步骤

**取值规约（reduction）**:
链上空态的裁决口径，两种值绝不折叠：**取位失败 → Miss；解析到空集合 → 空 List**。
_唯一实现_: `engine/select.ts` 的 `reducePicked`（选择段与取值段共用）；JSONPath 侧 `engine/jsonpath.ts` 同口径
_Avoid_: 空结果（太泛——Miss 与空 List 是两种值）

**值投影（value projection）**:
服务层把链尾 `EngineValue` 收成业务串的三种口径：单值文本位、URL 位、多值位。
_唯一实现_: `services/bridge.ts` 的 `firstValue` / `firstUrlValue` / `listValue`（字段侧入口同名分家：`fieldOf`/`urlFieldOf` 不吞错，`auxFieldOf`/`auxUrlFieldOf` 读不出留空）
_Avoid_: 取值规约（那是引擎层的空态裁决；这条是服务层的值收口）

**取值用途（rule usage）**:
同一条规则串在两种用途下**链尾未知词**的语义不同，调用方显式声明：`'value'` → 未知词按 HTML 属性名；`'list'` → 未知词按 CSS。
_唯一实现_: `engine/parse.ts` 的 `classifyDefault`
_Avoid_: 模式、场景（太泛——这是「链尾未知词」的裁决轴）

**属性终端（attr terminal）**:
取值用途下链尾的未知提取指令按 HTML 属性名取值：自身为空向下兜底第一个含该属性的后代。
_唯一实现_: `engine/select.ts` 的 `getValue`（`mode === 'attr'` 分支）
_Avoid_: 自定义属性（太泛——这是链尾语义，不是属性语法）

**模板字面段（literal segment）**:
规则段含 `{{expr}}`、`{$.path}` 或 URL 模板时整段按字面模板插值求值，产出 Value 而不报「认不出」。
_唯一实现_: 识别与切分 `engine/literal.ts`（`isLiteralForm`/`splitLiteral`），求值 `engine/evaluate.ts` 的 `branchGen` literal 分支
_Avoid_: URL 规则（太泛——不只 URL，任何含插值的字面段都是）

**AllInOne 行模板（row template）**:
AllInOne 条目下字段规则的形态：支文本出现 `$\d{1,2}` 时整支是行组引用模板，值 = 用当前行把 `$n` 绑好后的原文，不再按规则解析。js 区域豁免。
_唯一实现_: 判定 `engine/parse.ts`，绑定 `engine/regex-row.ts` 的 `bindRegexRow`，求值 `engine/evaluate.ts` 的 regexRow 分支；行经 `services/bridge.ts` 的 `ItemContext` 传入
_Avoid_: 变量替换、`$n` 展开（说「行模板」）；与「模板字面段」混称（两者按**触发形态**分家，出处见矩阵行 `a-allinone-group-zero`）

**按文本选元素（text selection）**:
默认方言 `text.<串>`（带参数）是选择段：命中「直系文本包含该串」的元素；不带参数的 `text` 才是取值终端。
_唯一实现_: `engine/select.ts` 的 `evalDefault`（textContaining 分支）
_Avoid_: 文本过滤（太泛——判据是「含文本的元素」，链上位置是选择段）

**详情上下文初始化（ruleDetailInit）**:
legado `ruleBookInfo.init` 的内部名：详情面先求值，其产物**整体替换**后续详情规则与 tocUrl 模板的求值上下文与 html。init 非空但零命中 → 抛错点名，不拿整页冒充上下文。
_唯一实现_: `services/bridge.ts` 的 `detailContextOf`（详情七字段取值单点同文件 `detailFieldsOf`；tocUrl 单点 `tocUrlOf`）
_Avoid_: init 规则（与 fetch 的 init 姿态易混，交流用内部名）

**纯 `@put` 的 init**:
整条规则只设变量时**不换根**——判据归引擎。
_唯一实现_: `engine/parse.ts` 的 `isPutOnlyRule`

**规则变量表（`ctx.vars`）**:
`@put` / `@get` 与沙箱 `java.put`/`java.get` 共用的那张键值表；引擎零内部状态，表由调用方持有并跨规则共享。作用域主人是门面：一次详情调用一张表，跨面不传。
_读写实现_: `engine/variables.ts` 的 `evalPut`/`evalGetVar`
_Avoid_: 变量池（太泛）、缓存（`cache` 是按源隔离的另一套键值表）

**动态请求头（headerRule）**:
legado `header` 字段的 `@js:`/`<js>` 规则形态的内部名（与静态 JSON 形态互斥同源）。求值失败 → warn 后回退静态头，不吞请求也不炸整链。
_唯一实现_: `services/bridge.ts` 的 `resolveHeaders`
_Avoid_: header 规则、动态 header（说内部名）

**探针（probe）**:
对一个书源真发一次搜索请求，得出可用性实测结论。关键词序列第一位是源自带的校验词，其后才是通用词。
_唯一实现_: `services/probe.ts`（校验词来自 `rules.probeKeyword`）
_Avoid_: 自测、健康检查

### 身份与状态

**书源注册表（source registry）**:
书源清单的唯一载体（`sources.json`，含登录态，仅存本机）。
_唯一实现_: `services/sources.ts` 的 `SourceRegistry`
_Avoid_: 源列表（UI 里的列表只是它的投影）

**按址去重（dedup by address）**:
同一 baseUrl 已有**可用**源时保留已有（`skipped`）；已有**不可用**源时新条替换并清掉其余同键条目。以可用者为准，是新条目规则改进被丢弃的既定口径。
_唯一实现_: `services/intake.ts` 的 `SourceIntake`
_Avoid_: URL 去重

**启停（enable / disable）**:
停用的书源不参与聚合搜索；探针与试跑不受影响。停用 ≠ 删除，也 ≠ 免验。
_唯一实现_: `services/sources.ts` 的 `setEnabled`
_Avoid_: 删除、隐藏

**书源待办（source inbox）**:
书源管理 tab 的首屏任务面：全库源清单派生出「坏源 / 未验证」两集合，反常置顶成任务卡，任务收尾自动消解。只看状态、不看启停；加载失败不渲染待办（不拿未知当「全部良好」）。
_唯一实现_: `src/client/source-inbox.ts`（派生）+ `src/client/views/SettingsSection.tsx`（渲染）
_Avoid_: 舰队快照（黑话，已否决）、状态总览 chips（读数与过滤混杂，已退役）

**换轮（round switch）**:
搜索观察者发现读面身份已变（快照 `job.id` ≠ 观察中的轮次 id）时的唯一裁决：旧累积整体丢弃、`since=0` 重读新轮基线、旧连接 abort、按新轮重建观察。
_唯一实现_: `src/client/search-job.ts` 的 `apply` 身份闸 + `rebaseline`
_Avoid_: 重连（重连是同一轮的通道恢复；换轮是身份变了）、重置

**整帧替换（full-frame replace）**:
发现面观察者的换轮裁决：读面是全量快照且**不设累积器**，故不比轮次身份——轮到谁就以谁的整帧为准，服务端换了轮（别的观察者提交）时新帧自然全覆盖，即「跟随最近一轮」。
_唯一实现_: `src/client/explore-job.ts` 的 `apply`
_Avoid_: 换轮（那是搜索面的说法：那边握着一份只对自己有效的游标，必须验身份、丢累积、从基线重读；这里没有可丢的东西）

**bookKey**:
书籍身份：详情页 URL，**可带 `,{option}` 请求选项后缀**（URL 即请求规格）；本地书为 `local:<uuid>`。
_相关实现_: `services/request.ts` 的 `assembleRequest`（解释选项）、`shared/wire.ts`（URL 剥选项与比对口径）
_Avoid_: id、url（太泛）

**本地书（local book）**:
从本地文件导入的书，**TXT 与 EPUB 2/3 两支**，分流按**内容**（ZIP 魔数走 EPUB 路径，其余走 TXT 解码链），两条互不兜底；源身份固定 `__local__`，与在线书源正交。
_唯一实现_: `src/services/localbooks.ts`（身份、分流、提交、读取、删除）+ `src/services/epub/`（解析与规范化——不认识书架与 HTTP）
_Avoid_: 本地 TXT（口径覆盖两种格式，书架卡片因此只说「本地」，真格式由导入回执的 `format` 交代）、上传文件

**后台任务（background job）**:
跑在服务端的耗时任务，四种 kind：`novel-import` / `novel-probe`（写，共用一槽）与 `novel-search` / `novel-explore`（读，另开一槽）。身份与生命周期登记给宿主 `ctx.jobs`；业务计数与明细归本仓持有者。**停止（cancel）不是失败也不是放弃**。
_唯一实现_: `services/import-job.ts` / `services/probe.ts` / `services/search-job.ts` / `services/explore-job.ts`
_Avoid_: 队列（是单槽不是队列）、前端任务（在途循环不在浏览器半）

**分类轮次（explore round）**:
一轮分类浏览的持有物：**一轮 = 一个源 + 一个类**，各页结果**跨页累积**住在 Node 半，读面给**全量快照**（整帧替换）；一次只留最近一轮，过了保留期读作「无任务」。**续页是这一轮里的事**（同 id 再打一页，不换轮；失败或被停止的那一批不占页号，所以再打的可能是同一页），快照上的 `page` / `hasMore` 是**动作契约**——`hasMore` 只说「此刻能不能点」，不是「还有没有书」。
_唯一实现_: `services/explore-job.ts` 的 `ExploreJobs`——整轮读数 `page` / `hasMore`、续页 `advance`、迟到批次那条边界 `absorb` 全在这一处；到底判据不自立第二个出口，它就是 `snapshot` 里 `hasMore` 的那个累积因子；门面入口 `services/reading.ts` 的 `loadMoreExploreJob`；跨半形状 `shared/wire.ts` 的 `ExploreSnapshot`
_Avoid_: 分类任务队列（是单轮槽不是队列）、新一轮（续页不换 id、不换身份，只有提交才换轮）

**阅读会话（reader session）**:
「目录 → 存档恢复 → 逐章懒加载 → 预取 → 进度落盘」的时序持有者；DOM 测量经 `ReaderPort` 注入，视图只渲染与接线。同一时刻只允许一章在途（`inflight`），滚动风暴与目录直达只记意图（`pendingJump`），刚失败过的同一章不自动重试。
_唯一实现_: `client/reader-session.ts`
_Avoid_: 阅读器状态管理（视图里的 state 只是它的投影）

**判到底（翻页闸）**:
「下一页 / 下一目录页」何时停的唯一语义：next 规则按取值用途求值、结果按列表形状处理。停止判据次序与代码同序——防环 → 上限 → 零新增 → 回环；正文面另串章闸。
_唯一实现_: `services/pagination.ts` 的 `followPages`（`stoppedBy` 五态）；串章启发式 `services/chapter-page.ts` 的 `isSameChapterPage`
_Avoid_: 翻页循环、重复过滤（判据是「本页零新增」与「URL 已见」，不是「出现重复就停」）

**阅读位置（reading position）**:
「这本书读到哪儿」= 章 + 章内比例（`{chapterIndex, offsetRatio}`）。在会话里是状态：`position` 是唯一真相，滚动测量 / 目录选中 / 存档恢复都只是修正它；落盘由单点 `commit(cause)` 判定。服务端 last-write-wins，前提是「只有一个读者」。
_唯一实现_: `client/reader-session.ts`（状态）+ `client/progress.ts`（位置 ⇄ 像素）+ `shared/wire.ts` 的 `ShelfProgress`、`hasProgress`
_Avoid_: 进度（要区分「元数据」与「阅读位置」）、scrollTop（像素是测量值，不是位置本身）

**缓存代际（epoch）**:
「这份目录 / 正文缓存还有效吗」的唯一算式：按面细分的规则指纹 + baseUrl，**入缓存文件名**而不是删除式失效。刻意不含 `auth`（登录态刷新会整源缓存全灭）。
_唯一实现_: `services/cache-epoch.ts` 的 `rulesEpoch`；裁决在 `services/reading.ts` 的 `getTocInner` / `getChapter`
_Avoid_: 版本号（是规则指纹不是自增版本）、缓存键

**正文槽位（slot）**:
正文缓存文件名的有效性段 = 代际 + 章名：代际管「规则变了」，章名管「站点侧目录变了」。刻意**不含章节 url**（带时效 token 的站点每次刷目录都换 url）。
_唯一实现_: `services/cache-epoch.ts` 的 `contentSlot`
_Avoid_: 正文键、章节 id

### 跨半契约

**书目字段集（shelf metadata field-set）**:
书架条目元数据的「名称 × 类型判别 × 归一化」唯一主人；加字段只改这张表。
_唯一实现_: `shared/wire.ts` 的 `SHELF_META` + `pickShelfMeta`
_Avoid_: 逐字段 typeof 筛键（那是这张表的抄本）

**来源投影（source projection）**:
书架读取面上由服务端 join 出的源名 `ShelfEntry.sourceName`。它是**读取面投影、不是书目字段**——不可 patch、不落盘，故刻意不进 `SHELF_META`。
_唯一实现_: `services/reading.ts` 的 `sourceNameOf`（读面入口 `shelfList`）
_Avoid_: 来源字段（那是落盘书目字段的说法）、来源快照（同址替换会复用 sourceId，快照会静默陈旧）

**分类词表（kind vocabulary）**:
书城那份可看清单的**按源**形状：一个源自己声明了哪些分类标题，按该源声明的原样顺序给、同源内去重。**不造同义词表**（「玄幻」≠「奇幻」是站点的真实分歧），跨源合并同名也不做——浏览轴的这一维是「点名一个源」（裁决见 `docs/adr/0028`）。
_唯一实现_: `services/explore.ts` 的 `deriveExploreSources`；跨半形状 `shared/wire.ts` 的 `ExploreSources`
_Avoid_: 分类目录（那是站点侧的分类，词表是各源自己声明的标题）、分类计数（旧版那份「被多少源声明」的读数随跨源轴一起走了）

**wire 契约（wire contract）**:
`/novel-api` 规范 JSON 的值形状与路由名——Node 半与浏览器半之间的唯一真相，代码只许有一个主人。
_唯一实现_: `shared/wire.ts`
_Avoid_: API 文档（文档是它的抄本）

**缺键投影（missing-key projection）**:
工具面把空值字段从规范值中整键省略的投影——harness 的 lossless-JSON 约束下的职责，不是 wire 口径。
_唯一实现_: `tools/project.ts`
_Avoid_: 字段过滤

**规范值（canonical value）**:
工具输出的完整 JSON 值；render 只是它的文本投影。
_唯一实现_: `tools/tools.ts` 各工具的 `render`（投影侧）与 `tools/project.ts` 的 `project`（缺键省略侧）
_Avoid_: 渲染结果（值与投影不是一回事）

**语义覆盖矩阵（legado coverage matrix）**:
「本插件对 legado 书源格式做到哪一步」的唯一读数口：一行一条 legado 语义，归属只能是 实现 / 环境不适用 / 待拍板 三态（不设「未知」）。
_唯一实现_: `tests/legado-coverage/matrix.ts`（数据）；能力单元清单 `tests/legado-coverage/inventory-coverage.test.ts`
_Avoid_: 兼容性清单、TODO 表

**环境不适用（not-applicable）**:
一条 legado 语义被判为**不接**的归属；理由写在该矩阵行的 `note` 里（对面自己没实现的字段也归这里，防止「对面没有」被当成「我们该补」）。
_Avoid_: 不支持（太泛——没说清是裁决还是欠账）、做不了

**构建期纯度门（bundle purity gate）**:
client bundle 的构建期守卫：平台模块表之外的 `@deepseek-ai/*` **值** import、或 Node 内建闯进浏览器 bundle → 构建立刻失败。后果：`src/shared/wire.ts` 必须零运行时依赖（它被整个 inline 进 client bundle）。
_唯一实现_: `tsdown.config.ts` 的 `dsh-novel-bundle-purity` 插件 + 平台模块表 `PLATFORM_MODULES`
_Avoid_: external / noExternal 配置（那是宿主侧 bundler 的事）
