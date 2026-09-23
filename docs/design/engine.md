# 规则引擎（engine）

本文是引擎的现状真相（single source）；领域词汇见 `CONTEXT.md`——取值链、净化尾、规则文法、面、段、取值规约、方言、搜索面、请求组装一律用那里的词，别自造。

引擎的边界：`src/engine/**` 零 Cordis、零 `@deepseek-ai/*`、零网络——网络只以 `EvalContext.fetch` 注入函数出现。规则串 → 词法（`parseRule`）→ 求值（`evaluate`）→ `EngineValue`。

## 模块地图

| 文件 | 职责 | 关键导出 | owner 语义 |
| --- | --- | --- | --- |
| `engine/types.ts` | 值形状与 AST | `Facet`、`EngineValue`、`Segment`、`Branch`、`ParsedRule`、`EvalContext`、`RuleUsage`、`DEFAULT_JS_TIMEOUT_MS`(2000) | `EngineValue` 五态（miss/value/list/nodes/matches）的唯一定义处。`Facet` 比文档多一个 `explore`（无生产调用方，见「已知开口」）；`EvalContext` 另携 `book`/`chapter`（legado 脚本变量，服务层按面注入） |
| `engine/errors.ts` | 三类引擎错误 | `EngineError`、`UnsupportedRuleError`、`RuleEvalError`(+`hits`)、`JsSandboxError`(+`script`/`line`)、`isEngineError` | 段级定位文案的唯一格式化点：`[facet#段N] msg（规则片段: "raw"）` |
| `engine/parse.ts` | 词法流水线：字符串 → AST（零 IO） | `parseRule(rule, facet='rule', usage='list')`、`isPutOnlyRule`（这条规则是否**只设变量**——服务层用它区分「零命中」与「只设变量」）。单斜杠开头按 XPath 处理是**对面同款**（`SourceRule.init` 的 `ruleStr.startsWith("/")` → `Mode.XPath`，`model/analyzeRule/AnalyzeRule.kt`），不是本仓多做的事；只认 `//` 的那条是 `SourceRule.isRule`（同文件 `private fun isRule`），管的只是 `{{…}}` 内表达式的「规则 vs JS」二分，本仓 `classifyExpr` 与之逐字对齐 | 切分次序、段识别白名单、隐式 CSS 回落、位置后缀、**属性终端**（取值用途链尾未知词 = 属性名，见 CONTEXT.md「取值用途」）、**模板字面段**识别（判据借 `literal.isLiteralForm`；**插值优先于 `/`-XPath 前缀**——斜杠开头且含 `{{}}` 的是 URL 模板，顶点小说 tocUrl 实证）、「不认识就炸」的唯一位置 |
| `engine/grammar.ts` | 规则文法：构词与解析同属一处 | `parseTails`、`appendTail`、`withImplicitText`、`jsRegionEnd`、`putRegionEnd`、`isJsForm`、`splitVarExpr`、`isPureVarExpr` | `##` 净化尾与 JS 区域语法的唯一认知点；`@put:{…}` 区域的边界也在此（体内 `@` 不是段界，legado `splitPutRule` 先剥离口径）；normalize 的方言拼串只能经 `appendTail` |
| `engine/literal.ts` | 模板字面段的识别与切分 | `isLiteralForm`、`splitLiteral`、`LiteralPart` | `{{expr}}`（JS/规则二分——以 `@`/`$.`/`$[`/`//` 开头按规则）与 `{$.path}` 单括号内嵌、`@get:`、`{{}}` 平衡括号切分的唯一认知点（parse 识别与 evaluate 消费共用同一份） |
| `engine/template.ts` | URL 模板插值与页码角度表 | `interpolateUrl(template, vars)`、`expandPageAngleList`、`URL_OPTION_SPLIT` | `{{name||缺省}}` 的替换口（词法拆分借 `grammar.splitVarExpr`）；`<a,b,c>` 按页取值（越界取末项 = 到底）唯一实现，矩阵 `b-page-angle-list` |
| `engine/dom.ts` | cheerio 封装与纯文本契约 | `loadHtml`、`cleanText`、`nodeText`、`htmlToText`、`looksLikeHtml`、`isNodeValue` | 「块级边界落成 `\n`」的正文契约唯一实现（不是 cheerio `.text()`） |
| `engine/select.ts` | default 选择段/取值段 | `reducePicked`、`applyIndex`、`applyExclude`、`evalDefault`、`isGetValueSegment`（链首该用哪个上下文由它裁决） | **取值规约的唯一实现**：`reducePicked` 管取位与空态裁决，`getValue` 管「元素在、取值全空 → 空 List」；`text.<串>` 按文本选元素（CONTEXT.md「按文本选元素」）与属性终端 `mode:'attr'`（空值丢弃 + 去重 + 向下兜底）同属此处 |
| `engine/css.ts` | `@css:` 段 | `evalCss` | 只做 `cur.find(selector)` + 消费 `reducePicked`；显式形态带 `!` 排除，位置后缀仅隐式回落形态携带 |
| `engine/xpath.ts` | XPath 子集求值器 | `evalXPath` | 直接在 domhandler 节点树上求值；轴/谓词/函数白名单与「位置谓词按父分组」都只在这里 |
| `engine/jsonpath.ts` | JSONPath 子集 | `evalJsonPath` | 手写 tokenizer；下标/切片负数从尾数与「取位失败 → Miss、空数组 → 空 List」的 JSONPath 侧口径 |
| `engine/allinone.ts` | AllInOne 整页正则 | `evalAllInOne` | 二维 `matches` 产物（条目×捕获组）唯一产地，永不压平 |
| `engine/variables.ts` | 变量段与 JSON 数据源 | `evalPut`、`evalGetVar`、`resolveJsonData` | `ctx.json` 优先、缺席回退解析 `ctx.html` 的口径 |
| `engine/combine.ts` | 组合符与反序 | `combine`、`reverseList` | `||` / `&&` / `%%` 的语义唯一实现 |
| `engine/replace.ts` | 净化尾求值 | `applyReplaces` | `##pattern##replacement` 与 OnlyOne(`###`) 的唯一执行点 |
| `engine/evaluate.ts` | 总装与 trace | `evaluate`、`evaluateWithTrace`、`TraceStep`、`TraceResult` | 链语义（generator `ruleGen`/`branchGen`）+ 两个驱动器 + 链衔接状态机 |
| `engine/js-sandbox.ts` | `@js` 沙箱 | `evalJs`、`runScript`、`JsHost`、`SourceSession`、`processSession`、`createSourceSession`、`ensureUnhandledGuard` | vm 逃逸防御、超时、日志收集、进程级 unhandledRejection 防线、**`java.ajax` 同步语义的唯一裁决点**（`SYNC_WORKER_RE` 性能启发 + 哨兵 `needsSyncBridge` → worker 透明重跑）、`runAsScript` **编译期** SyntaxError 判别（运行时 SyntaxError 不再静默回落成 Miss；**主线程与 worker 两路同口径**——worker 侧那份是 `WORKER_SRC` 里的文本抄本，跨路 fetch 计数钉子钉住）、BOOTSTRAP 的 `JSON.parse` 对象幂等 wrap、`Packages.*` 包路径仿真（重活走 `__pkg.*` 通道） |
| `engine/js-protocol.ts` | JavaBridge 协议表 | `JAVA_PROTOCOL`、`invokeJavaMethod`、`SANDBOX_MOUNTS`、`JavaBridge`(推导) | 加一个 `java.*` 方法 = 表加一行；BOOTSTRAP 名单/分派/类型面全部派生。含 cache 内存三别名（`putMemory`/`getFromMemory`/`deleteMemory`——本仓 cache 纯内存，别名只为真实源调用名）、`randomUUID`、字节组三方法（`strToBytes`/`hexDecodeToByteArray`/`base64DecodeToByteArray`，字节 = number[] 跨 RPC）、`downloadFile`(async，与 ajax 同款哨兵/worker 同步桥) + `connect`(async，对面 `StrResponse` → `{url, body}`；对面 `runCatching` 把异常塞进 body，本仓失败照旧抛，且非空 header 参数点名不静默丢——见矩阵 `h-java-connect`) + `readTxtFile`（**进程内暂存表，不暴露真实文件系统**——脚本读任意本地路径 = 数据外泄面） |
| `engine/js-utils.ts` | 沙箱宿主纯工具 | `engineValueToString(v, 'inner'\|'outer')`、`engineValueToStrings`、`md5Hex(16)`、`jcaHashName`（digest/HMac 族的 JCA 算法名映射）、`toNumChapter`/`chineseNumToInt`/`stringToInt`、`base64*`、`uriEncode`、`hexDecodeToString`、`fmtTime`、`decodePngToArgb`、`javaEncode/javaDecode/normalizeCharset` | `EngineValue → 单串` 的唯一实现（nodes 两种口径由参数区分）；PNG → ARGB 像素（node:zlib 解 IDAT + 逐行去滤波，隔行/未知滤波宁炸不猜）与 Java charset 别名归一也在此；像素上限由调用方以可选 `maxPixels` 传入，**在 IHDR 处判**（重活之前挡住）。摘要/HMAC 的算法名走 JCA 显式映射（认不出即点名，不静默退成 md5），矩阵 `h-digest-hmac-family` |
| `engine/index.ts` | 公开面（收窄后的全部导出） | `evaluate`、`evaluateWithTrace`、`interpolateUrl`、`expandPageAngleList`、`URL_OPTION_SPLIT`、`isEngineError`、`isPutOnlyRule`、四个错误类、`EngineValue`/`EvalContext`/`Facet`/`RuleUsage` 类型 | 服务半的**唯一**对外承诺；其余 module 深路径直引是实现层耦合，不是承诺 |

服务半 import 引擎分两类：**走 barrel**（`engine/index.ts`，即上表的公开面）与**深路径直引**（实现层耦合）。直引的现状共四处，都是「引擎内部能力被服务半直接消费」：`content.ts`→`dom.js`（html→纯文本）、`normalize.ts`→`grammar.js`（规则尾巴归一）、`search-template.ts`→`js-sandbox.js` 与 `bridge.ts`→`js-sandbox.js`（后两者同一需求：`runScript` 跑 `@js` 规则——搜索模板与 `@js:` 动态头）。这四处**没有**收进 barrel；若认定 `runScript` 属公开面，正确做法是把它加进 barrel 并改这两处 import（`js-protocol.ts` 的 URL 选项分界式走的是另一条路：先放 `template.ts`，再由 barrel 出）。`tests/engine/*` 的深引是测试需要，不是消费点。新增服务消费点前先问「这是引擎公开面吗」——是则加进 barrel，否则说明耦合放错了位置。

## 取值规约（最重要的一条）

**取位失败 → Miss；解析到空集合 → 空 List。**

- 选择段（`default` 的 class/id/tag/child/children 与 `css` 段）：`engine/select.ts` 的 `reducePicked` 把 `exclude` 过滤 → `index` 取位 → 空态裁决串成一处，三种失败态 `zero`/`excluded`/`oob` **一律判「选择失败」→ Miss**（曾有第四态 `sliced`——那是 `.a:b` 被当半开切片的产物，对面没有这种形态，见「legado 取值语义订正」）。
- 取值段（`engine/select.ts` 的 `getValue`）：同样消费 `reducePicked` 做取位；只有「元素在、取值全空」（`texts.length === 0`）才给空 List。`textNodes` 是唯一恒产 List 的取值段（`select.ts` 的 `textNodes` 分支）。
- JSONPath 同口径（`engine/jsonpath.ts` 的 `evalJsonPath`）：零命中/取到 `null`/下标越界/切片裁空 → Miss；**解析到空集合**（`[*]` 与 `[]` 是同一通配的两种写法，打在空数组上）→ 空 List。集合型末段（`[*]`、`[a:b]`、`..name`）哪怕只收一项也恒产 List（`jsonpath.ts` 的 `collection` 判定）。
- **中链 jsonpath 逐项目空态**（`evaluate.ts` 的 `jsonpath` case，「List → 逐项求值合并」分支）：上游是 List 时逐条目按 JSON 求值后**合并**——`miss` 条目不贡献（那是取位失败）；`list` 条目展平合并（空集合贡献零个条目，而不是一个空串条目）；其余（`value`/`matches`/`nodes`）命中即收，**空串也是值**。终局裁决：上游 List 为空 → 空 List（链首已判「解析到空集合」，逐项无物可求，中链不许改口）；非空上游逐条目**全部** `miss` 才是 Miss。链首与中链对同一输入必须给同一种值，否则 `||` 的兜底语义会随链长漂移。
- **模板内嵌段的插值**（`evaluate.ts` 的 `interpolateTemplate`，字面段与 **js 段代码文本**共用这一份）：任一插值段 Miss → 整段 Miss（Miss 折成空串会拼出语法合法的残 URL）；空 List → 空串照常参与拼接。js 段也要插值是因为对面段循环顺序是 `putRule → makeUpRule(result) → 按 mode 分发`——`makeUpRule` 重写的是**规则文本本身**，`@js:` 里的字符串字面量同样被替换（真实源靠它拼 URL；`chapter_list/100/{{$.book_id}}.txt` 一类，全库 158 源 28 源在用。不插值的后果是把字面花括号发上网，真机实证米读小说 toc 404）。钉子：`tests/engine/js-template.test.ts`。
- 组合符消费这个区分：`||` 认为空 List 是「未取到」继续向右（`combine.ts` 的 `combineFirst`，注释「空 List = 未取到，继续向右」），全 Miss → Miss，**全空 List（无 Miss）→ 空 List**（同函数尾的 `所有分支未命中` 与「全空 List 或零分支 → 空 List」注释）——绝不把空 List 折叠成 Miss。

**为什么**：legado 的 `||` 短路语义建立在「没取到」是一个可继续的值之上。若把「取到空」也当失败，兜底分支会连带失效并静默拉回错误内容（android-ebook 血训）。

**链上空的两种穿透行为**：Miss 在选择/取值段被原样透传（`evalNonJs` 各 case 的 `if (cur?.kind === 'miss') return cur`），不会变成「上游不是节点集」的求值错——这是 `||` 兜底能成立的前提。`requireNodes`（`evaluate.ts`）另外约定：链首未起链 → 根节点集 `$('*')`；上游是 Value（js 段产物或取值段产物）→ 按 HTML 重新解析为新上下文（legado `String → JSoup` 语义，`<js>…</js>@css:.x` 成立）；其余 → `RuleEvalError`。

