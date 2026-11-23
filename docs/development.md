# 开发与验证

这份文档是贡献者的入口：构建、本地调试、门、真机验证与发版；提交信息与 PR 约定见 `CONTRIBUTING.md`。用户怎么装、怎么用、有哪些配置键与 HTTP 路由见 `README.md`；模块为什么这么切、某条语义归谁见 `docs/architecture.md`；界面规格见 `docs/ui-spec.md`；裁决见 `docs/adr/`。这里只写「怎么做」与「怎么验」。

## 构建与日常开发

```powershell
git clone <仓库地址>   # GitHub 或 GitCode 镜像均可
cd dsh-novel
pnpm install
pnpm build        # 构建 lib/（Node 半 + 浏览器半）+ lib/types/（tsc 声明）；改动源码后、重启宿主前必须执行
pnpm dev          # = tsdown --watch，日常开发建议挂着；它只出 lib/*.js，开跑即清 lib/（含 lib/types）——
                  # 要类型声明就在 dev 起来之后另跑一次 pnpm build
```

**`lib/` 是构建产物且不入库**，任何从源码目录链进 profile 的安装方式都不会替你构建它——先 `pnpm build`，否则整个插件树拒绝挂载（`plugin tree failed to load` + `ERR_MODULE_NOT_FOUND`）。

改动生效分两半：**浏览器半**（`src/client/`）由 `dsh-client-hmr`（500ms stat 轮询 + SSE）在 `lib/client.js` 的 mtime / size 变化时自动推给浏览器热更新，无需重启；**Node 半**不在热重载链路内，需重启宿主。动手前先按 `docs/architecture.md` 的「唯一主人清单」找主人，别在第二处写判据。

## 本地源码调试

```powershell
dsh plugin --profile <profile> add link:C:/path/to/dsh-novel
pnpm build        # 必须在源码目录手动跑一次，缺这步宿主起不来
```

`link:` 只建目录链接、绝不触碰对端目录，pnpm 不会在对端执行 `prepare`（本包也没有 `prepare`：git 直装不会自动构建，源码安装一律先手动 build），反复重跑也不会生成 `lib/`。缺失时的报错是 `dsh: plugin tree failed to load` + `ERR_MODULE_NOT_FOUND`，指向 `lib/index.js`。

## 门（自动）

```powershell
pnpm gates         # 一次跑完 typecheck / lint / test / test:pack / test:compat；CI 与发版工作流共用
pnpm test          # 常规集（引擎 / 服务 / API / 工具 / 入口 / 前端逻辑与 smoke / 兼容判据与桥面自证 / 文档门）
pnpm test:compat   # 兼容性回放（tests/replay/fixtures → 离线复算；报告写 tests/replay/report.md，产物不入库）
pnpm test:pack     # 先 build，再跑构建产物自检（不打包、不读 tarball）
pnpm typecheck     # tsc --noEmit —— 必须与 pnpm test 同批跑
pnpm lint          # 类型感知 ESLint：显式 any、any 扩散（no-unsafe-*）、悬浮 Promise、非空断言 + react-hooks 两条；不引格式类规则
```

`test:compat` 的 compat 指**离线 fixture 回归**（`tests/replay/`），与 legado 覆盖矩阵是两条线：前者证明规则引擎在固定样本上可复算，后者证明格式语义有归属。`test:pack` 只跑 `tests/packaging-build.test.ts` 的**构建产物自检**（`lib/` 的形状、client bundle 的模块纯度）——它不执行 `pnpm pack`、也不读 tarball；发布清单与 tarball 内容的证明在 Release workflow 的断言与 `DSH_INSTALL_CHECK`（见「真机验证」）。

### 编译器档位与 lint 归属

`tsconfig.json` 在 `strict` 之上开着 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`erasableSyntaxOnly`、`noFallthroughCasesInSwitch`、`noImplicitOverride`、`verbatimModuleSyntax`、`noUnusedLocals`、`noUnusedParameters`；判据与弃选项住 `ADR-0053`。三条纪律单列：

