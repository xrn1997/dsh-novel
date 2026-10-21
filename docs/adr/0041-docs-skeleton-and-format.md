# 文档规范收成一套：骨架、ADR 格式与门禁清单各只有一份

Status: accepted

根 `AGENTS.md` 此前同时承担先读表、硬约束与文档治理，ADR 的格式与索引规则又住在索引页，提交与发版边界散在 README 与开发手册里。本篇把文档规范拆成一个入口 `docs/AGENTS.md`、一个 ADR 格式入口 `docs/adr/ADR-FORMAT.md`，根 AGENTS 只留常驻规则；开发手册改名为 `docs/development.md`，提交与发版边界归 `CONTRIBUTING.md`，发布历史归 `CHANGELOG.md`。`ADR-0040` 的分层结论保留，它关于「根 AGENTS 不另拆文档治理文件」「ADR 不另立格式文件」的条款由本篇取代。

## 背景

`ADR-0040` 定下了读数、决策、现状与过程四层分开住的结论，但落地方式把文档分层、放置判据与写作规则全压在根 `AGENTS.md`：每次会话都要为「这条内容放哪」的细节付一遍上下文成本，而这些细节只在写文档时才需要。

同时，ADR 的状态、索引与锚点规则住在 `docs/adr/README.md`；索引页既是导航又是格式规范，新增一篇 ADR 要打开两个地方。开发手册与 README 对提交与发版边界各写了一段，没有单一入口。

## 决定

1. **核心骨架固定为本仓的十份文档**：`AGENTS.md`（常驻规则）、`README.md`（用户事实）、`CONTEXT.md`（术语）、`docs/AGENTS.md`（文档规范）、`docs/architecture.md`（当前形状与主人清单）、`docs/development.md`（构建、门与发版）、`CONTRIBUTING.md`（提交与发版边界）、`CHANGELOG.md`（发布历史）、`docs/adr/README.md` + `docs/adr/ADR-FORMAT.md`（决策索引与格式）。每份只回答一类问题。
2. **文档分层、放置判据、写作规则与生命周期住 `docs/AGENTS.md`**：回答「这条内容该放哪、什么时候更新、什么时候归档」；根 AGENTS 只留每次会话必须可见的先读表、硬约束与门。
3. **ADR 的书写形状住 `docs/adr/ADR-FORMAT.md`**：编号只追加、每篇紧跟标题写 `Status: accepted` 或 `Status: superseded by NNNN`、每篇在索引恰好出现一次、文末必须有 `锚点：`、正文只写当前真相；索引页只做导航。
4. **文档门补齐机械检查**：`tests/docs-liveness.test.ts` 在既有索引一一对应之上，增加核心文件在场、根 AGENTS 字符预算（≤ 8,000）与 ADR `Status` 形状；不新增独立检查命令，`pnpm test` 仍是默认门。
5. **过程工件与规格层维持 0040 的结论**：过程工件只住本机 `.superpowers/`，不入库；本仓不设 `docs/specs/`，跨半契约的唯一主人是 `src/shared/wire.ts`；读数住矩阵行 `note` 与代码注释。

## 迁移

- 开发手册统一为 `docs/development.md`，README、architecture 与 ADR 的入链同步。
- README 的完整文档地图移入 `docs/AGENTS.md`，README 只留指针。
- 新增 `CONTRIBUTING.md` 与 `CHANGELOG.md`，分别承接提交/PR/发版边界与已发布版本记录。
- ADR 存量补 `Status` 行；`ADR-0040` 标为被本篇取代。

## 被否方案

- **继续把文档纪律放在根 AGENTS**：根文件已承担先读表、硬约束与门；再装分层、生命周期与 ADR 格式会让每次会话都为细节付费，且没有一个入口回答「这条内容该放哪」。
- **ADR 格式继续住在索引页**：索引是导航，格式是规则；混在一起后，改格式要动导航页，新增 ADR 要打开两个地方。`ADR-0040` 的「ADR 的写作规则住索引页」条款即此方案，本篇取代。
- **为每种文档再开一层目录（`docs/specs/`、`docs/agents/` 等）**：本仓没有对应体量，空壳目录只会多出维护面；跨半契约的唯一主人仍是 `src/shared/wire.ts`。

## 后果

- 文档多出 `docs/AGENTS.md` 与 `ADR-FORMAT.md` 两份，但每份只回答一类问题；根 AGENTS 变短，细节按需打开。
- ADR 存量补 `Status`，开发手册改名波及 README、architecture 与若干 ADR 的入链；文档门会把这些一次抓住。
- 预算与门禁清单进测试，不再写在散文里；以后调预算只改测试与 `docs/AGENTS.md` 的口径，不靠记忆。
- `ADR-0040` 仍可回查当时的分层取舍；当前文档规范以本篇与 `docs/AGENTS.md` 为准。

锚点：`docs/AGENTS.md`；`docs/adr/ADR-FORMAT.md`；`tests/docs-liveness.test.ts`；`tests/context-terms.test.ts`；`AGENTS.md`；`README.md`；`CONTRIBUTING.md`；`CHANGELOG.md`；`docs/development.md`；`docs/adr/0040-docs-layering.md`。