**取值用途的链终点节点集按对面串化**：选择段产 `nodes` 供后续段消费；`usage='value'` 的规则以节点集收尾时，`finalize`（`evaluate.ts` 的 `nodesAsString`）把节点集转成**逐元素 outerHTML、换行拼接**的 Value，且串化发生在 `##` 替换**之前**——对面 `AnalyzeRule.getString` 走完段循环只 `toString()`（从不因「剩节点集」而失败），XPath 模式更在段内就按换行 join 命中节点（`AnalyzeByXPath.getString`），`##` 尾替换作用于已串化的结果。真实源靠它的是「选了元素忘写 `/text()``」的 intro（爱丽丝书屋、搬山人小说网，2026-09 正文链路审计各 1 源）。服务层 `firstValue`/`listValue` 的 `nodesError('结果不是取值而是节点集')` 留作**误用闸口**（正常链路到不了：引擎内已串化）。Native 方言补隐式 `@text`（`normalize.ts`）不动——它管的是链长不变形，串化管的是链尾剩集。

**被否决的替代方案**：① 选择段切片裁空给空 List——曾如此（default 给空 List、css 给 Miss，同一 `x.5:9` 后缀两种结果），而空 List 不是节点集，中链必抛「上游结果不是节点集」；裁决为选择段四态一律 Miss（`tests/engine/reduce.test.ts` 的 `describe('选择段空态裁决统一（分叉①修复）')`）。② 取值段拥有自己的一份空态逻辑（`@text.5:9` 给空 List 而 `.5:9@text` 给 Miss）——已收拢到 `reducePicked` 单点。③ `&&` 用 Miss 冒充「合并失败」——改为抛 `UnsupportedRuleError`（`combine.ts` 的 `UnsupportedRuleError('&& 混合 AllInOne(matches) 二维结果无法合并')`，`tests/engine/combine.test.ts`）。④ `@text!0` 的排除被静默丢弃——排除现已在取值段生效（`select.ts` 的 `getValue` 消费 `reducePicked(arr, seg.exclude, seg.index)`）。⑤ 中链 jsonpath 用「合并后条目数为零」判 Miss（`evaluate.ts` 旧码 `if (s !== '') items.push(s)` + `items.length === 0 → miss`）——曾如此，它把两种值在同一处折叠两次：上游空 List 被改口成 Miss、命中但值为空串的条目被当失败丢掉，于是链首给空 List 的输入换个链长就变成 Miss，`||` 兜底随链漂移。现按上文「中链 jsonpath 逐项目空态」走（`tests/engine/reduce.test.ts` 的 `describe('中链 jsonpath 逐项目空态…')`）。

## 取值链文法

- **切分次序**（`parse.ts` 顶注「切分次序（钉死）」与 `parseRule`，顺序固定）：② 剥 `##` 净化尾（`parseTails`，`###` 先记 OnlyOne 再剥尾部一个 `#`）→ ③ 剥链首 `-` 反序前缀 → ③b **列表用途**剥链首 `+`（对面 `model/webBook/BookList.kt` 与 `model/webBook/BookChapterList.kt` 的列表入口先剥 `-` 再剥 `+`，剥完照常 `getElements`；本仓不剥时该规则恒 Miss = 列表/目录一条不出，2026-09-23 由「不适用」改判）→ ① 剥完上面仍以 `:` 开头 → 整链一个 allinone 段 → ④ 按 `||`/`&&`/`%%` 从左到右分支切分（**混用抛错**）→ ⑤⑥ 段切分与识别（`globalIndex` 全规则连续编号，写进错误定位）→ ⑦ 链尾 `(jsCode)` 与 `js` 末位限制。
- **分支切分跳过 JS 区域**（`splitTop` → `grammar.jsRegionEnd`）：`js:` 在链首或段界 `@` 后吃到链尾；`<js>…</js>` 块整体是一段。
- **段切分**（`splitElements`）：单 `@` 是段界，`@@` 是字面 `@`（显式声明形态，段内剥一个 `@`）。XPath 主导规则（`@xpath:`/`//`/`.//`/`/` 开头）的谓词 `@class` 与属性步 `@href` **不切段**，只在 `@已知特殊前缀` 处切；切过一段后回归普通模式（`//x@css:y@text` 成立）。
- **段识别**（`classifySegment`）：前缀大小写不敏感（真实源有 `@CSS:`/`@JS:`）。白名单 `KNOWN_MODES`（`parse.ts`）之外、又不构成选择器形态 → 解析期 `UnsupportedRuleError`。
- **终端**：`text`（**全部后代文本**，块级边界落 `\n`）、`textAll`（归一单行）、`ownText`（严格直系文本）、`textNodes`（逐文本节点一条）、`html`（内层）、`all`（outerHTML）、`href`/`src`（自身属性，空则向下兜底第一个含该属性的后代，但 `html`/`body` 包装元素一律不兜底）、`content`（自身属性，兜底第一个 `meta[content]`）。
- **位置后缀与排除**：`splitIndexSuffix` 从**最后一个** `.` 起取第一个能解析为 `IndexSpec` 的后缀（`all`/整数/**冒号分隔的索引列表**，均支持负数）；解析不了则整串是名称（`class.note.clearfix` → arg `note.clearfix`）。`!0:2:-1` 是排除，只对选择段（`default` 选择段与 `css`）合法，且与位置索引**不并存**（解析期抛错）。
- **位置后缀的落点差异**：`default` 段的位置后缀挂在**名称**上（`class.item.5:9` → 取索引 5 与 9 两个 `.item`）；隐式 CSS 回落把后缀带进 `css` 段（`a.0` = 选 `a` 再取第 0 个——真实源高频形态，曾被并进选择器 `a.0` 当 class 选择 → 恒零命中 → 首条书名为空）；显式 `@css:` 形态**没有**位置后缀概念，恒整集（`css.ts` 注释「css 显式形态无位置后缀（恒整集）」）。取值段后缀挂在终端后（`@text.5:9`），与选择段同口径裁决。
- **排除语法与 JS 段的边界**：排除切分用 `/^(.+?)!(-?\d+(?::-?\d+)*)$/`，只对选择段生效；`js:` 段代码里的 `!0`（布尔取反）在段前缀识别时先行返回，不受影响（`parse.ts` 的 `classifySegment`：`js:` 分支先于 `splitExclude`）。
- **隐式 CSS 回落**（`parse.ts` 的 `isImplicitCss`）：`#id`/`.class` 简写、裸 tag 词、`tag[attr]`、纯属性选择器、`tag.类` 组合、`tag+伪类/组合链`（首词须是 `HTML_TAGS` 成员）、**含选择器特征字符者**（串里有 `#` `[` `>` `+` `~` `=` `,` 任一，或以 `*` 开头——真实源 `ul#ncp3_ul li`、`*[href*=book/chapter]`、`li[style~=width:100%;]`）。这一条放宽的是**「哪串字符像选择器」**：交 `css-select` 求值后，非法选择器仍在求值层抛 `RuleEvalError`（带段定位），只有**合法 CSS 但零命中**才降为 Miss——即「认不出」与「认得但没找到」两种值依旧不折叠（2026-09 审查补记，边界钉在 `tests/engine/parse.test.ts` 的 `it('选择器特征字符 → css 段…')` 与 `it('放宽的边界：无选择器特征的未知串仍在解析期抛…')`）。首词非标签的「词.词」形态（`weirdsyntax.x`、`nonsense:x`）与无特征的未知串（`nonsense span`）与 default 方言有歧义 → **仍抛错**。
- **构词与解析同属一处**：`normalize` 三个方言分支与 `search-template`/`template` 的 `||` 拆分一律不可自写。`appendTail` 拼串后**用 `parseTails` 回读自校验**（round-trip）：pattern/replacement 含 `##`、与拼接边界 `#` 粘连、追加到 `###` 结尾的 OnlyOne 规则等情况，当场拒绝返回原 rule + warning，由调用方进 `normalize.warnings`。`withImplicitText` 也复用 `jsRegionEnd`，不再按 `||` 盲切 JS 体。

**为什么**：normalize 拼出来的必须正是 parse 认的。此前构词散在三个跨半 module 的硬拼串里，文法一改靠注释同步（已实际分叉：`<js>return a||b</js>` 被撕成 `<js>return a@text||b</js>@text`——正文规则一旦命中即整本书读不出正文且不报错）。

**JS 区域探测是文法的一半**（`grammar.ts` 的 `jsRegionEnd`，parser 的 `splitTop`/`splitElements` 与构词侧 `withImplicitText` **共用同一份认知**）：`<js>…</js>` 块整体是一个段、块内 `||`/`&&`/`%%`/`@` 是 JS 代码；`js:` 只在链首或段界 `@` 后成立，且**吃到链尾**（真实源 `@js` 代码里大量 `||`/`&&`/字符串里的 `@`）。构词侧此前裸 `split('||')` 会把 JS 体当连接符撕开，两侧对同一文法认知不一致。

**被否决的替代方案**：① 构词侧自持一份词法——否，改走 round-trip 自校验。② 遇到越界尾静默跳过——否，warning 进 `normalize.warnings`（宁吵不瞒）。③ 裸词透传留到求值期——否，解析期即炸（否则 compat 工具链按 parse 预检时漏掉，错误类与阶段全错）。**③ 的边界在 2026-09-22 按对面源码重划过**：`ElementsSingle.getElementsSingle` 的 else 分支是 `temp.select(beforeRule)`，所以白名单外的 `词.词`、非 ASCII tag（真源错字 `clasd.T-R-T-B2-Box1`、`text下一页`）**在对面不是"认不出"**，而是 CSS 选择器；本仓于是在**解析期**把它定性成 `css` 段（不是透传到 eval），零命中即 Miss，与对面同形。仍然抛的只剩**构不成选择器语法**的段（`$`、空格等非法字符）——那才是"认不出"。纯数字段另有一解：对面 `beforeRule` 为空 ⇒ `children()` 再取索引，故 `kind: "0"` 是真取值路径（矩阵 `a-bare-index-segment`）。④ `##` 落在正则/JS 代码内部靠朴素切分——仍是已知方言限制，但构词侧由 round-trip 拦下，不再产出求值期谜之结果。

## 方言与 normalize

`services/normalize.ts` 是三种方言（legado 平铺 / legado 对象 / Native）到模型字段的唯一映射点：`isNativeSource`（顶层字符串 `name`+`url` 且无 `bookSourceName`）判别 → `flattenDialect`（`ruleSearch` 落搜索面、`ruleBookInfo` 落 `ruleDetail*`——**含 `init` → `ruleDetailInit`**（详情上下文初始化，语义与宁炸口径见 CONTEXT.md 同名词条）、`ruleToc.chapterList` 落 `ruleChapterList`；`replaceRegex` 经 `appendTail` 追加净化尾）或 `flattenNative`（list/name/url 三件套、`replaceRules[]` 逐条 `appendTail`、`authorPrefix` → `##^前缀##`、`{{keyword}}` 改写为内部 `{{key}}`）。两条路都把拼串交给 `engine/grammar.ts`，越界当场进 warning。

Native 特有的**隐式终端构词**：`NATIVE_TEXT_FIELDS`（`normalize.ts`）里的取值字段裸选择器补 `@text`（`withImplicitText`）。`ruleBookList`/`ruleChapterList`/`ruleCoverUrl`/`ruleBookUrl` **不在列**——它们要节点集或属性，补了就取不到。

`services/request.ts` 持有「URL 模板 + 变量 + baseUrl → 可执行请求计划」的请求组装语义（`assembleRequest`/`fetchInitOf`）；模板内 `{{...}}` 的 JS 形态（`{{java.encodeURI(key)}}`、`{{page*2}}`）由 `services/search-template.ts` 经 `runScript` 预求值，纯变量形态留给 `interpolateUrl`（`encodeURIComponent` 编码，未知变量保留原文）。

**拼串与终端的施加次序**（`normalize.ts` 注释「终端语义收口：取值字段裸选择器补隐式 @text」钉死）：先在链体上追加净化尾（`authorPrefix` / `replaceRules[]`），**再**补隐式 `@text`——`withImplicitText` 只处理链体、尾部不动，反序会污染 `##` 段。`ruleDetail*` 与 `ruleChapterList` 是 `ruleBookInfo`/`ruleToc` 的落位目标，平铺方言缺失时在服务层回退（详情面回退 `rule*`，目录列表回退 `ruleBookList`；`reading.ts` 的 `getDetail` 里 `rules.ruleDetailName ?? rules.ruleBookName`、`getTocInner` 里 `s.rules.ruleChapterList ?? s.rules.ruleBookList`）——**回退发生在调用点，不在 normalize**。

## 面与段

- **面（facet）**：`search`/`detail`/`toc`/`content` 由服务半在调用点传入——搜索面 `search-face.ts` 的 `subEval(ruleBookList, …, 'search')`、详情/目录/正文 `reading.ts` 的 `getDetail`/`getTocInner`/`getChapter`（分别传 `'detail'`/`'toc'`/`'content'`）。face 只进错误定位与 trace，不改变求值语义。`rule` 是缺省面（`parseRule`/`evaluate` 的第二参缺省），用于 `loginUrl` 脚本等无面规则；`explore` 无生产调用方。
- **段（segment）**：`SegmentLoc = { segmentIndex, segmentRaw }`；`segmentIndex` 是跨分支的全规则连续编号（parse 的 `counter` 与 evaluate 的 `offset` 同口径）。错误消息形如 `[content#段0] …（规则片段: "@css:.con@text"）`。
- 服务层规约出的错误（正文规则零命中；链终点误剩节点集）用 `segmentIndex: -1` + `segmentRaw: '(服务层规约)'`（`reading.ts` 的 `RuleEvalError('正文规则没取到内容')`、`services/bridge.ts` 的 `nodesError`——后者只在引擎出口被绕过时到得了，见「关键口径」的链终点串化）。

## 数据流（书源规则 + 面 → 取值结果 / 错误）

1. `normalize` 出 `rules.*`（链字符串，含 `##` 尾）。
2. 面入口：`fetchSearchPage`（`services/search-face.ts`）先 `resolveSearchTemplate` → `buildSearchRequest`/`assembleRequest` → `fetchTextPage`（超时单点）→ `extractItems(await subEval(ruleBookList, …, 'search'))`。
3. `makeSubEval`（`bridge.ts`）→ `engineContextOf` 组装 `EvalContext`（`html`/`json`/`baseUrl`/`source`/`vars`/`fetch: engineFetch`/`jsLib`）→ `evaluate(rule, ctx, facet)`。
4. `evaluate`：`parseRule`（字符串形态）→ `ruleGen`/`branchGen`（链语义单点）→ `evalNonJs` 按段 kind 分派（css/xpath/default/jsonpath/allinone/getvar）→ js 段 `yield` 给驱动器 → `combine` → `reverseList` → `applyReplaces`。
5. 值回服务半：`firstValue`/`listValue`/`extractItems`（`bridge.ts`）。取值用途的链尾节点集已在引擎内串化（`finalize` 的 `nodesAsString`，见「关键口径」），`bridge.ts` 的 `nodesError('结果不是取值而是节点集')` 只剩**误用闸口**——正常链路到不了它（它曾是唯一出口，零测试）。
6. `evaluateWithTrace` 同一 runner，额外收集每段一行 `TraceStep`（`hits`/`preview`/`jsLogs`/`error`）；错误段先 push error Step 再照抛。

### 链语义单点（改引擎的第一站）

链衔接、`@put` 效果、js 段特判、trace 组装、错误步**只此一份**，以 generator `ruleGen`/`branchGen`（`evaluate.ts`）表达：非 js 段同步推进，js 段 `yield` 出完整 `evalJs` 入参。两个驱动器零链知识——`driveAsync`（主路径）`await evalJs` 后回喂，`driveSync`（`java.getString*` 的 `evaluateRef` 专用，沙箱宿主桥是同步接口）遇第一次 `yield` 即判「子规则内不支持 js 段」并抛错。

**为什么**：此前是 `runParsed`/`runParsedSync` 两个约 60 行逐条镜像的孪生函数，特判段（js/put）必须双写，且同步环路长期零测试。**被否决的替代方案**：① 保留双 runner 靠注释同步——已实际分叉；② 让同步驱动器异步化——沙箱宿主桥 `__host_call__` 是同步接口，改不动；③ 遇 js 段在同步环路里返回 Miss——否（用 Miss 冒充失败）。

**段链衔接的显式检查**：`checkChainStart`（`evaluate.ts`）只许 `allinone` 出现在分支首位（页级正则无中链语义）。`jsonpath` **中链合法**（上游修复后的 legado 语义——legado-with-MD3 fork 对 JS 返回对象不分发 Mode 的快捷路径是上游已修复的 bug，钉子测试 `model/analyzeRule/AnalyzeRuleFastPathReproTest.kt` 按修复后语义断言）：链首按整页/ctx.json 求值；上游 Value → 按 JSON 解析后求值；上游 List → 逐项求值合并（「js 返回对象数组再取字段」形态）；节点集/正则结果上游 → `RuleEvalError('jsonpath 段上游是节点集/正则结果，无法按 JSON 求值')`（宁炸）。`@get:` 段产出 Value/Miss，是合法的链值替换点（`evaluate.ts` 的 `case 'getvar'`）；`@put:` 是副作用段——写 `ctx.vars` 后链值**透传**（`evaluate.ts` 的 `seg.kind === 'put'` 分支），不替换 `cur`。

**trace 的已知限制**：错误段会先 push 一行 error Step 再抛，而 `evaluateWithTrace` 随错误 reject，调用方拿不到这段部分 trace——只有带段级定位的 typed error 浮出。若「试跑器」需要失败时的部分 trace，`TraceResult` 契约得扩展（例如返回 `{value?, steps, error}` 而不是抛）。

## 宁炸不猜的清单（每条都是显式裁决）

| 位置 | 行为 | 为什么 |
| --- | --- | --- |
| `parse.ts` 的 `UnsupportedRuleError('位置索引与 ! 排除语法不并存（legado 二选一）')`（default 与隐式 CSS 两处） | 位置索引与 `!` 排除并存 → 抛 | legado 二选一，语义冲突 |
| `parse.ts` 的 `UnsupportedRuleError('无法识别的段类型（default 段白名单之外）')` | 白名单外且非选择器形态 → 解析期抛 | 空结果冒充失败是最高罪 |
| `jsonpath.ts` 的 `reject(…, '过滤器 [?()] 不支持')` / `'脚本表达式 [()] 不支持'` / `'@ 特殊符号'` / `'& 特殊符号'` | 过滤器 `[?()]`、脚本 `[()]`、`@`/`&` → 抛 | 子集边界外不猜 |
| `jsonpath.ts` 的 `reject(…, '路径必须以 $ 开头')` | 路径非 `$` 开头 → 抛 | 无根路径无语义 |
| `xpath.ts` 的 `'XPath 轴不支持'` / `'XPath 函数不支持'` | 白名单外轴（ancestor 等）与函数（count/sum）→ 抛 | 274 条真实规则实测边界 |
| `combine.ts` 的 `'&& 混合 AllInOne(matches) 二维结果无法合并'` / `'%% 交叉合并不支持 AllInOne(matches) 二维结果'` | `&&`/`%%` 遇多分支 `matches`(2-D) → 抛 | 二维无法摊平；不得用 Miss 冒充 |
| `variables.ts` 的 `'@put 值是规则串但调用方未接线子规则求值口（evaluate 的 subEval）'` | 直测/桥缺位时规则形态的值不降级成字面存 | 缺接线不猜（生产链路由 evaluate 接线，见「@put 值 = getString」） |
| `js-protocol.ts` 的 `'getString 的 isUrl=true 在 v1 不支持（不支持取 URL 后自动抓取）'` | `java.getString(rule, isUrl=true)` → 抛 | 不在桥内做 fetch，静默把 URL 当内容返回是错误结果 |
| `evaluate.ts` 的 `driveSync`：`'子规则（java.getString 等递归求值）内不支持 js 段——沙箱宿主桥为同步接口'` | 子规则（`java.getString*`）内含 js 段 → 抛 | 沙箱宿主桥是同步接口，无法递归 await |
| `js-sandbox.ts` 的 no-op 名单：`需要安卓宿主环境` | `java.webView`/crypto/`android.*`/`org.*` → 报「需要安卓宿主环境」 | 不静默 no-op；纯 UI 副作用（toast/copyText/startBrowser/open）则明确 no-op |
| `xpath.ts` + `js-protocol.ts` | 解析不到、宿主桥未接线（`evaluateRef` 缺失）→ 抛 | 缺接线不降级 |

**例外（规则承认的静默）**：位置索引越界**不抛**（`applyIndex` 把越界位置逐个丢掉，对面 `if (it in 0 until len)` 同款），全部越界时取不到值 → Miss。这是 legado 行为，也是「越界不抛、语法不认识才抛」的边界。同类静默还有三处，都是**如实**而非掩盖：`@put` 的 JSONPath 求值 Miss → 变量不落盘（`@get` 时自然 Miss，`variables.ts` 的 `putJsonPath`：`if (res.kind === 'miss') return`）；`resolveJsonData` 解析失败 → `undefined` → JSONPath 如实 Miss（`variables.ts` 的 `resolveJsonData` 注释「非法 JSON → undefined」）；`normalize` 对未映射子字段与 v1 未支持字段聚合 warning（宁吵不瞒，不拦导入）。

**字符串化口径**（`EngineValue → 串` 只有一个实现 `js-utils.engineValueToString`）：`value`→text、`list`→`\n` 拼接、`matches`→行内 `\t`、`miss`→`''`，`nodes` 由参数区分 `inner`（`html()`，`java.getString` 口径）与 `outer`（`toString()`，`@js` 的 `host.result` 口径）。`engineValueToStrings`（`java.getStringList`）另把 `value` 按换行切分并滤空行。

## @js 沙箱与宿主垫片

`evalJs`（`js-sandbox.ts`）的机制与理由：

- **逃逸防御**：宿主绝不把函数/对象直接交给用户代码。唯一入口 `__host_call__` 被 vm-realm 闭包捕获后即从全局锁死（`typeof` 得 `number`），`java`/`console`/`cookie`/`source` 全是 vm realm 的包装函数，参数与返回值 JSON 双向序列化，宿主错误只取 `.message` 后以 vm realm `Error` 重抛。vm 上下文 `codeGeneration:{strings:false,wasm:false}` → `eval`/`Function` 一律 `EvalError`。**为什么**：此前把宿主函数直接注入 → `console.log.constructor("return process")()` 可直达宿主 realm（vm 的 `codeGeneration` 不约束宿主 realm 的 `Function`）。
- **禁用能力及理由**：`require`/`process`/`fs`/`global` 不注入（`typeof` 得 `'undefined'`）；字符串代码生成禁用——这是 `jsLib` 用 `eval`/`new Function` 的源报「Code generation from strings disallowed」的原因，**明确不支持**而非降级；webView/crypto/字体/`android.*`/`org.*` 报「需要安卓宿主环境」。
- **超时**：`jsTimeoutMs`（缺省 `DEFAULT_JS_TIMEOUT_MS = 2000`）双闸——`vm.runInContext` 的 timeout 杀同步死循环，外层 `Promise.race` 硬超时约束异步总时长（timer 已 unref）。**生产求值路径全部携带服务层配置**：插件 config `jsTimeoutMs`（缺省 15000，`index.ts` DEFAULTS）经 ReadingService → `bridge.engineContextOf`/`makeSubEval` → `EvalContext.jsTimeoutMs` 透传（阅读三面 + 搜索面 + 探针 + 登录脚本同一口径）；引擎常量只作**未传时的回退**。为什么缺省放宽到 15s：legado Rhino 无硬超时（观察式协程取消），真实源的多请求目录脚本（txs12 源：`java.ajax`×2 + md5 签名 + `source.setVariable`）实测超 2s 必炸——探针 verified 只证明搜索面，正文链路靠这个预算放行（钉子：`tests/services/reading.test.ts` 的 `describe('js 沙箱预算走配置出口（jsTimeoutMs）')` 三态）。
- **脚本形态**：`scriptForm:true`（`@js` 与 searchUrl 形态的缺省）＝代码作为脚本执行、**最后一个表达式的值即结果**；顶层 `return`/`await` 触发 SyntaxError 时回落 async IIFE 函数体形态。回落判别在**编译期**（`new vm.Script` 只编译不执行）——按运行时异常类名判会把 `JSON.parse` 坏串这类**运行时** SyntaxError 误当「顶层 return 形态」静默回落，表达式脚本在 wrapped 里无 return → 恒 Miss（novel.cooks.tw init 脚本真机实证：静默取空比报错更坏）。**两路都得判在编译期**：这条修正一度只落在主线程，worker 的 `WORKER_SRC` 仍是「先执行 code，捕获到 SyntaxError 再重跑 wrapped」——运行时 SyntaxError 于是把脚本跑两遍：ajax 已经发出去 → 站点两趟、非幂等写入两遍；第二遍恰好不抛时 wrapped 里无 return → 完成值 undefined → 静默 Miss（2026-09 审查实证：同一条脚本主线程如实抛、worker 打两趟站点后返回 Miss）。`wrapped` 文本改为在 `evalJs` 一次构造、经 `workerData` 交付（两路同一份——在 worker 字符串里再拼一遍等于养第二份，两处转义口径不同，改一处漏一处）；判别函数本身跨 realm 够不到（worker 里的 `vm` 是 worker realm 的 host 模块），只能留一份文本抄本，两路一致由 `tests/engine/json-parse-object-idempotent.test.ts` 的跨路钉子守。返回值映射：string→Value、array→List（元素 `String()`）、`null`/`undefined`/`''`→Miss、对象→JSON.stringify 的 Value。**`JSON.parse` 对象幂等 wrap**：JSON 页的 `result` 按已解析对象绑定（字段访问口径），而 `JSON.parse(result)` 形态的脚本会把对象 ToString 成 `"[object Object]"` → 运行时 SyntaxError → 目录全灭（同源实证）；wrap 对已解析对象先 stringify 再 parse（深拷贝幂等），字符串/标量走原生。
- **`host.result`**：上一段结果的序列化，**首段 → 整页原文**（`pageText()` = `html ?? String(json)`，JSON-only 页不再拿到空串）；nodes 口径是 outerHTML（`engineValueToString(v,'outer')`），与 `java.getString` 的 innerHTML 口径由参数显式区分。上游是 List 时，js 串结果按 `\n` 拆回 List（`evaluate.ts` 的 `prev?.kind === 'list'` 分支）。
- **`java.ajax` 与 unhandledRejection**：`java.ajax` 走 `ctx.fetch`（服务半注入 `engineFetch`：源 header 打底 + `assembleRequest` 选项语义 + 解码）。ajax 已**不再产出 Promise**（同步语义唯一，见下节「语义唯一：哨兵 + 透明重跑」），于是引导层那层「给悬空 Promise 挂空 catch」的防线连同它的 `DSH_NOVEL_NO_GUARD=1` 排障开关一起消失——没有 Promise 可消化（`init` 里的 `noGuard` 字段随之删除，该环境变量现已无任何读取点）。剩下的两层：① 协议表实现只管发起请求并如实失败；② `ensureUnhandledGuard()` 进程级常驻 `unhandledRejection` 监听（插件 dispose 时摘）。**② 仍然必需**：vm realm 的 Promise 与宿主同一 isolate，脚本**自建**又 fire-and-forget 的异步工作照旧会悬空拒绝，而 Node 20+ 默认把它当致命错误直接干掉整个 dsh 进程——尤其在**导入书源**时（探针逐源跑 @js，用户看到的「fatal load failure / 请求失败 403 / 404」正是这条 rejection 冒到进程顶层）。它必须加载期常驻而不是「evalJs 期间挂、finally 摘」：rejection 晚于 evalJs 返回才触发，摘早了照样漏。
- **`java.ajax` 的实参规约**（`js-protocol.ts` 的 `ajax` 行）：协议表把它声明成 `(url: unknown)`，发起前统一 `String(url)`——这是对面 Rhino 的 `String` 形参强制转换在本仓的等价物。真源常把上一段的值直接递给 ajax（`java.ajax(result)`），而 JSONPath 段产出的是**单元素数组**，`['https://x'].toString()` 恰好就是那条 URL → 对面打得通、本仓此前把原值交给 `assembleRequest` 炸成 `template.replace is not a function`（灯读文学 `ruleBookInfo.init` 段实证：错误信息既没有段线索也不等于对面的结果）。**`null` / `undefined` 不猜**：不拼成字符串 `"null"` 去打站点（那是拿合法形状冒充成功），当场点名「java.ajax 参数为空」——对面拿它 `new URL` 同样抛，两边都失败，但本仓说的是人话。钉子：`tests/engine/js-bindings.test.ts` 的「java.ajax 参数规约」；类型面钉子 `tests/engine/js-protocol.test.ts` 的 `_Ajax`（形参从 `string` 改 `unknown` 是**契约变更**，不是放松）。
- **宿主垫片**：`java.get/put`、`getString/getStringList/getElements/getElement`（经 `evaluateRef` 递归求值，基内容 `contentBase ?? result`）、`setContent`、`timeFormat/UTC`、`base64*/md5Encode*/encodeURI/hexDecodeToString`、`toNumChapter`（中文数字章节规整，`js-utils.ts` 照抄对面 `chineseNumToInt` 的算法）、`randomUUID`、`strToBytes`/`hexDecodeToByteArray`/`base64DecodeToByteArray`（字节 = number[] 0-255）、`downloadFile`/`readTxtFile`（进程内暂存表 + `ctx.fetchRaw` 二进制通道；路径对脚本是不透明令牌）、cache 的 `put/get/delete` 与内存三别名 `putMemory/getFromMemory/deleteMemory`、`cookie` get/set/remove（按源隔离的最小仿真，不做真实 CookieJar——那是无头浏览器的活）、`source.getVariable/setVariable/get/put`（同一变量表）、`source.header`/`source.key`/`source.getKey()`/字符串拼接语义、`java.log ≡ console.log`、`java.getWebViewUA`（返回**本仓实际出站**的 UA——对面给的是 WebView 默认 UA，本仓没有 WebView，属**近似**；`ctx.userAgent` 未接线即点名抛错，不编值，见矩阵 `h-java-webview-ua`）。**桥可达性对账**：协议表里有真实现的名字绝不允许同时躺在 BOOTSTRAP 的「需要安卓宿主」桩名单里——桩是后挂的，会静默覆盖真实现（`digestHex` 一族 2026-09-22 就这样"实现了但脚本够不着"，由 `tests/engine/parse-census.test.ts` 的面 C 钉死）。`cookie` 与源变量按 `SourceSession` 隔离：生产缺省 `processSession`（跨调用存活），测试注入 `createSourceSession()`（跨源污染用例才写得出来）。
- **`Packages.*` 包路径仿真**（BOOTSTRAP + `__pkg.*` 通道，2026-09）：真实源正文解密链用 Rhino 的 Java 包路径组织调用（爱腐文 favicon 密钥图实证：`ByteArrayInputStream → BitmapFactory → javax.crypto`）。轻活（流对象、`Arrays.copyOfRange`、`SecretKeySpec` 包装）留 vm 纯 JS；重活经 `__pkg.*` 宿主调用（与 `__elem.*` 同为引导层特判通道，不进协议表）：**PNG 解码**（`js-utils.decodePngToArgb`，隔行/未知滤波宁炸不猜）、AES-CBC 解密（v1 仅 `DECRYPT_MODE`，PKCS5=PKCS7 自动校验）、HmacSHA1/256/512（`update(byte[] | byte)` 与 `doFinal(input?) ≡ update(input)+doFinal()` 都按 Java 契约收实参、`doFinal` 结算后复位——此前 `doFinal` 不接参数，`m.doFinal(bytes)` 于是对零字节签名，是静默出错值；认不出的载荷形态如实抛）、charset 解码。`ByteArrayInputStream.read()` 带游标自增（没游标则 `while((b=s.read())!=-1)` 是第一死循环，唯一出口是 js 超时）。字节在脚本侧统一 number[]（0-255）：JSON 可序列化跨 SAB RPC 安全、`& 0xff` 语义不变。未知包路径/未知变换如实报错，不静默 no-op。
- **`jsLib` 两形态**（legado SharedJsScope）：裸 JS 文本，或 `{"名字":"https://…"}` URL 字典——后者在 `evalJs` 顶部由 `js-sandbox.ts` 的 `resolveJsLib` 下载并按 URL 缓存（上限 32，插入序淘汰），拼成一段库代码再执行。**两条路必须吃同一份解析后的文本**：worker 与主线程都取 `jsLibCode`（此前主线程读原始 `ctx.jsLib`，同一源在两条路上会少一层库），`SYNC_WORKER_RE` 也因此看得到下载后的库（库里含 `java.ajax` 才能被正确送进 worker）。下载失败 / 无 `ctx.fetch` 一律如实抛，不降级成空库。源级全局函数库，**先于**用户代码在同一 vm 上下文执行（函数定义落全局）；它本身不是求值目标，抛错如实上报（jsLib 坏了整源 js 都不可信）。
- **已知不可解**（源码注释已声明）：`await null; while(true){}` 这类「异步续体里的同步死循环」在 `runInContext` 返回后才跑，两道超时都拦不住 → 宿主事件循环饿死。v1 明确接受为限制（沙箱的安全义务——不可逃逸——已满足；同步死循环仍被拦），未上 worker_thread。

**改沙箱时的纪律**：加宿主能力只改 `JAVA_PROTOCOL` 一行（含实现），`SANDBOX_MOUNTS`（挂载清单）、`invokeJavaMethod`（分派）与 `JavaBridge`（类型面）全部派生——不存在第二份手写名字清单，`tests/engine/js-protocol.test.ts` 用「方法名唯一」与「表 ↔ 挂载清单完备」两条钉死这条派生关系。给不了 Android 的能力**只许报「需要安卓宿主环境」**，不许静默 no-op 或返回假数据。

## JSONPath 口径

自实现子集（禁 npm 依赖）：`$`、`.name`、`..name`（递归下降，按文档序收集）、`[n]`（下标，**负数从尾数**）、`[a:b]`（半开切片，负数从尾数）、`[*]`/`[]`（同义）、`.*`（属性通配：对象取全部值、数组取全部元素）、`.[*]` 冗余点。解析到 `null`/`undefined` 的分支直接丢弃。数据源：`ctx.json` 优先；缺席且 `ctx.html` 是合法 JSON 时回退解析（legado `isJSON` 口径——搜索链路只传 html 不传 json，不回退则所有 `$.` 规则对 JSON API 源恒 Miss）。

**明确拒绝并抛错**：过滤器 `[?(…)]`、脚本表达式 `[(…)]`、`@`/`&` 特殊符号、路径不以 `$` 开头、递归下降缺属性名、方括号未闭合、下标内容不合法——错误都带路径原文与段定位。

**为什么自实现**：`$.data.*` 属性通配、`.[*]` 冗余点、负数从尾数这些 legado 真实源形态不在任何小库的子集里，而完整 JSONPath 库会带进过滤器/脚本这些我们**明确不想支持**的语义——自实现才能把「不支持的语法」变成带定位的抛错而不是静默错值。

**元素字符串化钉死**：字符串原样；number/boolean → `String()`；对象/数组 → `JSON.stringify`（所以 `$.info.Datas` 的 List 元素是 JSON 文本，服务层再按面去 parse）。

## 测试钉子

| 测试文件 | 钉死的口径 |
| --- | --- |
| `tests/engine/reduce.test.ts` | 取值规约单点：`reducePicked` 四态、选择段/取值段同口径、取值段 `!` 排除生效、「取到空」仍是空 List、中链 jsonpath 的「上游空 List 保持空 List / 命中空串不收进 Miss / 逐项全 Miss 才是 Miss / 空子集不贡献空串条目」 |
| `tests/engine/content-facet.test.ts` | `text.<串>` 选择语义、属性终端与取值用途（含**命名空间属性名向下兜底不泄漏裸 Error**）、模板字面段（识别/切分/求值/链值引用/**插值 Miss 即整段 Miss**）、`##` 尾 `{{chapter.title}}` 插值、中链 jsonpath、**方括号多条目并集（文档序 / 越界条目丢弃 / 全越界 → Miss）** |
| `tests/engine/js-bindings.test.ts` | 沙箱非严格模式（未声明赋值）、`src`/`book`/`chapter` 绑定、**worker 路线自身的逃逸防御与超时**（`require`/`process`/`Function()` 与 `脚本超时（>Nms）` 口径两条路一致）、**`java.ajax` 语义唯一**（别名/注释干扰拼写一律同步返回，哨兵重跑不多打站点、不重复计日志）、**`java.ajax` 实参规约**（非串按 `String(值)` 交下去、`null` 点名不发请求） |
| `tests/engine/select.test.ts` | default 段选择/取值、点号位置索引列表（写入序、越界逐个丢、全越界 Miss）、`text`(后代) vs `ownText`(直系) vs `textAll` vs `textNodes`、块级换行、属性缺失→空 List、**链首裸取值终端以文档根为上下文（真源 `chapterName:"text"` 不再逐祖先重复三遍）** |
| `tests/engine/css.test.ts` | `@css` 段在当前节点集内 find、`!` 排除、非法选择器 → `RuleEvalError`(hits=0) |
| `tests/engine/parse.test.ts` | 切分次序、位置后缀、`!` 识别、大小写不敏感前缀、隐式 CSS 全形态（含**选择器特征字符放宽与其边界**）、未知段/裸词解析期抛错、`<js>` 块可非末位、`@js:` 吞链尾、**`@put:{…}` 体内 `@` 不切段、`@get:{name}` 剥括号** |
| `tests/engine/tocurl-interpolation.test.ts` | 斜杠开头 URL 模板插值优先于 XPath 前缀（顶点小说 `{{$.novelId}}` 实证） |
| `tests/engine/value-terminal.test.ts` | **取值用途链尾剩节点集 → 逐元素 outerHTML 换行拼接**（单命中/多命中、串化先于 `##` 替换、列表用途不变、Miss 不被串化成空 HTML）——爱丽丝书屋 / 搬山人小说网 `ruleSearch.intro` 实证 |
| `tests/engine/js-template.test.ts` | **js 段代码文本里的 `{{…}}` 先插值再执行**（makeUpRule 顺序）：JSONPath 内嵌段、插值 Miss → 整段 Miss 不发残 URL、`{{book.name}}` js 表达式形态、无内嵌段的 js 段行为不变 |
| `tests/engine/json-parse-object-idempotent.test.ts` | `JSON.parse` 对象幂等 wrap（两形态共存）+ 运行时 SyntaxError 如实上抛不再静默 Miss + 顶层 return 回落不误伤（novel.cooks.tw init 实证） |
| `tests/engine/legado-gaps.test.ts` | cache 内存三别名与挂载完备、`randomUUID` 形态、字节组三方法与 charset 归一、`downloadFile↔readTxtFile` 往返与「不读任意本地路径」、PNG 解码（RGBA/灰度/隔行拒绝）、`Packages.*`（流/`copyOfRange` Java 语义/AES 解密闭环/HMAC 同值/`BitmapFactory.getPixel`）、**段尾点号剥离**（`tag.li.!0:1:-1` 的 `!` 排除切走 base 后的尾巴不进选择器——看书源实证） |
| `tests/engine/grammar.test.ts` | `parseTails`/`appendTail` round-trip 自校验与全部越界 warning、`withImplicitText` 不动 JS 区域、`isJsForm`/`splitVarExpr`/`isPureVarExpr` 词法 |
| `tests/engine/combine.test.ts` | `||` 短路与空 List 继续、`&&` 合并/跳空/多分支 matches 抛错、`%%` 交叉驱动、反序四种值 |
| `tests/engine/replace.test.ts` | 净化循环替换、OnlyOne 剥 `g`、`$1` 原生语义、替换为空保留条目、非法正则段级定位、`{{}}` 插值只认 bindings 自有键（`{{toString}}` 等原型链成员保持字面） |
| `tests/engine/jsonpath.test.ts` | 负下标/负切片从尾数、切片裁空→Miss、空数组→空 List、集合型末段恒 List、属性通配、拒绝过滤器/`@`/`&` |
| `tests/engine/allinone.test.ts` | 二维 `matches` 不压平、零匹配→空 List（非 Miss）、无捕获组单元素行、零长度匹配不死循环 |
| `tests/engine/xpath.test.ts` | 谓词按父分组、`//text()` vs `/text()`、末段 `@attr`、`preceding-sibling` **逆文档序**编号、**相对路径存在性谓词（`li[.//a]`、`[a/@href]`，谓词内 `//` 起步如实抛）**、白名单外轴/函数抛错 |
| `tests/engine/variables.test.ts` | `@put` pairs 手写解析、**引号值 = 显式字面量 / 裸值 = JSONPath·键访问·字面回退**（两种写法不互相覆盖）、**值为规则串按子规则求值（多值 `\n` 拼接；js 形态值如实抛）**、JSONPath 值路由与 Miss 裁决、失败不半截写入、`@get` 只认 `ctx.vars` 自有键（原型链成员名如实 Miss） |
| `tests/engine/js-sandbox.test.ts` | 逃逸防御（代码生成禁、宿主 realm 不可达、引导入口锁死）、双超时、日志收集、垫片全清单、`jsLib` 先执行且抛错点名 |
| `tests/engine/js-protocol.test.ts` | 协议表方法名唯一、表↔`SANDBOX_MOUNTS` 完备、分派无 switch |
| `tests/engine/evaluate-sync-loop.test.ts` | `java.getString*` 真实环路（evaluate → evalJs → evaluateRef → 同步 runner）、子规则含 js 段抛错 |
| `tests/engine/trace.test.ts` | trace 每段一行、错误段定位（`/段1/`）、独立净化基值（html 原文 / `String(ctx.json)`）、JSON-only 页首段 `@js` 的 result、`evaluate(ParsedRule)` 直通不重 parse、`ctx.json` 缺席回退解析 html |
| `tests/engine/template.test.ts` / `types.test.ts` / `js-utils.test.ts` / `run-script.test.ts` / `source-session.test.ts` | `{{}}` 插值（含 `encodeURIComponent`、只认 vars 自有键——原型链成员名保留原文）、错误三元定位、`EngineValue → 串` 五分支口径、`runScript` 完成值语义、会话按源隔离 |
| `tests/services/error-taxonomy.test.ts` | 引擎三类错误（`UnsupportedRuleError`/`RuleEvalError`/`JsSandboxError`）与抓取两类按 `e.name` 投影成 wire 错误码——错误类**改名即改 wire 码** |
| `tests/services/normalize.test.ts` | 三方言展平映射、Native 隐式 `@text`、`appendTail` 越界进 warning |
| `tests/services/search-face.test.ts` / `request.test.ts` / `probe.test.ts` | 搜索面编排、请求组装、探针实测结论——引擎公开面的下游契约 |
| `tests/compat/replay.test.ts` + `compat/fixtures/demo-site/` | 合成书源在 `@js`/JSONPath/XPath 等形态上的离线全链路回放（分母是 fixture，**不是站点兼容率**） |
| `tests/packaging-*.test.ts` | 引擎构建产物（`lib/`）能按真实安装链路挂载——引擎改动要能过 `pnpm build` |

