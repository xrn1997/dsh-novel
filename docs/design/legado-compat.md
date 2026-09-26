# legado 兼容面：不适用清单与判据

这份文档只做一件事：**把「legado 有、本插件刻意不接」的能力面写清理由**。它和
`tests/legado-coverage/matrix.ts` 是一对——矩阵里每行 `not-applicable` 都必须指向本文（或子系统
设计文档）里一个真实存在的锚点措辞，机器守卫 `tests/legado-coverage/coverage.test.ts` 逐行验。

**判据①的「每条语义都有归属」现在有三层在册的机器检查**：
① 归属映射（`tests/legado-coverage/inventory-coverage.test.ts`）——31 个能力单元（`UNITS`，
**在册数据本身**：有 `###` 小节的组用小节号 A1…F2，只有 `##` 一级的组用整组 E/G/H/I/J/K；`## L`
是结论不是能力）每个都要挂到 ≥2 条真实存在的矩阵行，行被改名或删除即刻报红；
② 对面字段面（`tests/legado-coverage/upstream-fields.test.ts`）——**现读对面**
`data/entities/rule/*.kt` 的字段集合，每个字段都要有归属：矩阵行的文本提到它（容忍本仓换名，
如 `lastChapter` → `ruleLastChapter`），或在 `FIELD_OWNERSHIP` 里点名它挂哪条整块裁决行并给理由；
对面新增字段 / 本仓漏登记 → 红，登记了但对面已无此字段（僵尸）→ 也红；
③ 引用活性（`tests/legado-coverage/citation-liveness.test.ts`）——仓内每个指向别处的引用都能被读者
现查：**外部出处只许出现在四处**（`README.md` / 本仓覆盖矩阵 / 本文件 / 快照刷新工具），其余地方
只讲本仓口径与理由、不点对面文件与符号；对面 `.kt` 必须是**带目录的相对路径**且能在**仓内快照**
的路径集里现查、任何引用不许带行号、`.superpowers/` 只许是登记过的工具输出目录。快照不在场即红
（它是入库内容，谁 clone 都拿得到；外部 checkout 只是开发阶段刷新快照时的输入）。

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

**读数（2026-09-21 第 15 批，158 源全量，报告 `attribution` 字段；本节的「最新」是第 19 批，写在下面）**：`ok=95`
（起点第 6 批的 75 → 83 → 90 → 92 → 94 → 95），引擎类失败 15 条 = `site-side 7` + `guard 5`
+ `network 2` + **`host-gap 1`**，`unattributed 0`，**residual = 1**。
第 12 批时的两条 host-gap 之一已消（耽美小说 `/text()`：本仓自造的「链尾 `(…)` 当 js」形态，
对面从不切它、全库需要该形态的源为 0，见矩阵 `a-no-tail-js-split`；移除后该源变成
`toc | 目录 0 章`＝EmptyToc，非引擎类——它的规则在这份页面上确实取不到章节）。
**按源比对相邻两批是硬规矩**：第 14 批（补 `makeUpRule` 在 js 段文本插值）里
米读小说 / 全免小说 从 `toc` 404 直接到 `ok`，同时暴露一条**真回退**——
中文书城 的 `ruleToc.chapterList` 里 `${$.bookid}` 是 JS 模板字面量，被当成单括号内嵌
JSONPath 撕走 → 目录 0 章。第 15 批把 js 文本的插值收窄到只认双花括号（矩阵
`a-make-up-rule-in-js` 记着这条边界），该源回到 `ok`。同一批里另有 2 条「回退」经核实是
网络方差（章节 404 / 搜索超时），不是代码。

