# @xrn1997/dsh-novel

在 DeepSeek Harness（DSH）的 Web GUI 里读网络小说：导入 [legado](https://github.com/gedoor/legado) 书源 → 搜索 → 加书架 → 连续滚动阅读。AI 助手同时获得五个小说工具，一句「帮我找本书并读第 N 章」就能在对话里完成搜索与阅读。

## 功能特性

- **书源导入**：拖入或选择 .json 文件（可多选）或粘贴 legado 书源 JSON，导入跑在**服务端后台任务**——关掉页面不打断，进度与汇总随时回看；按书源地址自动去重（可用源优先保留）
- **阅读体验**：封面网格书架（带阅读进度、**每本书标注来源书源**——同源同色色点 + 源名，源被删则如实标「来源已删除」；支持「选择」进多选态**批量删除**）、聚合搜索跑在服务端（进度实时推送、可中途**停止**且保留已搜出的结果、**切走界面不丢结果**、失败源折叠）、连续滚动阅读（滚动到底自动预取下一章）、目录抽屉跳章、字号 / 行距 / 栏宽 / 纸张色可调、深浅主题自适应
- **AI 助手工具**：搜索、读章、导入书源、试跑书源、查书架五个工具，与 UI 共用同一条链路
- **章节范围导出**：点「⤓ 下载」先弹范围面板（起止章输入 +「整本 / 当前章起」快捷），确认才开下；部分导出文件名带范围后缀（流式下载、显示进度、可随时取消）
- **本地 TXT 导入**：本地小说文件（GBK / UTF-8 自动识别）解析章节后入架阅读
- **书源管理**（调度台 IA，入口在「小说」视图顶部「书源管理」tab）：**待办收件箱**把坏源/未验证置顶成任务卡（批量重验 / 一键验证，处理完自动消解；卡可「✕ 忽略」——待办是提示，成员集一变会自动回来），读数集中在源列表头的**状态带**（共 N · 已启用 · 已停用 · 未验证 · 坏源）；源列表支持文本/状态/分组过滤、行内启停开关（停用源不参与搜索，随时开回）、编辑模式批量启停/验证/删除（做完留在编辑态、勾选保留，成功进反馈条）、单源试跑下钻、登录支持（`POST /sources/:id/auth` 支持 cookie 录入与 `loginUrl` 脚本执行；「去登录」当前只打开源首页——见 `docs/design/client.md` 已知开口）；导入是弹层（拖放/粘贴），完成事项回流待办箱；删除统一模态二次确认（点名登录态失效，危险区/手输口令退役）

## 快速开始

### 安装

```powershell
dsh plugin --profile web add @xrn1997/dsh-novel
```

然后重启 `dsh web`，左侧栏会出现「小说」全局面板入口（图标行；点击即在中央面板打开小说视图）。

npm 安装使用预构建产物，秒装、无需构建授权。也可从 GitHub 源码安装（`dsh plugin --profile web add github:xrn1997/dsh-novel`）：`prepare` 脚本会自动构建，但 pnpm ≥10 首次安装可能报构建脚本被拦截（依赖已装但 `lib/` 未生成），需先在 profile 目录执行 `pnpm approve-builds --all` 再重跑安装命令。

卸载：

```powershell
dsh plugin --profile web remove @xrn1997/dsh-novel
```

### 首次使用

1. **导入书源**：「小说」视图 → 顶部「书源管理」tab → 选择 .json 文件（可多选，选中即开始导入）或粘贴 legado 书源 JSON。导入是**服务端后台任务**——关掉页面不影响导入，回来即可看到进度与汇总；同一书源地址自动去重（已有可用源则跳过，坏源/未验证源被新条替换）。
2. **批量验证**：导入不逐条探针（新源状态为「未验证」）——「书源管理」tab 顶部的**待办收件箱**把坏源/未验证置顶成任务卡，「一键验证」「批量重验」即点即跑；任意集合（状态/分组/文本过滤 + 编辑态勾选 +「验证所选」）同样可发起，慢速后台自测，并发 5 路限流，进度走全局状态条（任务在服务端跑，关页面不打断）。
3. **找书读**：「小说」视图 →「书架」tab 搜索书名 / 作者 → 点封面进入阅读器。阅读进度自动记住。
4. **让 AI 助手干活**：在对话里直接说「帮我找一本《XX》读第三章」「看看 XX 书源为什么坏了」。

## AI 助手工具

| 工具 | 用途 |
| --- | --- |
| `novel_search_books` | 在已启用的**文本**书源中聚合搜索（本插件当前仅支持小说文本面），结果逐源分组（单个源失败不影响其他源）；返回的 `url` 字段可作为其他工具的 `bookKey` |
| `novel_read_chapter` | 获取某本书第 N 章（0 起）的正文纯文本（含章名） |
| `novel_add_source` | 导入 legado 书源 JSON（对象或数组）；导入只做规范化 + 落盘不探针（新源状态「未验证」），逐条返回 `ok` / `missing` / `dupSkipped`（同址已有可用源，保留已有未新增）结果；可用性结论用 `novel_probe_source` 获取 |
| `novel_probe_source` | 对已有书源实际发起一次搜索请求，返回实测结论与失败定位 |
| `novel_shelf` | 查询书架与阅读进度（当前仅 `list`；加书 / 更新进度走阅读器 UI） |

## 配置

插件配置位于 cordis.yml 插件行的 `config` 字段（schemastery 校验，全部可选）：

| 键 | 缺省 | 说明 |
| --- | --- | --- |
| `dataDir` | `$DSH_HOME/novel/` | 数据根目录（见「数据存储」） |
| `searchTimeoutMs` | `15000` | 单源搜索超时（毫秒） |
| `searchParallel` | `5` | 搜索并发源数 |
| `jsTimeoutMs` | `15000` | js 沙箱预算（毫秒，阅读/搜索/探针/登录全链路共用）。legado 书源的多请求目录脚本（多次 `java.ajax` + 签名）需要秒级预算；缺省 2000ms 会把这类源卡死成「脚本超时」 |
| `cacheMaxBytes` | `209715200`（200MB） | 目录 / 正文缓存上限（字节，LRU 淘汰） |
| `exportDelayMs` | `300` | 范围导出的章节间抓取间隔（毫秒，串行限速以避免给站点造成压力） |
| `localImportMaxBytes` | `52428800`（50MB） | 本地 TXT 导入大小上限（字节） |
| `proxyUrl` | 自动探测 | 出站代理，见[常见问题](#常见问题)；`'direct'` 强制直连，或显式指定如 `'http://127.0.0.1:7897'` |

## HTTP API

所有路由以 `/novel-api` 为前缀（仅接受本机 loopback 且 **Origin/Referer 同源**的请求），响应为统一信封 `{ ok, value | error }`，错误附带 `code` 与可选的规则段级定位。共 26 条路由（21 条静态 + 5 条参数，计数由 `tests/shared/wire-builders.test.ts` 钉死）。**路由名与值形状的代码真相在 `src/shared/wire.ts`**（Node 半与浏览器半共用同一份定义，契约测试逐条把守）：

| 面 | 路由 |
| --- | --- |
| 健康检查 | `GET /novel-api` |
| 书源 | `GET /sources`、`POST /sources/import`（后台任务，body `{files:[{name,text}]}`，上限 32MB）、`GET /sources/job-status`（任务进度/汇总）、`POST /sources/batch-probe`（批量验证后台任务）、`POST /sources/batch-enabled`（批量启停）、`POST /sources/batch-delete`、`POST /sources/:id/probe`、`POST /sources/:id/enabled`（启停）、`POST /sources/:id/auth`、`DELETE /sources/:id` |
| 阅读 | `GET /search`（一次性收齐全部命中）、`GET /search/plan`（本次聚合搜索的参搜源集——参与集的唯一主人在服务端）、**`POST /search/job`（把聚合搜索交给后台任务跑，body `{keyword, sourceIds?}` → `{jobId}`；离开界面不影响它跑完）**、**`GET /search/job-status?since=N`（按游标读增量：`added` 是新完成的分组、`next` 是下次该带的游标；整轮结果保留 30 分钟）**、**`GET /search/job-stream?since=N`（同一份快照的 SSE 推送：首帧即 baseline，终帧后服务端关流；推送不可用时客户端自动回落到上面的快照轮询）**、**`POST /search/job-cancel`（停止本轮：不再往下搜，已搜出的命中一律保留）**、`GET /book`、`GET /toc`、`GET /chapter`（`?refresh=1` 绕过缓存） |
| 书架 | `GET /shelf`（条目附 `sourceName` 来源投影——服务端读取时 join 书源注册表）、`PUT /shelf/:key`（带 `title` 加书 / 带 `progress` 更新进度 / 带 `patch` 对在架书改元数据）、`DELETE /shelf/:key`、**`POST /shelf/batch-delete`（多选批量删，body `{keys:[bookKey]}`；本地书连带删副本，未知键静默跳过）** |
| 导出 | `GET /export`（流式 TXT，`from`/`to` 选段（1 基含端，缺席 = 全本），响应头 `X-Novel-Total-Chapters` 为**本次范围**章数、`X-Novel-Range` 为 `from-to`；倒置范围 422 `BadRange`，连接断开即停止抓取） |
| 本地书 | `POST /local/import?name=…`、`DELETE /local?id=…` |

## 数据存储

数据存于 `~/.dsh/novel/`（可用 `dataDir` 配置改写），与项目目录分离——阅读数据是跨项目、跨仓库的：

```
~/.dsh/novel/
├── sources.json   # 书源清单（含登录态，仅存本机、不会外传）
├── shelf.json     # 书架与阅读进度
├── cache/         # 目录 / 正文缓存（LRU，默认上限 200MB）
└── local/         # 导入的本地 TXT（原文 + 元数据与章节偏移表）
```

## 兼容哪些书源

兼容 legado 书源的声明式子集：取值链 / 组合符（`||`、`&&`、`%%`）/ `##` 替换 / AllInOne / JSONPath（含 `.*` 属性通配，且当页面是 JSON 文本时对内容按需解析）/ XPath 子集 / `@put` / `@get` / `@js` 沙箱（脚本完成值语义 + 顶层 `return`/`await` 回落）/ `jsLib` 源级函数库 / `searchUrl` 的 `@js`/`<js>` 形态（沙箱求值出 URL）/ 对象形态方言（**含 `ruleBookInfo.init` 详情上下文初始化**——init 先求值、结果替换后续详情规则与 tocUrl 模板的上下文，`{{$.…}}` 插值按换根后的 JSON 解析）/ `url,{json}` POST 请求（**选项随书 URL 与章节 URL 全程保留**——身份即请求规格，抓取时统一解释）/ 相对 URL / 隐式 CSS 选择器（`#id` / `.class` / 裸 tag / `tag.类` / `tag>子` 组合链 / 纯属性选择器 / 位置索引 `a.0`）/ `!` 排除语法，以及 `@js` 宿主垫片（`java.log` / `getElement` / `setContent` / `cookie` / `source.getVariable` / `source` 等对象）。缺省请求带浏览器 UA（部分站点 WAF 无 UA 直接 403）。

URL 模板语义与 legado 源码（[legado-with-MD3](https://github.com/gedoor/legado) 续作）逐条对齐：`url,{json}` 选项的逗号两侧允许空白（`,` / `, ` 均可）；模板内 `{{...}}` 按 JS 求值（`{{java.encodeURI(key)}}`、`{{page*2}}` 等），纯变量占位 `{{key}}`/`{{page}}` 保持原有的 URL 编码口径；`&&`/`%%` 组合符对空或 Miss 的分支静默跳过、只合并非空结果（与 legado 的并集语义一致，而非全命中）。

遇到不认识的语法，本插件选择**报错而不是猜测**——错误信息精确定位到出错的规则段，而不是产出错误的结果。依赖安卓 WebView 或加解密 API 的书源无法在本环境仿真，会明确报告不支持。

项目带有可离线复算的兼容性回放测试（真实源快照 → 搜索 / 目录 / 正文全链路），详见 [compat/README.md](compat/README.md)。

## 常见问题

**搜索结果全是「网络错误」，或正文显示为空白？**

多半是代理问题。DSH 的 Node 进程使用 undici 发请求，**不会读取系统代理设置**；对代理才可达的站点（如部分小说站），直连会被重定向或重置。解决办法：在配置中显式设置 `proxyUrl`（如 Clash 常用端口 `'http://127.0.0.1:7897'`）。缺省的自动探测顺序为：环境变量 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` → Windows 系统代理 → 直连。

**某条书源报「不支持 xx」的错误？**

本插件只实现 legado 规则的声明式子集（见上节），对无法仿真或不认识的语法会明确报错并定位到规则段，而不会静默给出错误结果。可以尝试换用不依赖 WebView / 加密的同类书源。

**书源探针报「jsLib 执行失败：Code generation from strings disallowed」？**

该源的 `jsLib` 里用了 `eval` / `new Function` 动态执行字符串——本插件的 JS 沙箱出于逃逸防御显式禁用了字符串代码生成（legado 的 Rhino 环境允许），这类源无法仿真。

**安装后侧栏没有出现「小说」面板入口？**

重启 `dsh web` 后生效。如果你是从源码目录安装的，确认已先执行 `pnpm build` 生成 `lib/`（构建产物缺失会让整个插件树拒绝挂载，`dsh web` 直接启动失败而非静默降级），详见[本地源码调试](#本地源码调试)。

## 开发

```powershell
git clone https://github.com/xrn1997/dsh-novel.git
cd dsh-novel
pnpm install
pnpm build        # 构建 lib/（Node 半 + 浏览器半）；改动源码后、重启 dsh web 前必须执行
```

也可以把本地目录直接装进 profile 调试：`dsh plugin --profile web add <本地路径>`。

### 本地源码调试

见上：**`lib/` 是构建产物且不入库，任何从源码目录链进 profile 的安装方式都不会替你构建它。**

```powershell
dsh plugin --profile web add link:C:/path/to/dsh-novel
pnpm build        # 必须在源码目录手动跑一次，缺这步 dsh web 起不来
```

`link:` 的语义是只建目录链接、绝不触碰对端目录，pnpm 不会在对端执行 `prepare`，反复重跑 `dsh plugin add` 也不会生成 `lib/`。同理，`git clone` 后直接 `dsh plugin add` 同样会失败。缺失时的报错是 `dsh: plugin tree failed to load` + `ERR_MODULE_NOT_FOUND`，指向 `lib/index.js`。

日常开发建议挂 watch 构建，避免每次改完手动重跑：

```powershell
pnpm dev          # = tsdown --watch
```

改动的生效方式分两半：

- **浏览器半（`src/client/`）**：`lib/client.js` 的 mtime / size 一变，`dsh-client-hmr`（500ms stat 轮询 + SSE）自动推给浏览器热更新，**无需重启 `dsh web`**。
- **Node 半（其余 `src/`）**：不在热重载链路内，需**重启 `dsh web`**。

### 测试

```powershell
pnpm test          # 常规测试（引擎 / 服务 / API / 工具 / 入口 / 前端逻辑与 smoke）
pnpm test:compat   # 兼容性回放（合成 fixture → 离线复算；**分母见 compat/report.md**）
pnpm test:pack     # 构建 + 产物自检
pnpm typecheck     # tsc --noEmit
```

**默认跳过、需显式打开的四条真链路门控**——`pnpm test` 全绿**不覆盖**它们（真实网络 / 真实安装）：

```powershell
# 真机全量重探（改动抓取/规则引擎后实测书源搜索面可用率；真实访问网络，耗时数分钟）
$env:DSH_REPROBE='1'; pnpm vitest run tests/reprobe.test.ts

# 正文链路全量审计（搜索→目录→正文逐段实测 + 失败分桶；「verified」只证明搜索面，
# 正文可用率以本审计为准——它是**报告**：分桶读数靠人判，代码不设通过率断言，
# 只断言每个注册源都进了审计；报告落 .superpowers/content-audit/，耗时十几分钟）
$env:DSH_CONTENT_AUDIT='1'; pnpm vitest run tests/content-audit.test.ts

# 真采集上游（把真实站点抓成 compat fixture 快照）
$env:COMPAT_CAPTURE='1'; pnpm vitest run --config vitest.compat.config.ts tests/compat/capture.test.ts

# 真安装链路（dsh plugin add → profile bundles 挂载 + lib/client.js/cordis.patch.yml 就位）
$env:DSH_INSTALL_CHECK='1'; pnpm vitest run tests/packaging-install.test.ts
```

> 说明：常规集证明了引擎 / 服务 / 契约 / 前端逻辑，**不证明任何真实站点可用性、也不证明安装链路**。
> 这四条门控是这些承诺的唯一自动化验证，需在改动相应链路后手动跑。

### 架构速览

```
src/
├── engine/     # legado 规则引擎（纯函数：解析 → 求值；段级错误追踪；@js 沙箱）
├── services/   # 业务门面：抓取（编码检测 / 代理）/ 书源注册表 / 书架 / 缓存 / 本地书
├── api/        # /novel-api/* HTTP 路由
├── tools/      # AI 助手五工具（与 HTTP 共用同一 service 层）
├── index.ts    # Node 侧插件入口（Cordis）
└── client/     # 浏览器侧：「小说」视图（书架 / 书城 / 书源管理三 tab）
```

UI、AI 工具、探针三个面共用同一个 service 层，不存在第二套实现。

### 设计与口径真相

- **`CONTEXT.md`**：领域词汇表，每个词条点名它的「唯一实现」位置。
- **`docs/design/engine.md` / `services.md` / `client.md`**：三个子系统的现状真相（single source）——模块地图、关键口径与**为什么**、被否决的方案、测试钉子、已知开口。改这三块之前先读对应那份。
- **`docs/reference/`**：外部事实参考（DSH 插件 API、tsdown 配置）。
- **`AGENTS.md`**：给 agent 的工作须知（真相分层、硬约束、门控、文档纪律）。
- 迭代过程文档（逐任务计划、审查报告、任务简报）**不入库**：`main` 只保留当前真相。

## 贡献

欢迎 Issue 与 PR。提交改动前请确保 `pnpm test` 与 `pnpm typecheck` 通过；若扩展了书源语法，请优先补充对应的回放测试 fixture（脱敏规程见 [compat/README.md](compat/README.md)）。提交即表示你同意以 [Apache-2.0](LICENSE) 协议授权你的贡献。

## 说明

本项目不提供、不内置任何书源，仅用于学习插件开发。

## License

[Apache-2.0](LICENSE)