## legado 正文链路语义补齐（2026-09 正文审计驱动）

背景：书源注册表 228 源全部 `verified`（探针只验搜索面），但正文链路全量审计（`DSH_CONTENT_AUDIT=1`，`tests/content-audit.test.ts`）实测仅 25 源全通——「搜索可用 ≠ 正文可读」。对照 legado 参考实现（对面 `model/analyzeRule/AnalyzeByJSoup.kt` 与 `data/entities/rule/*.kt`）补齐六条语义，每条都有引擎测试钉子（`tests/engine/content-facet.test.ts`、`tests/engine/js-bindings.test.ts`）：

1. **js 段 scriptForm 口径修正（最大单点）**：链内 `<js>`/`@js:` 段此前走 wrapped async IIFE——无 `return` 的**表达式形态**（legado 主导写法：最后一个表达式即结果）恒产 undefined → Miss，`$.id@js:"…"+result` 这类真实源主导形态整批静默取空。`evaluate.ts` 的 `branchGen` 现对 js 段显式传 `{ scriptForm: true }`（与 `runScript` 缺省一致）。
2. **沙箱非严格模式 + legado 变量绑定**：wrapper 去掉 `'use strict'`（legado Rhino/QuickJS sloppy 语义——`next = []` 未声明赋值写全局，实测 13+ 源目录脚本首行依赖）；沙箱全局新增 `src`（页面原文，ctx.html ?? String(ctx.json)）、`book`/`chapter`（服务层按面注入 EvalContext）。逃逸防御不靠严格模式（vm realm + codeGeneration 关闭 + 宿主入口锁死），BOOTSTRAP 顶注有完整理由。
3. **取值用途 + 属性终端**：`parseRule`/`evaluate` 增 `usage` 参数（CONTEXT.md「取值用途」）；取值用途链尾未知提取指令 = HTML 属性名（legado getResultLast else 分支），列表用途链尾未知词仍是选择器。`weirdsyntax.x`（词.词）依旧解析期抛错——宁炸不猜边界不外扩。属性终端的向下兜底**不走 CSS 属性选择器拼串**：`isAttrName` 放行冒号（`xlink:href` 这类命名空间属性名），而 `[xlink:href]` 在 nwsapi 里必炸成逃逸错误分类的裸 Error，故 `select.ts` 的 `attrFallback` 直接遍历后代取第一个含该属性且非空的节点（钉子：`tests/engine/content-facet.test.ts` 的 `属性终端：命名空间属性名`）。
4. **模板字面段**：`engine/literal.ts` 新模块——`{{expr}}`（JS 表达式 / 规则递归二分）、`{$.path}` 单括号内嵌、`http(s)://` URL 模板段；`branchGen` literal 分支逐段插值（js 部分经沙箱、`{{result}}` 引用链值、`{{page-1}}` 等绑定可见）。**任一字面插值段命中 Miss → 整段 Miss**：插值成空串会拼出语法合法的残 URL（`http://api/novel/{{$.novelId}}` → `http://api/novel/`），拿它发请求比报错更坏——残 URL 可能命中另一本书，而 Miss 会让门面明确失败（钉子见 `tests/engine/content-facet.test.ts` 的 `字面段插值命中 Miss → 整段 Miss`）。空 List 参与拼接时仍是空串：那是「解析到空集合」，不是「取位失败」，两种值不折叠的规矩照旧。
5. **`text.<串>` 按文本选元素**：legado getElementsContainingOwnText 口径（`select.ts`）。`text.下一页@href`、`text.章节目录@href` 是真实源最高频形态之一，此前参数被忽略 → 整页文本 → 链尾落空。
6. **`##` 尾插值与中链 jsonpath**：替换 pattern/replacement 里的 `{{chapter.title}}` 等点路径按 bindings（book/chapter/vars/baseUrl）插值（legado makeUpRule：替换规则串同样先插值再当正则）；jsonpath 中链合法化见上节。

