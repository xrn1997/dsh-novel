# EPUB 导航 toc 的 ul 列表按列表读并留变体告警，不当坏目录拒整本

Status: accepted

EPUB3 规范要求 toc nav 用 `ol`，真实书里有写成 `ul` 的；本包层把 `ol` / `ul` 按同一语义读（顺序以 DOM 为准）并留导入告警，只对「连列表都没有」的空壳维持坏目录报错。

## 背景

拒书是本层代价最高的动作，只能花在结构有歧义或读不出的书上。`ul` 与 `ol` 对读者是同一个嵌套列表结构，标签差异不构成歧义；原实现只认 `ol`，一份结构完整、只是标签变体的书被整本拒绝，故障落在最常见的书写变体上。告警而不是静默修好，是因为「这份书与规范不符」值得留痕：排查目录问题时它是线索。

## 决定

1. toc 导航的列表按 `ol` / `ul` 同读，嵌套层级同样容忍，条目顺序以 DOM 为准。
2. 用到变体时（含嵌套层）留稳定告警码 `epub-navigation-unordered-list`：程序按码分流，用户在「导入说明」里看见的是 message。
3. 「连列表都没有」仍按坏目录报错——只容忍标签变体，不容忍结构缺失。

## 被否方案

- **整本拒**：把可修的书写变体升级成换本书也解释不了的拒书，代价错位。
- **静默修好不留告警**：变体事实被抹掉，目录表现与规范不符时无从对账。
- **改走 spine 合成目录**：真实章节标题会被文件名盖掉，比容忍变体差得多；且「声明了导航却读不出 toc」按既有口径是坏目录，静默改走会把问题掩盖过去。

## 边界

- 只管 toc nav 的列表标签变体；landmarks / page-list 照旧不算正文目录，NCX 路径不涉及。
- 只读标签名，不校验 `ol` / `ul` 的其他属性语义。

## 后果

- 导入面多一个稳定告警码；包层模块头的口径注释与本篇同批更新。
- `parseNavDocument` 多收一个告警收集参数，导航读口与告警收集的耦合收在包层内部。

锚点：`src/services/epub/package.ts` 的 `parseNavDocument` / `navListsOf` / `WARN_NAV_UNORDERED`；`tests/services/epub-package.test.ts` 与 `tests/services/epub-import.test.ts` 的 ul 用例；`tests/fixtures/epub.ts` 的 `epub3-nav-ul`、`epub3-nav-ol-nested-ul` 与 `epub3-nav-no-list`。
