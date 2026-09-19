# 服务层与双半契约

本文是**服务层（`src/services/`）、HTTP 面（`src/api/`）、wire 契约（`src/shared/wire.ts`）与工具投影（`src/tools/`）的现状真相**（single source）；领域词汇见 `CONTEXT.md`——源入库、按址去重、书源注册表、启停、探针、请求组装、后台任务、书目字段集、wire 契约、缺键投影、规范值、本地书、bookKey 一律用那里的词，别自造。面向「下一个改服务层的人或 AI」：只讲口径与理由；操作步骤见 `README.md`，路由表与数据目录布局不在此重复抄。

## 模块地图

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `services/reading.ts` | 阅读链路门面：HTTP / 工具 / UI 三面的**唯一**业务入口 | `ReadingService.create/from`、`search/searchProgressive/searchPlan`、`startSearchJob/searchJobSnapshot`、`getDetail/getToc/getChapter`、`probe`、`shelfAdd/shelfPatch/shelfSaveProgress/removeBook`、`localImport/removeLocalBook`、`startImportJob/startBatchProbeJob/jobStatus`、`*Source*` 写侧动词、`flush`、`tocUrlOf`、`normalizeChapterText` |
| `services/sources.ts` | 书源注册表：加载 / 原子变更 / 只读投影 / 合并落盘 | `SourceRegistry.load`、`edit/flush/list/get/toPublic`、`SourceEdit` |
| `services/intake.ts` | 源入库：normalize → 批内留首条 → 按址去重 → add/replace | `SourceIntake`、`IntakeDecision`、`dedupKey` |
| `services/import-job.ts` | 后台写任务单槽（导入 / 批量验证）；生命周期登记给宿主 `ctx.jobs`（`host?: JobHost` 窄面，协作式取消） | `SourceJobs`、`JobRunningError`、`JobKind`、`ImportFile`、`JobHost`、`JobOutcome` |
| `services/search-job.ts` | 聚合搜索的**读任务**槽：Node 半持有整轮结果 + 游标增量读面，生命周期同样登记给宿主 `ctx.jobs`（kind `novel-search`） | `SearchJobs`、`SearchJobRun` |
| `services/normalize.ts` | 三方言（legado 平铺 / legado 对象 / Native）→ 规范化规则集 | `normalizeSource`、`NormalizeResult`、`splitGroups`、`stripLeadingIcons`、`isNativeSource`、`SOURCE_KIND_LABEL` |
| `services/request.ts` | 请求组装：模板 + 变量 + baseUrl → 可执行请求计划 | `assembleRequest`、`fetchInitOf`、`parseUrlOption`、`stripUrlOption`、`splitUrlOption`、`absUrlKeepOption`、`canonUrl`、`buildSearchRequest`、`RequestPlan` |
| `services/search-face.ts` | 搜索面：JS 模板解析 → 组装 → 抓取解码 → 列表求值 → 条目 | `fetchSearchPage`、`searchErrorCodeOf`、`SearchFaceResult` |
| `services/search-template.ts` | searchUrl 的 JS 形态与 `{{…}}` 预求值 | `resolveSearchTemplate`、`resolveJsSearchTemplate`、`preEvaluateUrlJs`、`isJsSearchUrl` |
| `services/fetcher.ts` | 守门抓取器（唯一出站口）+ 解码链 + 出站头合并 | `createFetcher`、`decodeBody`、`fetchTextPage`、`headerOf`、`Fetcher`、`FetchedPage` |
| `services/engine-fetch.ts` | `@js` 里 `java.ajax` 的守门出口 | `engineFetch` |
| `services/bridge.ts` | 引擎↔服务桥：值规约、条目提取、源级求值上下文 | `firstValue`、`listValue`、`extractItems`、`engineContextOf`、`makeSubEval`、`Page`、`SubRuleEval` |
| `services/pagination.ts` | 翻页闸（URL 防环 / 零新增 / 回环 / 上限 + 串章）+ next 列表语义 | `followPages`、`FollowResult` |
| `services/chapter-page.ts` | 章节分页判定（防串章闸判据） | `isSameChapterPage`、`stripExtension` |
| `services/content.ts` | 正文取值收口（HTML → 纯文本，幂等） | `contentToText`、`htmlToText`、`looksLikeHtml` |
| `services/localbooks.ts` | 本地 TXT 书库：解码 / 切章 / 偏移切片 / 内存 LRU / 删除 | `LocalBooks`、`decodeLocalText`、`splitChapters`、`isLocalBookKey`、`ChapterSpan` |
| `services/shelf.ts` | 书架：元数据写口（add = patch 语义 / update = 补丁）+ 进度 | `Shelf`、`AddBookInput`、`BookPatch` |
| `services/cache.ts` | 目录 / 正文文件缓存 + LRU 淘汰 | `PageCache`、`safeKey` |
| `services/storage.ts` | 数据根、原子写与并发串行、读 JSON 的损坏判别、防抖写 | `novelDir`、`readJson`、`writeJsonAtomic`、`writeFileAtomic`、`createDebouncedWriter`、`CorruptJsonError` |
| `services/errors.ts` | 错误类与**分类学单点** | `classify`、`ErrorCategory`、`SourceNotFoundError`、`ChapterNotFoundError`、`RuleMissingError`、`FetchError`、`DecodeError`、`LocalNotMountedError` |
| `services/probe.ts` | 探针：真发一次搜索请求（关键词逐词重试） | `probeSource` |
| `services/export.ts` | 整本导出核心：串行 + 节流 + 失败即停 + abort 即停 | `exportBook`、`ExportDeps`、`ExportOptions` |
| `services/proxy.ts` | 出站代理判定（config > 环境变量 > Windows 系统代理 > 直连） | `resolveProxyUrl`、`proxyFromEnv`、`normalizeProxyServer`、`readSystemProxy` |
| `services/types.ts` | 持久化模型（sources.json 形状） | `NovelSource`、`NormalizedRules`、`SourceAuth`；`SourceStatus` / `SourceContentKind` / `ShelfBook` / `ShelfProgress` 反向 re-export `shared/wire.ts` |
| `services/url.ts` | URL 绝对化（拆 request↔bridge 环的纯工具） | `absUrl` |
| `api/dispatch.ts` | `/novel-api` 前缀路由内部分发 | `createApiHandler`、`ApiHandlerOptions` |
| `api/wire.ts` | 同源 fence / body 读取 / 信封写出 / 错误→HTTP 映射 | `isTrustedRequest`、`readJsonBody`、`writeOk`、`writeError`、`errorStatusOf`、`ApiError` |
| `shared/wire.ts` | **跨半契约**：值形状、路由常量、query/body 构造器、书目字段集 | `ROUTES`、`paramRoutes`、`SEG`、`PARAMS`、`queries`、`shelfBody`、`SHELF_META`、`pickShelfMeta`、`LOCAL_SOURCE_ID`、`NOVEL_API_PREFIX`、全部 DTO |
| `tools/tools.ts` | agent 五工具（与 HTTP 共用 service 层） | `buildTools`、`registerTools` |
| `tools/project.ts` | 缺键投影唯一实现 | `project` |

## 关键口径与不变量

### 1. 源入库（`services/intake.ts`）——入库规则的唯一实现

`SourceIntake.intake(raw)` 是「书源进入系统」的全部语义，顺序钉死：**normalize → 批内留首条 → 按址去重 → add / replace**。两条调用路——后台导入任务（`import-job.runImport`）与工具面同步导入（`reading.importSource/importOne`）——都只是**调用方**，只把 `IntakeDecision` 映射成自己的词汇（任务 counts/issues、工具 `ImportOutcome`）。

- 批的边界 = 一个 `SourceIntake` 实例的生命周期：构造时冻结库内地址快照（`byKey`，O(1) 查重），批内新落键实时并入；`batchKeys` 与库内已有键**分列**，两种去重语义不混用。
- **被否决的方案**：规则只住在 `runImport` 里（历史形态）。后果是同址可重复入库——同步工具面导入没有去重，入库规则只兑现了一半。
- 去重键 `dedupKey` = `trim` + 去尾部 `/`，**不改大小写**（legado 地址区分路径大小写，魔改会误判）。