| 源 | 失败 | 性质 |
| --- | --- | --- |
| 万象书城 / 夜伴书屋 等 | `kind: "0"`、`imageStyle: "0"`（无 `@` 的单段） | **对面取空 vs 本仓解析期抛**（矩阵 `a-bare-index-segment`）。对面走 `AnalyzeByJSoup.getStringList` ⇒ `getResultList`：按 `@` 切完只剩一段时**不做任何选择**，直接 `getResultLast([上下文元素], 整串)` → `else -> attr(整串)` → 空。所以「对面读得出」在这里也是空字段，不是值；本仓在解析期抛是同一族的刻意严格。**订正**：本条一度被记成「对面 `getElementsSingle` 的 children 索引 = 真取值路径」——那是**列表**路径（`getElements`），取值路径不经过它；两侧别混。 |
| ~~乐文小说~~ | ~~`[toc#段2] 无法识别的段类型（规则片段: "text下一页"）`~~ | **已消解（2026-09-22），当时判错了性质**。原以为这是「对面静默取空 vs 本仓解析期抛」的刻意分歧、要人为它放宽「宁炸不猜」；查对面 `ElementsSingle.getElementsSingle` 后知道 `text下一页` 在对面**根本不是认不出**——else 分支 `temp.select(beforeRule)` 把它当 tag 选择器（命中 0 是文档的事）。本仓于是把它在解析期定性成 css 段（边界见 `a-unknown-segment-throws`），该源直接解析通过，`a-lazy-branch-parse` 的实证案例归零。留这一行是为了记住：**"对面静默 vs 我们抛"要先证对面确实静默，别把对面没做的事当成对面的裁决**。 |

顺带记下一条**不是缺口**的读数：同族写法在对面走 `getResultLast` 的 `else -> attr(整串)` 取空，
而 `BookList.getSearchItem` 对 kind/wordCount/lastChapter/intro/coverUrl 逐字段 try/catch 吞掉
（`name`/`author`/`bookUrl` 不吞）——所以对面「读得出」的一部分其实是**空字段**，不是值。
这也是为什么本仓的抛错在真机上会显得比对面严格。

**第 19 批（2026-09-22，`bookUrlPattern` 嗅探 + 嗅探路径的两处收口）**：`ok=94`、引擎类 16 条 =
`site-side 9` + `guard 4` + `network 3` + **`host-gap 1`**，`unattributed 0`，**residual = 1**（仍是上面那条待拍板）。
本批的真机账要分两次跑才看得清——**第一次跑（19a）的 residual=2，其中一条是我自己引入的**：

- **回退（19a，已修）**：搜索面新增的「列表零命中 → 按详情页解析」回落会去跑详情规则，而本仓
  `detailContextOf` 在 init 取空时**抛错**——对面是 `setContent(null)` 之后静默没有书目。结果
  快手趣阁（`ruleSearch.bookList: $.data[*]` 与 `ruleBookInfo.init: $.data` 同源，站点偶发不给 `data`）
  从 `ok` 掉到 `search | 详情初始化规则未取到上下文`。修法：嗅探路径显式传
  `onEmptyInit: 'no-book'`（详情面 `getDetail` 的「宁炸不猜」一字不动）。19b 该源回 `ok`。
- **一条既存 host-gap 被这次改动掀出来**（一并修了）：灯读文学 `ruleBookInfo.init` 的
  `@js:java.ajax(result)` 拿到的是上一段 JSONPath 的**单元素数组**，对面 Rhino 按 `String` 形参
  转换 → 打的是那条 URL；本仓把原值交给 `assembleRequest` → `template.replace is not a function`。
  桥侧统一 `String(值)`（`null`/`undefined` 点名参数为空，不拼成 `"null"` 去打站点）。
  第 18 批里同一条规则先被站点侧的 `charset=uft8` 解码错挡住，所以没露出来。
- **18 → 19b 的净账**：前进 3（`看书 toc→ok`、`连尚读书 search→content-partial`、
  `终极全栖接口聚合 search→ok`——前两条按现证据**归不到本批**：这些源都没有 `bookUrlPattern`，
  也可能只是网络方差）、后退 3（`次元姬子 ok→content-partial` 是站点改了 class 名
  `.chapter_article__vWEkb`，属 site-side；`九九藏书`、`鲤鱼乡` 都是 `TypeError: fetch failed`）。
  **引擎侧无回归**：residual 回到 1，`UnsupportedRuleError` 计数一字未动。