**被否决的替代方案**：① 链尾未知词一律按属性终端——否，ruleChapterList 等列表规则的链尾选择器会被打成属性（`id.chapter-list@a` 中的 `a`），usage 轴才分得开；② `{{}}` 插值统一进 search-template 那套预求值——否，插值依赖**链上下文**（`{{result}}`/条目 JSONPath），预求值拿不到；③ 沙箱补 `'use strict'` 安全性——否，严格模式与逃逸防御正交，反而杀掉 legado sloppy 源。

**仍开口（如实）**：`@webjs:`/`sourceRegex`/`webView:true` 属 WebView 面（本插件无头浏览器缺席，legado 本身也只在 URL 带 `webView:true` 时才走 WebView）；`contentRule.subContent`/`title` 未实现；jsLib 里用 `eval`/`new Function` 的源仍报 Code generation disallowed（安全边界明确不降级，实测 2 源）；**js 段（`@js:`/`<js>`）体内字符串的 `{{$.…}}` 不插值**——legado `SourceRule.makeUpRule` 对全 mode 规则先插值再执行，本仓模板字面段只认字面形态、js 段按纯代码执行（米读 `ruleTocUrl` 的 `@js:try{"…/{{$.book_id}}.txt"}…` 真机实证：字面 braces URL 404；QQ 类纯 URL 模板已由 `tocUrlOf` 的详情上下文路径覆盖，`@js` 包裹模板独立工单，勿在 js 段里随手加插值——那是改全引擎语义）。**已解决**（原列此处）：`<a,b,c>` URL 页码形态（`expandPageAngleList` 照抄 `AnalyzeUrl` 的 `pagePattern`，矩阵 `b-page-angle-list`）、方括号索引**多条目**并集（矩阵 `a-bracket-multi`，见下）、`java.ajax` 同步语义——worker+SAB RPC 桥落地，且语义已收口成唯一一种（哨兵 + 透明重跑，等价拼写不再换类型），见下。

