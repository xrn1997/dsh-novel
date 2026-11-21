# 声明在 body 上的锚点按「该文档开头」落位，不报成锚点不存在

Status: accepted

真实出版工具生成的 EPUB 会把封面页的 `id` 挂在 `<body>` 上，目录与正文链接指过去。本仓的图文树不含 body 节点，原实现既不在锚点表里收它、也不在被剥离名单里记它，绑定期落到「目标锚点在文档里不存在」——这句报错与源文件相反，后果却是整本拒收。现在 `scanXhtml` 把它单独记成 `documentAnchor`，绑定期返回「该文档 + 无片段」：链接照样可点，落点是这一页开头，不记降级告警。

## 背景

报错的判据主语是「一份文档里有没有这个锚点」，而它触发的动作是「这本书读不了」。同一族形状在正文层已经处理过两次——内联 SVG 从报错改成剥离加告警，被剥离子树里的锚点从「不存在」改成分开的 `strippedAnchors`——两处都把「我们表达不全」和「源是坏的」分开记。body 的 `id` 是这条分界的第三格：锚点在源里存在，承载它的内容整页都在树上，只是容器本身不是节点。另一面也成立：客户端早就按这套语义在读，`anchorId = null` 就是「该章块顶」，导入半却拒整本，两层判据互相打脸。

## 决定

1. `scanXhtml` 读 body 自己的 `id`（只认 `id`，`<a name>` 是元素级命名锚点），记进 `XhtmlScan.documentAnchor`；`anchors` 与 `strippedAnchors` 都不收它。
2. `lookupAnchor` 的次序是树上锚点 → 被剥离锚点 → 文档级锚点 → 这一份根本没读出来 → 按条降级并留痕。文档级命中时绑定期返回 `targetOf(doc, null)`，导航与正文内链同一处理。文档读不出时锚点表是空集，落点同样是该页开头（那一页读不出的原因另有一条痕），不许把「我们没读出来」说成「这个名字不存在」再拒整本书。
3. 不记告警。这与被剥离锚点那条不同：那件事确实丢了落点，这件事没有丢任何东西。
4. 树上同名元素照旧赢：`anchors` 先查，`<body id="x">` 与 `<p id="x">` 并存时指 `#x` 落到那个段落。

## 被否方案

- 进 `anchors` 并铸一个锚点 ID：那张表的键值对同时是承载节点的 ID，铸一个树上不存在的落点会让目录条目静默退到章首、当前项也量不到。
- 把 body 的 `id` 映射成「文档第 0 个节点」：要在树外再包一层容器，改变每份文档的树形与节点账，换来的落点与 `anchorId = null` 完全相同。
- 维持整本拒：把「我们的一棵树不表达这个容器」当成「这本书坏」，代价是真实出版物成片读不了。

## 边界

- 只认 `<body>` 的 `id`；`<html>` / `<head>` 上的 `id` 不认。
- 在一份读得出来的文档里指向从未存在过的名字不是坏书：它按该条降级并留 `epub-degraded-anchor`；整本拒收只留给书级事实。
- 同一份文档里同名锚点的落位另见 `ADR-0064`。

## 后果

- 导入面少一类假拒；`epub-degraded-anchor` 不再被用来描述「什么都没丢」的情况。
- 阅读面零改动：`anchorId = null` 与 `settleJump` 的章顶回退是既有路径。

锚点：`src/services/epub/documents.ts` 的 `scanXhtml` / `XhtmlScan.documentAnchor`；`src/services/epub/import.ts` 的 `lookupAnchor` / `bindTarget` / `bindLink`；`src/client/reader-geometry.ts` 的 `targetOffset` 与 `src/client/reader-session.ts` 的 `settleJump`；`tests/services/epub-documents.test.ts`；`tests/services/epub-import.test.ts`；`tests/fixtures/epub.ts` 的 `epub3-body-anchor`；`ADR-0064`。
