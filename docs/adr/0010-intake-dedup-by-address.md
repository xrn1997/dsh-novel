# 入库语义只有一份；同址去重「以可用者为准」并复用旧 id

「书源进入系统」的全部语义（normalize → 批内留首条 → 按址去重 → add/replace）只有一个实现 `src/services/intake.ts` 的 `SourceIntake`；后台导入任务与工具面同步导入都只是**调用方**，只把 `IntakeDecision` 映射成自己的词汇。规则曾只住在 `runImport` 里，同步工具面导入没有去重——同一 baseUrl 可重复入库，「入库规则」只兑现了一半。

去重判据：同一 baseUrl 已有条目里存在 verified → 保留已有、跳过新条；一条可用的都没有 → 新条 **replace 并复用旧 id**（书架与既有引用不断），同时清掉同键其余历史条目。去重键只做 `trim` + 去尾部 `/`，**不折叠大小写**——URL 路径大小写有意义。

**必须一起写明的既定后果**：同址已 verified 的源被新导入跳过时，**新条目带来的规则改进被丢弃**。这是用户拍板的口径、不是 bug；但 UI 与工具只报 `dupSkipped`（「重复跳过 N」），用户若想采纳新规则**得先删旧源**。这句话此前在仓里无家。

被否决的方案：① 新条目一律替换旧的（会把可用源挤掉）；② 替换时铸新 id（书架引用断裂，也正是上一条 ADR 里「快照源名」失效的根因）；③ 折叠大小写做键。

锚点：`src/services/intake.ts`（`IntakeDecision` / `dedupKey`）；`src/services/import-job.ts` 的 `runImport`；`CONTEXT.md`「源入库」「按址去重」；`tests/services/intake.test.ts`；矩阵行 `k-import-dedup`。
