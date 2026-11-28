# 宿主契约类型只借不依赖：type-only 进 devDependencies，`declare module` 只用于包主官宣的扩展点

Status: accepted

与宿主的关系原裁过「宿主类型面一律本地窄镜像，不装宿主类型包、不给已安装宿主包做 `declare module` 增强」（`ADR-0020` 决定④）。但入口与镜像要复用宿主会话、工作区与对话契约：纯窄镜像等于把宿主接口逐格手抄，宿主改形状时编译器不报，只剩运行时才发现。决定：**值依赖仍一条都不许**；契约类型可以 `import type` 借（devDependencies 精确钉编译所依的那一代），`declare module` 只用于包主在源码里官宣的 consumer 扩展点。

## 决定

1. **值依赖不变**：client 运行时 import 只来自平台模块表（`react` 两条）；宿主包只许 `import type`，编译期擦除，进不了产物。
2. **类型包进 devDependencies 并与 `dsh-tools` 同号**：类型面与编译所依同一代宿主；不进 `dependencies`（运行时不需要）、不进 `peerDependencies`（不能拿只用来编类型的包逼用户安装）。
3. **机器门**：`tests/packaging.test.ts` 词法扫 `src`，拦具名 / 动态 / 裸副作用三类值 import，并钉 devDeps 同号；`tsdown` 的纯度门仍只放行平台模块表。
4. **类型不等于运行时有**：跨代漂移不靠 tsc 假绿——镜像投影按运行时守卫降级（未映射种类＝占位、形状不符＝该轮降级）。
5. **`declare module` 只有一个理由**：包主在源码里写明 consumer 自己登记扩展点的位置（本仓用它登记 `SessionReferenceSourceMap` 的 `moyuStage` 引用标签）；不为别的契约补格。
6. **没有类型包的面继续窄镜像**：`pluginNavigation` 之类的结构化窄口照旧本地声明，不为此加包。

## 边界

- 不引入宿主值依赖、不改平台模块表、不把宿主包放进 peer。
- 类型只借只保证「按当版契约编得过」；旧代宿主上那些服务是否存在仍未验证——可选服务一律可选读（`ctx.get`），缺席就降级。
- 本篇只翻 `ADR-0020` 决定④的类型面；①工具名前缀 ②peer 区间 ③编译所依与实测两层 ⑤Node 半硬 inject 与双启用守卫 不变。

## 被否方案

- **继续纯本地窄镜像**：每格手抄宿主形状，宿主改形状时编译期无告警；假体与真实契约之间只剩测试碰运气。
- **把宿主包放进 dependencies 或 peer**：安装闸被宿主包闸取代，用户要为一批只编类型的东西买单。
- **用 `any` / 宽断言糊过去**：等于关掉漂移告警。

## 后果

- 五个宿主契约包进 devDependencies（与 `dsh-tools` 同号），跟版时一起抬。
- `lib/types` 的 d.ts 会带这些 import；公开类型入口不引用它们，但遍历全量 d.ts 的工具要能解析这几个包。
- `ADR-0067` 的「不 import 任何宿主 client 包」收窄为「不 import 值」：配置页仍零宿主包值依赖，平台模块表仍两条。

锚点：`package.json`（devDependencies）；`src/client/moyu-host.ts` 的 `declare module` / `MoyuHostPort`；`tests/packaging.test.ts`；`tsdown.config.ts` 的 `PLATFORM_MODULES`；`ADR-0020`（决定④ 被本篇收窄）、`ADR-0067`、`ADR-0108`。