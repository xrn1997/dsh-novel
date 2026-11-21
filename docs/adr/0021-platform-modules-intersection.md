# 平台模块表取**交集**不取并集；纯度门在构建期 throw

Status: accepted

浏览器半是 CJS 单文件闭包工厂，bundle 内每个 `require` 由宿主的**冻结模块表**解答。本仓维护一份 `PLATFORM_MODULES`，两条判据：**收录判据是「我们声明兼容的每一代宿主都答得上」（交集），不是把见过的清单并起来**——并集里多出来的每一条都是纯度门的一次豁免，守卫会从守卫变成共犯；据此撤掉裸 `cordis`（兼容窗口内并非每代都答得上，本插件只有 type-only import），也不收 `dockkit`。**纯度门是构建期插件**：在 `resolveId` 里对「平台表之外的 `@deepseek-ai/*` 值 import」与「Node 内建闯进浏览器 bundle」直接 throw；跨插件的值 import 是与生态的红线。由此推出：`src/shared/wire.ts` 必须**零运行时依赖**（它被整个 inline 进 client bundle）。产物自检里那份 require 白名单是配置的独立抄本，不许 import 配置（否则配置写宽了测试一起变宽）。本仓不「配 external」——client 侧由 `deps.neverBundle` / `alwaysBundle` 全量反转承担。待裁（属改进）：本仓不自带宿主每代 `staticModules()` 名单的采集面，「重读新表」无法机器判；可选做法是按代次冻结清单，但兼容判据不再架外部快照，此清单只能作开发期现查。

锚点：`tsdown.config.ts`（`PLATFORM_MODULES` 头注、`dsh-novel-bundle-purity`、三段式 banner 的 id 必须等于包名）；`tests/packaging-build.test.ts` 的「client 半纯度：require 集合恰为约定两条」；`src/shared/wire.ts` 文件头；`docs/development.md`「宿主兼容与实测名单」。
