## 1. 使用的方案

项目没有引入第三方日志框架，而是实现了一个极简的「日志缝」（log seam）：
- `src/services/log.ts` 定义 `LogSink` 接口（`info/warn/error(...args)`）和一个模块级可变 `sink`。
- 对外暴露 `log` 对象，三个级别方法都在调用 sink 之前强制拼接 `[dsh-novel]` 前缀。
- 通过 `setLogSink(next: LogSink)` 在运行时替换 sink；默认 sink 为原生 `console`，保证离线、测试以及组合根尚未安装适配器时仍可见。

这是仓库内唯一的结构化日志出口。引擎层不直接 import 该模块（依赖方向 `engine → services` 是单向的），沙箱侧未处理 rejection 的防护线改用注入的 sink，由注入方负责前缀。

## 2. 关键文件

| 文件 | 角色 |
|---|---|
| `src/services/log.ts` | LogSink 接口、默认 console sink、`[dsh-novel]` 前缀包装、`setLogSink` |
| `src/index.ts` | 组合根：构造 `ctx.logger('dsh-novel')` 的复合 adapter，注册到 log seam，并在 dispose 时复位回 `console` |
| `tests/services/log.test.ts` | 断言所有级别都以 `[dsh-novel]` 作为首参传给 sink |
| `src/services/request.ts` | 使用 `log.warn` 记录 URL 选项非法 / 未知键 |
| `src/services/source-eval.ts` | 使用 `log.warn` 记录动态头规则求值失败回退静态头 |
| `src/services/source-session.ts` | 使用 `log.error` 记录解析/落盘失败并附带备份路径 |
| `src/services/storage.ts` | 使用 `log.error` 记录解析失败及防抖落盘失败 |
| `src/services/sourcess.ts` | 使用 `log.error` 记录 recipe 抛错期间的落盘失败 |
| `src/services/search-face.ts` | 使用 `log.warn` 记录 bookUrlPattern 非合法正则 |

## 3. 架构与设计决策

- **单点出口 + 可插拔 sink**：所有留痕只经过 `src/services/log.ts` 的 `log` 对象，避免各模块手写前缀和散落的 `console.*` 调用。
- **两级输出（运行时）**：组合根在 `src/index.ts` 中把 sink 替换为一个复合 adapter——同时写入本机 `console` 和宿主的 `ctx.logger('dsh-novel')`。注释明确说明两条腿分工不同：console 用于本机可见性，logger 走 ring buffer 供启动诊断。
- **宿主 logger 的 level 过滤**：宿主 exporter 的缺省阈值 `LoggerLevel.INFO = 1` 会过滤掉 warn/debug，因此仅走 logger 那条腿会吞掉 warn 级留痕；console 腿的存在不是冗余。
- **生命周期安全**：组合根用 `ctx.effect(() => () => setLogSink(console), ...)` 在插件卸载时把 sink 复位回 `console`，防止模块级引用指向已卸载实例的 logger。
- **配置热更日志**：组合根还监听 volatile config，把出站代理变更以 `log.info` 写出。
- **服务注册守卫**：组合根对每个服务的注册包裹 try/catch，失败时用 `log.error` 写出；未处理 rejection 的全局守卫把 `warn` 桥接到 `log.warn`。

## 4. 约定与约束

- **唯一日志 API**：业务代码应通过 `import { log } from './services/log.js'` 使用 `log.info / log.warn / log.error`；测试中通过 `setLogSink` 注入捕获器验证行为（见 `tests/services/log.test.ts`）。
- **统一前缀**：所有级别方法的第一个参数恒为字符串 `[dsh-novel]`，由 log 层强制拼接；sink 实现不应自行加前缀。
- **三级语义**：`info` 用于正常流程信息（如配置热更、出站代理）、`warn` 用于降级/忽略场景（URL 选项非法、正则非法、动态头求值失败）、`error` 用于失败/回退（解析失败、落盘失败）。
- **引擎层隔离**：engine 包不 import `services/log`，避免反向依赖；沙箱异常路径通过注入的 sink 绕过此限制。
- **sink 替换必须显式恢复**：组合根在 dispose 钩子中复位为 `console`，任何自定义 sink 都应遵循同一模式，避免跨实例污染。