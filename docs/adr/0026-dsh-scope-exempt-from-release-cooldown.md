# 宿主依赖包的发布冷却闸整 scope 放行

Status: accepted

pnpm 默认的 `minimumReleaseAge`（24 小时内发布的版本不许进 lockfile）对 `@deepseek-ai/dsh-*` **整 scope 放行**，写死在 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`（`'@deepseek-ai/dsh-*'`）。**为什么**：本仓对这些包一律用**精确版本**，「吃不吃刚发布的这一版」已经由人写死在一个具名版本上——冷却闸想防的「无人复核就吃下新鲜发布」在这条路径上已被版本号本身顶掉；非 DSH 包仍走默认冷却。**为什么不是逐版点名**：逐版名单每次宿主升级都要人手整批换版，漏换的后果不是装得慢，而是整仓打不开——`pnpm install` 拒绝、`pnpm test` 的 pre-run 依赖校验转去 install，于是连测试一起断；一份靠人手逐代续写的白名单，失效时没有任何门会红。被否决：逐版点名、在仓内 `.npmrc` 写 `minimum-release-age=0`（那份读不到，且把所有包一起关掉）、等 24 小时。**重开条件**：若本仓开始对 `@deepseek-ai/dsh-*` 使用范围版本，这条豁免的论据就没了。

锚点：`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`；`package.json` 的 devDependencies；`docs/development.md`「宿主兼容与实测名单」。