- **取值不折叠**：取位失败 → Miss、解析到空集合 → 空 List，不许用 `?? []` / `?? ''` 把它们折成同一种结局；服务层对合法缺省的 `??` 收口不在禁令内。测试夹具的位置取位走 `tests/support/fixture.ts` 的 `pick` / `last`，需要断言存在性的查找走 `must`。
- **`no-unnecessary-condition` 的命中分两类**：真死代码删；「本地窄镜像钉死 ≠ 运行时必有」与「TS 看不见闭包写入」的判空保留，并在注释里写清为什么。
- **新增的 `eslint-disable` 只用于确证误报，每处带理由**；`src/client` 里那批无理由的 `react-hooks/exhaustive-deps` 是存量豁免清单，不属本门覆盖面。`require-await` 在 `tests/**` 关闭。

lint 与 tsc 的分工：`tsc` 管类型形状与可赋值性，**`any` 归 ESLint**。

> **跑门取退出码，别看管道说了什么**：`pnpm test | tail` 之后退出码是管道工具的，红会被吃掉。先把输出灌进文件、再单独打印退出码，汇报里把**退出码连同计数**一起抄；**跑门与提交必须是两条命令**。

**文档门是两件套**：`tests/docs-liveness.test.ts` 扫手写文档与代码注释，钉住点名的 `src/`、`tests/`、`docs/`、`locale/` 路径真实存在、已废称呼不再出现、`§N` 与中文小节名指路活着、相对链接与锚点指得到东西、ADR 编号 / 标题 / `Status` / `锚点：` / 索引齐全、README 截图与徽章 / 实测名单投影、职责边界各只有一份、根 `AGENTS.md` 预算；`tests/context-terms.test.ts` 查 `CONTEXT.md` 点名的符号在生产代码里现查得到。路径若有意保留历史名走 `ALLOWED` 白名单，加一条要写清为什么；死名没有豁免。

**CI 的分工**：GitHub Actions（`.github/workflows/ci.yml`）在 push / PR 上跑 `pnpm gates`；发版由 `.github/workflows/release.yml` 承接，tag push 与手动干跑的分工见「发版流程」第 4 步。真链路门（下面的 `DSH_*` 系列）不进 CI：它们需要真实站点、真浏览器、本机宿主或本机数据，仍按本机命令手动跑。

### 真链路门控（默认跳过、需显式打开）

`pnpm test` 全绿**不覆盖**它们；常规集证明引擎 / 服务 / 契约 / 前端逻辑，**不证明任何真实站点可用性、也不证明安装链路**：

