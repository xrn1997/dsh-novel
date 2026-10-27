## 1. 使用的系统/工具

- **包管理器**：pnpm（仓库根存在 `pnpm-lock.yaml`、`pnpm-workspace.yaml`，脚本使用 `pnpm build` / `pnpm test`）。
- **构建器**：tsdown（`scripts.build = "tsdown && tsc -p tsconfig.build.json"`），输出到 `lib/`。
- **宿主集成**：通过 `@deepseek-ai/cordis` 以 DSH 插件形式发布；运行时依赖由宿主提供，本包通过 `peerDependencies` 声明。
- **私有/企业源**：未见 `.npmrc` / `pnpm.config.*` 等自定义 registry 配置，未启用 vendoring。`pnpm-workspace.yaml` 中的 `minimumReleaseAgeExclude` 用于绕过 pnpm 的 supply-chain 24h 冷却校验，说明依赖主要来自 npm 公共注册表，且对 `@deepseek-ai/*` 内部包做了放宽处理。

## 2. 关键文件

- `package.json`：唯一依赖清单（dependencies / devDependencies / peerDependencies）、`dsh.bundle.patch`、`dsh.compatibility.dshReleases`、`exports` 多入口。
- `pnpm-workspace.yaml`：允许 esbuild 构建、豁免 `@deepseek-ai/dsh-*` 及个别传递依赖的 minimum release age。
- `pnpm-lock.yaml`：锁定所有依赖树版本（supply-chain 校验的权威来源）。
- `cordis.patch.yml`：DSH cordis 打包补丁，控制 bundle 阶段的行为。

## 3. 架构与约定

### 依赖分层

| 层级 | 包名 | 用途 |
|---|---|---|
| 运行期依赖 | `cheerio`, `undici`, `iconv-lite`, `yauzl`, `buffer-crc32`, `dom-serializer`, `domhandler`, `image-size` | 解析网页、解压 EPUB/TXT、编码转换、图片尺寸探测等核心能力 |
| 开发依赖 | `vitest`, `tsdown`, `typescript`, `eslint`, `jsdom`, `playwright`, `react`, `@testing-library/*` | 测试、类型检查、lint、浏览器端测试 |
| peerDependencies | `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`, `react`, `react-dom` | 由宿主（DSH）提供，避免重复打包 |

### 发布产物与入口

- `main = "lib/index.js"`，`types = "lib/types/index.d.ts"`。
- 通过 `exports` 暴露三个子路径：`.`（主模块）、`./client`（客户端 UI）、`./locale/*.json` 与 `./icon`、`./package.json` 静态资源。
- `files` 白名单仅包含 `lib/locale/icon.svg/cordis.patch.yml/README.md/LICENSE`，发布时不包含源码、测试和构建中间产物。

### DSH 兼容性矩阵

`package.json` 中 `dsh.compatibility.dshReleases` 显式列出兼容的 DSH 发行版（0.1.5-rc.1 ~ 0.2.1-rc.3），这是宿主侧约束依赖版本的正式契约，而非语义化版本区间。

### 构建注入

`dsh.bundle.patch` 指定 cordis 在打包时对宿主进行 patch；`dsh.client.inject` 注入 `@deepseek-ai/dsh-client-locale`，`platform: web` 限定运行平台。

### Lockfile 与供应链安全

- 使用 pnpm lockfile 锁定精确版本。
- `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 针对 `@deepseek-ai/dsh-*` 以及 `@deepseek-ai/cordis@4.0.5`、`@cosmokit@1.8.6`、`@schemastery@3.18.5` 放行 24h 内发布的包，注释明确说明原因：0.2.1-rc.1 的 dsh-tools 传递依赖会把这些包带到当天版本，而 lockfile 的 supply-chain 校验是兜底机制。

## 4. 约定与约束

- **依赖声明位置**：运行依赖放入 `dependencies`，宿主提供的运行时库放入 `peerDependencies`（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`、`react`、`react-dom`）。该约定由 pnpm 的 peerDependency 机制保证——若宿主未安装对应 peerDep，安装阶段会告警。
- **可选 peerDep**：`react` 与 `react-dom` 在 `peerDependenciesMeta` 中标记为 `optional: true`，使不含 React 的宿主仍可安装本包。
- **版本策略**：运行依赖使用固定版本（如 `playwright-core: 1.63.0`、`undici: 7.29.1`、`yauzl: 3.4.0`）或较窄范围（`cheerio: ^1.0.0`）；peerDep 使用范围（`^4.0.2`、`>=0.0.1-rc.5 <0.3.0-0`、`^3.18.2`、`^18.3.1`）以兼容宿主已安装的版本。
- **ESM 模块**：`type: "module"`，所有源码按 ESM 编写。
- **预发布包**：`publishConfig.access: "public"`，`@xrn1997/dsh-novel` 作为公开包发布。
- **构建前置**：`prepack` 钩子强制先执行 `npm run build`，确保发布前产物存在。
- **Supply-chain 校验**：`pnpm-workspace.yaml` 中 `minimumReleaseAgeExclude` 配合 pnpm 的 supply-chain 校验，限制新发布依赖的冷却时间；注释表明对 `@deepseek-ai/*` 包的豁免是临时性的（“满 24h 后可删”）。
- **无 vendoring**：未发现 `vendor/`、`node_modules` 提交记录以外的第三方源码拷贝；所有第三方代码通过 pnpm 安装并锁定于 `pnpm-lock.yaml`。
