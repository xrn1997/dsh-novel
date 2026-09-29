# legado 兼容面：不适用清单与判据

这份文档只做一件事：**把「legado 有、本插件刻意不接」的能力面写清理由**。它和
`tests/legado-coverage/matrix.ts` 是一对——矩阵里每行 `not-applicable` 都必须指向本文（或子系统
设计文档）里一个真实存在的锚点措辞，机器守卫 `tests/legado-coverage/coverage.test.ts` 逐行验。

**判据①的「每条语义都有归属」现在有五层在册的机器检查**：
① 归属映射（`tests/legado-coverage/inventory-coverage.test.ts`）——31 个能力单元（`UNITS`，
**在册数据本身**：有 `###` 小节的组用小节号 A1…F2，只有 `##` 一级的组用整组 E/G/H/I/J/K；`## L`
是结论不是能力）每个都要挂到 ≥2 条真实存在的矩阵行，行被改名或删除即刻报红；
② 对面字段面（`tests/legado-coverage/upstream-fields.test.ts`）——分母是**仓内快照**里那 7 个规则实体的字段表
（从 `data/entities/rule/*.kt` 抽出后冻结进仓，判据**不现读对面 checkout**），每个字段都要有归属：矩阵行的文本提到它（容忍本仓换名，
如 `lastChapter` → `ruleLastChapter`），或在 `FIELD_OWNERSHIP` 里点名它挂哪条整块裁决行并给理由；
本仓漏登记 → 红，登记了但快照里已无此字段（僵尸）→ 也红。**对面自己新增的字段要等刷新快照那天才露出来**：
这道门吃的是冻结件，别读成「上游一改我们就红」。
③ 引用活性（`tests/legado-coverage/citation-liveness.test.ts`）——仓内每个指向别处的引用都能被读者
现查：**外部出处只许出现在四处**（`README.md` / 本仓覆盖矩阵 / 本文件 / 快照刷新工具），其余地方
只讲本仓口径与理由、不点对面文件与符号；对面 `.kt` 必须是**带目录的相对路径**且能在**仓内快照**
的路径集里现查、任何引用不许带行号、`.superpowers/` 只许是登记过的工具输出目录。快照不在场即红
（它是入库内容，谁 clone 都拿得到；外部 checkout 只是开发阶段刷新快照时的输入）；
④ 对面宿主方法面（`tests/legado-coverage/host-methods.test.ts`，2026-09-28 补）——快照的**第三个
分母** `javaMethods`（66 个名字）此前只被普查用来判「真源调了而本仓没挂」，于是「对面有、现库暂时
没人调、本仓也没挂、登记面也没说它不适用」这一整类缺席项**永远不进任何判据**。现判据：每个名字
要么挂在**沙箱自报**的 `java` 面上，要么在矩阵里**逐字**点名（不做前缀或大小写归一的模糊匹配——
那会把 `getTag` 算成被 `getTags` 覆盖，正是本仓最讨厌的静默产假判定）。挂载面与普查**共用同一个探针**
（`tests/java-surface.ts`；两处各探一次就会各漂各的，而「抄协议表 / 正则抠 BOOTSTRAP」两种抄法
历史上都误报过）。当轮读数：66 名 / 已挂 29 / 未挂但已点名 37 / 两边都不沾 0。
**两侧红检都做过**：把一个点名名字改掉即报「既没挂、矩阵也没点名」；把真已挂载的名字塞进未挂名册
即报「其实已挂载，却被列在未挂名册里」——单向门只防漏登记，反向那半防的是过期缺席项被当成裁决；
⑤ 行 id 这个锚的两侧（`tests/legado-coverage/matrix-pointers.test.ts`，2026-09-28 补）——本文件与
`AGENTS.md` 把「要给出处就指矩阵行 id」定成全仓替代口径，而**指的那一行还在不在**此前无人管：行改名或
删掉之后，注释与文档里的指针会静默落到不存在的地址上，读的人按图索骥找不到登记，就把这条裁决当成
「没登记过」重新讨论一遍。正向判据：文本里「矩阵 / 矩阵行」后面跟着的 kebab 记号必须在 `COVERAGE`
现查得到（带 `*` 的族指认要求至少命中一行；指针总数骤降即判空转）。反向判据：每条 `open` 行的 id
必须在 `docs/design/*.md` / `CONTEXT.md` / `README.md` 里可达——**矩阵文件自己不算引用**（它当然含每个 id），
**匹配用整词不用子串**（红检时把某行改名成「旧名-MOVED」，子串判据照样绿，那才是本判据要抓的形状）。
当轮抓出 13 条只活在矩阵里的 open 行，已按组在 engine.md / services.md / client.md 各补一条可达性清单
（**读数与判据仍住矩阵那一行**，清单只负责让"读那份文档"这条路走到它——一个量一个主人）。

