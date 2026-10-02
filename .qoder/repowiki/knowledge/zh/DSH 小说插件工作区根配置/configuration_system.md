## 1. 使用方案

本仓库是一个 Cordis 宿主下的 DSH 插件，其运行时配置体系由三部分拼合：

- **Schema 校验**：`@deepseek-ai/schemastery`（`Schema.object(...)`），在 `src/index.ts` 定义 `NovelConfig` 类型与 `Config` schema。
- **Cordis 注入**：插件通过 `export const inject = ['webServer', 'tools', 'jobs']` 声明依赖宿主能力，`apply(ctx, config?)` 是入口；config 由 cordis 的 `resolveConfig` 从 cordis.yml 注入，未写时传 `undefined`，由 `.default({})` 兜住。
- **值域断言**：自定义 `assertConfig` 对数值范围做加载期拒绝（如 `searchParallel ≤ 0` 会永久饿死 Promise.all 批循环）。

数据持久化走自实现 JSON 原子写（见下节），不依赖外部配置数据库或 KV 引擎。

## 2. 关键文件

| 文件 | 职责 |
|---|---|
| `src/index.ts` | Cordis 插件入口、`NovelConfig` 接口与 `Config` schema、DEFAULTS 汇总表、`assertConfig`、`apply` 装配 |
| `src/services/proxy.ts` | 出站代理解析（config > env > Windows 注册表 > 直连） |
| `src/services/storage.ts` | 数据根目录 `novelDir()`、JSON 读写、原子写、损坏备份、进程内防抖合并 |
| `src/services/cache.ts` | `DEFAULT_CACHE_MAX_BYTES`（200MB） |
| `src/services/export.ts` | `DEFAULT_EXPORT_DELAY_MS`（300ms） |
| `src/services/fetcher.ts` | `DEFAULT_TIMEOUT_MS`（15000ms） |
| `src/services/reading.ts` | `DEFAULT_SEARCH_PARALLEL`（5）、`DEFAULT_JS_BUDGET_MS`（15000ms） |
| `src/services/localbooks.ts` | `DEFAULT_MAX_IMPORT_BYTES`（50MB） |
| `tests/services/defaults.test.ts` | 锁定各 DEFAULT_* 字面量，防止默认值漂移 |
| `vitest.config.ts` / `vitest.pack.config.ts` / `vitest.compat.config.ts` | Vitest 测试矩阵的运行时配置（非应用运行时配置） |

## 3. 架构与约定

### 3.1 配置分层与优先级

`src/index.ts` 中 `ReadingService.create` 接收的参数全部走同一模式：

```
config?.xxx ?? DEFAULTS.xxx
```

DEFAULTS 表本身只引用各服务导出的常量，注释明确要求「字面量只出现在各自的消费模块里」，避免配置文件与服务层回退值分叉。因此实际生效值的完整优先级为：

1. **显式配置项**（cordis.yml 传入 `apply` 的 `NovelConfig`）
2. **各服务模块的 `DEFAULT_*` 常量**（单测 `tests/services/defaults.test.ts` 钉住字面量）
3. **对于 `proxyUrl`**：再叠加一层运行时解析——`resolveProxyUrl` 将 `config.proxyUrl` → `HTTPS_PROXY/HTTP_PROXY/ALL_PROXY`（大小写两形态都认）→ Windows `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings\ProxyServer` → `null`（直连）
4. **对于 `dataDir`**：`config.dataDir ?? novelDir()`，其中 `novelDir()` 取 `$DSH_HOME` 或 `~/.dsh`，再拼 `novel` 子目录。

### 3.2 配置 Schema 与校验分离

`Config` schema 仅做**类型校验**（字段天然 optional，schema 无 `.optional()` 方法）；业务约束在 `assertConfig` 中以字符串错误消息抛出，例如：

```
[dsh-novel] 配置 searchParallel 非法：0（见 README 配置表）
```

这是「加载期响亮失败」策略，而非静默夹紧。

### 3.3 数据持久化约定

`src/services/storage.ts` 是**所有落盘的单一低层路径**：

- 数据根：`$DSH_HOME/novel`（`novelDir()` 唯一出口）。
- 原子写：`writeFileAtomic` / `writeJsonAtomic` 统一使用 `<file>.<pid>.<random>.tmp` 临时名 + `rename`，并按文件名串行排队（`renameChains` Map）以规避 Windows EPERM。
- 损坏处理：`readJson` 遇到 ENOENT 返回 fallback，解析失败则拷贝到 `<file>.bak` 后抛 `CorruptJsonError`，绝不折叠成空结果。
- 防抖：`createDebouncedWriter(100ms)` 合并连续写，`flush()` 等待全部落地（调用方在 dispose 钩子里 flush 书架/源注册表，防止 SIGINT 丢失窗口内最后一条）。
- 命名契约集中在一处：`TEMP_SUFFIX = '.tmp'`、`BACKUP_SUFFIX = '.bak'`，消费方（如 `localbooks.discard`）必须从这里取值而不是自己猜后缀。

### 3.4 宿主集成点

`apply` 通过 ctx.effect 注册三件事：

1. `ensureUnhandledGuard()` —— vm 沙箱内 fire-and-forget Promise rejection 的全局防线。
2. `c.jobs.attachController('dsh-novel')` —— 让宿主任务注册表接受本插件发起的工作（本机 web profile 自带 tool-jobs 被禁用，必须由插件补挂）。
3. `/novel-api` 路由 + tools 注册表。

重复启用防御：`applied` 标志 + dispose 复位，支持 cordis 热替换 unload→load。

## 4. 约定与规则

- **可配置项清单**（均可选）：`dataDir`、`searchTimeoutMs`、`searchParallel`、`jsTimeoutMs`、`cacheMaxBytes`、`exportDelayMs`、`localImportMaxBytes`、`proxyUrl` —— 新增字段需同时改接口、schema、DEFAULTS 表、`assertConfig` 及对应服务的构造参数。
- **默认值不得硬编码两处**：DEFAULTS 表仅引用各服务导出的 `DEFAULT_*` 常量；`tests/services/defaults.test.ts` 断言每个 DEFAULT_* 的字面量，是防止漂移的强制检查。
- **数值约束加载期拒绝**：`searchParallel ≥ 1`（整数）、`searchTimeoutMs > 0`、`jsTimeoutMs > 0`、`cacheMaxBytes ≥ 0`、`exportDelayMs ≥ 0`、`localImportMaxBytes > 0` —— 非法值直接抛错，不静默归一。
- **代理优先级固定**：`config.proxyUrl: 'direct'` → 环境变量（`HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`，大小写不敏感）→ Windows 注册表 `ProxyEnable=1` 时的 `ProxyServer` → 直连；`resolveProxyUrl` 是纯函数，仅读注册表那一步有副作用。
- **数据文件损坏不吞**：JSON 解析失败一律备份 `.bak` 并抛 `CorruptJsonError`，因为 SourceRegistry.load 会把截断内容当空注册表，后续 edit 会覆盖整库。
- **所有写盘走原子 + 按文件串行 + 100ms 防抖**：并发 rename 同目标在 Windows 上 EPERM，这是已实测问题；PageCache、shelf、source registry 共用同一低层路径。
- **插件入口幂等**：`applied` 标志防止 bundles+插槽双启用时重复挂载 `/novel-api`（会崩宿主进程），dispose 时复位允许热重载。
- **环境根变量**：`DSH_HOME` 决定数据根，缺省为 `os.homedir()/.dsh`，仅 `novelDir()` 读取，其他模块不直接碰环境变量。