**三轮补齐：`java.ajax` 同步语义（worker + SharedArrayBuffer RPC 桥）**：
legado 的 `java.ajax` 是 runBlocking 同步返回响应 body，Node 主线程 vm 无法阻塞 await——脚本里 `let b = java.ajax(u); b.indexOf(...)` / `java.ajax(url).match(...)` 这类**真实源主导形态**此前整批报 `xxx is not a function`（失败桶内 20 源引用 java.ajax）。实现（`js-sandbox.ts`）：
- **路由（只是性能与稳健性启发，不是语义开关）**：`evalJs` 用 `SYNC_WORKER_RE` 检测代码（含 jsLib）里**任何可能**是 ajax 的形态 → 整段求值直接进 worker 线程（`new Worker(WORKER_SRC, {eval:true})`——worker 代码以字符串交付，tsdown 打包后无独立 worker 文件可解析；BOOTSTRAP/init/code 全走 workerData，**不产生第二份引导代码抄本**）；认不出的脚本仍走主线程零开销。正则刻意**过近似**，三支：`\.ajax\s*\(`（任何 `.ajax(`）、`downloadFile\s*\(`（`java.downloadFile(`——与 ajax 同款的 async 哨兵桥）或 `java\s*\[`（对 java 桥的任何下标访问，含 `java["ajax"]` 与一切动态键）。放宽不只省一趟白跑——哨兵靠「抛出」传递，脚本自己的 `try/catch` 会在 vm 内吞掉它，现实的别名写法直接进 worker 就走不到抛哨兵那一步。**代价实测**（本机 228 源真实库）：放宽前后同样 28 源命中，多路由 **0** 个。**猜错只赔一趟白跑的主线程尝试，绝不改变返回类型**——语义由桥给（见下条）。
- **语义唯一：哨兵 + 透明重跑**（`js-sandbox.ts` 的 `SYNC_AJAX_SENTINEL` / `needsSyncBridge`）：`java.ajax` 在任何拼写下都只有一种语义——legado 的 runBlocking 同步返回 body。BOOTSTRAP 的 ajax 包装按 `init.syncAjax` 二选一：worker 分支走 SAB RPC 同步返回；**主线程分支不返回 Promise，而是在发起宿主调用之前抛哨兵** `__dsh_sync_ajax_required__`，`evalJs` 在最外层捕获后丢掉本次已收集的 logs、换 `initOf(true)` 在 worker 里重跑同一段（`init` 因此按 `syncAjax` 参数化：复用主线程那份会让 worker 里的包装再抛一次哨兵）。**为什么在宿主调用之前抛**：请求根本没发出去，重跑不会多打站点一次（钉子按 fetch 计数验）。**为什么哨兵要包在最外层**：它有四个可能冒出的位置——BOOTSTRAP init、`jsLib` 执行、同步 `runAsScript`/`runInContext`、以及 `await` 到的完成值（此时哨兵是 rejection）；内层 catch 会把裸 Error 转成 `JsSandboxError`，而 `jsErr` 是 `${prefix}：${msg}` 拼接，原文仍在 message 里，故 `needsSyncBridge` 按**子串**判定即可，不需要额外的错误类型或标记位。
  - **修复前的实测分叉**（源码文本选择语义，同一台机器同一棵树）：`typeof java.ajax("fixture")` → `"string"`（worker，同步）；`typeof java["ajax"]("fixture")` → `"object"`（主线程返回了 Promise）；`/* java.ajax( */ typeof java["ajax"]("fixture")` → `"string"`（加一段注释又把语义翻回来）。源作者把 `java.ajax(u)` 改写成 `java["ajax"](u)` 就静默拿到 Promise，真实源主导的 `.match(...)[1]` 直接炸。
  - **被否决的两条显然方案**：① **一律走 worker**——本机真实书源库实测：228 源中 142 源含 js 段、其中仅 28 源用 `java.ajax(`，一律走 worker 是 **5× 的 worker 生成量**（每次还各自分配 4 MB + 16 MB SharedArrayBuffer），得先做 worker 池才谈得上，那是另一个项目；② **加宽正则去猜动态别名**——不可判定（`java['aj'+'ax']`、解构、`with`、把 `java` 传进函数），任何加宽都是把语义继续押在拼写上。
  - **唯一残余（如实）**：正则放宽后，现实的别名写法（`java["ajax"]` 及一切下标访问）已直接进 worker，剩下能撞到哨兵的只有**脚本里不含那三个字面量的间接形态**（解构 `const {ajax} = java` 后再调、`with (java)`）——计算键 `java[...]` 已被正则的 `javas*[` 分支捞进 worker。这类脚本有两处残余：① 若在第一次 ajax **之前**做过非幂等写入（`source.setVariable` / `cache.put` / cookie 写；同类还有 `java.put` 写 `ctx.vars`、`java.setContent` 写 `BridgeDeps.contentBase`），重跑会把这些写入执行两遍；② 若脚本用自己的 `try/catch` 包住这次调用，哨兵会在 vm 内被吞掉、重跑不触发，脚本静默走它的 catch 分支而不是拿到 legado 语义（放宽正则正是为了把这条对现实写法关掉；`java.ajax(` 与 `java[...]` 两种主流拼写都已进不了这个洞）。当前 228 源库里用动态构造写法的源为 **0**，故两条实测零发生；**网络请求不受影响**（哨兵在宿主调用之前抛）。曾考虑给重跑挂一个影子 `SourceSession`（先在副本上写、成功后回写）——**否决**：为一个零发生场景引入写回机制，是新增的活动部件，自带它自己的失败模式（回写时机、与 `processSession` 的可见性分裂）。若将来真出现这种源，正确的修法是先做 worker 池再一律走 worker（把重跑整条路删掉），而不是补写回。
- **同步桥**：worker 内 `__host_call__` 把 `(name,argsJson)` 写进请求 SAB → `parentPort.postMessage({rpc:true})` 唤醒主线程 → `Atomics.wait` 阻塞；主线程用**同一个 `call`**（fetch 守门 / `java.getString` 引擎递归 / console 日志 / `__elem.*` 元素桥——全部现成）异步服务，响应 JSON 回写响应 SAB + `Atomics.notify` 唤醒 worker。JS 视角同步拿到 body（bootstrap 的 ajax 包装按 `init.syncAjax` 二选一，同一份代码）。
- **不变量**：逃逸防御不变（worker 里同一份 BOOTSTRAP + codeGeneration 锁死，SAB 上只流 JSON）；**脚本形态判别与主线程同口径**（编译期，见「脚本形态」节——worker 里那份是文本抄本，`wrapped` 经 `workerData` 交付而非在 worker 字符串里再拼）；超时双闸（worker 内 vm timeout 杀同步死循环 + 主线程 race 后 `worker.terminate()`），且 **worker 内 vm 超时映射回本仓口径**——跨边界只有 message/stack，`ERR_SCRIPT_EXECUTION_TIMEOUT` 那个 code 留在对端 realm，故按 message 判后抛 `jsTimeoutErr`（否则同一条件在主线程与 worker 两条路上报两种错，2026-09 审查发现）；RPC **帧解析也在 try 内**（畸形长度/坏 JSON 以 `{__error}` 回包让 worker 从 `Atomics.wait` 醒来，不许落在 `void serviceRpc()` 上成 unhandled rejection——那样要挂到外层 race 才 terminate）；宿主失败（如「该源未提供网络能力」）经 `{__error}` 通道回到 worker 以 vm Error 抛出——**与 legado 的差异如实记录**：legado ajax 失败返回异常堆栈**字符串**当 body（脚本继续跑垃圾数据），我们抛错（宁炸不猜优先）。`__elem.*` 元素桥的 cheerio 解析走**单条缓存**（一条 `els.get(i).text().attr()` 链对同一片段发多次宿主操作，逐次全量解析等于 N 遍；不用 Map——键是站点可控的 HTML 串，留清单就是留内存增长口）。
- 测试钉子：`tests/engine/js-bindings.test.ts`「java.ajax 同步语义（worker + SAB RPC 桥…）」（同步消费 + 链式 `.match` + 失败如实抛）、「worker 路线自身的逃逸防御与超时」（`require`/`process`/`module` 在 worker 里同样不可见、`Function()` 构造抛 `JsSandboxError`、同步死循环报 `脚本超时（>Nms）`；用例靠 fetch 计数自证真走了 worker 那条路，不是主线程用例的复述）、「等价写法同语义：java["ajax"] 与注释干扰都不再改变返回类型」（三种拼写一律 `typeof` 得 `string`，各一次 fetch）、「哨兵重跑不重复计日志、不多打站点，也不把哨兵当脚本错误上报」（用**解构**写法钉哨兵那条路——下标写法已被放宽的正则直接送进 worker，钉不到；`logs` 只一份、完成值照常、**fetch 计数为 1**，哨兵若挪到宿主调用之后即变 2）、「别名写法被脚本自己的 try/catch 包住也拿到同步语义（放宽正则后压根不抛哨兵）」；`tests/engine/json-parse-object-idempotent.test.ts` 的「worker 路与主线程同口径」三例（运行时 SyntaxError 只执行一遍并如实抛 / 脚本自带状态、第二遍不抛时也不许把首遍洗成 Miss / 顶层 return 仍回落 wrapped 且回落不多打站点——三例都按 fetch 计数自证真走了 worker）；既有 ajax 用例（注入 fetch 可 await / 无 fetch 报网络能力 / 逃逸防御）在 worker 路由下原样通过。