**快照刷新是有输入的了，而且是例行动作**（2026-09-28）：本机存在对面 checkout（`legado-with-MD3`，快照 meta 记的 fork 就是它），
`DSH_CAPTURE_UPSTREAM=1 DSH_LEGADO_REF=<该 checkout>` 一跑即换三个分母。本轮第一次刷：
**源根路径集 1909 → 1878**（消失的 31 条**全是**对面 `PrivateAccess` / `PrivateContent` / 生物解锁那一族——与规则格式、js 桥两个分母无关，
且无一处被跟踪文本引用，所以六门一字未红）；**规则实体字段表与 java 宿主方法名集一字未动**（仍 7 类 / 66 名）。
⇒ 引用对面源码不再是"隔着两天前的快照说话"；分母漂了就来刷一次，别把过期出处当现状。

**②这一层是替换品，不是补充**。原先的第 2 层是从一份**不入库的手抄笔记**现读小节集合做双向比对，
笔记一消失那层就静默转 skip——实测发生过：`pnpm test` 从 `1338 passed | 3 skipped` 变成
`1337 | 4`，**没有任何东西变红**，而那份笔记再也拿不出来。判据的分母架在会蒸发的文件上等于没有判据；
对面 rule 实体类才是格式的权威定义，且它是机器可读的。在此之前「矩阵覆盖了对面的字段面」也只是人说的：
矩阵行只写中文描述时，字段门会读不到归属（它一上线就点出 `lastChapter` 与 `callBackJs` 两个漏登记）。

**为什么要有这份文档**：判据是「每条 legado 语义要么实现并钉住，要么有证据判为环境不适用」。
「不适用」如果不写下来，就和「忘了做」「不知道」长得一模一样；写下来之后，下一次有人遇到这类源
报「不支持」，能直接查到这是裁决而不是漏洞。反过来说：**这里没有列出的缺席项就是欠账**，
按矩阵的 `open` 行排队。

## 审计失败归因（判据②怎么复算）

兼容目标的机器口径是「`UnsupportedRuleError` / `RuleEvalError` / `JsSandboxError` 三类引擎侧失败清零（站点与网络侧不计）」。
**只按 error name 计数读不出东西**：同一种 name 里既装着「本仓不认这条语法」，也装着「页面上没这个结构」
和「源脚本自己的正则取到 null」——把它们混成一个数字，既会把站点侧算成本仓欠账，也会把本仓缺口藏起来。

所以归因单点在 `tests/content-audit-classify.ts`，按**消息锚点**分四栏：

| 栏 | 判据 | 处置 |
| --- | --- | --- |
| `host-gap` | 锚点全部是本仓写下的抛错文案：缺 java/Packages 方法、未知元素桥操作、段类型/`XPath 步骤不支持`/`XPath 轴不支持`/`谓词…`、链终点误剩节点集、`在 v1 不支持` | **这一栏要清零**（`residual` = 本栏 + `unattributed`） |
| `guard` | 本仓**刻意闸口**：对面静默取空或整本回退目录页，我们明确失败（`目录 URL 规则未取到任何章节地址`、`无法解码 charset`、`需要安卓宿主环境`、`缺目录规则`） | 保留；每条在上表「环境不适用」或子系统文档里有理由 |
| `site-side` | 页面/脚本事实：源脚本 `match()` 取到 null、选择器零命中、返回的不是 JSON | 不计入判据；对面（安卓 Rhino + 同一份页面）同样读不出 |
| `network` | 请求失败/超时/`java.ajax` 打不通 | 不计入判据 |
| `unattributed` | 以上都不匹配 | **必须逐条人判并按判例补锚点**，不许长期非零 |

两条防跑偏的钉子（`tests/content-audit-classify.test.ts`）：① 除运行时文案（`is not a function`、
`Cannot read properties of null` 等 JS/Node 自己的措辞）外，**每条锚点都要求在 `src/` 里真实存在**——
改了抛错文案而忘了改锚点，归因会静默把本仓缺口读成别的成因，那是给自己放水；② 五种真实消息各钉一栏。

复算：`DSH_CONTENT_AUDIT=1 pnpm vitest run tests/content-audit.test.ts`，读控制台
`引擎类归因…` / `residual…` 两行，或报告 JSON 的 `attribution` 与 `residualItems`。

**读数与复算纪律（历批读数的家是门控报告与矩阵行 note，本文只留口径）**：每轮的 `ok` / `residual` 跨批不可比——网络方差是聚合涨落的主体，**按源比对相邻两批才是硬规矩**，聚合数不作收益或回归的证据。每条「回退」都要逐源核实是代码还是网络方差（判例：js 段文本插值曾把 `${$.bookid}` 当单括号内嵌 JSONPath 撕走 → 目录 0 章；收窄到只认双花括号后回到 `ok`，边界住矩阵 `a-make-up-rule-in-js`）。

