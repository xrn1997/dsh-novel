# 导入失败的半径等于判据的主语：结构文档之外不许整本拒收

Status: accepted

EPUB 导入里「这本书读不了」是代价最高的动作，它只花在**容器入口与包文档整体读不出**这一类事实上。其余判据——一份内容文档读不出正文、一条 spine/目录声明指不到东西、一处图片资源读不出——的主语比整本书小，后果也必须一样小：留空页、剪那一条、该处不留，且每一处都留下点名的痕。唯一的整本兜底是一条边界判据：**阅读序列里一份可读的正文都不剩**（或主序列被剪到空）才算这本书坏。

## 背景

原实现把「读不懂」与「这本书读不懂」混成一件事：任何一层遇到解释不了的东西都 `throw new EpubImportError`，而编排层对异常一律上抛——于是一张坏图、一条悬空目录、一页只有空白的版权页都能让一本书彻底打不开。错的不是严格，是**半径**：报错说的是「这一处」，动作杀的是「整本书」，两层主语不同却共用一个出口。这条错位在本仓已经承认过两次（内联 SVG、被剥离子树里的锚点），但都是就地举例外，没有立成规则。第二处根据是分层事实：浏览器半早就按「锚点找不到就落章顶」在读，Node 半却对同一件事报「坏书」。

## 决定

1. **半径由主语携带**：每一层交出的事实是 `Finding{scope, severity, code, resource, action}`，`scope` 取 `book | document | item | element`。**发出方只按半径表的名字交**（`findings.ts` 的 `FINDING_RADII`），半径与后果都由那张表决定——调用点填不出「整本书读不出」这一格，因为表里没有它；发出方不回答该不该拒书（携带机制见 `ADR-0063`）。
2. **后果由一张表导出**：`book/fatal` → 整本拒；`document/fatal` → 这一页留空（章号不动、目录照有名）；`document/degraded` → 照读但表达降级；`item/fatal` → 剪那一条（spine 条目压缩阅读序列、目录条目剪条保子、正文链接取消可点击性）；`element/fatal` → 该处不留（alt 文字与该元素承载的锚点位置照留）。表不发成「码 → 后果」名册：码留在发出它的模块，后果只由这两个维度决定。
3. **整本拒只有一条路**：`EpubImportError` 是书级的唯一表达，且只能经 `services/epub/errors.ts` 的 `rejectBook` / `bookError` 出来；资源级与文档级失败另有子类，编排层只接住那窄的一类，不对基类判 `instanceof` 来分半径。不许用 `book/fatal` 的痕绕开抛错通道——名册由 `tests/services/epub-failure-radius.test.ts` 钉住，单向收紧：按那两个符号的调用点处数，加一处要写 ADR。
4. **章号 = 阅读单元的位置**，不是 `itemref` 在原文件里的序号：包层交出「剩下的有序声明」，编排层只按它编号、不再重判。剪除只影响新导入的书；持久化形状不变，旧书零迁移。
5. **边界（这条口径不宽成「什么都吞」）**：容器入口与包文档整体读不出、主序列缺失或被剪到空、正文文档被加密、包级固定版式、声明了封面却读不出、写不出产物、条目连读都读不出——仍是整本失败。主序列一份可读的都没有就判整本，与 `ADR-0017` 的「个别回退可以、全部回退即整体失效」同源。可降级的失败只发生在读成功之后（解析、规范化、验证）；DOM 深度/节点预算超限算这一族，落空页而不是整本拒。

## 被否方案

- 逐点把 `throw` 改成 warn：判据没有层归属，下一个新判据会犯同一个错；也不会有任何东西变红来提醒。
- 对齐懒解析（打开只验包结构，正文读到时才规范化）：故障半径在结构上不会越界，但与这个插件的存在理由冲突——离线落盘的产物、导出与 AI 工具读同一份文字、总章数一次算准，都要求导入时规范化。
- 让告警通道带 severity 上 wire：跨半契约要加字段，而客户端此刻并不按严重度分流。
- 把「全部读不出」也做成逐条痕：会让一本没有可读正文的大部头以「导入成功」进书架——失败冒充成功是最高罪，不是拒收。

## 边界

- 只管导入面的半径；运行期读产物时的损坏仍按 `services/localbooks.ts` 的 `readDocument` 显式选 500，那是服务端自损，不是读者的书坏。
- 名册是判据清单而不是行为规格：某条拒收该降到哪一格，写在实现它的模块头注与本文的表里，名册只保证它数得着、并且只减不增。
- 目录条目的存在性剪除只看归档里有没有那份文档；「文档在但读不出正文」由文档级空页那条负责，两格不折叠。

## 后果

- 指进一份读不出的文档的锚点按该页开头落；它不额外记痕——「这一页读不出」已经有一条点名。
- 导入面新增稳定痕码：`epub-empty-document`、`epub-item-pruned`、`epub-image-dropped`、`epub-img-without-src`、`epub-duplicate-anchor`、`epub-fixed-layout-document`、`epub-scripted-document`、`epub-spine-linear-variant`；用户可见的承诺面随本篇同批改 `README.md`。
- 一处类目纠正：编排层「内部一致性被破坏」那两处是服务端自己的问题，抛裸 `Error`，服务层分类落 500，不再以 400 报成用户的书坏。
- 在册待裁：manifest 条目缺字段那一族与导航条目缺标题/缺 content 那一族现在仍按书级，规则已就位，逐条降级等真语料读数决定先后。

锚点：`src/services/epub/findings.ts` 的 `FindingLog` / `FindingScope` / `FindingSeverity`；`src/services/epub/errors.ts` 的 `EpubResourceError`；`src/services/epub/import.ts` 的 `enqueue` / `bindNav` / `bindTarget` / `bindLink` / `svgImagePageNodes` / `register`；`src/services/epub/package.ts` 的 `parseSpine` / `pruneDeadTargets` / `assertSupported`；`src/services/epub/documents.ts` 的 `convertXhtml` / `scanXhtml` / `droppedImage`；`src/services/epub/archive.ts` 的口径③；`tests/services/epub-failure-radius.test.ts`；`tests/services/epub-import.test.ts`；`ADR-0057`、`ADR-0060`、`ADR-0063`。
