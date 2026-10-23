# 源脚本求值收进一条缝；book 镜像由一个 builder 供出

Status: accepted

源能力集、动态头求值、非递归与回退、脚本可见的 `book` 镜像曾由 `bridge` 与各调用点共同拼装，同一个脚本从不同入口进来会看到不同的字段集。现在这些机械归 `source-eval` 一处，调用方只交规则与上下文；`book` 镜像由一个 builder 按调用方给的 shelf 上下文塑形，逐面字段集保持不变（`chapter` 仍由调用方构造后原样透传）。

## 被否方案
- 保留 `engineContextOf` 由调用方各拼一份：能力漏接只在特定路径炸，book 镜像继续有两个主人。
- 把 book 镜像统一成全集：会改变 search-face 的脚本可见字段，属于行为变化，不在本次重构内。

锚点：`src/services/source-eval.ts` 的 `createSourceEval` / `bookMirrorOf`；`tests/services/source-eval.test.ts`；`tests/engine/js-protocol.test.ts` 的能力位闸。
