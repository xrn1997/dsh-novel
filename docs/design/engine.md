# 规则引擎（engine）

本文是引擎的现状真相（single source）；领域词汇见 `CONTEXT.md`——取值链、净化尾、规则文法、面、段、取值规约、方言、搜索面、请求组装一律用那里的词，别自造。

引擎的边界：`src/engine/**` 零 Cordis、零 `@deepseek-ai/*`、零网络——网络只以 `EvalContext.fetch` 注入函数出现。规则串 → 词法（`parseRule`）→ 求值（`evaluate`）→ `EngineValue`。

## 模块地图

| 文件 | 职责 | 关键导出 | owner 语义 |
| --- | --- | --- | --- |
| `engine/types.ts` | 值形状与 AST | `Facet`、`EngineValue`、`Segment`、`Branch`、`ParsedRule`、`EvalContext`、`RuleUsage`、`DEFAULT_JS_TIMEOUT_MS`(2000) | `EngineValue` 五态（miss/value/list/nodes/matches）的唯一定义处。`Facet` 比文档多一个 `explore`（无生产调用方，见「已知开口」）；`EvalContext` 另携 `book`/`chapter`（legado 脚本变量，服务层按面注入） |
| `engine/errors.ts` | 三类引擎错误 | `EngineError`、`UnsupportedRuleError`、`RuleEvalError`(+`hits`)、`JsSandboxError`(+`script`/`line`)、`isEngineError` | 段级定位文案的唯一格式化点：`[facet#段N] msg（规则片段: "raw"）` |
| `engine/parse.ts` | 词法流水线：字符串 → AST（零 IO） | `parseRule(rule, facet='rule', usage='list')` | 切分次序、段识别白名单、隐式 CSS 回落、位置后缀、**属性终端**（取值用途链尾未知词 = 属性名，见 CONTEXT.md「取值用途」）、**模板字面段**识别（判据借 `literal.isLiteralForm`；**插值优先于 `/`-XPath 前缀**——斜杠开头且含 `{{}}` 的是 URL 模板，顶点小说 tocUrl 实证）、「不认识就炸」的唯一位置 |
| `engine/grammar.ts` | 规则文法：构词与解析同属一处 | `parseTails`、`appendTail`、`withImplicitText`、`jsRegionEnd`、`isJsForm`、`splitVarExpr`、`isPureVarExpr` | `##` 净化尾与 JS 区域语法的唯一认知点；normalize 的方言拼串只能经 `appendTail` |
| `engine/literal.ts` | 模板字面段的识别与切分 | `isLiteralForm`、`splitLiteral`、`LiteralPart` | `{{expr}}`（JS/规则二分——以 `@`/`$.`/`$[`/`//` 开头按规则）与 `{$.path}` 单括号内嵌、`@get:`、`{{}}` 平衡括号切分的唯一认知点（parse 识别与 evaluate 消费共用同一份） |
| `engine/template.ts` | URL 模板插值 | `interpolateUrl(template, vars)` | `{{name||缺省}}` 的替换口；词法拆分借 `grammar.splitVarExpr` |
| `engine/dom.ts` | cheerio 封装与纯文本契约 | `loadHtml`、`cleanText`、`nodeText`、`htmlToText`、`looksLikeHtml`、`isNodeValue` | 「块级边界落成 `\n`」的正文契约唯一实现（不是 cheerio `.text()`） |
| `engine/select.ts` | default 选择段/取值段 | `reducePicked`、`applyIndex`、`applyExclude`、`evalDefault` | **取值规约的唯一实现**：`reducePicked` 管取位与空态裁决，`getValue` 管「元素在、取值全空 → 空 List」；`text.<串>` 按文本选元素（CONTEXT.md「按文本选元素」）与属性终端 `mode:'attr'`（空值丢弃 + 去重 + 向下兜底）同属此处 |
| `engine/css.ts` | `@css:` 段 | `evalCss` | 只做 `cur.find(selector)` + 消费 `reducePicked`；显式形态带 `!` 排除，位置后缀仅隐式回落形态携带 |
| `engine/xpath.ts` | XPath 子集求值器 | `evalXPath` | 直接在 domhandler 节点树上求值；轴/谓词/函数白名单与「位置谓词按父分组」都只在这里 |
| `engine/jsonpath.ts` | JSONPath 子集 | `evalJsonPath` | 手写 tokenizer；下标/切片负数从尾数与「取位失败 → Miss、空数组 → 空 List」的 JSONPath 侧口径 |
| `engine/allinone.ts` | AllInOne 整页正则 | `evalAllInOne` | 二维 `matches` 产物（条目×捕获组）唯一产地，永不压平 |
| `engine/variables.ts` | 变量段与 JSON 数据源 | `evalPut`、`evalGetVar`、`resolveJsonData` | `ctx.json` 优先、缺席回退解析 `ctx.html` 的口径 |
| `engine/combine.ts` | 组合符与反序 | `combine`、`reverseList` | `||` / `&&` / `%%` 的语义唯一实现 |
| `engine/replace.ts` | 净化尾求值 | `applyReplaces` | `##pattern##replacement` 与 OnlyOne(`###`) 的唯一执行点 |
| `engine/evaluate.ts` | 总装与 trace | `evaluate`、`evaluateWithTrace`、`TraceStep`、`TraceResult` | 链语义（generator `ruleGen`/`branchGen`）+ 两个驱动器 + 链衔接状态机 |
| `engine/js-sandbox.ts` | `@js` 沙箱 | `evalJs`、`runScript`、`JsHost`、`SourceSession`、`processSession`、`createSourceSession`、`ensureUnhandledGuard` | vm 逃逸防御、超时、日志收集、进程级 unhandledRejection 防线、**`java.ajax` 同步语义的唯一裁决点**（`SYNC_WORKER_RE` 性能启发 + 哨兵 `needsSyncBridge` → worker 透明重跑）、`runAsScript` **编译期** SyntaxError 判别（运行时 SyntaxError 不再静默回落成 Miss）、BOOTSTRAP 的 `JSON.parse` 对象幂等 wrap、`Packages.*` 包路径仿真（重活走 `__pkg.*` 通道） |
| `engine/js-protocol.ts` | JavaBridge 协议表 | `JAVA_PROTOCOL`、`invokeJavaMethod`、`SANDBOX_MOUNTS`、`JavaBridge`(推导) | 加一个 `java.*` 方法 = 表加一行；BOOTSTRAP 名单/分派/类型面全部派生。含 cache 内存三别名（`putMemory`/`getFromMemory`/`deleteMemory`——本仓 cache 纯内存，别名只为真实源调用名）、`randomUUID`、字节组三方法（`strToBytes`/`hexDecodeToByteArray`/`base64DecodeToByteArray`，字节 = number[] 跨 RPC）、`downloadFile`(async，与 ajax 同款哨兵/worker 同步桥) + `readTxtFile`（**进程内暂存表，不暴露真实文件系统**——脚本读任意本地路径 = 数据外泄面） |
| `engine/js-utils.ts` | 沙箱宿主纯工具 | `engineValueToString(v, 'inner'\|'outer')`、`engineValueToStrings`、`md5Hex(16)`、`base64*`、`uriEncode`、`hexDecodeToString`、`fmtTime`、`decodePngToArgb`、`javaEncode/javaDecode/normalizeCharset` | `EngineValue → 单串` 的唯一实现（nodes 两种口径由参数区分）；PNG → ARGB 像素（node:zlib 解 IDAT + 逐行去滤波，隔行/未知滤波宁炸不猜）与 Java charset 别名归一也在此；像素上限由调用方以可选 `maxPixels` 传入，**在 IHDR 处判**（重活之前挡住） |
| `engine/index.ts` | 公开面（收窄后仅此八项） | `evaluate`、`evaluateWithTrace`、`interpolateUrl`、`URL_OPTION_SPLIT`、`isEngineError`、四个错误类、`EngineValue`/`EvalContext`/`Facet` 类型 | 服务半的**唯一**对外承诺；其余 module 深路径直引是实现层耦合，不是承诺 |

