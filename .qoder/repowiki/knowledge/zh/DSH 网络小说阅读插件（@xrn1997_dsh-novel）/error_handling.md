## 1. 总体方案

本仓库采用「**两分法 + 分类学单点**」的错误处理架构，核心决策见 ADR-0016（`docs/adr/0016-error-two-tier-and-origin-fence.md`）：

- **域/引擎错误**（业务语义类）→ `services/errors.ts` 的 `classify(e)` → `ErrorCategory` → `api/wire.ts` 的 `STATUS_OF` 表 → HTTP 状态码与 wire `code`。
- **路由层自检错误**（405 / 未知路由 404 / body 校验 400 / 非受信来源 403 / payload 超限 413）→ 直接抛 `ApiError(message, status, code, segment?)`，**不经过分类学**，由 `writeError` 直通。

ADR 明确禁止用 `message.startsWith('源不存在')` 这类中文文案匹配做分类——分类权在类型上，改错别字不应改变 HTTP 状态码。路由侧也不许再 inline 写 `writeJson(res, <状态码>, …)`，否则会成为“第三面”。

## 2. 关键文件与包

| 文件 | 职责 |
|---|---|
| `src/engine/errors.ts` | 引擎层异常族：`EngineError`、`UnsupportedRuleError`、`RuleEvalError`、`JsSandboxError`，均携带 `facet`/`segmentIndex`/`segmentRaw` 定位信息；导出 `isEngineError` 守卫 |
| `src/services/errors.ts` | 服务层异常族（`SourceNotFoundError`、`ChapterNotFoundError`、`RuleMissingError`、`FetchError`、`DecodeError`、`InvalidRequestError`、`JobRunningError`、`LocalNotMountedError`）+ 唯一分类入口 `classify` + `ErrorCategory` 联合类型 |
| `src/services/epub/errors.ts` | EPUB 解析子树自有的 `EpubImportError`，避免反向依赖服务层门面，保持单向分层 |
| `src/api/wire.ts` | `ApiError`（自带 status/code）、`errorStatusOf`、`writeError`、`STATUS_OF` 映射表、同源校验 `isTrustedRequest` |
| `src/api/dispatch.ts` | `createApiHandler` 统一捕获，调用 `writeError` 落失败信封 `{ ok: false, error }` |
| `docs/adr/0016-error-two-tier-and-origin-fence.md` | 错误→HTTP 两分法、同源 fence Origin/Referer 策略的权威文档 |

## 3. 架构与约定

### 3.1 引擎异常族
`EngineError` 继承 `Error`，构造消息形如 `[facet#段N] message（规则片段: ...）`，并暴露 `facet`、`segmentIndex`、`segmentRaw`。子类扩展字段：
- `RuleEvalError.hits` — 命中数
- `JsSandboxError.script`、`line` — 沙箱脚本定位
所有引擎异常通过 `isEngineError(e)` 守卫识别，再由 `classify` 归入 `'rule-eval'`。

### 3.2 服务层异常族
每个领域错误定义一个具名 class，构造时设 `this.name = new.target.name`，以便 wire 层以 `e.name` 作为默认 `code`。注释中显式标注了该异常的 HTTP 语义（例如 `SourceNotFoundError` → 404、`RuleMissingError` → 422 + `RuleMissing`、`JobRunningError` → 409），这些语义由 `classify` 与 `STATUS_OF` 共同保证，而不是由 catch 分支决定。

### 3.3 分类学单点
`classify(e)` 是唯一的“异常 → 类目”映射，按更窄判据优先的顺序排列（例如先问 `LocalArtifactNotFoundError` 再问 `LocalImportError`，因为前者是 404、后者是 400）。未命中的异常落入 `'other'`（500 + `InternalError`）。

### 3.4 Wire 错误输出
`errorStatusOf` 两路分流：
- `instanceof ApiError` → 直接用 `e.status`、`e.code`
- 否则 `classify(e)` → `STATUS_OF[category]` → 生成 `{ status, body }`；若 `e instanceof EngineError`，附带 `segment` 字段
`writeError` 把结果写入 JSON 信封 `{ ok: false, error: { code, message, segment? } }`。

### 3.5 分层约束
EPUB 子树的异常（`EpubImportError`）只依赖 `shared/wire` 的类型，不 import 服务层门面异常，以避免循环依赖。服务层 `classify` 再通过 `instanceof` 接入它——依赖方向单向：门面 → 子树，永不反向。

## 4. 约定与约束

- **分类权在类型不在文案**：`services/errors.ts` 注释明确要求不要用裸 Error + 中文前缀匹配来分类；`instanceof` 是唯一判据（ADR-0016 ①）。
- **路由层自检错误不走分类学**：ADR-0016 ② 规定 405/404/400/403/413 等用 `ApiError` 直通，禁止把它们塞进分类表成为“第三面”。
- **路由侧不允许 inline 写状态码**：`api/wire.ts` 注释声明“路由侧不允许再 inline `writeJson(res, <状态码>, …)`”，一律走 `ApiError`。
- **引擎异常必须带 segment**：`EngineError` 及其子类携带 facet/segmentIndex/segmentRaw，wire 层自动投影到 `ApiErrorBody.segment`，用于客户端精确定位规则片段。
- **Wire 错误码来源优先级**：`STATUS_OF[code === '' ? e.name : code]`——`RuleMissing` 等固定码来自表，其余使用 `e.name`（即类名），因此新增异常类应让 `name` 有可读性。
- **同源 fence 策略**：`/novel-api` 仅放行 loopback；Origin 在场须与 Host 同源、Referer 在场须与 Host 同源；无 Origin/无 Referer 视为合法（给本机工具与 curl 的承诺），见 ADR-0016。
- **重复任务互斥**：`JobRunningError` 由任务模块抛出、路由层映射 409，`services` 层不 import api 层，避免环依赖（见 `services/errors.ts` 注释）。
- **本地书未挂载**：`LocalNotMountedError` 由门面层抛出，返回 503，路由层不再各自判断 `opts.local === undefined`。

## 5. 覆盖范围说明

本文基于对 `src/engine/errors.ts`、`src/services/errors.ts`、`src/services/epub/errors.ts`、`src/api/wire.ts`、`src/api/dispatch.ts` 及 ADR-0016 的直接审阅得出。仓库中存在大量 `new XxxError(...)` 与 `classify` 调用（grep 显示约 263 处），但本文仅归纳已验证的架构模式；未检查的其他模块是否遵循该模式不作断言。