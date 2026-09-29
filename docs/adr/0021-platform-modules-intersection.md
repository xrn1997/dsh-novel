# 平台模块表取**交集**不取并集；纯度门在构建期 throw

浏览器半是 CJS 单文件闭包工厂，bundle 内每个 `require` 由宿主的**冻结模块表**解答。本仓维护一份 `PLATFORM_MODULES`，两条判据：

- **收录判据是「我们声明兼容的每一代宿主都答得上」（交集），不是把见过的清单并起来。** 并集里多出来的每一条都是纯度门的一次豁免——允许表宽于运行时表，守卫就从守卫变成共犯，证明的不再是「官方表长这样」而是「我们只 require 这些」。据此**撤掉**裸 `cordis`（它只活在更早两代官方样例的清单里；本插件对 cordis 从头到尾只有 type-only import，留着等于允许一次「构建通过、浏览器 require 落空」），也据此**不收**新代宿主新种的 `dockkit`（本插件不用它、老宿主也没有，收了等于用新宿主的表给老宿主放行）。
- **纯度门是构建期插件，不是构建后断言**：在 `resolveId` 里对「平台表之外的 `@deepseek-ai/*` **值** import」与「Node 内建闯进浏览器 bundle」直接 throw。跨插件的值 import 是与生态的红线（官方 slots 规则同一条：别的包只能 `import type`）。

由此推出的一条硬约束：`src/shared/wire.ts` 必须**零运行时依赖**——它被整个 inline 进 client bundle，引任何运行时依赖都会撞自己的门。

产物自检里那份 require 白名单是配置的**独立抄本**，不许 import 配置：抄本若 import 配置，「配置写宽了」会连同测试一起变宽，守卫退化成回声。

用词提醒：本仓不「配 external」——client 侧的 external 语义由 `deps.neverBundle` / `alwaysBundle` 全量反转承担（`CONTEXT.md` 把「external / noExternal 配置」列为禁词）。

待裁（属改进不属决策）：宿主每代的 `staticModules()` 名单目前只能每次 bump 现读，因此「重读新表」这一件事无法机器判——可选做法是照 `compat/upstream/snapshot.json` 的先例给宿主模块表也做一份按代次冻结的仓内快照。

锚点：`tsdown.config.ts`（`PLATFORM_MODULES` 头注 = 判据的家、`dsh-novel-bundle-purity`、三段式 banner 的 id 必须等于包名）；`tests/packaging-build.test.ts` 的「client 半纯度：require 白名单外零泄漏」；`src/shared/wire.ts` 文件头；`README.md`「宿主兼容声明分两层」末条。