| 源 | 失败 | 性质 |
| --- | --- | --- |
| 万象书城 / 夜伴书屋 等 | `kind: "0"`、`imageStyle: "0"`（无 `@` 的单段） | **对面取空 vs 本仓解析期抛**（矩阵 `a-bare-index-segment`）。对面走 `AnalyzeByJSoup.getStringList` ⇒ `getResultList`：按 `@` 切完只剩一段时**不做任何选择**，直接 `getResultLast([上下文元素], 整串)` → `else -> attr(整串)` → 空。所以「对面读得出」在这里也是空字段，不是值；本仓在解析期抛是同一族的刻意严格。**订正**：本条一度被记成「对面 `getElementsSingle` 的 children 索引 = 真取值路径」——那是**列表**路径（`getElements`），取值路径不经过它；两侧别混。 |
| ~~乐文小说~~ | ~~`[toc#段2] 无法识别的段类型（规则片段: "text下一页"）`~~ | **已消解（2026-09-22），当时判错了性质**。原以为这是「对面静默取空 vs 本仓解析期抛」的刻意分歧、要人为它放宽「宁炸不猜」；查对面 `ElementsSingle.getElementsSingle` 后知道 `text下一页` 在对面**根本不是认不出**——else 分支 `temp.select(beforeRule)` 把它当 tag 选择器（命中 0 是文档的事）。本仓于是把它在解析期定性成 css 段（边界见 `a-unknown-segment-throws`），该源直接解析通过，`a-lazy-branch-parse` 的实证案例归零。留这一行是为了记住：**"对面静默 vs 我们抛"要先证对面确实静默，别把对面没做的事当成对面的裁决**。 |

顺带记下一条**不是缺口**的读数：同族写法在对面走 `getResultLast` 的 `else -> attr(整串)` 取空，而对面 `getSearchItem` 对 kind/wordCount/lastChapter/intro/coverUrl 逐字段 try/catch 吞掉（`name`/`author`/`bookUrl` 不吞）——所以对面「读得出」的一部分其实是**空字段**不是值，这也是本仓的抛错在真机上显得比对面严格的原因。

**历批审计的两处收口（2026-09-22 前后；逐轮读数住门控报告与矩阵行 note，本文只留结论）**：① 搜索面「列表零命中 → 按详情页解析」的回落遇到 init 取空时，曾把一次正常的「没搜到东西」升级成整源搜索错误——嗅探路径显式传 `onEmptyInit: 'no-book'`（详情面 `getDetail` 的「宁炸不猜」一字不动）后该源回 `ok`；② 灯读文学那条既存 host-gap（`java.ajax(result)` 拿到上一段 JSONPath 的**单元素数组** → `template.replace is not a function`）由桥侧统一 `String(值)` 收口（`null`/`undefined` 点名参数为空，不拼成 `"null"` 去打站点）。两条收口都只 claim「**引擎侧无回归**」——`residual` 回到原值、`UnsupportedRuleError` 计数一字未动。搜索面门（`DSH_REPROBE=1`）只出分布不点名，规则类失败要逐条甄别得走审计报告那一侧；各批 verified 率与历史**不可比**（不同批源集、不同网络条件）。

**历批登记（第 20 ~ 22 批，2026-09-22；逐轮读数与门况住门控报告，本文只留结论与指针）**：

