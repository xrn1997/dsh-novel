## 总体方案

仓库采用「两分法」错误体系，把 **domain/引擎错误** 与 **路由层自检错误** 严格分开，通过一个集中分类器 `services/errors.classify` 和一张状态映射表 `api/wire.STATUS_OF` 统一落盘为 JSON 信封 `{ ok: false, error: { code, message, segment? } }`。

- 领域错误：抛出自定义 Error 子类 → `classify(e)` 返回 `ErrorCategory` → `errorStatusOf` 查 `STATUS_OF` → `writeError` 写响应。
- 路由自检错误：直接抛 `ApiError(message, status, code, segment?)`，跳过分类学，status/code 原样透传。

该设计在 ADR `docs/adr/0016-error-two-tier-and-origin-fence.md` 中显式记录，并强调「分类权在类型上，不在中文文案上」（历史形态是 `message.startsWith('源不存在')`，改错别字即改 HTTP 状态码）。

## 关键文件与包

| 文件 | 职责 |
|---|---|
| `src/services/errors.ts` | 领域错误类 + `ErrorCategory` 枚举 + `classify(e)` 单点分类器 |
| `src/api/wire.ts` | `ApiError`、`isTrustedRequest`、`readCappedBody`、`readJsonBody`、`writeOk`、`writeError`、`errorStatusOf`、`STATUS_OF` |
| `src/engine/errors.ts` | 引擎层异常族（`EngineError` / `UnsupportedRuleError` / `RuleEvalError` / `JsSandboxError`）+ `isEngineError` 守卫 |
| `src/services/epub/errors.ts` | EPUB 子树异常 `EpubImportError`，仅面向解析层，不反向依赖服务层 |
| `src/shared/wire.ts` | `ApiErrorBody` / `ApiEnvelope` 契约类型 |
| `src/api/dispatch.ts` | 路由分发；所有校验分支均抛 `ApiError`，不再 inline `writeJson(res, <code>, …)` |
| `docs/adr/0016-error-two-tier-and-origin-fence.md` | 两分法与同源 fence 的正式决策文档 |

## 架构与约定

### 1. 领域错误类族

`src/services/errors.ts` 定义一组语义明确的异常类：

- `SourceNotFoundError` — 书源缺失，HTTP 404
- `ChapterNotFoundError` — 目录缺章，HTTP 404
- `RuleMissingError` — 规则缺失，HTTP 422，code 固定 `RuleMissing`（与搜索面/探针共享同一词汇）
- `FetchError` — 出站请求失败（超时/网络/非 2xx），HTTP 502
- `DecodeError` — charset 解码失败，HTTP 502
- `InvalidRequestError` — 值域非法（如负数、越界比例），HTTP 400
- `LocalNotMountedError` — 本地书服务未挂载，HTTP 503
- `JobRunningError` — 任务互斥，HTTP 409

每个类的 `name` 被显式设为构造名 (`this.name = new.target.name`)，用于作为 wire 错误码的 fallback。

`src/engine/errors.ts` 提供基类 `EngineError`（带 facet、segmentIndex、segmentRaw）以及 `UnsupportedRuleError`、`RuleEvalError`、`JsSandboxError`，并通过 `isEngineError` 守卫供 `classify` 识别。

`src/services/epub/errors.ts` 的 `EpubImportError` 独立于服务层异常，保持「门面 → 子树」单向依赖。

### 2. 分类学与状态映射

`classify(e)` 是唯一把「异常类 → `ErrorCategory`」的逻辑所在，`ErrorCategory` 取值：`rule-eval` / `rule-missing` / `fetch` / `not-found` / `bad-request` / `local-import` / `local-too-large` / `unavailable` / `job-running` / `other`。

