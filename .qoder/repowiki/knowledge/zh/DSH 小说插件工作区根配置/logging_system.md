## 1. 采用的方案

仓库没有引入任何第三方日志库（搜索 `pino`/`winston`/`bunyan`/`debug`/`tslog` 等关键字均无业务代码引用），也没有自研 logger 模块。所有运行期诊断信息统一通过 Node.js 原生 `console.log` / `console.warn` / `console.error` 直接输出。

## 2. 关键位置

- `src/index.ts`：插件初始化、代理 URL 打印、路由/工具注册失败的错误入口。
- `src/engine/js-sandbox.ts`：沙箱脚本的 `console.log` / `console.error` 被桥接到宿主；同时把沙箱内产生的日志收集到内存数组返回给调用方，而不是直接外泄打印（见第 608 行注释与第 999–1003 行的实现）。
- `src/services/request.ts`、`src/services/sources.ts`、`src/services/storage.ts`、`src/services/bridge.ts`、`src/services/search-face.ts`、`src/api/dispatch.ts`：各服务层对非法输入、文件落盘失败、正则解析失败等场景的警告与错误输出。

测试目录下的 `tests/temp-dir.ts`、`tests/setup.ts`、`tests/legado-coverage/matrix.ts` 等也使用了 `console.*`，但属于测试辅助代码。

## 3. 架构与约定

- **前缀约定**：所有业务日志都以 `[dsh-novel]` 作为统一前缀，便于在宿主控制台里过滤该插件的输出。示例：
  - `console.warn('[dsh-novel] duplicate apply ignored…')`
  - `console.log('[dsh-novel] 出站代理: ${proxyUrl}')`
  - `console.error('[dsh-novel] route registration failed:', e)`
- **级别用法**：仅使用三个级别，语义固定——
  - `console.warn`：可恢复的异常路径或用户输入不合法（URL 选项键未实现、动态头求值失败、bookUrlPattern 非合法正则）。
  - `console.error`：不可恢复的错误（service init failed、route/tools registration failed、sources.json 落盘失败、JSON 解析失败并抛出 CorruptJsonError）。
  - `console.log`：仅用于启动阶段的可观察信息（如打印代理地址）。
- **沙箱隔离**：引擎侧（`js-sandbox.ts`）对插件脚本暴露的 `console.log` / `console.error` 做了拦截——日志先写入 `logs` 数组，由上层决定是否透传到宿主 `hostConsole`；同时当触发同步 `java.ajax` 回退 worker 时，会清空已收集的 logs（第 753 行），避免同一段脚本的 console 输出重复出现。
- **结构化字段**：没有 JSON 结构化日志；额外上下文以字符串插值拼入消息正文（例如 `${source.name}`、`${resourceId}`、`${file}`），而非独立字段。

## 4. 约定与约束

- 业务日志统一带 `[dsh-novel]` 前缀（由 `src/index.ts` 及各 services 文件共同体现）。
- 沙箱脚本不允许直接写宿主控制台；所有 `console.log/error` 必须经 `js-sandbox.ts` 的桥接函数，且默认只收集进返回值中的 `logs` 数组（源码第 608 行注释明确说明“不外泄打印”）。
- 未定义 log level 枚举或配置项；当前行为完全依赖开发者对 `console.*` 三者的选择，无运行时开关或配置文件控制输出级别。
- 不存在集中化的 sink、格式化器或异步日志队列——每条日志都是同步调用 `console.*`。

综上，本仓库的 logging system 是**无框架、纯 console 的轻量约定式输出**，唯一具备工程化约束的是 `[dsh-novel]` 前缀以及沙箱侧对 `console.*` 的拦截收集。