### 2. 可/不可用源的去重差异（`intake.intake`）

同一 baseUrl 已有条目时：

- 已有条目里**存在 verified** → 保留已有、跳过新条，`skipped{reason:'verified'}`。取 `existing.find(verified) ?? existing[0]`——不能让一条历史脏的 unverified 条目把可用源挤掉。**verified 跳过同样占批内键**（与旧任务口径一致，后续同址条目一律 batch 跳过）。
- **无可用的**（全 broken / unverified）→ 新条 `tx.replace(preferred.id, result)` **复用旧 id**（书架与既有引用不断），并 `tx.removeAll(rest)` 清掉同键其余条目。历史脏数据在此收敛成一条。
- 缺地址的条目（normalize 失败）不参与去重，按 missing 口径逐条报。

`replace` 的语义在注册表侧：原位 splice 保列表序、`status` 复位 `unverified`、`importedAt` 更新为现在——**新规则需重验**，且只收 `ok:true` 的 normalize 产物（与 `add` 同口径）。

### 3. 书源注册表是原子事务，落盘不是调用方的纪律（`services/sources.ts`）

`SourceRegistry` 对外只有 `edit(recipe)` / `flush()` / `list()` / `get()` / `toPublic()`。原 7 个公开 mutator 与公开 `persist()` **全部删除**——「改了忘落盘」在 interface 上不可表达。recipe 同步执行，故一次 `edit` 内的多步变更对外不可分割（并发 edit 不交错）。

落盘策略住在 module 内部，调用方不知道粒度存在：累计 ≥20 次变更的那次 `edit` **等写落地**，否则 100ms 尾沿防抖后台合并；任务收尾与测试断言用 `flush()`。**被否决的方案**：9 处调用点手工配对「mutator + persist」（注释里的顺序约束），加上住在任务运行器里的 `IMPORT_PERSIST_EVERY` / `PROBE_PERSIST_EVERY` 两个节流常量——谁忘了 persist 就是静默丢数据。

`load()` 承担**存量归一**并在改动时立即落盘收敛：`enabled` 缺省 → true（早期数据无此字段，缺省即启用，否则搜索面 `s.enabled &&` 会静默排除老源）；`type` 缺省 → `'text'`；`groups` 按 `splitGroups` 拆分（逗号粘连收敛）；`name` 按 `stripLeadingIcons` 剥前缀图标。四条迁移都幂等。

`list()` 返回**活体数组**（不是快照）：intake 的地址索引与 import-job 的状态判定依赖活引用。快照化读面是另一张卡的事。

### 4. 后台任务：写任务单槽、读任务另开一槽（`services/import-job.ts` + `services/search-job.ts`）

`SourceJobs` 只有一个 `current: JobState`。运行中再提交（任意 kind）→ `JobRunningError` → 路由 409 `JobRunning`。任务结束后结果**保留在槽内**直到下一个任务开始——关设置页、刷新浏览器后重挂载查一次 `job-status` 就能恢复展示。**这条互斥只管两个写任务**；聚合搜索是读，另开一槽（见下面 `novel-search`）。

**生命周期已登记给宿主 `ctx.jobs`（2026-09），单槽互斥与 counts 仍归本模块**。分工是刻意的两半：宿主注册表管**身份与生命周期**（`<kind>-N`、`running → completed|killed|failed`、owner 栅栏、随服务卸载而 cancel），`SourceJobs` 管**业务计数与明细**（`counts` / `issues` / `fileErrors`——宿主只有 `label` + `detail` 一行，装不下 642 源的失败分桶）。要点：
- `kind` 用 `novel-import` / `novel-probe` / `novel-search`（宿主对 kind 的唯一判据是「非空字符串」，按不透明命名空间处理，不需要类型包合并）；`label` 写清工作量（`导入书源 N 个文件` / `批量验证书源 N 家` / `聚合搜索「kw」（N 家书源）`）。
- **类型面是本地窄镜像** `JobHost`（`src/index.ts` 的 `NovelContext` + `*Like` 先例）：npm 上的 `@deepseek-ai/dsh-jobs` 停在 `0.0.1-rc.3` 而宿主跑 `0.1.5-rc.1`，装它等于拿一套不同代的契约。**`host` 缺席即不登记**（单测直构与无 jobs 的组合都走这条路，任务语义不变）。
- 入口在 `ctx.effect` 里 `attachController('dsh-novel')`：宿主 `start` 的准入闸要求「有已挂载 controller 服务该 owner」，而本机 profile 里第一方的 `tool-jobs` 是 disabled 的（证据见 `docs/reference/dsh-plugin-api.md` 风险第 10 条）。
- **取消是协作式的**：宿主 `cancel(reason)` 只把旗子立起来，运行器在**取下一条之前**收手——在途的网络探针/入库不打断（打断半路写回的源更脏）。收手时已入库/已验证的结果一律保留 + `flush()` 等齐，`JobState` 落 `phase='failed'` + `error='任务已取消：…'`。**wire 的 `phase` 不加 `killed`**：对 UI 的判据（`phase !== 'running'`）两个终态无区别，加一态要动跨半契约与三处判据，收益为零。宿主侧则如实结算 `status:'killed'`。
- 收尾三处写口（`completed` / `killed` / `failed`）集中在 `settle()` 一处——漏掉一处就是「小说 UI 显示已结束，宿主注册表里还挂着 running」。终态词汇 `JobOutcome` 也只此一处声明（`search-job.ts` 复用同一别名，不各写一份联合类型）。
- **`novel-search` 不进写槽**：搜索是**读**，与导入 / 验证挤同一个 `current` 等于「搜一本书能挡住一次导入」——那是惩罚探索动作。所以读任务有自己的持有者 `SearchJobs`（`services/search-job.ts`），与 `SourceJobs` 各持一个槽，两者都把生命周期登记给宿主。代价如实记着：宿主侧可同时存在两条 novel 任务（`maxConcurrentJobsPerOwner` 缺省 10，够用），而浏览器半「任何任务在途即禁用」那条判据只管两个写任务。
- **`SearchJobs` 比写任务多持有一件事：整轮结果 + 游标**（宿主只有一个 `detail` 字符串，装不下 642 家源的分组命中）。三条上限都是在这里定的，不在浏览器半：**只留最近一轮**（新提交即替换上一轮，上一轮若在跑则协作式收手并结算 `killed`）、每源 hits 截 `SEARCH_HITS_CAP_PER_SOURCE`（50）、结束后 `SEARCH_JOB_RETENTION_MS`（30 分钟）内可读，**过期读作「无任务」而不是空结果**（不把过期伪装成「搜了没命中」）。
- **SSE 不引入第二套状态**：`SearchJobs.subscribe(listener)` 只发「本轮变了」的信号，**不带数据**——每条连接自己带游标 `snapshot(cursor)` 取增量，所以推送帧与快照查询共用同一份合并代码、同一个 `phase !== running` 判据。任一时刻只有一条通道在推进游标（两条同时在飞会把同一批命中累加两遍），这条约束归客户端（`client/search-job.ts` 的「流在就不问，流断才轮询」）。信号口在 `end()`（终态）也要响一次，否则关不掉流。
- 任务态**只在内存**：DSH 重启即丢（`status()` 返回 null，UI 回落空闲态）；但源已按批落盘，导入本身幂等可重跑，故不做任务持久化。
- 导入管线：逐文件 `JSON.parse(stripBom(text))`，坏文件记 `fileErrors` 继续，其余照常；`Array.isArray` 摊平后逐条交 `SourceIntake`。**导入不探针**——新源一律 `unverified`，验证归批量验证任务（并发 5 路，对齐 `searchParallel` 的限流敬畏）。
- `issues` 截断 200 条（内存不膨胀），**计数字段不受截断影响**。
- 批量验证的 worker 每条**重查注册表**：任务运行期间源可能被删，取不到就点名跳过，不产生 `TypeError` 垃圾失败。
- 跳过 642 条源的逐条同步探针是本设计的出发点：原链路每条 persist 全量重写 sources.json + 逐条串行网络请求，每 20 条要等几十秒。

### 5. 请求组装（`services/request.ts`）——选项语义的唯一主人

`assembleRequest(template, vars, baseUrl, opts)` → `RequestPlan`。这里一次性解释完：