- **字符串化的规则容器**（矩阵 `c-stringified-rule-objects`）：对面给每个 rule 对象都写了 `JsonDeserializer`、字符串分支再 parse 一次，本仓此前对非对象容器 `continue` ⇒ 整块规则丢失（表现成「缺规则」，像源坏了）。现库 0 源命中，但它是**格式本身**的一条支持写法，故实现——「格式支持即实现」的样板判例。
- **摘要 / HMAC 族**（矩阵 `h-digest-hmac-family`）：`digestHex`/`digestBase64Str`/`HMacHex`/`HMacBase64` 接入协议表——**data 在前、算法在后**、JCA 算法名走显式映射（认不出即点名，不静默退成 md5）；期望值由 openssl 独立算出并与 RFC 4231 公开值对上（node crypto 就是实现本身，自证无效）。另两项**按证据不做并记开口**：非对称签名族（现量 0；自签自验的测试证明不了与安卓 KeyStore 一致——做错比不做更糟）、jsoup 活节点导航面（架构级：本仓条目是脱离文档的 outerHTML 片段，见矩阵 `h-jsoup-live-node-navigation`）。
- **书目字段面**：`ruleSearch.kind`/`wordCount` 与 `ruleBookInfo.kind`/`wordCount` 按**对面语义**（不是字段名）接入，口径见 `docs/design/services.md` §7；顺带纠两条登记错——`ruleSearch.updateTime` 对面根本没有消费点（全仓 grep `bookListRule.` 恰九项）、`e-word-count-format` 原判「不适用：对面亦只在 UI 格式化」是没核消费层的错判，已转 implemented。
- **字段到货率（这一节最该留的教训）**：审计加了一行「声明源里真取到值的比例」——失败分桶看不见被吞成 null 的字段，「接进了链路」与「值到了」是两件事。首跑 **0/82 源**，原因不在解析而在 `rules` 是**导入时派生落盘**、老库根本没这四个键；补 `SourceRegistry.load` 第九条迁移（按 raw 补推、只填缺席键）后 69/79。**每一次接字段都按这条走：normalize 的映射 + load 的补推是一件事的两半，只做前半对存量无效**（钉子 `tests/services/sources.test.ts`「存量 rules 缺 kind/wordCount 四键」）。**读数局限**：`residual = 0` 只说「本轮真跑到的链路里没有已归因到本仓的缺口」——不覆盖被吞成 null 的字段、不覆盖因网络侧没走到的段，也不证明取到的**值**与对面相同（值等价仍无机器口径）。

**换分母（第 23 批，2026-09-22；结论写成一条纪律：分母要换着跑）**：目标口径是「**对面**能解析的我们也得能解析」，而本机这批源不是对面的全集——只打自己那 214 条，一条本库从未出现过的写法就永远露不出来。取两份**独立**公开合集（共 67 源）灌进同一扇门（`DSH_PARSE_CENSUS_FILE`，取法见 `README.md`「解析面普查」节；第三方数据不入库，但**取法入库**，否则分母又是一份会蒸发的文件）：

- 规则语法面：**未在册新形态仍为 0**（1412 条规则串全过 `parseRule`）——「未知形态 = 0」的成色从「这批源没试过」升到「另一批来源不同的源也没试出来」。
- js 桥面：捞出**四条本库从未用过的对面方法**——`java.post`（**已实现**，矩阵 `h-java-post`：对面返回 Jsoup `Connection.Response` **对象**，脚本写 `res.body()`/`res.cookies()`，故方法壳包在 BOOTSTRAP 内、跨桥只走 JSON 数据，出站仍走同一个守门 fetcher 不开第二出口）与三条按证据入册的待办：矩阵行 `h-java-t2s`（要繁简词典且对面还跑自家 `fixT2sDict` → 换轮子得到的文本不逐字相等，要拍板）、`h-java-cache-file`（既有「真实文件 API 不适用」裁决**第一次拿到真需求方**）、矩阵行 `h-java-tourl`（等看清那 1 源调了哪些成员再造壳）。
- **这几个数全是那批 67 源的读数**：本机现库（214 源，2026-09-28 按调用名重测）四条全部 **0 处 / 0 源**——本库读数 0 只是「这批源没踩到」，不是「适配完了」。

**搜索面门的读数口径（第 24 批，2026-09-22 起沿用）**：`导入失败 40` **不是坏源**——入库闸把非文本源挡在门外，与下面「需求量读数」表 40/214 非文本那行同源，按参与集算才是有效率；改动落在导入 / 请求头这类不进正文链路面时，`DSH_CONTENT_AUDIT` 不必重跑。

## 需求量读数（用来排**实现顺序**，不用来判**做不做**）
**排序判据（2026-09-22 换口径）**：兼容目标是「legado 书源格式在本仓可用」，所以分母是对面仓的
能力面，不是本机这一批源。由此：
- **对面解析器认这种写法 → 就要实现**，本库有没有源在用只决定它排第几，不决定它做不做。
  「现库 0 源」从「不做」的理由降级为「排到队尾」——反例是现成的：`c-stringified-rule-objects`
  本库 0/214 命中，仍然实现了，因为它是格式本身的一条被支持写法。
- **例外是运行时机制而不是格式**：`enabledCookieJar`（要 CookieStore）、`concurrentRate`（要限速器）、
  `loginCheckJs` / `loginUi`（要登录面）——这些没有「格式支持」这回事，按机制有没有需求方单独裁。
- 读数会随用户增删源漂走（本轮实测：同一批判据文档写 158 源，现库 214）。**引用前先重数**，
  且**按 `raw`（原始书源 JSON）数**：导入会改名字段（`lastChapter` → `ruleLastChapter` /
  `ruleDetailLastChapter`）并只保留白名单键，按规范化后的顶层键数会系统性量成 0。

