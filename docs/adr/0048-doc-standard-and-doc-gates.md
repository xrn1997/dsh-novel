# 文档标准固定为一套：核心文件清单、界面规格与三件套文档门

Status: accepted

ADR-0041 固定了十份核心文件与一个文档门。本篇把核心文件扩到界面规格与 agent 约定两层，把文档门拆成三件套，并把 ADR 的锚点与互引形态定死。ADR-0041 的「十份核心文件」与「不设 `docs/agents/`」条款由本篇取代；ADR-0040 的分层结论保留。

## 背景

三件事让原来那套不够用了：

- **界面状态与架构归属是两类问题**。`docs/architecture.md` 已经承担唯一主人清单；再让它在同一份文件里回答「界面现在长什么样」，两类读者都要翻大半页无关段落，改界面状态也会碰到主人清单的编辑面。
- **agent 约定需要落脚**。issue、triage 标签与领域文档的读法是协作用法，不是本仓事实；ADR-0041 当初以「没有对应体量」拒绝开这一层，但它们确实每天都在被用，散在根 `AGENTS.md` 里又会让常驻规则变长。
- **文档门缺了最容易腐烂的几类检查**。它只覆盖引用活性、ADR 形状与根 AGENTS 预算；职责边界（主人清单 / 界面规格 / 文档规范的标题各只有一份）、已废称呼、行号禁令、README 的徽章与真机名单投影、截图三方一致，全都靠人记。

## 决定

1. **核心文件固定为十一份 + 一层**：`AGENTS.md`、`README.md`、`CONTEXT.md`、`docs/AGENTS.md`、`docs/architecture.md`、`docs/ui-spec.md`、`docs/development.md`、`CONTRIBUTING.md`、`CHANGELOG.md`、`docs/adr/README.md`、`docs/adr/ADR-FORMAT.md`，外加 `docs/agents/*`（agent 技能配置，不是事实源）。
2. **规范正文只住两处**：分层表、放置判据、写作规则、生命周期与评审清单住 `docs/AGENTS.md`；ADR 的标题、`Status`、锚点、互引与取代规则住 `docs/adr/ADR-FORMAT.md`。根 `AGENTS.md` 只留常驻规则，章节固定为：先读哪份 / 必须过的门 / 硬约束 / 实现前先验 / 环境坑 / Agent skills。
3. **界面规格独立成层**：现行状态、布局、层级与危险层级住 `docs/ui-spec.md`；像素、断点、文案键的唯一定义在 `src/client/` 与 `tests/client/`，规格不抄读数。界面事实不再住 `docs/architecture.md`。
4. **agent 约定独立成层**：issue tracker、triage 标签与领域文档的读法住 `docs/agents/*`；它们不进事实源。
5. **ADR 格式收成一套**：`锚点：` 为可折行的一段；互引统一写 `ADR-NNNN`；不引用仓外 ADR 编号——编号序列不对齐，溯源用提交 hash 或本仓可验证的锚点。
6. **文档门收成三件套**：`tests/docs-liveness.test.ts`（路径、行号禁令、已废称呼、`§N`、中文小节名、相对链接/锚点、职责边界、ADR 编号/索引/Status/锚点、根 AGENTS 预算、README 投影、截图清单）、`tests/context-terms.test.ts`（`CONTEXT.md` 点名的符号现查得到）、`tests/comment-altitude.test.ts`（代码注释高度）。三份各管一段，`pnpm test` 仍是默认门。
7. **CHANGELOG 四小节**：新增 / 变更 / 修复 / 升级注意，无内容的小节省略；历史版本按当时体例保留，不回溯改写（已废称呼与不可回查的批次号按文档门清理）。

## 边界

- 本仓不设 `specs/`：跨半契约的唯一主人仍是 `src/shared/wire.ts`（ADR-0040 的结论保留）。
- 界面规格只管现行状态，不装历史取舍与像素读数；历史在 git 与 ADR 里。

## 被否方案

- **继续十份文件 + 单文件文档门**：界面状态与归属混住；门的四类判据挤在一个文件里，失败时读的人先要分辨是哪一类，改一类判据也会牵动整份文件。
- **让界面规格并回 architecture**：本仓此前这么定过；architecture 已经承担主人清单，再装界面状态会让同一份文件同时回答「谁拥有」与「长什么样」。
- **把标准抽成独立仓或包**：`AGENTS.md` 的约定是离被改文件最近的指令生效，独立仓不在 agent 的 checkout 里；本仓规模也撑不起独立标准的版本维护。
- **保留两份格式变体（锚点一行 vs 可折行、`docs/adr/` 前缀的旧互引 vs `ADR-NNNN`）**：门代码与评审判据不通用，复制一次就分叉。
- **让 `CONTEXT.md` 继续靠评论把守**：词条点名的符号搬一次家就静默失效，评审记性不是门。

## 后果

- 本仓新增 `docs/ui-spec.md` 与 `docs/agents/*`；`docs/AGENTS.md` 的分层表与放置判据随之改口径。
- 文档门的断言集合变大：新增已废称呼、中文小节名、职责边界、README 徽章投影与截图三方一致五项检查，并把 ADR 互引收紧为 `ADR-NNNN`；代价是文档里重复的标题与旧称呼会被判红，存量里不可回查的批次号已清理为日期或序数。
- 存量互引从 `docs/adr/` 前缀改写为 `ADR-NNNN`；`锚点：` 的门从「一行」放宽为「一段」。
- ADR-0041 的十份文件清单与「不设 `docs/agents/`」被取代；ADR-0040 仍可回查分层取舍。

锚点：`docs/AGENTS.md`；`docs/adr/ADR-FORMAT.md`；`docs/ui-spec.md`；`docs/agents/domain.md`；`tests/docs-liveness.test.ts`；`tests/context-terms.test.ts`；`tests/comment-altitude.test.ts`；`AGENTS.md`；ADR-0041。
