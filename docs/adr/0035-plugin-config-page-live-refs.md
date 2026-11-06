# 插件页配置表单走 volatile 活配置，不重载插件

Status: accepted

dsh-novel 的运行参数（字段清单的家是 `src/config.ts` 的 `Config`）放进宿主「插件」页的 `plugins.bundle.config` 槽：schema 标 `.volatile()`，Loader 解析后把字段变成稳定 ref；`resolveConfig` 返回只读 getter，服务在每次操作时读当前值。保存由宿主 settings/configEditor 写回 profile patch，不重启插件。`dataDir` 不进表单：它决定全部落盘根，改它必须重建 registry/shelf/cache/local，等价于重启。

被否决的做法：

- **全部字段可编辑、保存后整插件重载**：要自开 `/novel-api` 配置路由 + `configEditor`，制造第二配置主人与更大兼容面；热更字段已覆盖日常调参。
- **行页而不是 bundle 页**：行页多点一次「配置」，本 bundle 只有一个行，bundle 页内嵌更直接。
- **把 `dataDir` 也标 volatile**：Loader 会接受新值，但服务不会重建落盘根——制造「保存了但不生效」的静默失败。
- **代理清空后重新探测系统代理**：热更路径要再读一次注册表，且系统代理可能在会话中变化；本设计固定为启动时 fallback，表单 hint 明说。
- **把设置面当硬依赖注册**：不采——根 `inject` 不动，用 `ctx.inject(['remote', 'remote.settings'], ...)` 可选注册；配置页挂点是可选的，宿主未提供该面时插件照常激活，只是不见配置页（兼容窗口的事实源是 `package.json`）。

**代价**：`resolveConfig` 多了「已解析 ref 不重跑 schema」的分支；服务层从构造时抄值改成每次读 getter；`proxyUrl` 变更要替换并关闭 undici dispatcher；未提供配置页面的宿主只是不见配置页，插件照常服务。`dataDir` 仍只能改文件 + 重启。

锚点：`src/config.ts` 的 `Config` / `resolveConfig` / `ResolvedConfig`；`src/services/reading.ts` 的 `staticLiveConfig` 与 `ReadingService.localImportMaxBytes`；`src/services/fetcher.ts` 的 `createFetcher`（dispatcher 缓存）；`src/client/config-page.tsx` 的 `registerConfigPage` / `NovelConfigCard`；`src/client/index.tsx` 的可选 `ctx.inject(['remote', 'remote.settings'], ...)`；钉子 `tests/config.test.ts`、`tests/services/live-config.test.ts`、`tests/client/config-page.test.tsx`、`tests/packaging-build.test.ts`；写协议见 `ADR-0067`。