**第 25 批（2026-09-28，214 源，按 raw 重数）：重跑下表**。库文件自 2026-09-22 起未再动（214 源、raw 逐字节相同），
故**每一行的现量都原样复现**——没有分母漂，读数变了的地方都是判据写得不清。两处旧读数没写判据，这次写实
（不写清，下一个人重数时必然量出另一个数）：「explore 整块」旧读 168 只数了 `exploreUrl`，把仅 `ruleExplore`
非空的那 4 源（经致文学 / 多看阅读 / 咪咕阅读 / 乡土小说）算进去是 172；「`<a,b,c>` 页码形态」旧读 5 是只数
explore 面的口径，按 URL 位用真入口数（`searchUrl` 4 + `exploreUrl` 5）是 9。形态行的口径逐条写实：
字段行走 `deriveRuleField`（**导入侧同一份展平**，平铺 / 对象容器 / Native 三种方言都认，故按规范化后的顶层键
数才会系统性量成 0）；子字段行与 `ruleExplore` 行走 `normalizeSource` 的 warning（字符串化容器照解析）；
页码形态走 `expandPageAngleList` 且**只打在 URL 位**——服务半就是这么调它的，把 URL 展开器打到 js 串上会数出
98 源，那是判据错不是需求涨（单 token 的 `<x>` 也算匹配，但不构成页码表）；`retry` 行走 `URL_OPTION_SPLIT`
切出的选项对象键。顺带把 17 个取值字段的 2506 条规则串过了一遍 `parseRule`：只有 3 条抛错，全是
`kind: "0"` 这类无 `@` 单索引段（已在「不适用」表裁决），没有新形态冒出来。

下表各行为第 22 批（2026-09-22，按 raw 重数）排出的顺序，第 25 批逐行复现：

**这张表和矩阵行是同一个量的两份抄本，所以它有一道机器守卫**（2026-09-28）：表里某行只要用反引号
点了某条**已进 `ROW_DEMAND`** 的矩阵行，它「现量」列开头那组加粗主读数就必须能从那条行的绑定读数里
凑出来（单个或若干之和，`172 = 168 + 4` 这种整块口径合法），否则 `tests/legado-coverage/coverage.test.ts`
红并点名。今天对账 10 行；唯一靠**行内写明「不等价」**豁免的是页码形态那一行（表按字段位 9 处、矩阵按源 8 源）
——豁免声明住在行里，测试里没有豁免表。没点名的行不归它管（`142`、`41` 那类没有复数入口的读数，本条判据也无从重算）。
**改这张表的数之前先想清楚：要么改数，要么改那行点名的矩阵行，两份抄本不许各自漂。**

