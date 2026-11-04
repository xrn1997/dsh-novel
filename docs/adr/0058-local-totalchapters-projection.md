# 本地书的总章数由门面从章序列统一投影，旧条目启动时补数

Status: accepted

`totalChapters` 不再由导入结果按格式各报：门面从本地 meta 的章序列长度（`chapterCount`）统一投影，TXT 与 EPUB 同口径；更早版本落下的缺字段条目在启动时补一次并落盘。

## 背景

过去 EPUB 导入自报 `totalChapters`，TXT 一律缺席：同一书架字段在两种格式下语义不同（有 / 没有），消费方要两套防。而章数在本地 meta 里一直算得出来——TXT 偏移表与 EPUB spine 索引共用同一份线性序列 `chapters`，缺的只是投影这一步。

## 决定

1. `LocalBookMeta` 不携带 `totalChapters`；门面 `localImport` 从 `chapterCount` 统一投影进书架字段。
2. 启动时对缺字段的既有条目补一次：已有值不覆盖；读不到 meta 的条目跳过。
3. 补数走书架的常规写路径落盘，不是内存里的临时投影——界面读的是落盘那份，只改内存等于下次启动再补一遍。
4. 补数不是校验：meta 读不到（副本已删 / 元数据损坏）就跳过，不替书架判那份副本还在不在；两种失败折成「跳过」是这条口径的一部分。

## 被否方案

- **维持「EPUB 有、TXT 没有」**：字段语义按格式分裂，客户端、导出与工具面各自防御缺席。
- **打开书时由客户端回写补数**：没打开过的书永远缺字段，本地书卡片上的已读百分比一直缺席。
- **导入端各格式自报**：每加一种格式就多一处要记得报章数的地方，漏报是静默的。

## 边界

- 只管本地书：在线书的 `totalChapters` 语义不变。
- `chapterCount` 的唯一来源是本地 meta 的 `chapters` 线性序列；展示树的嵌套条目不是章序列，不参与计数。
- 补数只在启动跑一轮，且只对缺字段的条目发生；已是数字的值永远不覆盖。

锚点：`src/services/reading.ts` 的 `localImport` / `backfillLocalChapterCounts`；`src/services/localbooks.ts` 的 `chapterCount` / `LocalBookMeta`；`tests/services/reading.test.ts` 的「TXT 回执」与「既有条目缺 totalChapters」用例；`tests/services/localbooks.test.ts` 的导入回执用例。