- **切分**：`,{`（允许逗号两侧空白——legado `paramPattern` 是 `\s*,\s*(?=\{)`；真实源大量写 `, {...}`，此前不许空格会把选项串并进 URL，POST/charset 选项成片失效）。选项 JSON 严格优先，失败回退单引号交换（`{'a':'b'}` 真实源大量存在）；`headers` 支持字符串双重编码。
- **选项解析不了 → 整串当纯 URL**（诚实失败于请求层，不半途猜结构），但 **`console.warn` 留痕**——静默改语义（GET 打向含 `,{...}` 的地址）极难排障。
- **method 判定**：`(option.method ?? 'GET').toUpperCase() === 'POST'` 才 POST，其余一律 GET。
- **body 插值**：`option.body` 同样过 `interpolateUrl`。
- **POST 表单默认头**：有 body 且 headers 里没有（任意大小写）`content-type` → 补 `application/x-www-form-urlencoded`。不补的话 Node fetch 发 `text/plain`，PHP 类表单端点 `$_POST` 解析不到字段（帝国 CMS 搜索收空关键词返回空页）。
- **charset** 进计划，解码优先级高于 Content-Type 与嗅探。
- **相对 URL 按 baseUrl 绝对化**；`baseUrl = null` 不做绝对化（`@js` 的 `java.ajax` 形态：URL 由脚本自己拼好）。
- **`trimFirstPage`**：Native 分页语义——模板以 `/{{page}}` 结尾且首页 → 裁掉页码段（带 `/1` 的站点直接 404）。

`fetchInitOf(plan, baseHeaders)` 是 init 姿态单点：GET **不带 method 键**（fetch 缺省即 GET）；POST 带 method 与插值后的 body；`baseHeaders`（如源级 `headerOf`）打底、计划 headers 覆盖同名。**被否决的方案**：`buildSearchRequest` 与 `engineFetch` 各写一份、靠「与对方同口径」注释同步。

`stripUrlOption(href)` 剥 URL 尾部的 `,{"webView":true}` 选项后缀（legado 嗅探语义）：只认「逗号 + 完整 JSON 对象收尾」，正文里的 `{a,b}` 不误剥。本插件不支持 WebView——剥掉后缀让普通请求照常尝试，而不是 URL 解析必炸。**现仅详情页书 URL 一处用它**（`reading.getDetail`）：章节 / 下一页 URL 已改为落库保留选项（见下节「章节 URL 保留 `,{option}` 后缀」），比对口径另有 `canonUrl` 剥选项归一。

### 6. 守门 fetcher（`services/fetcher.ts`）——唯一出站口

`createFetcher` 收口三件事：超时（`AbortController` + `Promise.race`，缺省 15000ms，可按次覆盖）、网络层异常、HTTP 非 2xx——分别类型化为 `FetchError`，**绝不把未分类异常漏给上层**。

- **缺省请求头**带浏览器 UA / Accept / Accept-Language：Node fetch 默认不带 UA，站点 WAF 按 UA 过滤直接 403（实测 26 源）。调用方显式声明的同名头优先。
- **代理**走 undici 的 `ProxyAgent`（`dispatcher`）：Node 的 fetch **不读系统代理**，有代理才通的站点直连会被 302 / 重置——「浏览器能开、读者打不开」的类型错位由此而来。判定优先级见 `services/proxy.ts`。
- **解码链**（`decodeBody`，禁默认 UTF-8 硬解）：⓪ 声明覆盖（searchUrl 选项 charset）→ ① Content-Type charset → ② 缺位且内容（去 BOM/前导空白后）以 `<!doctype`/`<html`/`<head`/`<?xml` 开头 → 前 1024 字节 latin1 嗅探 `<meta charset>` / `<meta content=…charset=…>` → ③ 兜底 UTF-8。**声明的 charset iconv 不认识 → `DecodeError`**（宁可报「这页编码解不出」，不拿乱码冒充正文）；空串 charset 声明视为缺位（真实源存在 `charset=` 空值），不炸。
- `fetchTextPage(fetcher, url, init, declaredCharset)` 是「抓取 + 解码 + 落地地址」的单点，超时归 fetcher 自身（**被否决的方案**：`fetchTimed` 在 fetcher 之外再竞速一个**不 abort** 的定时器，两套超时并存、错误文案却一字不差）。
- `headerOf(source)`：源静态 `rules.header` 打底 → 非 expired 的 `auth.headers` 覆盖同名 → Cookie 段合并（静态段按名去重、auth 名占优并在后）。

### 7. 搜索面（`services/search-face.ts`）——探针与聚合搜索共用一条请求语义

`fetchSearchPage(source, keyword, fetcher, timeoutMs)` 是「发一次书源搜索请求并取回条目」的唯一实现，page 固定 1（搜索面无翻页）：规则缺失判定 → `resolveSearchTemplate`（`@js:`/`<js>` 沙箱求值 + `{{…}}` 按 JS 预求值，纯变量占位原样留给 `interpolateUrl`）→ `assembleRequest`（Native 时 `trimFirstPage`）→ `fetchTextPage` → 列表规则求值 → `extractItems`。返回 `landedUrl`（跟随重定向后的 finalUrl）——**规则求值与相对链接一律以落地地址为基准**，与目录 / 正文面同口径（重定向站点不再错位）。

错误策略：抓取 / 解码 / 沙箱错误**上抛**（调用方各自 catch，用 `searchErrorCodeOf` 归类）；**规则缺失是结果**（`{ok:false, code:'RuleMissing'}`），因为两个 adapter 都把它当正常分支而非异常。

**聚合编排也只有一份（`services/reading.ts`）**：`searchProgressive(keyword, {sourceIds, onGroup, shouldStop})` 是批循环的唯一主人——`onGroup` 按**完成序**逐源交付（谁先求值完谁先出），返回值仍按**参搜源序**排列。`search()` 是它的薄壳（收齐全部命中），HTTP 面与 `novel_search_books` 工具都走这一份；`startSearchJob()` 是第三个消费方（同一个循环，换 `onGroup` 交给 `SearchJobs.emit`、`shouldStop` 交给它的协作式取消）。**这一侧不许出现第二个批循环**——浏览器半那套分批只为拿增量与进度条而存在，2026-09 后台化落地时已随之下线（口径见 `docs/design/client.md` 的「搜索」节）。

### 8. 探针（`services/probe.ts`）

真发一次搜索请求，关键词按 `PROBE_KEYS = ['书','小说','的']` 逐词重试——单字「书」在个别站被搜索程序停用（实测 aijjxs 对「书」0 命中、其余词 1 命中）。**只有「请求成功但 0 命中」才换词**；网络 / 规则异常立即返回，不多打请求。`ruleBookList ≥1 条目且首条 ruleBookName 非空` → `verified`，否则 `broken` 并如实透出（引擎错误 message 已含段级定位）。书名求值的 `usage` 必须与搜索面一致（`'value'`）：规则以属性终端收尾（`@title`/`@onclick`/`@_src`）时两种用途结果不同——探针曾按缺省 `'list'` 求值，把搜索面读得出书名的源判成「首条书名为空」的坏源（2026-09 审查修，钉子 `tests/services/probe.test.ts`）。CONTEXT.md「搜索面」的「探针与聚合搜索共用一次请求语义」全靠这一条成立。

**探针与搜索同一个耐心值**：`opts.timeoutMs` 缺省走 `ReadingService.searchTimeoutMs`，门面 `probe()` 显式传入。「配了 5s 就都是 5s」是既有承诺——修复前门面 `probe` 漏传，落回 fetcher 固定 15s。

### 9. 缓存（`services/cache.ts`）与落盘（`services/storage.ts`）

`PageCache` 把目录与正文写成 `cache/toc/<sourceId>-<safeKey>.json`、`cache/content/<sourceId>-<safeKey>-<idx>.txt`，每次 `set*` 后 `prune()`：两目录总字节超上限（缺省 200MB）→ 按 `mtimeMs` 升序删到 ≤ 上限（**LRU 近似**，不维护访问计数）。`safeKey` = `encodeURIComponent(bookKey)`；超 100 字符改前 60 字符 + `~` + sha1 前 10 位（确定性，规避文件名长度上限）。

