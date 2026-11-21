# 插件页配置表单走 volatile 活配置，不重载插件

Status: accepted

dsh-novel 的运行参数放进宿主「插件」页的 `plugins.bundle.config` 槽：schema 标 `.volatile()`，Loader 解析后把字段变成稳定 ref；`resolveConfig` 返回只读 getter，服务在每次操作时读当前值。保存走宿主设置面 `ctx.remote.settings` 的 `describe` / `mutate`，不重启插件。`dataDir` 不进表单：它决定全部落盘根，改它必须重建 registry/shelf/cache/local，等价于重启。被否决：全部字段可编辑、保存后整插件重载（要自开配置路由 + `configEditor`，制造第二配置主人）；行页而不是 bundle 页；把 `dataDir` 也标 volatile（Loader 接受新值但服务不重建落盘根，制造「保存了但不生效」）；代理清空后重新探测系统代理；把设置面当硬依赖注册（用 `ctx.inject(['remote', 'remote.settings'], ...)` 可选注册，宿主未提供时插件照常激活，只是不见配置页）。**代价**：`resolveConfig` 多了「已解析 ref 不重跑 schema」的分支；服务层从构造时抄值改成每次读 getter；`proxyUrl` 变更要替换并关闭 undici dispatcher；`dataDir` 仍只能改文件 + 重启。

锚点：`src/config.ts` 的 `Config` / `resolveConfig` / `ResolvedConfig`；`src/services/fetcher.ts` 的 `createFetcher`；`src/client/config-page.tsx` 的 `registerConfigPage` / `NovelConfigCard`；`src/client/index.tsx` 的可选 `ctx.inject(['remote', 'remote.settings'], ...)`；`tests/config.test.ts`、`tests/services/live-config.test.ts`、`tests/client/config-page.test.tsx`；写协议见 `ADR-0067`。
