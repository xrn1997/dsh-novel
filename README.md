# @xrn1997/dsh-novel

在 DeepSeek Harness（DSH）里读网络小说：导入 [legado](https://github.com/gedoor/legado) 书源 → 聚合搜索 → 加书架 → 连续滚动阅读。AI 助手同时获得六个小说工具（`dshnovel_` 前缀），一句「帮我找本书并读第 N 章」就能在对话里完成搜索与阅读。

![左侧栏「小说」面板：书架 / 书城 / 书源管理 tab](https://raw.githubusercontent.com/xrn1997/dsh-novel/main/docs/screenshots/screenshot-01.png)

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
- [文档地图](#文档地图)
- [贡献](#贡献)
- [致谢](#致谢)

## 功能特性

- **书源导入**：拖入 / 多选 `.json` 或粘贴 legado 书源 JSON；导入跑在服务端后台，关页面不打断，进度与汇总可回看，按书源地址自动去重（可用源优先保留）。
- **书架**：封面网格 + 阅读进度，每本书标注来源书源（同源同色色点 + 源名；源被删则标「来源已删除」）；支持多选批量删除。
- **阅读器**：连续滚动、滚动到底自动预取下一章、目录抽屉跳章；字号 / 行距 / 栏宽 / 纸张色可调，深浅主题自适应；支持章节范围流式导出（可取消）。不在书架上的书点「书架」离开阅读器时会先问是否加入（加入才保存进度）。
- **聚合搜索**：服务端执行，SSE 实时推送（不可用时回落轮询），可中途停止并保留命中，切走界面不丢结果，失败源折叠；结果默认按（书名，作者）归并成一本、行上标「N 家源」，可展开逐源行或「都加架」逐条入架；默认只列书名 / 作者 / 分类含关键词（或书名含其空格分段）的结果，其余折进「疑似无关」、可展开，最多列 200 本并如实报总数；页尾保留「按源看」折叠。
- **书城（分类浏览）**：左栏选源（只有声明了分类入口、启用且没关掉发现的文本源进城；`@js:` / `<js>` 发现入口不执行），右栏看该源自己声明的分类——按源内顺序列、不排序、不跨源合并、不带计数；书单 4 列（窄面板 2 列），「加载更多」一次一页；点书进详情浮层，可读、加架，或手动在其他源搜这本（逐源一行到达、不归并、不排序、不替用户判同书、可停止，未响应的源点名摊开）。
- **AI 助手工具**：搜索、读章、目录、书架（含写）、书源管理、导入书源六个工具，与 UI 共用同一条链路（详见下文）。
- **本地书（TXT / EPUB）**：TXT 自动识别 GBK / UTF-8 并切章；EPUB 2/3 流式排版按 spine 计章，保留原书目录树、正文插图、脚注跳转与返回、基本格式。有损项落成持久导入说明，进书后还能在阅读器里重看。
- **书源管理**：待办收件箱把坏源 / 未验证置顶成任务卡（批量重验 / 一键验证，处理完自动消解），状态带汇总读数；支持文本 / 状态 / 分组过滤、行内启停、批量启停 / 验证 / 删除、单源试跑、cookie 录入与 `loginUrl` 脚本执行两形态；删除二次确认。
- **中英界面**：界面文案跟随宿主语言（中文 / English；服务端返回的错误原文与书源数据不翻，已生成的任务 / 错误条目保留生成时语言），插件卡片标题与描述也随语言切换。

## 安装

插件装进哪个 profile，就在那个 profile 里生效——本插件不绑定宿主的发行形态，只认 DSH 的插件生态。

```powershell
dsh plugin --profile <profile> add @xrn1997/dsh-novel
```

重启宿主后，左侧栏出现「小说」全局面板入口（图标行；点击即在中央面板打开书架 / 书城 / 书源管理 tab）。侧栏入口要求该 profile 的 bundles 里有 `@deepseek-ai/dsh-web-app`；不带它的 profile 只挂 Node 半与 AI 工具，界面上不会多出入口。

npm 安装使用预构建产物，秒装、无需构建授权。从 GitHub 源码安装（`dsh plugin --profile <profile> add github:xrn1997/dsh-novel`）时 `prepare` 脚本会自动构建，但 pnpm ≥10 首次安装可能拦下构建脚本（依赖已装而 `lib/` 未生成），需先在 profile 目录执行 `pnpm approve-builds --all` 再重跑。

卸载：

```powershell
dsh plugin --profile <profile> remove @xrn1997/dsh-novel
```

**宿主兼容声明分两层**：安装许可由 `package.json` 的 `peerDependencies` 决定——宿主 `dsh plugin add` 会拿运行中的宿主版本逐个比对插件的 `@deepseek-ai/dsh*` peer 区间，不满足即 `installation rejected`；peer 区间按宿主线开口，线内 rc / patch 不跟版，跨线才重验。实测记录写在 `dsh.compatibility.dshReleases`，只列真跑过的宿主版本。宿主发版、peer 区间与浏览器模块表的维护流程，以及发布冷却闸，见 [docs/developing.md](https://github.com/xrn1997/dsh-novel/blob/main/docs/developing.md#宿主兼容与发版)。

## 首次使用

1. **导入书源**：「小说」→「书源管理」tab → 选择 .json 文件（可多选，选中即开始导入）或粘贴 legado 书源 JSON。导入是服务端后台任务，关页面不打断；同址自动去重（已有可用源则跳过，坏源 / 未验证源被新条替换）。
2. **批量验证**：导入不逐条探针（新源状态为「未验证」）——顶部**待办收件箱**把坏源 / 未验证置顶成任务卡，「一键验证」「批量重验」即点即跑；任意集合（过滤 + 编辑态勾选 +「验证所选」）同样可发起，后台并发 5 路限流。
3. **找书读**：「书架」tab 顶部搜书名 / 作者 → 点封面进阅读器，阅读进度自动记住。想按分类逛就走「书城」tab：先在左栏点一个源，再点它自己声明的那几类。手上已有文件就走书架末位的**导入本地书籍**（TXT / EPUB）。
4. **让 AI 助手干活**：对话里直接说「帮我找一本《XX》读第三章」「看看 XX 书源为什么坏了」。

## AI 助手工具

| 工具 | 用途 |
| --- | --- |
| `dshnovel_search` | 在已启用的**文本**书源中聚合搜索（当前仅支持小说文本面），与界面同判据、同视图：按书返回——同一（书名，作者）多家归并成一本、逐源各留一行，`failed` 逐家点名未答话的源，`searched`/`answered`/`filtered` 自报本轮账目；返回的 `url` 可作为其他工具的 `bookKey` |
| `dshnovel_read` | 取某本书第 N 章（0 起）的正文纯文本（含章名）；章序从 `dshnovel_toc` 查。图文书同样只给文字：插图落成 `[图片：替代文字]` 占位（无替代文字则 `[图片]`） |
| `dshnovel_toc` | 取书籍目录：逐章返回章名与 0 起 `chapterIndex`（章名→下标的唯一映射处）与章节 URL |
| `dshnovel_shelf` | 书架与阅读进度：`list` / `add` / `save_progress` / `remove` |
| `dshnovel_source` | 书源管理：`list` / `probe`（真实搜索请求 + 失败定位）/ `enable`·`disable` / `remove` |
| `dshnovel_import_source` | 导入 legado 书源 JSON（对象或数组）；只做规范化 + 落盘不探针，逐条返回 `ok` / `missing` / `dupSkipped` |

六个工具与 UI、探针共用同一个 service 层，不存在第二套实现。工具名全部锁 `dshnovel_` 前缀——宿主对工具重名直接抛错，插件专属前缀是与生态其他插件的硬边界（名字集合由 `tests/tools/tools.test.ts` 钉住）。

## 配置

插件配置位于 profile 的 `cordis.patch.yml` 里该插件行的 `config` 字段（schemastery 校验，全部可选）：

| 键 | 缺省 | 说明 |
| --- | --- | --- |
| `dataDir` | `$DSH_HOME/novel/` | 数据根目录（见「数据存储」） |
| `searchTimeoutMs` | `15000` | 单源搜索超时（毫秒） |
| `searchParallel` | `5` | 搜索并发源数 |
| `jsTimeoutMs` | `15000` | js 沙箱预算（毫秒，阅读 / 搜索 / 探针 / 登录全链路共用）。legado 的多请求目录脚本需要秒级预算 |
| `cacheMaxBytes` | `209715200`（200MB） | 目录 / 正文缓存上限（字节，LRU 淘汰） |
| `exportDelayMs` | `300` | 范围导出的章节间抓取间隔（毫秒，串行限速） |
| `localImportMaxBytes` | `52428800`（50MB） | 本地文件导入大小上限（字节，TXT / EPUB 共用） |
| `proxyUrl` | 启动时自动探测 | 出站代理，见[常见问题](#常见问题)；`'direct'` 强制直连，或显式指定如 `'http://127.0.0.1:7897'` |

除 `dataDir` 外，其余 7 项还可在宿主的「插件」页 → `@xrn1997/dsh-novel` 详情里的「运行参数」中编辑（需宿主支持插件配置页）；保存后立即生效，不需要重启插件。旧宿主没有这一页时，配置仍写在 profile 的 `cordis.patch.yml`。`dataDir` 始终需改该文件并重启。

数值项按整数校验；`proxyUrl` 只接受 `direct`、空串或 http(s) 地址（裸 `host:port` 按 `http://` 补全）。非法值（含 `NaN` / `Infinity`）在插件加载期报错；在插件页保存时被同样拒绝，页面保留草稿供修改。显式 `null` 按未设置处理、取缺省。

## HTTP API

所有路由以 `/novel-api` 为前缀（仅接受本机 loopback 且 **Origin/Referer 同源**的请求），响应为统一信封 `{ ok, value | error }`，错误附带 `code` 与可选的规则段级定位。共 35 条路由（30 静态 + 5 参数，计数由 `tests/shared/wire-builders.test.ts` 钉死）。**路由名与值形状的代码真相在 `src/shared/wire.ts`**——Node 半与浏览器半共用同一份定义，契约测试逐条把守。

| 面 | 路由 |
| --- | --- |
| 健康检查 | `GET /novel-api` |
| 书源 | `GET /sources`、`POST /sources/import`（后台任务，body `{files:[{name,text}]}`，上限 32MB）、`GET /sources/job-status`、`POST /sources/batch-probe`、`POST /sources/batch-enabled`、`POST /sources/batch-delete`、`POST /sources/:id/probe`、`POST /sources/:id/enabled`、`POST /sources/:id/auth`、`DELETE /sources/:id` |
| 搜索与阅读 | `GET /search`（一次性收齐全部命中）、`GET /search/plan`（本次参搜源集——参与集的唯一主人在服务端）、`POST /search/job`、`GET /search/job-status?since=N`（按游标读增量）、`GET /search/job-stream?since=N`（同一份快照的 SSE 推送，首帧即 baseline）、`POST /search/job-cancel`（停止本轮：不再往下搜，已搜出的命中一律保留）、`GET /book`、`GET /toc`、`GET /navigation`（线性 `chapters` + 展示树 `items`）、`GET /chapter`（`{kind:'text'}` 或图文树 `{kind:'rich'}`；`?refresh=1` 绕过缓存） |
| 书城发现面 | `GET /explore/kinds`（**按源**给出各源自己声明的**分类标题**清单，零网络请求，入口地址不外泄：原生方言的 `ruleFind` 与 legado 的 `exploreUrl` 都认，后者接**声明式两档**（`标题::URL` 多行 / JSON 条目数组）；脚本形态（`@js:` / `<js>`）的发现入口不执行，那类书源在书城没有分类）、`POST /explore/list`（body `{sourceId, kind}`：一轮 = 点名一个源 + 它自己声明的一类，回 `{jobId}`）、`POST /explore/list/more`（续这一轮的第 page+1 页，**同一轮不换 jobId**；没得续（已到底 / 触页数上限 / 一批在途）→ 409）、`GET /explore/list/job-status`（整轮全量快照，无游标）、`GET /explore/list/job-stream`（同一份快照的 SSE 推送，首帧可能是「还没提交过」的空档） |
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

**「做到哪一步」有机器口径**：`tests/legado-coverage/matrix.ts` 一行一条 legado 语义，每行归入 实现 / 环境不适用 / 待拍板 三态之一，并带可回查的证据（实现符号、钉住它的用例）与裁决理由。四门默认随 `pnpm test` 跑（见 [docs/developing.md 的「兼容判据四门」](https://github.com/xrn1997/dsh-novel/blob/main/docs/developing.md#兼容判据四门)）。想查某个字段支不支持：在矩阵里按 `id` 或能力名搜那一行即可。

## 常见问题

**搜索结果全是「网络错误」，或正文显示为空白？**
多半是代理问题。DSH 的 Node 进程用 undici 发请求，**不会读取系统代理设置**；对代理才可达的站点，直连会被重定向或重置。解决：在配置里显式设 `proxyUrl`（如 Clash 常用端口 `'http://127.0.0.1:7897'`）。缺省的自动探测顺序为：环境变量 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` → Windows 系统代理 → 直连。

**某条书源报「不支持 xx」？**
本插件只实现 legado 规则的声明式子集（见上节），对无法仿真或不认识的语法会明确报错并定位到规则段，而不会静默给出错误结果。可以尝试换用不依赖 WebView / 加密的同类书源。

**探针报「jsLib 执行失败：Code generation from strings disallowed」？**
该源的 `jsLib` 里用了 `eval` / `new Function` 动态执行字符串——本插件的 JS 沙箱出于逃逸防御显式禁用字符串代码生成（legado 的 Rhino 环境允许），这类源无法仿真。

**安装后侧栏没有出现「小说」入口？**
先重启宿主。若从源码目录安装，确认已先 `pnpm build` 生成 `lib/`（构建产物缺失会让整个插件树拒绝挂载，宿主直接启动失败而非静默降级），详见 [docs/developing.md 的「本地源码调试」](https://github.com/xrn1997/dsh-novel/blob/main/docs/developing.md#本地源码调试)；装进了 bundles 里没有 `@deepseek-ai/dsh-web-app` 的 profile，则本就只有工具面、没有侧栏入口。

## 开发

```powershell
git clone https://github.com/xrn1997/dsh-novel.git
cd dsh-novel
pnpm install
pnpm build        # 构建 lib/（Node 半 + 浏览器半）；改动源码后、重启宿主前必须执行
pnpm dev          # = tsdown --watch，日常开发建议挂着
```

本地源码调试、构建产物与热更新、宿主兼容与发版、全部测试门控与真宿主冒烟见 [docs/developing.md](https://github.com/xrn1997/dsh-novel/blob/main/docs/developing.md)；模块形状与语义归属见 [docs/architecture.md](https://github.com/xrn1997/dsh-novel/blob/main/docs/architecture.md)。

## 文档地图

本仓的文档按「一个事实只有一个家」分工，六家各管一种寿命：

| 位置 | 承担 | 明确不承担 |
| --- | --- | --- |
| `README.md`（本文件） | 用户面事实与产品命令：安装、用法、配置键、路由与工具表 | 设计理由、真机读数、贡献者门控与发版细节 |
| `AGENTS.md` | 给 agent 的工作纪律：真相在哪、硬约束、跑门纪律、文档纪律、环境坑 | 时点状态与读数 |
| `CONTEXT.md` | 领域词汇表，每个词条点名它的**唯一实现**符号 | 口径论证、实现细节 |
| `docs/architecture.md` | 形状与归属：分几块、为什么这么切、某条语义该去哪改 | 读数、决策史、逐文件清单 |
| `docs/developing.md` | 贡献者命令与验证：构建、本地调试、全部门控、真宿主冒烟、宿主兼容与发版 | 用户用法、设计决策、真机读数 |
| `docs/adr/` | 决策与当初被否决的替代方案，每篇一个编号文件（只追加，推翻就标 superseded） | 现状描述、验收清单 |

两类东西不进文档：**兼容裁决与真机读数**住 `tests/legado-coverage/matrix.ts` 的行 `note`（要重算见 `docs/developing.md` 的「解析面普查」）；**局部口径的为什么**住实现它的那段代码注释。宿主侧的 API 行为以就地注释引原文 + 每次 bump 现读为凭，本仓**没有**宿主 API 的参考文档；legado 侧的对读结论才冻结成在册快照 `compat/upstream/snapshot.json`。

迭代过程文档（任务计划、审查报告、一次性脚本）**不入库**，写在本机 `.superpowers/`——`main` 只保留当前真相。文档面的引用活性由 `tests/docs-liveness.test.ts` 随 `pnpm test` 把住：路径不在场、写行号、指已出库的东西、ADR 断号，都会红。

## 贡献

欢迎 Issue 与 PR。提交改动前请确保 `pnpm test` 与 `pnpm typecheck` 通过，且**两条命令的退出码都亲眼看过**；完整的真链路门控与真宿主冒烟见 [docs/developing.md 的「测试与真链路门控」](https://github.com/xrn1997/dsh-novel/blob/main/docs/developing.md#测试与真链路门控)。若扩展了书源语法，请优先补充对应的回放测试 fixture（脱敏判据见 `tests/compat/sanitize.ts`），并把新形态在 `tests/legado-coverage/matrix.ts` 里落到正确的那一态。提交即表示你同意以 [Apache-2.0](LICENSE) 协议授权你的贡献。

## 致谢

书源兼容语义的开发阶段对读，参考了 legado 及其续作 [legado-with-MD3](https://github.com/HapeLee/legado-with-MD3)（上游 `gedoor/legado` 已下架）。对读的结论以**仓内快照**形式留存：`compat/upstream/snapshot.json`（源根路径集 / 规则实体字段表 / java 宿主方法名集），由开发阶段的门控工具抽取一次；**运行与 CI 都不依赖任何外部 checkout**。对面 `.kt` 路径与符号只出现在本文件、覆盖矩阵与快照刷新工具里，其余地方只讲本插件自己的口径。

## 说明

本项目不提供、不内置任何书源，仅用于学习插件开发。

## License

[Apache-2.0](LICENSE)