| 能力（对面字段 / 形态） | 现量 | 结论 |
| --- | --- | --- |
| `exploreUrl` + `ruleExplore` 整块 | **172**（`exploreUrl` 非空 168，另 4 源只带 `ruleExplore`） | 在册最大缺口（矩阵 `c-explore-url`）：读入但零消费者。发现面是新增功能面，要的是门面 + UI 入口 |
| `ruleBookInfo.lastChapter`（详情面最新章节） | **142** 非空（另有搜索面 `ruleSearch.lastChapter` 110） | **已实现**（`bridge.ts` 取 `ruleDetailLastChapter ?? ruleLastChapter`）。它此前在矩阵里**没有归属行**——两行只用中文写「最新章节」，字段门读不到，故把对面字段名写进那两行的 capability（这条不是代码缺口，是登记漏项，由 `upstream-fields.test.ts` 抓出） |
| `ruleSearch.kind` / `wordCount`、`ruleBookInfo.kind` / `wordCount` | **150 / 42 / 164 / 55**（kind 两面都带的 121 源、只详情面 43、只搜索面 29） | **已实现**（矩阵 `c-rule-search-subfields` / `e-word-count-format` / `e-aux-field-error-isolation`），且**语义按对面而不是按字段名**：kind 是 `getStringList().joinToString(",")` 的多值逗号串、wordCount 在解析层就过 `wordCountFormat`、两字段的读取异常对面吞成空字段（口径与反例见 `docs/design/services.md` §7）。顺带纠一处照抄字段表的错：`ruleSearch.updateTime` **对面没有消费点**（全仓 grep `bookListRule.` 恰九项），它过去被写成本仓欠的一项 |
| `{{page}}` 搜索翻页 | **94** | 真缺口（`d-search-paging`），且是**格式 + 门面 + UI** 三件一起的活：每源一页只搜一次是产品形状问题 |
| `enabledCookieJar === true` | **105** | 运行时机制（矩阵 `b-cookie-jar`，三档读数与对面三层接线都住那一行）：105 源**声明**，但全链路审计的失败签名里 0 条可归因到 cookie → 不预先造 CookieStore。出现「先要一次访问才给正文」的源时按那条源补 |
| `concurrentRate` 带值 | **17** | 运行时机制（限速器），`b-concurrent-rate` 排队 |
| `bookUrlPattern` 带值 | **41** | 已实现（`c-book-url-pattern` / `d-empty-list-info-item`），本批从 27 涨到 41 是分母漂了不是格式变了 |
| `ruleContent.title` 非空 | **10** | 缺口在册（`c-content-title`）：卡的是本仓门面返回形状与 wire 契约，不是解析 |
| `ruleContent.subContent` 非空 | **1** | 缺口在册（`c-content-sub-content`），量小但属格式面 |
| `<a,b,c>` URL 页码形态 | **9**（`searchUrl` 4 + `exploreUrl` 5；real entry 只打 URL 位） | **已实现**（`b-page-angle-list`，2026-09-22）：`expandPageAngleList` 照抄 `AnalyzeUrl` 的 page 段——越界取末项、page 不参与则整段不动。旧读 5 只数了 explore 面；**本行这一列按字段位算（9 处）**，而按源去重的主判据与复数入口住矩阵行 `b-page-angle-list`（普查面 D 键 `pageAngleListUrl`，2026-09-28 现算 8 源）——两个宽度不等价，不许互抄；searchUrl 那 4 源是真在跑的链路，exploreUrl 那 5 源随 explore 面（上一行）一起还没消费者 |
| `ruleContent.callBackJs` 非空 | **0** | 排队尾，但**已在册**（新行 `g-callback-js`）：导入时点名提示，不静默丢 |
| `retry` URL 选项 | **0** | 保持开口（`b-opt-retry`），理由同上：排到队尾而不是判死 |
| 字符串化 rule 容器 | **0** | 仍实现（`c-stringified-rule-objects`），这是「格式支持即实现」的样板判例 |
| `ruleReview` / `avatarRule` 等段评字段 | **0** | 整块裁决不接（见下表「不适用：评论与段评面」），8 个字段在字段门里逐条挂到 `j-review` |
| jsoup 活节点导航（`.parent()` / `.children()` / `nextElementSibling`） | **0**（第 21 批按「1 源实证」记的是一条特定源脚本的取巧写法，不是这个正则命中） | 架构级差异在册（`h-jsoup-live-node-navigation`）：本仓条目是脱离文档的 outerHTML 片段 |

这张表同时也是给下一批的**排序说明**：「对面有、我们没有」的能力一律排队，只是排前面排后面的区别；
把「声明了字段」和「造成过一次失败」分开看（前者查 raw，后者查审计签名）。
## 环境不适用的面（逐条给理由）

