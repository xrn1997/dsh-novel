# 开发与验证

这份文档是贡献者的入口：构建、本地调试、宿主兼容与发版、全部测试门控与真宿主冒烟。用户怎么装、怎么用、有哪些配置键与 HTTP 路由，见 `README.md`；模块为什么这么切、某条语义归谁，见 `docs/architecture.md`；决策与被否决的方案见 `docs/adr/`。这里只写「怎么做」与「怎么验」。

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

## 宿主兼容与发版

安装许可由 `package.json` 的 `peerDependencies` 决定——宿主 `dsh plugin add` 会拿运行中的宿主版本逐个比对插件的 `@deepseek-ai/dsh*` peer 区间，不满足即 `installation rejected`。实测记录写在 `dsh.compatibility.dshReleases`，只列真跑过的宿主版本。两层由 `tests/packaging.test.ts` 同时看住：编译期 devDependency 必须被 peer 区间放行，且必须出现在实测声明里。

宿主发新版分两种：**线内**（当前 `>=0.0.1-rc.5 <0.3.0-0` 的 rc / patch）不要求本插件跟版；要声称实测兼容时，升级编译所依、重读新宿主的浏览器模块表（宿主前端的 `staticModules()`）并对齐 `PLATFORM_MODULES`、真机确认后加实测条目。**跨线**（如 `0.3.0`）必须先真机验，再把 peer 上界开到下一条线。编译所依被 peer 放行且出现在实测声明里由 `tests/packaging.test.ts` 钉住；模块表与实测条目靠真机与人工核对。

宿主依赖包的**发布冷却闸**（pnpm 的 `minimumReleaseAge`，24 小时内发布的版本不许进 lockfile）对 `@deepseek-ai/dsh-*` 整 scope 放行，写死在 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`——所以 bump 宿主不必再动一份逐代手写的放行名单（理由与被否决的做法见 `docs/adr/0026`）。

## 测试与真链路门控

```powershell
pnpm test          # 常规集（引擎 / 服务 / API / 工具 / 入口 / 前端逻辑与 smoke / 兼容判据四门）
pnpm test:compat   # 兼容性回放（compat/fixtures → 离线复算；报告写 compat/report.md，产物不入库）
pnpm test:pack     # 构建 + 产物自检
pnpm typecheck     # tsc --noEmit —— 必须与 pnpm test 同批跑
pnpm lint          # react-hooks 一条规则集（未豁免的界面依赖数组；存量 eslint-disable 另计）；只此一集，不引格式类规则
```

> **跑门取退出码，别看管道说了什么**：`pnpm test | tail` 之后退出码是管道工具的，红会被吃掉。先把输出灌进文件、再单独打印退出码，汇报里把**退出码连同计数**一起抄；**跑门与提交必须是两条命令**。

**CI 的分工**：GitHub Actions（`.github/workflows/ci.yml`）在 push / PR 上跑离线门——`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm test:pack`、`pnpm test:compat`。真链路门（下面的 `DSH_*` 系列）不进 CI：它们需要真实站点、真浏览器或本机宿主，仍按本机命令手动跑；CI 绿不代表站点可用性或安装链路通过。

**默认跳过、需显式打开的门控**（`pnpm test` 全绿**不覆盖**它们；常规集证明引擎 / 服务 / 契约 / 前端逻辑，**不证明任何真实站点可用性、也不证明安装链路**）：

```powershell
# 真机全量重探：改动抓取 / 规则引擎后实测书源**搜索面**可用率（真实联网，耗时数分钟）
# 注意 verified 只证搜索面，不证正文可读
$env:DSH_REPROBE='1'; pnpm vitest run tests/reprobe.test.ts

# 正文链路全量审计：搜索→目录→正文逐段实测 + 失败分桶（正文可用率以本审计为准）
# 它是**报告**：分桶读数靠人判，代码不设通过率断言，只断言每个注册源都进了审计
$env:DSH_CONTENT_AUDIT='1'; pnpm vitest run tests/content-audit.test.ts
$env:DSH_AUDIT_KEYWORDS='小说,完本,的'   # 旋钮（都可省）：关键词表 / 并发 / 每本抽哪几章 / 只审某些源
$env:DSH_AUDIT_WORKERS='5'
$env:DSH_AUDIT_CHAPTERS='0,2,5,mid'
$env:DSH_AUDIT_ONLY='源名子串1,源名子串2'

# 搜索相关性分档 + 按书归并真机审计：全量源聚合搜索 → kept/suspect 分桶读数、按书本数与家数分布、三组待判样例（联网，分钟量级）
# 它是**报告**：不设通过率断言（分母随源增删与站点脸色漂），唯一断言是判据自洽（分档不丢条）；读数供裁「去虚字放行」偏离与那把归并键的焊错面
$env:DSH_SEARCH_FILTER_AUDIT='1'; pnpm vitest run tests/search-relevance-audit.test.ts
$env:DSH_SEARCH_AUDIT_KEYWORD='冰魔女的契约'   # 旋钮（可省）：审计关键词

# 真采集上游：把真实站点抓成 compat fixture 快照（联网；关键词须与回放同批，缺省「书」）
$env:COMPAT_CAPTURE='1'; $env:COMPAT_KEYWORD='书'
pnpm vitest run --config vitest.compat.config.ts tests/compat/capture.test.ts
# 采完离线复算：pnpm test:compat —— 落盘的必须是脱敏后的产物（见下）