落盘只有一条低层路径 `writeFileAtomic`：tmp + rename，**并按文件名排队串行**——并发 rename 同一目标在 Windows 上会 EPERM（实测 642 源并发导入时 25 次炸在 sources.json rename）。`writeJsonAtomic` 与 `PageCache` 共用它（历史分叉：PageCache 曾自抄一份无排队的 writeAtomic，阅读 + 导出并发抓同章实测 30/80 EPERM→500）。入队必须先于任何 `await`（含 mkdir），否则「最后写的最后落盘」不成立。

`readJson` 严格区分两种「读不到」：**ENOENT → fallback**（首启无 sources.json / shelf.json 是常态）；**存在但解析失败 → 备份 `.bak` + 日志 + 抛 `CorruptJsonError`**。绝不折叠成 fallback——那会让下一次 `edit` 用空表覆盖整文件，642 条源无告警消失。

### 10. 书架与书目字段集（`services/shelf.ts` + `shared/wire.ts`）

`shelf.json` 常驻内存镜像，写盘走 `createDebouncedWriter(100)` 防抖（进度高频更新只落最后一次）。

**书目元数据字段集的唯一主人是 `shared/wire.ts` 的 `SHELF_META` 表 + `pickShelfMeta`**：7 个字段（`sourceId`/`title`/`author`/`coverUrl`/`intro`/`lastChapterName`/`totalChapters`）的「名称 × 类型判别 × 归一化」只准活在这张表里。三个消费方都从它派生——`Shelf.applyPatch` 遍历表做保值覆盖、`shelfBody`（客户端 body 构造）走 `pickShelfMeta` 整理形状、`dispatch.shelfPut` 把未知 JSON body 归一化。**加一个书目字段 = 只改这张表**（`Shelf` 与 dispatch 零改动）。**被否决的方案**：逐字段 `typeof` 筛键的各处抄本。

- `bookKey`（身份）与 `progress` / `addedAt`（系统字段）不属于元数据写口，**不进表**。
- `pickShelfMeta` 的口径：类型不符 / null / undefined / 未知键一律缺席；`totalChapters` 取 `Math.max(0, Math.floor(v))`，非有限数缺席；**空串保留**——「title 非空才加书」的分叉判别归调用方（`dispatch.shelfPut`）。
- 两种元数据写口：`add` = 不在架才插入、已在架即 **patch 语义**；`update` = 对在架书打补丁、不在架返回 `null`（不静默造书）。两者共用 `applyPatch`：**缺席 / 空值键跳过（保值），带值键覆盖**——新书构造也走同一函数，可选元数据缺席不落键。**被否决的方案**：`{...existing, ...input}` 展开——`: undefined` 的自有键会抹掉已有元数据。

### 11. 规范值与缺键投影（`tools/project.ts`）

**wire 口径**：空值字段一律 `| null`（JSON 里 null 是在场的值），只有「可能整键缺席」的字段（时间戳、`statusDetail` 之类）保持 `?:`（`JSON.stringify` 会丢 undefined 键）。**这不是工具面的口径**。

**工具面口径**：`project()` 把规范值里 `null` / `undefined` 的字段**整键省略**（数组逐项、对象递归、原值不动，纯投影不改输入）。理由是 harness 对工具输出做 lossless-JSON 校验，`undefined` 属性值一票否决（整个工具调用报 "value is not lossless JSON"，真实结果被吞掉）。**这是 harness 约束下的职责，不是 wire 口径**——此前五个工具的 `execute` 各自手抹六处，纪律靠抄。

代价如实记录：投影**改变类型**（可空字段变为缺席），故出参类型由调用方断言；schema 侧一致性由 `tests/tools/schema-contract.test.ts` 钉住（execute 输出过 harness 同款校验）。但**注意这条钉子的成色**：schema 属性集只有 **shelf 那一条**是从 `SHELF_META` 表真派生出来的（`schema-contract.test.ts` 的「这一条**从 wire 的 SHELF_META 表派生**」用例），其余四份是**手抄快照**——wire 改名时它们不会自动报错，需人工同步（机构上无法从擦除后的 TS 类型反推）。

### 12. 本地书身份 `__local__`（`services/localbooks.ts` + `shared/wire.ts`）

`LOCAL_SOURCE_ID = '__local__'` 的**唯一主人是 `shared/wire.ts`**（跨半契约常量）：client 半与测试直接 import，服务半 re-export 保留既有路径——**不再有第二份声明**。为什么服务半可以有第二份而这里不许：client 纯度门拦不住服务半（`services/types.ts`、`reading.ts` 本就在引 shared），所以服务端那份从来不是构建约束逼出来的。

- bookKey 形态 `local:<uuid>`，`BOOK_KEY_RE` 严格 uuid 校验**兼防路径穿越**。
- 本地解码链与 fetcher 不同（`decodeLocalText`）：BOM 优先 → **UTF-8 `fatal:true` 严格探测** → GBK 回退。不复用 `fetcher.decodeBody`——它的兜底是 UTF-8，GBK 文件会乱码；本地文件也没有 Content-Type。`Buffer.toString('utf8')` 会把非法字节静默换成 U+FFFD，故必须用 fatal TextDecoder。
- 原文落盘（重解码路径保留）+ 元数据 JSON（含章节字符偏移表 `ChapterSpan[]`）；读取按偏移切片，**解码全文内存 LRU 上限 3 本**（Map 迭代序即 LRU 序）。退化 span（相邻标题行 / 文末孤标题）`start > end` 时夹紧边界，保证只切出 `''` 而非负长度。
- `__local__` 的书在门面内分流：`getToc` / `getChapter` 见 `sourceId === LOCAL_SOURCE_ID` 走本地书面、**不查注册表**；路由层零 LOCAL 知识。「删书不留孤儿文件」的 invariant 也归门面 `removeBook`（本地书连带删文件 + 删书架条目）。

### 13. 整本导出（`services/export.ts` + `api/dispatch.ts`）

`exportBook` 是异步生成器：BOM 开头（Windows 记事本兼容）→ 逐章 `getChapter`（**缓存优先语义即天然断点续传**）→ 每章后 `sleep(delayMs)`（N-1 次，最后一章不睡）。**限流敬畏是第一原则：绝不并行抓章**。两个停止条件都落在生成器内：单章抛错 → 输出 `[导出中断于第 k 章《名》：原因]` 后 `return`（失败即停，重跑只补缺章）；`signal.aborted` → 直接返回。

路由侧：toc 为空 → 首包前走错误信封（422 `EmptyToc`）；否则发 200 + `X-Novel-Total-Chapters` 后逐块写。`res.on('close')` → abort（浏览器关页 / 取消即停抓取）。背压等待 `drain` **前先查死连接**——destroyed 的响应不会再发 `drain`，挂等会吞掉断连取消。200 头已发后异常**不能走 `writeError`**（二次 writeHead 报 `ERR_HTTP_HEADERS_SENT`），就地补中断标记。

### 14. wire 契约（`shared/wire.ts`）

**25 条路由**（20 条静态 `ROUTES` + 5 条参数 `paramRoutes`），**计数由 `tests/shared/wire-builders.test.ts` 钉死**——此前的「17 条路由」注释既腐烂又无测试。`route(...segs)` 同时给出 `path`（客户端 fetch 用）与 `segs`（服务端段匹配与一致性测试用），同一构造保证一致。`SEG` 是路由段的唯一字面量来源，`PARAMS` 是 query 参数名的唯一字面量来源（此前参数名散在 dispatch 与四个 client 文件里各写一份，改名无处编译报错；`SearchView` 曾手拼 `shelf/${...}` 绕过 `paramRoutes`——活漂移）。

**统一信封**：成功 `{ ok: true, value }`，失败 `{ ok: false, error: { code, message, segment? } }`。`segment = { facet, segmentIndex, segmentRaw }` 是**段级定位**——错误定位到出错的规则段，而不是产出错误的结果。

