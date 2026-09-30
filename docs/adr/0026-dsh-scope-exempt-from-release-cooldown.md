# 宿主依赖包的发布冷却闸整 scope 放行

pnpm 默认的 `minimumReleaseAge`（24 小时内发布的版本不许进 lockfile）对 `@deepseek-ai/dsh-*` **整 scope 放行**，写死在 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`：

```yaml
minimumReleaseAgeExclude:
  - '@deepseek-ai/dsh-*'
```

**为什么**：本仓对这些包一律用**精确版本**（`package.json` 的 devDependencies / peerDependencies 里没有范围），「吃不吃刚发布的这一版」这个判断本来就已经由人写死在一个具名版本上——冷却闸想防的「无人复核就吃下新鲜发布」，在这条路径上已经被版本号本身顶掉了。非 DSH 包不受影响，仍走默认冷却。

**为什么不是逐版点名**：上一版名单是 17 条 `@0.1.7-rc.2`，宿主升到 `0.2.0-rc.2` 时整批漏换，后果不是「装得慢一点」而是整仓打不开：`pnpm install` 以 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` 拒绝，而 `pnpm test` 的 pre-run 依赖校验发现 `node_modules` 落后于 lockfile、转去调 install，于是连测试一起断——**一份靠人手逐代续写的白名单，失效时没有任何门会红**。这个故障模式才是决定换通配的理由；名单本身少写 17 行只是表象。

被否决的做法：

- **逐版点名**（保持原样）：保留「每次发版显式放行」的语义，代价是上面那条无门可守的静默失效——已经实测栽过一次。
- **在仓内 `.npmrc` 写 `minimum-release-age=0`**：本仓设置的家是 `pnpm-workspace.yaml`，`.npmrc` 那份读不到（`pnpm config get` 仍为空）；而且那是把冷却闸对**所有**包一起关掉，为省 17 行而放弃全部保护。
- **什么都不做，等 24 小时**：发布满 24 小时后安装自然恢复，但这让「宿主发版当天改本仓」这件事在物理上不可能。

**重开条件**：若本仓开始对 `@deepseek-ai/dsh-*` 使用范围版本（而非精确版本），这条豁免的论据就没了——那时该回来重估，而不是继续放行。

锚点：`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`；`package.json` 的 devDependencies（精确版本这一前提的现场）；`README.md`「宿主兼容声明分两层」末段。