服务半 import 引擎分两类：**走 barrel**（`engine/index.ts`，即上表的公开面）与**深路径直引**（实现层耦合）。直引的现状共四处，都是「引擎内部能力被服务半直接消费」：`content.ts`→`dom.js`（html→纯文本）、`normalize.ts`→`grammar.js`（规则尾巴归一）、`search-template.ts`→`js-sandbox.js` 与 `bridge.ts`→`js-sandbox.js`（后两者同一需求：`runScript` 跑 `@js` 规则——搜索模板与 `@js:` 动态头）。这四处**没有**收进 barrel；若认定 `runScript` 属公开面，正确做法是把它加进 barrel 并改这两处 import（`js-protocol.ts` 的 URL 选项分界式走的是另一条路：先放 `template.ts`，再由 barrel 出）。`tests/engine/*` 的深引是测试需要，不是消费点。新增服务消费点前先问「这是引擎公开面吗」——是则加进 barrel，否则说明耦合放错了位置。

## 取值规约（最重要的一条）

**取位失败 → Miss；解析到空集合 → 空 List。**

- 选择段（`default` 的 class/id/tag/child/children 与 `css` 段）：`engine/select.ts` 的 `reducePicked` 把 `exclude` 过滤 → `index` 取位 → 空态裁决串成一处，四种失败态 `zero`/`excluded`/`oob`/`sliced` **一律判「选择失败」→ Miss**。
- 取值段（`engine/select.ts` 的 `getValue`）：同样消费 `reducePicked` 做取位；只有「元素在、取值全空」（`texts.length === 0`）才给空 List。`textNodes` 是唯一恒产 List 的取值段（`select.ts` 的 `textNodes` 分支）。
- JSONPath 同口径（`engine/jsonpath.ts` 的 `evalJsonPath`）：零命中/取到 `null`/下标越界/切片裁空 → Miss；**解析到空集合**（`[*]` 与 `[]` 是同一通配的两种写法，打在空数组上）→ 空 List。集合型末段（`[*]`、`[a:b]`、`..name`）哪怕只收一项也恒产 List（`jsonpath.ts` 的 `collection` 判定）。
- **中链 jsonpath 逐项目空态**（`evaluate.ts` 的 `jsonpath` case，「List → 逐项求值合并」分支）：上游是 List 时逐条目按 JSON 求值后**合并**——`miss` 条目不贡献（那是取位失败）；`list` 条目展平合并（空集合贡献零个条目，而不是一个空串条目）；其余（`value`/`matches`/`nodes`）命中即收，**空串也是值**。终局裁决：上游 List 为空 → 空 List（链首已判「解析到空集合」，逐项无物可求，中链不许改口）；非空上游逐条目**全部** `miss` 才是 Miss。链首与中链对同一输入必须给同一种值，否则 `||` 的兜底语义会随链长漂移。
- **模板字面段的插值**（`evaluate.ts` 的 `literal` 分支）：任一插值段 Miss → 整段 Miss（Miss 折成空串会拼出语法合法的残 URL）；空 List → 空串照常参与拼接。
- 组合符消费这个区分：`||` 认为空 List 是「未取到」继续向右（`combine.ts` 的 `combineFirst`，注释「空 List = 未取到，继续向右」），全 Miss → Miss，**全空 List（无 Miss）→ 空 List**（同函数尾的 `所有分支未命中` 与「全空 List 或零分支 → 空 List」注释）——绝不把空 List 折叠成 Miss。

**为什么**：legado 的 `||` 短路语义建立在「没取到」是一个可继续的值之上。若把「取到空」也当失败，兜底分支会连带失效并静默拉回错误内容（android-ebook 血训）。

**链上空的两种穿透行为**：Miss 在选择/取值段被原样透传（`evalNonJs` 各 case 的 `if (cur?.kind === 'miss') return cur`），不会变成「上游不是节点集」的求值错——这是 `||` 兜底能成立的前提。`requireNodes`（`evaluate.ts`）另外约定：链首未起链 → 根节点集 `$('*')`；上游是 Value（js 段产物或取值段产物）→ 按 HTML 重新解析为新上下文（legado `String → JSoup` 语义，`<js>…</js>@css:.x` 成立）；其余 → `RuleEvalError`。

**`nodes` 不许到达链终点**：选择段产 `nodes` 供后续段消费；若规则以节点集收尾，服务层的 `firstValue`/`listValue` 抛 `RuleEvalError('结果不是取值而是节点集')`（`services/bridge.ts` 的 `nodesError`，`segmentIndex: -1`）。这也是 Native 方言要补隐式 `@text` 的原因——不补就会以节点集收尾。

**被否决的替代方案**：① 选择段切片裁空给空 List——曾如此（default 给空 List、css 给 Miss，同一 `x.5:9` 后缀两种结果），而空 List 不是节点集，中链必抛「上游结果不是节点集」；裁决为选择段四态一律 Miss（`tests/engine/reduce.test.ts` 的 `describe('选择段空态裁决统一（分叉①修复）')`）。② 取值段拥有自己的一份空态逻辑（`@text.5:9` 给空 List 而 `.5:9@text` 给 Miss）——已收拢到 `reducePicked` 单点。③ `&&` 用 Miss 冒充「合并失败」——改为抛 `UnsupportedRuleError`（`combine.ts` 的 `UnsupportedRuleError('&& 混合 AllInOne(matches) 二维结果无法合并')`，`tests/engine/combine.test.ts`）。④ `@text!0` 的排除被静默丢弃——排除现已在取值段生效（`select.ts` 的 `getValue` 消费 `reducePicked(arr, seg.exclude, seg.index)`）。⑤ 中链 jsonpath 用「合并后条目数为零」判 Miss（`evaluate.ts` 旧码 `if (s !== '') items.push(s)` + `items.length === 0 → miss`）——曾如此，它把两种值在同一处折叠两次：上游空 List 被改口成 Miss、命中但值为空串的条目被当失败丢掉，于是链首给空 List 的输入换个链长就变成 Miss，`||` 兜底随链漂移。现按上文「中链 jsonpath 逐项目空态」走（`tests/engine/reduce.test.ts` 的 `describe('中链 jsonpath 逐项目空态…')`）。

## 取值链文法

