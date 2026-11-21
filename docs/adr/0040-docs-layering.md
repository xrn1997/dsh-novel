# 文档分层：读数、决策、现状分开住，过程文档出库

Status: superseded by 0041

本仓的散文文档按**寿命**分四层：当前事实（`README.md` / `CONTEXT.md` / `docs/architecture.md` / `docs/development.md`）、决策（`docs/adr/`）、读数（`tests/legado-coverage/matrix.ts` 的行 `note` 与代码注释）、过程（本机 `.superpowers/`，不入库）。为什么必须分开：三者寿命不同步，写回同一份文件，任何一次读数更新都会把决策与现状一起拖旧；当前事实源只写现在时。过程文档出库：逐任务计划、审查报告、任务简报、一次性扫描脚本写在本机 `.superpowers/`，仓库内不设 `specs/` 或 archive。被否决：把所有内容写进一份大文档；仓库内 plans/specs + archive；`specs/` 稳定规格层；生成 API 文档；把过程文档搬进仓库。代价：过程不留档，读者要按「真相在哪」的顺序找，语义重复只能靠评审。

锚点：`AGENTS.md` 的「先读哪份」；`README.md` 的「文档」；`tests/docs-liveness.test.ts`；`tests/context-terms.test.ts`；`tests/legado-coverage/matrix.ts`；`shared/wire.ts`；`docs/adr/README.md`。