```powershell
# 真机全量重探：改动抓取 / 规则引擎后实测书源**搜索面**可用率（真实联网，耗时数分钟）
# 注意 verified 只证搜索面，不证正文可读
$env:DSH_REPROBE='1'; pnpm vitest run tests/reprobe.test.ts

# 正文链路全量审计：搜索→目录→正文逐段实测 + 失败分桶（正文可用率以本审计为准）
# 它是**报告**：分桶读数靠人判，代码不设通过率断言
# 改动正则求值面必跑：死线对「大而合法」页面的误伤只在真页面上显形，离线门全绿证不了它
# 旋钮（都可省）：关键词表 / 并发 / 每本抽哪几章 / 只审某些源
$env:DSH_AUDIT_KEYWORDS='小说,完本,的'; $env:DSH_AUDIT_WORKERS='5'
$env:DSH_AUDIT_CHAPTERS='0,2,5,mid'; $env:DSH_AUDIT_ONLY='源名子串1,源名子串2'
$env:DSH_CONTENT_AUDIT='1'; pnpm vitest run tests/content-audit.test.ts

# 搜索相关性分档 + 按书归并真机审计：kept/suspect 分桶、按书本数与家数分布、三组待判样例
# 它是**报告**：不设通过率断言，唯一断言是判据自洽（分档不丢条）
$env:DSH_SEARCH_AUDIT_KEYWORD='冰魔女的契约'   # 旋钮（可省）：审计关键词
$env:DSH_SEARCH_FILTER_AUDIT='1'; pnpm vitest run tests/search-relevance-audit.test.ts

# 真采集：把真实站点抓成 compat fixture（联网；关键词须与回放同批，缺省「书」）
$env:COMPAT_CAPTURE='1'; $env:COMPAT_KEYWORD='书'
pnpm vitest run --config vitest.compat.config.ts tests/replay/capture.test.ts
# 采完离线复算：pnpm test:compat —— 落盘的必须是脱敏后的产物
# 脱敏规则演进后重洗已入库 fixture（原地重写、幂等）：
$env:COMPAT_RESANITIZE='1'; pnpm vitest run --config vitest.compat.config.ts tests/replay/resanitize.test.ts

# 真安装链路：dsh plugin add → profile bundles 挂载 + lib/client.js / cordis.patch.yml 就位
# 两格：源码目录（pnpm 的 link 语义）/ `pnpm pack` 的 tarball（GitHub Release 资产形态）
$env:DSH_INSTALL_CHECK='1'; pnpm vitest run tests/packaging-install.test.ts

# 真浏览器 WebView 门（离线，需本机装 Edge 或 Chrome）：webView 渲染与 webJs 页面内执行
# 默认集合里该用例是 skip；矩阵 b-opt-webview 的实现证据就是这一枚
$env:DSH_WEBVIEW='1'; pnpm vitest run tests/services/webview.test.ts

# 真浏览器门（离线，开关名 DSH_BROWSER_GATE；旧名 DSH_EPUB_BROWSER 仍认）：
#   EPUB 图文阅读的真图片解码 / 真排版位置 / 真下载字节
# 本地随机端口起真服务、驱动构建产物 lib/client.js，只用**已安装的** Edge/Chrome，从不下载
# 指定浏览器可执行文件（可选）：$env:DSH_BROWSER_EXECUTABLE='C:\path\to\chrome.exe'
$env:DSH_BROWSER_GATE='1'; pnpm vitest run tests/browser/epub-reader.test.ts
# 同一枚闸下的几何门（不起服务、不读站点），按文件跑：
#   city-sheet-layout / config-page-layout / tts-layout / tts-engine-edit-layout /
#   shelf-nowplaying-layout / source-list-layout（都在 tests/browser/ 下）
# 读数与断言住对应测试文件；jsdom 量不到排版，所以几何必须进真浏览器。
$env:DSH_BROWSER_GATE='1'; pnpm vitest run tests/browser/<文件>.test.tsx

# EPUB 真语料审计（离线，读本机目录）：逐本 importEpub → 按结局与痕码分桶
# 语料目录 = $env:DSH_EPUB_CORPUS_DIR（缺省 `$DSH_HOME/novel/corpus/`）；**语料不入库**
$env:DSH_EPUB_CORPUS='1'; pnpm vitest run tests/services/epub-corpus-audit.test.ts

# 听书真链路审计（先 `pnpm build`；联网）：把构建产物接成 `/novel-api`，走一遍合成 → 音频读口
# 脚本强制直连（`proxyUrl: 'direct'`，输出 `PROXY: direct (forced)`）：代理环境视为未覆盖
# 退出码 0 可用 / 1 不可用 / 2 未测或没跑成；订阅引擎需数据根里有 tts-engines.json
node scripts/tts-live.mjs [--engine http:<id> --data-dir <dataDir>]
```

- **`scripts/tts-live.mjs` 只验服务端合成链**：证明「取文本 → 上游合成 → 音频读口」在真实网络下可用；浏览器直出没有字节可审计，遇到它如实报「未测」。`--help` 打印用法后以 0 正常退出，但那不是审计结果——0 只在这三格都成立时才是「可用」：合成回执成功信封、回执带播放补速（`playbackRate`，`ADR-0081`）、音频读口给回非空 `audio/*` 字节。它强制直连：代理环境视为**未覆盖**。
- **采集三条实践口径**：出站与生产同口径（`resolveProxyUrl`：config > 环境变量 > 系统代理 > 直连）；manifest 的键是**请求 URL**而非重定向后的落地地址；站点会抖，**别删已采好的 fixture**。落盘的是生产解码链读到的文本（`decodeBody`）。
- **脱敏是门禁**：`tests/replay/sanitize.ts` 在写盘前扫 cookie / token / password / authorization / apiKey；自动脱敏是兜底不是证明，入库前仍要人工过目。
- **`DSH_BROWSER_GATE` 允许带按应有口径写的「诚实红」**：已知缺陷的读数不削成绿，缺陷与读数登记在该测试文件自己的注释里；修好时按那条记录一起撤下。这门同时量配置页 / 浮层 / 听书面几何，名字按「真浏览器门」取。
- **`DSH_EPUB_CORPUS` 是审计报告，不是通过率门**：唯一断言是审计自洽（每本都得出结局、被拒的每本都带得出原因骨架）；通过率与分桶靠人判。语料的合法来路：公版书、外部反馈者裁到最小的样本（只落本机、不入库）、转换工具自转的同族写法；要把真实形状钉进默认门，提炼进 `tests/fixtures/epub.ts` 的合成表。