- **切分次序**（`parse.ts` 顶注「切分次序（钉死）」与 `parseRule`，顺序固定）：② 剥 `##` 净化尾（`parseTails`，`###` 先记 OnlyOne 再剥尾部一个 `#`）→ ③ 剥链首 `-` 反序前缀 → ① 剥完上面两步仍以 `:` 开头 → 整链一个 allinone 段 → ④ 按 `||`/`&&`/`%%` 从左到右分支切分（**混用抛错**）→ ⑤⑥ 段切分与识别（`globalIndex` 全规则连续编号，写进错误定位）→ ⑦ 链尾 `(jsCode)` 与 `js` 末位限制。
- **分支切分跳过 JS 区域**（`splitTop` → `grammar.jsRegionEnd`）：`js:` 在链首或段界 `@` 后吃到链尾；`<js>…</js>` 块整体是一段。
- **段切分**（`splitElements`）：单 `@` 是段界，`@@` 是字面 `@`（显式声明形态，段内剥一个 `@`）。XPath 主导规则（`@xpath:`/`//`/`.//`/`/` 开头）的谓词 `@class` 与属性步 `@href` **不切段**，只在 `@已知特殊前缀` 处切；切过一段后回归普通模式（`//x@css:y@text` 成立）。
- **段识别**（`classifySegment`）：前缀大小写不敏感（真实源有 `@CSS:`/`@JS:`）。白名单 `KNOWN_MODES`（`parse.ts`）之外、又不构成选择器形态 → 解析期 `UnsupportedRuleError`。
- **终端**：`text`（**全部后代文本**，块级边界落 `\n`）、`textAll`（归一单行）、`ownText`（严格直系文本）、`textNodes`（逐文本节点一条）、`html`（内层）、`all`（outerHTML）、`href`/`src`（自身属性，空则向下兜底第一个含该属性的后代，但 `html`/`body` 包装元素一律不兜底）、`content`（自身属性，兜底第一个 `meta[content]`）。
- **位置后缀与排除**：`splitIndexSuffix` 从**最后一个** `.` 起取第一个能解析为 `IndexSpec` 的后缀（`all`/整数/`a:b` 切片，均支持负数）；解析不了则整串是名称（`class.note.clearfix` → arg `note.clearfix`）。`!0:2:-1` 是排除，只对选择段（`default` 选择段与 `css`）合法，且与位置索引**不并存**（解析期抛错）。
- **位置后缀的落点差异**：`default` 段的位置后缀挂在**名称**上（`class.item.5:9` → 选择 5:9 个 `.item`）；隐式 CSS 回落把后缀带进 `css` 段（`a.0` = 选 `a` 再取第 0 个——真实源高频形态，曾被并进选择器 `a.0` 当 class 选择 → 恒零命中 → 首条书名为空）；显式 `@css:` 形态**没有**位置后缀概念，恒整集（`css.ts` 注释「css 显式形态无位置后缀（恒整集）」）。取值段后缀挂在终端后（`@text.5:9`），与选择段同口径裁决。
- **排除语法与 JS 段的边界**：排除切分用 `/^(.+?)!(-?\d+(?::-?\d+)*)$/`，只对选择段生效；`js:` 段代码里的 `!0`（布尔取反）在段前缀识别时先行返回，不受影响（`parse.ts` 的 `classifySegment`：`js:` 分支先于 `splitExclude`）。
- **隐式 CSS 回落**（`parse.ts` 的 `isImplicitCss`）：`#id`/`.class` 简写、裸 tag 词、`tag[attr]`、纯属性选择器、`tag.类` 组合、`tag+伪类/组合链`（首词须是 `HTML_TAGS` 成员）、**含选择器特征字符者**（串里有 `#` `[` `>` `+` `~` `=` `,` 任一，或以 `*` 开头——真实源 `ul#ncp3_ul li`、`*[href*=book/chapter]`、`li[style~=width:100%;]`）。这一条放宽的是**「哪串字符像选择器」**：交 `css-select` 求值后，非法选择器仍在求值层抛 `RuleEvalError`（带段定位），只有**合法 CSS 但零命中**才降为 Miss——即「认不出」与「认得但没找到」两种值依旧不折叠（2026-09 审查补记，边界钉在 `tests/engine/parse.test.ts` 的 `it('选择器特征字符 → css 段…')` 与 `it('放宽的边界：无选择器特征的未知串仍在解析期抛…')`）。首词非标签的「词.词」形态（`weirdsyntax.x`、`nonsense:x`）与无特征的未知串（`nonsense span`）与 default 方言有歧义 → **仍抛错**。
- **构词与解析同属一处**：`normalize` 三个方言分支与 `search-template`/`template` 的 `||` 拆分一律不可自写。`appendTail` 拼串后**用 `parseTails` 回读自校验**（round-trip）：pattern/replacement 含 `##`、与拼接边界 `#` 粘连、追加到 `###` 结尾的 OnlyOne 规则等情况，当场拒绝返回原 rule + warning，由调用方进 `normalize.warnings`。`withImplicitText` 也复用 `jsRegionEnd`，不再按 `||` 盲切 JS 体。

**为什么**：normalize 拼出来的必须正是 parse 认的。此前构词散在三个跨半 module 的硬拼串里，文法一改靠注释同步（已实际分叉：`<js>return a||b</js>` 被撕成 `<js>return a@text||b</js>@text`——正文规则一旦命中即整本书读不出正文且不报错）。

**JS 区域探测是文法的一半**（`grammar.ts` 的 `jsRegionEnd`，parser 的 `splitTop`/`splitElements` 与构词侧 `withImplicitText` **共用同一份认知**）：`<js>…</js>` 块整体是一个段、块内 `||`/`&&`/`%%`/`@` 是 JS 代码；`js:` 只在链首或段界 `@` 后成立，且**吃到链尾**（真实源 `@js` 代码里大量 `||`/`&&`/字符串里的 `@`）。构词侧此前裸 `split('||')` 会把 JS 体当连接符撕开，两侧对同一文法认知不一致。

**被否决的替代方案**：① 构词侧自持一份词法——否，改走 round-trip 自校验。② 遇到越界尾静默跳过——否，warning 进 `normalize.warnings`（宁吵不瞒）。③ 裸词透传留到求值期——否，解析期即炸（否则 compat 工具链按 parse 预检时漏掉，错误类与阶段全错）。④ `##` 落在正则/JS 代码内部靠朴素切分——仍是已知方言限制，但构词侧由 round-trip 拦下，不再产出求值期谜之结果。

## 方言与 normalize

`services/normalize.ts` 是三种方言（legado 平铺 / legado 对象 / Native）到模型字段的唯一映射点：`isNativeSource`（顶层字符串 `name`+`url` 且无 `bookSourceName`）判别 → `flattenDialect`（`ruleSearch` 落搜索面、`ruleBookInfo` 落 `ruleDetail*`——**含 `init` → `ruleDetailInit`**（详情上下文初始化，语义与宁炸口径见 CONTEXT.md 同名词条）、`ruleToc.chapterList` 落 `ruleChapterList`；`replaceRegex` 经 `appendTail` 追加净化尾）或 `flattenNative`（list/name/url 三件套、`replaceRules[]` 逐条 `appendTail`、`authorPrefix` → `##^前缀##`、`{{keyword}}` 改写为内部 `{{key}}`）。两条路都把拼串交给 `engine/grammar.ts`，越界当场进 warning。

Native 特有的**隐式终端构词**：`NATIVE_TEXT_FIELDS`（`normalize.ts`）里的取值字段裸选择器补 `@text`（`withImplicitText`）。`ruleBookList`/`ruleChapterList`/`ruleCoverUrl`/`ruleBookUrl` **不在列**——它们要节点集或属性，补了就取不到。

`services/request.ts` 持有「URL 模板 + 变量 + baseUrl → 可执行请求计划」的请求组装语义（`assembleRequest`/`fetchInitOf`）；模板内 `{{...}}` 的 JS 形态（`{{java.encodeURI(key)}}`、`{{page*2}}`）由 `services/search-template.ts` 经 `runScript` 预求值，纯变量形态留给 `interpolateUrl`（`encodeURIComponent` 编码，未知变量保留原文）。

**拼串与终端的施加次序**（`normalize.ts` 注释「终端语义收口：取值字段裸选择器补隐式 @text」钉死）：先在链体上追加净化尾（`authorPrefix` / `replaceRules[]`），**再**补隐式 `@text`——`withImplicitText` 只处理链体、尾部不动，反序会污染 `##` 段。`ruleDetail*` 与 `ruleChapterList` 是 `ruleBookInfo`/`ruleToc` 的落位目标，平铺方言缺失时在服务层回退（详情面回退 `rule*`，目录列表回退 `ruleBookList`；`reading.ts` 的 `getDetail` 里 `rules.ruleDetailName ?? rules.ruleBookName`、`getTocInner` 里 `s.rules.ruleChapterList ?? s.rules.ruleBookList`）——**回退发生在调用点，不在 normalize**。

## 面与段

- **面（facet）**：`search`/`detail`/`toc`/`content` 由服务半在调用点传入——搜索面 `search-face.ts` 的 `subEval(ruleBookList, …, 'search')`、详情/目录/正文 `reading.ts` 的 `getDetail`/`getTocInner`/`getChapter`（分别传 `'detail'`/`'toc'`/`'content'`）。face 只进错误定位与 trace，不改变求值语义。`rule` 是缺省面（`parseRule`/`evaluate` 的第二参缺省），用于 `loginUrl` 脚本等无面规则；`explore` 无生产调用方。
- **段（segment）**：`SegmentLoc = { segmentIndex, segmentRaw }`；`segmentIndex` 是跨分支的全规则连续编号（parse 的 `counter` 与 evaluate 的 `offset` 同口径）。错误消息形如 `[content#段0] …（规则片段: "@css:.con@text"）`。
- 服务层规约出的错误（链终点剩节点集、正文规则零命中）用 `segmentIndex: -1` + `segmentRaw: '(服务层规约)'`（`services/bridge.ts` 的 `nodesError`、`reading.ts` 的 `RuleEvalError('正文规则没取到内容')`）。

## 数据流（书源规则 + 面 → 取值结果 / 错误）

