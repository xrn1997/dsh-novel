## 1. 采用的体系

仓库使用 npm/pnpm 生态的轻量型构建工具链：

- **包管理**：`pnpm-workspace.yaml`（启用 `allowBuilds: esbuild: true`，排除 `@deepseek-ai/dsh-*` 最低发行年龄限制）+ `pnpm-lock.yaml`。
- **TypeScript 编译/类型检查**：`tsconfig.json`（`strict: true`、`moduleResolution: Bundler`、`noEmit: true`，仅做类型检查，不产出）。
- **打包器**：`tsdown`（基于 rolldown/esbuild），通过 `tsdown.config.ts` 定义两个独立输出。脚本入口集中在 `package.json` 的 `scripts` 字段。
- **测试框架**：Vitest，按用途拆成三个配置文件（常规 / compat / packaging-build）。
- **宿主集成**：作为 DSH 插件通过 `@deepseek-ai/cordis` 注册，`cordis.patch.yml` 声明插件 id。

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `package.json` | 包元数据、`dsh.*` 宿主契约（bundle patch、client inject、compatibility.dshReleases）、`scripts`、`exports` 多入口 |
| `tsdown.config.ts` | 双半构建配置（host ESM + client CJS），含平台模块白名单与 purity 门 |
| `vitest.config.ts` | 常规测试集（排除 compat 与 packaging-build） |
| `vitest.compat.config.ts` | legado 兼容回放集（单独 include `tests/compat/**`） |
| `vitest.pack.config.ts` | 构建产物自检集（仅 `tests/packaging-build.test.ts`） |
| `tsconfig.json` | TypeScript 严格模式 + path alias `@engine/*` |
| `pnpm-workspace.yaml` | pnpm 行为开关 |
| `cordis.patch.yml` | cordis 插件注册补丁 |
| `tests/packaging-build.test.ts` | 对 `lib/index.js` / `lib/client.js` 的二进制级断言 |

## 3. 架构与约定

### 双半构建（host / client）

`tsdown.config.ts` 导出一个数组，生成两份产物，均落在 `lib/`：

- **host 半**（`src/index.ts`）：ESM、`platform: 'node'`、target ES2024、带 `.d.ts` 类型直出；依赖策略为 `neverBundle` 排除 `@deepseek-ai/*`（peerDependency 保留 import）、`alwaysBundle` 打包其余 npm 依赖。
- **client 半**（`src/client/index.tsx`）：CJS 单文件工厂，`platform: 'browser'`、sourcemap 开启；将除平台白名单外的全部 npm 依赖 inline 进 bundle，并通过 banner/intro/footer 三段式包裹 `window.__ModuleLoader__.load({ id: '@xrn1997/dsh-novel', factory })`——这是官方 `./client` 导出契约。

### 平台模块表与纯度门

`PLATFORM_MODULES` 维护一份“宿主 web shell 的 `staticModules()` 交集”：`react`、`react/jsm-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`-ui-slots`、`-ui-primitives`。构建期插件 `dsh-novel-bundle-purity` 拒绝两类导入：

1. Node 内建模块进入浏览器 bundle。
2. `@deepseek-ai/*` 中不在白名单的 require。

测试端在 `tests/packaging-build.test.ts` 中以独立白名单副本再验证一遍 `require(...)` 结果，避免“配置写宽了，测试也跟着放宽”。

### 运行时环境常量注入

client 半通过 `define` 注入四键：`process.env`、`process.env.NODE_ENV`、`import.meta.env.MODE`、`import.meta.env`，以杜绝 Node 习惯依赖在浏览器 boot 抛 `ReferenceError`。

### 测试矩阵

- 常规集：`vitest run`，`include: tests/**/*.test.{ts,tsx}`，`environment: node`，排除 `tests/compat/**` 与 `tests/packaging-build.test.ts`。
- compat 集：`pnpm test:compat`，单独 config 只 include `tests/compat/**`，由 `capture.test.ts` 内的 `COMPAT_CAPTURE` 门控默认 skip。
- packaging-build 集：`pnpm test:pack`（先 `pnpm build` 再跑），断言 `lib/index.js` 包含插件身份与 `/novel-api`、不含 `__ModuleLoader__`；断言 `lib/client.js` 三段式工厂、sourcemap 注释在 footer 之后、面板注册存在；断言 dts 含 `apply` / `Config`。

### 宿主兼容性声明

`package.json` 的 `dsh.compatibility.dshReleases` 列出已验证的 DSH 版本（`0.1.5-rc.1` 到 `0.2.0-rc.2`），`dsh.client.inject` 声明注入 `@deepseek-ai/dsh-client-ui-primitives`，`dsh.bundle.patch` 指向 `cordis.patch.yml`。

## 4. 约定与约束

- **构建命令**：统一通过 `pnpm build`（等价 `tsdown`）触发双半构建；开发用 `pnpm dev --watch`。
- **类型检查**：`pnpm typecheck` 调用 `tsc --noEmit`，`tsconfig.json` 设置 `noEmit: true`，禁止 TS 自行产文件。
- **发布入口**：`package.json` 的 `main`、`types`、`exports` 三处同时指向 `lib/`；`files` 字段仅发布 `lib`、`cordis.patch.yml`、`README.md`、`LICENSE`。
- **Client 工厂契约**：`lib/client.js` 首行必须是 `window.__ModuleLoader__.load({ id: '@xrn1997/dsh-novel', factory: (require) => {`，末尾必须闭合为 `return module.exports; } });`，由 `tsdown.config.ts` 的 `banner`/`intro`/`footer` 强制，并由 `tests/packaging-build.test.ts` 校验。
- **平台模块白名单**：只有 `tsdown.config.ts` 中的 `PLATFORM_MODULES` 八项可被 client bundle 以 `require` 形式引用；其余 `@deepseek-ai/*` 会触发构建错误（purity 门），由同一文件的 resolveId 插件与测试双重保证。
- **Node 内建禁入浏览器**：任何 Node builtin（含 `node:` 前缀）进入 client bundle 都会直接 throw Error。
- **测试隔离**：常规 vitest 与 compat 回放互斥（通过各自 config 的 include/exclude 实现），packaging-build 单独运行以避免污染常规集。
- **pnpm 工作区规则**：允许 esbuild 子进程构建；对 `@deepseek-ai/dsh-*` 包跳过最低发行年龄检查（适配 RC 版宿主依赖）。
- **prepare 钩子**：`package.json` 定义了 `"prepare": "tsdown"`，安装依赖后自动触发构建。