**元素桥与 org.jsoup 补充**（同二/三轮）：`org.jsoup.Jsoup.parse(html)` 以 cheerio 元素包装等价承接（白鹿书院形态：`doc.select(...)`/`.size()`/`.get(i)`/`.text()`/`.attr()` 链可用），其余 `org.*` 仍如实报需要安卓宿主；`java.getElements/getElement` 对 jsonpath/js 的 value/list 产物如实映射条目（此前只认 nodes → JSON 数据面恒空数组）；**JSON 页 `result` 对象绑定**（legado setContent isJSON 口径）：js 段上游是整页/条目且原文是合法 JSON 时，脚本首段 `result` 按**解析后的对象**绑定（`result.chapterTitle`、`result.data.list` 字段访问形态——JSON API 源目录/正文脚本的主导写法；HTML 页仍是元素包装，字符串方法照常）。沙箱 `result` 三态由此收口：JSON 对象 / 元素包装（String 对象）/ 原文字符串，均按「上游是什么」如实绑定。

**二轮补齐（同审计驱动，测试钉子同上两文件 + js-sandbox/variables/allinone 既有套件）**：

1. **元素包装对象**（`js-sandbox.ts` BOOTSTRAP + `__elem.*` 物理通道）：js 段上游是节点集（`resultKind==='nodes'`）或 HTML 页原文（`'page'` 且含标签）时，`result` 被包成 **String 对象**（字符串方法照常：match/replace/模板串），额外挂 `attr(name)`/`text()`/`html()`/`select(rule)`/`toArray()`/`first()`/`size()`——legado JSoup Element/Elements 的最小仿真，宿主侧经 `__elem.*` 用 cheerio 同步求值（与 console.* 同为引导层特判通道，不进协议表——它不是 java.* 面）。`java.getElements/getElement` 返回值同样包成元素包装；且两者对 **jsonpath/js 的 value/list 产物**如实映射条目（此前只认 nodes → JSON 数据面恒空数组）。
2. **js 数组产物元素字符串化**（`js-sandbox.ts` 的 `serializeJsElement`）：字符串原样、String 对象取原文、带 `html` 字段的对象取 html、其余 JSON.stringify——与 jsonpath 元素口径一致，`<js>java.getElements("$.list[*]")</js>$.name` 这类「js 产条目 → 继续取字段」形态成立。
3. **cache 垫片**（协议表 `cacheGet/cachePut/cacheDelete` + SANDBOX_MOUNTS.cache）：legado CacheManager 最小仿真（按源隔离进程内键值表）——真实源搜索面 `cache.put`、目录面 `cache.get` 的跨面形态（快看漫画）。
4. **AES 解密桥**（协议表 `aesBase64DecodeToString` + 引导层 `createSymmetricCrypto(t,k,iv).decryptStr` 链式外壳）：legado 正文解密形态，Node crypto 实现（AES-CBC/ECB + PKCS5/7，key/iv utf8）；密文/密钥不合法 → `JsSandboxError('AES 解密失败…')` 宁炸，`encryptStr` v1 不支持。原先两者都在「需要安卓宿主环境」名单里。
5. **`@put` 裸值与键访问**（`variables.ts`）：无引号值收（真实源 `@put:{cid:ComicID}`），且按 legado LinkedTreeMap 口径**先按键访问当前 JSON 条目**（`{img:pic}` → `vars.img = 条目.pic`），未命中/非 JSON 上下文 → 字面存。**带引号的值不参与这层推断**（`{img:"pic"}` → `vars.img = 'pic'`）：引号是作者显式表达「我要字面量」的唯一记号，`parsePairs` 第三元把它带到 `evalPut`——丢了它，同一份数据下字面量与键访问两种写法会互相覆盖（2026-09 审查修，钉子「带引号的值是显式字面量」）。豁免只到键访问为止：`$.`/`@json:` 前缀与不支持的规则形态即便带引号仍按声明处理（那是显式语法记号，不是推断）。
6. **AllInOne 行内标志**（`allinone.ts`）：模式开头 `(?s)`/`(?i)`/`(?si)` 剥离转 JS flags（Java 正则写法，JS 无行内标志——此前直接编译必炸 Invalid group）。
7. **方括号索引**（`parse.ts` 的 `splitBracketSuffix` + `select.ts` 的 `applyIndex` range 分支）：legado ElementsSingle `[n]` / `[a:b[:c]]`（**闭区间**、负数从尾数、端点越界钳边、step 缺省按方向自动——`[-1:0]` = 整表倒序）/ `[!n…]` 排除；**多条目并集 `[a,b,…]`（可与区间混写）已收**——`select.ts` 的 `positionsFor` multi 分支按 legado `indexSet` 口径：去重、越界条目静默丢弃、**按写入序取位**（对面 `for (pcInt in indexSet)` 走 LinkedHashSet 插入序），全越界 → Miss。点号形态 `tag.li.0:2` 走同一个 multi（冒号是索引分隔符，见「legado 取值语义订正」）。
8. **book 变量补字段**（`services/reading.ts`）：`origin`（源 baseUrl——努努书坊 `{{book.origin}}/e/...`）、`tocUrl`、书架上的 `name`/`author`。
9. **摘要 / HMAC 族**（`js-utils.ts` 的 `jcaHashName` + 协议表四行 `digestHex`/`digestBase64Str`/`HMacHex`/`HMacBase64`）：对面 `help/JsEncodeUtils.kt` 的「消息摘要/散列消息鉴别码」段。**三条不显然的口径**：① 实参顺序是 **data 在前、算法在后**（照抄签名，反过来等于把 API 做坏）；② `HMacHex`/`HMacBase64` 是**大写 H 开头**的畸形名——照搬对面（它靠 `@Suppress("FunctionName")` 保住这个名字），不许"顺手规范化"成 `hMacHex`；③ 算法名是 **JCA 名**（`SHA-256`/`HmacSHA512`）而 node 要 `sha256`/`sha512` → 显式映射表，认不出**点名原样算法名**抛错（对面此时是 `NoSuchAlgorithmException`；静默退成 md5 会产出看着合法的错摘要）。刻意不用 `crypto.getHashNames()` 当白名单：本仓实测 vitest 的 node realm 没有该方法，拿它做判据会让整桥在加载期炸。**期望值全部由 openssl 3.5.6 独立算出**（node crypto 就是实现本身，自证无效），其中 `HMacHex('Hi There','HmacSHA256',0x0b×20)` 那条与 RFC 4231 test case 2 的公开值一致——两条来路对得上才敢钉。钉子：`tests/engine/js-protocol.test.ts` 的「摘要与 HMAC 族」。

## legado 变量与链首上下文（2026-09「彻底兼容」第一批）

背景：目标是逐条对齐 legado 3.26 书源格式（语义清单见会话产出的参考盘点，不入库）。第一批由本机库真实形态驱动，四条语义：

1. **`@put:{…}` 是文法区域，体内 `@` 不是段界**（`grammar.ts` 的 `putRegionEnd`，`parse.ts` 的 `splitElements` 消费，与 `jsRegionEnd` 同族）。legado 的 `splitPutRule` 在任何切分**之前**先剥离 `@put:(\{[^}]+?\})`；本仓过去按 `@` 盲切，把 `@put:{n:"[property$=book_name]@content", …}` 撕成七段，当场解析期抛错——本机 4 源（万象书城 / 夜伴书屋 / 圣墟小说 / 全本小说）的 `ruleBookInfo.init` 全是这个写法。吃到第一个 `}` 为止：legado 的正则同样不嵌套，值里带 `}` 的规则在对面也是残规则，不另造更宽的判据。
2. **`@put` 的值 = `getString(值)`**（`variables.ts` 的 `evalPut` 第 5 参 `subEval`，由 `evaluate.ts` 的 put 分支接线，基内容 = 当前链值、未起链则整页原文）。legado `putRule` 逐字就是 `put(key, getString(value))`，所以 `[property$=x]@content`、`//xpath`、`i@text` 这类值必须**按子规则求值**，v1 的「只收普通串或 JSONPath」白名单被推翻。同步推论：`getString` 从不返回列表 ⇒ 多值 `\n` 拼接存（原「JSONPath 结果是 List → 抛」两条钉子按此改写）。值里含 js 段仍走同步子环路 → 如实抛「子规则内不支持 js 段」，不静默取空；`subEval` 未接线的直测路径也如实抛，不降级成字面存。
3. **纯 `@put` 的规则「只设变量、不取值」**：`parse.ts` 的 `isPutOnlyRule`（进 barrel）把这句话留在引擎里，服务层（`reading.ts` 的 `detailContextOf`）据此**不换根**——legado 剥掉 @put 后规则为空、`AnalyzeByJSoup.getElements` 对空规则返空集，取不到新根；本仓若打成「零命中」抛 `RuleEvalError`，等于把一条合法规则判成失效。
4. **链首裸取值终端的上下文 = 文档根，不是 `$('*')`**（`select.ts` 的 `isGetValueSegment` + `evaluate.ts` 的 default 分支）。`$('*')` 会让每个祖先各出一份文本：真源 `ruleToc.chapterName: "text"` 实测章名三遍（`<html><body><a>x</a></body></html>` → 三份）。选择段（`class.x` / `tag.a` / `text.串`）仍从全集往下选，`xpath` 分支早有同形先例（链首 `$().root()`）。

**顺带修正**：`@get:{name}` 花括号形态此前留下名字 `{name}`（legado `evalPattern` 是 `@get:\{[^}]+?\}`），现剥括号取内名——真源详情面整条规则就是 `@get:{n}`。

**`{{…}}` 也是文法区域**（`grammar.ts` 的 `braceRegion`，与 `putRegionEnd` / `jsRegionEnd` 同族）：legado 的 `evalPattern` 在任何 `@` 切分**之前**先匹配 `{{[\w\W]*?}}`，所以 `&nbsp;{{@@[property$=description]@content}}`（本机 4 源 `ruleBookInfo.intro` 实证形态）在对面是一条模板字面段 + 区内子规则；本仓此前只在字面段（`literal.ts`）认括号、链切分不认，于是把区内的 `@` 当段界撕开，尾段剩 `content}}` 认不出模式 → 解析期抛错。现 `splitElements` 遇 `{{` 调 `braceRegion` 整体跳过，字面段解析改用同一个口（原来那份私有括号扫描已删，不留第二份抄本）。**刻意比对面宽**：`braceRegion` 做引号感知与嵌套深度，`{{ 'a}b' }}`、`{{ {x:1} }}` 在对面（非贪婪 `*?`）会截断成残表达式，本仓按完整区域收下——放宽只让此前必炸的写法活下来，不改变任何原本能跑的规则的读数，故不构成口径漂移。同段另钉**「整段翻转为 Regex」的可观测等价**：模板段 / `@get:` 段带 `##` 替换尾时先展开、展开结果直接进替换，不回头从页面取根（`tests/engine/content-facet.test.ts` 两条 `##` 钉子）。

**`@@` 在链首此前必炸**（建覆盖矩阵时补的钉子抓出来的）：`splitElements` 遇 `@@` 只 `i++`、不吃第二位，第二个 `@` 随即被当成段界，于是 `@@css:.x`（legado「`@@<rule>` 强制按 Default 处理」形态）被切成 `['@','css:.x']`，第一段认不出即解析期抛错。现 `i += 2`，转义段自带前导 `@`，交 `classifySegment` 剥一位后按常规识别（`tests/engine/parse.test.ts` 的 `it('@@ 段内剥一个 @ 后按常规识别')`）。同批补上此前「只有代码、没有标题钉子」的两条抛错口径（位置索引与 `!` 排除并存）。

**这批另两件产物**：`tests/legado-coverage/matrix.ts` + `coverage.test.ts`（legado 语义覆盖矩阵——每条 legado 语义登记为 实现 / 环境不适用 / 待拍板开口，逐行验证据可回查，是这条兼容线的唯一读数口）；`docs/design/legado-compat.md`（「不适用」的理由清单，矩阵的 doc 锚点落在这里）。

**被否决的方案**：① 在 `splitElements` 里就地写一份 `@put` 花括号扫描——否，文法认知归 `grammar.ts`（构词与解析同属一处），否则又一处抄本；② 让 `evalPut` 自己 import `evaluate` 求值——否，`evaluate → variables` 已是单向依赖，反向即环（`resolveJsonData` 当年就是为破这个环搬进来的）；③ 用「链尾剩 Miss」冒充「只设变量」让服务层按 `detail` 文案判——否，`EngineValue.miss.detail` 是给人看的，判据必须是结构；④ 把链首取值终端的产物去重折叠成一条——否，那是掩盖错误的上下文，`textNodes`/`html` 在链首同样该以整篇为一次上下文，去重会把真多值抹掉。

**仍开口（本批如实记下）**：`ctx.vars` 现在只在**单次门面调用**内共享（`reading.getDetail` 一张表；`getToc`/`getChapter` 各自新建），legado 的四级作用域链 `chapter → book → ruleData → source` 未建模——跨面透传变量（目录里 `@put`、正文里 `@get`）暂不成立，出现真源再按那一源来定形状，不预先造作用域层。
**jsoup 的「活节点」导航面未接**（矩阵 `h-jsoup-live-node-navigation`）：对面的条目元素活在解析后的页面树里，脚本可以 `result.parent().children().get(i-1)` 这样横向/纵向跳；本仓的条目是**脱离文档的 outerHTML 片段**（逐条 `ctx.html`），片段的父与兄弟在数据里不存在——这不是缺桥方法，是条目形状差异。现量 1/158（金银小说网 `coverUrl` 用它取「前一个兄弟里的图」当封面，且脚本包在 `try{}` 里 → 今天表现为封面静默为空，不报错）。要接得先把条目改成携带 (文档, 选择器) 的形状，牵动条目提取 / 缓存 / 去重三处，属独立工程。已解决（原列此处）：XPath 父步 `..` 已实现（`xpath.ts` 的 `parent` 轴 + 矩阵 `a-xpath-parent-step`），文档根之上自然零命中而非猜成 `<html>`。