**第 19 批的搜索面门（`DSH_REPROBE=1`，40s，158 源）**：verified **102（64.6%）**，失败分布
`FetchError 49`（网络/代理侧）+ `导入失败 5` + `RuleEvalError 1` + `JsSandboxError 1`——改了搜索面与
探针语义之后，**规则类失败只剩 2 条**，其余全落在网络侧。该门只出分布不点名，这两条要逐条甄别得走
审计报告那一侧。与历史各批的 verified 率**不可比**（不同批源集、不同网络条件——即第 12 条开口里
那条判读局限）。

**第 20 批（2026-09-22，字符串化的规则容器）**：对面给每一个 rule 对象都写了 `JsonDeserializer`，
`isJsonPrimitive` 分支把字符串再 parse 一次；本仓此前对非对象容器 `continue`，这类源导入后整块规则
丢失（表现成「缺规则」，像源坏了）。现量 0/158 用该形态，但它是**格式本身**的一条支持写法
（矩阵 `c-stringified-rule-objects` 转 implemented）。**门况如实**：本批只动导入路径，且现库 0 源命中
（五个容器键里不存在「以 `{` 开头的字符串」，平铺 `ruleContent` 也无一以 `{` 开头），故未重跑两个
真链路门——跑了也不可能产生与本批相关的新读数；`pnpm test` 1333 绿、`pnpm typecheck` 0 错。

**第 21 批（2026-09-22，摘要/HMAC 族 + 两项按证据定性）**：`java.digestHex`/`digestBase64Str`/`HMacHex`/`HMacBase64` 接入协议表（对面 `help/JsEncodeUtils.kt`；**data 在前、算法在后**、JCA 算法名走显式映射表、认不出即点名，不静默退成 md5）。**期望值全部由 openssl 3.5.6 独立算出**（node crypto 就是实现本身，自证无效），其中 HMAC-SHA256/20×0x0b 那条与 RFC 4231 test case 2 的公开值一致。门：`DSH_CONTENT_AUDIT=1` 真跑（158 源）——`ok=94`、引擎类 16 条 = `site-side 8` + `guard 3` + `network 3` + **`host-gap 1`**、`unattributed 0`、**residual 仍 = 1**（与 19b 同一批源、同一条待拍板）。逐源对 19b 有 6 源变动，**三条回退全按错误类定为网络侧**（`爱乐文学` 请求超时、`看书` 与 `终极全栖` 都是 `TypeError: fetch failed`），本批改动是**纯增方法**（0 源在调新名），引擎侧无回归。另两项**按证据不做并记开口**：非对称签名族（0/158，且自签自验的测试证明不了与安卓 KeyStore 一致——做错比不做更糟）、jsoup 活节点导航面（1/158，架构级：本仓条目是脱离文档的 outerHTML 片段，见 `engine.md` 仍开口与矩阵 `h-jsoup-live-node-navigation`）。

**第 22 批（2026-09-22，书目字段面：对面 `bookListRule` 九项消费点收齐）**：接入 `ruleSearch.kind`/`wordCount` 与 `ruleBookInfo.kind`/`wordCount`（现量 150 / 42 / 164 / 55，分母 214），语义按对面而不是按字段名——见 `docs/design/services.md` §7 那四条（kind 是 `getStringList` 的逗号串、wordCount 在解析层过 `wordCountFormat`、两字段的读取异常对面吞成空字段）。**顺带纠两条登记错**：`ruleSearch.updateTime` 对面根本没有消费点（全仓 grep `bookListRule.` 恰九项），它一直被写成本仓欠的一项；`e-word-count-format` 那条「不适用：对面亦只在 UI 格式化」是**没核过消费层**的判定，实为解析层格式化，已转 implemented。