**解析面普查（离线，读本地书源库）**——「legado 能解析的书源本插件也能解析」这条目标的进度读数口：把现库**每一条规则串**过 `parseRule`、把**每一个脚本里的 `java.*` 调用**与沙箱实际挂载面对账，输出「本仓拒绝的语法族」「脚本在调而桥没挂的方法」两张清单，并断言**未在册的新形态 = 0**；同时印一张**需求读数表**。

```powershell
$env:DSH_PARSE_CENSUS='1'; pnpm vitest run tests/engine/parse-census.test.ts
```

数不一致只打印漂移、不判红；判红的是**绑定落空**与**零读数空转**。**分母要定期换**：把另一批独立公开合集灌进同一个门（`DSH_PARSE_CENSUS_FILE` 指过去即可）。

### 兼容判据与桥面自证

（随 `pnpm test` 默认跑，运行时不需要任何外部 checkout）

| 门 | 判什么 |
| --- | --- |
| `status-evidence.test.ts` | 逐行验证据可回查：`implemented` 的实现符号在剥注释后的代码里、钉子用例在测试里；`not-applicable` 必须写明裁决理由；`open` 必须带 `2026-MM-DD` 复核戳；行 id 唯一 |
| `bridge-surface.test.ts` | 名册点名的缺席项真的不在沙箱挂载面；名册指向的矩阵行在册；协议表的真实现没被沙箱桩覆盖 |

格式字段与宿主方法的覆盖走现量口径：读数由解析面普查报告，不进默认门（`ADR-0099`）。

## 真机验证（硬约束，别跳）

`DSH_INSTALL_CHECK` 证明**两种装入**（一次性 profile、断言 bundles 与产物就位，跑完自己 `remove`）：源码目录（`link:`）与 `pnpm pack` 的 tarball。它不起宿主，所以不证明插件树真能被挂载、也不证明六个工具在宿主里跑得通。那两件事只能手工做：

1. **前置**：先 `pnpm build`。宿主 profile 必须**可由 CLI 写**——保留名 `desktop` 归宿主应用独占；写不了就改用 CLI 自建的一次性 profile。
2. **装载与挂载**：`dsh plugin --profile <名> add link:<本仓目录>`（本包没有 `prepare`：`github:` 直装不会自动构建、缺 `lib/` 会被宿主拒挂）→ `dsh --profile <名> --dump-config` 的组合树里出现本插件 → 起 `dsh --profile <名>`，看组合树里没有 `plugin tree failed to load`。Release 资产那一格（`add <tarball>`）由同一道门的第二格量。
3. **工具面与一条真路径**：六个 `dshnovel_` 工具各真调一次；再走一条真实业务：搜 → 详情 → 目录 → 正文并翻一页（顺带覆盖出站代理与解码链）。
4. **听书面**：在同一台真宿主上听一次——阅读器顶条起播 → 暂停 / 继续 / 跳段 / 拖章内滑杆 → 改语速与定时 → 离开阅读器后浮窗仍在并续听 → 重开这本书按共用进度续上。宿主装了语音合成服务插件时引擎清单应多出它那一行；没装就不列。
5. **桌面版的浮窗可达区**（`ADR-0100`，只有桌面壳在场才有这一格）：把浮窗往宿主窗控带那条里拖、松手，再看展开态与设置弹层——整块要停在带的下沿之下、拖面任何时候都抓得到。门的读数由用例自己种属性，那条带真不真按这份读数出现，只有桌面壳里看得见。

**它证明什么**：当前宿主版本上「装得进、挂得上、工具面活着、业务链路走得通一次」。**它不证明**：站点正文可读率、浏览器里的渲染与图片解码、听书一定出得了声，也不证明其它宿主版本——每次 bump 编译所依都要重跑上面这几步，并如实更新 `package.json` 的实测名单与 README 投影。

## 发版流程

