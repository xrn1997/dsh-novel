# 工具面与 HTTP 面共用同一批门面动词；两套可空口径刻意分家

六个 `dshnovel_` 工具与 UI、探针共用同一个 service 层，**不存在第二套实现**：工具模块只 `import type { ReadingService }`，每个 `execute` 都是门面动词的调用——没有一处自己发 fetch、自己读 `sources.json` / `shelf.json`，也没有第二份规则求值。`ReadingService` 的全部部件是构造函数里的 `private readonly` 参数，所以「绕过门面直接动注册表」在**类型上不可表达**。

工具面自己只拥有两件事，因为它们属于 harness 的输出约束而不是业务语义：**缺键投影**与 **render 文本投影**。

**两套可空口径**：wire 上空值字段一律 `| null`（JSON 里 null 是在场的值），只有可能整键缺席的字段保持可选；工具面相反——把规范值里 `null` / `undefined` 的字段**整键省略**。这不是冲突：harness 对工具输出做 lossless-JSON 校验，`undefined` 属性值一票否决，会**把真实结果整个吞掉**。诚实记代价：投影改变类型，出参类型由调用方断言。被否决：各工具 `execute` 手抹（六处抄本，纪律靠抄）；把工具口径反向统一成 wire（wire 会长出「整键缺席」的假可选性）。

**schema 从 wire 派生，不手抄**：三份有对应 wire 类型的输出（search / toc / shelf）由一份常量清单在**运行时**比对 schema 属性集、并在**编译期**用类型等式绑回 wire —— wire 加字段会让 `pnpm typecheck` 红。仍开的一半要说清：read / import_source / source 是工具自己的投影形状，没有 wire 类型可绑，只能靠 execute 输出比对兜底。被否决：手抄快照 + 人工同步（早期五份就是如此，wire 改名不会报红）。

**契约升级是配套升级**：跨半形状改动（正文统一成 `ChapterContent`、新增导航面）不做新旧双形态自动猜测——让客户端按形状猜语义等于把契约交给运行时；Node 半与浏览器半必须**同批上线**（Node 重启后浏览器要刷新，不能只热更 client）。同理 `rich` 不另存一份纯文本字段：第二份字段一旦落盘就会与树分叉，同一本书的导出、AI 工具与阅读器会读到不同正文。

在册待裁：`getDetail`、本地书管理、批探针**没有对应工具**（本地书与批探针定位在 UI 面）——已批默认「不补、维持现状」；将来要补就按同一纪律从 wire 派生，不手抄第三份。

锚点：`src/tools/tools.ts`；`src/tools/project.ts`；`src/services/reading.ts`；`tests/tools/schema-contract.test.ts`；`src/shared/wire.ts` 的 `ChapterContent`；`src/services/chapter-content.ts`。
