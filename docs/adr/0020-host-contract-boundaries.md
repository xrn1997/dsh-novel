# 与宿主的关系：前缀是硬边界、peer 区间是安装闸、类型面用本地窄镜像

五条约束都不是本仓的口味，而是宿主行为逼出来的：

1. **工具名全部带 `dshnovel_` 前缀**。宿主对工具重名**直接抛错**——撞名不是显示难看，是插件工具面整体挂掉；逐词避让是治标，插件专属前缀才是根治。名字集合由测试钉住。
2. **`peerDependencies` 是宿主的安装闸，不是自述**。宿主 `dsh plugin add` 会拿运行中的宿主版本逐项比对插件的 `@deepseek-ai/dsh*` peer 区间，不满足即 `installation rejected` 并回滚。所以区间写窄的后果不是「不兼容」而是**装都装不进去**；semver 的预发布规则使「>=A <B」只开最低那一代，**不存在免维护写法**，只能逐代显式开口。被否决：一个大区间（读数骗人）、`*`（同样不放行预发布）。
3. **编译所依与实测声明是两层**。devDependency 精确钉版（编译所依）与 `dsh.compatibility.dshReleases`（只列真跑过的宿主、状态词只许 `compatible`）各管各的事，同一条测试看住两头：编译所依必须被 peer 放行、且不得早于已声明兼容的最新宿主。`dshReleases` **不是安装许可**——混了就会出现「声明兼容却装不进去」。多一个状态词（`unknown` / `incompatible`）等于把「没验过」写进兼容门面。
4. **宿主类型面一律本地窄镜像**（只声明用到的成员 + 一次强转），不装宿主类型包、不做 `declare module` 增强。理由：npm 上的宿主包与运行中的宿主**不同代**，引包等于主动拿一套与在跑宿主不符的契约；`extends Context` 还会撞 TS2717（同一服务名在 host/client 两侧类型不同）。正解是让版本差异在**运行时**暴露，而不是在类型层假装对齐。
5. **三个宿主服务全硬 inject**（`webServer` / `tools` / `jobs`），不用「可选挂接」——缺服务就该响亮失败（`plugin tree failed to load`），不降级静默少挂功能。同处的防御：入口的模块级双重启用守卫——bundles 与插槽双启用会重复注册同一条 prefix 路由，而宿主对重复 `(kind, path)` 直接 throw ⇒ 整棵插件树 boot 失败；**前缀命名因此是组合级契约**。

锚点：`src/index.ts`（`inject` / `WebServerLike` / `JobsRuntimeLike` / `applied`）；`src/tools/tools.ts`；`src/services/import-job.ts` 的 `JobHost`；`package.json`（peer 段与 `dsh.compatibility`）；`tests/packaging.test.ts`；`tests/tools/tools.test.ts`；`tests/index.test.ts`。