1. **一条门**：`pnpm gates`，退出码看过。发版与 CI 跑的是同一条门；别在这里改挑子集。
2. **写发布记录**：在 `CHANGELOG.md` 追加这一版（新增 / 变更 / 修复 / 升级注意）；未发布改动不预写，历史版本不回溯改写。
3. **版本前移**：`package.json` 的 `version` 提一笔 `chore: 发版 x.y.z`；提交并 push。
4. **GitHub Release 资产（自动）**：给第 3 步的提交打 annotated tag `Vx.y.z` 并 push，触发 `.github/workflows/release.yml`——先校验 tag = `V` + `package.json` 版本，再跑 `pnpm gates` → `pnpm pack` → 断言 tarball 里的挂载产物齐全 → 挂到 Release。每个 Release 两份资产：版本名 `xrn1997-dsh-novel-<版本>.tgz` 与稳定别名 `dsh-novel.tgz`；tag 带 `-` 的按 prerelease 处理，不抢 `latest`。`workflow_dispatch` 只干跑。**tag 排在 npm 之前**：不可逆的一步放最后。
5. **`npm publish`**：`prepack` 会跑 `build`；`files` 是**精确清单**——构建每新多出一个要发布的产物，就要同时加进 `files`。
6. **README 徽章与实测名单**：徽章读 npm `latest` 清单，发版后现查；实测名单按当次真机代次更新。

npm 与 GitHub Release 是两条渠道，靠同一个 tag 对齐；发版后核对两边都在位。

### 宿主兼容与实测名单

安装许可由 `package.json` 的 `peerDependencies` 决定，实测记录写在 `dsh.compatibility.dshReleases`，只列真跑过的宿主版本（两层的关系见 `README.md` 与 `ADR-0020`）。两层由 `tests/packaging.test.ts` 同时看住：编译期 devDependency 必须被 peer 区间放行，且必须出现在实测声明里。

宿主发新版分两种：**线内**（当前 peer 区间内的 rc / patch）不要求本插件跟版；要声称实测兼容时，升级编译所依、重读新宿主的浏览器模块表（`staticModules()`）并对齐 `PLATFORM_MODULES`、真机确认后加实测条目。**跨线**必须先真机验，再把 peer 上界开到下一条线。平台模块表只剩 `react` 两条：客户端页面/面板不得 import 任何宿主 client 包（`ADR-0067`）。

宿主依赖包的**发布冷却闸**（pnpm 的 `minimumReleaseAge`）对 `@deepseek-ai/dsh-*` 整 scope 放行，写死在 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`（`ADR-0026`）。

## 已知的环境坑

- **Windows 沙箱下 node 的子进程 spawn 一律 EPERM**：vitest 起 esbuild 服务会撞上——换个不受限的执行环境即可。
- **npm cache EPERM**：`npm view` 偶尔撞 `AppData\Local\npm-cache` 临时文件锁，重试或换查询方式。
- **GitHub git 端口不可达**：`github.com:443` 超时但 `api.github.com` 通时，可临时走 `git push ssh://git@ssh.github.com:443/xrn1997/dsh-novel.git <tag>`。
- **`lib/` 是构建产物且不入库**：先 `pnpm build`，否则整个插件树拒绝挂载（见「构建与日常开发」）。
- **改动生效分两半**：浏览器半由宿主 HMR 热推，Node 半必须重启宿主（见「构建与日常开发」）。
- **出站代理**：DSH 的 Node 进程走 undici，**不读系统代理**；只有代理能到的站点必须在插件里配 `proxyUrl`，否则表现为「浏览器能开、插件打不开」。
- **运行时数据不在仓库**：书源 / 书架 / 缓存 / 本地书住 `$DSH_HOME/novel/`（缺省 `~/.dsh/novel/`；`dataDir` 可改）。
- **`tests/replay/report.md` 是跑门产物**：`pnpm test:compat` 每次覆盖写，已 gitignore；分母是 fixture，**不是站点可用率**。
- **冒烟启动宿主时日志里那行带 token 的 URL 是活的凭据**：别留在日志或会话输出里，测完删文件。
- **缺前端测试依赖会假红**：`jsdom` / `@testing-library/react` 没装全时前端测试报 `Cannot find module`；先 `pnpm install`。
- **`.qoder/repowiki` 是生成的知识库快照**：整棵只在本机、不进版本控制，不是事实源（`docs/AGENTS.md`）。