**后台搜索任务的读面形状**：`SearchJobSnapshot`（`id / keyword / phase / total / done / added / next / startedAt / finishedAt? / error?`）+ 两个上限常量 `SEARCH_HITS_CAP_PER_SOURCE`（每源 50 条）、`SEARCH_JOB_RETENTION_MS`（结果保留 30 分钟）。`cancelled: boolean` 是**给用户按「停止」准备的**：本轮立即 `phase=failed` + `error=任务已取消…`，但 UI 判「这是用户停的不是搜挂了」只认这个字段，不去比那句中文（刷新后重读同一轮也要能分清）。`phase` 与写任务的 `JobState.phase` 同一套词汇，所以 UI 的「还在跑吗」判据（`!== 'running'`）只有一种写法；`added`/`next` 是官方要求的可恢复游标（baseline / cursor / 显式 query 里的 cursor）。整轮结果本身**不上 wire**——那是服务层持有物。

**错误→HTTP 两分法**（不是「状态映射只许一处」）：

1. **domain / 引擎错误**：类 → `ErrorCategory`（`services/errors.classify` 单点）→ `STATUS_OF` 表 → 状态码 / 错误码。引擎三类与抓取两类用 `e.name` 当 wire 错误码；`RuleMissing` 在 HTTP 面与搜索面 / 探针是同一词汇。
2. **路由层自检错误**：`ApiError(message, status, code)` **自带 status/code、不进分类学**，直通（405 方法不允许、404 未知路由、400 body 校验、403 非受信来源、400 非法百分号编码……）。

分类权在**类型**上，不在中文文案上（`message.startsWith('源不存在')` 是历史形态：改错别字即改 HTTP 状态码）。路由侧不允许再 inline `writeJson(res, <状态码>, …)`——那会成为第三面。

**同源校验**（`api/wire.ts` 的 `isTrustedRequest`）：只放行 loopback 且（无 referer 或 referer 与 host 同源）且（无 origin 或 origin 与 host 同源）的请求。**无 referer / 无 origin 放行**是本机工具与 curl 的承诺；看 `Origin` 而不只看 `Referer` 的理由：恶意页可以 `<meta name="referrer" content="no-referrer">` 让 Referer 缺席，但浏览器对跨源 POST **总是**发 Origin——「Origin 存在且跨源」必须拒，否则 `content-type: text/plain` 的 simple POST（不触发 preflight）可 CSRF 打 import / batch / auth。

`readJsonBody` 的钉死：空 body → fallback；超限 → **413 只 throw 不 destroy**（destroy 会断 PassThrough 流）。`/sources/import` 单独把上限放到 32MB——真实 legado 多源导出常见数 MB（实测用户文件 4.8MB/642 源），默认 1MB 会把最大流量的包挡在门外。

## 数据流与时序

```
浏览器 / agent 工具
   │  queries.* / shelfBody.*（构造器归 wire，参数名与字段取舍同源）
   ▼
HTTP: POST/GET /novel-api/**         工具: novel_* → project() 缺键投影
   │  isTrustedRequest → readJsonBody → 段匹配（SEG / paramRoutes）
   ▼
api/dispatch.ts  ── 只做「传输关注点」：方法守卫、body 形状校验、信封、导出节流
   │  （业务判据一律抛给门面：本地书分流、loginUrl 形态、任务互斥、启停 invariant）
   ▼
services/reading.ts（ReadingService）── 唯一业务入口，部件装配后即 private
   ├─ SourceRegistry（edit 原子变更 + 内部合并落盘）
   ├─ SourceIntake ── normalizeSource（三方言 → NormalizedRules）
   ├─ SourceJobs（单任务槽）── probeSource ── fetchSearchPage
   ├─ Shelf（SHELF_META 派生的保值补丁）+ PageCache（LRU）
   ├─ LocalBooks（偏移表 + 解码 LRU）
   └─ Fetcher（唯一出站口：超时 / 代理 / UA / 解码链）
        ▲
        └─ engineContextOf / makeSubEval ── engine evaluate（段级错误追踪、@js 沙箱）
```

- **搜索**：`searchProgressive(keyword, {sourceIds, onGroup, shouldStop})` 过滤 `enabled` 源（`[]` = 未限定 = 搜全部启用源）→ 按 `searchParallel` 分批 `Promise.all` → 每源独立 `searchOne`（catch 后只写该组 `error`，单源失败不拖垮整批）；`search()` 是收齐全部的薄壳。`searchPlan()` 是参与集判定的唯一主人（`startSearchJob` 也经它算 `total`，别处不再抄一份启停谓词）。后台任务面另有两个动词：`startSearchJob(keyword, {sourceIds})` 提交一轮（交 `SearchJobs` 持有整轮结果）、`searchJobSnapshot(since)` 按游标读增量。
- **阅读**：`getToc` 缓存优先（`refresh` 跳过）+ **in-flight 去重**（同书并发只拉一次，`tocInflight`）；`getChapter` 缓存优先 + 目录越界守卫（双边：负数与超长都拦，HTTP 面有 `^\d+$`、工具面无下限，守门必须盖住两面入口）+ 多页串接 + Miss 抛 `RuleEvalError` 不吞。
- **目录 / 正文的翻页**：`followOrSingle` 在 next 规则为 `null` 时短路单页（无翻页发现能力），否则走 `followPages`（CONTEXT.md「判到底」）。next 规则按**列表语义**求值（legado getStringList(isUrl=true)）：单候选链式跟进、多候选全部抓取不递归；停止判据 = URL 防环 → 零新增（本页 0 条）→ 回环（本页有条目但 0 新增；**部分重复不停**——此前「出现重复即停」把站点页间重叠的真实页截断）→ 上限（`tocMaxPages` 200 / `contentMaxPages` 50）。正文面串章闸：**目录知识优先**（候选「下一页」canon 后 == 目录里其他章节 URL → `chapter-boundary`；legado「下一页 == 下一章 URL 即 break」正判据）——路径启发式 `isSameChapterPage` 只在无目录知识时兜底，因为 `?id=..&cid=..&page=2` 这类非页码键分页会被启发式误拦（「一章只解析出一页」的根因之一）。
- **章节 URL 保留 `,{option}` 后缀**（legado BookChapter.getAbsoluteURL 口径）：目录落库不再 strip 选项（`absUrlKeepOption`：URL 部分绝对化、选项原文接回）；抓取时 `reading.fetchPage` 经 `assembleRequest` 单点解释选项（POST method/body、charset 进解码链、headers 合并）——API 型章节端点（POST body 模板）不再退化成裸 GET。`canonUrl` 是串章闸/防环的比对口径（剥选项 + URL 归一化）。
- **目录 URL 缺失逐章回退**：`ruleChapterUrl` 取空 → 该章地址回退**目录页地址**（legado BookChapterList「未获取到url,使用baseUrl替代」）——此前「url null → 整条丢弃」把这类源的目录清成 0 章（EmptyToc 桶的成因之一）。**但整本每一条都回退就不是缺链接，而是规则整体失效**：静默产出 N 条指向目录页自身的 toc 等于拿合法形状冒充成功（本仓镜像的宁炸不猜），故 `extract` 收口处判 `fellBack === out.length` → 抛 `RuleEvalError` 点名 `ruleChapterUrl` 与回退条数（2026-09 审查；钉子 `tests/services/reading.test.ts` 成对——混合形态仍逐章回退，不许改回整条丢弃）。
- **零命中不得静默**：正文规则取到空文本 → 抛 `RuleEvalError` 并带落点（请求地址 → 实际落地地址，两者不同即说明被跳转走了），**不写缓存**；缓存读取时空正文一律当未命中（旧版曾把站点跳转落地页的零命中写成 0 字节缓存，27 章全空到无感）。目录 / 正文规则缺失同样不降级 `?? ''`（空串规则会把整页文本当正文），宁炸不猜。
- **正文取值收口**（`services/content.ts`，legado HtmlFormatter 对齐）：HTML → 纯文本时 **img 保留为地址行**（`<img src>`/`data-src` → 独立行，漫画/图片章节不再整章零命中）；藏在 `<noscript>` 里的 img 同样取回——domhandler 把 noscript 内容按 raw text 解析（`find('img')` 为 0），下钻那层文本等于把字面 `<img src="…">` 当正文吐给读者，故正文面把那层文本**再解析一次**再走行规约（`engine/dom.ts` 的 noscript 分支）；非 HTML 形态含预转义实体时白名单解码（`&nbsp;`/`&#8220;` 等，未知实体原样——不猜）；**解出来仍像 HTML 就在同一趟转成纯文本**——`&lt;p&gt;…` 这类预转义正文若只解码不收口，产物就带标签，违反「产物不含标签」的幂等前提，而 `reading.getChapter` 对缓存还要再收一次口，第二趟会把段落当标签吞掉（同一章在缓存前后长得不一样的根因）。
- **值规约（服务层侧）**：引擎的 `EngineValue` 到服务层字符串只有两个出口——`firstValue`（单值：miss→null、value→text、list→`join('\n')`、matches→每行首列）与 `extractItems`（列表页条目：nodes→逐节点 HTML 片段、list→逐项、matches→行 `join('\t')`、miss→`[]`）。`nodes` 落到单值出口是错误而非数据，抛带 facet 与节点数的 `RuleEvalError`（`segmentIndex = -1` 表示服务层规约层，不是规则某一段）。空态裁决口径见 `CONTEXT.md`「取值规约」（取位失败 → Miss；解析到空集合 → 空 List），唯一实现在 `engine/select.ts` 的 `reducePicked`——服务层不复制这套判定，只消费结果。