1. `normalize` 出 `rules.*`（链字符串，含 `##` 尾）。
2. 面入口：`fetchSearchPage`（`services/search-face.ts`）先 `resolveSearchTemplate` → `buildSearchRequest`/`assembleRequest` → `fetchTextPage`（超时单点）→ `extractItems(await subEval(ruleBookList, …, 'search'))`。
3. `makeSubEval`（`bridge.ts`）→ `engineContextOf` 组装 `EvalContext`（`html`/`json`/`baseUrl`/`source`/`vars`/`fetch: engineFetch`/`jsLib`）→ `evaluate(rule, ctx, facet)`。
4. `evaluate`：`parseRule`（字符串形态）→ `ruleGen`/`branchGen`（链语义单点）→ `evalNonJs` 按段 kind 分派（css/xpath/default/jsonpath/allinone/getvar）→ js 段 `yield` 给驱动器 → `combine` → `reverseList` → `applyReplaces`。
5. 值回服务半：`firstValue`/`listValue`/`extractItems`（`bridge.ts`）。`nodes` 到达链终点 → `RuleEvalError('结果不是取值而是节点集')`（`bridge.ts` 的 `nodesError`）。
6. `evaluateWithTrace` 同一 runner，额外收集每段一行 `TraceStep`（`hits`/`preview`/`jsLogs`/`error`）；错误段先 push error Step 再照抛。

### 链语义单点（改引擎的第一站）

链衔接、`@put` 效果、js 段特判、trace 组装、错误步**只此一份**，以 generator `ruleGen`/`branchGen`（`evaluate.ts`）表达：非 js 段同步推进，js 段 `yield` 出完整 `evalJs` 入参。两个驱动器零链知识——`driveAsync`（主路径）`await evalJs` 后回喂，`driveSync`（`java.getString*` 的 `evaluateRef` 专用，沙箱宿主桥是同步接口）遇第一次 `yield` 即判「子规则内不支持 js 段」并抛错。

**为什么**：此前是 `runParsed`/`runParsedSync` 两个约 60 行逐条镜像的孪生函数，特判段（js/put）必须双写，且同步环路长期零测试。**被否决的替代方案**：① 保留双 runner 靠注释同步——已实际分叉；② 让同步驱动器异步化——沙箱宿主桥 `__host_call__` 是同步接口，改不动；③ 遇 js 段在同步环路里返回 Miss——否（用 Miss 冒充失败）。

**段链衔接的显式检查**：`checkChainStart`（`evaluate.ts`）只许 `allinone` 出现在分支首位（页级正则无中链语义）。`jsonpath` **中链合法**（上游修复后的 legado 语义——legado-with-MD3 fork 对 JS 返回对象不分发 Mode 的快捷路径是上游已修复的 bug，钉子测试 `AnalyzeRuleFastPathReproTest.kt` 按修复后语义断言）：链首按整页/ctx.json 求值；上游 Value → 按 JSON 解析后求值；上游 List → 逐项求值合并（「js 返回对象数组再取字段」形态）；节点集/正则结果上游 → `RuleEvalError('jsonpath 段上游是节点集/正则结果，无法按 JSON 求值')`（宁炸）。`@get:` 段产出 Value/Miss，是合法的链值替换点（`evaluate.ts` 的 `case 'getvar'`）；`@put:` 是副作用段——写 `ctx.vars` 后链值**透传**（`evaluate.ts` 的 `seg.kind === 'put'` 分支），不替换 `cur`。

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
| `variables.ts` 的 `'@put 值不支持该规则形态（v1 仅支持普通字符串或 JSONPath）'` | `@put` 值非普通串/非 JSONPath（XPath、`@css:`、`<js>`、`#{`）→ 抛 | v1 只支持两种值形态 |
| `variables.ts` 的 `'@put 的 JSONPath 求值结果为列表，v1 变量只存单值'` | `@put` 的 JSONPath 求值结果是 List → 抛 | 变量只存单值 |
| `js-protocol.ts` 的 `'getString 的 isUrl=true 在 v1 不支持（不支持取 URL 后自动抓取）'` | `java.getString(rule, isUrl=true)` → 抛 | 不在桥内做 fetch，静默把 URL 当内容返回是错误结果 |
| `evaluate.ts` 的 `driveSync`：`'子规则（java.getString 等递归求值）内不支持 js 段——沙箱宿主桥为同步接口'` | 子规则（`java.getString*`）内含 js 段 → 抛 | 沙箱宿主桥是同步接口，无法递归 await |
| `js-sandbox.ts` 的 no-op 名单：`需要安卓宿主环境` | `java.webView`/crypto/`android.*`/`org.*` → 报「需要安卓宿主环境」 | 不静默 no-op；纯 UI 副作用（toast/copyText/startBrowser/open）则明确 no-op |
| `xpath.ts` + `js-protocol.ts` | 解析不到、宿主桥未接线（`evaluateRef` 缺失）→ 抛 | 缺接线不降级 |

**例外（规则承认的静默）**：位置越界、切片越界**不抛**（`applyIndex` 静默裁剪），越界定位取不到值 → Miss。这是 legado 行为，也是「越界不抛、语法不认识才抛」的边界。同类静默还有三处，都是**如实**而非掩盖：`@put` 的 JSONPath 求值 Miss → 变量不落盘（`@get` 时自然 Miss，`variables.ts` 的 `putJsonPath`：`if (res.kind === 'miss') return`）；`resolveJsonData` 解析失败 → `undefined` → JSONPath 如实 Miss（`variables.ts` 的 `resolveJsonData` 注释「非法 JSON → undefined」）；`normalize` 对未映射子字段与 v1 未支持字段聚合 warning（宁吵不瞒，不拦导入）。

**字符串化口径**（`EngineValue → 串` 只有一个实现 `js-utils.engineValueToString`）：`value`→text、`list`→`\n` 拼接、`matches`→行内 `\t`、`miss`→`''`，`nodes` 由参数区分 `inner`（`html()`，`java.getString` 口径）与 `outer`（`toString()`，`@js` 的 `host.result` 口径）。`engineValueToStrings`（`java.getStringList`）另把 `value` 按换行切分并滤空行。

## @js 沙箱与宿主垫片

`evalJs`（`js-sandbox.ts`）的机制与理由：