## legado XPath 父步（2026-09「彻底兼容」第二批）

**父步 `..` 是真机需求，`@*` / `.` / ancestor 不是**——先普查再动手：本机库 144 条 XPath 段 / 12 源的步骤形态逐条分类，白名单外的**只有**父步（2 源 4 条规则、两种形态：正文 `//a[text()="下一页"]/../../../preceding-sibling::div[1]`、目录 `//a[text()="下一页"]/../following-sibling::li/a`）；属性通配 `@*`、自身步 `.`、`ancestor::` 等轴实测零需求（复算口径：本机库每条含 `/` 的规则过 `parseStep` 按步骤形态分类，白名单外者点名——判据在册在 `xpath.ts`，不依赖一次性脚本）。因此这一批只加 `parent` 一条轴（`xpath.ts` 的 `parseStep` 认 `..` → `{ axis:'parent', test:{kind:'star'} }`，`axisPool` 取 `ctx.parent`），其余越界照旧解析期抛错——**边界不是拍脑袋收窄的，是量出来的**。

两个刻意保留的口径：
- **节点测试用 `*` 而不是特判**：`..` 攀到文档根时根节点 `type !== 'tag'`，被自然过滤 → 零命中 `Miss`。否决方案是「根当 html 用」——那是猜，且会让 `//x/../../..` 这类越界规则静默出数。
- **父步上的谓词按分组生效**（`..[1]` 取到父本身，因为父在自己的分组里是第 1 个）：与既有「谓词按父分组」口径同源，不另开分支。

顺带删掉 `xpath.ts` 里与 `AXIS_NAMES` 重复且从未被引用的 `AXES` 常量——同一份轴白名单不留两份抄本（本批正是改这份白名单的那只手）。

### 三条切分口径（同批全库普查残留 13 → 3；2026-09-22 复判为 0，见下）

普查口径：本机 158 源的 2327 条取值规则逐条过 `parseRule`（普查口径：登录 URL / jsLib 字典 / headers 这类**不进 parseRule** 的字段要剔除——早先一版没剔，虚报了 4 条）。修掉的三条：

1. **`{{…}}` 区内的 `||`/`&&`/`%%` 不是连接符**（`parse.ts` 的 `splitTop` 现跳过 `grammar.braceRegion` 区）。此前分支切分先于段切分发生，于是 `{{@css:.a@text||.b@text}}`（英文小说 `ruleContent`）在 `||` 处被劈成两支，第二支尾巴 `text}}` 认不出 → 解析期炸；米读小说 4.9KB 的 `ruleDetailIntro` 更狠：`{{(function(){…&&…})()}}` 里 JS 的 `&&` 被当连接符 → 判「一条规则混用了多个连接符」。对面靠 `makeUpRule` **先插值、后 splitRule** 天然没这问题——顺序即口径，本仓补的是同一件事。
2. **XPath 主导链的裸 `@终端` 是下一级规则**（`splitElements` 的 `xpathPending` 现按括号/引号深度判定，深度 0 且前一位不是 `/` 才切）。此前 `//a[…]@html` 的 `@html` 被整段吞进 XPath path，`xpath.ts` 再把 `preceding-sibling::div[1]@html` 当一个步骤 → 「XPath 步骤不支持」（腐小说 `ruleContent`，本批父步修好后暴露的下一层）。对面 `RuleAnalyzer.splitRule` 是先用 `chompBalanced` 拉出 `[...]`/`(...)` 平衡组、再在 `@` 处切，同结果。**刻意保留的两处不对称**：谓词里的 `[@id="x"]` 在深度内不切；斜杠属性步 `/@href` 留在 path 里——本仓 XPath 求值器已把末段属性步实现为提取，切出来反而多一段，且 144 条真源 XPath 段全部按此形态跑得通（`tests/engine/parse.test.ts` 三条钉子钉住两种形态的边界）。
3. **空白段不成段**（`splitElements` 末尾 `filter(el => el.trim() !== '')`）。`</js>` 块后紧跟换行再接 `##` 替换尾（世界名著网 `ruleBookUrl`）会留下一个只含 `\n` 的段 → 「无法识别的段类型」。对面 `RuleAnalyzer.trim` 明确跳过 `queue[pos] < '!'` 的字符、列表切分 `filterNot { it.isBlank() }`。**分支级同款**（`parseBranch` 返回 null 即丢该分支，矩阵 `a-blank-branch-dropped`）：`A&&&&B`、尾随 `&&` 这类切出的空白分支，对面 `splitRule` 并不滤空串，但空规则取值是 `getElements("")` → 空列表，合并时自然不贡献——等价于丢分支而不是整条失败。本仓此前抛「空分支」，把对面读得出的规则整条判死（解析面普查第 22 批从真源 `ruleBookInfo.kind` 抓到的），现与 `rest === ''` 同路：零分支即空，不产假值。

剩下 3 条（3 源）当年判成**错误策略差异**：`text下一页`、`chapter.chapterContent`、`href\n书名h4` 在对面也会被 jsoup 当标签/属性名选择器 → **静默取空**（见矩阵行 `a-lazy-branch-parse`）；差别只在对面按序试 `||` 分支、坏分支不拖垮好分支，而本仓在解析期整条抛错。**2026-09-22 复判后归零**：前两条是构词侧认错了（对面 `ElementsSingle.getElementsSingle` 的 else 分支 = `temp.select(beforeRule)`，白名单外的 `词.词`、非 ASCII tag 在对面的名字是 CSS 选择器，本仓现于解析期定性成 css 段），第三条含换行、构不成选择器语法，现库无实例。**「宁炸不猜」没有被放宽**：解析面普查现量（214 源 / 4170 条规则串）被拒的只剩 5 条 3 源，全是裸索引段族（矩阵 `a-bare-index-segment`），与惰性分支无关。惰性这件事只剩原则（真·未识别语法的分支仍会连坐），登记在矩阵 `a-lazy-branch-parse`，等真出现再拍板。

### 变量读链：四级里本仓接了两级

对面 `AnalyzeRule.get` 是 `chapter → book → ruleData → source` 四级，每级
`.takeIf { it.isNotEmpty() }`——**空串不算命中、继续下找**；`put` 则停在第一个存在的宿主
（Kotlin `?:` 只在接收者为 null 时下滑，所以有 chapter 就永远写 chapter）。本仓
`ctx.vars` 是「本次门面调用」那层（≈ ruleData/chapter），`ctx.sourceVar` 接的是 source 层，
与 `source.get/put`/`getVariable` 同一张按源隔离的表。两处不显然的口径：
① 接 source 层只能用 **peek（非建档）** 访问器——`session.sourceVars()` 一调就建表，会把
`source.getVariable()`「从未设置 ⇒ 空」的语义改掉（本仓有钉子，第一版直接接 Map 当场报红）；
② 访问器是惰性的，所以「同一次调用里先 `source.put` 再 `java.get`」也读得到。
还缺的是 chapter/book 两个**持久化**层（对面 `Book.variable`/`Chapter.variable` 落库）：
「目录面 @put、正文面读」这类跨门面用法本仓仍 Miss——补它要先定书/章变量表的落盘与代际清理，
不是引擎改一行（矩阵 `a-var-scope-chain`）。

### JSON 条目上的裸词终端（对面按内容类型分派，本仓此前只会问 DOM）

真源 `ruleChapterUrl: "url"` / `"href"`（麻豆传媒AI、中文书城、全本小说型——`ruleChapterList` 是 `@js:` 产出的 JSON 条目）。对面在 `model/analyzeRule/AnalyzeRule.kt` 按 `isJSON || ruleStr.startsWith("$."|"$[")` 分派：内容是 JSON 时**整条规则走 `AnalyzeByJSonPath.getString`**，于是裸词 `url` 是属性读，根本不碰 DOM。本仓把 JSON 条目原文串放在 `html` 里逐条求值，裸词终端（`select.ts` 的 `mode === 'attr'`）只在 DOM 上找同名属性 → 恒 0 命中 → 逐章回退目录页 → 服务层判「ruleChapterUrl 整体失效」抛 `RuleEvalError`。

现在 `evaluate.ts` 的 default 分支先问一句 `jsonObjectOf`：**当前内容本身是合法 JSON 对象**时，把裸词终端（`attr` 的未知词，以及无参 `href`/`src`）按 `$.<名>` 求值。边界与理由：
- **HTML 片段一律不抢**（不以 `{` 开头直接返回 undefined），所以 `img@_src`、`<a href>` 既有语义分毫不动（两条钉子各钉一侧）。
- **只在链首/上游是 Value 且未挂索引与排除**时介入——`seg.index`/`exclude` 的语义在 JSON 侧没有对应实现，宁可不接也不猜。
- **`id`/`class`/`tag` 不在内**：对面 `getElementsSingle` 按关键字认它们（`"id" -> Evaluator.Id(rules[1])`），本仓同理是选择段，所以 JSON 里名为 `id` 的字段要写 `$.id`。这一条差异登记为开口 `a-json-context-selector-modes`，未拿到真源需求前不翻 HTML 侧既有读法。

### js 段的 `result` 是元素**集**，不是单个元素


真源 toc 模板（废纸文学 / 新龙小说 / PO5 三家共用同一份拷贝）写 `class.X@li<js>list = result.toArray(); … for(i in list){ l[s[i]] = list[i] }`。对面这条链上 `result` 是 `org.jsoup.Elements`——一个**集合**。本仓此前把 nodes 结果包成「一个 String 对象 + 几个方法」（`mkElem`），于是：

- `size()` 恒 1、`toArray()` 只出一个成员（宿主桥 `case 'split'` 取的是 `root().children()`，parse5 会把片段挂进 `body`，根下只有一个 `html`）→ `size()/get()/each()` 全错位。现取 `body` 的顶层子元素，`size()` 按真实成员数算，并补 `get/eq/each/last`。
- 集合助手挂在数组对象上是**可枚举**属性 → `for (i in list)` 会把 `toArray`、`size` 也当元素遍历，当场炸「list[i].text is not a function」。Rhino 给的是 Java 数组，`for-in` 只出下标。现用 `Object.defineProperty(…, {enumerable:false})` 挂，与对面一致。
- **列表用途下前一段零命中时，`result` 仍是空集合**：对面空 `Elements` 照样带方法，脚本走完得到空目录；本仓此前退化成原文字符串，同一份脚本在第一行就抛 `JsSandboxError`。后果不只是报错难听——审计里「站点页面没有这个结构」会被记成**引擎侧失败**（判据②的分母被污染）。分派身份用 `ParsedRule.usage`（对面 `getElements` / `getString` 两条路径的本仓对应物），取值路径不变仍是字符串。

钉子：`tests/engine/js-sandbox.test.ts` 的两组（空集形态 / 元素集表面）+ `describe('元素桥 remove()…')`。**`Elements.remove()` 已补**：片段不再住构造常量而是住 `box.html`，`元素.select(规则)` 把 `owner={box,rule}` 交给集合，`remove()` 让宿主（`js-sandbox.ts` 的 `case 'remove'`）摘完节点按**原形状**串化回写——对面是活 jsoup 文档，且 `Element.remove()` 只把节点从父上摘走、子树跟着节点走（环安小说网那条 `select("p,script,div")` 连元素自己都命中，摘完 `html()` 仍要读到幸存的 `<em>`，故宿主在摘前先记下顶层节点）。仍**不支持**的是没有可回写片段的集合：`java.getElements(...)`、`toArray()`、集合级 `select()` 的临时聚合——它们的 `remove()` 如实抛，不静默 no-op（静默等于把脏节点当已净化交给正文）。同一改动让 `String(元素)` 走 `toString` 读 `box.html`，摘除之后的整树串化才对（悦读小说 `doc.select(".articleHide").remove(); doc` 形态）。

**列表路径 vs 取值路径的分派**（同批续）：上面那组方法挂在 `mkElem`（String 对象）上，但 `result.forEach(...)`（西瓜书屋 `ruleChapterList`）与 `r.length - v`（穿越小说）要的是**集合**——对面的分派轴正是 `getElements` / `getString` 两条路。于是 `JsHost` 带 `resultCtx`（值就是 `ParsedRule.usage`，不新建第三份判定表）：列表路径下 nodes 结果绑成 `wrapElems`（原生数组 → `forEach`/`length`/下标天然成立，另挂 `size/get/eq/first/last/each/toArray/attr/text/html/select`，`toString` 按 `Elements.toString` 语义**无分隔**拼接 outerHTML），取值路径仍是字符串对象（`length` 是字符数）。两侧各有钉子，含一条专门钉「取值路径没有集合方法」的边界。

**book/chapter 是实体不是字典**（同批续）：对面 Rhino 直绑 Kotlin `Book`，脚本会调 `book.setType(4)`（终极全栖）、`book.getVariable("custom")`（穿越小说）。`mkHostObj` 在沙箱里给镜像补上 `getType/setType`、`getVariable/putVariable/removeVariable`、`getName/getBookUrl/getOrigin`。两处刻意分开：Book 变量表与 source 变量表**互不串味**（对面 `Book.variables` 与 `BookSource.variables` 本来就是两个存储，钉子钉住），以及 type 只落回镜像字段——**落库不在本层职责**，本仓也没有 Book 级持久变量存储，所以变量只活一次规则调用（对面跨启动持久；穿越小说恰好只读用户手设值，取不到即空串走默认分支，与对面"未设置"同形）。

## legado 取值语义订正（2026-09-23，与对面同输入对读）

背景：兼容目标判据是「对面能正确解析的书源，本仓也能」，而覆盖矩阵只验**证据存在**（实现符号在代码里、测试标题在用例里），**不验两边取值是否相同**（`tests/legado-coverage/coverage.test.ts` 头注自己写着「覆盖矩阵绿 ≠ 本插件什么都能干」）。这一批是把三条**已标 implemented、实际给错值**的语义按对面改齐——三条都在本仓 HEAD 上离线复现过，对面的期望值出自 `model/analyzeRule/AnalyzeByJSoup.kt` 与 `model/analyzeRule/AnalyzeRule.kt` 的代码路径。

