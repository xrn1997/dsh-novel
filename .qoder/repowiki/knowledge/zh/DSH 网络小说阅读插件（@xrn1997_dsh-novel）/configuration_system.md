## 概览

本仓库的配置系统围绕 `src/config.ts` 一个文件构建，采用「单一字段表 → schemastery schema → 运行时只读读数面」的单向派生模型。所有运行期可调参数集中声明、统一校验、由 UI 与宿主 Loader 共同消费，避免在多处复制默认值与类型。

## 核心文件

- `src/config.ts`：唯一配置主人。定义 `CONFIG_FIELDS`、schema、`NovelConfig` / `ResolvedConfig` 类型、`resolveConfig()`。
- `src/client/config-page.tsx`：宿主 `plugins.bundle.config` 槽挂载的运行参数表单，仅渲染 `volatile` 字段。
- `src/services/reading.ts`：通过 `staticLiveConfig()` 暴露服务直装入口；对 `searchParallel` 做二次范围校验。
- `src/client/prefs-ui.ts`：阅读偏好常量（字号、行高、版面档位），不属于持久化配置，是 UI 预设。
- `locale/zh.json`、`locale/en.json`：配置项文案与提示。
- `tests/config.test.ts`、`tests/services/live-config.test.ts`：覆盖 `resolveConfig` 与 live config 语义。

## 架构与设计约定

### 1. 单一字段表（Single Source of Truth）

`CONFIG_FIELDS` 是唯一配置清单。每个条目包含：
- `default`：缺省值，统一从被消费模块导出的 `DEFAULT_*` 常量引用（如 `DEFAULT_TIMEOUT_MS`、`DEFAULT_JS_BUDGET_MS`），本文件不出现业务字面量。
- `volatile`：是否可运行时热更新（改 `dataDir` 需重启，改 `proxyUrl` 等即时生效）。
- `schema()`：返回 schemastery 子 schema，同时声明类型与值域。

新增字段只需加一行，`Config` schema、`NovelConfig` / `ResolvedConfig` 类型、UI 字段列表均由其派生——注释明确反对「在六份清单上各抄一次」。

### 2. 三类字段工厂

- `numberField(default, min)`：整数 + `.step(1)` + `.min(min)`，挡掉 NaN/Infinity。
- `textField()`：非活值文本（如 `dataDir`）。
- `proxyField()`：空串 / `direct` / `http(s)://host[:port]/path` 正则约束，完整解析在 `createFetcher` 前再做一次。

### 3. 双形态输入与只读读数面

`resolveConfig()` 接受两种输入：
- 纯值对象（测试、直装路径）→ 走 schemastery 校验。
- 含 `VOLATILE_WRITE` Symbol 的 ref 对象（宿主 Loader 解析后的活值）→ 跳过 schema，直接生成 getter。

返回值 `ResolvedConfig` 用 `Object.defineProperty` 为每格挂 getter，读取的是 `out[name]` 当前快照或 `get()`，保证 volatile 字段实时反映宿主持有的最新值。

### 4. 可编辑字段与不可变字段分离

通过 `VolatileConfigFieldName` 类型派生区分：
- `dataDir`：静态，不改 UI，等价重启。
- `searchTimeoutMs`、`jsTimeoutMs`、`searchParallel`、`cacheMaxBytes`、`exportDelayMs`、`localImportMaxBytes`、`proxyUrl`：进入 `configForms` 能力门后出现在设置页，保存即改宿主持有的活配置。

### 5. 安全兜底：`requireParallelStep`

`searchParallel` 若为非正整数，批循环 `i += n` 会永不终止而非抛错。因此 `services/reading.ts` 的 `requireParallelStep(n)` 在装配期和每次搜索循环都重读该值并 `throw RangeError`，作为「宁炸不猜」的第二道尺。

### 6. 多来源合并

原始配置来自三处同源：
- 插件页用户输入。
- 宿主 profile 中的 cordis patch（`cordis.patch.yml`）。
- 组合根直装的 `parts.config`。

宿主装载期用导出的 `Config` schema 校验并填充 patch 行的 config；`resolveConfig` 在生产路径上近似幂等。

### 7. UI 层约定

- 字段名、单位、预设、文案键全部集中在 `FIELDS` 记录中，键名来自 `VolatileConfigFieldName`，少一行就编译失败。
- 数值位不用 `type=number`（浏览器静默清空非法输入），而是 `inputMode="numeric"` + 宿主 `settingsNumberField` 的 parse；值域仍由 schema 把关。
- 字节换算按 1024（`humanBytes`），与仓内常量口径一致。
- 旧宿主没有 `configForms` 服务时，`registerConfigPage` 静默返回，配置页是可选能力。

### 8. 阅读偏好（prefs）

`prefs-ui.ts` 中的 `FONT_STEPS`、`LINE_HEIGHTS`、`MEASURES`、`PAPER_PRESETS` 是 UI 预设集合，不是持久化配置；它们通过宿主 prefs 机制单独存取，与 `config.ts` 的管理方式不同。

## 规则与约束

1. **新增配置字段必须加到 `CONFIG_FIELDS`**：这是唯一入口，类型与 schema 自动派生。（来源：`src/config.ts` 注释及 `Object.fromEntries(Object.entries(CONFIG_FIELDS))`）
2. **缺省值不得在本文件硬编码**：一律引用被消费模块导出的 `DEFAULT_*` 常量。（来源：`src/config.ts` 注释「缺省值一律引各消费模块的常量」）
3. **数值字段使用 `numberField`，禁止裸数字**：确保 step=1 且拦截 NaN/Infinity。（来源：`src/config.ts` 中 `numberField` 实现与六个字段的调用方式）
4. **`searchParallel` 必须在运行时再次校验**：装配期和每轮搜索均调用 `requireParallelStep`。（来源：`src/services/reading.ts` 第 104–106 行及第 644 行）
5. **volatile 字段才进设置表单**：非 volatile 字段（如 `dataDir`）不显示在 UI，改它等价重启。（来源：`maybeVolatile` 与 `VolatileConfigFieldName` 类型推导）
6. **代理 URL 格式由两层约束**：schemastery 正则 + `parseProxyUrl` 完整解析。（来源：`proxyField` 与 `services/fetcher.ts`）
7. **字节单位统一按 1024**：`humanBytes` 与仓内常量（如 `MB = 1024 * 1024`）保持一致。（来源：`src/client/config-page.tsx` 中 `humanBytes` 与 `FIELDS` 预设）
8. **配置加载失败应抛出错误而非降级**：`resolveConfig` catch 块抛出带说明的错误信息。（来源：`src/config.ts` 中 try/catch 逻辑）
9. **配置文件与 schema 同步**：`tests/config.test.ts` 验证配置结构与 schema 契约一致。（来源：测试文件命名与断言目标）

## 不适用性判断

本仓库存在完整的配置系统，涵盖配置定义、schema 校验、运行时活值、UI 表单、多来源合并与安全兜底，属于 high 置信度。