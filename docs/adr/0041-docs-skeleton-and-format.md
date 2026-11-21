# 文档规范收成一套：骨架、ADR 格式与门禁清单各只有一份

Status: superseded by 0048

文档规范拆成一个入口 `docs/AGENTS.md`、一个 ADR 格式入口 `docs/adr/ADR-FORMAT.md`，根 `AGENTS.md` 只留常驻规则；开发手册改名为 `docs/development.md`，提交与发版边界归 `CONTRIBUTING.md`，发布历史归 `CHANGELOG.md`。核心骨架固定为十份文档，每份只回答一类问题。`ADR-0040` 的分层结论保留；它关于「根 AGENTS 不另拆文档治理文件」「ADR 不另立格式文件」的条款由本篇取代。被否：继续把文档纪律放在根 AGENTS；ADR 格式继续住在索引页；为每种文档再开一层目录。后果：文档多出两份，但每份只回答一类问题；根 AGENTS 变短，细节按需打开。

锚点：`docs/AGENTS.md`；`docs/adr/ADR-FORMAT.md`；`tests/docs-liveness.test.ts`；`tests/context-terms.test.ts`；`AGENTS.md`；`README.md`；`CONTRIBUTING.md`；`CHANGELOG.md`；`docs/development.md`；`ADR-0040`。
