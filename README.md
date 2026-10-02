# @xrn1997/dsh-novel

在 DeepSeek Harness（DSH）里读网络小说：导入 [legado](https://github.com/gedoor/legado) 书源 → 聚合搜索 → 加书架 → 连续滚动阅读。AI 助手同时获得六个小说工具（`dshnovel_` 前缀），一句「帮我找本书并读第 N 章」就能在对话里完成搜索与阅读。

![左侧栏「小说」面板：书架 / 书城 / 书源管理三个 tab](https://raw.githubusercontent.com/xrn1997/dsh-novel/main/docs/screenshots/screenshot-01.png)

- 安装：`dsh plugin --profile <profile> add @xrn1997/dsh-novel`
- 许可：[Apache-2.0](LICENSE)
- 数据：全部留在本机 `~/.dsh/novel/`，插件不内置任何书源

## 目录

- [功能特性](#功能特性)
- [安装](#安装)
- [首次使用](#首次使用)
- [AI 助手工具](#ai-助手工具)
- [配置](#配置)
- [HTTP API](#http-api)
- [数据存储](#数据存储)
- [本地书格式（TXT / EPUB）](#本地书格式txt--epub)
- [兼容哪些书源](#兼容哪些书源)
- [常见问题](#常见问题)
- [开发](#开发)
- [测试与真链路门控](#测试与真链路门控)
- [文档地图](#文档地图)
- [贡献](#贡献)
- [致谢](#致谢)

## 功能特性

- **书源导入**：拖入或选择 .json 文件（可多选）或粘贴 legado 书源 JSON。导入跑在**服务端后台任务**——关掉页面不打断，进度与汇总随时回看；按书源地址自动去重（可用源优先保留）
- **阅读体验**：封面网格书架（带阅读进度、每本书标注来源书源——同源同色色点 + 源名，源被删则如实标「来源已删除」；多选态批量删除）、连续滚动阅读（滚动到底自动预取下一章）、目录抽屉跳章、字号 / 行距 / 栏宽 / 纸张色可调、深浅主题自适应、章节范围流式导出（可取消）
- **聚合搜索**：跑在服务端，进度实时推送（SSE，不可用时自动回落轮询）、可中途**停止**且保留已搜出的命中、**切走界面不丢结果**、失败源折叠
- **AI 助手工具**：搜索、读章、目录、书架（含写）、书源管理、导入书源六个工具，与 UI 共用同一条链路
- **本地书导入（TXT / EPUB）**：TXT 走 GBK / UTF-8 自动识别后切章入架；EPUB 2/3 流式排版按 spine 计章，保留原书目录树、正文插图、脚注跳转与返回、基本格式。有损项落成**持久导入说明**——导入时就地交代，进书后还能在阅读器里重看
- **书源管理**（调度台 IA，入口在「小说」视图顶部「书源管理」tab）：**待办收件箱**把坏源 / 未验证置顶成任务卡（批量重验 / 一键验证，处理完自动消解），读数集中在源列表头的**状态带**；支持文本 / 状态 / 分组过滤、行内启停、编辑模式批量启停 / 验证 / 删除、单源试跑下钻、登录支持（cookie 录入与 `loginUrl` 脚本执行两形态）；删除统一模态二次确认

## 安装

插件装进哪个 profile，就在那个 profile 里生效——本插件不绑定宿主的发行形态，只认 DSH 的插件生态。

```powershell
dsh plugin --profile <profile> add @xrn1997/dsh-novel
```

重启宿主后，左侧栏出现「小说」全局面板入口（图标行；点击即在中央面板打开书架 / 书城 / 书源管理三个 tab）。侧栏入口要求该 profile 的 bundles 里有 `@deepseek-ai/dsh-web-app`；不带它的 profile 只挂 Node 半与六个 AI 工具，界面上不会多出入口。

npm 安装使用预构建产物，秒装、无需构建授权。从 GitHub 源码安装（`dsh plugin --profile <profile> add github:xrn1997/dsh-novel`）时 `prepare` 脚本会自动构建，但 pnpm ≥10 首次安装可能拦下构建脚本（依赖已装而 `lib/` 未生成），需先在 profile 目录执行 `pnpm approve-builds --all` 再重跑。

卸载：

```powershell
dsh plugin --profile <profile> remove @xrn1997/dsh-novel
```

**宿主兼容声明分两层，别混**：安装许可由 `package.json` 的 `peerDependencies` 决定——宿主 `dsh plugin add` 会拿运行中的宿主版本逐个比对插件的 `@deepseek-ai/dsh*` peer 区间，不满足即 `installation rejected`（区间写窄了，插件在真宿主上装都装不进去）。实测记录写在 `dsh.compatibility.dshReleases`，只列真跑过的宿主版本。两层由 `tests/packaging.test.ts` 同时看住：编译期 devDependency 必须被 peer 区间放行，且必须出现在实测声明里。宿主发新版要做四件事——升级编译所依、给 peer 区间开这一代的口、加实测条目、把新宿主的浏览器模块表（宿主前端的 `staticModules()`）重读一遍并对齐 `PLATFORM_MODULES`；前两件漏了会红，后两件靠真机与人工核对。宿主依赖包的**发布冷却闸**（pnpm 的 `minimumReleaseAge`，24 小时内发布的版本不许进 lockfile）对 `@deepseek-ai/dsh-*` 整 scope 放行，写死在 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`——所以 bump 宿主不必再动一份逐代手写的放行名单（理由与被否决的做法见 `docs/adr/0026`）。

## 首次使用

1. **导入书源**：「小说」→「书源管理」tab → 选择 .json 文件（可多选，选中即开始导入）或粘贴 legado 书源 JSON。导入是服务端后台任务，关页面不打断；同址自动去重（已有可用源则跳过，坏源 / 未验证源被新条替换）。
2. **批量验证**：导入不逐条探针（新源状态为「未验证」）——顶部**待办收件箱**把坏源 / 未验证置顶成任务卡，「一键验证」「批量重验」即点即跑；任意集合（过滤 + 编辑态勾选 +「验证所选」）同样可发起，后台并发 5 路限流。
3. **找书读**：「书架」tab 顶部搜书名 / 作者 → 点封面进阅读器，阅读进度自动记住。手上已有文件就走书架末位的**导入本地书籍**（TXT / EPUB）。
4. **让 AI 助手干活**：对话里直接说「帮我找一本《XX》读第三章」「看看 XX 书源为什么坏了」。

## AI 助手工具

| 工具 | 用途 |
| --- | --- |
| `dshnovel_search` | 在已启用的**文本**书源中聚合搜索（当前仅支持小说文本面），结果逐源分组（单源失败不影响其他源）；返回的 `url` 可作为其他工具的 `bookKey` |
| `dshnovel_read` | 取某本书第 N 章（0 起）的正文纯文本（含章名）；章序从 `dshnovel_toc` 查。图文书同样只给文字：插图落成 `[图片：替代文字]` 占位（无替代文字则 `[图片]`） |
| `dshnovel_toc` | 取书籍目录：逐章返回章名与 0 起 `chapterIndex`（章名→下标的唯一映射处）与章节 URL |
| `dshnovel_shelf` | 书架与阅读进度：`list` / `add` / `save_progress` / `remove` |
| `dshnovel_source` | 书源管理：`list` / `probe`（真实搜索请求 + 失败定位）/ `enable`·`disable` / `remove` |
| `dshnovel_import_source` | 导入 legado 书源 JSON（对象或数组）；只做规范化 + 落盘不探针，逐条返回 `ok` / `missing` / `dupSkipped` |

六个工具与 UI、探针共用同一个 service 层，不存在第二套实现。工具名全部锁 `dshnovel_` 前缀——宿主对工具重名直接抛错，插件专属前缀是与生态其他插件的硬边界（名字集合由 `tests/tools/tools.test.ts` 钉住）。

## 配置

插件配置位于 cordis.yml 插件行的 `config` 字段（schemastery 校验，全部可选）：

| 键 | 缺省 | 说明 |
| --- | --- | --- |
| `dataDir` | `$DSH_HOME/novel/` | 数据根目录（见「数据存储」） |
| `searchTimeoutMs` | `15000` | 单源搜索超时（毫秒） |
| `searchParallel` | `5` | 搜索并发源数 |
| `jsTimeoutMs` | `15000` | js 沙箱预算（毫秒，阅读 / 搜索 / 探针 / 登录全链路共用）。legado 的多请求目录脚本需要秒级预算 |
| `cacheMaxBytes` | `209715200`（200MB） | 目录 / 正文缓存上限（字节，LRU 淘汰） |
| `exportDelayMs` | `300` | 范围导出的章节间抓取间隔（毫秒，串行限速） |
| `localImportMaxBytes` | `52428800`（50MB） | 本地文件导入大小上限（字节，TXT / EPUB 共用） |
| `proxyUrl` | 自动探测 | 出站代理，见[常见问题](#常见问题)；`'direct'` 强制直连，或显式指定如 `'http://127.0.0.1:7897'` |

## HTTP API

所有路由以 `/novel-api` 为前缀（仅接受本机 loopback 且 **Origin/Referer 同源**的请求），响应为统一信封 `{ ok, value | error }`，错误附带 `code` 与可选的规则段级定位。共 34 条路由（29 静态 + 5 参数，计数由 `tests/shared/wire-builders.test.ts` 钉死）。**路由名与值形状的代码真相在 `src/shared/wire.ts`**——Node 半与浏览器半共用同一份定义，契约测试逐条把守。

| 面 | 路由 |
| --- | --- |
| 健康检查 | `GET /novel-api` |
| 书源 | `GET /sources`、`POST /sources/import`（后台任务，body `{files:[{name,text}]}`，上限 32MB）、`GET /sources/job-status`、`POST /sources/batch-probe`、`POST /sources/batch-enabled`、`POST /sources/batch-delete`、`POST /sources/:id/probe`、`POST /sources/:id/enabled`、`POST /sources/:id/auth`、`DELETE /sources/:id` |
| 搜索与阅读 | `GET /search`（一次性收齐全部命中）、`GET /search/plan`（本次参搜源集——参与集的唯一主人在服务端）、`POST /search/job`、`GET /search/job-status?since=N`（按游标读增量）、`GET /search/job-stream?since=N`（同一份快照的 SSE 推送，首帧即 baseline）、`POST /search/job-cancel`（停止本轮：不再往下搜，已搜出的命中一律保留）、`GET /book`、`GET /toc`、`GET /navigation`（线性 `chapters` + 展示树 `items`）、`GET /chapter`（`{kind:'text'}` 或图文树 `{kind:'rich'}`；`?refresh=1` 绕过缓存） |
| 书城发现面 | `GET /explore/kinds`（各源 `ruleFind` 词表的本地并集，零网络请求）、`POST /explore/list`（body `{kind}`，回 `{jobId}`）、`GET /explore/list/job-status`（整轮全量快照，无游标）、`GET /explore/list/job-stream`（同一份快照的 SSE 推送，首帧可能是「还没提交过」的空档） |
| 书架 | `GET /shelf`（条目附 `sourceName` 来源投影）、`PUT /shelf/:key`（带 `title` 加书 / 带 `progress` 存进度 / 带 `patch` 改元数据）、`DELETE /shelf/:key`、`POST /shelf/batch-delete`（本地书连带删副本，未知键静默跳过） |
| 导出 | `GET /export`（流式 TXT，`from`/`to` 选段（1 基含端，缺席 = 全本），响应头 `X-Novel-Total-Chapters` / `X-Novel-Range`；倒置范围 422 `BadRange`，连接断开即停止抓取） |
| 本地书 | `POST /local/import?name=…`、`DELETE /local?id=…`（连带删整份副本）、`GET /local/document?id=&documentId=`（脚注 / 附录）、`GET /local/resource?id=&resourceId=`（插图与封面，只认不透明资源 ID）、`GET /local/warnings?id=`（持久化的导入说明） |

## 数据存储

数据存于 `~/.dsh/novel/`（可用 `dataDir` 改写），与项目目录分离——阅读数据是跨项目、跨仓库的：

```
~/.dsh/novel/
├── sources.json   # 书源清单（含登录态，仅存本机、不会外传）
├── shelf.json     # 书架与阅读进度
├── cache/         # 目录 / 正文缓存（LRU，默认上限 200MB）
└── local/         # 本地书：TXT 是 <uuid>.txt + <uuid>.json（章节偏移表）
                   # EPUB 是 <uuid>/ 目录（原文 + 派生文档 + 资源）+ <uuid>.json
```

## 本地书格式（TXT / EPUB）

「书架」末位的**导入本地书籍**卡收 `.txt` 与 `.epub`；分流由服务端**按内容**做（文件头是 ZIP 就按 EPUB 解析）。

| 格式 | 支持 | 明确不做 / 已知边界 |
| --- | --- | --- |
| TXT | BOM 优先 → UTF-8 严格探测 → GBK 回退；标题行切章（第X章 / 卷 / 回 / 节 / 章外篇目 …） | 自定义章名正则（legado 那套「按内容打分挑规则」未接，本仓是一条钉死的正则）；PDF / MOBI / UMD 未接 |
| EPUB 2 / 3（流式排版） | 阅读顺序按 **spine 主序列**计章；原书目录树（EPUB3 nav / EPUB2 NCX，含章内锚点与命名锚点）；封面；正文插图（JPEG/PNG/GIF/WebP 与受限静态 SVG）；基本格式（段落、标题、粗斜体、列表、引用、分隔线、基本表格、上下标、预格式文本）；脚注与附录（补充文档面板，可跟随可返回） | **不加载出版方 CSS 与字体**（排版归本插件阅读设置）；**固定版式**、需 DRM 解密的正文、脚本驱动的交互与音视频不宣称支持（明确拒绝或告警）；正文内联 `<svg>` 装饰图形剥离并记说明（整页是一棵只包一张书内图的 SVG 时按那张图读那一章）；远程图片一律拒绝 |

- **按内容分流、不互相兜底**：文件头是 ZIP 就按 EPUB 解析，失败**不会**回退成 TXT——否则一份加密压缩包会以「一本乱码书」入架；不是 ZIP 的字节才走 TXT 解码链。
- **文字输出只有文字**：图片只在 EPUB 阅读器里显示；TXT 导出与六个 AI 工具把插图投影成 `[图片：替代文字]` 占位。本轮不提供 EPUB / 图片导出。
- **有损导入的交代是持久的**：`GET /local/warnings` 可回看（导入时在书架就地显示，进书后在阅读器「导入说明」重看），不静默丢内容；带持久说明的导入不自动跳进阅读器。
- **导入失败说具体原因**：固定版式 / 加密条目 / 是 ZIP 魔数但读不成归档（缺 `mimetype`、条目越界或重名、CRC 对不上、截断）/ 超限由服务端逐条点名，不折叠成「导入失败」一句泛话。

## 兼容哪些书源

兼容 legado 书源的**声明式子集**：取值链 / 组合符（`||`、`&&`、`%%`）/ `##` 替换 / AllInOne / JSONPath（含 `.*` 属性通配，页面是 JSON 文本时对内容按需解析）/ XPath 子集 / `@put` / `@get` / `@js` 沙箱（脚本完成值语义 + 顶层 `return`/`await` 回落）/ `jsLib` 源级函数库 / `searchUrl` 的 `@js`/`<js>` 形态 / 对象形态方言（**含 `ruleBookInfo.init` 详情上下文初始化**）/ `url,{json}` POST 请求（选项随书 URL 与章节 URL 全程保留）/ 相对 URL / 隐式 CSS 选择器 / `!` 排除语法，以及 `@js` 宿主垫片（`java.log` / `getElement` / `setContent` / `cookie` / `source.getVariable` 等）。缺省请求带浏览器 UA（部分站点 WAF 无 UA 直接 403）。

URL 模板语义按 legado 书源格式对齐：`url,{json}` 选项的逗号两侧允许空白；模板内 `{{...}}` 按 JS 求值（`{{java.encodeURI(key)}}`、`{{page*2}}`、源级 `jsLib` 定义的全局如 `{{host}}`），变量占位 `{{key}}`/`{{page}}` 保持原有的 URL 编码口径；URL 里的 js 块可出现在任意位置（`<js>…</js>` 闭区间、`@js:` 吃到串尾、块间字面文本按 `@result` 拼接）；`charset` 同时用于**请求体编码**与响应解码（GBK 站点才搜得到）；`&&` / `%%` 对空或 Miss 的分支静默跳过、只合并非空结果。

遇到不认识的语法，本插件选择**报错而不是猜测**——错误定位到出错的规则段，而不是产出错误结果。依赖安卓 WebView 或加解密 API 的书源无法在本环境仿真，会明确报告不支持。

**「做到哪一步」有机器口径**：`tests/legado-coverage/matrix.ts` 一行一条 legado 语义，每行归入 实现 / 环境不适用 / 待拍板 三态之一，并带可回查的证据（实现符号、钉住它的用例）与裁决理由。四门默认随 `pnpm test` 跑（见[测试与真链路门控](#测试与真链路门控)）。想查某个字段支不支持：在矩阵里按 `id` 或能力名搜那一行即可。

## 常见问题

**搜索结果全是「网络错误」，或正文显示为空白？**
多半是代理问题。DSH 的 Node 进程用 undici 发请求，**不会读取系统代理设置**；对代理才可达的站点，直连会被重定向或重置。解决：在配置里显式设 `proxyUrl`（如 Clash 常用端口 `'http://127.0.0.1:7897'`）。缺省的自动探测顺序为：环境变量 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` → Windows 系统代理 → 直连。

**某条书源报「不支持 xx」？**
本插件只实现 legado 规则的声明式子集（见上节），对无法仿真或不认识的语法会明确报错并定位到规则段，而不会静默给出错误结果。可以尝试换用不依赖 WebView / 加密的同类书源。

**探针报「jsLib 执行失败：Code generation from strings disallowed」？**
该源的 `jsLib` 里用了 `eval` / `new Function` 动态执行字符串——本插件的 JS 沙箱出于逃逸防御显式禁用字符串代码生成（legado 的 Rhino 环境允许），这类源无法仿真。

**安装后侧栏没有出现「小说」入口？**
先重启宿主。若从源码目录安装，确认已先 `pnpm build` 生成 `lib/`（构建产物缺失会让整个插件树拒绝挂载，宿主直接启动失败而非静默降级），详见[本地源码调试](#本地源码调试)；装进了 bundles 里没有 `@deepseek-ai/dsh-web-app` 的 profile，则本就只有工具面、没有侧栏入口。

## 开发

```powershell
git clone https://github.com/xrn1997/dsh-novel.git
cd dsh-novel
pnpm install
pnpm build        # 构建 lib/（Node 半 + 浏览器半）；改动源码后、重启宿主前必须执行
pnpm dev          # = tsdown --watch，日常开发建议挂着
```

### 本地源码调试

**`lib/` 是构建产物且不入库，任何从源码目录链进 profile 的安装方式都不会替你构建它。**

```powershell
dsh plugin --profile <profile> add link:C:/path/to/dsh-novel
pnpm build        # 必须在源码目录手动跑一次，缺这步宿主起不来
```

`link:` 只建目录链接、绝不触碰对端目录，pnpm 不会在对端执行 `prepare`，反复重跑也不会生成 `lib/`。缺失时的报错是 `dsh: plugin tree failed to load` + `ERR_MODULE_NOT_FOUND`，指向 `lib/index.js`。

改动生效分两半：**浏览器半**（`src/client/`）由 `dsh-client-hmr`（500ms stat 轮询 + SSE）在 `lib/client.js` 的 mtime / size 变化时自动推给浏览器热更新，无需重启；**Node 半**不在热重载链路内，需重启宿主。

### 架构速览

```
src/
├── engine/     # legado 规则引擎（纯函数：解析 → 求值；段级错误追踪；@js 沙箱）
├── services/   # 业务门面：抓取（编码检测 / 代理）/ 书源注册表 / 书架 / 缓存 / 本地书
├── api/        # /novel-api/* HTTP 路由
├── tools/      # AI 助手六工具（与 HTTP 共用同一 service 层）
├── index.ts    # Node 侧插件入口（Cordis）
├── shared/     # 跨半 wire 契约（唯一主人）
└── client/     # 浏览器侧：「小说」视图（书架 / 书城 / 书源管理三 tab）
```

## 测试与真链路门控

```powershell
pnpm test          # 常规集（引擎 / 服务 / API / 工具 / 入口 / 前端逻辑与 smoke / 兼容判据四门）
pnpm test:compat   # 兼容性回放（compat/fixtures → 离线复算；报告写 compat/report.md，产物不入库）
pnpm test:pack     # 构建 + 产物自检
pnpm typecheck     # tsc --noEmit —— 必须与 pnpm test 同批跑
```

> **跑门取退出码，别看管道说了什么**：`pnpm test | tail` 之后退出码是管道工具的，红会被吃掉。先把输出灌进文件、再单独打印退出码；**跑门与提交必须是两条命令**。

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

# 真采集上游：把真实站点抓成 compat fixture 快照（联网；关键词须与回放同批，缺省「书」）
$env:COMPAT_CAPTURE='1'; $env:COMPAT_KEYWORD='书'
pnpm vitest run --config vitest.compat.config.ts tests/compat/capture.test.ts
# 采完离线复算：pnpm test:compat —— 落盘的必须是脱敏后的产物（见下）

# 真安装链路：dsh plugin add → profile bundles 挂载 + lib/client.js / cordis.patch.yml 就位
$env:DSH_INSTALL_CHECK='1'; pnpm vitest run tests/packaging-install.test.ts

# 真浏览器门（离线）：EPUB 图文阅读的真图片解码 / 真排版位置 / 真下载字节
# 本地随机端口起真服务、驱动构建产物 lib/client.js，只用**已安装的** Edge/Chrome，从不下载
$env:DSH_EPUB_BROWSER='1'; pnpm vitest run tests/browser/epub-reader.test.ts
```

- **采集三条实践口径**：出站与生产同口径（走 `resolveProxyUrl`：config > 环境变量 > 系统代理 > 直连，缺这条会把反爬壳页采成「正文为空」）；manifest 的键是**请求 URL**而非重定向后的落地地址（搜索类源常「POST 出去、302 落到结果页」）；站点会抖，**别删已采好的 fixture**，重采会覆盖、删除只会让你重新赌一次站点脸色。落盘的是生产解码链读到的文本（`decodeBody`：声明 charset → content-type → `<meta>` 嗅探），GBK 页才存成真中文。
- **脱敏是门禁**：`tests/compat/sanitize.ts` 在写盘前扫 cookie / token / password / authorization / apiKey 与 `Authorization: Bearer …` 形态（判据与被否决的旧写法住该文件头注），`tests/compat/sanitize.test.ts` 钉住它。自动脱敏**是兜底不是证明**，入库前仍要人工过目。
- **`DSH_EPUB_BROWSER` 允许带按应有口径写的「诚实红」**：已知缺陷的读数不削成绿，缺陷与读数登记在该测试文件自己的注释里；修好时按那条记录一起撤下。

**解析面普查（离线，读本地书源库）**——「legado 能解析的书源本插件也能解析」这条目标的进度读数口：把现库**每一条规则串**过 `parseRule`、把**每一个脚本里的 `java.*` 调用**与沙箱实际挂载面对账，输出「本仓拒绝的语法族」「脚本在调而桥没挂的方法」两张清单，并断言**未在册的新形态 = 0**；同时印一张**需求读数表**（矩阵 `note` 里那些「N 源带值」一条命令重算，判据印在数字旁边——同一个键常有两种数法）。

```powershell
$env:DSH_PARSE_CENSUS='1'; pnpm vitest run tests/engine/parse-census.test.ts
```

数不一致只打印漂移、不判红（分母随用户增删漂）；判红的是**绑定落空**（矩阵行 id 被改名 / 删掉、或那个键再也算不出来）与**零读数空转**（当下数出 0 的判据必须在合成样品上数得出非 0，否则分不清「真没人用」与「判据接不上任何东西」）。**分母要定期换**：只跑本机库，一条从未出现过的写法就永远不会露出来——把另一批独立公开合集灌进同一个门（`DSH_PARSE_CENSUS_FILE` 指过去即可，取法见 `tests/engine/parse-census.test.ts` 头注）。

**兼容判据四门**（随 `pnpm test` 默认跑，运行时不需要任何外部 checkout）：

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
2. **装载与挂载**：`dsh plugin --profile <名> add github:xrn1997/dsh-novel`（源码装首次要 `pnpm approve-builds --all`）→ `dsh --profile <名> --dump-config` 的组合树里出现本插件 → 起 `dsh --profile <名>`，看组合树里没有 `plugin tree failed to load`。
3. **工具面与一条真路径**：六个 `dshnovel_` 工具各真调一次；再走一条真实业务：搜 → 详情 → 目录 → 正文并翻一页（顺带覆盖出站代理与解码链）。

**它证明什么**：当前宿主版本上「装得进、挂得上、工具面活着、业务链路走得通一次」。**它不证明**：任何站点的正文可读率（那是 `DSH_CONTENT_AUDIT` 的分桶报告，报告不等于通过率）、浏览器里的渲染与图片解码（那是 `DSH_EPUB_BROWSER`），也不证明其它宿主版本——每次 bump 宿主版本都要重跑这三步，并把结果如实加进上面的实测名单。

## 文档地图

本仓的文档按「一个事实只有一个家」分工，五家各管一种寿命：

| 位置 | 承担 | 明确不承担 |
| --- | --- | --- |
| `README.md`（本文件） | 用户面事实与全部命令：安装、用法、配置键、路由与工具表、门控 | 设计理由、真机读数 |
| `AGENTS.md` | 给 agent 的工作纪律：真相在哪、硬约束、跑门纪律、文档纪律、环境坑 | 时点状态与读数 |
| `CONTEXT.md` | 领域词汇表，每个词条点名它的**唯一实现**符号 | 口径论证、实现细节 |
| `docs/architecture.md` | 形状与归属：分几块、为什么这么切、某条语义该去哪改 | 读数、决策史、逐文件清单 |
| `docs/adr/` | 决策与当初被否决的替代方案，每篇一个编号文件（只追加，推翻就标 superseded） | 现状描述、验收清单 |

两类东西不进文档：**兼容裁决与真机读数**住 `tests/legado-coverage/matrix.ts` 的行 `note`（要重算走 `DSH_PARSE_CENSUS`）；**局部口径的为什么**住实现它的那段代码注释。宿主侧的 API 行为以就地注释引原文 + 每次 bump 现读为凭，本仓**没有**宿主 API 的参考文档；legado 侧的对读结论才冻结成在册快照 `compat/upstream/snapshot.json`。

迭代过程文档（任务计划、审查报告、一次性脚本）**不入库**，写在本机 `.superpowers/`——`main` 只保留当前真相。文档面的引用活性由 `tests/docs-liveness.test.ts` 随 `pnpm test` 把住：路径不在场、写行号、指已出库的东西、ADR 断号，都会红。

## 贡献

欢迎 Issue 与 PR。提交改动前请确保 `pnpm test` 与 `pnpm typecheck` 通过，且**两条命令的退出码都亲眼看过**；若扩展了书源语法，请优先补充对应的回放测试 fixture（脱敏判据见 `tests/compat/sanitize.ts`），并把新形态在 `tests/legado-coverage/matrix.ts` 里落到正确的那一态。提交即表示你同意以 [Apache-2.0](LICENSE) 协议授权你的贡献。

## 致谢

书源兼容语义的开发阶段对读，参考了 legado 及其续作 [legado-with-MD3](https://github.com/HapeLee/legado-with-MD3)（上游 `gedoor/legado` 已下架）。对读的结论以**仓内快照**形式留存：`compat/upstream/snapshot.json`（源根路径集 / 规则实体字段表 / java 宿主方法名集），由开发阶段的门控工具抽取一次；**运行与 CI 都不依赖任何外部 checkout**。对面 `.kt` 路径与符号只出现在本文件、覆盖矩阵与快照刷新工具里，其余地方只讲本插件自己的口径。

## 说明

本项目不提供、不内置任何书源，仅用于学习插件开发。

## License

[Apache-2.0](LICENSE)
