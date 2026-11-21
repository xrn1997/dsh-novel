# 半径由主语声明、由出口符号数得着：整本拒收成一处，痕收成一张表

Status: accepted

`ADR-0061` 定了判据（失败半径等于判据的主语），本篇定它怎么携带：**半径在知道自己是谁的那一处声明，而不是在 catch 处判**；整本拒只有一个出口符号；痕只能按半径表的名字发。理由是同一件事当时在两处各说了一套。

## 背景

按 `ADR-0061` 落地后，规则的执行形状与规则本身对不上：`Finding` 的 `scope` 与 `severity` 由各发出点各自手填，Node 半没有任何一处按这两个维度分派后果，后果实际由异常子类、集合成员、布尔字段、`null` 返回等不同机制决定；一份文档的坏取决于哪一步被 `try` 包住（同一份正文文档，DOM 预算失败抛的是书级基类，一页太深就让整本书打不开）；基类 `instanceof` 把已经收窄的失败一起吃掉；名册数的是文本不是位置（靠「源码里最长的一段散文」当锚点，改措辞门就红）。另有一处相邻形状问题：落盘的是投影出来的整句中文，读面只能原样复读——拆开后合并、处数前缀与例子列表可由读面按当下口径重算，**动作句仍是导入时写下的那句**。

## 决定

1. **半径在主语已知处声明**：一份被读的文档的预算（`XmlBudget`）自带 `subject`（包文档 / 正文文档 / SVG 资源），`xml.ts` 唯一的失败出口 `fail` 按它给类。于是解码、静态闸门、解析、深度与节点预算四条路对同一份文档给出同一种半径，不必在每个调用点外面再包一层 `try`。
2. **整本拒只有一组具名出口**：`rejectBook`（抛出）与 `bookError`（构造，供 Promise 拒绝与异常包装那两处）。书级异常不在这两处之外被构造，这条由门检；名册因此改成数**符号的调用点处数**（按文件），措辞随便改都不动门；半径要升格就得加名册，加名册要写 ADR。
3. **「这条引用解不开」独立成一个类**（`EpubHrefError`），不是书级的子类：同一个解析口服务两种主语，共用一个类就必然要在一边 `instanceof` 基类。包层用 `packageHref` 收成书级，正文层按自己的半径收成元素级。
4. **痕只能按半径表的名字发**：`FindingLog.add` 收的是 `FINDING_RADII` 的键，半径与后果由表决定，调用点填不了也填不出 `book` + `fatal`。
5. **低层交回事实清单，可变账本只住编排层**：包层、文档层、资源层各自内部记账、对外交回不可变清单，编排层按条并入（`addEntry`：处数照加、例子各留前三）。
6. **落盘的是拆开的事实清单，投影在读面现算**：`LocalEpubMeta` 存 `FindingEntry`（半径、码、资源、动作句、处数与例子），`GET /local/warnings` 按当下的 `warningListOf` 重算合并；动作句本身是导入时的原文。旧书元数据没有这一项时原样用它存过的那份投影；新书同时落一份 `warnings` 投影供旧版本读面降级显示（读面仍以 `findings` 为准）。跨半契约不变——`scope` 与 `severity` 仍不上 wire。

## 边界

- 不改 `ADR-0061` 的判据：什么算书级、什么只影响一格仍由那篇定；本篇只改「半径怎么带出门」与「名册怎么数」。
- DOM 预算失败归文档级是执行那篇已有的规则；一份文档读不读得出仍按 `hasVisibleContent` 判。
- 窄类的继承关系照 `ADR-0061` 保留，但不许对基类做 `instanceof` 判半径——基类只许归档层那一处。
- 运行期读产物的损坏口径不变。

## 后果

- 一页太深或太宽的真实文档不再让整本书打不开：它进阅读序列、占章号、目录有名，点开是空白页，痕点名这份文档与原因。
- 名册从「按报错文本登记的条目」收成「按文件登记的处数」；报错文案从此可以自由改写而不触发半径门，反过来同一文件里净增一处整本拒一定触发。
- 用户可见的承诺面随本篇同批改 `README.md`。

锚点：`src/services/epub/errors.ts` 的 `rejectBook` / `bookError` / `EpubHrefError`；`src/services/epub/xml.ts` 的 `XmlBudget.subject` / `fail` / `decodeEpubXml` / `parseXml`；`src/services/epub/findings.ts` 的 `FINDING_RADII` / `FindingLog.add` / `addEntry` / `warningListOf`；`src/services/epub/package.ts` 的 `packageHref` / `readXmlText` / `hrefFail`；`src/services/epub/import.ts` 的 `contentBudget` / `readXhtml` / `classifyHref` / `merge`；`src/services/epub/resources.ts` 的 `validateImage` / `parseSvg` / `wrapperPath`；`src/services/epub/documents.ts` 的 `convertXhtml`；`src/services/local-meta.ts` 的 `decodeLocalMeta` 与 `LocalEpubMeta`；`tests/services/epub-failure-radius.test.ts`、`tests/services/epub-import.test.ts`、`tests/services/epub-findings.test.ts`、`tests/services/localbooks.test.ts`；`ADR-0060`、`ADR-0061`。