### 工具面与 HTTP 面共用 service 层的证据（不存在第二套实现）

- `tools/tools.ts` 只 `import type { ReadingService }`，全部 `execute` 都是 `service.search / getToc / getChapter / importSource / probe / shelfList` 的调用 —— 没有任何一处自己发 fetch、自己读 `sources.json` / `shelf.json`，也没有第二份规则求值。
- 探针的耐心值、入库规则（`SourceIntake`）、越界判定（`ChapterNotFoundError`）都在服务层单点：工具面 `novel_read_chapter` 只调 `getToc` + `getChapter`，越界报错由服务层抛；`novel_add_source` 只做「JSON 文本 → `importSource` → `project`」。
- 唯一由工具面**自己**拥有的语义是「缺键投影」（`tools/project.ts`）与各工具的 render 文本投影——因为它是 harness 输出 schema 的约束，不是业务语义。规范值（`service` 返回的完整 JSON）在投影前不被裁剪，render 只是规范值的文本投影。
- 反向验证：`tests/api/routes.test.ts` 断言 `SEG` 每一段都被某条路由用到（无孤儿段、无手抄段）。而工具 schema 侧的对应断言**只有五分之一是真绑**（见 §11）——`schema-contract.test.ts` 里除 shelf 外都是手抄快照。

## 构建、装载与验收

**`lib/` 是构建产物且不入库**（`package.json` 的 `files` 只含 `lib` / `cordis.patch.yml` / README / LICENSE；`main` 指向 `lib/index.js`）。构建是 `tsdown` 双配置（`tsdown.config.ts`）：host 半 ESM + dts，client 半 CJS 单文件闭合工厂（`window.__ModuleLoader__.load({ id: '@xrn1997/dsh-novel', factory: … })` 三段式 banner/intro/footer）。client 半带**构建期纯度门**：Node 内建与平台模块表之外的 `@deepseek-ai/*` 值 import 一律构建失败——这也是 `shared/wire.ts` 必须零运行时依赖、只许 type-only 依赖的原因（client 半会把整个文件 inline 进 bundle）。

缺失 `lib/` 的报错形态：`dsh: plugin tree failed to load` + `ERR_MODULE_NOT_FOUND` 指向 `lib/index.js`——**整个插件树拒绝挂载（`dsh web` 直接启动失败），不是静默降级**。

三种安装路径的差异必须记住：

- **npm 安装**（`dsh plugin add @xrn1997/dsh-novel`）走预构建产物，秒装、无需构建授权。
- **GitHub 源码安装**（`add github:xrn1997/dsh-novel`）由 `prepare` 脚本（= `tsdown`）自动构建；pnpm ≥10 首次安装可能报构建脚本被拦截（依赖已装但 `lib/` 未生成），需先在 profile 目录 `pnpm approve-builds --all` 再重跑安装命令。
- **本地目录 / `link:` 安装**（`add link:<path>`）**pnpm 只建目录链接、绝不在对端跑 `prepare`**——必须在源码目录手动 `pnpm build` 一次，否则 `dsh web` 起不来。

**`pnpm test`（常规集）覆盖什么**：引擎规则求值、服务层语义、API 路由与信封、工具 schema 契约、Cordis 入口、前端逻辑与 smoke（`vitest.config.ts` 排除 `tests/compat/**` 与 `tests/packaging-build.test.ts`）。**不覆盖什么**：任何真实站点可用性、真实安装链路、构建产物自检——它只用注入的假 fetch 与合成 HTML。

**三条默认关闭的真链路门控**（`describe.skipIf`）各自的承诺边界：

| 门控 | 跑法 | 承诺边界 |
| --- | --- | --- |
| `DSH_REPROBE=1` | `pnpm vitest run tests/reprobe.test.ts` | 对 `sources.json` 全量真发搜索请求，得出**当前网络 + 当前源集**的 verified 率与失败分布。真实访问网络、数分钟量级；结论随时间与代理环境漂移，不是回归断言。 |
| `DSH_CONTENT_AUDIT=1` | `pnpm vitest run tests/content-audit.test.ts` | 对 `sources.json` 全量跑**搜索 → 目录 → 正文（多章采样）**全链路（enabled 全置 true——审计问「链路通不通」，不问启停），逐源按 stage + 错误类分桶，报告落 `.superpowers/content-audit/`（过程产物不入库）。**「verified」只证明搜索面**——正文可用率以本审计为准，注意它是**报告不是通过率门**：分桶读数给人判，代码只断言每个注册源都进了 stage（漏审即红）。真实访问网络、十几分钟量级。 |
| `COMPAT_CAPTURE=1` | `pnpm vitest run --config vitest.compat.config.ts tests/compat/capture.test.ts` | 把真实站点抓成 fixture 快照（脱敏两刀后落盘）。采集与回放**必须同关键词**（manifest 已记）；GBK 源 v1 直接失败（fixture 只存 utf8 原文，不静默转码）。 |
| `DSH_INSTALL_CHECK=1` | `pnpm vitest run tests/packaging-install.test.ts` | 真跑 `dsh plugin add`（一次性 profile `novel-smoke`）→ 断言 bundles 挂载 + `lib/client.js` / `cordis.patch.yml` 就位 → remove。测试自己先 `pnpm build`，忠实复现「源码目录装入」流程。 |

`pnpm test` 全绿 = 引擎 / 服务 / 契约 / 前端逻辑成立，**不等于**任何真实站点可用，也不等于安装链路成立。

**compat 回放的分母口径**：`compat/report.md` 的「跑通率」分母是 `compat/fixtures/` 下的 fixture，当前树只有 1 条手写合成 fixture（`demo-site`，域名 `demo.local` 不存在）——它是**规则引擎离线回放的回归基线**，**不代表任何真实站点兼容率**（不覆盖真实 HTTP / 重定向 / GBK / 超时 / 反爬 / `@js` 真实宿主）。`compat/sources/` 目前为空；站点可用率请用真机重探（`DSH_REPROBE=1`）或投放真实源后走「投放 → 采集 → 复算」三步闭环。

**验收口径（原 v1 设计文档 §4.6 的条款；那份文档已出库，此条仍成立）**：**compat 回放跑通率是 v1 的验收标准本身**——本目录把「率」变成可一键复算的数字。与之并列的两条：常规门禁 `pnpm test` + `pnpm typecheck` 全绿，以及真安装链路 `DSH_INSTALL_CHECK=1` 通过（DoD#1 属**人工验收**，自动化对应物就是这条门控）。注意验收标准是「率可复算 + 分母口径讲清」，不是「率等于 100%」——当前分母只有合成 fixture，真实站点兼容率需要投放真实源才能谈。

## 测试钉子短表

