# 与宿主的关系：前缀是硬边界、peer 区间是安装闸、类型面用本地窄镜像

Status: accepted

五条约束都是宿主行为逼出来的：① **工具名全部带 `dshnovel_` 前缀**——宿主对工具重名直接抛错，撞名是插件工具面整体挂掉；浏览器半的槽位 id / keyed key 同一纪律（宿主对复用已有 id 的规则是静默替换占用者）。② **`peerDependencies` 是安装闸**：宿主逐项比对 `@deepseek-ai/dsh*` peer 区间，不满足即拒绝并回滚；写窄的后果是装都装不进去；连续窄区间放行线内预发布，跨宿主线才重新真机验；下界由 `JobSpec.output` 从 0.1.7-rc.1 起才有。③ **编译所依与实测声明是两层**：devDependency 精确钉版，`dsh.compatibility.dshReleases` 只列真跑过的宿主，编译所依必须被 peer 放行；`dshReleases` 不是安装许可。被否决：一个大区间（读数骗人）、`*`（会连 1.0 与所有未来宿主一起放行）；多一个状态词（`unknown` / `incompatible`）等于把「没验过」写进兼容门面。④ **宿主类型面一律本地窄镜像**（只声明用到的成员 + 一次强转），不装宿主类型包、不给已安装宿主包做 `declare module` 增强；本仓不 import 任何宿主 client 包，形状由消费点用例与假体钉住。⑤ **Node 半的宿主服务全硬 inject**（`webServer` / `tools` / `jobs`），缺服务就响亮失败；`ctx.on` 在 `apply` 里同步强取；浏览器半的 `locale` 服务是可选读。同处的防御：入口的模块级双重启用守卫——bundles 与插槽双启用会重复注册同一条 prefix 路由，宿主对重复 `(kind, path)` 直接 throw；第二份实例不注册路由/工具，留痕走 error 档。

> 后续翻案：决定④ 的「不装宿主类型包 / 不给已安装宿主包做 `declare module` 增强 / 不 import 任何宿主 client 包」已由 `ADR-0109` 收窄为「值 import 仍禁、契约类型只 type-only 借，`declare module` 只在包主官宣的扩展点」；①②③⑤ 不变。

锚点：`src/index.ts`（`inject` / `WebServerLike` / `JobsRuntimeLike` / `applied`）；`src/tools/tools.ts`；`src/services/job-holder.ts` 的 `JobHost`；`package.json`（peer 段与 `dsh.compatibility`）；`tests/packaging.test.ts`；`tests/tools/tools.test.ts`；`tests/index.test.ts`。