`STATUS_OF` 把类目投影到 HTTP 状态码与 wire `code`：`rule-eval`→422、`rule-missing`→422(`RuleMissing`)、`fetch`→502、`not-found`→404(`NotFound`)、`bad-request`→400(`BadRequest`)、`local-import`→400、`local-too-large`→413(`PayloadTooLarge`)、`unavailable`→503(`Unavailable`)、`job-running`→409(`JobRunning`)、`other`→500(`InternalError`)。

`errorStatusOf(e)` 先检查 `ApiError instanceof`，再走 `classify` 查表；对 `EngineError` 额外附带 `segment` 字段。对于没有显式 code 的类目，使用 `e.name`（即类名）作为 wire code。

### 3. 路由层约束

ADR 明确禁止三类行为：

- 路由侧不允许再 inline 写 HTTP 状态码（会形成「第三面」），必须抛 `ApiError`。
- 路由自检错误不进分类学（405 / 未知路由 404 / body 校验 400 / 非受信来源 403 / 非法百分号编码 400）。
- 所有响应走 `writeOk` / `writeError`，由 `wire.ts` 唯一控制信封形状。

`dispatch.ts` 中所有校验分支（方法检查、参数校验、路径解码、body 结构校验、登录结果校验等）均以 `throw new ApiError(...)` 形式抛出，不再直接调用 `writeJson`。

### 4. 同源 Fence

`isTrustedRequest(req)` 实现 `/novel-api` 的同源门限：只放行 loopback（`127.0.0.1`、`::1`、`::ffff:127.0.0.1`），且要求 Origin 在场时与 Host 同源、Referer 在场时与 Host 同源。**无 Origin / 无 Referer 视为合法**——这是给本机工具与 curl 的显式承诺。

选择同时看 Origin 而不只看 Referer 的原因是：恶意页可用 `<meta name="referrer" content="no-referrer">` 让 Referer 缺席，但浏览器对跨源 POST 总是发 Origin；若不拒「Origin 存在且跨源」，则 `content-type: text/plain` 的 simple POST（不触发 preflight）即可 CSRF 攻击导入/批量/登录路由。

### 5. 流式体上限

`readCappedBody` 提供唯一的流式字节计数循环，默认上限 `DEFAULT_JSON_BODY_MAX_BYTES = 1 MiB`；超限抛 `ApiError(413, 'PayloadTooLarge')`。注释强调「这个数是唯一主人」，调用方要放宽就传参，不能再写第二个字面量。

## 观察到的约定与约束

- **领域错误一律继承自 `Error`**，构造函数设置 `this.name = new.target.name`，以便 wire 层提取类名作为错误码。
- **分类权在类型上，不在中文文案上**；历史形态 `message.startsWith('源不存在')` 已被标记为需淘汰。
- **两分法不可混用**：domain 错误走 `classify` + `STATUS_OF`；路由自检错误走 `ApiError` 直通。ADR 明确指出「被否决：把所有状态码映射塞进同一张表」。
- **新增领域错误类后，必须在 `classify` 中注册**，否则落入 `other` → 500 InternalError。
- **引擎异常**（`EngineError` 及其子类）在 wire 层自动附带 `segment`（facet、segmentIndex、segmentRaw），便于客户端定位规则片段。
- **EPUB 子树异常**不得反向 import 服务层异常类，以维持「门面 → 子树」单向依赖。
- **测试判据**：ADR 指出 `tests/api/routes.test.ts` 仍以中文措辞「未知路由」为断言，属于「在册待裁」——应改为基于 `code` 的结构化断言。
- **Wire 契约**：成功信封 `{ ok: true, value }` 与失败信封 `{ ok: false, error: { code, message, segment? } }` 的形状定义在 `src/shared/wire.ts`，`api/wire.ts` 仅 re-export 类型。

## 置信度评估

本模式在多个层面得到验证：专门的错误定义文件（`engine/errors.ts`、`services/errors.ts`、`services/epub/errors.ts`）、集中分类器、API 层 `ApiError` 与状态映射表、ADR 正式决策、以及 `dispatch.ts` 中一致的 `throw new ApiError` 用法，证据充分且跨模块一致。