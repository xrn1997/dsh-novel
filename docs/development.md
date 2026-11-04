# 开发与验证

这份文档是贡献者的入口：构建、本地调试、门、真机验证与发版；提交信息与 PR 约定见 `CONTRIBUTING.md`。用户怎么装、怎么用、有哪些配置键与 HTTP 路由，见 `README.md`；模块为什么这么切、某条语义归谁，见 `docs/architecture.md`；界面规格见 `docs/ui-spec.md`；裁决见 `docs/adr/`。这里只写「怎么做」与「怎么验」。

## 构建与日常开发

```powershell
git clone <仓库地址>   # GitHub 或 GitCode 镜像均可
cd dsh-novel
pnpm install
pnpm build        # 构建 lib/（Node 半 + 浏览器半）+ lib/types/（tsc 声明）；改动源码后、重启宿主前必须执行
pnpm dev          # = tsdown --watch，日常开发建议挂着；它只出 lib/*.js，且开跑即清 lib/——
                  # 要 lib/types/（声明）就在它之后或之前补一次 pnpm build
```

**`lib/` 是构建产物且不入库**，任何从源码目录链进 profile 的安装方式都不会替你构建它——先 `pnpm build`，否则整个插件树拒绝挂载（`plugin tree failed to load` + `ERR_MODULE_NOT_FOUND`）。

改动生效分两半：**浏览器半**（`src/client/`）由 `dsh-client-hmr`（500ms stat 轮询 + SSE）在 `lib/client.js` 的 mtime / size 变化时自动推给浏览器热更新，无需重启；**Node 半**不在热重载链路内，需重启宿主。