1. **点号位置后缀的冒号是索引分隔符，不是区间**（`parse.ts` 的 `parseIndexSuffix` → `select.ts` 的 `positionsFor` multi）。对面 `ElementsSingle.findIndexSet` 的 legacy 分支对 `.`/`:`/`!` 一律「下一个数字进 `indexDefault`」（它自己的文档注释给的例子就是 `tag.div.-1:10:2` = 三个索引）。本仓此前把 `.a:b` 读成半开切片：四项列表上 `tag.li.0:2@text` 出 A、B，对面出 A、C；`-1:10:2` 这种对面合法的写法更被当选择器当场炸掉。**IndexSpec 的 `slice` 形态随之删除**（对面没有这个概念，`reducePicked` 因此从四态收为三态；JSONPath 自己的切片是另一套 token，不动）。
2. **多条目取位按写入序，不按文档序**（同一个 `positionsFor`）。对面 `for (pcInt in indexSet) es.add(elements[pcInt])` 走 LinkedHashSet 的插入序，所以 `[3,1]` 出「第4个、第2个」。此前本仓 `sort` 成文档序，并在文档里写成「写序不影响结果」——那是一句把差异讲没的话。**订正**：矩阵 `a-bracket-multi` 与本文的方括号索引节都改了；`select.test.ts`/`content-facet.test.ts` 里钉文档序的预期同步改判。
3. **OnlyOne（`###`）= 先截取首个匹配、再在其内替换**（`replace.ts`）。对面 `AnalyzeRule.replaceRegex` 的 replaceFirst 分支：`regex.find(result)` 拿 `match.value`，再 `match.value.replaceFirst(regex, replacement)`，无匹配给**空串**。本仓此前做成「原文里只改第一处」——`aXaX` 经 `##X##-###` 对面得 `-`、本仓得 `a-aX`，净化尾留下本该被裁掉的尾巴。捕获组引用（`$1`）因此在**截出的那段**内解析。
4. **组合符按用途分派形状**（`combine.ts` 新增 `CombineOpts.usage`，取 `ParsedRule.usage`，与沙箱 `resultCtx` 同一份分派轴、不新建第三份）。对面两条路径的合并代码各写一份且不同：列表路径 `getElements` 每支产出 Elements、`&&` 是 `elements.addAll(es)`、`%%` 的驱动长度取 `elementsList[0].size`（**空首支也占第一位** ⇒ 整条为空）；取值路径 `getStringList` 的 `results` 只收非空支、`%%` 驱动取 `results[0]`。本仓此前：`&&`/`%%` 的合并循环只认 value/list 两种 kind ⇒ **节点分支什么也不贡献**，`tag.li&&tag.ul`（3 个 li + 1 个 ul）在列表用途下合并成空 List = 目录整块消失且不报错；`%%` 又循环到 maxLen，把长分支尾项多产出来。现在：全节点 → 合并/交叉出节点集，混节点与字符串 → `UnsupportedRuleError`。
   **为什么混形状要炸而不是「谁有用取谁」**：对面列表路径的分支只会是 Elements、取值路径只会是 `List<String>`，混形状在对面**没有对应语义**；静默丢一侧正是本仓定的最高罪（空结果冒充失败）。被否决的替代方案：把字符串分支按 HTML 解析成节点再合并——那是给对面没有的形态发明行为，且会让 `&&` 的产物随分支顺序漂移。

**同批对读出来、刻意没在这一批动的**（都已在矩阵登记为 open，附对面锚点）：

- `a-allinone-group-zero`：对面 AllInOne 的行**含 group 0**（`AnalyzeByRegex` 从 `groupValues` 下标 0 起收），字段规则的 `$1`/`$2` 由 `SourceRule.splitRegex` + `makeUpRule` 按组号从那一行取值。本仓行里只有 group 1..n，且**没有 `$n` 映射**（`bridge.firstValue` 取 `rows[i][0]`、`extractItems` 把整行 `join('\t')` 当条目上下文）。**两件事耦合**：只补 group 0 会让 firstValue 从「首捕获组」变「整段」、extractItems 出重复内容——把现在能读的源改坏，所以按「一起做」排队。
- `a-replace-tail-single-pair`：对面一条规则**只有一对** `##pattern##replacement`，存在第 4 段仅表示 `replaceFirst=true`（第 4 段内容作废）；本仓 `parseTails` 把尾部两两配对成多步。改它要连带重做 `appendTail` 的 round-trip 自校验与 normalize 的方言拼串（`authorPrefix`/`replaceRegex` 都走那条口）。
- 惰性 `||` 分支（`a-lazy-branch-parse`）：对面 `getStringList`/`getElements` 的分支循环是「取一支、非空即 break」，本仓 `ruleGen` 先把所有分支求完再 combine——首支已命中时，坏分支仍会把整条炸掉。**这条不是取值差，是求值策略差**（对面同一支坏语法同样会抛，只是抛不到），排在上面这些之后。
- 元素/桥侧的三条契约错值（`h-get-string-unescape-flag`、`h-source-variable`、`b-opt-method-head`）与正文 `replaceRegex` 的阶段错位，属服务层与沙箱桥，见 `docs/design/services.md` 与矩阵行本身的 note。

**门况**：`pnpm test`（含 `tests/legado-coverage/` 五道门）+ `pnpm typecheck` 全绿；改动落在规则引擎，按 AGENTS.md 的纪律另跑真链路门（`DSH_REPROBE` / `DSH_CONTENT_AUDIT`），读数如实写进汇报，不拿「没有异常」当兼容证明。



## 已知开口

**历史里已被推翻的结论（别按它们改回去）**

本仓早期开发过程文档（逐任务计划 / 审查报告 / 任务简报）已出库，且**不再保留副本**。下面这些结论曾写在那些文档里，**与现在的代码相反**——若从旧笔记、旧会话或别处翻到，照抄即回归：

| 早期文档里的旧结论 | 现在的代码 |
| --- | --- |
| `&&`/`%%`「任一分支 Miss → 整体 Miss」 | 空/Miss 分支静默跳过、只合并非空结果（legado 并集语义；`combine.ts` 注释「此前实现为『任一 Miss → 整体 Miss』」记着这是曾发布的 bug） |
| `text` = 严格直系文本 | `text` = 全部后代文本（`select.ts` 的 `case 'text'` 注释「实测打不动真实源」记着旧实现为何被推翻——正文整本读不出）；直系文本是 `ownText` |
| JSONPath 不接受负号 | 下标与切片都支持负数从尾数（`jsonpath.ts` 的 `/^-?\d+$/` 与 `/^(-?\d+)?:(-?\d+)?$/` 两条解析分支） |
| `<js>…</js>` 只能作为分支末段 | 可出现在任意位置、块后无 `@` 直接续段（`grammar.ts` 的 `jsRegionEnd`、`parse.ts` 的 `splitElements` 内 `<js>` 分支，注释「块起始即隐式段界」） |
| `evaluate(rule: ParsedRule, ctx): EngineValue`（同步、只收 AST） | `async evaluate(rule: string \| ParsedRule, ctx, facet='rule')`（`evaluate.ts` 的 `evaluate`）；`parseRule` 不在公开面 |
| AllInOne 零匹配 → `List{rows:[]}` | `List{items:[]}`（`allinone.ts` 的 `evalAllInOne` 尾返回） |
| facet 表没有 `rule` | `Facet` 含 `rule`（缺省面）与无生产调用方的 `explore`（`types.ts`） |
| `preceding-sibling` 按文档序编号 | 已按逆文档序修正（`xpath.ts` 的 `axisPool` `case 'bwd'`：`sibs.slice(0, i).reverse()`，测试改判 `[1]`=最近前序） |
| XPath 只认 `@XPath:` 前缀 | 裸 `//`/`.//`/`/` 前导同样识别（`parse.ts` 的 `raw.startsWith('//')` 分支）；`init` 段仍未实现——真源驱动，无实现即抛错 |

**代码内仍开口的**

10. `engine/types.ts` 的 `Facet` 含 `'explore'`，全仓无生产者/消费者（`normalize.ts` 的 `field: 'ruleExplore'` warning）。
11. `engine/evaluate.ts` 的 `evalNonJs` 里 `case 'allinone'` 与 `case 'getvar'` 不校验链位（只有 `allinone` 经 `evaluate.ts` 的 `checkChainStart` 判「必须是分支首位」），但 `allinone` 实际靠 parse 的「整链以 `:` 开头」保证唯一性；`@get:name` 允许出现在链中段并替换链值（`evaluate.ts` 的 `case 'getvar'`）。`jsonpath` 中链已合法化（上游修复后 legado 语义，见「段链衔接的显式检查」）。
12. `engine/js-protocol.ts` 的 `BridgeDeps.contentBase` 是可变捕获状态：`java.setContent` 写它（`js-protocol.ts` 的 `method('setContent')`：`d.contentBase = …`）、`java.getString*` 读它（`js-protocol.ts` 的 `d.contentBase ?? d.result`）——同一次求值内多次 `setContent` 会互相影响（legado 同款，但未写进任何文档）。
13. 两项**需要拍板的未决口径**（`AuthRequiredError` 声明未落地、探针「分段 trace」无结构化字段）属服务层与 wire 面——不在本文重复，见 `docs/design/services.md` 的「已知开口」。引擎侧相关事实只有一条：`TraceStep` 目前只被 `evaluateWithTrace` 的生产者内部消费，没有第二个消费者。
14. `tests/reprobe.test.ts` 是「改动引擎/抓取后实测书源可用率」的唯一自动化验证，默认跳过（`DSH_REPROBE=1` 才跑）；`pnpm test` 全绿不构成真实站点兼容性证据。
15. 引擎的无回归门禁是「`tests/engine/**` 全绿 + `pnpm typecheck` 干净」两条；`vitest.config.ts` 把 `tests/compat/**` 与 `packaging-build.test.ts` 排除在常规集外（分别由 `pnpm test:compat` / `pnpm test:pack` 驱动）。改引擎后若只跑常规集，`compat` 回放与构建产物两条链是**没被验证**的。
16. `src/engine/` 20 个文件里只有 `index.ts` 有对外承诺；`parse.ts` 的 `KNOWN_MODES`、`HTML_TAGS` 与 `xpath.ts` 的白名单都是**手写清单**——扩方言时它们不会因为别处改动而自动跟随，测试是唯一守卫。
17. **`scriptForm` 省缺值两条路不一致**（需要拍板）：worker 路取 `opts?.scriptForm ?? true`（省缺即脚本形态），主线程路取 `opts?.scriptForm === true`（省缺即 wrapped 函数体）——同一个省缺在两条路上语义不同。哨兵重跑走 worker 路，因此也是 `?? true`（即「主线程尝试省缺、重跑按脚本形态」在这条未决口径下同样分叉）。生产路径不受影响（`evaluate.ts` 的 `branchGen` 对 js 段**显式传 true**，`runScript` 也缺省 true，见「js 段 scriptForm 口径修正」），要统一得先定「省缺默认走哪条」并连带核对 `runScript` 与两条路的测试调用点。
18. **哨兵重跑的两处残余**（接受的残余，只落在真正的动态构造写法上）：`SYNC_WORKER_RE` 放宽后，`java.ajax(`、`java.downloadFile(` 与 `java[...]`（含计算键 `java['aj'+'ax']`——正则按字面文本命中它，进 worker 而不是撞哨兵）都直接进 worker，剩下能撞哨兵的只有解构 / `with` 这类脚本里没有那三个字面量的写法。它们：① 若在第一次 ajax **之前**做过非幂等写入（`source.setVariable` / `cache.put` / cookie 写 / `java.put` / `java.setContent`），重跑会执行两遍；② 若脚本用自己的 `try/catch` 包住该调用，哨兵在 vm 内被吞、重跑不触发，脚本静默走 catch 分支而拿不到 legado 语义。当前 228 源库里这类写法的源为 **0**；网络请求不受影响（哨兵在宿主调用之前抛，钉子按 fetch 计数钉死）。**这句别读成「worker 不会重跑」**：worker 内部另有第二条重跑路——运行时 SyntaxError 被按异常类名误判成顶层 return 形态 → 重跑 `wrapped`，那条**会**多打站点（ajax 已在第一次执行里发出去），2026-09 审查实证并已改判在编译期关掉，见「脚本形态」节。影子 `SourceSession` + 写回已被否决，理由与将来的正确修法（先做 worker 池再一律走 worker，把重跑整条路删掉）见「语义唯一：哨兵 + 透明重跑」的「唯一残余」。
19. ~~坏分支要不要惰性~~ **已消解（2026-09-22），不用拍板了**：当年列它是因为全库普查残留 3 条真规则走这一型。查对面 `ElementsSingle.getElementsSingle` 后知道那 3 条（`text下一页`、Default 链末段的 `text(…)` 等）在对面**不是"认不出"**——else 分支 `temp.select(beforeRule)` 就是当 CSS 选择器；本仓据此把它们在解析期定性成 css 段（边界见 `a-unknown-segment-throws`），**这条惰性需求没有实例了**：解析面普查现量（214 源 / 4170 条规则串）被拒的只剩 5 条 3 源，全是裸索引段族（矩阵 `a-bare-index-segment`），与本行无关。原则上的差异仍在（真·未识别语法的分支仍会连坐），矩阵 `a-lazy-branch-parse` 留作该情形的登记，等真出现再拍。

20. **`children` 的根上下文与对面分叉（真实存在，但**现库 0 需求方**，故不排期）**：`evaluateWithTrace("children", {html:"<div>…</div>"})` 在本仓给出 `<head>`、`<body>` 甚至**重复计入的后代**（span/p 各一次），对面 `Jsoup.parse` 的 Document 其 `children()` 只有 `[<html>]`；且本仓在取值用途、链尾无终端时把节点**序列化 HTML** 当值透出（`children.0` → `"<head></head>"`），对面走 `text`。影响面不止 `children`：任何依赖根子节点的规则（含 `kind: "0"` 这类纯索引段——矩阵 `a-bare-index-segment` 正因如此被撤回，不当可疑基座）都不同。修法两问要先定：① 根上下文取 Document 还是 body（对面 Jsoup.parse → Document，但 `AnalyzeByJSoup` 持有的是 Element，逐条要看它从哪儿接手）；② 无终端的 default 段该给 text 还是 html（本仓现给 html）。未定之前，普查里这两族保持在册登记。
