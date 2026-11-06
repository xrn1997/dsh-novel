# 声明在 body 上的锚点按「该文档开头」落位，不报成锚点不存在

Status: accepted

真实出版工具生成的 EPUB 会把封面页的 `id` 挂在 `<body>` 上，目录与正文链接指过去。本仓的图文树不含 body 节点，原实现于是既不在锚点表里收它、也不在被剥离名单里记它，绑定期落到「目标锚点在文档里不存在」这一支——**这句报错与源文件相反**，而它的后果是整本拒收。现在 `scanXhtml` 把它单独记成 `documentAnchor`，绑定期返回「该文档 + 无片段」：链接照样可点，落点是这一页开头，不记降级告警。

## 背景

报错的判据主语是「一份文档里有没有这个锚点」，而它触发的动作是「这本书读不了」。同一族形状在正文层已经处理过两次——内联 SVG 从报错改成剥离加告警，被剥离子树里的锚点从「不存在」改成分开的 `strippedAnchors`（见 `documents.ts` 头注③④）——两处都把「我们表达不全」和「源是坏的」分开记。body 的 `id` 是这条分界的**第三格**：锚点在源里存在，承载它的内容整页都在树上，只是容器本身不是节点。三格少一格，真书写法就被读成坏书。

另一面也成立：客户端早就按这套语义在读。`ReadingTarget.anchorId` 为 `null` 就是「该章块顶」（`client/reader-geometry.ts` 的 `targetOffset`），连锚点在树上找不到时，`client/reader-session.ts` 的 `settleJump` 也会退回章顶。**同一个事实在浏览器半是落章顶、在导入半是拒整本**，两层判据互相打脸，本仓不允许这种分叉。

## 决定

1. `scanXhtml` 读 body 自己的 `id`（**只认 `id`**：`<a name>` 是元素级命名锚点，body 上没有这种写法），记进 `XhtmlScan.documentAnchor`；`anchors` 与 `strippedAnchors` 都不收它。
2. `lookupAnchor` 的次序是树上锚点 → 被剥离锚点 → 文档级锚点 → **这一份根本没读出来** → 按条降级（目录落该页开头、正文链接取消可点击性）并留一条痕。文档级命中时绑定期返回 `targetOf(doc, null)`，导航与正文内链**同一处理**（内链不降级成纯文本：目标文档在，指的就是它的开头）。文档读不出时锚点表是空集，「源里有没有这个名字」无从判断——落点同样是该页开头（那一页读不出的原因另有一条痕），**不许把「我们没读出来」说成「这个名字不存在」**再拒整本书。
3. 不记告警。这与被剥离锚点那条不同：那件事确实丢了落点，这件事没有丢任何东西。
4. 树上同名元素照旧赢：`anchors` 先查，所以 `<body id="x">` 与 `<p id="x">` 并存时，指 `#x` 落到那个段落。

## 被否方案

- **进 `anchors` 并铸一个锚点 ID**：那张表的键值对同时是承载节点的 ID（富文本树里没有第二张锚点表），铸一个树上不存在的落点会让目录条目静默退到章首、当前项也量不到——正是 `SvgOnlyPage.carriedAnchors` 注释警告过的形状。
- **把 body 的 `id` 映射成「文档第 0 个节点」**：要保住第一个真实节点的 ID 与语义，就得在树外再包一层容器；包一层会改变每份文档的树形与节点账，换来的落点与 `anchorId = null` 完全相同。
- **维持整本拒**：把「我们的一棵树不表达这个容器」当成「这本书坏」，代价是真实出版物成片读不了，而报错说的还是假的。

## 边界

- 只认 `<body>` 的 `id`。`<html>`/`<head>` 上的 `id` 不认：目录指到那里的书未见，提前收下等于凭空发明需求面。
- 在一份**读得出来**的文档里指向从未存在过的名字**不是**坏书：它按该条降级（目录落该页开头、正文链接取消可点击性、文字照留），各留一条 `epub-degraded-anchor`；整本拒收只留给书级事实，半径判据的主人见 `ADR-0061`。
- 同一份文档里同名锚点出现多处时的落位另见 `ADR-0064`（本条只管 body 这个容器上的 `id` 与树上元素的优先关系）。
- 本条只管锚点身份；一份文档**读不出任何正文**时的半径另见后续裁决。

## 后果

- 导入面少一类假拒；`epub-degraded-anchor` 这条告警不再被用来描述「什么都没丢」的情况。
- 阅读面零改动：`anchorId = null` 与 `settleJump` 的章顶回退是既有路径，本条只是让导入不再抢在运行期之前替用户判死。

锚点：`src/services/epub/documents.ts` 的 `scanXhtml` / `XhtmlScan.documentAnchor`；`src/services/epub/import.ts` 的 `lookupAnchor` / `bindTarget` / `bindLink`；`src/client/reader-geometry.ts` 的 `targetOffset` 与 `src/client/reader-session.ts` 的 `settleJump`（同一语义的另一头）；`tests/services/epub-documents.test.ts` 的「body 自己的 id 是**文档级锚点**」，`tests/services/epub-import.test.ts` 的「文档级锚点（真书封面页把 id 挂在 body 上）」；`tests/fixtures/epub.ts` 的 `epub3-body-anchor`；同名锚点的落位见 `ADR-0064`。