**本批真正的收获是量出来的一件事**：给审计加了一行「**字段到货率**」（`ruleSearch.kind` 声明源里真取到值的比例——失败分桶看不见被吞成 null 的字段，「接进了链路」与「值到了」是两件事）。第一次跑：**0/82 源、0/2941 条**。原因不在解析，而在 `rules` 是**导入时派生落盘**的——老库根本没这四个键。于是补 `SourceRegistry.load` 第九条迁移（按 raw 补推，只填缺席键），同一条读数变成 **69/79 源、2132/2909 条**（wordCount 23/25、312/432）。**这条教训推广到以后每一次接字段**：normalize 的映射 + load 的补推迁移是一件事的两半，只做前半对存量无效（钉子见 `tests/services/sources.test.ts`「存量 rules 缺 kind/wordCount 四键」）。

**门况**：`DSH_CONTENT_AUDIT=1` 真跑（214 源，报告 `report-2026-09-22T05-34-20-005Z.json`）——`ok=69`、引擎类 11 条 = `site-side 5` + `guard 4` + `network 2` + **`host-gap 0`**、`unattributed 0`、**residual = 0**（上一批起 ⑥⑦⑧⑨ 那批收口把最后一条 host-gap 消掉了：乐文小说 `text下一页` 经核在对面**也不是**「认不出」，见上表划掉那一行）。逐源比对相邻两批：前进 8 / 后退 8，**两侧全是 `FetchError`（超时 / `fetch failed`）**，无一条引擎类签名进出；`UnsupportedRuleError` 计数一字未动。**读数局限如实**：residual=0 只说「本轮真跑到的链路里没有已归因到本仓的缺口」——它不覆盖被吞成 null 的字段（正是靠到货率才看见那 82 源）、不覆盖因网络侧没走到的段，也不证明取到的**值**与对面相同（值等价仍无机器口径）。

**第 23 批（2026-09-22，换分母：把普查打到独立公开书源上）**。目标口径是「**对面**能解析的我们也得能解析」，
而本机这批源不是对面的全集——只打自己那 214 条，一条本库从未出现过的写法就永远露不出来。
现取两份**独立**公开合集（`jiwangyihao/source-j-legado` 按站分文件 + `entr0pia/MyLegadoSource` 单文件，共 67 源）
灌进同一个门（`DSH_PARSE_CENSUS_FILE`，取法见 `README.md`「解析面普查」节；第三方数据不入库，但**取法入库**，
否则分母又是一份会蒸发的文件）。第一次跑的产出：

- 规则语法面：**未在册新形态仍为 0**（1412 条规则串全过 `parseRule`）——「未知形态 = 0」这句话的成色从
  「这批源没试过」升到「另一批来源不同的源也没试出来」。
- js 桥面：**四条本库从未用过的对面方法**——`java.post`（9 源 10 处）、`java.t2s`（2 源 33 处）、
  `java.cacheFile`（3 源 5 处）、`java.toURL`（1 源）。`post` 本批**已实现**（矩阵 `h-java-post`：
  对面返回 Jsoup `Connection.Response` **对象**，脚本写 `res.body()`/`res.cookies()`，故方法壳包在
  BOOTSTRAP 内、跨桥只走 JSON 数据；出站仍走同一个守门 fetcher，不开第二出口）。
  另三条按证据入册（`h-java-t2s` 需要繁简词典且对面还跑自家 `fixT2sDict` → 换轮子得到的文本不逐字相等，要拍板；
  `h-java-cache-file` 是既有「真实文件 API 不适用」裁决**第一次拿到真需求方**；`h-java-tourl` 等看清那 1 源调了哪些成员再造壳）。
- 结论写成一条纪律：**分母要换着跑**。本库读数为 0 不是「适配完了」的证据，只是「这批源没踩到」的证据。