# 真安装链路：dsh plugin add → profile bundles 挂载 + lib/client.js / cordis.patch.yml 就位
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
- **脱敏是门禁**：`tests/compat/sanitize.ts` 在写盘前扫 cookie / token / password / authorization / apiKey 与 `Authorization: Bearer …` 形态（判据与被否决的旧写法住该文件头注），`tests/compat/sanitize.test.ts` 钉住它。自动脱敏**是兜底不是证明**，入库前仍要人工过目。
- **`DSH_EPUB_BROWSER` 允许带按应有口径写的「诚实红」**：已知缺陷的读数不削成绿，缺陷与读数登记在该测试文件自己的注释里；修好时按那条记录一起撤下。

**解析面普查（离线，读本地书源库）**——「legado 能解析的书源本插件也能解析」这条目标的进度读数口：把现库**每一条规则串**过 `parseRule`、把**每一个脚本里的 `java.*` 调用**与沙箱实际挂载面对账，输出「本仓拒绝的语法族」「脚本在调而桥没挂的方法」两张清单，并断言**未在册的新形态 = 0**；同时印一张**需求读数表**（矩阵 `note` 里那些「N 源带值」一条命令重算，判据印在数字旁边——同一个键常有两种数法）。

```powershell
$env:DSH_PARSE_CENSUS='1'; pnpm vitest run tests/engine/parse-census.test.ts
```

数不一致只打印漂移、不判红（分母随用户增删漂）；判红的是**绑定落空**（矩阵行 id 被改名 / 删掉、或那个键再也算不出来）与**零读数空转**（当下数出 0 的判据必须在合成样品上数得出非 0，否则分不清「真没人用」与「判据接不上任何东西」）。**分母要定期换**：只跑本机库，一条从未出现过的写法就永远不会露出来——把另一批独立公开合集灌进同一个门（`DSH_PARSE_CENSUS_FILE` 指过去即可，取法见 `tests/engine/parse-census.test.ts` 头注）。

### 兼容判据四门

（随 `pnpm test` 默认跑，运行时不需要任何外部 checkout）

| 门 | 判什么 |
| --- | --- |
| `status-evidence.test.ts` | 逐行验证据可回查：`implemented` 的实现符号在剥注释后的代码里、钉子用例在测试里；`not-applicable` 必须写明裁决理由；`open` 必须带 `2026-MM-DD` 复核戳；行 id 唯一；一行一条记录 |
| `inventory-coverage.test.ts` | 每个能力单元各挂 ≥2 条真实矩阵行（分母是矩阵本身，**不读快照**） |
| `upstream-fields.test.ts` | 对面 7 个规则实体的**每个字段**都要在矩阵有归属 |
| `host-methods.test.ts` | 对面 `java` 宿主方法名集的归属：要么挂在沙箱自报的方法面上、要么在矩阵里逐字点名 |

后两门的分母是**仓内快照** `compat/upstream/snapshot.json`（对面源根路径集 / 规则实体字段表 / java 宿主方法名集），由开发阶段的门控从对面 checkout 抽一次；日常跑门只读快照，**快照不在场即红**（不静默跳过）：

```powershell
$env:DSH_CAPTURE_UPSTREAM='1'; $env:DSH_LEGADO_REF='<对面 checkout 路径>'
pnpm vitest run tests/legado-coverage/capture-upstream-snapshot.test.ts
```

### 真宿主冒烟（手工，动的是宿主与环境，属授权项——仓内没有自动化替代）

`DSH_INSTALL_CHECK` 只证明**源码装入这一格**（一次性 profile、自建 `lib/`、断言 bundles 与产物就位，跑完自己 `remove`）。它不起宿主，所以不证明插件树真能被挂载、也不证明六个工具在宿主里跑得通。那两件事只能手工做：

1. **前置**：先 `pnpm build`。宿主 profile 必须**可由 CLI 写**——保留名 `desktop` 归宿主应用独占，普通 CLI 会以 `profile "desktop" is managed exclusively by the Electron application` 拒写；写不了就改用 CLI 自建的一次性 profile（`dsh plugin --profile <名> add <本地路径>` 初始化它，再把 `@deepseek-ai/dsh-web-app` 加进 `dsh.profile.bundles`），它组出同一棵树。
2. **装载与挂载**：`dsh plugin --profile <名> add link:<本仓目录>`（本包没有 `prepare`：`github:` 直装不会自动构建、缺 `lib/` 会被宿主拒挂——冒烟对象是上一步构建出的本仓产物，源码装一律先构建再 link，见「构建与日常开发」）→ `dsh --profile <名> --dump-config` 的组合树里出现本插件 → 起 `dsh --profile <名>`，看组合树里没有 `plugin tree failed to load`。
3. **工具面与一条真路径**：六个 `dshnovel_` 工具各真调一次；再走一条真实业务：搜 → 详情 → 目录 → 正文并翻一页（顺带覆盖出站代理与解码链）。

**它证明什么**：当前宿主版本上「装得进、挂得上、工具面活着、业务链路走得通一次」。**它不证明**：任何站点的正文可读率（那是 `DSH_CONTENT_AUDIT` 的分桶报告，报告不等于通过率）、浏览器里的渲染与图片解码（那是 `DSH_EPUB_BROWSER`），也不证明其它宿主版本——每次 bump 编译所依（把新宿主加进实测名单）都要重跑这三步，并把结果如实加进上面的实测名单。