模块形状与语义归属见 `docs/architecture.md`；动手前先按那里的「唯一主人清单」找主人，别在第二处写判据。

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
pnpm test:pack     # 构建 + 产物自检
pnpm typecheck     # tsc --noEmit —— 必须与 pnpm test 同批跑
pnpm lint          # 类型感知 ESLint：显式 any、any 扩散（no-unsafe-*）、悬浮 Promise、非空断言 + react-hooks 两条；不引格式类规则
```

`test:compat` 里的 compat 指**离线 fixture 回归**（`tests/replay/`），与 legado 覆盖矩阵是两条线：前者证明规则引擎在固定样本上可复算，后者证明格式语义有归属。

### 编译器档位与 lint 归属

`tsconfig.json` 在 `strict` 之上开着 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`erasableSyntaxOnly`、`noFallthroughCasesInSwitch`、`noImplicitOverride`；判据与弃选项住 `ADR-0053`。三条纪律单列：

- **取值不折叠**：引擎取值链的空态不折叠——取位失败 → Miss、解析到空集合 → 空 List，两者是两种值，不许用 `?? []` / `?? ''` 之类的缺省把它们折成同一种结局（取值规约见 `CONTEXT.md`）；服务层对合法缺省的 `??` 收口不在禁令内。测试夹具的位置取位走 `tests/support/fixture.ts` 的 `pick` / `last`，需要断言存在性的查找走 `must`，越界即抛「夹具缺第几项、共几项」，不改成 `?.`。
- **`no-unnecessary-condition` 的命中分两类**：真死代码删；「本地窄镜像钉死 ≠ 运行时必有」与「TS 看不见闭包写入」的判空**保留**，并在注释里写清为什么（注释只写为什么，不抄表达式）。
- **新增的 `eslint-disable` 只用于确证误报，每处带理由**；`src/client` 里那批无理由的 `react-hooks/exhaustive-deps` 是存量豁免清单（见 `AGENTS.md`），不属本门覆盖面。`require-await` 在 `tests/**` 关闭——替身的 `async` 就是为回一个 Promise。

lint 与 tsc 的分工：`tsc` 管类型形状与可赋值性，**`any` 归 ESLint**——`tsc` 从不拒绝显式 `any`，把这条记到 tsc 头上等于没有门。

> **跑门取退出码，别看管道说了什么**：`pnpm test | tail` 之后退出码是管道工具的，红会被吃掉。先把输出灌进文件、再单独打印退出码，汇报里把**退出码连同计数**一起抄；**跑门与提交必须是两条命令**。

**文档门是三件套**：`tests/docs-liveness.test.ts` 扫 `AGENTS.md` / `CONTEXT.md` / `README.md` / `CONTRIBUTING.md` / `CHANGELOG.md`、`docs/**` 与 `src/**`、`tests/**` 的正文与注释，钉住点名的 `src/`、`tests/`、`docs/`、`locale/` 路径真实存在、已废的文档称呼不再出现、`§N` 与中文小节名指路活着、相对链接与锚点指得到东西、ADR 编号连续且标题 / `Status` / `锚点：` 齐全、索引双向完整且没有重复行、README 截图三方一致、README 的窗口 / 真机名单 / 徽章从 `package.json` 投影、主人清单 / 界面规格 / 文档标准各只有一份、根 `AGENTS.md` 预算；`tests/context-terms.test.ts` 查 `CONTEXT.md` 点名的符号在生产代码里现查得到；`tests/comment-altitude.test.ts` 查注释不抄代码表达式。路径若有意保留历史名走 `ALLOWED` 白名单，加一条要写清为什么；死名没有豁免。文档门自己从语料里排除：它的正文必须引用已废称呼，扫自己必然自红；这是唯一的自排除。

**CI 的分工**：GitHub Actions（`.github/workflows/ci.yml`）在 push / PR 上跑 `pnpm gates`（清单住 `package.json`；pnpm 版本住 `packageManager`，Node 版本在两条工作流里各写一次）。发版由 `.github/workflows/release.yml` 承接，tag push 与手动干跑的分工见「发版流程」第 5 步。真链路门（下面的 `DSH_*` 系列）不进 CI：它们需要真实站点、真浏览器或本机宿主，仍按本机命令手动跑；CI 绿不代表站点可用性或安装链路通过——发版工作流的绿只证明门与资产上传成功，装不装得进由 `DSH_INSTALL_CHECK` 量。

### 真链路门控（默认跳过、需显式打开）

`pnpm test` 全绿**不覆盖**它们；常规集证明引擎 / 服务 / 契约 / 前端逻辑，**不证明任何真实站点可用性、也不证明安装链路**：

```powershell
# 真机全量重探：改动抓取 / 规则引擎后实测书源**搜索面**可用率（真实联网，耗时数分钟）
# 注意 verified 只证搜索面，不证正文可读
$env:DSH_REPROBE='1'; pnpm vitest run tests/reprobe.test.ts

# 正文链路全量审计：搜索→目录→正文逐段实测 + 失败分桶（正文可用率以本审计为准）
# 它是**报告**：分桶读数靠人判，代码不设通过率断言，只断言每个注册源都进了审计
# 改动正则求值面（`engine/regex-guard.ts` 的死线、AllInOne / `##` / CSS 属性过滤 / `bookUrlPattern` 嗅探的口径）必跑这一条：
# 死线对「大而合法」页面的误伤只在真页面上显形，离线门全绿证不了它
$env:DSH_CONTENT_AUDIT='1'; pnpm vitest run tests/content-audit.test.ts
$env:DSH_AUDIT_KEYWORDS='小说,完本,的'   # 旋钮（都可省）：关键词表 / 并发 / 每本抽哪几章 / 只审某些源
$env:DSH_AUDIT_WORKERS='5'
$env:DSH_AUDIT_CHAPTERS='0,2,5,mid'
$env:DSH_AUDIT_ONLY='源名子串1,源名子串2'

# 搜索相关性分档 + 按书归并真机审计：全量源聚合搜索 → kept/suspect 分桶读数、按书本数与家数分布、三组待判样例（联网，分钟量级）
# 它是**报告**：不设通过率断言（分母随源增删与站点脸色漂），唯一断言是判据自洽（分档不丢条）；读数供裁「去虚字放行」偏离与那把归并键的焊错面
$env:DSH_SEARCH_FILTER_AUDIT='1'; pnpm vitest run tests/search-relevance-audit.test.ts
$env:DSH_SEARCH_AUDIT_KEYWORD='冰魔女的契约'   # 旋钮（可省）：审计关键词

# 真采集：把真实站点抓成 compat fixture（联网；关键词须与回放同批，缺省「书」）
$env:COMPAT_CAPTURE='1'; $env:COMPAT_KEYWORD='书'
pnpm vitest run --config vitest.compat.config.ts tests/replay/capture.test.ts
# 采完离线复算：pnpm test:compat —— 落盘的必须是脱敏后的产物（见下）

# 真安装链路：dsh plugin add → profile bundles 挂载 + lib/client.js / cordis.patch.yml 就位
# 两格：源码目录（pnpm 的 link 语义）/ `pnpm pack` 的 tarball（GitHub Release 资产形态）
$env:DSH_INSTALL_CHECK='1'; pnpm vitest run tests/packaging-install.test.ts

# 真浏览器 WebView 门（离线，需本机装 Edge 或 Chrome）：webView 渲染与 webJs 页面内执行
# 默认集合里该用例是 skip；矩阵 b-opt-webview 的实现证据就是这一枚（不开闸只证明夹具）
$env:DSH_WEBVIEW='1'; pnpm vitest run tests/services/webview.test.ts

# 真浏览器门（离线）：EPUB 图文阅读的真图片解码 / 真排版位置 / 真下载字节
# 本地随机端口起真服务、驱动构建产物 lib/client.js，只用**已安装的** Edge/Chrome，从不下载
$env:DSH_EPUB_BROWSER='1'; pnpm vitest run tests/browser/epub-reader.test.ts
# 同一枚闸下的几何门：不起服务、不读站点——把浮层的真 DOM 灌进浏览器量 rect（jsdom 量不到排版）
$env:DSH_EPUB_BROWSER='1'; pnpm vitest run tests/browser/city-sheet-layout.test.tsx
# 插件页「运行参数」的行几何：量单位后缀是否真在框内、数字框是否被限宽、窄档折不折得干净
$env:DSH_EPUB_BROWSER='1'; pnpm vitest run tests/browser/config-page-layout.test.tsx
```

- **采集三条实践口径**：出站与生产同口径（走 `resolveProxyUrl`：config > 环境变量 > 系统代理 > 直连，缺这条会把反爬壳页采成「正文为空」）；manifest 的键是**请求 URL**而非重定向后的落地地址（搜索类源常「POST 出去、302 落到结果页」）；站点会抖，**别删已采好的 fixture**，重采会覆盖、删除只会让你重新赌一次站点脸色。落盘的是生产解码链读到的文本（`decodeBody`：声明 charset → content-type → `<meta>` 嗅探），GBK 页才存成真中文。
- **脱敏是门禁**：`tests/replay/sanitize.ts` 在写盘前扫 cookie / token / password / authorization / apiKey 与 `Authorization: Bearer …` 形态（判据住该文件头注），`tests/replay/sanitize.test.ts` 钉住它。自动脱敏**是兜底不是证明**，入库前仍要人工过目。
- **`DSH_EPUB_BROWSER` 允许带按应有口径写的「诚实红」**：已知缺陷的读数不削成绿，缺陷与读数登记在该测试文件自己的注释里；修好时按那条记录一起撤下。

**解析面普查（离线，读本地书源库）**——「legado 能解析的书源本插件也能解析」这条目标的进度读数口：把现库**每一条规则串**过 `parseRule`、把**每一个脚本里的 `java.*` 调用**与沙箱实际挂载面对账，输出「本仓拒绝的语法族」「脚本在调而桥没挂的方法」两张清单，并断言**未在册的新形态 = 0**；同时印一张**需求读数表**（登记册那些「N 源带值」的读数，矩阵行 `demand` 绑定的键由这一条命令重算，判据印在数字旁边——同一个键常有两种数法）。

```powershell
$env:DSH_PARSE_CENSUS='1'; pnpm vitest run tests/engine/parse-census.test.ts
```

数不一致只打印漂移、不判红（分母随用户增删漂）；判红的是**绑定落空**（读数绑的键再也算不出来）与**零读数空转**（当下数出 0 的判据必须在合成样品上数得出非 0，否则分不清「真没人用」与「判据接不上任何东西」）。**分母要定期换**：只跑本机库，一条从未出现过的写法就永远不会露出来——把另一批独立公开合集灌进同一个门（`DSH_PARSE_CENSUS_FILE` 指过去即可，取法见 `tests/engine/parse-census.test.ts` 头注）。

### 兼容判据与桥面自证

（随 `pnpm test` 默认跑，运行时不需要任何外部 checkout）

| 门 | 判什么 |
| --- | --- |
| `status-evidence.test.ts` | 逐行验证据可回查：`implemented` 的实现符号在剥注释后的代码里、钉子用例在测试里；`not-applicable` 必须写明裁决理由；`open` 必须带 `2026-MM-DD` 复核戳；行 id 唯一；一行一条记录 |
| `inventory-coverage.test.ts` | 每个能力单元各挂 ≥2 条真实矩阵行（分母是矩阵本身） |
| `bridge-surface.test.ts` | 名册点名的缺席项真的不在沙箱挂载面；名册指向的矩阵行在册；协议表的真实现没被沙箱桩覆盖（只问本仓沙箱，不读书源） |
| `demand-keys.test.ts` | 矩阵行上的需求读数键都在面 D 的表里、每条带日期锚；记为 0 的读数在反空转样品上数得出 |

格式字段与宿主方法的覆盖走现量口径：读数由上面的解析面普查（`DSH_PARSE_CENSUS`）报告，不进默认门（`ADR-0054`）。默认门自证矩阵证据、能力单元归属、桥面名册与需求读数绑定。

## 真机验证（硬约束，别跳）

`DSH_INSTALL_CHECK` 证明**两种装入**（一次性 profile、断言 bundles 与产物就位，跑完自己 `remove`）：源码目录（`link:`）与 `pnpm pack` 的 tarball（GitHub Release 资产形态）。它不起宿主，所以不证明插件树真能被挂载、也不证明六个工具在宿主里跑得通。那两件事只能手工做：

1. **前置**：先 `pnpm build`。宿主 profile 必须**可由 CLI 写**——保留名 `desktop` 归宿主应用独占，普通 CLI 会拒写该保留名；写不了就改用 CLI 自建的一次性 profile（`dsh plugin --profile <名> add <本地路径>` 初始化它，再把 `@deepseek-ai/dsh-web-app` 加进 `dsh.profile.bundles`），它组出同一棵树。
2. **装载与挂载**：`dsh plugin --profile <名> add link:<本仓目录>`（本包没有 `prepare`：`github:` 直装不会自动构建、缺 `lib/` 会被宿主拒挂——冒烟对象是上一步构建出的本仓产物，源码装一律先构建再 link，见「构建与日常开发」）→ `dsh --profile <名> --dump-config` 的组合树里出现本插件 → 起 `dsh --profile <名>`，看组合树里没有 `plugin tree failed to load`。Release 资产那一格（`add <tarball>`）由同一道门的第二格量；真实 Release 下载地址的安装同样要手工过第 2–3 步。
3. **工具面与一条真路径**：六个 `dshnovel_` 工具各真调一次；再走一条真实业务：搜 → 详情 → 目录 → 正文并翻一页（顺带覆盖出站代理与解码链）。

**它证明什么**：当前宿主版本上「装得进、挂得上、工具面活着、业务链路走得通一次」。**它不证明**：任何站点的正文可读率（那是 `DSH_CONTENT_AUDIT` 的分桶报告，报告不等于通过率）、浏览器里的渲染与图片解码（那是 `DSH_EPUB_BROWSER`），也不证明其它宿主版本——每次 bump 编译所依（把新宿主加进实测名单）都要重跑这三步，并如实更新 `package.json` 的实测名单与 README 投影。

## 发版流程

1. **一条门**：`pnpm gates`（typecheck / lint / test / test:pack / test:compat，组成住 `package.json`），退出码看过。发版与 CI 跑的是同一条门；别在这里改挑子集，那会让发版门比检查门更宽。
2. **写发布记录**：在 `CHANGELOG.md` 追加这一版（新增 / 变更 / 修复 / 升级注意）；未发布改动不预写，历史版本不回溯改写（已废称呼与不可回查的批次号按文档门清理），逐提交明细留 git。
3. **版本前移**：`package.json` 的 `version` 提一笔 `chore: 发版 x.y.z`；提交并 push。
4. **`npm publish`**：`prepack` 会跑 `build`；`files` 是**精确清单**——构建每新多出一个要发布的产物，就要同时加进 `files`。先发 npm 再推 tag：npm 失败时不会留下一个只有 GitHub 侧到位的版本。
5. **GitHub Release 资产（自动）**：给第 3 步的提交打 annotated tag `Vx.y.z` 并 push，触发 `.github/workflows/release.yml`——先校验 tag = `V` + `package.json` 版本，再跑 `pnpm gates` → `pnpm pack` → 断言 tarball 里的挂载产物齐全（清单住 workflow）→ 挂到 Release。每个 Release 两份资产：版本名 `xrn1997-dsh-novel-<版本>.tgz` 与稳定别名 `dsh-novel.tgz`；tag 带 `-` 的按 prerelease 处理（新建时直接标，已存在时补标），不抢 `latest`；Release 已存在时资产覆盖。`workflow_dispatch` 只干跑：跑门 + 打包 + 传 workflow artifact，不建 Release。
6. **README 徽章与实测名单**：徽章读 npm `latest` 清单，工作树改了不会变——发版后现查 npm `latest`，别把某次读数写死；实测名单按当次真机代次更新。

npm 与 GitHub Release 是两条渠道，靠同一个 tag 对齐；发版后核对两边都在位。

### 宿主兼容与实测名单

安装许可由 `package.json` 的 `peerDependencies` 决定，实测记录写在 `dsh.compatibility.dshReleases`，只列真跑过的宿主版本（两层的关系见 `README.md` 与 `ADR-0020`）。两层由 `tests/packaging.test.ts` 同时看住：编译期 devDependency 必须被 peer 区间放行，且必须出现在实测声明里。

宿主发新版分两种：**线内**（当前 peer 区间内的 rc / patch，上下界现查 `package.json`）不要求本插件跟版；要声称实测兼容时，升级编译所依、重读新宿主的浏览器模块表（宿主前端的 `staticModules()`）并对齐 `PLATFORM_MODULES`、真机确认后加实测条目。**跨线**（跨过一条线）必须先真机验，再把 peer 上界开到下一条线。编译所依被 peer 放行且出现在实测声明里由 `tests/packaging.test.ts` 钉住；模块表与实测条目靠真机与人工核对。

宿主依赖包的**发布冷却闸**（pnpm 的 `minimumReleaseAge`：刚发布的版本暂不许进 lockfile）对 `@deepseek-ai/dsh-*` 整 scope 放行，写死在 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`——所以 bump 宿主不必再动一份逐代手写的放行名单（理由与被否决的做法见 `ADR-0026`）。

## 已知的环境坑

- **Windows 沙箱下 node 的子进程 spawn 一律 EPERM**：vitest 起 esbuild 服务会撞上——那不是本仓代码的问题，换个不受限的执行环境即可。
- **npm cache EPERM**：`npm view` 偶尔撞 `AppData\Local\npm-cache` 临时文件锁，重试或换查询方式。
- **GitHub git 端口不可达**：`github.com:443` 超时但 `api.github.com` 通时，`git push` 推不了 tag；可临时走 `git push ssh://git@ssh.github.com:443/xrn1997/dsh-novel.git <tag>`。Release 资产下载同样要能到 `github.com`。
- **`lib/` 是构建产物且不入库**：先 `pnpm build`，否则整个插件树拒绝挂载（`plugin tree failed to load` + `ERR_MODULE_NOT_FOUND`）。
- **改动生效分两半**：浏览器半由宿主 HMR 热推，Node 半必须重启宿主。
- **出站代理**：DSH 的 Node 进程走 undici，**不读系统代理**；只有代理能到的站点必须在插件里配 `proxyUrl`，否则表现为「浏览器能开、插件打不开」。
- **运行时数据不在仓库**：书源 / 书架 / 缓存 / 本地书住 `$DSH_HOME/novel/`（缺省 `~/.dsh/novel/`；`dataDir` 可改）。
- **`tests/replay/report.md` 是跑门产物**：`pnpm test:compat` 每次覆盖写，已 gitignore；它的分母是 `tests/replay/fixtures/` 下的 fixture，**不是站点可用率**。
- **冒烟启动宿主时日志里那行带 token 的 URL 是活的凭据**：别留在日志或会话输出里，测完删文件。
- **`.qoder/repowiki` 是生成的知识库快照**：基线 commit 只记在 `.qoder/repowiki/knowledge/zh/_index.yaml` 里（要对照就现查那份，篇数与 hash 都不在这里抄——抄一次就多一个会腐烂的镜像）。仓内**没有**再生成它的路径（只能在 Qoder 里重跑），所以它永远可能落后于代码；它不是事实源，判断口径见 `docs/AGENTS.md`。