| 测试文件 | 钉死什么 |
| --- | --- |
| `tests/shared/wire-builders.test.ts` | 路由计数 20 + 5、`LOCAL_SOURCE_ID` 持久化值与跨半同源、`encodeQuery` / `queries`（含 `searchJobStatus(since)` / `searchJobStream(since)` 同一条游标）、`searchJobCancel` 的 path/segs/ `shelfBody` 的参数名与字段取舍、`SHELF_META` 键集、`pickShelfMeta` 判别与归一化、shelf 路径必须走 `paramRoutes.shelfKey` |
| `tests/api/routes.test.ts` | `ROUTES` → 真实 dispatch 落点逐条；405 / 404 / 400 三态；local part 缺席 → 503；`SEG` 无孤儿段 |
| `tests/api/wire.test.ts` | 同源 fence 四态；`readJsonBody` 的 400 / 413；`errorStatusOf` 全类目映射与 segment |
| `tests/api/dispatch-sources.test.ts` | 导入任务 → jobId → job-status → done；结果保留；409 JobRunning；旧同步路由 405；body 校验；大包不 413 |
| `tests/api/dispatch-reading.test.ts` | search / book / toc / chapter 落点与 400；**search/job 面：提交/快照/SSE/取消四条路由的方法守卫、keyword 与 sourceIds 校验、终态快照形状、`since` 游标语义（超前夹到末尾、非法当作 0）、只留最近一轮；SSE 帧体=同一份快照、只含本轮、终帧后服务端关流；`POST search/job-cancel` → `{cancelled}`，取消后本轮分组仍整轮可读、二次点击是空操作**；shelf 三形态 PUT 与 `patch` 单字段回写；`sourceId` 必填；progress 值域 |
| `tests/api/dispatch-local.test.ts` | 本地导入自动加书架（`sourceId=__local__`）、GBK 回显、400 / 413、删书连带删文件 |
| `tests/api/dispatch-export.test.ts` | 流式头（BOM / Content-Disposition / X-Novel-Total-Chapters）与两章正文；toc 失败走错误信封（非流） |
| `tests/services/intake.test.ts` | 入库四裁决（added / replaced / skipped×2）与替换复用 id、清同键残留、`dedupKey` 口径 |
| `tests/services/sources.test.ts` | `edit` 原子性与合并落盘（不 flush 磁盘未写、20 次阈值强制落盘、并发 edit 不交错、recipe 抛错仍标脏）；`toPublic` 凭据红线；load 四条存量归一 |
| `tests/services/import-job.test.ts` | 单槽互斥与结果保留、issues 截断 200、坏文件不拖垮、导入不探针、批量验证并发 ≤5 与运行中删源；**宿主登记三钉**（kind/label、取消 → 宿主结算 `killed`、自然收尾 → `completed`） |
| `tests/services/search-job.test.ts` | 游标增量读面（`added`/`next` 跟着走、超前只给空增量不报错）、**subscribe 事件口（新一轮 / 每次 emit / 终态各响一次、退订后不再打扰）**、每源命中截断而 `done` 计数不受截断影响、只留最近一轮（新提交替换旧的、旧的读不出来）、结束过保留期读作「无任务」不伪装成零命中、`cancel` 立协作式旗并落 failed 带原因、宿主登记 kind `novel-search` 与 `completed`/`killed` 两种结算；**停止的另一半**：`cancel()` 置 `cancelled` 后已 emit 的分组照旧整轮可读、再点为 `false` 空操作 |
| `tests/services/reading.test.ts` | 搜索分组与空数组语义、重定向按落地地址、目录两页翻页闸与缓存、正文规约与零命中报错不写缓存、**目录 URL：逐章回退保留但整本全回退 → `RuleEvalError` 点名 ruleChapterUrl**、ruleDetail* 回退、`__local__` 分流、防孤儿删书、探针同耐心；**`searchProgressive` 的增量出口与 `shouldStop`（批头收手 / 条目头跳过该源）** |
| `tests/services/probe.test.ts` | 逐词重试与 broken 口径、规则缺失是结果、charset 解不出 `DecodeError`、超时覆盖、**书名 usage 与搜索面一致**（`ruleBookName` 以属性终端收尾时不误判 `broken: 首条书名为空`） |
| `tests/services/search-face.test.ts` | 条目提取 + landedUrl、规则缺失结果形态、按次超时、POST 选项透传、错误码投影 |
| `tests/services/request.test.ts` | 选项切分（含逗号空格、单引号 JSON、双重编码 headers）、POST 表单默认头、charset 透传、相对 URL 绝对化、`trimFirstPage`、`stripUrlOption`、`@js` 模板三形态 |
| `tests/services/fetcher.test.ts` | 非 2xx / 网络 / 超时 → `FetchError`；代理 dispatcher 有无；缺省 UA 与调用方覆盖；解码链四优先级 + 空串声明；`headerOf` 的 Cookie 合并 |
| `tests/services/cache.test.ts` | toc / content 往返与按章隔离、prune 按 mtime 淘汰、`safeKey` 长短形态 |
| `tests/services/storage.test.ts` | `novelDir` 两态、原子写无 `.tmp` 残留、并发写串行、损坏文件抛 `CorruptJsonError` + `.bak`、防抖合并 |
| `tests/services/shelf.test.ts` | add 往返与 patch 语义（缺席键保值、显式 undefined 不抹值）、progress 防抖、不在架 `null` |
| `tests/services/localbooks.test.ts` | 解码链四态、切章正则诸形态、`local:` 形态防穿越、LRU 3 本、越界明确报错、零内容章不产生负长度 |
| `tests/services/pagination.test.ts` | URL 防环 / 零新增 / 回环（整页零新增）/ 上限 / 串章（stopUrls 目录知识**取代**启发式——两闸同供时启发式不参与，非页码键分页照常跟进）/ next 列表语义（多候选不递归）/ 页间部分重叠不停 逐一 |
| `tests/services/chapter-page.test.ts` | 同章后缀形态、下一章拦下、标准页码查询放行、判不准拦下 |
| `tests/services/url-option.test.ts` | `,{option}` 后缀切分（严格/单引号 JSON、正文 `{a,b}` 不误剥）、`absUrlKeepOption` 绝对化接回、`canonUrl` 比对口径 |
| `tests/services/content.test.ts` | `looksLikeHtml` 白名单（纯文本正文不误伤）、`htmlToText` 块级换行与脚本/样式整树丢弃、`contentToText` 的 **img 保留为地址行 / noscript 内 img 取回地址而非字面标签 / 预转义实体就地解码且未知实体原样**、**幂等：产物不含标签，二次收口必直通（含 `&lt;p&gt;` 预转义 HTML 串）** |
| `tests/services/export.test.ts` | N-1 次节流与章格式、失败即停无后续请求、abort 零请求、toc 抛错透传 |
| `tests/services/error-taxonomy.test.ts` | 每个错误类的类目 / HTTP / ProbeErrorCode 三投影；新类目忘进表编译期报错 |
| `tests/services/normalize.test.ts` | 三方言映射、必填校验、warning 口径、`bookSourceType` 拒绝非文本、分组拆分与图标剥离 |
| `tests/tools/schema-contract.test.ts` | execute 输出过 harness 同款校验；schema 在 harness 强制子集内；wire 绑定只对 shelf 成立（表派生），其余四份是手抄快照 |
| `tests/tools/tools.test.ts` / `project.test.ts` | 五工具名与输出形状、注册与 disposer、投影的整键省略与不可变性 |
| `tests/index.test.ts` | 插件身份与 Config schema、值域校验加载期失败、ready 后注册与 disposer 摘净、双重启用防御；**三类任务真抵达宿主**（假 `ctx.jobs` + 真 http 口跑 `sources/import`、`sources/batch-probe`、`search/job` → 记到 `job-start` 的 kind 恰是 `novel-import`/`novel-probe`/`novel-search`）——`create → from → SourceJobs/SearchJobs` 这条 host 传递链上任一跳丢参数，其余 1042 条仍然绿（各单测直构持有者、门面测试不传 host），只有这条红 |

## 已知开口

按「代码为准」记录与旧文档冲突处，以及需要决策的未决口径。

