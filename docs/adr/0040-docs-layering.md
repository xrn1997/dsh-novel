# 文档分层：读数、决策、现状分开住，过程文档出库

本仓的散文文档按**寿命**分四层：当前事实（`README.md` / `CONTEXT.md` / `docs/architecture.md` / `docs/developing.md`）、决策（`docs/adr/`）、读数（`tests/legado-coverage/matrix.ts` 的行 `note` 与代码注释里的局部口径）、过程（本机 `.superpowers/`，不入库）。代码与测试是最终真相；文档与代码冲突时以代码为准，并顺手把文档改回现状。

**为什么必须分开**：读数、决策与现状的寿命不同步。真机读数随站点与批次变，决策难逆，现状随代码变；写回同一份文件，任何一次读数更新都会把决策与现状一起拖旧。兼容读数与裁决还要求「一行一条、可回查」，这与散文的导航职责相反。

**当前事实源只写现在时**：历史、旧方案与「当时为什么」只在 ADR、matrix 行 `note`、git 与本机过程文档里；architecture 不列读数，ADR 不写验收清单，README 不装设计理由。文档地图与各家的「不承担」写在 `README.md`。

**过程文档出库**：逐任务计划、审查报告、任务简报、一次性扫描脚本写在本机 `.superpowers/`。它们不是事实源，也不该让 `main` 出现第二份「当时真相」；完成时该提炼的提炼进 ADR / architecture / matrix，该丢的丢。仓库内不设 `docs/superpowers/`、`plans/`、`specs/` 或 archive。

**不设 `docs/specs/`**：本仓的跨半契约唯一主人是 `shared/wire.ts`，兼容读数的唯一主人是 `tests/legado-coverage/matrix.ts`，语义的最终真相是代码与测试。另写一份「规格」会造第二份契约，并让「规格优先于实现」倒置本仓的真相顺序；README 的兼容段只做用户面摘要。

**根 AGENTS 不另拆文档治理文件**：根文件只装常驻规则，篇幅仍可控；ADR 的写作规则住 `docs/adr/README.md`，文档分层本身的裁决住本篇。再拆一层只会让 agent 多一跳，不会让事实更唯一。

**机器面**：`tests/docs-liveness.test.ts` 守路径、行号、ADR 编号、ADR 索引与 Markdown 链接/标题锚点；`tests/context-terms.test.ts` 守词汇表点名的符号；`tests/comment-altitude.test.ts` 守注释不抄代码表达式。**「一个事实只有一个家」的语义重复没有机器面**，靠评审清单：这条事实的家是否唯一、别处是否还有旧副本、当前事实源是否混进历史/计划口吻、引用是否指向读者拿不到的东西、移动后入链是否更新。

被否决的做法：

- **把所有内容写进一份大文档**：任何一处更新都会让另外两处开始腐烂，读者也无法判断哪句是当前真相。
- **仓库内 plans/specs + archive**（另一种常见做法）：过程工件有历史价值，但一旦入库就会与当前事实争权威；`- [ ]` 的待办语义、旧路径与旧方案会让「`main` 只保留当前真相」失效。历史细节留给 git 与本机过程文档。
- **`docs/specs/` 稳定规格层**：会把 `shared/wire.ts` 的契约抄成第二份，并让规格与代码争最终真相；本仓要的是「代码是真相，文档解释为什么」。
- **生成 API 文档**：契约的唯一主人是 `shared/wire.ts`，生成物只是抄本；文档门只守引用活性，不生成第二份形状。
- **把过程文档搬进仓库**：审查报告与一次性脚本寿命短，入库即需要维护；需要长期成立的结论应提炼成 ADR、architecture 或 matrix 行，而不是留一份原始过程。

**代价**：过程不留档，跨会话只剩 ADR / matrix / 代码注释与 git；读者要按「真相在哪」的顺序找，不能一份文件通读；语义重复只能靠评审，机器门管不到。

锚点：`AGENTS.md` 的「真相在哪」「文档纪律」；`README.md` 的「文档地图」；`tests/docs-liveness.test.ts`；`tests/context-terms.test.ts`；`tests/comment-altitude.test.ts`；`tests/legado-coverage/matrix.ts`；`shared/wire.ts`；`docs/adr/README.md`。
