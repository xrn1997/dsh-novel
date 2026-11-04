# EPUB 的 HTML 命名实体在解析前归一化，表外实体仍拒

Status: accepted

EPUB 的 XML 只读面在解析前先把 HTML 命名实体转成数字字符引用（带分号的按内建表、没写分号的按 legacy 表；正文与属性各按浏览器的 data / 属性状态读），表外实体仍按坏书拒绝；不解析 DTD、不请求远端，也不把未知实体降级成 warning。

## 背景

XML 只预定义五个实体，`&nbsp;` 这类常见实体依赖 (X)HTML DTD 才成立。本层为安全不解析 DTD（外部实体是 XXE 的入口，实体展开是 billion-laughs 的入口），但把整本拒绝的代价落在最常见的空白实体上：真实 EPUB 里它很常见，其他阅读器也会接受。只把 `&nbsp;` 加进预定义集合不够——XML 解析器仍不认它，正文会留下字面实体串。

## 决定

1. 在唯一解析入口 `parseXml` 之前归一化 HTML 命名实体：把名字解成数字字符引用（`&#x...;`），让 XML 解析器按数值引用统一解码。
2. CDATA 与注释整段跳过；**带分号**的引用按内建表严格归一化，**没写分号**的按 HTML 的 legacy 表归一化——`&nbsp` 与 `&nbsp;` 同解。正文按 HTML 的 data 状态读，标签（属性值）按属性状态读：无分号写法后接字母数字或 `=` 时不算引用，URL 里未转义的 `&sect=2` 不会被改写成 `§=2`。`&amp;nbsp;` 仍只解一层。
3. 表外实体、`<!ENTITY>`、DOCTYPE 内部子集仍拒；不读、不请求 DTD，不做递归展开。
4. 不把实体降级为 warning：字面实体串或丢失内容都是内容损坏，比拒书更坏。
5. 未闭合的 CDATA / 注释在解析前切段时点名拒绝：字面量的边界只能猜，而边界猜错就是内容错。

## 边界

- 只服务 EPUB 的 XML 只读面（包、导航、正文、SVG 资源）；在线正文的实体口径不变。
- 没写分号的解码只覆盖 HTML 的 legacy 表（含最长前缀匹配：`&notin` 与浏览器一样解成 `¬in`）；连 legacy 前缀都对不上的无分号写法（如 `&hellip`）按字面文本保留。
- 标签整段按 HTML 的属性状态归一化，不逐个属性解析：属性值里的**带分号**引用与无分号的真引用照解，只有后接字母数字或 `=` 的无分号写法留原样。
- 不是通用 DTD 解析器，不承诺支持书内自定义实体。

## 被否方案

- **解析 DTD / 请求远端**：引入 XXE 与网络依赖；外站不可达时书也读不了。
- **只把 `nbsp` 加进预定义集合**：XML 解析器不认 HTML 表，正文留下字面 `&nbsp;`，静默污染内容。
- **把没写分号的形态一律按坏书拒**：`&nbsp` 在真实书里就是「整本被拒」的另一种写法，拒它等于把要修的故障换个触发条件；原样留着又违反第 4 条。按 legacy 表解是唯一既不猜边界、又不吐字面串的走法。
- **降级 warning 继续解析**：未知实体要么以字面串上屏、要么被丢掉，两者都是内容损坏。
- **改用 HTML 解析模式**：绕过现有 XML 良构与安全门。

## 后果

- 常见 EPUB 可正常导入；未知实体仍点名拒绝。
- 属性值（链接、图片地址）不被实体归一化悄悄改写：无分号写法的保护规则与浏览器一致。
- 未闭合的 CDATA / 注释被拒时，理由说的是「没闭合」，不会被说成「实体不在表里」。
- Node 半多一个只读实体表依赖；客户端半不包含这条解析路径。
- 回归由 `tests/services/epub-documents.test.ts` 的实体与未闭合字面量用例、`tests/fixtures/epub.ts` 的 `epub-html-entities` 与 `tests/services/reading.test.ts` 的导入用例把住。

锚点：`src/services/epub/xml.ts` 的 `normalizeHtmlNamedEntities` / `rewriteSegments` / `scanXml`；`tests/services/epub-documents.test.ts` 的实体与未闭合字面量用例；`tests/fixtures/epub.ts` 的 `epub-html-entities`；`tests/services/reading.test.ts` 的「XHTML 命名实体」用例。