**第 24 批（2026-09-22，本轮评审收口后重跑搜索面门）**：`DSH_REPROBE=1` 55s，214 源——verified **159（74.3%）**，失败分布 `导入失败 40` + `FetchError 14` + `RuleEvalError 1`。`导入失败 40` **不是坏源**：入库闸把非文本源挡在门外，与下面「需求量读数」表里 40/214 非文本那行同源；按参与集（文本源 174）算 verified **91.4%**。与本轮改动的关系：本轮唯一落在出站面的改动是请求头合并改成**大小写不敏感**（此前源声明小写 `user-agent` 会与缺省头并存，被 undici 并成 `"默认, 源"` 的畸形 UA——现库 2 源命中），这一趟把它连到真站点上跑过。`DSH_CONTENT_AUDIT` 未重跑：本轮改动落在导入与请求头，正文链路的读法没动，最近一次真机读数是第 23 批。

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

第 22 批（2026-09-22，214 源，按 raw 重数）的读数与结论：

| 能力（对面字段 / 形态） | 现量 | 结论 |
| --- | --- | --- |
| `exploreUrl` + `ruleExplore` 整块 | **168** | 在册最大缺口（矩阵 `c-explore-url`）：读入但零消费者。发现面是新增功能面，要的是门面 + UI 入口 |
| `ruleBookInfo.lastChapter`（详情面最新章节） | **142** 非空（另有搜索面 `ruleSearch.lastChapter` 110） | **已实现**（`bridge.ts` 取 `ruleDetailLastChapter ?? ruleLastChapter`）。它此前在矩阵里**没有归属行**——两行只用中文写「最新章节」，字段门读不到，故把对面字段名写进那两行的 capability（这条不是代码缺口，是登记漏项，由 `upstream-fields.test.ts` 抓出） |
| `ruleSearch.kind` / `wordCount`、`ruleBookInfo.kind` / `wordCount` | **150 / 42 / 164 / 55**（kind 两面都带的 121 源、只详情面 43、只搜索面 29） | **已实现**（矩阵 `c-rule-search-subfields` / `e-word-count-format` / `e-aux-field-error-isolation`），且**语义按对面而不是按字段名**：kind 是 `getStringList().joinToString(",")` 的多值逗号串、wordCount 在解析层就过 `wordCountFormat`、两字段的读取异常对面吞成空字段（口径与反例见 `docs/design/services.md` §7）。顺带纠一处照抄字段表的错：`ruleSearch.updateTime` **对面没有消费点**（全仓 grep `bookListRule.` 恰九项），它过去被写成本仓欠的一项 |
| `{{page}}` 搜索翻页 | **94** | 真缺口（`d-search-paging`），且是**格式 + 门面 + UI** 三件一起的活：每源一页只搜一次是产品形状问题 |
| `enabledCookieJar === true` | **105** | 运行时机制：105 源**声明**，但全链路审计的失败签名里 0 条可归因到 cookie → 不预先造 CookieStore。出现「先要一次访问才给正文」的源时按那条源补 |
| `concurrentRate` 带值 | **17** | 运行时机制（限速器），`b-concurrent-rate` 排队 |
| `bookUrlPattern` 带值 | **41** | 已实现（`c-book-url-pattern` / `d-empty-list-info-item`），本批从 27 涨到 41 是分母漂了不是格式变了 |
| `ruleContent.title` 非空 | **10** | 缺口在册（`c-content-title`）：卡的是本仓门面返回形状与 wire 契约，不是解析 |
| `ruleContent.subContent` 非空 | **1** | 缺口在册（`c-content-sub-content`），量小但属格式面 |
| `<a,b,c>` URL 页码形态 | **5** | **已实现**（`b-page-angle-list`，2026-09-22）：`expandPageAngleList` 照抄 `AnalyzeUrl` 的 page 段——越界取末项、page 不参与则整段不动 |
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
| `不适用：评论与段评面` | `ruleReview` / `reviewUrl` / `ruleContent.title` 落段评图标 `reviewImg` | 参考实现侧就是 dead：`BookSource.Converters` 把 `ruleReview` 序列化成 `"null"`，全仓无读取点。本机 158 源带值数为 0。对面活着的段评走另一套 `BookChapterReview` 表，属 App 功能而非书源格式。 |
| `不适用：RSS 订阅源面` | `RssSource` 及其 `ruleArticles`/`contentWhitelist` 等 | 复用同一套规则引擎的**另一种源实体**与本插件无关的 UI 栈。本仓的 `Facet` 里没有 rss，也不打算加。 |
| `不适用：书籍类型位标志体系` | `BookType`（text/audio/image/webFile/local/archive/notShelf/video 位标志）与 `book.config.fixedType` | 本仓用单值 `type ∈ {text,audio,image,file,unknown}` + `participates` 谓词承担同一职责（唯一判定在 `reading.ts`）。位标志组合在本插件里没有消费方；扩媒介时只扩那一处谓词。 |
| `不适用：respondTime 排序轴` | 书源检查失败时把 `respondTime` 人为放大以沉底、按响应时间排序 | 本仓排序是导入序 + 「坏源/未验证」经待办收件箱置顶（`client/source-inbox.ts`）。对面该字段只在排序与书源检查里用，不影响抓取。 |
| `不适用：编辑器侧规则补全` | `RuleComplete.autoComplete`（编辑器给 `@text/@href` 补全、`img` 的 `@alt` 修正） | 运行期无语义。本仓尚无规则编辑器（见矩阵 `k-edit-source` 开口）。 |
| `不适用：2.x 旧格式迁移` | `ImportOldData.toNewRule`（`#re#`→`##re##`、`|`→`||`、`&`→`&&`、`ruleFindUrl`→`exploreUrl`…） | 一次性升级工具。本仓导入即 3.x 格式，无 2.x 库存；遇到再按那批源实现，不预先建映射表。 |
| `不适用：源级代理路由` | `header` 里的 `proxy` 伪键（socks5 / 带账号的 http） | 本仓代理是进程级判定（config > env > Windows 系统代理 > 直连，`services/proxy.ts`），出站口只有守门 fetcher 一处。源级代理等于把网络出口分散到不可审的粒度。 |
| `不适用：变量不落盘与大小分流` | 变量按 10000 字符分流到 `Book` 表（`putBigVariable`） | 本仓 `ctx.vars` 是单次门面调用内的进程内表，不落盘，故无「大变量」问题。见 `docs/design/services.md` 已知开口的作用域条。 |
| `不适用：真实文件与压缩包 API` | `java.cacheFile/getFile/readFile/unzipFile/getZipString/getTxtInFolder/importScript` | 书源脚本可读任意本地路径 = 数据外泄面。本仓只给 `downloadFile` → 不透明令牌 → `readTxtFile` 的进程内暂存表。 |
| `不适用：Android 与 App 宿主能力` | `java.webView`、`android.*`、`org.*`（非 jsoup 部分）、`startBrowserAwait`、`getVerificationCode`、`toast/copyText/openUrl`、`java.androidId` | 无安卓宿主：一律如实抛「需要安卓宿主环境」；纯 UI 副作用（toast/copyText/startBrowser/open/openUrl）明确 no-op——静默 no-op 会让脚本以为成功，但这类方法对面本就无返回值。`androidId` 抛错而不是造随机值：脚本常拿它当签名/密钥参数，造出来的值会让本仓产出**与对面不同但看着合法**的结果，比失败更坏。（`openUrl` 曾只挂了 `open` 没挂这个名字，普查第 22 批抓到并补上——裁决与挂载面不一致时，以裁决为准。） |
| `不适用：字体反混淆` | `queryTTF`/`queryBase64TTF`/`replaceFont` | 依赖 App 的字体下载与渲染栈；本机 158 源带此调用为 0。出现时按那一源评估（需自解 TTF `cmap`）。 |
| `不适用：加密/签名的加密侧` | `createAsymmetricCrypto`、`createSign`、`digestHex`/`digestBase64Str`、`HMacHex`/`HMacBase64`、`encryptStr` | 本仓只实现正文**解密**形态（`aesBase64DecodeToString` + `Packages.javax.crypto` 的 Cipher/Mac）。加密与签名在书源里服务于「造请求」，本机库 0 源使用；抛错点名，不返回假数据。 |
| `不适用：jsLib 里的字符串代码生成` | Rhino 允许 `eval` / `new Function` | 沙箱逃逸防御的硬边界（`codeGeneration` 关闭）。这是**明确不支持**而不是降级——实测本机 6 源含该形态，它们读不出是安全边界的代价。 |
| `不适用：缓存 TTL 与磁盘层级` | `CacheManager` 带 TTL 的内存+磁盘两级 | 本仓 `cache` 垫片是按源隔离的进程内键值表（内存/磁盘两层级在此不存在，别名只为脚本调用名而在）。文件缓存另有其人：`PageCache` + 规则代际。 |
| `不适用：目录整本倒序轴` | `getReverseToc()` + 目录阶段两次 `reverse()` | 本仓「倒序」需求由链首 `-` 前缀表达；没有整本倒序阅读开关。 |
| `不适用：重读与换源校验键` | `checkKey`（参考实现侧 grep 无匹配）、`canReRead`、`addUrlRule`、`disableCache`、`respondBody`、`toasts`、`getHttp`、`snippet` | **对面自己就没有**（参考实现盘点逐条 grep 确认）。列在这里是为了防止以后把「对面没有」当成「我们该补」。 |
| `不适用：XPath 子集外的轴与函数` | `ancestor` / `descendant-or-self` / `namespace` 轴，`count` / `sum` 等函数 | 子集边界由 274 条真实规则实测划出（口径在 `docs/design/engine.md`），越界一律解析期抛错而不是猜。本仓求值器只有**上下文节点**，绝对轴与聚合函数不是「还没写」，是没有可对应的语义。 |
| `不适用：无 @ 单索引段（对面取空）` | 无 `@` 的单段（`kind: "0"` 这类） | 对面按 `@` 切完只剩一段时**不做任何选择**，直接 `attr(整串)` → 空；本仓解析期抛同一族的「无法识别的段类型」。两侧读者都拿不到值，差别只在「静默空」与「点名抛」——本仓选后者。证据与订正史见本文上面的失败归因表（裸索引段那条）。 |
| `不适用：data: URI 直接解字节` | URL 是 `data:…;base64,…` 时直接解出字节 | 本仓二进制通道只有 `downloadFile` 与 `ctx.fetchRaw`（不透明令牌形态），没有「把 data URI 当响应体」这条路径；本机库 0 源使用。 |
| `不适用：dnsIp / serverID 自定义解析` | `dnsIp` / `serverID` 选项绕过系统解析 | 属 Android/OkHttp 侧能力，Node undici 没有对应机制。键名已进「未知选项键」的 warn 点名，不静默吞。 |
| `不适用：canReName 改名轴` | `ruleBookInfo.canReName`（反直觉真值判定） | 本仓书架是「加书即一次快照 + 实时投影」，没有「书源能否改名」这条轴；3 源带值，无实际影响。 |
| `不适用：fork 专属的首页与漫画模块面` | `relatedBooks` / `homepageModules` / `customButton` / `eventListener` | 这是参考实现的 fork 新增模块面，不属于 legado 通用书源格式——判据是「对面通用格式」，不是「那个 fork 里有什么」。 |
| `不适用：书籍更新检测（preUpdateJs）` | `ruleToc.preUpdateJs`（更新前脚本，含 `reGetBook` / `refreshTocUrl`） | 本仓没有「书籍更新检测」链路（书架不做版本比对、无追更），该脚本只在追更时开火；本机库 0 源带值。 |
| `不适用：字典取词与纠错（DictRule）` | `DictRule` 取词 / 纠错替换 | 属阅读器附加功能（取词翻译），不影响书源可读性；本库无对应诉求。这一条不是「还没做」，而是不属书源格式。 |
| `不适用：划线高亮与书签（阅读器 UI 面）` | `HighlightRule` / `BookMarking` | 阅读器 UI 面（同一 fork 新增），与书源格式无关；本仓阅读器不承载批注数据。 |
