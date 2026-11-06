# 同一份文档里的同名锚点取文档序第一个，并留一条 notice

Status: accepted

真实出版工具重排章节时会复用模板 id，同一份文档里因此可能出现多个同名锚点。原实现把「目标有歧义」当成坏书整本拒；
现在 `scanXhtml` 只把撞过的名字记进 `duplicates`，绑定期取文档序第一个，编排层留一条 `epub-duplicate-anchor` notice。

## 背景

目录与正文链接指到一个名字，而这个名字在同一份文档里承载了多个元素——原来的判据是「歧义不许猜」，动作是整本拒。
但这份歧义在外部世界有确定答案：树上承载它的就是**文档序第一个**，其余同名元素照样是正文的一部分。
把一处可以解释的重复当成整本书读不了，惩罚的是排版工具的模板复用，不是读者的书。

这不是放宽「宁炸不猜」：那条针对的是「我们读不懂」，而这里我们读得懂，也知道该落哪一个。

## 决定

1. `scanXhtml` 把同一份文档里撞过的名字记进 `XhtmlScan.duplicates`；锚点表仍只收文档序第一个元素的 ID。
2. 绑定期（`lookupAnchor`）查到的就是文档序第一个承载者的 ID；转换期（`anchorIdOf`）只有它认领那个
   锚点 ID，后出现的同名元素照旧作为正文读出来，但**不拿那个锚点 ID**（拿一个新铸的普通节点 ID）——
   树上因此不会出现两个同 ID 节点，目录落位不会在两处之间挑错。
3. 编排层为每个撞名留一条 `epub-duplicate-anchor` notice（`element` 级、`notice`），目录与正文链接同一处理。

## 被否方案

- **撞名仍整本拒**：一处撞名就让整本书打不开，代价与「哪个才算」这件事的严重度不成比例；取文档序第一个不损失任何内容。

## 边界

- 只管同一份文档内的同名锚点；跨文档的名字不共享作用域。
- 读不出的文档没有锚点表，落到该页开头（见 `ADR-0060` / `ADR-0061` 的文档级锚点与空页口径），不按撞名处理。

## 后果

- 导入面少一类假拒；每处撞名在「导入说明」里点得名，正文内容一字不丢。

锚点：`src/services/epub/documents.ts` 的 `scanXhtml` / `XhtmlScan.duplicates` / `anchorIdOf` / `ctx.claimedAnchors`；`src/services/epub/import.ts` 的 `lookupAnchor` / `WARN_DUP_ANCHOR`；`src/services/epub/findings.ts` 的 `FINDING_RADII.elementNoted`；`tests/services/epub-documents.test.ts` 的「同一份文档里重复 id：文档序第一个赢，撞名记进 duplicates（不再整本拒）」；`tests/services/epub-import.test.ts` 的「同一份文档里撞名的锚点：文档序第一个赢并留痕，不整本拒」；`tests/fixtures/epub.ts` 的 `epub3-dup-anchor`。
