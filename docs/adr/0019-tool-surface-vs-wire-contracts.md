# 工具面与 HTTP 面共用同一批门面动词；两套可空口径刻意分家

Status: accepted

六个 `dshnovel_` 工具与 UI、探针共用同一个 service 层，**不存在第二套实现**：工具模块只 `import type { ReadingService }`，每个 `execute` 都是门面动词的调用；`ReadingService` 的部件全是构造函数里的 `private readonly`，绕过门面在**类型上不可表达**。工具面自己只拥有**缺键投影**与 **render 文本投影**。**两套可空口径**：wire 上空值字段一律 `| null`，只有可能整键缺席的字段保持可选；工具面相反——把 `null` / `undefined` 整键省略——因为 harness 的 lossless-JSON 校验一票否决 `undefined` 属性值，会把真实结果整个吞掉；代价是投影改变类型，出参类型由调用方断言；被否决：各工具 `execute` 手抹（六处抄本，纪律靠抄）、把工具口径反向统一成 wire（wire 会长出「整键缺席」的假可选性）。**schema 从 wire 派生**：三份有对应 wire 类型的输出由一份常量清单在运行时比对 schema 属性集、在编译期用类型等式绑回 wire；仍开的一半：`read` / `import_source` / `source` 是工具自己的投影形状、无 wire 类型可绑，只能靠 execute 输出比对兜底（被否决：手抄快照 + 人工同步——wire 改名不会报红）。**契约升级是配套升级**：跨半形状改动不做新旧双形态自动猜测，Node 半与浏览器半必须同批上线；`rich` 不另存纯文本字段。**写动词的缺席语义**：更新动词把缺席表达成 `BookNotOnShelfError`（`classify` → 400），删除动词回布尔/计数（幂等成功）。在册待裁：`getDetail`、本地书管理、批探针没有对应工具，已批「不补」。

锚点：`src/tools/tools.ts`；`src/tools/project.ts`；`src/services/reading.ts`；`tests/tools/schema-contract.test.ts`；`src/shared/wire.ts` 的 `ChapterContent`；`src/shared/chapter-text.ts`；`src/services/errors.ts` 的 `BookNotOnShelfError`；`src/services/probe.ts` 的 `ProbeOutcome`；`src/api/dispatch.ts` 的 `shelfUpdate`；`tests/tools/probe-projection.test.ts`。