| 锚点 | legado 侧能力 | 为什么不适用（不是怎么做不出来） |
| --- | --- | --- |
| `不适用：仅文本源` | `bookSourceType` 1 音频 / 2 图片 / 3 文件（含漫画阅读器、下载、`downloadUrls`、`imageStyle`、图片地址带请求参数） | 本插件的产物是「连续滚动的文字阅读」+ 给 agent 的文本工具。对面这三类各有独立读源与 UI。入库闸把它们挡在门外（`normalize` 产 missing 拒绝入库），而不是读不懂就当文本——误标 text 的漫画源会成片污染聚合搜索与书架（书架诊断实证）。 |
| `不适用：评论与段评面` | `ruleReview` / `reviewUrl` / `ruleContent.title` 落段评图标 `reviewImg` | 参考实现侧就是 dead：`BookSource.Converters` 把 `ruleReview` 序列化成 `"null"`，全仓无读取点。本机 **214** 源带值数为 0（2026-09-28 按 raw 重数；此处原写 158，那是第 15–21 批的分母）。对面活着的段评走另一套 `BookChapterReview` 表，属 App 功能而非书源格式。 |
| `不适用：RSS 订阅源面` | `RssSource` 及其 `ruleArticles`/`contentWhitelist` 等 | 复用同一套规则引擎的**另一种源实体**与本插件无关的 UI 栈。本仓的 `Facet` 里没有 rss，也不打算加。 |
| `不适用：书籍类型位标志体系` | `BookType`（text/audio/image/webFile/local/archive/notShelf/video 位标志）与 `book.config.fixedType` | 本仓用单值 `type ∈ {text,audio,image,file,unknown}` + `participates` 谓词承担同一职责（唯一判定在 `reading.ts`）。位标志组合在本插件里没有消费方；扩媒介时只扩那一处谓词。 |
| `不适用：respondTime 排序轴` | 书源检查失败时把 `respondTime` 人为放大以沉底、按响应时间排序 | 本仓排序是导入序 + 「坏源/未验证」经待办收件箱置顶（`client/source-inbox.ts`）。对面该字段只在排序与书源检查里用，不影响抓取。 |
| `不适用：编辑器侧规则补全` | `RuleComplete.autoComplete`（编辑器给 `@text/@href` 补全、`img` 的 `@alt` 修正） | 运行期无语义。本仓尚无规则编辑器（见矩阵 `k-edit-source` 开口）。 |
| `不适用：2.x 旧格式迁移` | `ImportOldData.toNewRule`（`#re#`→`##re##`、`|`→`||`、`&`→`&&`、`ruleFindUrl`→`exploreUrl`…） | 一次性升级工具。本仓导入即 3.x 格式，无 2.x 库存；遇到再按那批源实现，不预先建映射表。 |
| `不适用：源级代理路由` | `header` 里的 `proxy` 伪键（socks5 / 带账号的 http） | 本仓代理是进程级判定（config > env > Windows 系统代理 > 直连，`services/proxy.ts`），出站口只有守门 fetcher 一处。源级代理等于把网络出口分散到不可审的粒度。 |
| `不适用：变量不落盘与大小分流` | 变量按 10000 字符分流到 `Book` 表（`putBigVariable`） | 本仓 `ctx.vars` 是单次门面调用内的进程内表，不落盘，故无「大变量」问题。见 `docs/design/services.md` 已知开口的作用域条。 |
| `不适用：真实文件与压缩包 API` | `java.cacheFile/getFile/readFile/unzipFile/getZipString/getTxtInFolder/importScript` | 书源脚本可读任意本地路径 = 数据外泄面。本仓只给 `downloadFile` → 不透明令牌 → `readTxtFile` 的进程内暂存表。 |
| `不适用：Android 与 App 宿主能力` | `java.webView`、`android.*`、`org.*`（非 jsoup 部分）、`startBrowserAwait`、`getVerificationCode`、`toast/copyText/openUrl`、`java.androidId` | 无安卓宿主：一律如实抛「需要安卓宿主环境」；纯 UI 副作用（toast/copyText/startBrowser/open/openUrl）明确 no-op——静默 no-op 会让脚本以为成功，但这类方法对面本就无返回值。`androidId` 抛错而不是造随机值：脚本常拿它当签名/密钥参数，造出来的值会让本仓产出**与对面不同但看着合法**的结果，比失败更坏。（`openUrl` 曾只挂了 `open` 没挂这个名字，普查第 22 批抓到并补上——裁决与挂载面不一致时，以裁决为准。） |
| `不适用：字体反混淆` | `queryTTF`/`queryBase64TTF`/`replaceFont` | 依赖 App 的字体下载与渲染栈；现库 **214** 源带此调用为 0（2026-09-28 按 raw 重数；原写「41 源」，那是更早一批的分母，2026-09-22 那批 158 源亦为 0）。出现时按那一源评估（需自解 TTF `cmap`）。 |
| `不适用：加密/签名的加密侧` | `createAsymmetricCrypto`、`createSign`、`encryptStr` | 本仓只实现正文**解密**形态（`aesBase64DecodeToString` + `Packages.javax.crypto` 的 Cipher/Mac）。加密与签名在书源里服务于「造请求」，现库 **214** 源 0 源使用（2026-09-28 按 raw 重数；原写「41 源」是更早一批的分母）；抛错点名，不返回假数据。**摘要与 HMAC 族不在本行**：`digestHex`/`digestBase64Str`/`HMacHex`/`HMacBase64` 已接进协议表（矩阵 `h-digest-hmac-family`），原先把它们并列在这里是 2026-09-22 那批的过期读数——由 `coverage.test.ts` 的「协议表已挂载的宿主方法不得同时被列成「不适用」（裁决表不许留下过期缺席项）」一挡钉住。 |
| `不适用：jsLib 里的字符串代码生成` | Rhino 允许 `eval` / `new Function` | 沙箱逃逸防御的硬边界（`codeGeneration` 关闭）。这是**明确不支持**而不是降级——**现量按 raw 重数（2026-09-28）**：任意字符串（含 `jsLib` 与各 `@js:` 段）里出现 `eval(`/`new Function(` 的源 **10/214**（名单以漫画类非文本源为主，那批本就不参搜），`jsLib` 字段内 **0/5**（带非空 jsLib 的源共 5 个）。旧读数写「现库 41 源里 4 源」，两个判据都复现不出来（41 也不是本库任何一处的现量），故按上面写实；这些源读不出是安全边界的代价。 |
| `不适用：缓存 TTL 与磁盘层级` | `CacheManager` 带 TTL 的内存+磁盘两级 | 本仓 `cache` 垫片是按源隔离的进程内键值表（内存/磁盘两层级在此不存在，别名只为脚本调用名而在）。文件缓存另有其人：`PageCache` + 规则代际。 |
| `不适用：目录整本倒序轴` | `getReverseToc()` + 目录阶段两次 `reverse()` | 本仓「倒序」需求由链首 `-` 前缀表达；没有整本倒序阅读开关。 |
| `不适用：重读与换源校验键` | `checkKey`（参考实现侧 grep 无匹配）、`canReRead`、`addUrlRule`、`disableCache`、`respondBody`、`toasts`、`getHttp`、`snippet` | **对面自己就没有**（参考实现盘点逐条 grep 确认）。列在这里是为了防止以后把「对面没有」当成「我们该补」。 |
| `不适用：XPath 子集外的轴与函数` | `ancestor` / `descendant-or-self` / `namespace` 轴，`count` / `sum` 等函数 | 子集边界由 274 条真实规则实测划出（口径在 `docs/design/engine.md`），越界一律解析期抛错而不是猜。本仓求值器只有**上下文节点**，绝对轴与聚合函数不是「还没写」，是没有可对应的语义。 |
| `不适用：无 @ 单索引段（对面取空）` | 无 `@` 的单段（`kind: "0"` 这类） | 对面按 `@` 切完只剩一段时**不做任何选择**，直接 `attr(整串)` → 空；本仓解析期抛同一族的「无法识别的段类型」。两侧读者都拿不到值，差别只在「静默空」与「点名抛」——本仓选后者。证据与订正史见本文上面的失败归因表（裸索引段那条）。 |
| `不适用：data: URI 直接解字节` | URL 是 `data:…;base64,…` 时当**文本页**响应体解码 | **裁决面（2026-09-23 收窄，本行原先写「没有这条路径」，实测不成立）**：二进制通道能把 data URI 直接解出字节（`engineFetchRaw`，`java.downloadFile` 走的同一条守门口）；缺的只是「把它当**文本页**响应体」这一路——规则拿到的不是可解析的页面。对面是在取字节那条路上处理它的，两侧不同形。本机库 0 源依赖。 |
| `不适用：dnsIp / serverID 自定义解析` | `dnsIp` / `serverID` 选项绕过系统解析 | 属 Android/OkHttp 侧能力，Node undici 没有对应机制。键名已进「未知选项键」的 warn 点名，不静默吞。 |
| `不适用：canReName 改名轴` | `ruleBookInfo.canReName`（**presence 开关**，不是真值判定） | 本仓书架是「加书即一次快照 + 实时投影」，没有「书源能否改名」这条轴；**5 源带值**（2026-09-28 按 raw 重数；旧写 3 源——分母漂）。**对面语义已对读源码坐实（2026-09-28，`model/webBook/BookInfo.kt`）**：`val mCanReName = canReName && !infoRule.canReName.isNullOrBlank()` —— 该字段只看**是否非空白**，值内容一律不参与判断（所以字符串 `"1"`×4 与 `"true"`×1 完全同义），布尔的另一半来自**调用方**（详情页手动刷新传 true，静默更新路径传 false）。本行原先那半句「对面怎么把它折成布尔没有仓内证据、本机 checkout 不在场」**两条都已失效**：`data/entities/rule/BookInfoRule.kt` 与 `model/webBook/BookInfo.kt` 都在快照路径集里，本轮就是从开发阶段的对面 checkout 读到实现的（对读当天快照还停在 `21208775…`，同日已刷到本机 checkout 的 `4285f7f1f`——见 `b-concurrent-rate` 行与本文件「快照刷新」那条）。裁决不变（本仓不读这个键）。 |
| `不适用：fork 专属的首页与漫画模块面` | `relatedBooks` / `homepageModules` / `customButton` / `eventListener` | 这是参考实现的 fork 新增模块面，不属于 legado 通用书源格式——判据是「对面通用格式」，不是「那个 fork 里有什么」。 |
| `不适用：书籍更新检测（preUpdateJs）` | `ruleToc.preUpdateJs`（更新前脚本，含 `reGetBook` / `refreshTocUrl`） | 本仓没有「书籍更新检测」链路（书架不做版本比对、无追更），该脚本只在追更时开火；本机库 0 源带值。 |
| `不适用：字典取词与纠错（DictRule）` | `DictRule` 取词 / 纠错替换 | 属阅读器附加功能（取词翻译），不影响书源可读性；本库无对应诉求。这一条不是「还没做」，而是不属书源格式。 |
| `不适用：划线高亮与书签（阅读器 UI 面）` | `HighlightRule` / `BookMarking` | 阅读器 UI 面（同一 fork 新增），与书源格式无关；本仓阅读器不承载批注数据。 |