- **逃逸防御**：宿主绝不把函数/对象直接交给用户代码。唯一入口 `__host_call__` 被 vm-realm 闭包捕获后即从全局锁死（`typeof` 得 `number`），`java`/`console`/`cookie`/`source` 全是 vm realm 的包装函数，参数与返回值 JSON 双向序列化，宿主错误只取 `.message` 后以 vm realm `Error` 重抛。vm 上下文 `codeGeneration:{strings:false,wasm:false}` → `eval`/`Function` 一律 `EvalError`。**为什么**：此前把宿主函数直接注入 → `console.log.constructor("return process")()` 可直达宿主 realm（vm 的 `codeGeneration` 不约束宿主 realm 的 `Function`）。
- **禁用能力及理由**：`require`/`process`/`fs`/`global` 不注入（`typeof` 得 `'undefined'`）；字符串代码生成禁用——这是 `jsLib` 用 `eval`/`new Function` 的源报「Code generation from strings disallowed」的原因，**明确不支持**而非降级；webView/crypto/字体/`android.*`/`org.*` 报「需要安卓宿主环境」。
- **超时**：`jsTimeoutMs`（缺省 `DEFAULT_JS_TIMEOUT_MS = 2000`）双闸——`vm.runInContext` 的 timeout 杀同步死循环，外层 `Promise.race` 硬超时约束异步总时长（timer 已 unref）。**生产求值路径全部携带服务层配置**：插件 config `jsTimeoutMs`（缺省 15000，`index.ts` DEFAULTS）经 ReadingService → `bridge.engineContextOf`/`makeSubEval` → `EvalContext.jsTimeoutMs` 透传（阅读三面 + 搜索面 + 探针 + 登录脚本同一口径）；引擎常量只作**未传时的回退**。为什么缺省放宽到 15s：legado Rhino 无硬超时（观察式协程取消），真实源的多请求目录脚本（txs12 源：`java.ajax`×2 + md5 签名 + `source.setVariable`）实测超 2s 必炸——探针 verified 只证明搜索面，正文链路靠这个预算放行（钉子：`tests/services/reading.test.ts` 的 `describe('js 沙箱预算走配置出口（jsTimeoutMs）')` 三态）。
- **脚本形态**：`scriptForm:true`（`@js` 与 searchUrl 形态的缺省）＝代码作为脚本执行、**最后一个表达式的值即结果**；顶层 `return`/`await` 触发 SyntaxError 时回落 async IIFE 函数体形态。回落判别在**编译期**（`new vm.Script` 只编译不执行）——按运行时异常类名判会把 `JSON.parse` 坏串这类**运行时** SyntaxError 误当「顶层 return 形态」静默回落，表达式脚本在 wrapped 里无 return → 恒 Miss（novel.cooks.tw init 脚本真机实证：静默取空比报错更坏）。返回值映射：string→Value、array→List（元素 `String()`）、`null`/`undefined`/`''`→Miss、对象→JSON.stringify 的 Value。**`JSON.parse` 对象幂等 wrap**：JSON 页的 `result` 按已解析对象绑定（字段访问口径），而 `JSON.parse(result)` 形态的脚本会把对象 ToString 成 `"[object Object]"` → 运行时 SyntaxError → 目录全灭（同源实证）；wrap 对已解析对象先 stringify 再 parse（深拷贝幂等），字符串/标量走原生。
- **`host.result`**：上一段结果的序列化，**首段 → 整页原文**（`pageText()` = `html ?? String(json)`，JSON-only 页不再拿到空串）；nodes 口径是 outerHTML（`engineValueToString(v,'outer')`），与 `java.getString` 的 innerHTML 口径由参数显式区分。上游是 List 时，js 串结果按 `\n` 拆回 List（`evaluate.ts` 的 `prev?.kind === 'list'` 分支）。
- **`java.ajax` 与 unhandledRejection**：`java.ajax` 走 `ctx.fetch`（服务半注入 `engineFetch`：源 header 打底 + `assembleRequest` 选项语义 + 解码）。ajax 已**不再产出 Promise**（同步语义唯一，见下节「语义唯一：哨兵 + 透明重跑」），于是引导层那层「给悬空 Promise 挂空 catch」的防线连同它的 `DSH_NOVEL_NO_GUARD=1` 排障开关一起消失——没有 Promise 可消化（`init` 里的 `noGuard` 字段随之删除，该环境变量现已无任何读取点）。剩下的两层：① 协议表实现只管发起请求并如实失败；② `ensureUnhandledGuard()` 进程级常驻 `unhandledRejection` 监听（插件 dispose 时摘）。**② 仍然必需**：vm realm 的 Promise 与宿主同一 isolate，脚本**自建**又 fire-and-forget 的异步工作照旧会悬空拒绝，而 Node 20+ 默认把它当致命错误直接干掉整个 dsh 进程——尤其在**导入书源**时（探针逐源跑 @js，用户看到的「fatal load failure / 请求失败 403 / 404」正是这条 rejection 冒到进程顶层）。它必须加载期常驻而不是「evalJs 期间挂、finally 摘」：rejection 晚于 evalJs 返回才触发，摘早了照样漏。
- **宿主垫片**：`java.get/put`、`getString/getStringList/getElements/getElement`（经 `evaluateRef` 递归求值，基内容 `contentBase ?? result`）、`setContent`、`timeFormat/UTC`、`base64*/md5Encode*/encodeURI/hexDecodeToString`、`randomUUID`、`strToBytes`/`hexDecodeToByteArray`/`base64DecodeToByteArray`（字节 = number[] 0-255）、`downloadFile`/`readTxtFile`（进程内暂存表 + `ctx.fetchRaw` 二进制通道；路径对脚本是不透明令牌）、cache 的 `put/get/delete` 与内存三别名 `putMemory/getFromMemory/deleteMemory`、`cookie` get/set/remove（按源隔离的最小仿真，不做真实 CookieJar——那是无头浏览器的活）、`source.getVariable/setVariable/get/put`（同一变量表）、`source.header`/`source.key`/`source.getKey()`/字符串拼接语义、`java.log ≡ console.log`。`cookie` 与源变量按 `SourceSession` 隔离：生产缺省 `processSession`（跨调用存活），测试注入 `createSourceSession()`（跨源污染用例才写得出来）。
- **`Packages.*` 包路径仿真**（BOOTSTRAP + `__pkg.*` 通道，2026-09）：真实源正文解密链用 Rhino 的 Java 包路径组织调用（爱腐文 favicon 密钥图实证：`ByteArrayInputStream → BitmapFactory → javax.crypto`）。轻活（流对象、`Arrays.copyOfRange`、`SecretKeySpec` 包装）留 vm 纯 JS；重活经 `__pkg.*` 宿主调用（与 `__elem.*` 同为引导层特判通道，不进协议表）：**PNG 解码**（`js-utils.decodePngToArgb`，隔行/未知滤波宁炸不猜）、AES-CBC 解密（v1 仅 `DECRYPT_MODE`，PKCS5=PKCS7 自动校验）、HmacSHA1/256/512（`update(byte[] | byte)` 与 `doFinal(input?) ≡ update(input)+doFinal()` 都按 Java 契约收实参、`doFinal` 结算后复位——此前 `doFinal` 不接参数，`m.doFinal(bytes)` 于是对零字节签名，是静默出错值；认不出的载荷形态如实抛）、charset 解码。`ByteArrayInputStream.read()` 带游标自增（没游标则 `while((b=s.read())!=-1)` 是第一死循环，唯一出口是 js 超时）。字节在脚本侧统一 number[]（0-255）：JSON 可序列化跨 SAB RPC 安全、`& 0xff` 语义不变。未知包路径/未知变换如实报错，不静默 no-op。
- **`jsLib`**：源级全局函数库，**先于**用户代码在同一 vm 上下文执行（函数定义落全局）；它本身不是求值目标，抛错如实上报（jsLib 坏了整源 js 都不可信）。
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
| `tests/engine/content-facet.test.ts` | `text.<串>` 选择语义、属性终端与取值用途（含**命名空间属性名向下兜底不泄漏裸 Error**）、模板字面段（识别/切分/求值/链值引用/**插值 Miss 即整段 Miss**）、`##` 尾 `{{chapter.title}}` 插值、中链 jsonpath |
| `tests/engine/js-bindings.test.ts` | 沙箱非严格模式（未声明赋值）、`src`/`book`/`chapter` 绑定、**worker 路线自身的逃逸防御与超时**（`require`/`process`/`Function()` 与 `脚本超时（>Nms）` 口径两条路一致）、**`java.ajax` 语义唯一**（别名/注释干扰拼写一律同步返回，哨兵重跑不多打站点、不重复计日志） |
| `tests/engine/select.test.ts` | default 段选择/取值、位置与切片、`text`(后代) vs `ownText`(直系) vs `textAll` vs `textNodes`、块级换行、属性缺失→空 List |
| `tests/engine/css.test.ts` | `@css` 段在当前节点集内 find、`!` 排除、非法选择器 → `RuleEvalError`(hits=0) |
| `tests/engine/parse.test.ts` | 切分次序、位置后缀、`!` 识别、大小写不敏感前缀、隐式 CSS 全形态（含**选择器特征字符放宽与其边界**）、未知段/裸词解析期抛错、`<js>` 块可非末位、`@js:` 吞链尾 |
| `tests/engine/tocurl-interpolation.test.ts` | 斜杠开头 URL 模板插值优先于 XPath 前缀（顶点小说 `{{$.novelId}}` 实证） |
| `tests/engine/json-parse-object-idempotent.test.ts` | `JSON.parse` 对象幂等 wrap（两形态共存）+ 运行时 SyntaxError 如实上抛不再静默 Miss + 顶层 return 回落不误伤（novel.cooks.tw init 实证） |
| `tests/engine/legado-gaps.test.ts` | cache 内存三别名与挂载完备、`randomUUID` 形态、字节组三方法与 charset 归一、`downloadFile↔readTxtFile` 往返与「不读任意本地路径」、PNG 解码（RGBA/灰度/隔行拒绝）、`Packages.*`（流/`copyOfRange` Java 语义/AES 解密闭环/HMAC 同值/`BitmapFactory.getPixel`）、**段尾点号剥离**（`tag.li.!0:1:-1` 的 `!` 排除切走 base 后的尾巴不进选择器——看书源实证） |
| `tests/engine/grammar.test.ts` | `parseTails`/`appendTail` round-trip 自校验与全部越界 warning、`withImplicitText` 不动 JS 区域、`isJsForm`/`splitVarExpr`/`isPureVarExpr` 词法 |
| `tests/engine/combine.test.ts` | `||` 短路与空 List 继续、`&&` 合并/跳空/多分支 matches 抛错、`%%` 交叉驱动、反序四种值 |
| `tests/engine/replace.test.ts` | 净化循环替换、OnlyOne 剥 `g`、`$1` 原生语义、替换为空保留条目、非法正则段级定位、`{{}}` 插值只认 bindings 自有键（`{{toString}}` 等原型链成员保持字面） |
| `tests/engine/jsonpath.test.ts` | 负下标/负切片从尾数、切片裁空→Miss、空数组→空 List、集合型末段恒 List、属性通配、拒绝过滤器/`@`/`&` |
| `tests/engine/allinone.test.ts` | 二维 `matches` 不压平、零匹配→空 List（非 Miss）、无捕获组单元素行、零长度匹配不死循环 |
| `tests/engine/xpath.test.ts` | 谓词按父分组、`//text()` vs `/text()`、末段 `@attr`、`preceding-sibling` **逆文档序**编号、白名单外轴/函数抛错 |
| `tests/engine/variables.test.ts` | `@put` pairs 手写解析、**引号值 = 显式字面量 / 裸值 = JSONPath·键访问·字面回退**（两种写法不互相覆盖）、JSONPath 值路由与 Miss/List 裁决、失败不半截写入、`@get` 只认 `ctx.vars` 自有键（原型链成员名如实 Miss） |
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

背景：书源注册表 228 源全部 `verified`（探针只验搜索面），但正文链路全量审计（`DSH_CONTENT_AUDIT=1`，`tests/content-audit.test.ts`）实测仅 25 源全通——「搜索可用 ≠ 正文可读」。对照 legado 参考实现（语义清单 `.superpowers/legado-content-facet-semantics.md`，不入库）补齐六条语义，每条都有引擎测试钉子（`tests/engine/content-facet.test.ts`、`tests/engine/js-bindings.test.ts`）：

1. **js 段 scriptForm 口径修正（最大单点）**：链内 `<js>`/`@js:` 段此前走 wrapped async IIFE——无 `return` 的**表达式形态**（legado 主导写法：最后一个表达式即结果）恒产 undefined → Miss，`$.id@js:"…"+result` 这类真实源主导形态整批静默取空。`evaluate.ts` 的 `branchGen` 现对 js 段显式传 `{ scriptForm: true }`（与 `runScript` 缺省一致）。
2. **沙箱非严格模式 + legado 变量绑定**：wrapper 去掉 `'use strict'`（legado Rhino/QuickJS sloppy 语义——`next = []` 未声明赋值写全局，实测 13+ 源目录脚本首行依赖）；沙箱全局新增 `src`（页面原文，ctx.html ?? String(ctx.json)）、`book`/`chapter`（服务层按面注入 EvalContext）。逃逸防御不靠严格模式（vm realm + codeGeneration 关闭 + 宿主入口锁死），BOOTSTRAP 顶注有完整理由。
3. **取值用途 + 属性终端**：`parseRule`/`evaluate` 增 `usage` 参数（CONTEXT.md「取值用途」）；取值用途链尾未知提取指令 = HTML 属性名（legado getResultLast else 分支），列表用途链尾未知词仍是选择器。`weirdsyntax.x`（词.词）依旧解析期抛错——宁炸不猜边界不外扩。属性终端的向下兜底**不走 CSS 属性选择器拼串**：`isAttrName` 放行冒号（`xlink:href` 这类命名空间属性名），而 `[xlink:href]` 在 nwsapi 里必炸成逃逸错误分类的裸 Error，故 `select.ts` 的 `attrFallback` 直接遍历后代取第一个含该属性且非空的节点（钉子：`tests/engine/content-facet.test.ts` 的 `属性终端：命名空间属性名`）。
4. **模板字面段**：`engine/literal.ts` 新模块——`{{expr}}`（JS 表达式 / 规则递归二分）、`{$.path}` 单括号内嵌、`http(s)://` URL 模板段；`branchGen` literal 分支逐段插值（js 部分经沙箱、`{{result}}` 引用链值、`{{page-1}}` 等绑定可见）。**任一字面插值段命中 Miss → 整段 Miss**：插值成空串会拼出语法合法的残 URL（`http://api/novel/{{$.novelId}}` → `http://api/novel/`），拿它发请求比报错更坏——残 URL 可能命中另一本书，而 Miss 会让门面明确失败（钉子见 `tests/engine/content-facet.test.ts` 的 `字面段插值命中 Miss → 整段 Miss`）。空 List 参与拼接时仍是空串：那是「解析到空集合」，不是「取位失败」，两种值不折叠的规矩照旧。
5. **`text.<串>` 按文本选元素**：legado getElementsContainingOwnText 口径（`select.ts`）。`text.下一页@href`、`text.章节目录@href` 是真实源最高频形态之一，此前参数被忽略 → 整页文本 → 链尾落空。
6. **`##` 尾插值与中链 jsonpath**：替换 pattern/replacement 里的 `{{chapter.title}}` 等点路径按 bindings（book/chapter/vars/baseUrl）插值（legado makeUpRule：替换规则串同样先插值再当正则）；jsonpath 中链合法化见上节。

**被否决的替代方案**：① 链尾未知词一律按属性终端——否，ruleChapterList 等列表规则的链尾选择器会被打成属性（`id.chapter-list@a` 中的 `a`），usage 轴才分得开；② `{{}}` 插值统一进 search-template 那套预求值——否，插值依赖**链上下文**（`{{result}}`/条目 JSONPath），预求值拿不到；③ 沙箱补 `'use strict'` 安全性——否，严格模式与逃逸防御正交，反而杀掉 legado sloppy 源。

**仍开口（如实）**：`@webjs:`/`sourceRegex`/`webView:true` 属 WebView 面（本插件无头浏览器缺席，legado 本身也只在 URL 带 `webView:true` 时才走 WebView）；`<p1,p2>` URL 页码形态、`contentRule.subContent`/`title` 未实现；方括号索引**多条目**（legado 多区间并集）解析期抛错；jsLib 里用 `eval`/`new Function` 的源仍报 Code generation disallowed（安全边界明确不降级，实测 2 源）；**js 段（`@js:`/`<js>`）体内字符串的 `{{$.…}}` 不插值**——legado `SourceRule.makeUpRule` 对全 mode 规则先插值再执行，本仓模板字面段只认字面形态、js 段按纯代码执行（米读 `ruleTocUrl` 的 `@js:try{"…/{{$.book_id}}.txt"}…` 真机实证：字面 braces URL 404；QQ 类纯 URL 模板已由 `tocUrlOf` 的详情上下文路径覆盖，`@js` 包裹模板独立工单，勿在 js 段里随手加插值——那是改全引擎语义）。**已解决**（原列此处）：`java.ajax` 同步语义——worker+SAB RPC 桥落地，且语义已收口成唯一一种（哨兵 + 透明重跑，等价拼写不再换类型），见下。

**三轮补齐：`java.ajax` 同步语义（worker + SharedArrayBuffer RPC 桥）**：
legado 的 `java.ajax` 是 runBlocking 同步返回响应 body，Node 主线程 vm 无法阻塞 await——脚本里 `let b = java.ajax(u); b.indexOf(...)` / `java.ajax(url).match(...)` 这类**真实源主导形态**此前整批报 `xxx is not a function`（失败桶内 20 源引用 java.ajax）。实现（`js-sandbox.ts`）：
- **路由（只是性能与稳健性启发，不是语义开关）**：`evalJs` 用 `SYNC_WORKER_RE` 检测代码（含 jsLib）里**任何可能**是 ajax 的形态 → 整段求值直接进 worker 线程（`new Worker(WORKER_SRC, {eval:true})`——worker 代码以字符串交付，tsdown 打包后无独立 worker 文件可解析；BOOTSTRAP/init/code 全走 workerData，**不产生第二份引导代码抄本**）；认不出的脚本仍走主线程零开销。正则刻意**过近似**，三支：`\.ajax\s*\(`（任何 `.ajax(`）、`downloadFile\s*\(`（`java.downloadFile(`——与 ajax 同款的 async 哨兵桥）或 `java\s*\[`（对 java 桥的任何下标访问，含 `java["ajax"]` 与一切动态键）。放宽不只省一趟白跑——哨兵靠「抛出」传递，脚本自己的 `try/catch` 会在 vm 内吞掉它，现实的别名写法直接进 worker 就走不到抛哨兵那一步。**代价实测**（本机 228 源真实库）：放宽前后同样 28 源命中，多路由 **0** 个。**猜错只赔一趟白跑的主线程尝试，绝不改变返回类型**——语义由桥给（见下条）。
- **语义唯一：哨兵 + 透明重跑**（`js-sandbox.ts` 的 `SYNC_AJAX_SENTINEL` / `needsSyncBridge`）：`java.ajax` 在任何拼写下都只有一种语义——legado 的 runBlocking 同步返回 body。BOOTSTRAP 的 ajax 包装按 `init.syncAjax` 二选一：worker 分支走 SAB RPC 同步返回；**主线程分支不返回 Promise，而是在发起宿主调用之前抛哨兵** `__dsh_sync_ajax_required__`，`evalJs` 在最外层捕获后丢掉本次已收集的 logs、换 `initOf(true)` 在 worker 里重跑同一段（`init` 因此按 `syncAjax` 参数化：复用主线程那份会让 worker 里的包装再抛一次哨兵）。**为什么在宿主调用之前抛**：请求根本没发出去，重跑不会多打站点一次（钉子按 fetch 计数验）。**为什么哨兵要包在最外层**：它有四个可能冒出的位置——BOOTSTRAP init、`jsLib` 执行、同步 `runAsScript`/`runInContext`、以及 `await` 到的完成值（此时哨兵是 rejection）；内层 catch 会把裸 Error 转成 `JsSandboxError`，而 `jsErr` 是 `${prefix}：${msg}` 拼接，原文仍在 message 里，故 `needsSyncBridge` 按**子串**判定即可，不需要额外的错误类型或标记位。
  - **修复前的实测分叉**（源码文本选择语义，同一台机器同一棵树）：`typeof java.ajax("fixture")` → `"string"`（worker，同步）；`typeof java["ajax"]("fixture")` → `"object"`（主线程返回了 Promise）；`/* java.ajax( */ typeof java["ajax"]("fixture")` → `"string"`（加一段注释又把语义翻回来）。源作者把 `java.ajax(u)` 改写成 `java["ajax"](u)` 就静默拿到 Promise，真实源主导的 `.match(...)[1]` 直接炸。
  - **被否决的两条显然方案**：① **一律走 worker**——本机真实书源库实测：228 源中 142 源含 js 段、其中仅 28 源用 `java.ajax(`，一律走 worker 是 **5× 的 worker 生成量**（每次还各自分配 4 MB + 16 MB SharedArrayBuffer），得先做 worker 池才谈得上，那是另一个项目；② **加宽正则去猜动态别名**——不可判定（`java['aj'+'ax']`、解构、`with`、把 `java` 传进函数），任何加宽都是把语义继续押在拼写上。
  - **唯一残余（如实）**：正则放宽后，现实的别名写法（`java["ajax"]` 及一切下标访问）已直接进 worker，剩下能撞到哨兵的只有**脚本里不含那三个字面量的间接形态**（解构 `const {ajax} = java` 后再调、`with (java)`）——计算键 `java[...]` 已被正则的 `javas*[` 分支捞进 worker。这类脚本有两处残余：① 若在第一次 ajax **之前**做过非幂等写入（`source.setVariable` / `cache.put` / cookie 写；同类还有 `java.put` 写 `ctx.vars`、`java.setContent` 写 `BridgeDeps.contentBase`），重跑会把这些写入执行两遍；② 若脚本用自己的 `try/catch` 包住这次调用，哨兵会在 vm 内被吞掉、重跑不触发，脚本静默走它的 catch 分支而不是拿到 legado 语义（放宽正则正是为了把这条对现实写法关掉；`java.ajax(` 与 `java[...]` 两种主流拼写都已进不了这个洞）。当前 228 源库里用动态构造写法的源为 **0**，故两条实测零发生；**网络请求不受影响**（哨兵在宿主调用之前抛）。曾考虑给重跑挂一个影子 `SourceSession`（先在副本上写、成功后回写）——**否决**：为一个零发生场景引入写回机制，是新增的活动部件，自带它自己的失败模式（回写时机、与 `processSession` 的可见性分裂）。若将来真出现这种源，正确的修法是先做 worker 池再一律走 worker（把重跑整条路删掉），而不是补写回。
- **同步桥**：worker 内 `__host_call__` 把 `(name,argsJson)` 写进请求 SAB → `parentPort.postMessage({rpc:true})` 唤醒主线程 → `Atomics.wait` 阻塞；主线程用**同一个 `call`**（fetch 守门 / `java.getString` 引擎递归 / console 日志 / `__elem.*` 元素桥——全部现成）异步服务，响应 JSON 回写响应 SAB + `Atomics.notify` 唤醒 worker。JS 视角同步拿到 body（bootstrap 的 ajax 包装按 `init.syncAjax` 二选一，同一份代码）。
- **不变量**：逃逸防御不变（worker 里同一份 BOOTSTRAP + codeGeneration 锁死，SAB 上只流 JSON）；超时双闸（worker 内 vm timeout 杀同步死循环 + 主线程 race 后 `worker.terminate()`），且 **worker 内 vm 超时映射回本仓口径**——跨边界只有 message/stack，`ERR_SCRIPT_EXECUTION_TIMEOUT` 那个 code 留在对端 realm，故按 message 判后抛 `jsTimeoutErr`（否则同一条件在主线程与 worker 两条路上报两种错，2026-09 审查发现）；RPC **帧解析也在 try 内**（畸形长度/坏 JSON 以 `{__error}` 回包让 worker 从 `Atomics.wait` 醒来，不许落在 `void serviceRpc()` 上成 unhandled rejection——那样要挂到外层 race 才 terminate）；宿主失败（如「该源未提供网络能力」）经 `{__error}` 通道回到 worker 以 vm Error 抛出——**与 legado 的差异如实记录**：legado ajax 失败返回异常堆栈**字符串**当 body（脚本继续跑垃圾数据），我们抛错（宁炸不猜优先）。`__elem.*` 元素桥的 cheerio 解析走**单条缓存**（一条 `els.get(i).text().attr()` 链对同一片段发多次宿主操作，逐次全量解析等于 N 遍；不用 Map——键是站点可控的 HTML 串，留清单就是留内存增长口）。
- 测试钉子：`tests/engine/js-bindings.test.ts`「java.ajax 同步语义（worker + SAB RPC 桥…）」（同步消费 + 链式 `.match` + 失败如实抛）、「worker 路线自身的逃逸防御与超时」（`require`/`process`/`module` 在 worker 里同样不可见、`Function()` 构造抛 `JsSandboxError`、同步死循环报 `脚本超时（>Nms）`；用例靠 fetch 计数自证真走了 worker 那条路，不是主线程用例的复述）、「等价写法同语义：java["ajax"] 与注释干扰都不再改变返回类型」（三种拼写一律 `typeof` 得 `string`，各一次 fetch）、「哨兵重跑不重复计日志、不多打站点，也不把哨兵当脚本错误上报」（用**解构**写法钉哨兵那条路——下标写法已被放宽的正则直接送进 worker，钉不到；`logs` 只一份、完成值照常、**fetch 计数为 1**，哨兵若挪到宿主调用之后即变 2）、「别名写法被脚本自己的 try/catch 包住也拿到同步语义（放宽正则后压根不抛哨兵）」；既有 ajax 用例（注入 fetch 可 await / 无 fetch 报网络能力 / 逃逸防御）在 worker 路由下原样通过。

**元素桥与 org.jsoup 补充**（同二/三轮）：`org.jsoup.Jsoup.parse(html)` 以 cheerio 元素包装等价承接（白鹿书院形态：`doc.select(...)`/`.size()`/`.get(i)`/`.text()`/`.attr()` 链可用），其余 `org.*` 仍如实报需要安卓宿主；`java.getElements/getElement` 对 jsonpath/js 的 value/list 产物如实映射条目（此前只认 nodes → JSON 数据面恒空数组）；**JSON 页 `result` 对象绑定**（legado setContent isJSON 口径）：js 段上游是整页/条目且原文是合法 JSON 时，脚本首段 `result` 按**解析后的对象**绑定（`result.chapterTitle`、`result.data.list` 字段访问形态——JSON API 源目录/正文脚本的主导写法；HTML 页仍是元素包装，字符串方法照常）。沙箱 `result` 三态由此收口：JSON 对象 / 元素包装（String 对象）/ 原文字符串，均按「上游是什么」如实绑定。

**二轮补齐（同审计驱动，测试钉子同上两文件 + js-sandbox/variables/allinone 既有套件）**：

1. **元素包装对象**（`js-sandbox.ts` BOOTSTRAP + `__elem.*` 物理通道）：js 段上游是节点集（`resultKind==='nodes'`）或 HTML 页原文（`'page'` 且含标签）时，`result` 被包成 **String 对象**（字符串方法照常：match/replace/模板串），额外挂 `attr(name)`/`text()`/`html()`/`select(rule)`/`toArray()`/`first()`/`size()`——legado JSoup Element/Elements 的最小仿真，宿主侧经 `__elem.*` 用 cheerio 同步求值（与 console.* 同为引导层特判通道，不进协议表——它不是 java.* 面）。`java.getElements/getElement` 返回值同样包成元素包装；且两者对 **jsonpath/js 的 value/list 产物**如实映射条目（此前只认 nodes → JSON 数据面恒空数组）。
2. **js 数组产物元素字符串化**（`js-sandbox.ts` 的 `serializeJsElement`）：字符串原样、String 对象取原文、带 `html` 字段的对象取 html、其余 JSON.stringify——与 jsonpath 元素口径一致，`<js>java.getElements("$.list[*]")</js>$.name` 这类「js 产条目 → 继续取字段」形态成立。
3. **cache 垫片**（协议表 `cacheGet/cachePut/cacheDelete` + SANDBOX_MOUNTS.cache）：legado CacheManager 最小仿真（按源隔离进程内键值表）——真实源搜索面 `cache.put`、目录面 `cache.get` 的跨面形态（快看漫画）。
4. **AES 解密桥**（协议表 `aesBase64DecodeToString` + 引导层 `createSymmetricCrypto(t,k,iv).decryptStr` 链式外壳）：legado 正文解密形态，Node crypto 实现（AES-CBC/ECB + PKCS5/7，key/iv utf8）；密文/密钥不合法 → `JsSandboxError('AES 解密失败…')` 宁炸，`encryptStr` v1 不支持。原先两者都在「需要安卓宿主环境」名单里。
5. **`@put` 裸值与键访问**（`variables.ts`）：无引号值收（真实源 `@put:{cid:ComicID}`），且按 legado LinkedTreeMap 口径**先按键访问当前 JSON 条目**（`{img:pic}` → `vars.img = 条目.pic`），未命中/非 JSON 上下文 → 字面存。**带引号的值不参与这层推断**（`{img:"pic"}` → `vars.img = 'pic'`）：引号是作者显式表达「我要字面量」的唯一记号，`parsePairs` 第三元把它带到 `evalPut`——丢了它，同一份数据下字面量与键访问两种写法会互相覆盖（2026-09 审查修，钉子「带引号的值是显式字面量」）。豁免只到键访问为止：`$.`/`@json:` 前缀与不支持的规则形态即便带引号仍按声明处理（那是显式语法记号，不是推断）。
6. **AllInOne 行内标志**（`allinone.ts`）：模式开头 `(?s)`/`(?i)`/`(?si)` 剥离转 JS flags（Java 正则写法，JS 无行内标志——此前直接编译必炸 Invalid group）。
7. **方括号索引**（`parse.ts` 的 `splitBracketSuffix` + `select.ts` 的 `applyIndex` range 分支）：legado ElementsSingle `[n]` / `[a:b[:c]]`（**闭区间**、负数从尾数、端点越界钳边、step 缺省按方向自动——`[-1:0]` = 整表倒序）/ `[!n…]` 排除；多条目索引解析期抛错（见仍开口）。
8. **book 变量补字段**（`services/reading.ts`）：`origin`（源 baseUrl——努努书坊 `{{book.origin}}/e/...`）、`tocUrl`、书架上的 `name`/`author`。

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

10. `engine/types.ts` 的 `Facet` 含 `'explore'`，全仓无生产者/消费者（`normalize.ts` 的 `field: 'ruleExplore'` warning）。`engine/combine.ts` 的 `combine`/`combineAnd`/`combineZip` 三处 `loc` 参数都复制了 facet 字面量联合而不是引 `Facet`——加面时四处要改。
11. `engine/evaluate.ts` 的 `evalNonJs` 里 `case 'allinone'` 与 `case 'getvar'` 不校验链位（只有 `allinone` 经 `evaluate.ts` 的 `checkChainStart` 判「必须是分支首位」），但 `allinone` 实际靠 parse 的「整链以 `:` 开头」保证唯一性；`@get:name` 允许出现在链中段并替换链值（`evaluate.ts` 的 `case 'getvar'`）。`jsonpath` 中链已合法化（上游修复后 legado 语义，见「段链衔接的显式检查」）。
12. `engine/js-protocol.ts` 的 `BridgeDeps.contentBase` 是可变捕获状态：`java.setContent` 写它（`js-protocol.ts` 的 `method('setContent')`：`d.contentBase = …`）、`java.getString*` 读它（`js-protocol.ts` 的 `d.contentBase ?? d.result`）——同一次求值内多次 `setContent` 会互相影响（legado 同款，但未写进任何文档）。
13. 两项**需要拍板的未决口径**（`AuthRequiredError` 声明未落地、探针「分段 trace」无结构化字段）属服务层与 wire 面——不在本文重复，见 `docs/design/services.md` 的「已知开口」。引擎侧相关事实只有一条：`TraceStep` 目前只被 `evaluateWithTrace` 的生产者内部消费，没有第二个消费者。
14. `tests/reprobe.test.ts` 是「改动引擎/抓取后实测书源可用率」的唯一自动化验证，默认跳过（`DSH_REPROBE=1` 才跑）；`pnpm test` 全绿不构成真实站点兼容性证据。
15. 引擎的无回归门禁是「`tests/engine/**` 全绿 + `pnpm typecheck` 干净」两条；`vitest.config.ts` 把 `tests/compat/**` 与 `packaging-build.test.ts` 排除在常规集外（分别由 `pnpm test:compat` / `pnpm test:pack` 驱动）。改引擎后若只跑常规集，`compat` 回放与构建产物两条链是**没被验证**的。
16. `src/engine/` 20 个文件里只有 `index.ts` 有对外承诺；`parse.ts` 的 `KNOWN_MODES`、`HTML_TAGS` 与 `xpath.ts` 的白名单都是**手写清单**——扩方言时它们不会因为别处改动而自动跟随，测试是唯一守卫。
17. **`scriptForm` 省缺值两条路不一致**（需要拍板）：worker 路取 `opts?.scriptForm ?? true`（省缺即脚本形态），主线程路取 `opts?.scriptForm === true`（省缺即 wrapped 函数体）——同一个省缺在两条路上语义不同。哨兵重跑走 worker 路，因此也是 `?? true`（即「主线程尝试省缺、重跑按脚本形态」在这条未决口径下同样分叉）。生产路径不受影响（`evaluate.ts` 的 `branchGen` 对 js 段**显式传 true**，`runScript` 也缺省 true，见「js 段 scriptForm 口径修正」），要统一得先定「省缺默认走哪条」并连带核对 `runScript` 与两条路的测试调用点。
18. **哨兵重跑的两处残余**（接受的残余，只落在真正的动态构造写法上）：`SYNC_WORKER_RE` 放宽后，`java.ajax(`、`java.downloadFile(` 与 `java[...]`（含计算键 `java['aj'+'ax']`——正则按字面文本命中它，进 worker 而不是撞哨兵）都直接进 worker，剩下能撞哨兵的只有解构 / `with` 这类脚本里没有那三个字面量的写法。它们：① 若在第一次 ajax **之前**做过非幂等写入（`source.setVariable` / `cache.put` / cookie 写 / `java.put` / `java.setContent`），重跑会执行两遍；② 若脚本用自己的 `try/catch` 包住该调用，哨兵在 vm 内被吞、重跑不触发，脚本静默走 catch 分支而拿不到 legado 语义。当前 228 源库里这类写法的源为 **0**；网络请求不受影响（哨兵在宿主调用之前抛，钉子按 fetch 计数钉死）。影子 `SourceSession` + 写回已被否决，理由与将来的正确修法（先做 worker 池再一律走 worker，把重跑整条路删掉）见「语义唯一：哨兵 + 透明重跑」的「唯一残余」。
