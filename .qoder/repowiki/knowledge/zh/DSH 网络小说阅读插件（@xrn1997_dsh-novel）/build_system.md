## 1. 总体方案

本项目是一个面向 DeepSeek Harness (DSH) 的浏览器插件，采用 **pnpm** 作为包管理器、**tsdown**（Rollup/Rolldown 封装）作为 TypeScript→JavaScript 打包器、**vitest** 作为测试运行器、**TypeScript** 做类型检查，并通过 GitHub Actions 在 `main` 分支 push/PR 时执行离线门禁。产物分为两部分：Node 端 ESM (`lib/index.js`) 和 DSH 宿主注入的浏览器 CJS 单文件工厂 (`lib/client.js`)。

## 2. 关键文件

- `package.json` — 脚本入口、`dsh` 扩展字段（bundle patch、client inject/platform、兼容性矩阵）、依赖声明
- `tsdown.config.ts` — 双目标构建配置（host node ESM + client browser CJS），含平台模块白名单与 bundle 纯度门
- `tsconfig.build.json` / `tsconfig.json` — TS 编译选项（dts 输出由 tsc 单独处理）
- `vitest.config.ts` / `vitest.compat.config.ts` / `vitest.pack.config.ts` — 常规测试、compat 回放、打包自检三套 Vitest 配置
- `.github/workflows/ci.yml` — GitHub Actions 离线门禁流水线
- `pnpm-workspace.yaml` / `pnpm-lock.yaml` — pnpm workspace + 锁定依赖版本

## 3. 构建架构与约定

### 3.1 双产物打包（tsdown）

`tsdown.config.ts` 定义两个 entry：

| 目标 | entry | format | platform | outDir | 说明 |
|---|---|---|---|---|---|
| host | `src/index.ts` | `esm` | `node` | `lib` | Node 侧 ESM，peerDeps 保持 external，npm 依赖 inline |
| client | `src/client/index.tsx` | `cjs` | `browser` | `lib` | 浏览器侧 CJS 单文件闭合工厂，三段式 banner/intro/footer 匹配 DSH `./client` 导出契约 |

- `lib/types/` 由 `tsc -p tsconfig.build.json` 单独生成，不在 tsdown 内联 dts（避免原生 yuku 模块与 banner 冲突）。
- `prepack` 钩子调用 `npm run build`（即 `tsdown && tsc -p tsconfig.build.json`），确保 `pnpm pack` 产出干净的 `lib/`。

### 3.2 平台模块白名单与 purity 门

`PLATFORM_MODULES` 显式列出宿主 web shell 冻结的模块表（react、react-dom、@deepseek-ai/cordis、@deepseek-ai/dsh-client-store/ui-slots/ui-primitives），且注释明确该表取“跨代兼容宿主的交集”，而非见过清单的并集。

- `neverBundle: isRequested` → 这些模块保留为 `require` 调用，不 inline。
- `alwaysBundle: !isRequested` → 其余 npm 依赖全部 inline。
- 自定义插件 `dsh-novel-bundle-purity` 在 resolveId 阶段拦截两类违规：① Node builtin 被引入浏览器 bundle；② `@deepseek-ai/*` 非白名单模块被引用。**违反则构建期抛错**，这是真正的强制约束。

### 3.3 宿主兼容性声明

`package.json` 的 `dsh.compatibility.dshReleases` 以键值对形式列举受支持的 DSH 版本（如 `0.1.5-rc.1` → `compatible`），同时通过 `dsh.client.platform = 'web'` 和 `inject` 列表声明运行时注入策略。

### 3.4 测试分层

- `tests/**/*.test.{ts,tsx}` 由 `vitest.config.ts` 收集，排除 `tests/compat/**` 与 `tests/packaging-build.test.ts`。
- `tests/setup.ts` 提供全局 setup；`@deepseek-ai/dsh-client-ui-primitives` 被 alias 到本地 stub，使 UI 测试能在 Node 环境跑。
- `vitest.compat.config.ts` 驱动 compat 回放集（`pnpm test:compat`），与主测试集互斥。
- `vitest.pack.config.ts` 驱动打包自测（`pnpm test:pack`），先 `pnpm build` 再验证产物。

### 3.5 CI 门禁（GitHub Actions）

`.github/workflows/ci.yml` 仅运行 **offline-gates** 任务（Ubuntu + Node 24 + pnpm 11.25.0），步骤顺序固定为：

1. `pnpm install --frozen-lockfile`
2. `pnpm typecheck`
3. `pnpm lint`
4. `pnpm test`
5. `pnpm test:pack`
6. `pnpm test:compat`

注释明确将需要真实站点/浏览器/本机的真链路门（REPROBE、CONTENT_AUDIT、SEARCH_FILTER_AUDIT、EPUB_BROWSER、WEBVIEW、INSTALL_CHECK）排除出日常 CI，改为开发者手动执行。

## 4. 约定与规则

- **依赖安装必须使用 `pnpm install --frozen-lockfile`**：CI 中强制，lockfileVersion 9 与 pnpm 11.25.0 需对齐（见 workflow 注释）。
- **构建命令**：`pnpm build` = `tsdown && tsc -p tsconfig.build.json`，`pnpm dev` = `tsdown --watch`。
- **测试命令**：`pnpm test`（主测试）、`pnpm test:compat`（compat 回放）、`pnpm test:pack`（打包自检，先 build 后测试）。
- **类型检查**：`pnpm typecheck` = `tsc --noEmit`。
- **ESLint**：`pnpm lint`，配置文件位于根目录 `eslint.config.js`。
- **浏览器 bundle 纯度**：任何 `@deepseek-ai/*` 外部模块或 Node builtin 进入 client bundle 都会触发 tsdown 自定义插件抛错——这是构建期的硬性阻断，不是警告。
- **Client 导出契约**：`lib/client.js` 必须以 `window.__ModuleLoader__.load({ id: '@xrn1997/dsh-novel', factory: (require) => { ... } })` 三段式包裹，由 `outputOptions.banner/intro/footer` 硬编码保证。
- **Host/Client 依赖分离**：host 端 peerDeps 保持 external，client 端除 PLATFORM_MODULES 外全部 inline；`playwright-core` 被显式加入 `neverBundle` 以避免污染浏览器 bundle。
- **发布范围**：`files` 字段限定 publish 产物只包含 `lib`、`locale`、`icon.svg`、`cordis.patch.yml`、`README.md`、`LICENSE`。
- **DSH 版本矩阵**：新增受支持版本需在 `package.json` 的 `dsh.compatibility.dshReleases` 中添加条目，配合 ADR `0026-dsh-scope-exempt-from-release-cooldown.md` 中的版本收敛策略。

## 5. 未覆盖项

仓库未发现 Dockerfile、Makefile、独立 release 脚本或跨平台交叉编译配置；版本管理直接走 `package.json` 的 `version` 字段，无 semver 预发布脚本。