1. **段匹配读的是 `SEG.*`，不是 `ROUTES.*.segs`**（`src/api/dispatch.ts` 的 `import { NOVEL_API_PREFIX, PARAMS, paramRoutes, pickShelfMeta, ROUTES, SEG }`，全文段匹配用 `SEG.sources` 等）。`ROUTES.*.segs` 的**生产消费者为零**，只有 `tests/api/routes.test.ts` 的用例「SEG 每一段都被某条路由使用」用它做命名空间校验。功能等价（`segs` 本就由 `SEG` 构造，路由段字面量仍单点）——但写新路由时别以为存在第二份权威。
2. **仓库没有 CI**（无 `.github/`）：`pnpm test` / `pnpm typecheck` / 三条真链路门控全靠人记得跑，而门控默认 `describe.skipIf` 关闭。一次「只跑常规集」的提交就足以让构建产物或 compat 回放静默退化——改动抓取 / 引擎 / 打包链路时，那三条门控是**唯一**的自动化验证，别省。
3. **旧 spec 声明 `AuthRequiredError`（「需登录」错误类），实现里不存在**——`services/errors.ts` 无此类，`classify` 无对应类目。需要维护者拍板：补「需登录未配 auth」的探测启发式，还是把声明撤下（本轮未擅自发明启发式）。
4. **旧 spec 称探针返回「分段 trace」，实际 `ProbeResult` 无结构化 trace 字段**（只有 `error.message` 里的段级文本 + HTTP 面的 `segment`）。修法需先定探针输出形状。
5. **`compat/sources/` 为空、分母只有 1 条合成 fixture**：真实站点兼容率**无数字支撑**，需要真实可联网站点与人工采集（`COMPAT_CAPTURE=1` + 脱敏人工过目）。验收口径已讲清是「率可复算」，但「率」目前不代表站点。
6. **同址已 verified 的源被新导入跳过时，新条目的规则改进被丢弃**：这是「以可用者为准」的既定口径（用户拍板），不是 bug；但 UI / 工具只报 `dupSkipped`，用户若想采纳新规则需先删旧源。
7. **工具输出 schema 与 wire 的绑定只成立五分之一**：`tests/tools/schema-contract.test.ts` 的用例「② schema 属性集 ≡ wire 类型字段集」仅对 shelf 从 `SHELF_META` 派生比对，其余四份 schema 是手抄快照——wire 字段改名不会让它们报红，只能人工同步（该测试文件头注已如实声明这条局限）。
8. **已确认的刻意保留（不改代码）**：`services/request.ts` 的 `SearchRequest` 类型别名全仓零引用；`services/bridge.ts` 的 `listValue` 无生产消费者（唯二引用是测试当归约器）；`localbooks.ts` 的 `ChapterSpan` / `BOOK_KEY_RE` / `LocalImportResult` 只在模块内用；`reading.ts` 的 `tocUrlOf` / `normalizeChapterText` 注释自称「供测试/复用」但无测试 import；`normalize.ts` 的两张方言映射表的 `ruleBookInfo` 整块逐字相同（方言是两条独立演化线，强抽有 speculative generality 风险）。`request.ts` 的 `buildSearchRequest` 虽只是 `assembleRequest` 的薄壳，但 `search-face.ts` 的 `fetchSearchPage` 在用它，属历史名字兼容、保留。
9. **缺省值多份复制**：`50 * 1024 * 1024`（本地导入上限）在 `index.ts` DEFAULTS、`reading.ts` 的 `create` 与 `from`、`localbooks.ts` 的 `create` 各写一份；`15000` 在 `reading.ts` 与 `fetcher.ts` 各一份；`exportDelayMs` 的 `300` 在 `index.ts` 与 `dispatch.ts` 各一份；`readJsonBody` 的 1MiB 与本地导入的手写流式上限循环是两份字节上限逻辑。生产路径始终显式传值，改错一处不会静默改变业务规则——但这类复制正是「靠注释对齐」的温床。
10. **`tests/api/routes.test.ts` 以中文文案前缀「未知路由」为判据**（钉措辞而非结构码）：文案一改即整套误红。暂无可替代的机器可读判据——「未知路由 404」与「域 404」的错误码都是 `NotFound`。
11. **任务态不持久化**：DSH 重启后 `job-status` 返回 null，正在跑的导入进度不可恢复（已落盘的源不丢，导入幂等可重跑）。这是 YAGNI 决策，不是缺口；但「重启后 UI 显示空闲而用户以为任务还在跑」的可能性留给下一个人判断。
12. **探针 verified 只证明搜索面**：正文链路（目录/正文规则、翻页、js 沙箱语义）的可用性由 `DSH_CONTENT_AUDIT=1` 全链路审计实测（读报告分桶，非通过率门；数据点：2026-09 实测：228 源全 verified，正文全链路修复前仅 25 源全通；三轮 legado 语义补齐后见门控报告——js 段 scriptForm / 沙箱 sloppy 作用域与变量绑定 / 元素包装对象 / **java.ajax 同步语义（worker+SAB RPC 桥）** / AES 解密桥 / cache 垫片 / 取值用途与属性终端 / 模板字面段 / `text.<串>` 选择 / `@put` 裸值键访问 / AllInOne 行内标志 / 方括号索引 / `##` 尾插值 / 中链 jsonpath / 翻页闸（列表 next + 目录知识串章闸）/ 章节 URL 选项保留 / 目录 URL 缺失逐章回退（**整本全回退即如实抛错**）/ 正文 img 保留与实体解码，全部落地，语义与理由见 `docs/design/engine.md`「legado 正文链路语义补齐」）。残余失败的已知边界：`@webjs:`/`sourceRegex`/`webView:true`（WebView 面——legado 本身也只在章节 URL 带 `webView:true` 时走 WebView，属「需要登录/JS 渲染」类，与用户口径一致不计入规则引擎欠账）、`<p1,p2>` URL 页码、`contentRule.subContent`/`title`、方括号索引多条目、jsLib 用 `eval` 的源（Code generation disallowed——安全边界不降级）。网络层失败（FetchError/EmptyToc）需逐源人工甄别死站/反爬/代理，非引擎问题。
    **第二个数据点（2026-09-19 本机全量重探，`DSH_REPROBE=1`，79s 跑完）**：库已长到 **431 源**，verified **161（37.4%）**；失败分布 `FetchError 121` / `RuleEvalError 96` / `JsSandboxError 50` / `UnsupportedRuleError 3`。与上面那条「228 源全 verified」不是同一批源，也不能读成引擎退化——但 **146 个规则/沙箱类失败值得单独甄别**（同一次跑里出现多条「URL 选项不是合法 JSON，整串按纯 URL 处理」的 warn，形态是 `'单引号键` 与「JSON 后再跟 `@js:`」两类；选项失效会直接改变 method/body/charset，因而完全可能是 RuleEvalError 的上游而非站点问题）。这条不在本轮范围内改，另卡一次甄别。
13. **正文串章只有一道闸**：`pagination.ts` 的串章判定是 `stopUrls`（目录知识）**取代**路径启发式，不是叠加（`else if` 形态，接口注释与 `chapter-page.ts` 头注都写明了理由：启发式判不准时宁漏页不串章，而它误拦的 `?id=..&cid=..&page=2` 实测就是一批源「一章只解析出一页」的根因）。残余缺口如实记着：`canonUrl` 会剥 `,{option}` 后缀并按 WHATWG 归一相对地址，但**不归一尾斜杠与 query 参数顺序**——站点「下一页」若与目录条目差在这两处，`stopSet` 漏判且没有第二道闸，下一章正文会被接在本章后面。2026-09 审查复议提议「stopSet 未命中时再走收窄到路径变化的启发式」，**已否决**：收窄后仍会误拦 `/book/1/1.html → /book/1/2.html` 这类路径式同章分页（比现行更糟）。钉子钉住优先级本身（`tests/services/pagination.test.ts` 的 `it('两闸同供时目录知识优先…')`），改双闸必须先过这条钉；漏判的实际发生率只有 `DSH_CONTENT_AUDIT=1` 能出数（本轮未跑）。

14. **聚合搜索后台化已落地（2026-09）**：读 / 写分槽（§4）、结果只留最近一轮 + 每源 50 条 + 收尾 30 分钟（§4）、投递走「带游标的显式快照查询 + 同一份快照的 SSE 推送」（§4 末与 §14）。通道选自有 SSE 的理由与 `EventSource` 被否的理由都写在 `docs/design/client.md` 的「搜索」节。仍开着的只剩一件：UI 该不该给「取消搜索」钮（`SearchJobs.cancel()` 与宿主 kill 都已在位）。
