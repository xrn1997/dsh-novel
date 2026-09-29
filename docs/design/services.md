# 服务层与双半契约

本文是**服务层（`src/services/`）、HTTP 面（`src/api/`）、wire 契约（`src/shared/wire.ts`）与工具投影（`src/tools/`）的现状真相**（single source）；领域词汇见 `CONTEXT.md`——源入库、按址去重、书源注册表、启停、探针、请求组装、后台任务、书目字段集、wire 契约、缺键投影、规范值、本地书、bookKey 一律用那里的词，别自造。面向「下一个改服务层的人或 AI」：只讲口径与理由；操作步骤见 `README.md`，路由表与数据目录布局不在此重复抄。

> **现量口径**：本文凡以「现库 / 本库 N 源」形式给出的规则形态读数都是**当批读数**——**2026-09-28 按 `raw` 复核为 214 源**（status 全 verified，type 分布 text 174 / image 30 / audio 5 / unknown 4 / file 1）。分母随用户增删漂得很快，引用前先按 `raw`（原始书源 JSON）重数，别当常量读，**也别把别批的读数抄进当前声明**（纪律见 `AGENTS.md`）。

## 模块地图

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `services/reading.ts` | 阅读链路门面：HTTP / 工具 / UI 三面的**唯一**业务入口 | `ReadingService.create/from`、`search/searchProgressive/searchPlan`、`startSearchJob/searchJobSnapshot`、`getDetail/getToc/getChapter/getChapterContent/getNavigation/getLocalSupplement/getLocalResource/getLocalImportWarnings`、`probe`、`shelfList/shelfAdd/shelfPatch/shelfSaveProgress/removeBook/removeBooks`、`localImport/removeLocalBook`、`startImportJob/startBatchProbeJob/jobStatus`、`*Source*` 写侧动词、`flush`、`tocUrlOf`、`normalizeChapterText` |
| `services/sources.ts` | 书源注册表：加载 / 原子变更 / 只读投影 / 合并落盘 | `SourceRegistry.load`、`edit/flush/list/get/toPublic`、`SourceEdit` |
| `services/intake.ts` | 源入库：normalize → 批内留首条 → 按址去重 → add/replace | `SourceIntake`、`IntakeDecision`、`dedupKey` |
| `services/import-job.ts` | 后台写任务单槽（导入 / 批量验证）；生命周期登记给宿主 `ctx.jobs`（`host?: JobHost` 窄面，协作式取消） | `SourceJobs`、`JobRunningError`、`JobKind`、`ImportFile`、`JobHost`、`JobOutcome` |
| `services/search-job.ts` | 聚合搜索的**读任务**槽：Node 半持有整轮结果 + 游标增量读面，生命周期同样登记给宿主 `ctx.jobs`（kind `novel-search`） | `SearchJobs`、`SearchJobRun` |
| `services/normalize.ts` | 三方言（平铺 / 对象方言 / Native）→ 规范化规则集；规则容器可为对象或**字符串化的 JSON**（两形态走同一分支，`ruleContainer` 单点） | `normalizeSource`、`NormalizeResult`、`splitGroups`、`stripLeadingIcons`、`isNativeSource`、`SOURCE_KIND_LABEL` |
| `services/request.ts` | 请求组装：模板 + 变量 + baseUrl → 可执行请求计划 | `assembleRequest`、`fetchInitOf`、`parseUrlOption`、`stripUrlOption`、`splitUrlOption`、`absUrlKeepOption`、`canonUrl`、`buildSearchRequest`、`RequestPlan` |
| `services/search-face.ts` | 搜索面：JS 模板解析 → 组装 → 抓取解码 → **详情页嗅探判定** → 列表求值 → 条目 | `fetchSearchPage`、`searchErrorCodeOf`、`SearchFaceResult` |
| `services/search-template.ts` | searchUrl 的 JS 形态与 `{{…}}` 预求值 | `resolveSearchTemplate`、`resolveJsSearchTemplate`、`preEvaluateUrlJs` |
| `services/fetcher.ts` | 守门抓取器（唯一出站口）+ 解码链 + 出站头合并 | `createFetcher`、`decodeBody`、`fetchTextPage`、`headerOf`、`Fetcher`、`FetchedPage` |
| `services/engine-fetch.ts` | `@js` 里 `java.ajax` 的守门出口 | `engineFetch` |
| `services/bridge.ts` | 引擎↔服务桥：值投影、条目提取、源级求值上下文、**请求头解析**、**详情字段取值单点** | `firstValue`、`firstUrlValue`、`listValue`、`extractItems`、`engineContextOf`、`makeSubEval`、`resolveHeaders`、`fieldOf`、`urlFieldOf`、`auxFieldOf`、`auxUrlFieldOf`、`kindFieldOf`、`wordCountFieldOf`、`formatWordCount`、`detailContextOf`、`detailFieldsOf`、`Page`、`SubRuleEval` |
| `services/pagination.ts` | 翻页闸（URL 防环 / 上限 / 零新增 / 回环 + 串章）+ next 多候选形状 | `followPages`、`FollowResult` |
| `services/chapter-page.ts` | 章节分页判定（防串章闸判据） | `isSameChapterPage`、`stripExtension` |
| `services/content.ts` | 正文取值收口（HTML → 纯文本，幂等）+ **简介展示文本** | `contentToText`、`htmlToText`、`looksLikeHtml`、`formatIntro` |
| `services/localbooks.ts` | 本地书库（TXT / EPUB）：按内容分流 / 发布提交 / 正文·导航·资源·告警读取 / 删除 | `LocalBooks`、`decodeLocalText`、`splitChapters`、`isLocalBookKey`、`ChapterSpan`、`LocalImportResult`、`LocalResource` |
| `services/epub/archive.ts` | 受限 ZIP 条目读取：路径闸、重名、加密位、CRC 与实际字节预算 | `openEpubArchive`、`EpubArchive`、`EpubLimits`、`DEFAULT_EPUB_LIMITS` |
| `services/epub/xml.ts` | EPUB 的**只读 XML 面**（包 / 导航 / 正文共用）：字节事实解码（BOM > 声明 > UTF-8，无猜测链）+ 静态闸门（**先摘注释与 CDATA**，再判 DOCTYPE 内部子集、实体声明与未声明引用）+ 良构性（**多根元素即拒**：只取第一个会静默丢内容）+ 单文档 DOM 预算 + 本地名 DOM 小工具 | `decodeEpubXml`、`parseXml`、`xmlBudget`、`textOf`、`descendants` |
| `services/epub/package.ts` | 包结构：container→OPF、manifest、spine 主序列、nav/NCX 目录、封面候选、编码与路径解析 | `readEpubPackage`、`resolveEpubHref`、`EpubPackage` |
| `services/epub/warnings.ts` | **告警层**（与转换 / 资源验证都不相干）：同类告警合并器（**处数不设限、例子最多三个**）+ 跨模块共享的那几个码 | `EpubWarningLog`、`WARN_REMOVED`、`WARN_ACTIVE_ATTR`、`WARN_CSS_ATTR`、`WARN_INLINE_SVG` |
| `services/epub/documents.ts` | XHTML → 白名单图文树 + 锚点/链接映射（两遍走；活动内容剥除并记告警） | `scanXhtml`、`convertXhtml` |
| `services/epub/resources.ts` | 图片类型/尺寸/像素验证与受限 SVG 重建（白名单外可见元素报错） | `validateImage`、`SVG_MEDIA_TYPE` |
| `services/epub/import.ts` | 导入编排：串起包/文档/资源，只写指定暂存目录，返回索引（不发布、不认识书架与 HTTP） | `importEpub`、`EpubImportData` |
| `services/epub/errors.ts` | EPUB 子树的异常类（避免 localbooks ↔ epub 成环） | `EpubImportError` |
| `services/chapter-content.ts` | 规范正文 → 纯文本的**唯一投影**（图 = `[图片：替代文字]` 占位，不追链接） | `chapterContentToText` |
| `services/shelf.ts` | 书架：元数据写口（add = patch 语义 / update = 补丁）+ 进度 + 批量删 | `Shelf`、`AddBookInput`、`BookPatch` |
| `services/cache.ts` | 目录 / 正文文件缓存 + LRU 淘汰（只回答「放在哪」，有效性归 `cache-epoch.ts` + `reading.ts`） | `PageCache`、`safeKey` |
| `services/cache-epoch.ts` | 缓存有效性唯一算式：规则指纹 → 目录代际 / 正文槽位 | `rulesEpoch`、`contentSlot`、`RULE_EPOCH_IMPACT`、`EpochImpact`、`CacheFacet` |
| `services/storage.ts` | 数据根、原子写与并发串行、读 JSON 的损坏判别、防抖写 | `novelDir`、`readJson`、`writeJsonAtomic`、`writeFileAtomic`、`createDebouncedWriter`、`CorruptJsonError` |
| `services/errors.ts` | 错误类与**分类学单点** | `classify`、`ErrorCategory`、`SourceNotFoundError`、`ChapterNotFoundError`、`RuleMissingError`、`FetchError`、`DecodeError`、`LocalNotMountedError` |
| `services/probe.ts` | 探针：真发一次搜索请求（关键词逐词重试） | `probeSource` |
| `services/export.ts` | 章节范围导出核心：from/to 裁剪与倒置校验 + 串行 + 节流 + 失败即停 + abort 即停 | `exportBook`、`ExportDeps`、`ExportOptions` |
| `services/proxy.ts` | 出站代理判定（config > 环境变量 > Windows 系统代理 > 直连） | `resolveProxyUrl`、`proxyFromEnv`、`normalizeProxyServer`、`readSystemProxy` |
| `services/types.ts` | 持久化模型（sources.json 形状） | `NovelSource`、`NormalizedRules`、`SourceAuth`；`SourceStatus` / `SourceContentKind` / `ShelfBook` / `ShelfProgress` 反向 re-export `shared/wire.ts` |
| `services/url.ts` | URL 绝对化（拆 request↔bridge 环的纯工具） | `absUrl` |
| `api/dispatch.ts` | `/novel-api` 前缀路由内部分发 | `createApiHandler`、`ApiHandlerOptions` |
| `api/wire.ts` | 同源 fence / body 读取 / 信封写出 / 错误→HTTP 映射 | `isTrustedRequest`、`readJsonBody`、`writeOk`、`writeError`、`errorStatusOf`、`ApiError` |
| `shared/wire.ts` | **跨半契约**：值形状、路由常量、query/body 构造器、书目字段集 | `ROUTES`、`paramRoutes`、`SEG`、`PARAMS`、`queries`、`resourceUrl`、`shelfBody`、`SHELF_META`、`pickShelfMeta`、`ShelfEntry`、`LOCAL_SOURCE_ID`、`NOVEL_API_PREFIX`、全部 DTO |
| `tools/tools.ts` | agent 六工具，全锁 `dshnovel_` 前缀（与 HTTP 共用 service 层） | `buildTools`、`registerTools` |
| `tools/project.ts` | 缺键投影唯一实现 | `project` |

## 关键口径与不变量

### 1. 源入库（`services/intake.ts`）——入库规则的唯一实现

`SourceIntake.intake(raw)` 是「书源进入系统」的全部语义，顺序钉死：**normalize → 批内留首条 → 按址去重 → add / replace**。两条调用路——后台导入任务（`import-job.runImport`）与工具面同步导入（`reading.importSource/importOne`）——都只是**调用方**，只把 `IntakeDecision` 映射成自己的词汇（任务 counts/issues、工具 `ImportOutcome`）。

- 批的边界 = 一个 `SourceIntake` 实例的生命周期：构造时冻结库内地址快照（`byKey`，O(1) 查重），批内新落键实时并入；`batchKeys` 与库内已有键**分列**，两种去重语义不混用。
- **被否决的方案**：规则只住在 `runImport` 里（历史形态）。后果是同址可重复入库——同步工具面导入没有去重，入库规则只兑现了一半。
- 去重键 `dedupKey` = `trim` + 去尾部 `/`，**不改大小写**（URL 路径大小写是有意义的，折叠会把两条不同地址误判成同一条）。

### 2. 可/不可用源的去重差异（`intake.intake`）

同一 baseUrl 已有条目时：

- 已有条目里**存在 verified** → 保留已有、跳过新条，`skipped{reason:'verified'}`。取 `existing.find(verified) ?? existing[0]`——不能让一条历史脏的 unverified 条目把可用源挤掉。**verified 跳过同样占批内键**（与旧任务口径一致，后续同址条目一律 batch 跳过）。
- **无可用的**（全 broken / unverified）→ 新条 `tx.replace(preferred.id, result)` **复用旧 id**（书架与既有引用不断），并 `tx.removeAll(rest)` 清掉同键其余条目。历史脏数据在此收敛成一条。
- 缺地址的条目（normalize 失败）不参与去重，按 missing 口径逐条报。
- **内容形态是入库闸，不是状态**（2026-09 裁定）：`bookSourceType` 不是文本（书源格式里该字段是整数——`1`/`2`/`3` 是音频/图片/文件，认不出的值同样算非文本）→ normalize 出 `missing` → `ok:false` → 不入库；存量误标由 `SourceRegistry.load` 按 raw 重推成 `unknown`。两个被否决的方案：① **读不懂就当文本**（曾如此：warning + 按文本处理）——误标 text 的漫画/短剧源照样进聚合搜索与文字书架（书架诊断实证），且没有任何门会拦住它；② **打成坏源**（`status='broken'`）——探针只验搜索面，而这类源搜索面恰恰是好的，一次「验证/重验」就把标记洗白。`unknown` 的唯一职责是让 `participates` 不认它；列表、状态带、待办都不读 `type`。

`replace` 的语义在注册表侧：原位 splice 保列表序、`status` 复位 `unverified`、`importedAt` 更新为现在——**新规则需重验**，且只收 `ok:true` 的 normalize 产物（与 `add` 同口径）。

### 3. 书源注册表是原子事务，落盘不是调用方的纪律（`services/sources.ts`）

`SourceRegistry` 对外只有 `edit(recipe)` / `flush()` / `list()` / `get()` / `toPublic()`。原 7 个公开 mutator 与公开 `persist()` **全部删除**——「改了忘落盘」在 interface 上不可表达。recipe 同步执行，故一次 `edit` 内的多步变更对外不可分割（并发 edit 不交错）。

落盘策略住在 module 内部，调用方不知道粒度存在：累计 ≥20 次变更的那次 `edit` **等写落地**，否则 100ms 尾沿防抖后台合并；任务收尾与测试断言用 `flush()`。**被否决的方案**：9 处调用点手工配对「mutator + persist」（注释里的顺序约束），加上住在任务运行器里的 `IMPORT_PERSIST_EVERY` / `PROBE_PERSIST_EVERY` 两个节流常量——谁忘了 persist 就是静默丢数据。

`load()` 承担**存量归一**并在改动时立即落盘收敛：`enabled` 缺省 → true（缺省即启用，否则搜索面 `s.enabled &&` 会静默排除老源）；`type` 缺省 → `'text'`、并按 `raw.bookSourceType` 重推（读不懂 → `'unknown'`，退出参与集）；`groups` 按 `splitGroups` 拆分（逗号粘连收敛）；`name` 按 `stripLeadingIcons` 剥前缀图标；`ruleDetailInit`（第六条）/ `headerRule`（第七条）/ `bookUrlPattern`（第八条）按 raw 重推，`kind`/`wordCount` 四键（第九条）同样补推。**九条迁移都幂等**，而幂等的前提是**读路只有一份**：第二条自己解释 raw 的读函数必然与导入侧的容器/优先级口径分叉，恒覆盖就会把导入侧派生的正确值改写掉并落盘——写成读数上看不出来的 `null`。**接新规则字段做存量收敛按第六条的做法**（`normalize.deriveRuleField(raw, 模型键名)`，直接跑导入侧那份展平），不要再写第二个自己读 raw 的函数；**第九条是例外**：`rawBookMetaFields` 自带容器优先级，属「单一读路」纪律之前的产物，只能**只填缺席的键、不覆盖已有值**（恒落会把「字符串化容器」那类源的正确值改写成 `null`）。第七、八条没有容器与优先级语义，恒覆盖安全。钉子：`tests/services/sources.test.ts` 的三条「⑥ init 往返 / 单一读路」（往返一致、平铺优先不被容器改写、受损存量修复且二次 load 幂等）。

`list()` 返回**活体数组**（不是快照）：intake 的地址索引与 import-job 的状态判定依赖活引用。快照化读面是另一张卡的事。

### 4. 后台任务：写任务单槽、读任务另开一槽（`services/import-job.ts` + `services/search-job.ts`）

`SourceJobs` 只有一个 `current: JobState`。运行中再提交（任意 kind）→ `JobRunningError` → 路由 409 `JobRunning`。任务结束后结果**保留在槽内**直到下一个任务开始——关设置页、刷新浏览器后重挂载查一次 `job-status` 就能恢复展示。**这条互斥只管两个写任务**；聚合搜索是读，另开一槽（见下面 `novel-search`）。

**生命周期已登记给宿主 `ctx.jobs`（2026-09），单槽互斥与 counts 仍归本模块**。分工是刻意的两半：宿主注册表管**身份与生命周期**（`<kind>-N`、`running → completed|killed|failed`、owner 栅栏、随服务卸载而 cancel），`SourceJobs` 管**业务计数与明细**（`counts` / `issues` / `fileErrors`——宿主只有 `label` + `detail` 一行，装不下 642 源的失败分桶）。要点：
- `kind` 用 `novel-import` / `novel-probe` / `novel-search`（宿主对 kind 的唯一判据是「非空字符串」，按不透明命名空间处理，不需要类型包合并）；`label` 写清工作量（`导入书源 N 个文件` / `批量验证书源 N 家` / `聚合搜索「kw」（N 家书源）`）。
- **类型面是本地窄镜像** `JobHost`（`src/index.ts` 的 `NovelContext` + `*Like` 先例）：npm 上的 `@deepseek-ai/dsh-jobs` 停在 `0.0.1-rc.3`（2026-09-23 与 2026-09-26 两次复核：npm 仍是这个号）而宿主跑 `0.1.7-rc.2`，装它等于拿一套不同代的契约。**`host` 缺席即不登记**（单测直构与无 jobs 的组合都走这条路，任务语义不变）。
- 入口在 `ctx.effect` 里 `attachController('dsh-novel')`：宿主 `start` 的准入闸要求「有已挂载 controller 服务该 owner」，而本机 profile 里第一方的 `tool-jobs` 是 disabled 的（证据见 `docs/reference/dsh-plugin-api.md` 风险第 10 条）。
- **取消是协作式的**：宿主 `cancel(reason)` 只把旗子立起来，运行器在**取下一条之前**收手——在途的网络探针/入库不打断（打断半路写回的源更脏）。收手时已入库/已验证的结果一律保留 + `flush()` 等齐，`JobState` 落 `phase='failed'` + `error='任务已取消：…'`。**wire 的 `phase` 不加 `killed`**：对 UI 的判据（`phase !== 'running'`）两个终态无区别，加一态要动跨半契约与三处判据，收益为零。宿主侧则如实结算 `status:'killed'`。
- 收尾三处写口（`completed` / `killed` / `failed`）集中在 `settle()` 一处——漏掉一处就是「小说 UI 显示已结束，宿主注册表里还挂着 running」。终态词汇 `JobOutcome` 也只此一处声明（`search-job.ts` 复用同一别名，不各写一份联合类型）。
- **`novel-search` 不进写槽**：搜索是**读**，与导入 / 验证挤同一个 `current` 等于「搜一本书能挡住一次导入」——那是惩罚探索动作。所以读任务有自己的持有者 `SearchJobs`（`services/search-job.ts`），与 `SourceJobs` 各持一个槽，两者都把生命周期登记给宿主。代价如实记着：宿主侧可同时存在两条 novel 任务（`maxConcurrentJobsPerOwner` 缺省 10，够用），而浏览器半「任何任务在途即禁用」那条判据只管两个写任务。
- **`SearchJobs` 比写任务多持有一件事：整轮结果 + 游标**（宿主只有一个 `detail` 字符串，装不下 642 家源的分组命中）。三条上限都是在这里定的，不在浏览器半：**只留最近一轮**（新提交即替换上一轮，上一轮若在跑则协作式收手并结算 `killed`）、每源 hits 截 `SEARCH_HITS_CAP_PER_SOURCE`（50）、结束后 `SEARCH_JOB_RETENTION_MS`（30 分钟）内可读，**过期读作「无任务」而不是空结果**（不把过期伪装成「搜了没命中」）。
- **SSE 不引入第二套状态**：`SearchJobs.subscribe(listener)` 只发「本轮变了」的信号，**不带数据**——每条连接自己带游标 `snapshot(cursor)` 取增量，所以推送帧与快照查询共用同一份合并代码、同一个 `phase !== running` 判据。任一时刻只有一条通道在推进游标（两条同时在飞会把同一批命中累加两遍），这条约束归客户端（`client/search-job.ts` 的「SSE 推送优先，快照轮询兜底」）；**跨观察者的换轮裁决同样归客户端观察 module**（读面单槽 + 数字游标：旧观察者读回来的是新轮按旧游标切的片——身份闸与基线恢复的口径见 `docs/design/client.md` 搜索节「轮次身份与游标不可分开」）。信号口在 `end()`（终态）也要响一次，否则关不掉流。
- 任务态**只在内存**：DSH 重启即丢（`status()` 返回 null，UI 回落空闲态）；但源已按批落盘，导入本身幂等可重跑，故不做任务持久化。
- 导入管线：逐文件 `JSON.parse(stripBom(text))`，坏文件记 `fileErrors` 继续，其余照常；`Array.isArray` 摊平后逐条交 `SourceIntake`。**导入不探针**——新源一律 `unverified`，验证归批量验证任务（并发 5 路，对齐 `searchParallel` 的限流敬畏）。
- `issues` 截断 200 条（内存不膨胀），**计数字段不受截断影响**。
- 批量验证的 worker 每条**重查注册表**：任务运行期间源可能被删，取不到就点名跳过，不产生 `TypeError` 垃圾失败。
- 跳过 642 条源的逐条同步探针是本设计的出发点：原链路每条 persist 全量重写 sources.json + 逐条串行网络请求，每 20 条要等几十秒。

### 5. 请求组装（`services/request.ts`）——选项语义的唯一主人

`assembleRequest(template, vars, baseUrl, opts)` → `RequestPlan`。这里一次性解释完：

- **切分**：`,{`（允许逗号两侧空白——切分式 `\s*,\s*(?=\{)` 住 `engine/template.ts` 的 `URL_OPTION_SPLIT`；真实源大量写 `, {...}`，此前不许空格会把选项串并进 URL，POST/charset 选项成片失效）。选项 JSON 严格优先，失败回退单引号交换（`{'a':'b'}` 真实源大量存在）；`headers` 支持字符串双重编码。
- **切分无条件、选项尽力解析**（2026-09 裁定）：切分式命中即把 URL 切干净，**选项 JSON 是否合法只决定「拿没拿到选项」，不决定「URL 干不干净」**——解析失败 → `option: undefined` + `console.warn` 留痕，请求按无选项发出。被否决的旧行为：解析失败把整串（含 `,{…}`）当纯 URL——「诚实失败」听起来克制，实际把站点 404 当成了失败原因（那条弯引号形态的真机实证住矩阵 `b-split-unconditional`，这里不重抄）。弯引号/单引号/裸键选项仍走 `parseOptionJson` 的宽容链尽力还原。
- **charset 双面（2026-09-26）**：声明的 charset 既管**响应解码**（`plan.charset` → `decodeBody`）也管**请求编码**——POST 表单体在组装期按它转义（`encodeFormCharset`：**`option.charset` 在场即逐段转义**——当前没有「这具body是不是表单」的判别，默认 `urlencoded` 头还是转义之后才补，函数头注里那句「只在体非 JSON/XML」是还没落地的意图，见「已知开口」）。此前只做解码：GBK 站点收到 UTF-8 关键词恒 0 命中（辣妹小说真机实证：UTF-8 体 0 条 / GBK 体 131 条）。**查询串不重编码**：`{{key}}` 在 `interpolateUrl` 阶段已按 UTF-8 转义，重编码会把 `%xx` 再转义一遍——「已编码就不动」的守卫下同样是不动，故只在体上补这一层。
- **method 三态**（GET / POST / HEAD，2026-09-28 收口，出处与对读记录见矩阵 `b-opt-method-head`）：`assembleRequest` 按三态分派，认不出的值落 GET。**HEAD 不发 body**——它是「只看响应头」的元数据探测，源就算同时声明了 body 也丢掉，连默认 `urlencoded` 头一起补会把一次探测变成真的写请求。**被否决的旧口径**：只问「是不是 POST」、其余并进 GET——声明 HEAD 的源实际发出 GET，本仓把这条降级当成了实现记了很久（病史在同一条矩阵行里）。
- **body 插值**：`option.body` 同样过 `interpolateUrl`。
- **POST 表单默认头**：有 body 且 headers 里没有（任意大小写）`content-type` → 补 `application/x-www-form-urlencoded`。不补的话 Node fetch 发 `text/plain`，PHP 类表单端点 `$_POST` 解析不到字段（帝国 CMS 搜索收空关键词返回空页）。
- **未知选项键留痕**（宁吵不瞒，2026-09）：`parseOptionJson` 是白名单读取（`method` / `body` / `charset` / `headers` / `webView`），书源选项里的其余键（`retry` / `type` / `js` / `bodyJs` / `dnsIp` / `serverID` / `webJs` / `origin`…）在本插件不生效，但**当场 warn 点名键名**——静默丢弃会让人以为选项生效（本库 4 源带这类键，2026-09-28 按 raw 抽出选项 JSON 比对白名单量得：键为 `title`/`url`、`js`、`type`、`name`/`placeholder`。**旧句把 `retry` 当主例已订正**——那条今日 **0 源**：`DSH_PARSE_CENSUS=1` 的 `retryOption` 行与矩阵 `b-opt-retry` 按真入口的读数一致）。被否决的旧行为：解析后就丢掉、无任何留痕。
- **charset** 进计划，解码优先级高于 Content-Type 与嗅探。
- **相对 URL 按 baseUrl 绝对化**；`baseUrl = null` 不做绝对化（`@js` 的 `java.ajax` 形态：URL 由脚本自己拼好）。
- **`trimFirstPage`**：Native 分页语义——模板以 `/{{page}}` 结尾且首页 → 裁掉页码段（带 `/1` 的站点直接 404）。

`fetchInitOf(plan, baseHeaders)` 是 init 姿态单点：GET **不带 method 键**（fetch 缺省即 GET）；POST 带 method 与插值后的 body；HEAD 只带 method、**不带 body**（丢掉 body 发生在 `assembleRequest`，见上面「method 三态」——这里只是不再补回来）；`baseHeaders`（如源级 `headerOf`）打底、计划 headers 覆盖同名。**被否决的方案**：`buildSearchRequest` 与 `engineFetch` 各写一份、靠「与对方同口径」注释同步。

`stripUrlOption(href)` 剥 URL 尾部的 `,{…}` 选项后缀（嗅探语义）：**逗号 + `{` 开头即切**（无条件切分、不校验尾段 JSON——2026-09 放宽，与 `parseUrlOption` 同源），选项合法性由抓取时的 `assembleRequest` 负责（解析失败 → 无选项 + warn）；正文里的 `{a,b}` 不误剥（逗号后不是 `{`，切分式不命中）。本插件不支持 WebView——剥掉后缀让普通请求照常尝试，而不是 URL 解析必炸。**落库与求值出口一律保留选项**，三个出口统一走 `absUrlKeepOption`（URL 部分绝对化、`,{option}` 原样接回）：书 URL（URL 即请求规格——米读类 POST API 源的 book_id 藏在选项 body 里，剥掉则详情/目录/正文全链路 405）、章节 URL、`ruleBookInfo.tocUrl`（2 源真机实证）。**通用教训（三处同源修复的共同原因）**：`new URL()` 会吃掉换行并把 `{` 百分号编码——任何带 `,{option}` 的 URL 出口都必须在 `new URL()` **之前**切分，绝对化是这条链上唯一会静默改写选项串形状的步骤。
`stripUrlOption` 现在只出现在**解析 base**（`reading.getDetail` 的引擎上下文与封面绝对化、`tocUrlOf` 的相对链接解析——选项不属于链接解析域）与比对口径（`canonUrl` 剥选项归一）；抓取解释选项全走 `assembleRequest` 单点——`reading.fetchText` 已由裸抓改为经 `assembleRequest` + `plan.charset` 解码（书 URL / 详情页 / tocUrl 回退都可能是 POST 端点）。钉子：`tests/services/reading.test.ts` 的 `describe('书 URL 承载请求选项（,{option} 随身份存取）')`、`tests/services/toc-url-option.test.ts`（动态插值与静态两种 tocUrl 各一条）。

**简介（`intro`）是展示文本，不是原样透出的字段**（2026-09 补齐）：块级标签（`div`/`p`/`br`/`hr`/`hN`/`article`/`dd`/`dl`）转换行、注释与其余标签连属性删除、`&nbsp;/&ensp;/&emsp;` 转空格、`&thinsp;/&zwnj;/&zwj;` 删除、换行折叠成「换行 + 两个全角空格」，最后 5000 字符截断。实现在 `content.ts` 的 `formatIntro`（与正文的 `contentToText` 分家：那条是「HTML→段落文本、img 保留为地址行」的正文契约，这条是简介的展示净化）。**两个面的净化口径刻意不对称**：`reading.getDetail` 传 `keepDirective: true`——`intro` 以 `<usehtml>` / `<md>` / `<useweb>` 开头（trimStart 后判，大小写不敏感）就**连前缀原样保留**（否则 `<button>@onclick` 等书源交互标记会被清理掉；现库 1 源：米读小说把整页 CSS + 卡片 HTML 写进 intro），搜索面（`searchOne`）**不认前缀、恒净化**。两条有意偏差都只裁空白：串尾不留尾空行（不裁的话产物会以「换行 + 缩进」收尾），串首缩进统一两个全角空格（朴素实现补四个）。Miss 仍是 `null`，不折成空串。钉子：`tests/services/intro-format.test.ts`。渲染指令本仓**没有**对应渲染器（纯文本阅读器 + `<p>` 分段）——保留前缀的价值是不把样式源码当正文，将来要渲染时判得出来；这属产品面开口，不是净化缺口。

### 6. 守门 fetcher（`services/fetcher.ts`）——唯一出站口

`createFetcher` 收口三件事：超时（`AbortController` + `Promise.race`，缺省 15000ms，可按次覆盖）、网络层异常、HTTP 非 2xx——分别类型化为 `FetchError`，**绝不把未分类异常漏给上层**。

- **缺省请求头**带浏览器 UA / Accept / Accept-Language：Node fetch 默认不带 UA，站点 WAF 按 UA 过滤直接 403（实测 26 源——**当批真机探针读数**，分母随库漂，要引就重跑探针）。调用方显式声明的同名头优先。
- **代理**走 undici 的 `ProxyAgent`（`dispatcher`）：Node 的 fetch **不读系统代理**，有代理才通的站点直连会被 302 / 重置——「浏览器能开、读者打不开」的类型错位由此而来。判定优先级见 `services/proxy.ts`。
- **解码链**（`decodeBody`，禁默认 UTF-8 硬解）：⓪ 声明覆盖（searchUrl 选项 charset）→ ① Content-Type charset → ② 缺位且内容（去 BOM/前导空白后）以 `<!doctype`/`<html`/`<head`/`<?xml` 开头 → 前 1024 字节 latin1 嗅探 `<meta charset>` / `<meta content=…charset=…>` → ③ 兜底 UTF-8。**声明的 charset iconv 不认识 → `DecodeError`**（宁可报「这页编码解不出」，不拿乱码冒充正文）；空串 charset 声明视为缺位（真实源存在 `charset=` 空值），不炸。
- `fetchTextPage(fetcher, url, init, declaredCharset)` 是「抓取 + 解码 + 落地地址」的单点，超时归 fetcher 自身（**被否决的方案**：`fetchTimed` 在 fetcher 之外再竞速一个**不 abort** 的定时器，两套超时并存、错误文案却一字不差）。
- `headerOf(source)`：源静态 `rules.header` 打底 → 非 expired 的 `auth.headers` 覆盖同名 → Cookie 段合并（静态段按名去重、auth 名占优并在后）。
- **请求头解析单点 `resolveHeaders(fetcher, source, {jsTimeoutMs})`**（`services/bridge.ts`，2026-09）：`rules.headerRule`（`@js:`/`<js>` 动态头）经沙箱求值得 JSON 头表，叠在 `headerOf` 之上（同序：auth/cookie 在后占优）；无规则直答静态头。**失败语义是「降级不炸」**：求值抛错 / 产物非 JSON 对象 → `console.warn` 后回退静态头（动态头缺失 = 站点按无 device 鉴权处理，下游自然报错——不吞请求也不炸整条链）。**不递归**：规则脚本自身的 fetch 用静态头打底，否则头规则里一次 `java.ajax` 就会重新求值头规则。三个抓取调用点（`reading.fetchPage/fetchText`、`search-face`）与引擎上下文（`engineContextOf` 的惰性 provider 形态）都走它——`engineFetch` 的 `HeadersInput` 因此支持静态表或 provider 双形态，`@js` 动态头**每请求现算**（device-id 逐请求刷新，不能缓存）。header 单字段两形态互斥同源：raw.header 是规则 → `rules.headerRule`（`normalizeHeaderRule`）；否则 JSON → `rules.header`；存量由 `SourceRegistry.load` 第七条迁移按 raw 重推（与 `ruleDetailInit` 第六条同构）。

### 7. 搜索面（`services/search-face.ts`）——探针与聚合搜索共用一条请求语义

`fetchSearchPage(source, keyword, fetcher, timeoutMs, jsTimeoutMs)` 是「发一次书源搜索请求并取回条目」的唯一实现，page 固定 1（搜索面无翻页）：规则缺失判定 → `resolveSearchTemplate`（**URL 模板里的 js 块先求值**：`<js>…</js>` 可在任意位置、`@js:` 吃到串尾、块间字面文本按 `@result` 拼接——js 块逐行解析口径住本模块的 `URL_JS_BLOCK_RE`（行为对读见矩阵行 `b-url-js-anywhere`）；链内的 JS 区域/段界口径才住 `engine/grammar.ts` 的 `jsRegionEnd` / `isJsForm`。**两处刻意不合一**：URL 模板不是规则链，`@`/`@@` 在模板里没有段界语义，把块识别并进 `jsRegionEnd` 会改掉 `@@js:` 等形态的现行为——真机读数钉在现形态上（同矩阵行），要合一先得拍板那批形态怎么读）；随后 `{{…}}` 按 JS 预求值，**变量占位**原样留给 `interpolateUrl`，jsLib 全局等一律进沙箱）→ `assembleRequest`（Native 时 `trimFirstPage`）→ `fetchTextPage` → 列表规则求值 → `itemContextsOf`（逐条目求值上下文；AllInOne 条目另带行，供字段规则的 `$n` 绑定）。返回 `landedUrl`（跟随重定向后的 finalUrl）——**规则求值与相对链接一律以落地地址为基准**，与目录 / 正文面同口径（重定向站点不再错位）。

错误策略：抓取 / 解码 / 沙箱错误**上抛**（调用方各自 catch，用 `searchErrorCodeOf` 归类）；**规则缺失是结果**（`{ok:false, code:'RuleMissing'}`），因为两个 adapter 都把它当正常分支而非异常。

**详情页嗅探（`bookUrlPattern`）判在搜索面，两个 adapter 不各写一份**（2026-09 补齐；两处判定：落地地址整串命中 pattern，与「列表为空则按详情页解析」）。结果的 `shape` 有二：`'list'` = `contexts` 是**逐条目的求值上下文**（`html` 即条目原文；AllInOne 条目另带 `regexRow`，字段规则的 `$n` 在引擎入口按它绑定——见 `docs/design/engine.md` 的「AllInOne 行模板与 `$n` 绑定」），调用方按**搜索条目规则**逐条展开；`'info'` = 整段响应本身就是详情页（`body` + 一条 `bookUrl`），调用方按**详情规则**展开成一条书目。走 info 的两条路：① 落地地址**整串**命中 `bookUrlPattern` → 列表规则根本不参与（判定先于列表求值）；② 列表零命中**且源未声明 pattern** → 回落详情页（回落的前置就是「未声明 pattern」，所以声明过却没命中就是 0 结果，不再回落，`via` 字段把两条路分开报给探针）。几条刻意的口径，每条都有反例撑着：
- **整串匹配，不是子串**：`bookUrlPattern` 的语义是「整串等于一条详情页地址」，而 JS `RegExp.test` 只做子串匹配，故锚定 `^(?:…)$`。现库 **41** 个带值源里有 `\/novel\/[0-9]+\.html` 这种**永远不可能整串等于一条 URL** 的写法（2026-09-28 按 raw 重数，与 `legado-compat.md` 需求量表同一读；此处原写 27 是旧分母）——裸 `test` 会把搜索结果页误判成详情页，读数上就是一条都搜不出来。
- **`bookUrl` 在未重定向时保留 `,{option}`**（绝对化的输入是 `{{}}` 代入后、选项切分**之前**的那一串）：POST 型 API 源的 book_id 活在选项 body 里，剥掉之后这条地址再也发不出同一个请求——与书 URL / 章节 URL / tocUrl 的 keepOption 同一条通用教训（§5）。重定向时只能用落地地址（搜索地址不是可重访的详情页）。
- **info 形态只对声明了 `ruleBookInfo.name` 的源开放**（现库 **176/214** 声明，41 个带 pattern 的源全在其中；2026-09-28 按 raw 重数，原写 127/158 是旧分母）。本仓的详情字段对平铺方言会回退搜索条目规则，而这条回退在详情页上是**对的**（平铺源一套规则两用）、在「零结果」的响应页上是**假的**（`tag.a@text` 会拿页面第一个链接当书名）——不闸就等于用合法形状冒充成功。这道闸正是为这个落差设的：声明了 `ruleBookInfo.name` 才说明这套字段是给详情页写的。
- **嗅探来的「这是详情页」是猜测，不是事实：init 取空 = 没有书目**（`detailFieldsOf(…, { onEmptyInit: 'no-book' })`）。`getDetail` 走的是另一套：那里的 init 取空必须抛（不拿整页冒充上下文）。少了这道区分，一次正常的「这个词没搜到东西」会被升级成整源搜索错误——第 19 批真机抓回（快手趣阁 `ruleSearch.bookList: $.data[*]` 与 `ruleBookInfo.init: $.data` 同源，站点偶发不给 `data` → 列表 0 条 → 回落 → init 也取空；少了 `no-book` 这道区分，这次「没搜到东西」就会被报成 `RuleEvalError`）。
- **坏正则不废搜索**：`bookUrlPattern` 编译不过 → `console.warn` 点名 + 按未声明处理（当场抛会让整次搜索失败）。与「URL 选项不是合法 JSON」同一先例：留痕，但不把故障放大。被否决的方案是让编译错误上抛——一条源自己写歪的正则不该让它的搜索面整体不可用。
- **缺 `ruleBookList` 不再是 `RuleMissing`**：书源没声明 `bookList` 时按空规则求值 → 得空列表，然后走②。书名规则仍是硬要求（空串规则返回整页文本，会造垃圾标题）。
详情字段的取值实现在 `bridge.detailFieldsOf`（与 `getDetail` 同一份，含 `ruleDetailInit` 换根），info 形态的书地址基准取落地地址。钉子：`tests/services/search-book-url-pattern.test.ts`。

**分类与字数不是「取到字符串就给」——两条口径都定在解析层**（2026-09 第 22 批）：
- **`kind` 是多值逗号串**：多值列表按 `,` 连接、截前 1000 个 UTF-16 code unit，本仓 `bridge.kindFieldOf` 即此口径（`listValue` + `join(',')` + `slice(0, 1000)`）。取首值会让 `class.tags a@text`、`$.categoryNames[*]className` 这类规则两边读到不同的值。
- **`wordCount` 在存下来之前就被格式化**：字数在**解析层**就被格式化，**不在 UI 层**——所以 `book.wordCount` 里住的已经是「1.2万字」这种串。本仓 `bridge.formatWordCount` 即此口径：整串匹配 `-?[0-9]+` 才转换、`>10000` 走 `DecimalFormat("#.#")` 的 **HALF_EVEN** 舍入（`12500`→`1.2万字`、`13500`→`1.4万字`，不是四舍五入）、≤0 变空串、认不出数字原样给回（站点文案「120万字」「连载中」本就是字符串）。
- **这一族的读取失败只丢该字段**（`bridge.metaFieldOf` 一族：`auxFieldOf` / `auxUrlFieldOf`）：**恰是五项**按字段级吞错——kind / wordCount / lastChapter / intro / coverUrl；name / author / bookUrl / tocUrl 四项不吞（求值失败上抛）。不吞的后果很具体：现库有 **8 处**这样的取值、分属 **7 源**（`kind`/`wordCount` 两字段的裸串值：万象书城 / 夜伴书屋 / 八零小说 / 爱丽丝书屋 / 爱看小说 / VIP中文 / 笔趣阁，2026-09-28 按 raw 重数；此处原写「9 条源」是旧读数），那形态在本仓解析期抛 `UnsupportedRuleError`，字段级吞掉 = 该源照常出书目，不吞 = 整组搜索变 error——**接入一个字段反而造出欠账**。钉子两侧都钉（`tests/services/reading.test.ts`「辅助字段的坏规则只丢该字段」：坏简介出书目、坏作者整组报错），因为只钉「吞」等于放行「什么都吞」，而**宁炸不猜在这条边界上没有被放宽**——空结果冒充失败依旧是错，只是「一条辅助字段的规则读不出」从来不是失败。
- **搜索条目规则的消费点经全仓 grep 恰为九项**（bookList/name/author/bookUrl/coverUrl/intro/kind/lastChapter/wordCount），本仓九项齐；`updateTime` 整族**没有任何消费点**（`ruleToc.updateTime` 同样零读取，`src/` 里 grep 不到），矩阵 `c-rule-search-subfields` 记着这次「字段表齐而消费点不齐」的纠正。
- **详情面对搜索面规则的 `??` 回退是本仓的近似**：本仓 `ruleDetailKind ?? ruleKind` 是拿搜索规则**在详情页上重算一遍**——它携带的是**规则**而不是**值**（不复用搜索面已经取到的那一份）。平铺源一套规则两用时会碰巧对，两不沾时得 null，而 null 经 `pickShelfMeta` 是**键缺席**、不覆盖书架上已有的值，所以两条路都不会把已有的分类抹掉。这与 `lastChapter`/`intro` 等字段同一条既有口径（见上文「info 形态只对声明了 `ruleBookInfo.name` 的源开放」那条 bullet 里的同一落差），不是这次新加的裁决。

**聚合编排也只有一份（`services/reading.ts`）**：`searchProgressive(keyword, {sourceIds, onGroup, shouldStop})` 是批循环的唯一主人——`onGroup` 按**完成序**逐源交付（谁先求值完谁先出），返回值仍按**参搜源序**排列。`search()` 是它的薄壳（收齐全部命中），HTTP 面与 `dshnovel_search` 工具都走这一份；`startSearchJob()` 是第三个消费方（同一个循环，换 `onGroup` 交给 `SearchJobs.emit`、`shouldStop` 交给它的协作式取消）。**这一侧不许出现第二个批循环**——浏览器半那套分批只为拿增量与进度条而存在，2026-09 后台化落地时已随之下线（口径见 `docs/design/client.md` 的「搜索」节）。

### 8. 探针（`services/probe.ts`）

真发一次搜索请求，关键词按 `PROBE_KEYS = ['书','小说','的']` 逐词重试——单字「书」在个别站被搜索程序停用（实测 aijjxs 对「书」0 命中、其余词 1 命中）。**源自带 `ruleSearch.checkKeyWord`（映射为 `rules.probeKeyword`）时它是第一个关键词**——「只搜得到自家书名」的站对通用词恒 0 命中，会把好源判坏（现库 47/214 源带值，2026-09-28 按 raw 量 `ruleSearch.checkKeyWord` 非空；`DSH_PARSE_CENSUS=1` 的 `probeKeyword` 行可重算。旧注「31/158」是上一批分母上的数，别抄）；值含 `http`/`::`/`++`/`--` 的（是 URL 或脚本片段，不是搜索词）在导入期弃用，回落通用序列——判据住 `src/services/normalize.ts`。**只有「请求成功但 0 命中」才换词**；网络 / 规则异常立即返回，不多打请求。`ruleBookList ≥1 条目且首条 ruleBookName 非空` → `verified`，否则 `broken` 并如实透出（引擎错误 message 已含段级定位）。书名求值的 `usage` 必须与搜索面一致（`'value'`）：规则以属性终端收尾（`@title`/`@onclick`/`@_src`）时两种用途结果不同——探针曾按缺省 `'list'` 求值，把搜索面读得出书名的源判成「首条书名为空」的坏源（2026-09 审查修，钉子 `tests/services/probe.test.ts`）。CONTEXT.md「搜索面」的「探针与聚合搜索共用一次请求语义」全靠这一条成立。

**搜索面的两种 `shape` 在探针里分岔**（2026-09，随详情页嗅探同批）：`info` 且 `via='pattern'` → 书名按**详情规则**判（走 `bridge.detailFieldsOf`，与聚合搜索同一实现），读到书名即 `verified`；`info` 且 `via='empty-list'` → **与零条目同义，照旧换词重试**——那是「这个词没搜到东西」，把它当 verified 等于用一次空响应洗白一个坏源。钉子 `tests/services/search-book-url-pattern.test.ts`（探针节）。

**探针与搜索同一个耐心值**：`opts.timeoutMs` 缺省走 `ReadingService.searchTimeoutMs`，门面 `probe()` 显式传入。「配了 5s 就都是 5s」是既有承诺——修复前门面 `probe` 漏传，落回 fetcher 固定 15s。**js 沙箱预算同口径**：探针与搜索/阅读/登录共用插件配置 `jsTimeoutMs`（缺省 15000）——`probeSource` opts → `fetchSearchPage` → `makeSubEval`/`resolveSearchTemplate` → `EvalContext.jsTimeoutMs`，引擎 `ctx.jsTimeoutMs ?? DEFAULT_JS_TIMEOUT_MS` 消费，引擎零改动。

### 9. 缓存（`services/cache.ts` + `services/cache-epoch.ts`）与落盘（`services/storage.ts`）

`PageCache` 把目录与正文写成 `cache/toc/<sourceId>-<safeKey>-<epoch>.json`、`cache/content/<sourceId>-<safeKey>-<idx>-<slot>.txt`，每次 `set*` 后 `prune()`：两目录总字节超上限（缺省 200MB）→ 按 `mtimeMs` 升序删到 ≤ 上限（**LRU 近似**，不维护访问计数）。`safeKey` = `encodeURIComponent(bookKey)`；超 100 字符改前 60 字符 + `~` + sha1 前 10 位（确定性，规避文件名长度上限）。`epoch` / `slot` 对 `PageCache` 是**不透明串**——本模块只回答「放在哪」，不回答「何时有效」。

**缓存有效性**：算式唯一实现是 `cache-epoch.ts`，裁决在 `reading.ts`（读与写共用同一次算出的值）。根因是同址替换复用 `sourceId` 保书架引用（§2 既有裁决），于是「身份没变」被当成了「内容仍有效」——换规则后目录 / 正文照旧命中旧代际，而全仓没有清缓存的出口、阅读器也从不发 `refresh=1`，脏命中是永久的。

- **代际入键而不是删除式失效**：在途请求写的是它起飞时那个代际的文件名，新规则的读永远看不见它——「旧在途写回」自动无害，不需要墓碑也不需要取消通道。删除式失效必须额外挡回写，且 `intake` 有两个调用方（`reading.importOne` 与 `import-job` 批量），任一处忘了调就重新漏。旧代际文件不删：此后不再被写，mtime 只可能更早，因此排在**新写入**之前；但 prune 是 mtime 近似、`read()` 不刷新 mtime，长期只读的热条目同样不会被读操作续命，可能先于旧代际被淘汰（不假装「挤不掉热数据」）。
- **按面细分指纹**：`rulesEpoch(rules, baseUrl, facet)` 只哈希与该面相关的规则字段（facet 名与 baseUrl 也入指纹）；`facet` 是引擎面 `CacheFacet`（只有 toc / content 两个引擎面有文件缓存，故从 `Facet` 收窄出这两值）。归类表 `RULE_EPOCH_IMPACT` 给每个字段一个**影响面** `EpochImpact`（toc / content / both / none，是「改这个字段会作废哪些面的缓存」这条轴，与引擎「面」刻意换词，见 CONTEXT.md），`FACES_OF` 把影响面映射到它作废的引擎面。**编译器强制穷尽有两处**：`Record<keyof NormalizedRules, …>` 保证每个字段**都有一行**（加字段没归类 → `pnpm typecheck` 红）、`Record<EpochImpact, …>` 保证每个影响面**都配了面集**。但**把字段归错行 tsc 抓不住**——归类的对错没有机器守卫，只能靠给字段归类前核对 `getTocInner` / `getChapter` / `followOrSingle` 是否真消费它（`ruleBookList` 行的注释就是这条自查的范例；逐字段翻转钉子见 `tests/services/cache-epoch.test.ts`）。正文代际**同时收目录面字段**（`FACES_OF` 的 `toc` 行含 `content`）：正文的输入是目录的产物，改 `ruleChapterUrl` 这类规则时章名可能一字不变而章节地址已换，旧正文是用旧地址抓的——槽位（代际 + 章名）的章名那一半挡不住，只有代际能挡。这与「槽位刻意不含章节 url」不矛盾：那里排除的是**站点侧**的 url 抖动（时效 token，每次刷目录都换，入键等于正文缓存永不命中），这里是**规则侧**的 url 变更（钉子 `tests/services/reading.test.ts`「换 ruleChapterUrl 而章名不变」）。刻意**不含** `NovelSource.auth`：登录态刷新会让指纹变，整源缓存每次登录后全灭。**被否决的方案**：`JSON.stringify(rules)` 整体入指纹——赌键序、且改一条只影响搜索面的规则会连带清掉全部阅读缓存（过度失效）。
- **正文槽位含章名、不含章节 url**（`contentSlot(epoch, chapterName)`）：这是与代际正交的独立缺陷——正文曾按 `chIndex` 存，站点在前面插一章则全体 index 位移，旧文件端给读者的是**另一章**。代际管「规则变了」，章名管「站点侧目录变了」。刻意不含章节 url：带时效 token 的站点每次刷目录都换 url，入键等于正文缓存永不命中；章名 + index 稳定即命中，且串配照样挡住。为此 `getChapter` 的目录读取上移到缓存读取**之前**（槽位需要章名）。如实记代价：目录缓存命中时是一次文件读 + JSON.parse；目录缺失（首次 / 被 prune 淘汰，而 prune 是 mtime 近似、toc 文件写一次就不再被 touch 故淘汰得早）时会真发一次目录抓取——**热正文缓存不再能单独服务一章**。这是「槽位含章名」的必然代价，不是可优化掉的疏忽（章名只存在于目录里）。行为变化：越界 `chIndex` 现在先抛 `ChapterNotFoundError`，不再可能命中越界 index 的旧缓存文件。
- 钉子：`tests/services/cache-epoch.test.ts`（不过度失效 / 逐字段翻转——每个字段只影响它声称影响的面 / header 键序无关 / null 与空串不共用指纹 / baseUrl 入指纹）+ `tests/services/reading.test.ts` 的 `describe('缓存有效性：代际随规则走、槽位随章名走')`（同 id 换规则默认读取即新目录、换正文规则默认读取即新正文；章序位移不串配）。

落盘只有一条低层路径 `writeFileAtomic`：tmp + rename，**并按文件名排队串行**——并发 rename 同一目标在 Windows 上会 EPERM（实测 642 源并发导入时 25 次炸在 sources.json rename）。`writeJsonAtomic` 与 `PageCache` 共用它（历史分叉：PageCache 曾自抄一份无排队的 writeAtomic，阅读 + 导出并发抓同章实测 30/80 EPERM→500）。入队必须先于任何 `await`（含 mkdir），否则「最后写的最后落盘」不成立。

`readJson` 严格区分两种「读不到」：**ENOENT → fallback**（首启无 sources.json / shelf.json 是常态）；**存在但解析失败 → 备份 `.bak` + 日志 + 抛 `CorruptJsonError`**。绝不折叠成 fallback——那会让下一次 `edit` 用空表覆盖整文件，642 条源无告警消失。

### 10. 书架与书目字段集（`services/shelf.ts` + `shared/wire.ts`）

`shelf.json` 常驻内存镜像，写盘走 `createDebouncedWriter(100)` 防抖（进度高频更新只落最后一次）。

**阅读进度的写入口径是 last-write-wins**：`ShelfProgress.updatedAt` 只写不读，没有冲突裁决——「同一时刻只有一个读者」是本设计的前提（两窗口同开同一本会互相覆盖，属已知取舍）。正确性靠客户端侧保证：阅读位置在会话里是显式状态，落盘时机由单点收口（见 `docs/design/client.md` 的「阅读会话」节）。防抖窗口的代价由**卸载时 flush** 兜住：`ReadingService.flush()` 挂在插件 dispose 上（`src/index.ts` 的 effect），宿主重启前窗口里的最后一条进度不会丢；硬杀进程（SIGKILL）仍会丢，这是防抖写的固有边界。

**书目元数据字段集的唯一主人是 `shared/wire.ts` 的 `SHELF_META` 表 + `pickShelfMeta`**：9 个字段（`sourceId`/`title`/`author`/`coverUrl`/`intro`/`lastChapterName`/`kind`/`wordCount`/`totalChapters`）的「名称 × 类型判别 × 归一化」只准活在这张表里。三个消费方都从它派生——`Shelf.applyPatch` 遍历表做保值覆盖、`shelfBody`（客户端 body 构造）走 `pickShelfMeta` 整理形状、`dispatch.shelfPut` 把未知 JSON body 归一化。**加一个书目字段 = 只改这张表**（`Shelf` 与 dispatch 零改动）。**被否决的方案**：逐字段 `typeof` 筛键的各处抄本。

- `bookKey`（身份）与 `progress` / `addedAt`（系统字段）不属于元数据写口，**不进表**。
- `pickShelfMeta` 的口径：类型不符 / null / undefined / 未知键一律缺席；`totalChapters` 取 `Math.max(0, Math.floor(v))`，非有限数缺席；**空串保留**——「title 非空才加书」的分叉判别归调用方（`dispatch.shelfPut`）。
- 两种元数据写口：`add` = 不在架才插入、已在架即 **patch 语义**；`update` = 对在架书打补丁、不在架返回 `null`（不静默造书）。两者共用 `applyPatch`：**缺席 / 空值键跳过（保值），带值键覆盖**——新书构造也走同一函数，可选元数据缺席不落键。**被否决的方案**：`{...existing, ...input}` 展开——`: undefined` 的自有键会抹掉已有元数据。
- **来源投影（`ShelfEntry`）**：读取面条目 = 落盘 `ShelfBook` + `sourceName`，源名在 `shelfList()` 里**实时 join 书源注册表**（与 `SearchGroup.sourceName` 同一口径）；本地书与「源已被删」都投影成 `null`，客户端分别落成「本地」角标与灰字「来源已删除」。**刻意不进 `SHELF_META`**——那张表是「可 patch 的书目字段」的名册，投影既不可写也不落盘（进表 = 它变成能被 PUT 写进 shelf.json 的假元数据）。**被否决的方案**：加书那刻把源名快照进 shelf.json——零新机制、源删了也还留名，但 **按址去重会复用旧 id**（同址换规则/换源不换 id，见 §2），于是同一本书的来源名会静默陈旧，且刷新它需要重加书。代价如实记：源被删后书架只剩「来源已删除」，用户看不出当初是哪一家（要留名只能靠快照那条路）。
- **批量删（多选）**：写口 `Shelf.removeMany(keys)` 一趟裁掉命中项并**返回被删条目**（不是计数），因为连带副作用只该对真在架的书做；`ReadingService.removeBooks(keys)` 据此沿用单删那条「本地书连带删 `dataDir/local/` 副本」的 invariant（幽灵键不去动磁盘），返回 `{ removed }` 供前端如实报数。未知键静默跳过、重复键幂等——与源批路由同口径。**被否决的方案**：客户端循环 N 次 `DELETE shelf/:key`——一次「全选」就是几百个请求，且半途失败后前端手上没有可报的整批结论。

### 11. 规范值与缺键投影（`tools/project.ts`）

**wire 口径**：空值字段一律 `| null`（JSON 里 null 是在场的值），只有「可能整键缺席」的字段（时间戳、`statusDetail` 之类）保持 `?:`（`JSON.stringify` 会丢 undefined 键）。**这不是工具面的口径**。

**工具面口径**：`project()` 把规范值里 `null` / `undefined` 的字段**整键省略**（数组逐项、对象递归、原值不动，纯投影不改输入）。理由是 harness 对工具输出做 lossless-JSON 校验，`undefined` 属性值一票否决（整个工具调用报 "value is not lossless JSON"，真实结果被吞掉）。**这是 harness 约束下的职责，不是 wire 口径**——早期各工具的 `execute` 各自手抹六处，纪律靠抄。

代价如实记录：投影**改变类型**（可空字段变为缺席），故出参类型由调用方断言；schema 侧一致性由 `tests/tools/schema-contract.test.ts` 钉住（execute 输出过 harness 同款校验）。但**注意这条钉子的成色**：schema 属性集只有 **shelf 那一条**是从 `SHELF_META` 表真派生出来的（`schema-contract.test.ts` 的「这一条**从 wire 的 SHELF_META 表派生**」用例），其余五份是**手抄快照**——wire 改名时它们不会自动报错，需人工同步（机构上无法从擦除后的 TS 类型反推）。

### 12. 本地书身份（`services/localbooks.ts` + `shared/wire.ts` + `services/epub/`）

本地书有 **TXT 与 EPUB** 两支，落盘形态不同但身份与读取面同一套：`LOCAL_SOURCE_ID = '__local__'` 的**唯一主人是 `shared/wire.ts`**（跨半契约常量）：client 半与测试直接 import，服务半 re-export 保留既有路径——**不再有第二份声明**。为什么服务半可以有第二份而这里不许：client 纯度门拦不住服务半（`services/types.ts`、`reading.ts` 本就在引 shared），所以服务端那份从来不是构建约束逼出来的。bookKey 形态 `local:<uuid>`，`BOOK_KEY_RE` 严格 uuid 校验**兼防路径穿越**。

**① 按内容分流（唯一判据：文件头 4 字节）**。`PK\x03\x04`（ZIP 本地头签名）→ EPUB 路径；此后归档层与包层的**任何**失败都照原样上抛（加密位 / 符号链接 / 非 store-deflate / 重名 / zip-slip / 条目与解压超限 / 缺 mimetype / 坏 XML 都是这条路径上的失败），**不做 TXT 兜底**。不是 ZIP 魔数的字节才走既有 TXT 解码链（BOM → **UTF-8 `fatal:true` 严格探测** → GBK 回退，一字不改）。**被否决的方案**：「先试着开归档，失败就当 TXT」——那正是把归档层明令的**安全拒绝**吞成「不是 EPUB」，再让 GBK 兜底与「无标题单章」把一份加密 ZIP 落成整本乱码、以 200 入架，即本仓「失败冒充成功」的最坏形态。所以判据只看文件头，不看任何解析结果；缺 mimetype 的普通 ZIP 同属 EPUB 路径的失败，不为它开第二条路。另一面同样刻意：**不新增「二进制即拒收」的启发式**——那会让现网本来能读的 TXT（GBK 短篇、含控制字符的导出文件）变成拒收，比乱码更坏。TXT 解码链为什么不能复用 `fetcher.decodeBody`：它的兜底是 UTF-8，GBK 文件会乱码；本地文件也没有 Content-Type。`Buffer.toString('utf8')` 会把非法字节静默换成 U+FFFD，故必须用 fatal TextDecoder。

**② 落盘身份（两代形态，旧书零迁移）**：

| 格式 | 落盘 | 元数据（本地书目录下） |
| --- | --- | --- |
| TXT（既有形态） | `local/<uuid>.txt`（原文，重解码路径保留） | `local/<uuid>.json`：**没有 `schemaVersion`**——元数据缺席它就是 TXT，含 `ChapterSpan[]` 偏移表 |
| EPUB（新增） | `local/<uuid>/original.epub` + `local/<uuid>/documents/<opaqueId>.json` + `local/<uuid>/resources/<opaqueId>.<safeExt>` | `local/<uuid>.json`：`schemaVersion: 2` + `format: 'epub'`，含阅读序列、文档表、资源表、导航树、告警 |

- EPUB 的元数据**既是提交标记也是格式判据**（`isEpubMeta`）：缺 `schemaVersion` 的旧元数据继续按既有 TXT 读取，**不为 EPUB 改写旧偏移与进度**。
- 索引形状（`chapters` / `items` / `documents` / `resources` / `coverResourceId` / `warnings`）直接复用导入层的类型（以 `EpubImportData` 为准）（形状主人是 `services/epub/import.ts`），本地库**不抄一份字段表**——抄一份的下场是导入端加字段、读端不知道。
- 书目元数据（作者 / 封面 / 总章数）**不进本地元数据**：它们走既有 `SHELF_META` 字段集落 `shelf.json`（`bookMetaOf` 只挑 `author`/`coverUrl`/`totalChapters`）。**本地格式不新增可 patch 字段**——加一个 `format` 进 `SHELF_META` 就多一个能被 `PUT shelf/:key` 随意改写、与磁盘真相脱节的假字段（客户端卡片因此只说「本地」，见 `docs/design/client.md`）。
- 读取口径：TXT 按偏移切片 + **解码全文内存 LRU 上限 3 本**（Map 迭代序即 LRU 序；退化 span（相邻标题行 / 文末孤标题）`start > end` 时夹紧边界，保证只切出 `''` 而非负长度）；**EPUB 正文按文档读 JSON，不进这个 LRU**（整本塞进去等于两份缓存与两套失效口径），资源流式读取。

**③ 发布/提交协议（staging → rename → 原子元数据 → 入架）**。导入先在 `local/<uuid>.importing/` 建全部产物（导入器只写 `documents/` 与 `resources/`），原字节另存 `original.epub`，一次 `rename` 成最终目录，再原子写顶层元数据（**提交标记**），最后由门面 `localImport` 交 `ReadingService` 入架。失败只清理**本次 UUID** 的路径（staging / 已发布目录 / 元数据与它的 `.bak` / 同名 TXT 两件 / 原子写残留），绝不删 `local/` 之外的东西、绝不碰别的书的文件，也**不造书架条目**。**如实记的边界**：本地目录与 `shelf.json` 之间**没有**跨文件事务，不假装有——强杀恰在「元数据写完、书架落盘前」会留一份完整但未入架的副本，本轮不建恢复扫描器、也不用自动删除掩盖（见「已知开口」）。

**④ 读取面（门面动词，路由层与工具面都不持 LOCAL 知识）**：

- `getToc`：线性阅读序列（TXT 的旧响应一字不改；EPUB 按 spine 主序列，章名取文档标题），进度 / 逐章 API / 导出范围都按它。
- `getNavigation`：`chapters`（同一份线性序列）+ `items`（展示树）——EPUB 读持久化的原生 nav/NCX 目录，其他书（TXT / 在线）按 `planarNavigation` 派生平面树（单点在 wire，不在客户端重推导）。
- `getChapterContent`：EPUB 返回 `{kind:'rich'}`（按需读该章的文档 JSON），TXT 与在线书返回 `{kind:'text'}`。
- `getChapter`（文字面）：一律 `chapterContentToText(getChapterContent(...))`——**唯一投影**，导出、AI 工具与阅读器的文字出口共用它，不写第二份文字实现；rich 不另存一份文字（第二份字段一旦落盘就会与树分叉）。
- `getSupplement`：补充文档（脚注 / 附录）按 opaque 文档 ID 读规范化 JSON——不在阅读流里、不计章号。
- `getResource`：**只认不透明 ID**——先查持久化的资源表（查不到 = 404 类错误），再按表里的相对名打开文件；路径从不来自请求，打开成功后才返回流。字节数取**打开后 stat 的真实 size**（元数据里那份是导入期记的，文件被截断时按它发 `content-length` 会头体不一致）。表是 `JSON.parse` 出的普通对象，故一律 `Object.hasOwn` 查自有键——`constructor`/`__proto__`/`toString` 会命中继承成员，`ref.file` 取到 `undefined` 再 `path.resolve` 会抛成 500，而这里要的是 404。
- `readDocument`（章正文与补充文档共用）分两种缺席，**不是一条 404 兜到底**：表里没这个文档 ID → `LocalArtifactNotFoundError`（404，读者问的是这本书里没有的东西）；表说有、读出来的内容却对不上号（`kind` 不是 rich、或 `documentId` 与表不符）→ **裸 `Error` = 500，显式选定的**。为什么不是 404：那是服务端自己的存储坏了，报成 404 会把自损伪装成「没这份文档」，用户与我们都无从下手（宁炸不猜）。这条判定写在代码注释里，不是「分类器没管到所以落 500」。
- `getImportWarnings`：非 EPUB 恒空数组。

**⑤ 资源响应的安全头单点在 `api/dispatch.resourceHeaders`**：MIME 用**导入期的验证结果**（不是 manifest 声明），`x-content-type-options: nosniff`、`cross-origin-resource-policy: same-origin`、`cache-control: private, max-age=3600`；独立 SVG 额外附 `content-security-policy: default-src 'none'; sandbox`（重建过的静态文本仍按不可信文档对待）。不设 `content-disposition`——资源口只服务 `<img>`，**不提供任意原文下载**。断连即销毁本条流（不动别的请求）；头已发之后流上出错只能断连，但必须 `console.error` 留痕（吞成静默断连会让人对着「读了一半没了」猜原因）。

**⑥ 删除 invariant**：TXT 是两件文件、EPUB 是整棵 `local/<uuid>/` 目录加顶层元数据——两者都走同一份 `discard` 清点，**不会留下「只删了顶层 JSON、documents/resources 还在」的残骸**。存在性只看元数据文件在不在（不解析：损坏的元数据不该让删除/恢复路径也炸）。门面侧：`removeLocalBook` 与 `removeBooks`（批量）共用同一条「删副本 + 删书架条目」，**没真在架的键不碰磁盘**（幽灵键不去动文件）。

**⑦ EPUB 导入期的三条裁决（写下来才算裁决，否则与遗忘同形）**：

- **被剥除的活动内容只记告警，可见图形不支持才报错**——两者不是一回事。告警码（稳定标识，服务层原样持久化并展示；用户看 message、程序按 code 分流，同类同资源同动作会合并计数并把处数写在开头，免得成百上千处 `style` 属性把告警面变成噪声）：`epub-removed-active-content`（脚本 / 内嵌框 / 对象 / 表单 / 音视频 / 文档级装载指令）、`epub-active-attribute`（事件属性）、`epub-css-attribute`（`style` 属性与出版方 CSS）、`epub-link-not-followable`（`javascript:`/`data:`/`file:` 等不可跟随 scheme）、`epub-external-link`（书外链接取消可点击性、指向书内不可读资源的链接）、`epub-svg-image-page`（**整页只有一棵内联 SVG** 的图形页按其内唯一一张书内图导入，见下一条裁决）、`epub-navigation-synthesized`（无 nav/NCX，按 spine 合成平面导航）、`epub-navigation-degraded`（EPUB3 无 nav 退用 NCX）、`epub-encrypted-resource`（**未被用到**的资源被加密：留一条点名资源的说明；真被正文用到时导入失败并点名「被加密」而不是按混淆字节说成「损坏」）。前三条的铸造点在 `services/epub/documents.ts`（SVG 资源侧同码，见 `resources.ts`），中间三条（含 `epub-svg-image-page`）在 `services/epub/import.ts`，后三条在 `services/epub/package.ts`。
- **正文内联 `<svg>` 是「剥离 + 告警」，只有它是该文档唯一内容时才交回候选**（`epub-removed-inline-svg`）。理由是对称性：设计里的 SVG 条款讲的是交给浏览器的 `image/svg+xml` **资源**，而正文里的一层花饰/首字下沉若按「拒整本」处理，与同层的其它装饰性失败（`style` 属性、未知容器）极不对称，也与「纯图片阅读单元是有效正文」之外的一切「不静默」口径不符；代价如实记（这些文档会丢掉内联矢量图形，有告警点名文档与处数）。**剥离后没有任何别的可见节点时**，文档层**不再自己判生死**，而是交回 `svgOnly` 候选（那棵 `svg` 元素）——**裁决在编排层**，因为「这一页有没有内容」取决于里面那张图落不落得下，而资源事实只 `import.ts` 有：SVG 里恰好只剩一张 `<image>`（`resources.ts` 的 `soleRasterHref`，与独立 SVG 的**单图包装**同一份判据、不许有第二份抄本）且其 href 指书内可加载资源 → **导成单图章节** + 一条 `epub-svg-image-page` 说明；不是「只剩一张图」仍按 `svgOnlyPageReason` 拒整本，图在书外则点名「指向书外」拒（两种落不下的情形各说各的话）。**这条改判由真书反例推动（2026-09-26，Gutenberg #7337 图像版 `pg7337-images-3.epub`）**：EPUB3 推荐的整页封面写法就是「一层 div 包一棵 SVG，SVG 里一张 `<image>` 指向书内封面图」，而且同一张图另以 `properties="cover-image"` 声明——旧判据把这种书的**第一章**判成空章节，整本拒掉。「有没有可见内容」仍是**递归判**的（`documents.ts` 的 `hasVisibleContent`）：容器本身不算内容，`<p><svg/></p>` 与裸 `<svg/>` 走同一条路（只看一层的判据会被「包一层」绕过——2026 整分支评审定为合入前必修）；图算可见、非空白文本算、孤立的 `br` / `hr` 不算（那只是渲染出的一条空隙，没有可读的字）。候选面刻意**只认「恰好一棵」内联 SVG**（两棵就不是"整页图形"），也刻意**不在有正文的页里多落一张图**——钉子见 `tests/services/epub-import.test.ts` 的「有正文的页里夹一棵单图 SVG」。独立 SVG **资源**仍走白名单重建，白名单外的可见元素（`foreignObject` / `use` 外链 / 未登记的渐变引用）报错点名资源。
- **锚点随被剥离内容消失 → 降级 + 告警，不拒整本**（`epub-degraded-anchor`）：扫描期把被剥离子树里的锚点名单独记成 `strippedAnchors`（「这个锚点曾经存在」是一份事实），绑定期据此**导航目标降级成「该文档 + 无片段」**（跳到文档开头，导航仍可用）、**正文内链降级成纯文本**（只留子内容、不出 link 节点）。两者各自成条（同码不同动作是两件事），点名文档与锚点。**拼写错、指向从未存在的 id 仍然按坏书拒收**——降级只认「被剥离的内容里确实有过这个名字」；「宁炸不猜」针对的是「我们读不懂 / 没有这个目标」。
- **整页 SVG 页的两条配套口径**：① 被顶替掉的容器（`body → svg` 路径上那些带 `id` 的 `div`）各自的锚点**由替代出来的那张图承接**（`SvgOnlyPage.carriedAnchors` + `containerNode` 逐层包一层 div）——锚点是扫描期铸的，承载它的容器随整页 SVG 一起没了，不承接就是悬空锚点（落位退化成章首、目录当前项量不到）；② SVG **资源**按 **XML 类别的字节预算**读（`xmlBytes`，与 container/OPF/正文同档），不是图片那一档（`entryBytes` 32 MiB）——它要进解析器，按图片档读等于这道闸不存在。
- **SVG 里带命名空间前缀的 `href` 是引用、不是元数据**（`resources.ts`）：`xlink:href` 在渐变上是**继承**（引用另一处渐变的 stop），静默丢掉会让图形失去填充却报成功且无告警——照本层口径点名报错（与 `url(...)`、白名单外元素同一条）；`xmlns:*` 声明仍按元数据丢弃。
- **EPUB2 命名锚点（`<a name="x">`）也认**：元素声明的锚点名 = `id` + **仅 `a` 元素的 `name` 属性**（EPUB2/HTML 时代的命名锚点，锚点最终都重映射成 opaque ID，安全面没有差别）。别的元素上的 `name` 另有含义（表单控件名、`meta name=…`），把它当锚点是凭空发明。同一文档内重复锚点明确拒绝（目标会有歧义）。

其余导入期口径（章按 spine 主序列、补充文档**可达才解析**、图片先验证再转换、远程/损坏/超预算/被加密的引用图片报错点名资源、封面声明了却读不出即失败、未使用的 manifest 条目不要求受支持、所有条目先过路径/重名/加密/压缩方式闸再解压、CRC 与字节预算按实际累加）见 `services/epub/import.ts` 与 `services/epub/archive.ts` 的头注。

**⑧ 本地书的文字输出**：EPUB 的插图在文字面是 `[图片：替代文字]`（无替代文字则 `[图片]`）占位，不泄露资源 ID 与磁盘地址；导出面板与 AI 工具都只给文字（口径见 §13 与 `docs/design/client.md`）。

### 13. 章节范围导出（`services/export.ts` + `api/dispatch.ts`）

`exportBook` 是异步生成器：BOM 开头（Windows 记事本兼容）→ 按 `from/to`（1 基含端，**由调用方裁好**——见下「范围判据单点」）逐章 `getChapter`（**缓存优先语义即天然断点续传**）→ 段内每章后 `sleep(delayMs)`（k-1 次，段末章不睡）。**限流敬畏是第一原则：绝不并行抓章**。生成器内三条退出路径：`[from, to]` 不是 `toc` 的一段（空目录、越界、倒置合起来判）→ 抛 `导出范围越界：…`；单章抛错 → 输出 `[导出中断于第 k 章《名》：原因]` 后 `return`（失败即停，重跑只补缺章；**k 是全书绝对章号**，与目录、阅读器进度同一套坐标，不是段内序号）；`signal.aborted` → 直接返回。

**范围判据单点在 `dispatch`**（它要在首包前拿这些数写 `X-Novel-Total-Chapters` / `X-Novel-Range`，本来就必须自己算一遍）：`from/to` 非整数 → 400 `BadRequest`（先于目录抓取，快速失败）；toc 为空 → 首包前走错误信封（422 `EmptyToc`）；越界各自裁剪到 `[1, 目录长]`、裁剪后倒置 → 422 `BadRange`；否则发 200 + `X-Novel-Total-Chapters`（**本次范围章数，非全书章数**——面板进度标题按它显示）+ `X-Novel-Range: from-to` 后逐块写。被否决的旧形状：`exportBook` 里再抄一份 `clip` 与同一句「导出范围非法」——对唯一调用方恒等（`clip(clip(x)) === clip(x)`），是判据的第二份抄本；它换来的却是两条**静默**出口（空目录只发一个 BOM、倒置靠 clip 折回来），而「只有 BOM 的文件」在用户手里与「导完的空书」没区别。**空目录 / 越界 / 倒置三件事合并成一个前置校验**（说的是同一件事：范围不是目录的一段），既不留静默也不留第二份策略。`res.on('close')` → abort（浏览器关页 / 取消即停抓取）。背压等待 `drain` **前先查死连接**——destroyed 的响应不会再发 `drain`，挂等会吞掉断连取消。200 头已发后异常**不能走 `writeError`**（二次 writeHead 报 `ERR_HTTP_HEADERS_SENT`），就地补中断标记。

**导出的正文一律走 `getChapter`（文字面）**，所以图文书在这里是 `[图片：替代文字]` 占位（唯一投影 `chapterContentToText`，见 §12「本地书的文字输出」）：导出面板与 README 都明写「TXT 文字导出，不包含图片」，本轮不新增 EPUB / 图片导出（用户已确认的范围）。

### 14. wire 契约（`shared/wire.ts`）

**30 条路由**（25 条静态 `ROUTES` + 5 条参数 `paramRoutes`），**计数由 `tests/shared/wire-builders.test.ts` 钉死**——此前的「17 条路由」注释既腐烂又无测试，此前的「26 条」也是同一族腐烂（EPUB 面落地后补正）。`route(...segs)` 同时给出 `path`（客户端 fetch 用）与 `segs`（服务端段匹配与一致性测试用），同一构造保证一致。`SEG` 是路由段的唯一字面量来源，`PARAMS` 是 query 参数名的唯一字面量来源（此前参数名散在 dispatch 与四个 client 文件里各写一份，改名无处编译报错；`SearchView` 曾手拼 `shelf/${...}` 绕过 `paramRoutes`——活漂移）。批路由的 body 字段名随身份走：源批路由收 `{ ids }`（书源 id），书架批路由收 `{ keys }`（bookKey）——**bookKey 是 URL，走 JSON body 不必编码**（走路径就得 `paramRoutes.shelfKey`）。`shelf/:key` 与 `shelf/batch-delete` 的第二段不会撞：bookKey 形态只有 URL 与 `local:<uuid>`，都不等于 `batch-delete`。

**本地图文面（EPUB）的契约升级是一批同源的改名与新增，不做旧/新响应自动猜测**：

- `ChapterContent` 是正文的**唯一形状**（`{kind:'text'; text}` 或 `{kind:'rich'; documentId; nodes}`）：**`GET chapter` 已改回 `ChapterContent`**（原先只回纯文本），浏览器调用方与测试同批更新，不做「字符串 / 对象」双形态兼容——双形态兼容等于让客户端按形状猜语义。AI 工具与导出的文字面不受影响：它们走 `ReadingService.getChapter`，投影在服务端。
- 新增 `GET navigation`（`BookNavigation` = 线性 `chapters` + 展示树 `items`；入参与 `GET toc` 相同）——`GET toc` 的旧响应一字不改（工具面与导出仍按线性序列）。
- 新增本地三条读口，**路径段都不用 bookKey**（`id=bookKey` 走 query：`local:<uuid>` 里的 `:` 与 URL 里的 `/` 不必编码成段）：`GET local/document?id=&documentId=`（补充文档正文）、`GET local/resource?id=&resourceId=`（资源流，只认不透明 ID）、`GET local/warnings?id=`（导入说明，**按需查看**，不随每次取章重复携带）。`PARAMS.documentId` / `resourceId` 与 `id` 同归 wire 单点。
- 部署口径：Node 半与浏览器半是同一插件的**配套契约升级**，需 Node 重启后浏览器刷新，不能只热更新 client（`GET chapter` 的返回形状变了）。

**统一信封**：成功 `{ ok: true, value }`，失败 `{ ok: false, error: { code, message, segment? } }`。`segment = { facet, segmentIndex, segmentRaw }` 是**段级定位**——错误定位到出错的规则段，而不是产出错误的结果。

**后台搜索任务的读面形状**：`SearchJobSnapshot`（`id / keyword / phase / total / done / added / next / startedAt / finishedAt? / error?`）+ 两个上限常量 `SEARCH_HITS_CAP_PER_SOURCE`（每源 50 条）、`SEARCH_JOB_RETENTION_MS`（结果保留 30 分钟）。`cancelled: boolean` 是**给用户按「停止」准备的**：本轮立即 `phase=failed` + `error=任务已取消…`，但 UI 判「这是用户停的不是搜挂了」只认这个字段，不去比那句中文（刷新后重读同一轮也要能分清）。`phase` 与写任务的 `JobState.phase` 同一套词汇，所以 UI 的「还在跑吗」判据（`!== 'running'`）只有一种写法；`added`/`next` 是官方要求的可恢复游标（baseline / cursor / 显式 query 里的 cursor）。整轮结果本身**不上 wire**——那是服务层持有物。

**错误→HTTP 两分法**（不是「状态映射只许一处」）：

1. **domain / 引擎错误**：类 → `ErrorCategory`（`services/errors.classify` 单点）→ `STATUS_OF` 表 → 状态码 / 错误码。引擎三类与抓取两类用 `e.name` 当 wire 错误码；`RuleMissing` 在 HTTP 面与搜索面 / 探针是同一词汇。
2. **路由层自检错误**：`ApiError(message, status, code)` **自带 status/code、不进分类学**，直通（405 方法不允许、404 未知路由、400 body 校验、403 非受信来源、400 非法百分号编码……）。

分类权在**类型**上，不在中文文案上（`message.startsWith('源不存在')` 是历史形态：改错别字即改 HTTP 状态码）。路由侧不允许再 inline `writeJson(res, <状态码>, …)`——那会成为第三面。

**同源校验**（`api/wire.ts` 的 `isTrustedRequest`）：只放行 loopback 且（无 referer 或 referer 与 host 同源）且（无 origin 或 origin 与 host 同源）的请求。**无 referer / 无 origin 放行**是本机工具与 curl 的承诺；看 `Origin` 而不只看 `Referer` 的理由：恶意页可以 `<meta name="referrer" content="no-referrer">` 让 Referer 缺席，但浏览器对跨源 POST **总是**发 Origin——「Origin 存在且跨源」必须拒，否则 `content-type: text/plain` 的 simple POST（不触发 preflight）可 CSRF 打 import / batch / auth。

`readJsonBody` 的钉死：空 body → fallback；超限 → **413 只 throw 不 destroy**（destroy 会断 PassThrough 流）。`/sources/import` 单独把上限放到 32MB——真实书源导出文件常见数 MB（实测用户文件 4.8MB/642 源），默认 1MB 会把最大流量的包挡在门外。

## 数据流与时序

```
浏览器 / agent 工具
   │  queries.* / shelfBody.*（构造器归 wire，参数名与字段取舍同源）
   ▼
HTTP: POST/GET /novel-api/**         工具: dshnovel_* → project() 缺键投影
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
   ├─ LocalBooks（TXT 偏移表 + 解码 LRU；EPUB 发布/读取/资源流）
   │    └─ epub/（archive / package / documents / resources / import：只解析与规范化，不认识书架与 HTTP）
   └─ Fetcher（唯一出站口：超时 / 代理 / UA / 解码链）
        ▲
        └─ engineContextOf / makeSubEval ── engine evaluate（段级错误追踪、@js 沙箱）
```

- **搜索**：`searchProgressive(keyword, {sourceIds, onGroup, shouldStop})` 过滤 `enabled ∧ type==='text'` 源（参与集唯一判定 `ReadingService.participates` 谓词——**启用 ∧ 文本源**，本插件当前仅支持小说文本面；`[]` = 未限定 = 搜全部启用文本源）→ 按 `searchParallel` 分批 `Promise.all` → 每源独立 `searchOne`（catch 后只写该组 `error`，单源失败不拖垮整批）；`search()` 是收齐全部的薄壳。`searchPlan()` 是参与集判定的唯一主人（`startSearchJob` 也经它算 `total`，别处不再抄一份启停/形态谓词）。后台任务面另有两个动词：`startSearchJob(keyword, {sourceIds})` 提交一轮（交 `SearchJobs` 持有整轮结果）、`searchJobSnapshot(since)` 按游标读增量。
- **本地书**（`__local__`）：`getToc` / `getNavigation` / `getChapterContent` / `getChapter` / `getSupplement` / `getResource` / `getImportWarnings` 见 `sourceId === LOCAL_SOURCE_ID` 走本地书面、**不查注册表**；路由层零 LOCAL 知识（口径与落盘形态见 §12）。
- **阅读**：`getToc` 缓存优先（`refresh` 跳过；缓存键含规则代际，见 §9「缓存有效性」）+ **in-flight 去重**（同书并发只拉一次，`tocInflight`——键刻意**不含代际**：加宽它得把 `requireSource` 上移进公开 `getToc`，同步抛错会变成非 rejected promise、破坏 dispatch 的错误映射；缓存两侧都不可能脏，残余只是「与替换赛跑的那一次请求拿回旧目录」）；`getChapter` 先读目录（槽位需要章名）→ 越界守卫（双边：负数与超长都拦，HTTP 面有 `^\d+$`、工具面无下限，守门必须盖住两面入口；**先于缓存读取**）→ 缓存优先 + 多页串接 + Miss 抛 `RuleEvalError` 不吞。
- **目录 / 正文的翻页**：`followOrSingle` 在 next 规则为 `null` 时短路单页（无翻页发现能力），否则走 `followPages`（CONTEXT.md「判到底」）。next 规则按**取值用途**（`'value'`）求值、结果按**列表形状**处理（`pagination.ts`：逐项绝对化 + 去重 + 丢空）：单候选链式跟进、多候选全部抓取不递归。**两用途只在链尾裸词上分岔**（取值用途把末个未知词读成属性名、列表用途读成选择器），而现库 72 条 next 规则里裸词尾 **0** 条——这个分岔今天不可观测，别拿「列表语义」四个字去改那一参；停止判据按代码里的**实际次序**（每轮先防环再判上限，然后才取条目）：URL 防环 → 上限（`tocMaxPages` 200 / `contentMaxPages` 50，判在 extract **之前**，所以裁在 cap 那一轮不新增条目）→ 零新增（本页 0 条）→ 回环（本页有条目但 0 新增；**部分重复不停**——此前「出现重复即停」把站点页间重叠的真实页截断）。次序读错会让 `stoppedBy` 的归因不同（同一次迭代里 cap 与 zero-new 谁先命中），别照旧序抄。正文面串章闸：**目录知识优先**（候选「下一页」canon 后 == 目录里其他章节 URL → `chapter-boundary`；「下一页 == 下一章 URL 即 break」正判据）——路径启发式 `isSameChapterPage` 只在无目录知识时兜底，因为 `?id=..&cid=..&page=2` 这类非页码键分页会被启发式误拦（「一章只解析出一页」的根因之一）。
- **章节 URL 保留 `,{option}` 后缀**（URL 部分绝对化、选项原文接回）：目录落库不再 strip 选项（`absUrlKeepOption`：URL 部分绝对化、选项原文接回）；抓取时 `reading.fetchPage` 经 `assembleRequest` 单点解释选项（POST method/body、charset 进解码链、headers 合并）——API 型章节端点（POST body 模板）不再退化成裸 GET。`canonUrl` 是串章闸/防环的比对口径（剥选项 + URL 归一化）。
- **目录 URL 缺失逐章回退**：`ruleChapterUrl` 取空 → 该章地址回退**目录页地址**（该章缺地址时用目录页地址替代）——此前「url null → 整条丢弃」把这类源的目录清成 0 章（EmptyToc 桶的成因之一）。**但整本每一条都回退就不是缺链接，而是规则整体失效**：静默产出 N 条指向目录页自身的 toc 等于拿合法形状冒充成功（本仓镜像的宁炸不猜），故 `extract` 收口处判 `fellBack === out.length` → 抛 `RuleEvalError` 点名 `ruleChapterUrl` 与回退条数（2026-09 审查；钉子 `tests/services/reading.test.ts` 成对——混合形态仍逐章回退，不许改回整条丢弃）。
- **零命中不得静默**：正文规则取到空文本 → 抛 `RuleEvalError` 并带落点（请求地址 → 实际落地地址，两者不同即说明被跳转走了），**不写缓存**；缓存读取时空正文一律当未命中（旧版曾把站点跳转落地页的零命中写成 0 字节缓存，27 章全空到无感）。目录 / 正文规则缺失同样不降级 `?? ''`（空串规则会把整页文本当正文），宁炸不猜。
- **正文取值收口**（`services/content.ts`）：HTML → 纯文本时 **img 保留为地址行**（`<img src>`/`data-src` → 独立行，漫画/图片章节不再整章零命中）；藏在 `<noscript>` 里的 img 同样取回——domhandler 把 noscript 内容按 raw text 解析（`find('img')` 为 0），下钻那层文本等于把字面 `<img src="…">` 当正文吐给读者，故正文面把那层文本**再解析一次**再走行规约（`engine/dom.ts` 的 noscript 分支）；非 HTML 形态含预转义实体时白名单解码（`&nbsp;`/`&#8220;` 等，未知实体原样——不猜）；**解出来仍像 HTML 就在同一趟转成纯文本**——`&lt;p&gt;…` 这类预转义正文若只解码不收口，产物就带标签，违反「产物不含标签」的幂等前提，而 `reading.getChapter` 对缓存还要再收一次口，第二趟会把段落当标签吞掉（同一章在缓存前后长得不一样的根因）。
- **值投影（服务层侧）**：引擎的 `EngineValue` 到服务层字符串只有三个出口——`firstValue`（单值：miss→null、value→text、list→`join('\n')`、matches→每行首列）、`firstUrlValue`（**URL 位**：list 取**首项**，其余四态同 `firstValue`）与 `extractItems`（列表页条目：nodes→逐节点 HTML 片段、list→逐项、matches→行 `join('\t')`、miss→`[]`）。`nodes` 落到单值出口是错误而非数据，抛带 facet 与节点数的 `RuleEvalError`（`segmentIndex = -1` 表示服务层规约层，不是规则某一段）。**URL 位为什么要单开一个出口**：对面的 URL 取值取 `list[0]`，多值 join 只服务非 URL 取值——把多命中地址 join 成多行串会被 `absUrl` 的换行守卫判死，表现为「搜到了却没有地址」（对读证据与逐源读数见矩阵行 `b-url-value-first-item`，2026-09-28 审计实测 8 条文本源）。字段侧入口按「吞不吞错」乘以「是不是 URL 位」分四个：`fieldOf`/`urlFieldOf`（不吞）与 `auxFieldOf`/`auxUrlFieldOf`（读不出留空）。空态裁决口径见 `CONTEXT.md`「取值规约」（取位失败 → Miss；解析到空集合 → 空 List），唯一实现在 `engine/select.ts` 的 `reducePicked`——服务层不复制这套判定，只消费结果。

### 工具面与 HTTP 面共用 service 层的证据（不存在第二套实现）

- `tools/tools.ts` 只 `import type { ReadingService }`，全部 `execute` 都是 `service.search / getToc / getChapter / importSource / probe / shelfList` 的调用 —— 没有任何一处自己发 fetch、自己读 `sources.json` / `shelf.json`，也没有第二份规则求值。
- 探针的耐心值、入库规则（`SourceIntake`）、越界判定（`ChapterNotFoundError`）都在服务层单点：工具面 `dshnovel_read` 只调 `getToc` + `getChapter`，越界报错由服务层抛；`dshnovel_import_source` 只做「JSON 文本 → `importSource` → `project`」。工具面自己拥有的校验只有 action 枚举工具的 `requireArgs`（action 对但参数缺 → 抛「缺少参数」，不静默兜底——同「宁炸不猜」精神）。
- 唯一由工具面**自己**拥有的语义是「缺键投影」（`tools/project.ts`）与各工具的 render 文本投影——因为它是 harness 输出 schema 的约束，不是业务语义。规范值（`service` 返回的完整 JSON）在投影前不被裁剪，render 只是规范值的文本投影。
- 反向验证：`tests/api/routes.test.ts` 断言 `SEG` 每一段都被某条路由用到（无孤儿段、无手抄段）。而工具 schema 侧的对应断言**只有六分之一是真绑**（见 §11）——`schema-contract.test.ts` 里除 shelf 外都是手抄快照。

## 构建、装载与验收

**`lib/` 是构建产物且不入库**（`package.json` 的 `files` 只含 `lib` / `cordis.patch.yml` / README / LICENSE；`main` 指向 `lib/index.js`）。构建是 `tsdown` 双配置（`tsdown.config.ts`）：host 半 ESM + dts，client 半 CJS 单文件闭合工厂（`window.__ModuleLoader__.load({ id: '@xrn1997/dsh-novel', factory: … })` 三段式 banner/intro/footer）。client 半带**构建期纯度门**：Node 内建与平台模块表之外的 `@deepseek-ai/*` 值 import 一律构建失败——这也是 `shared/wire.ts` 必须零运行时依赖、只许 type-only 依赖的原因（client 半会把整个文件 inline 进 bundle）。

缺失 `lib/` 的报错形态：`dsh: plugin tree failed to load` + `ERR_MODULE_NOT_FOUND` 指向 `lib/index.js`——**整个插件树拒绝挂载（`dsh web` 直接启动失败），不是静默降级**。

三种安装路径的差异必须记住：

- **npm 安装**（`dsh plugin add @xrn1997/dsh-novel`）走预构建产物，秒装、无需构建授权。
- **GitHub 源码安装**（`add github:xrn1997/dsh-novel`）由 `prepare` 脚本（= `tsdown`）自动构建；pnpm ≥10 首次安装可能报构建脚本被拦截（依赖已装但 `lib/` 未生成），需先在 profile 目录 `pnpm approve-builds --all` 再重跑安装命令。
- **本地目录 / `link:` 安装**（`add link:<path>`）**pnpm 只建目录链接、绝不在对端跑 `prepare`**——必须在源码目录手动 `pnpm build` 一次，否则 `dsh web` 起不来。

**`pnpm test`（常规集）覆盖什么**：引擎规则求值、服务层语义、API 路由与信封、工具 schema 契约、Cordis 入口、前端逻辑与 smoke（`vitest.config.ts` 排除 `tests/compat/**` 与 `tests/packaging-build.test.ts`）。**不覆盖什么**：任何真实站点可用性、真实安装链路、构建产物自检——它只用注入的假 fetch 与合成 HTML。

**四条默认关闭的真链路门控**（`describe.skipIf`）外加一条浏览器验收门，各自的承诺边界：

| 门控 | 跑法 | 承诺边界 |
| --- | --- | --- |
| `DSH_REPROBE=1` | `pnpm vitest run tests/reprobe.test.ts` | 对 `sources.json` 全量真发搜索请求，得出**当前网络 + 当前源集**的 verified 率与失败分布。真实访问网络、数分钟量级；结论随时间与代理环境漂移，不是回归断言。 |
| `DSH_CONTENT_AUDIT=1` | `pnpm vitest run tests/content-audit.test.ts` | 对 `sources.json` 全量跑**搜索 → 目录 → 正文（多章采样）**全链路（enabled 全置 true——审计问「链路通不通」，不问启停），逐源按 stage + 错误类分桶，报告落 `.superpowers/content-audit/`（过程产物不入库）。**「verified」只证明搜索面**——正文可用率以本审计为准，注意它是**报告不是通过率门**：分桶读数给人判，代码只断言每个注册源都进了 stage（漏审即红）。真实访问网络、十几分钟量级。 |
| `COMPAT_CAPTURE=1` | `pnpm vitest run --config vitest.compat.config.ts tests/compat/capture.test.ts` | 把真实站点抓成 fixture 快照（按 `compat/README.md`「脱敏规程」处理后才落盘——刀数与键名单只在那一份里数，别处不再抄）。采集与回放**必须同关键词**（manifest 已记）；落盘的是**生产解码链读到的文本**（2026-09-28 起：GBK 等非 utf-8 页存成真中文。此前只存 utf8 原文，GBK 页存成乱码——采集侧断言跑在真解码链上、回放侧一律以 utf-8 供文本，于是「采集能过、回放必红」；旧句子「GBK 源 v1 直接失败」已作废）。 |
| `DSH_INSTALL_CHECK=1` | `pnpm vitest run tests/packaging-install.test.ts` | 真跑 `dsh plugin add`（一次性 profile `novel-smoke`）→ 断言 bundles 挂载 + `lib/client.js` / `cordis.patch.yml` 就位 → remove。测试自己先 `pnpm build`，忠实复现「源码目录装入」流程。 |
| `DSH_EPUB_BROWSER=1` | `pnpm vitest run tests/browser/epub-reader.test.ts` | 真浏览器验收图文阅读（EPUB 的目录抽屉 / 注释面板 / 内链返回与落位）。**它不在上面四条里**：跑的是本机浏览器与本地书，不访问任何站点，也不代表站点可用率 |

`pnpm test` 全绿 = 引擎 / 服务 / 契约 / 前端逻辑成立，**不等于**任何真实站点可用，也不等于安装链路成立。

**compat 回放的分母口径**：`compat/report.md` 的「跑通率」分母是 `compat/fixtures/` 下的 fixture，当前树只有 1 条手写合成 fixture（`demo-site`，域名 `demo.local` 不存在）——它是**规则引擎离线回放的回归基线**，**不代表任何真实站点兼容率**（不覆盖真实 HTTP / 重定向 / GBK / 超时 / 反爬 / `@js` 真实宿主）。`compat/sources/` 目前为空；站点可用率请用真机重探（`DSH_REPROBE=1`）或投放真实源后走「投放 → 采集 → 复算」三步闭环。

**验收口径（原 v1 设计文档 §4.6 的条款；那份文档已出库，此条仍成立）**：**compat 回放跑通率是 v1 的验收标准本身**——本目录把「率」变成可一键复算的数字。与之并列的两条：常规门禁 `pnpm test` + `pnpm typecheck` 全绿，以及真安装链路 `DSH_INSTALL_CHECK=1` 通过（DoD#1 属**人工验收**，自动化对应物就是这条门控）。注意验收标准是「率可复算 + 分母口径讲清」，不是「率等于 100%」——当前分母只有合成 fixture，真实站点兼容率需要投放真实源才能谈。

## 测试钉子短表

| 测试文件 | 钉死什么 |
| --- | --- |
| `tests/shared/wire-builders.test.ts` | 路由计数 25 + 5、`LOCAL_SOURCE_ID` 持久化值与跨半同源、`encodeQuery` / `queries`（含 `searchJobStatus(since)` / `searchJobStream(since)` 同一条游标）、`searchJobCancel` / `shelfBatchDelete` 的 path/segs、`shelfBody` 的参数名与字段取舍、`SHELF_META` 键集、`pickShelfMeta` 判别与归一化、shelf 路径必须走 `paramRoutes.shelfKey` |
| `tests/api/routes.test.ts` | `ROUTES` → 真实 dispatch 落点逐条；405 / 404 / 400 三态；local part 缺席 → 503；`SEG` 无孤儿段 |
| `tests/api/wire.test.ts` | 同源 fence 四态；`readJsonBody` 的 400 / 413；`errorStatusOf` 全类目映射与 segment |
| `tests/api/dispatch-sources.test.ts` | 导入任务 → jobId → job-status → done；结果保留；409 JobRunning；旧同步路由 405；body 校验；大包不 413 |
| `tests/api/dispatch-reading.test.ts` | search / book / toc / **navigation** / chapter 落点与 400（`GET chapter` 回的是 `ChapterContent`，契约升级后不做双形态兼容）；**search/job 面：提交/快照/SSE/取消四条路由的方法守卫、keyword 与 sourceIds 校验、终态快照形状、`since` 游标语义（超前夹到末尾、非法当作 0）、只留最近一轮；SSE 帧体=同一份快照、只含本轮、终帧后服务端关流；`POST search/job-cancel` → `{cancelled}`，取消后本轮分组仍整轮可读、二次点击是空操作**；shelf 三形态 PUT 与 `patch` 单字段回写；`sourceId` 必填；progress 值域；**`POST shelf/batch-delete`：一趟删多本 + 未知键静默跳过、body 非法（空/缺 keys/非字符串）400 与 GET 405、`GET /shelf` 的 `sourceName` 投影（join 到源名 / join 不到 null）** |
| `tests/api/dispatch-local.test.ts` | 本地 TXT 的 HTTP 面：导入自动加书架（`sourceId=__local__`）、toc/chapter 分流（`__local__` 不查注册表）、GBK 回显、本地读口（warnings 空数组 + document/resource 404）、缺参 400 / 方法 405、空文件 400 与超限 413、`DELETE local`（删文件 + 书架条目消失）、shelf DELETE 连带删副本 |
| `tests/api/dispatch-export.test.ts` | 流式头（BOM / Content-Disposition / X-Novel-Total-Chapters）与两章正文；toc 失败走错误信封（非流） |
| `tests/services/intake.test.ts` | 入库四裁决（added / replaced / skipped×2）与替换复用 id、清同键残留、`dedupKey` 口径 |
| `tests/services/sources.test.ts` | `edit` 原子性与合并落盘（不 flush 磁盘未写、20 次阈值强制落盘、并发 edit 不交错、recipe 抛错仍标脏）；`toPublic` 凭据红线；load 九条存量归一 |
| `tests/services/import-job.test.ts` | 单槽互斥与结果保留、issues 截断 200、坏文件不拖垮、导入不探针、批量验证并发 ≤5 与运行中删源；**宿主登记三钉**（kind/label、取消 → 宿主结算 `killed`、自然收尾 → `completed`） |
| `tests/services/search-job.test.ts` | 游标增量读面（`added`/`next` 跟着走、超前只给空增量不报错）、**subscribe 事件口（新一轮 / 每次 emit / 终态各响一次、退订后不再打扰）**、每源命中截断而 `done` 计数不受截断影响、只留最近一轮（新提交替换旧的、旧的读不出来）、结束过保留期读作「无任务」不伪装成零命中、`cancel` 立协作式旗并落 failed 带原因、宿主登记 kind `novel-search` 与 `completed`/`killed` 两种结算；**停止的另一半**：`cancel()` 置 `cancelled` 后已 emit 的分组照旧整轮可读、再点为 `false` 空操作 |
| `tests/services/reading.test.ts` | 搜索分组与空数组语义、重定向按落地地址、目录两页翻页闸与缓存、正文规约与零命中报错不写缓存、**目录 URL：逐章回退保留但整本全回退 → `RuleEvalError` 点名 ruleChapterUrl**、ruleDetail* 回退、`__local__` 分流、防孤儿删书、探针同耐心；**`searchProgressive` 的增量出口与 `shouldStop`（批头收手 / 条目头跳过该源）**；**缓存有效性（同 id 换规则默认读取即新目录、同 id 换正文规则默认读取即新正文、章序位移正文不串配）**；**书 URL 承载请求选项（命中保留 `,{option}` + getDetail 按选项真发 POST）**；**详情上下文 init（换根命中字段 / 零命中宁炸点名 ruleDetailInit / 纯 `@put` 形态只设变量不换根、随后 `@get:{k}` 字段与目录在同一份 vars 上求值）+ tocUrl 模板按 init 上下文插值 + 存量缺键直通**；**js 预算三态（jsTimeoutMs 小预算点名「脚本超时（>Nms）」/ 缺省放行 >2s 的重型多请求脚本 / 搜索面与探针同口径）**；**门面直测：`removeBooks` 批量删沿用「本地书连带删副本」invariant（未知键静默跳过）+ `shelfList` 来源投影（源名实时 join、源一删投影即刻 null、本地书恒 null）** |
| `tests/services/probe.test.ts` | 逐词重试与 broken 口径、**`checkKeyWord` 排第一（合法值）与非法值导入期弃用**、规则缺失是结果、charset 解不出 `DecodeError`、超时覆盖、**书名 usage 与搜索面一致**（`ruleBookName` 以属性终端收尾时不误判 `broken: 首条书名为空`） |
| `tests/services/search-face.test.ts` | 条目提取 + landedUrl、规则缺失结果形态、按次超时、POST 选项透传、错误码投影 |
| `tests/services/search-book-url-pattern.test.ts` | **详情页嗅探**：整串命中才走 info（部分命中不算）、判定用落地地址、列表 0 条且未声明 pattern 才回落、声明未命中不回落、缺 ruleBookList 不是 RuleMissing、**未声明 ruleBookInfo.name 不开 info 形态（不造假书目）**、坏正则 warn 点名、`bookUrl` 两分支（保留 `,{option}` / 落地地址）、info 形态的一条书目（字段走 ruleDetail*、书名空则 0 命中不报错）、**探针按 via 分岔**、**回落遇 init 零命中 → 0 命中而不是整源搜索错误** |
| `tests/services/request.test.ts` | 选项切分（含逗号空格、单引号 JSON、双重编码 headers）、**未知选项键 warn 点名 / 全支持键零 warn**、POST 表单默认头、charset 透传、相对 URL 绝对化、`trimFirstPage`、`stripUrlOption`、`@js` 模板三形态 |
| `tests/services/fetcher.test.ts` | 非 2xx / 网络 / 超时 → `FetchError`；代理 dispatcher 有无；缺省 UA 与调用方覆盖；解码链四优先级 + 空串声明；`headerOf` 的 Cookie 合并 |
| `tests/services/cache.test.ts` | toc / content 往返与按章 + 槽位隔离（换代际 / 换槽位即换文件）、prune 按 mtime 淘汰、`safeKey` 长短形态 |
| `tests/services/cache-epoch.test.ts` | 指纹按面细分（改搜索面字段不动阅读代际、改目录 URL 规则不动正文代际——正文对目录的依赖走槽位章名、改正文规则不动目录代际）、header 键序无关、baseUrl 入指纹、逐字段翻转（每个字段只影响它声称影响的面）、null 与空串不共用指纹、槽位随章名 / 代际变 |
| `tests/services/storage.test.ts` | `novelDir` 两态、原子写无 `.tmp` 残留、并发写串行、损坏文件抛 `CorruptJsonError` + `.bak`、防抖合并、**命名约定的唯一住址**（`tempPathOf` 产出的裸名恰是 `isAtomicTemp` 认的那一个；备份名与 `readJson` 实际留下的一致——删书的清点按这两个判据扫残留，不再各抄字面量） |
| `tests/services/shelf.test.ts` | add 往返与 patch 语义（缺席键保值、显式 undefined 不抹值）、progress 防抖、不在架 `null`、`removeMany`（返回被删条目、未知键跳过、重复键幂等、落盘一次） |
| `tests/services/localbooks.test.ts` | 解码链四态、切章正则诸形态、`local:` 形态防穿越、LRU 3 本、越界明确报错、零内容章不产生负长度（HTTP 码与错误体不归本文件，见 `tests/api/dispatch-local.test.ts` 与 `tests/services/error-taxonomy.test.ts`）；**按内容分流**（ZIP 魔数走 EPUB、**归档失败不被吞成 TXT 乱码书**、GBK 回退维持原样不新增「二进制即拒收」启发式）；**发布/提交**（归档失败回收本次 UUID、提交标记写失败回收刚发布的目录（用例标题「提交标记（顶层元数据）写失败」）、旧 TXT 无 schemaVersion 照读、EPUB 可重启读）；**整棵删除**（EPUB 目录 + 元数据 + 损坏备份一次清光，只删顶层 JSON 留残骸即红） |
| `tests/services/epub-archive.test.ts` | ZIP 安全边界：zip-slip / 绝对路径 / 盘符 / 反斜杠 / 重名 / 符号链接 / 加密位 / 非 store-deflate / CRC 损坏 / 声称大小不符 / 条目与字节预算（**含真实 10_000 边界两向实证**：正好 10_000 条打得开、10_001 条被拒并点名越界那条）、截断包——每项精确断言错误且**无成功输出** |
| `tests/services/epub-package.test.ts` | 包结构：按 spine 阅读（不按 ZIP 顺序或目录叶数）、linear=no 不进主序列、同文档多锚点各自成条、landmarks/page-list 不混入、EPUB2 NCX / EPUB3 nav 优先级与降级、命名空间前缀、路径与百分号解码、BOM/声明编码（非法字节不猜） |
| `tests/services/epub-documents.test.ts` | 文档层（XHTML → 白名单图文树，不碰文件系统也不认识包）：b/i 规范成 strong/em、数字属性只认合法整数、raw attributes 一律不上树、实体只解一次、原书 id 只进锚点映射（节点 ID 一律 opaque）、纯插图文档是有效正文、没有 body 的文档报错；**剥离必须留告警**（脚本等活动内容 / 事件与 style 属性 / 内联 SVG 剥整棵子树，同类多处合并计数）、**内联 SVG 是文档唯一内容 → 交回 `svgOnly` 候选**（本层不裁决：那张图落不落得下要问资源；两棵 SVG 不算候选、仍报错）、**空壳容器不算内容**（`<div><section><script/></section></div>` / `<p><br/></p>` 一律拒；深处真有字或图才成立。`<p><svg/></p>` 走候选——`<p>` 包一层不改变"整页就是一棵图"这件事）、被剥离子树里的锚点名进 `strippedAnchors`（锚点降级的事实来源）、**EPUB2 命名锚点 `<a name>`**、同文档重复锚点即拒、**只读解析的三条边界**（注释里的 `&nbsp;` 不是引用、多根元素即拒「不按半途结果读」、十几万节点的宽文档逐项追加不撞参数上限） |
| `tests/services/epub-import.test.ts` | 图文规范化与资源：主序列计章 + 补充文档不计章、目录目标绑锚点且锚点真在产物里、粗斜体/列表/表格跨行跨列/pre/sup/sub、共享图片只落一份、封面优先 cover-image、**安全面拒绝要精确点名**（远程图 / 损坏图 / 坏封面 / 重复锚点 / 失效锚点 / 失效链接 / 内联 SVG 是唯一内容且里面不是一张书内图 / 整页 SVG 那张图在书外（点名「书外」而不是泛话）/ foreignObject / use 外链 / 加密资源 / 超深超宽 / 像素超预算）、**安全去除项必须有告警**（脚本等剥除、内联 SVG 剥离 + 告警、**锚点随剥离内容消失 → 降级 + 告警**、锚点从未存在仍拒整本）、**整页图形页按那张图书导入**（真书 fixture `epub3-svg-cover-page`＝Gutenberg #7337 的封面页形状：章按 spine 照计、图与声明的封面共用一份资源、留 `epub-svg-image-page` 且**不再**报「移除了内联 SVG」；反例钉子：有正文的页里夹一棵单图 SVG 仍只剥离+告警，`resources` 一个都不许多落；**容器带的锚点随图落到树上**——目录指向 `#cover` 时不是悬空锚点）、**SVG 资源按 XML 类别的字节预算读**（默认预算下同一份样本导入成功、`xmlBytes` 收到 1 KB 即拒——只断言「拒了」证明不了拒的是这一类上限）、EPUB2 命名锚点 |
| `tests/services/epub-resources.test.ts` | 图片验证与受限 SVG 重建：魔数/MIME/尺寸/像素预算、EXIF 旋转、白名单外可见元素报错、**命名空间 `href` 引用（渐变继承 `xlink:href="#base"`）报错不静默丢**（`xmlns:*` 声明照旧按元数据丢弃） |
| `tests/services/epub-warnings.test.ts` | 告警合并器的两条边界：处数如实累加（同码同资源同动作合并、重复细节不重复占例子位、键不同各成一条）、**例子最多三个且不限制处数**（无界收集实测会把三万条外链的正文同步阻塞十几秒） |
| `tests/services/chapter-content.test.ts` | `chapterContentToText` 唯一投影：text 分支逐字通过、块级换行、表格单元格制表符、链接只留文字、**图片输出 `[图片：替代文字]` / `[图片]` 且不泄露资源 ID**、**行内上下文（链接/行内元素）里的块级内容仍按块投影**（pre 逐字、表格行制表符、`rule` 收行） |
| `tests/api/dispatch-epub.test.ts` | 真实 HTTP 上的图文链路：导入回执 = `LocalImportResponse`（书名/作者/封面 + 章数/格式/编码/告警，并自动上架，用例标题「导入回执是 LocalImportResponse」）→ `GET navigation` / `GET chapter`（`ChapterContent`）/ `GET local/document` / `GET local/resource`（MIME 与安全头、404）/ `GET local/warnings`；图文读取与文字读取共用同一份内容；失败面（坏 EPUB 400 不留痕、ZIP 加密条目 400 不入架、`.txt` 名字的合法 EPUB 走图文）；删除（`DELETE local` / shelf 单删 / 批删）连带删整棵目录与元数据 |
| `tests/services/pagination.test.ts` | URL 防环 / 上限 / 零新增 / 回环（整页零新增）/ 串章（stopUrls 目录知识**取代**启发式——两闸同供时启发式不参与，非页码键分页照常跟进）/ next 列表语义（多候选不递归）/ 页间部分重叠不停 逐一 |
| `tests/services/chapter-page.test.ts` | 同章后缀形态、下一章拦下、标准页码查询放行、判不准拦下 |
| `tests/services/url-option.test.ts` | `,{option}` 后缀切分（严格/单引号 JSON、正文 `{a,b}` 不误剥）、`absUrlKeepOption` 绝对化接回、`canonUrl` 比对口径 |
| `tests/services/intro-format.test.ts` | `formatIntro`：块级换行与标签/注释删除、空白实体转换、段首统一缩进与 5000 截断、**详情面 `<usehtml>/<md>/<useweb>` 前缀原样保留（含大小写与前导空白）**、**搜索面不豁免** |
| `tests/services/toc-url-option.test.ts` | `ruleBookInfo.tocUrl` 带 `,{option}`（多行选项 JSON + baseUrl 插值 / 静态两种）→ 目录请求打到干净端点且 POST 选项生效，任何一次请求都不带被并进 URL 的选项串 |
| `tests/services/content.test.ts` | `looksLikeHtml` 白名单（纯文本正文不误伤）、`htmlToText` 块级换行与脚本/样式整树丢弃、`contentToText` 的 **img 保留为地址行 / noscript 内 img 取回地址而非字面标签 / 预转义实体就地解码且未知实体原样**、**幂等：产物不含标签，二次收口必直通（含 `&lt;p&gt;` 预转义 HTML 串）** |
| `tests/services/export.test.ts` | N-1 次节流与章格式、失败即停无后续请求、abort 零请求、toc 抛错透传、**范围由调用方裁好 + 空目录/越界/倒置合并成一个前置抛（不再有「只发 BOM」的静默出口），且校验在任何抓取之前（零请求）** |
| `tests/services/error-taxonomy.test.ts` | 每个错误类的类目 / HTTP / ProbeErrorCode 三投影；新类目忘进表编译期报错 |
| `tests/services/normalize.test.ts` | 三方言映射、必填校验、warning 口径、`checkKeyWord` → `probeKeyword`（非法值弃用）、`bookSourceType` 拒绝非文本**与认不出的编码（`unknown`）**、分组拆分与图标剥离、**字符串化规则容器（对象照常 / JSON 串再 parse / `"null"` 与数组静默缺席 / 坏 JSON 点名不炸导入 / 字符串化里的 `replaceRegex` 照样拼 `##` 尾）** |
| `tests/tools/schema-contract.test.ts` | execute 输出过 harness 同款校验；schema 在 harness 强制子集内；wire 绑定只对 shelf 成立（表派生），其余五份是手抄快照 |
| `tests/tools/tools.test.ts` / `project.test.ts` | 六工具名（含 `dshnovel_` 前缀断言）与输出形状、注册与 disposer、投影的整键省略与不可变性 |
| `tests/index.test.ts` | 插件身份与 Config schema、值域校验加载期失败、ready 后注册与 disposer 摘净、双重启用防御；**三类任务真抵达宿主**（假 `ctx.jobs` + 真 http 口跑 `sources/import`、`sources/batch-probe`、`search/job` → 记到 `job-start` 的 kind 恰是 `novel-import`/`novel-probe`/`novel-search`）——`create → from → SourceJobs/SearchJobs` 这条 host 传递链上任一跳丢参数，其余全部用例（当批 1410 条）仍然绿（各单测直构持有者、门面测试不传 host），只有这条红；**jsTimeoutMs schema 透传与值域（≤0 加载期响亮）** |

## 已知开口

按「代码为准」记录与旧文档冲突处，以及需要决策的未决口径。

1. **段匹配读的是 `SEG.*`，不是 `ROUTES.*.segs`**（`src/api/dispatch.ts` 的 `import { NOVEL_API_PREFIX, PARAMS, paramRoutes, pickShelfMeta, ROUTES, SEG }`，全文段匹配用 `SEG.sources` 等）。`ROUTES.*.segs` 的**生产消费者为零**，只有 `tests/api/routes.test.ts` 的用例「SEG 每一段都被某条路由使用」用它做命名空间校验。功能等价（`segs` 本就由 `SEG` 构造，路由段字面量仍单点）——但写新路由时别以为存在第二份权威。
2. **仓库没有 CI**（无 `.github/`）：`pnpm test` / `pnpm typecheck` / 四条真链路门控全靠人记得跑，而门控默认 `describe.skipIf` 关闭。一次「只跑常规集」的提交就足以让构建产物或 compat 回放静默退化——改动抓取 / 引擎 / 打包链路时，那四条门控是**唯一**的自动化验证，别省。
3. **旧 spec 声明 `AuthRequiredError`（「需登录」错误类），实现里不存在**——`services/errors.ts` 无此类，`classify` 无对应类目。**2026-09-28 核：那条「声明」在当前仓里查不到**（全仓只剩两处**文档**提到它：本节与 `engine.md` #13，且两处都写着「实现里不存在」；旧 spec 已出库）→ 所以「把声明撤下」**没有可撤的对象**，真正的选择是：**A 补**「需登录未配 auth」的探测启发式（要定它探哪一层信号——HTTP 状态码 / 响应体特征 / 源自己声明的 `loginUrl` + 空结果组合；代价是启发式天生会误报）／**B 什么都不做**（现状：这类源表现为站点侧失败，审计里如实暴露，不猜）。本轮不擅自发明启发式。 **待裁（在册，即 D8 的小项之一）**：A 补探测启发式（HTTP 状态码 / 响应体特征 / `loginUrl` + 空结果组合，代价是启发式天生会误报）／B 维持现状（这类源表现为站点侧失败，审计里如实暴露）。**推荐 B**。
4. **旧 spec 称探针返回「分段 trace」，实际 `ProbeResult` 无结构化 trace 字段**（只有 `error.message` 里的段级文本 + HTTP 面的 `segment`）。修法需先定探针输出形状。 **待裁**：修法要先定探针输出形状（结构化 trace 字段进不进 `ProbeResult`）。**推荐维持现状**——段级文本已在 `error.message`、HTTP 面已有 `segment`，在没有按段渲染的消费方之前加字段等于造没人读的 schema。
5. **真实站点兼容率仍无数字支撑：分母只有 1 条合成 fixture**：`COMPAT_CAPTURE=1` 的**采集能力**已在 2026-09-28 首次真采中验证过——三组真站（`jiujiu-attr-regex` / `midu-api-json` / `qiexs-plain`）走完全链路五步断言，自动脱敏也在真页面上确实生效（那一轮同时暴露了旧判据的瞎处：JSON 带引号键与 `Authorization: Bearer …` 整条不触发，修法与被否决的旧口径住 `compat/README.md` 脱敏规程）。**但那批产物已不在工作区**（2026-09-29 复核：`compat/sources/` 只剩 `.gitkeep`，三个 fixture 目录只剩空 `pages/`，`git ls-files compat/fixtures` 仍只数到 `demo-site`）⇒ 原先登记的「7 件产物扣在工作区等过目」**连同它给的入库命令一起作废**——那条命令如今 `pathspec did not match any files`，而空壳目录会被 `loadCases` 静默数成零个 case。**推进这一条的代价因此变了**：不再是「一次过目」，而是**重采一次**（联网 + 站点脸色 + 脱敏人工过目，三道都在 `compat/README.md` 的采集实践口径里）。防再次误读：`compat/report.md` 的分母构成现由 `renderReport` 按各 case manifest 的采集时刻**自述**真站 / 合成条数，不由模板宣称两类都在（钉子：`tests/compat/harness.test.ts` 的「本批 0 条真站采集 + 1 条合成基线」）。 **待裁**：A 重采一次，把分母从 1 条合成推到真站（`compat 跑通率` 是本插件 v1 的验收标准本身，合成基线撑不起「兼容率」这个词）／B 认账 v1 分母就是合成基线，把用户面的「兼容率」措辞降级成「离线回归基线」。**推荐 A**——代价是一次联网与一轮人工过目，收益是规则改动从此有真页面回归；B 只在你判定真站 fixture 不值得养时选。
6. **已收口，仅留档**：**同址已 verified 的源被新导入跳过时，新条目的规则改进被丢弃**：这是「以可用者为准」的既定口径（用户拍板），不是 bug；但 UI / 工具只报 `dupSkipped`，用户若想采纳新规则需先删旧源。
7. **工具输出 schema 与 wire 的绑定：三面已钉死、另三面是工具自有形状（2026-09-28 收紧）**：原先只有 shelf 从 `SHELF_META` 运行时派生，其余五份是手抄快照——wire 字段改名不会让它们报红。现在 `tests/tools/schema-contract.test.ts` 把**从 wire 派生的字段清单**收成一份常量（`GROUP_FIELDS`/`HIT_FIELDS`/`CHAPTER_FIELDS`/`SHELF_FIELDS`/`SHELF_EXCLUDED`）：**运行时**拿它与 schema 的属性集比、**编译期**再用 `Assert<Eq<keyof Wire, …>>` 把同一份清单绑回 wire 类型 → wire 加/改字段会让 `pnpm typecheck` 红（红检实证：给 `SearchHit` 临时加一个字段，`tsc` 报 `Type 'false' does not satisfy the constraint 'true'`）。覆盖面：`dshnovel_search`（`SearchGroup`/`SearchHit`）、`dshnovel_toc`（`ChapterEntry`）、`dshnovel_shelf`（`ShelfBook`，且 `SHELF_FIELDS ⊆ SHELF_META` 另有一条运行时断言）——**这三份之后不用再靠人工同步**；`dshnovel_read`/`dshnovel_import_source`/`dshnovel_source` 是**工具自己的**投影形状（没有对应 wire 类型可绑），仍是字面清单，由用例① 的 execute-校验兜底。**同条附记（2026-09 六工具化后仍开）**：`getDetail`（书籍详情）与 `localImport`/`removeLocalBook`（本地书 TXT / EPUB 的导入与删除）没有对应工具——本地书管理走 UI，agent 的书源/书架闭环已齐；批探针（`startBatchProbeJob`）同样只在 UI 面，工具面 `dshnovel_source` 只有单源 `probe`。要不要补投影属产品拍板，非遗漏即修。**可批默认（2026-09-29）**：不补、维持现状——本地书管理定位在 UI 面（agent 的书源/书架闭环已齐），批探针留在 UI 面同理；将来要补就按 `tests/tools/schema-contract.test.ts` 的纪律从 wire 派生字段清单，不手抄第三份。
8. **已收口，仅留档**：**已确认的刻意保留（不改代码）**：`services/request.ts` 的 `SearchRequest` 类型别名全仓零引用；`localbooks.ts` 的 `ChapterSpan` / `BOOK_KEY_RE` / `LocalImportResult` 只在模块内用；`reading.ts` 的 `normalizeChapterText` **已补直接钉子（2026-09-28，`tests/services/reading-text.test.ts` 五条：逐行 trim 含 CRLF、去首尾空行、相邻空行折叠一个、全空白归一、幂等；红检：删掉折叠那行即红）**——它此前只被 `getChapter` 间接走到，而它塑造每一章的文字输出；`tocUrlOf` 的导出已被 `tests/services/toc-url-miss.test.ts` 直接用上（这条原记「无测试 import」，现只剩 `normalizeChapterText` 那句注明「供测试/复用」的注释已兑现）。`normalize.ts` 的两张方言映射表的 `ruleBookInfo` 整块逐字相同（方言是两条独立演化线，强抽有 speculative generality 风险）。`request.ts` 的 `buildSearchRequest` 虽只是 `assembleRequest` 的薄壳，但 `search-face.ts` 的 `fetchSearchPage` 在用它，属历史名字兼容、保留。
9. **已收口，仅留档**：**缺省值单点化（已收口 2026-09-28，病史与单一主人留档）**：原先同一批缺省值在四处各写一份字面量——`50 * 1024 * 1024` 在 `index.ts` DEFAULTS、`reading.ts` 的 `create` 与 `from`、`localbooks.ts` 的 `create`；`15000` 在 `reading.ts`（`searchTimeoutMs` 与 `jsTimeoutMs` 各一处）与 `fetcher.ts`；`exportDelayMs` 的 `300` 在 `index.ts` 与 `dispatch.ts`；`readJsonBody` 的 1MiB 与本地导入的手写流式上限循环是**两份字节上限逻辑**。生产路径始终显式传值，所以改错一处不会静默改变业务规则——但这类复制正是「靠注释对齐」的温床。
    - **现在的单一主人**（字面量只许出现在这些地方，`index.ts` 的 DEFAULTS 全部引常量）：本地导入上限 = `localbooks.ts` 的 `DEFAULT_MAX_IMPORT_BYTES`；出站耐心 = `fetcher.ts` 的 `DEFAULT_TIMEOUT_MS`（`searchTimeoutMs` 与 `jsTimeoutMs` 共用它，因为两者缺省同值同源）；js 预算与聚合并发 = `reading.ts` 的 `DEFAULT_JS_BUDGET_MS` / `DEFAULT_SEARCH_PARALLEL`（预算常量改名前曾与引擎回退常量 `DEFAULT_JS_TIMEOUT_MS` 同名——两层各有默认、按名 import 会落错主人，故分开叫）；磁盘缓存 = `cache.ts` 的 `DEFAULT_CACHE_MAX_BYTES`；导出节流 = `export.ts` 的 `DEFAULT_EXPORT_DELAY_MS`；JSON 信封体上限 = `api/wire.ts` 的 `DEFAULT_JSON_BODY_MAX_BYTES`。
    - **两份字节上限逻辑合并**：`api/wire.ts` 的 `readCappedBody(req, maxBytes, overMessage)` 是流读 + 上限判据的唯一实现，`readJsonBody`（信封体）与 `api/dispatch.ts` 的本地导入（原始字节）都走它，措辞由调用方给（一个说字节数、一个说 MB）。
10. **`tests/api/routes.test.ts` 以中文文案前缀「未知路由」为判据**（钉措辞而非结构码）：文案一改即整套误红。暂无可替代的机器可读判据——「未知路由 404」与「域 404」的错误码都是 `NotFound`。**2026-09-28 补：给未知路由单独一个码不是纯内部改动**——客户端**确实消费 `code`**（`api.ts` 拿它构造 `ApiClientError`、`SearchView` 直接渲染 `g.error?.code`、`ReaderNotes` 与 `export-run` 按 code 分支），所以新码会在 UI 上出现成新字符串、得配套中文映射；**A/B**：A 新增一个码（如 `UnknownRoute`）并把「文案判据」换成「码判据」——契约面扩张，UI 一侧要同批跟；B 维持现状（文案判据 + 这条注记，改文案时记得这里会红）。
11. **已收口，仅留档**：**任务态不持久化**：DSH 重启后 `job-status` 返回 null，正在跑的导入进度不可恢复（已落盘的源不丢，导入幂等可重跑）。这是 YAGNI 决策，不是缺口；但「重启后 UI 显示空闲而用户以为任务还在跑」的可能性留给下一个人判断。
12. **探针 verified 只证明搜索面**：正文链路（目录/正文规则、翻页、js 沙箱语义）的可用性由 `DSH_CONTENT_AUDIT=1` 全链路审计实测（读报告分桶，非通过率门）；三轮书源语义补齐的清单与理由见 `docs/design/engine.md`「legado 正文链路语义补齐」（**2026-09 实测：228 源全 verified 时正文全链路仅 25 源全通——「搜索可用 ≠ 正文可读」**）。残余失败的已知边界：`@webjs:`/`sourceRegex`/`webView:true`（WebView 面——只在章节 URL 带 `webView:true` 时才需要，属「需要登录/JS 渲染」类，不计入规则引擎欠账）、`contentRule.subContent`/`title`、jsLib 用 `eval` 的源（Code generation disallowed——安全边界不降级）。**别再排的队（2026-09-28 订正）**：`<p1,p2>` URL 页码与方括号索引多条目都**已实现**（矩阵 `b-page-angle-list` / `a-bracket-multi`，理由与钉子住 `engine.md` 的「已解决」段）——照旧文把它们当缺口排期，就是同一条真相的抄本没跟上。网络层失败（FetchError/EmptyToc）需逐源人工甄别死站/反爬/代理，非引擎问题。
    **历轮真机读数（第九至第十三个数据点 = 2026-09-28 的几轮；第二至第八个数据点 = 2026-09-19 ~ 09-26 的发版前对照轮）**：逐轮测量叙事已收掉——读数的家是**门控报告 + 矩阵行 note**（报告是过程产物不入库，要复现就重跑那扇门）。只留结论与关键读数：
    - **跨轮聚合读数不可比**：`ok` / `verified` 率主体是出站网络脸色（同日复跑可差几十个点），每轮唯一可 claim 的是「引擎类归因表无新增类别、`residual` 未涨」。两个网络门都是**报告不是通过率门**（`reprobe` 唯一断言 `sources.length > 0`、审计唯一断言「每个注册源都落进 stage」）——绿 = 跑了没漏审，不是达标；`字段到货率` 的分母随当轮搜索面响应漂，不能当某条规则修复的收益读。
    - **最近一次全量复跑（2026-09-28，214 源、经本地代理）**：`DSH_CONTENT_AUDIT=1` 阶段分布 `ok 103 / toc 45 / search-no-hit 46 / content-error 8 / content-partial 6 / search 5 / no-book-url 1`，引擎类归因 `host-gap 1 / guard 3 / site-side 9 / network 1 / unattributed 0`、**`residual` 仍 1**——唯一那条是起点(部分可看) 的 `chapter.isVip is not a function`（矩阵 `h-book-chapter-vip-flag`，要接它先裁章节形状，见第 23 条）；`DSH_REPROBE=1` 同日 214 源 verified **115（53.7%）**、失败 `FetchError 56 / 导入失败 40 / RuleEvalError 3`。`search-no-hit` 里 40 条是非文本源（**范围不是欠账**），余下文本源逐源复跑均判站点侧、本仓机制按设计走（不抛错、如实 0 命中）。
    - **桶名不是归因——从桶里挖出并修掉的真缺陷**（2026-09-28；教训：别按桶名当「站点侧」跳过，先用审计的 `DSH_AUDIT_ONLY` 旋钮把桶拆开逐源复跑——真入口跑到那一步再说）：① `no-book-url` 桶 56 → 1——8 条文本源不是「站点没给地址」，是本仓把多命中地址 `join('\n')` 拼成多行串、被 `absUrl` 的换行守卫判死（修法与逐源读数见矩阵行 `b-url-value-first-item`）；② `EmptyToc` 桶里的 `b-toc-url-xpath-vs-url`（绝对 XPath 的 tocUrl 被当静态 URL 短路、回退成 bookUrl）修后 `若夏` / `爱丽丝书屋` / `思兔阅读` 转 `ok`，`神魔` 那条是另一种形态——`##` 尾之后带 js 块（矩阵行 `a-replace-tail-trailing-js`），上游语义也是字面文本、两边都跑不出值，属源侧写法；余下未归因条目逐源复跑（真入口抓页 + 跑列表规则 + 数页面里的期望结构）均为「页面已没有那个结构」＝站点侧，**别再笼统写成「页面没章节链接」**。
    - **挖桶的标准动作**（留档，别再发明第二套）：把桶判据按条目数分家（`content-audit-classify.searchFaceStageOf`，0 条 → `search-no-hit`）+ 桶级复跑旋钮 `DSH_AUDIT_ONLY='名字1,名字2'`；全量一轮十几分钟，逐源复跑才是归因。**没跑到那一步的源，先让它跑到那一步**——规则文本与桶名都不是归因。
    - **单源复跑是修复的真机证据、聚合数不是**（2026-09-28 例：`a-css-attr-regex` 修后 `书盟小说` `toc → 42 章`；矩阵行 `a-allinone-group-zero` 修后 `若夏` `tocCount 26`）。同批的旁证门：`DSH_EPUB_BROWSER=1`（离线、本机 Edge）**21/21 全绿**——它验的是「没碰坏兄弟功能」；**该门自带「`lib/client.js` 必须比 `src/` 新」的陈旧判据**，src 一改先 `pnpm build`，否则拿旧 bundle 跑出的绿是假绿。
    - **真机读数证明不了不在审计四面里的改动**（`loginUrl` / `exploreUrl` 的 action 串 / 详情面模板那一类）——那类改动只有单测级证据（各带红检），如实分开记，别把「两门跑得动、引擎类无新增缺口」读成它们的收益。
    - **改动落不进审计四面时，回归门只 claim「无新增缺口」**：例（2026-09-28）——两处「等齐落盘」改动后 `DSH_CONTENT_AUDIT=1` exit=0、归因表无新增类别、`residual` 仍 1（这条门跑的正是缓存与书架写）。`content-error` / `content-partial` 这类桶里的「规则类」失败一律逐源复跑（真入口 `getToc → getChapter`）再定性：复跑读到正文 = 不可复现（站点/瞬时侧），复现且点名 = 真缺陷，被网络挡住 = 如实记「无法复核」。
    - **不出网的批次只记离线回归旁证**（`pnpm build` + `DSH_EPUB_BROWSER` 21/21，它只回答「没碰坏」、不读成收益）；没有出站面改动就不重跑 `DSH_REPROBE` / `DSH_CONTENT_AUDIT`——重跑只会拿到一个受网络脸色支配的新数。待授权的 `DSH_INSTALL_CHECK` 与真宿主冒烟见第 20 条。
    - **历轮（第二至第八个数据点，2026-09-19 ~ 09-26）只作回归对照**：那几轮的修复清单与聚合读数按上面三条口径收掉。唯一留着的病史结论：「URL 选项不是合法 JSON 时整串当纯 URL」**已收口**（`assembleRequest` 改成无条件切分后该 warn 形态消失，别照旧文再排一次甄别）。
    - **分母变小的轮次读数一律弃读**（例：第八个数据点 2026-09-26 那轮分母只有 2 源，对引擎面探测力接近零——引擎语义可用性只认当轮逐源复跑，别引 50% 当可用率）。同轮并入的源列表「⋯」菜单修复末行可达率 5% → 100%，残余（长列表滚到滚动口底 **23% 可达**）登记在 `docs/design/client.md` 已知开口第 11 条。
    - **门控盲区（如实）**：`content-audit` 把 `sources.json` 的 `enabled` 全置 true 直读真库——它绕开 `participates`（它答的是「链路通不通」，不答「参不参搜」），`load()` 与全部存量迁移照常执行。所以「未知形态不参搜」这条闸**只有单测、没有真机读数**（`normalize` 拒入库 / `load` 重推 / `participates` 排除三处）；其影响面按数据（2026-09-21 批）：214 源里 `raw.bookSourceType=4` 恰 4 条，参与集 178 → 174，无附带伤害。
13. **正文串章只有一道闸**：`pagination.ts` 的串章判定是 `stopUrls`（目录知识）**取代**路径启发式，不是叠加（`else if` 形态，接口注释与 `chapter-page.ts` 头注都写明了理由：启发式判不准时宁漏页不串章，而它误拦的 `?id=..&cid=..&page=2` 实测就是一批源「一章只解析出一页」的根因）。残余缺口如实记着：`canonUrl` 会剥 `,{option}` 后缀并按 WHATWG 归一相对地址，但**不归一尾斜杠与 query 参数顺序**——站点「下一页」若与目录条目差在这两处，`stopSet` 漏判且没有第二道闸，下一章正文会被接在本章后面。2026-09 审查复议提议「stopSet 未命中时再走收窄到路径变化的启发式」，**已否决**：收窄后仍会误拦 `/book/1/1.html → /book/1/2.html` 这类路径式同章分页（比现行更糟）。钉子钉住优先级本身（`tests/services/pagination.test.ts` 的 `it('两闸同供时目录知识优先…')`），改双闸必须先过这条钉；漏判的实际发生率只有 `DSH_CONTENT_AUDIT=1` 能出数（本轮未跑）。

14. **聚合搜索后台化已落地（2026-09）**：读 / 写分槽（§4）、结果只留最近一轮 + 每源 50 条 + 收尾 30 分钟（§4）、投递走「带游标的显式快照查询 + 同一份快照的 SSE 推送」（§4 末与 §14）。通道选自有 SSE 的理由与 `EventSource` 被否的理由都写在 `docs/design/client.md` 的「搜索」节。「取消搜索」钮已在 UI 在位（`POST search/job-cancel`，钉子见 `docs/design/client.md` 测试钉子节的 `views-wiring.test.tsx`）；跨观察者换轮的身份裁决也已收进客户端观察 module（`client/search-job.ts`，钉子 `tests/client/search-job-round-identity.test.tsx`）。本节不再有开着的搜索开口。

15. **缓存有效性的三条接受残余（不改代码，如实记）**：① 热正文缓存不再能单独服务一章——`getChapter` 先读目录拿章名算槽位，目录缓存缺失（首次 / 被 prune 淘汰）时一次章读会退化成一次目录抓取（或抛 `FetchError`），正文缓存命中不再等于可离线读。② `getChapter` 注入的 `book.name` / `book.author` 取自**书架**而非规则，故正文脚本用到 `book.name` 时，改书架书名后旧正文照样命中缓存、吐旧书名（把书架元数据入槽位会让每次改名全缓存 miss，更糟——记录不修）。③ 代际只覆盖规则、不覆盖代码版本，升级后仍可能读到旧提取代码写下的条目（`reading.getChapter` 出边界用 `contentToText` 再收一次口，靠它幂等才无害）。

16. **规则变量表（`ctx.vars`）的作用域只到「一次门面调用」**：`reading.getDetail` 给这次调用一张表（`makeSubEval(…, { vars: {} })`），于是纯 `@put` 的 `ruleDetailInit` 写的变量能被随后的 `@get:{k}` 字段与目录读到；`getToc` / `getChapter` 各自新建，**跨面不传递**。多级作用域链（写取各按第一个非空宿主）本仓未建，**原注写的「本机库暂无此形态」已不成立（2026-09-28 订正）**：现库有一条——`海棠搜书` 的 `ruleBookInfo.intro` 里 `java.put('list', href)`、`ruleBookInfo.tocUrl` 里 `java.get('list')` 读它，而这两条**不在同一次门面调用**（`intro` 属 `getDetail`，`tocUrl` 由 `getToc` 经 `tocUrlOf` 重新求值）→ 变量表已是新的一张 → `Cannot read properties of null (reading 'split')`；**审计里就是这条**（`海棠搜书` stage `toc`，规则片段与推演逐字对上）。对面语义：变量表挂在书/章实体上（进程内、**跨调用**），未设时读变量返回**空串**（本仓返回 undefined，同族另差一处；对读细节住矩阵行 `a-var-scope-chain`）。**最小忠实改法** = 服务层给 `(sourceId, bookUrl)` 建一张进程内、跨调用的书级变量表，四个面共用（含删源/换规则的清理口径）；要不要连 chapter/source 两层一起做（四级链）另定——**正在矩阵行 `a-var-scope-chain` 等拍板**，不预先造作用域层（预造自带清理与可见性两套失败模式）。**可批默认**：推荐做**最小忠实版**（按 `(sourceId, bookUrl)` 建进程内跨调用的书级变量表，四面共用），四级作用域链是否全做另定；需求方与形态见矩阵 `a-var-scope-chain`。

17. **本地发布与书架落盘之间的跨文件窗口（如实披露，本轮不修）**：EPUB 的发布完成判据是「顶层元数据写完」（提交标记），而入架是随后由门面 `localImport` 调 `Shelf.add` 写 `shelf.json`（防抖写）。这两步之间**没有跨文件事务**：进程在「元数据已写、书架未落盘」之间被杀，就会在 `local/<uuid>/` 留下一份**完整但未入架**的副本——用户看不到它（书架没这条），磁盘上却占着空间（一部书 = 原 EPUB + 派生文档 + 资源）。**被否决的修法**：加一个启动扫描器「扫 `local/` 里没有对应书架条目的 uuid 就删」——它把「未入架」与「用户手动清过书架但想留文件」「多窗口/多进程同时写同一数据根」这些情形一起误杀，代价比收益大；本轮不建通用存储事务 / 后台恢复系统。运维口径：副本不会自己消失，也不会被自动复用（`<uuid>` 每次导入新铸），要清就人工清 `local/`（数据根以 `dataDir` 为准）。 **残余（判为不修）**：这一条是**已接受的窗口**，不是待办——建通用事务/后台恢复系统的代价大于收益（会把并发写入与人工清目录这些情形一起误杀）。运维口径见本条末句。

18. **`coverUrl` 的形态（已裁：维持快照；重开条件写在末段）**：本地 EPUB 的封面 URL 现在是**导入那刻的快照**——`bookMetaOf` 用 `wire.resourceUrl` 拼出带 `/novel-api` 前缀与 `bookKey` 的完整 URL，写进 `SHELF_META.coverUrl` 落 `shelf.json`。
    - **① 维持快照（选定）**：零改动，客户端拿到的就是可直接 `<img>` 的地址；代价是「路由前缀」这一层**传输面**知识进了持久化数据——前缀归 `NOVEL_API_PREFIX`（wire），换挂载前缀就会与旧 `shelf.json` 里的封面 URL 脱节，而它看起来仍是个合法 URL，坏得无声（不会报错，只会不显示）。
    - **② 读取面投影（否决）**：`shelf.json` 只存不透明身份（`bookKey` + 资源 ID），URL 在 `shelfList()` 读取时按当前前缀拼出来——前缀知识只活在传输面；代价是要给「本地书封面」在读取面上开一个投影口径（要么让它挤进 `coverUrl`，把写口「写的是 URL」那条假设打破；要么新增一个读面字段——`ShelfEntry.sourceName` 是同类先例，但它也不进 `SHELF_META`）。
    **为什么这么裁（2026-09-24 现查）**：② 要防的那件事今天**不存在**——`NOVEL_API_PREFIX` 是 `shared/wire.ts` 的硬字面量，`src/index.ts` 直接拿它 `register({ kind: 'prefix' })`，全仓没有任何配置口能让前缀变；而 ② 的代价是现在就付的（给一个不存在的旋钮改数据形状，并在读取面开第二类投影口径）。**重开条件**：一旦前缀成为可配置项（宿主换挂载点、多实例、或 `dataDir` 之外新增挂载配置），① 的失效就是静默的（封面不显示、无报错），那时必须走 ②——这条判断由「前缀会不会变」独扛，所以把它写成条件而不是结论。

19. **已收口，仅留档**：**「先 await、再挂断连收尾」会漏掉断开窗口（已修，口径留档）**：本地资源口原先只写 `res.on('close', () => stream.destroy())`，而这条流的源头是 `getResource` 里 `handle.createReadStream()` 返回的 `FileHandle` 流。`close` 监听器是在 `await service.getLocalResource(...)`（查资源表 + 打开文件）**之后**才挂上的——客户端若在那次 await 期间就断开，`close` 早已发过、挂监听也等不到第二次，于是那条流没人销毁，fd 一直挂到 GC；Node ≥22 把「GC 期关闭仍打开的 FileHandle」从弃用警告升格成**未捕获错误**（`ERR_INVALID_STATE`），表现为整轮测试在收尾处变红而不是某条用例失败（`tests/api/dispatch-epub.test.ts` 的「断连的请求只销毁自己那条流」正是最容易命中这个窗口的现场：`ctrl.abort()` 紧随 `fetch`）。修法：监听挂上后立刻补查一次已断连（`if (res.destroyed) stream.destroy()`），让「断开即销毁」与监听器抢没抢到 `close` 无关。**为什么留档**：这类「await 之后才挂收尾监听」的形态是通用陷阱，同族的流式路由（导出）写新代码时按同一条口径自查——收尾必须对「监听器挂上之前就已断开」这一时序成立，而不是靠监听器一定抢在前面。**未选**的掩盖法：吞掉错误、加 try/catch 兜住未捕获异常、放宽断言——三条都只是把 fd 泄漏藏起来。

20. **EPUB 解析/存储层的残余（整分支评审逐条记录）**：**未修的只有下面两条**（`package.ts` 的三处窄口径、一批小口径项），其余各条都已收，留档在下半段别当开口再找。**验收门这一侧还压着一件没跑的授权项，单独列在最前**——它不属于"已收口"，容易被扫过去：
    - **待授权、尚未执行**：`DSH_INSTALL_CHECK` 与真宿主冒烟**未跑**（会写用户 profile / 需重启用户宿主，要他点头；他说「接着做」不等于授权这两条）。浏览器门 `DSH_EPUB_BROWSER=1` 覆盖的是测试壳，**不证明真宿主**。前置已验（2026-09-28 复跑）：`pnpm build` 绿、`DSH_EPUB_BROWSER=1` 21/21 全绿。
    - **验收门的残余：三条都已收口（2026-09-28）**。① **失败侧的位置读数**原先量的是插图**之前**的节点——图前的节点在「框塌陷 / 框到手才撑开」时一动不动，量它只能抓到「主滚动被拽走」，抓不到「正文被推走」，而后者才是预留框要保的事；现在两条图片用例都改成量**图之后**的第一个正文节点（`nodeBelow`），失败侧另加「框高不变」的断言（比值相同不代表高度相同）。② **慢图片**原先靠一个有界延迟（2.5s）撑出在途窗口，极慢机器会响亮假红；现在改成**可显式释放的挂起**（`host.hold` + `release`），窗口由用例掌控，读数不再是对时长的赌注（同一条用例的耗时也从 3.5s 降到 1.45s）。③ 第 19 条的 fd 修复原先只有一次性探针，现在有**确定性常驻钉子**：`tests/api/dispatch-epub.test.ts` 把「打开资源」那次 await 拉成显式闸，在闸里断开再放行，断言返回的那条流被销毁（红检：撤掉 `res.destroyed` 补查即红，`expected false to be true`）。
    - **`package.ts` 的三处窄口径**：NCX 的 `navPoint` 缺 `<content>` 一律硬拒（EPUB3 的 span 分组是允许的，两者不对称）；`itemref` 上的固定版式声明一律拒、不分 `linear`（真机若撞到「仅封面 pre-paginated 的流式书」需要改判）；降级范围按**子树**而非按元素种类——被移除的 `form`/`canvas` 等子树里的锚点同样走降级（与裁定措辞一致，仅作宽度记录）。**2026-09-24 裁：挂判据不动**——放宽拒绝面需要反例，而当时本机数据根 `local/` 里只有 1 本书且是 TXT（EPUB 侧这三处没有任何真书读数），没有证据就松手等于拿没量过的形态换假安全。**2026-09-26 更新（真书读数的口径变了，裁定没变）**：第一本真书（Gutenberg #7337 图像版 `pg7337-images-3.epub`）在离线探针里真读过——它撞出的反例是「内联 SVG 整页封面」那一类，已按证据改判（裁决与理由见 §12 ⑦）；而这三处（NCX 缺 `<content>`、`itemref` 固定版式、降级按子树宽度）**没有被这本真书触到**，仍无反例，继续挂判据。教训随读数一起记：**「没有读数」不等于「形态不存在」**，一条判据该不该放宽要看真书，而第一本真书就可能推翻它。
    - **一批小口径项**：「同一归档可被两个 wrapper 引用」会重复校验（只浪费）；GIF 只校验 trailer（真解码与「长度自洽的截断」由浏览器门覆盖，见第 9 条的既定分工）；crc32 的 `as unknown as` interop 归一化保留（实测 `import crc32 from 'buffer-crc32'` 报 TS1192、具名 import 运行时不导出，结论写在代码注释里）。
    - **本批已收（留档，别当开口再找）**：`readDocument` 的 404 / 500 分家写进「读口」一节；`xml.ts` 两处走法的计数口径在注释里点明（共用阈值与报错、各数各的节点）；`chapter-content.ts` 的 `SOURCE_WS` 头注改为点名 `nodeText`（并说明同文件 `cleanText` 是**另一条** NBSP 口径）；`EPUB_MIMETYPE_VALUE` 收成模块私有（它从来只被本模块用）；`importRejection` 把 fixture 构造移出 `catch`（拼错样本名不再被报成「类型不符的拒绝」）；**告警层独立成 `services/epub/warnings.ts`**（`EpubWarningLog` 不再住在转换模块被资源模块按类型回头看，顺带消灭 `resources.ts` 里那三个抄自 `documents.ts` 的码字面量）；**原子写与备份的命名约定收进 `storage.ts`**（`tempPathOf`/`backupPathOf`/`isAtomicTemp`，`localbooks.discard` 改用判据而不是自己写死 `.tmp`/`.bak`）；**真实 10_000 条目边界补了两向实证**（原先只有缩小预算的用例）；**告警例子有界**（无界收集实测把三万条外链的正文同步阻塞 13.3 秒，处数仍如实累加）；**行内上下文里的块级内容按块投影**（见上条）；**只读解析的多根与注释边界**（见模块表与测试行）。
    - **行内上下文里的块级内容（2026-09-26 已收）**：原先记的三条残余（行内元素里嵌 `pre` 丢逐字空白、嵌 `rule` 不收行、`link` 里嵌 `tr` 丢制表符）已按「块级内容在行内上下文仍走块自己的投影」修掉。**它不是非规范 XHTML 的边角**：XHTML5 的 `<a>` 是透明内容模型，块级子节点是合法书写（EPUB3 就是 XHTML5），真书里 `link` 包 `pre`/表格会走到这条路；`chapter-content.ts` 的投影改成「软文本 / 块文本」两种片段，块文本（pre 逐字、表格行制表符）不再进外层行的空白规约。三条钉子见 `tests/services/chapter-content.test.ts`。

21. **表单体编码只做子集（已裁：维持子集，2026-09-28；重开条件在末段）**：`encodeFormCharset` 干的是「整具体里的非 ASCII 段按声明 charset 百分号转义」，缺的三件都在矩阵 `b-opt-charset-form-fidelity` 里记着对面那条路的形状：① **体形状守卫**——现在 `option.charset` 在场就编，声明了 charset 的 JSON/XML 体照样被转义（百分号跑进 JSON 串：语法仍成立、语义已错），而默认 `urlencoded` 头是在转义**之后**才补，所以「有没有自带 Content-Type」根本不构成条件；② **逐字段编码**——不按 `&` / `=` 切开分别编，保留字符与空格 / `+` 的规则与对面不一致；③ **`charset=escape` 那一支**——被当成未知字符集原样返回，静默不编。**为什么不动手**：当批现库带 `charset` 选项、且落在三件不可观测形态上的源为 0，而 ② 的口径差异只有真机样本能判对错——没有需求方就改抓取行为，本仓不做。**已裁（2026-09-28）：三件都不补，维持子集**。理由：① 的「未兑现承诺」这一条本就不成立——`request.ts` 头注早已改成纯陈述（明写「当前**没有**形状判别」，并把这句意图登记为本条与矩阵行），读的人不会以为守卫已经在了；而补守卫的收益在现库为 0、风险是挡掉未来某个真需要按 charset 编的非表单体（那类体的「形状」判不出，误拒比不编更坏）；② ③ 的差异只有真机样本能判对错，照字面抄对面等于把没验证过的行为写进抓取面。**重开条件**：出现第一条真需要按声明 charset 编的非表单体（或某条真机样本证明现行为发错了字节）——那时按那一条源定形状，不预先补。矩阵行 `b-opt-charset-form-fidelity` 随本条保持 `open`（对面有、我们没有的事实不变），note 已同步这条裁决。**2026-09-28 重数（分母换到现库）**：带 charset 选项的 **12 处 / 10 源**（旧注「41 源带 charset 选项的 0 源」是旧分母上的读数），其中 11 处带 POST 体（本仓子集覆盖）、唯一不带体的一处是飞卢小说（`charset=gbk` + 查询串，按「查询串不重编码」那一半差异不可观测）——**重开条件未被触发**，裁决不变。

22. **本地书只收 TXT 与 EPUB；PDF / MOBI / UMD 待裁**：导入分流是**白名单式**的——只有 ZIP 本地头签名（`PK\x03\x04`）改道 EPUB，其余字节一律走 TXT 解码链（口径见「本地书身份」一节；不新增「二进制即拒收」的全量启发式，是为了不误伤 GBK 短篇与带控制字符的 TXT）。于是 **PDF / MOBI / UMD 这三种文件今天会被 TXT 链当文本读**（可能落成一本乱码书）——这既不等于「支持」，也还没有裁决。三种格式与 EPUB 的可复用面各不相同：PDF 要文本抽取与排版还原、MOBI 是 Kindle 容器、UMD 是私有封装；本仓无对应解析器，接就是从零写三种读取器，而需求面未见（用户点名的缺口是 EPUB）。**需要拍板**：接（排期）还是判环境不适用（落 `docs/design/legado-compat.md` 的「不适用」表并给锚点）；若判不接，可一并考虑**具名魔数的最小拒收**（`%PDF-` / `BOOKMOBI` / UMD 头）——它与上面那条「不加全量启发式」的裁决不冲突。矩阵行 `j-local-book-other-formats`。**可批默认（就是那一条 D7）**：推荐 PDF 记「不适用」、MOBI / UMD 记「待需求方」，并把「PDF 今天会被 TXT 链当文本读成一本乱码书」这条后果如实写进不适用表——裁决权在他，不代答。

23. **章节形状要不要扩字段：一把待裁的 wire 决定（连带解掉审计唯一的 residual）**：对面的章节条目带 `isVip` / `isVolume` / `isPay` / `updateTime`（对面把它们落到章节 tag 与层级），本仓 `ChapterEntry` 只有 `{name,url}`。现库按 raw 容器同名子字段重数：**`isVip` 13 源、`isVolume` 5 源、`updateTime` 19 源**（矩阵 `c-toc-flags` 与 `f-chapter-tag-update-time` 同族）。扩它要动 `shared/wire.ts` 的章节形状 + 目录缓存代际 + 阅读器目录显示（属产品面）。**同一条裁决的下半**：`DSH_CONTENT_AUDIT=1`（2026-09-28，214 源、经本地代理）的**唯一 residual** 就是起点(部分可看) 的正文脚本 `if(chapter.isVip()){…}` 抛 JsSandboxError——`chapter` 镜像没有这个方法，而它的值只能来自 `ruleToc.isVip`，所以**要接 `isVip` 就必须先裁章节形状**（矩阵行 `h-book-chapter-vip-flag`）。不裁则维持现状：`chapter.isVip()` **如实抛错**、host-gap 如实计入 residual——不静默给 `false`（那会让 VIP 章走非 VIP 分支去取，把错值读成成功）。

24. **四条「App 级 / 配置面 / 新请求面」的待裁项**（都不在「格式支持」这条轴上，且此前只活在矩阵里）：每条都记着需求面与代价，等一句话裁定。**可批默认（2026-09-29，与矩阵各行的推荐对齐）**：四条默认全取**不开**——`i-rule-sub` 推荐不开（若开须与 `k-import-formats` 同一出站能力一起开，并先定深度/条数上限与失败粒度）；`i-txt-toc-rule`/`f-txt-toc-rule` 推荐不开、等需求方点名；`i-global-replace-rule` 推荐不开（本仓没有对应的全局配置面，超时语义也无法照抄）；`e-toc-html-reuse`/`e-info-html-reuse` 默认维持现状不接复用（真要裁就两条一起裁、三案择一，优先①照对面的实体字段传递——它不吃代际失效，②③ 都要先接受「详情刷新后仍读旧原文」这条新问题）。
    - **`i-rule-sub`（订阅式导入）**：对面 JSON 对象里带 `sourceUrls` 时会逐个 URL 拉取并**递归**解析；本仓导入只收文件 / 粘贴的 JSON 数组或单对象（矩阵 `k-import-formats` 同族）。**代价比「低成本」这个直觉大**，两条已现查：递归的深度由数据决定、**没有上限**（清单可以指向清单，所以开这个出站面必须自带扇出与深度上限），且对面是**整批校验**（一条坏源让整次导入失败），与本仓「逐份 parse、坏份记账继续」的失败粒度相反。另外对面那台订阅表的 `autoUpdate` 列**没有任何调度消费者**——「自动更新」是字段在场、行为缺席，别把它当需求抄。⇒ 要不要开。
    - **`i-txt-toc-rule` / `f-txt-toc-rule`（TxtTocRule 可配置正则集）**：本仓本地 TXT 是一条钉死的 `CHAPTER_RE`（标题行切章，`localbooks.ts`）；对面按内容**打分挑规则**（chapterRule / volumeRule），且那套规则是独立实体 + 导入对话框。补它要新开一扇**用户可配面**（配置形状 + UI），不是照抄一行。**打分不是加权平均**：它拿全量正文跑每条规则、以「命中跨度足够大」的个数估章数取最大，**平局由规则表顺序决定**（判据与四条反直觉细节住矩阵 `f-txt-toc-rule`）⇒ 要接就得连「表顺序即优先级」一起定。
    - **`i-global-replace-rule`（ReplaceRule 全局替换库）**：本仓净化只有规则串内的 `##` 尾与源内 `replaceRules[]`（导入期固化）；对面是 **App 级配置**、跨源生效。两条口径与名字直觉不同，落地前必须先读（全文在矩阵 `i-global-replace-rule`）：**`scope` / `excludeScope` 不是作用在文本上的正则，而是「哪些源生效」的包含式名单**（按书名或源标识匹配，空即全域），标题与正文各有独立开关；而那个「超时看门狗」到点会**取消替换并抛错**，上层兜底还不一致——标题路径顺手把该规则**禁用写回库**，正文路径把规则名与堆栈**当正文输出**，且对面还会在 3 秒后重启 App。本仓既不能重启宿主也没有 per-rule 禁用面 ⇒ **先裁「超时怎么办」，再谈抄毫秒数**。
    - **`e-toc-html-reuse` / `e-info-html-reuse`（详情 / 目录响应复用）**：对面在目录地址与书籍地址相同时直接拿详情页原文建目录、搜索响应已含详情时跳过网络；本仓 `fetchText` 不接页面级缓存，同一条 URL 会**真打两次**。这**不是**「缓存已覆盖」——`PageCache` 存的是目录条目与正文，不是详情页原文。**形状上有三个选项，不是两个**（此前记的 A/B 两案都不是对面的做法）：① 照对面——把响应体挂在书目对象上随调用传递、在固定点位显式清空，**因此不吃代际失效**，代价是「谁负责清空」散在调用点上；② 按 `(sourceId, url, 规则代际)` memo 详情页原文；③ 给 `fetchText` 加页面级缓存并吃代际失效——②③ 都会带来「详情刷新后仍读到旧原文」这一类新问题，且与本仓刚立起来的缓存代际口径相互作用 ⇒ 必须拍板，不是照抄一行。（判据与两处对面点位住矩阵这两行。）

25. **以下抓取面 open 行原先只活在矩阵里**（可达性清单；读数与判据住各行，一个量一个主人）：
    - `d-explore-three-forms` / `d-explore-fallback-search-rule`：发现面（D1）的两个子行——形态 JSON / `标题::URL` / js 三类的分布，与"自带列表规则 vs 靠搜索面回落"各 86 源（2026-09-28 复算；判据是矩阵行绑的 `exploreBookList` 键，别照这句话另数一套）。
    - `b-login-check-js`：`loginCheckJs` 三条逐条打开后**用途与行名相反**（两条 Cloudflare 拦截页探测、一条付费墙探测），且都调对面**响应对象**成员——要接先定"响应对象要不要进桥"，那是桥面设计。
    - `b-login-ui`：`loginUi` 非空的源与三种形态（读数住矩阵那一行）。**代价此前写小了**：对面这块不是「画个表单」——面板有两种模式（`loginUi` 空白走 WebView，非空才走 Form）、每一行的 `action` 不是外链就是**整段当 JS 求值**、**打开面板就会把 default 写进凭据缓存**，而凭据存储是 AES 且密钥取设备指纹 `androidId` 的前 16 字节（本仓那一格是点名桩）。四条口径与出处文件都在矩阵行里，判它之前先读那一条。
    - `b-cookie-jar`：现量三档（true / false / 该键缺失）与对面那三层接线都住矩阵那一行。要点是**隔离粒度不同**——对面按**二级域名**存与发（两个源同站即共享登录态），本仓是**按源**的脚本键值表且请求侧不自动回带。那句"该字段不影响行为"只描述我们这侧，**不是对面的等价描述**：对面关掉该位仍会发同域历史 cookie，只是不再自动收集。要裁就照「粒度 + 收集与否」这两件事裁，别照那句话以为对面也没有这一层。

26. **Windows 上 `pnpm test` 那种「全绿但 exit≠0」的瞬时 EPERM（2026-09-28，口径留档）**：病史——摘要全绿、末尾 `Unhandled Rejection … EPERM: rename %TEMP%\…\shelf.json.*.tmp`，vitest 因此非 0 退出，原样重跑就绿。**顺带修掉的两处同族真缺陷**（不是那次红的根因：两处 flush 都改完后现场仍复现——上一笔提交把「找到同族缺陷」写成「定到根因」是过头的，以本条现文为准）：① `createDebouncedWriter.flush` 原先只排「调用那一刻」的挂起写快照，而低层写 `mkdir → writeFile → rename` 真异步 ⇒ 第一轮 I/O 在途期间新调度的写不在快照里、计时器挂着自己烧；② `SourceRegistry.flush` 原先只 `await writeNow()` 一次，同族。钉子：`tests/services/storage.test.ts`「flush 排到静默…」（防抖窗刻意放到 10 秒，不靠 sleep、不给放宽断言留余地）与 `tests/services/sources.test.ts`（fake 钟**数挂起计时器**——注册表写整文件快照，按内容断言这一族会假绿）。**扫完结论**：本仓只有这两处「等齐」合同，都已排到静默；`PageCache` 与本地书落盘在调用点直等自己的写，无这一族窗口。**为什么不设轮次上限**：`flush` 的合同就是「等齐落盘」，加上限等于把逃逸窗口藏回注释。
  - **「一次 I/O 失败为什么会变成进程级未处理拒绝」已扫到收口（2026-09-28）**：`setTimeout` 里 `void flushOne(file)` 没有主人，失败就漂出去；同链的 `SourceRegistry` 却是 `console.error` 后吞掉——**两处口径不一致**是本条唯一还开着的结构性问题。`src/**` 里「无人接收的异步调用」只有这一处（`import-job` 两个任务都带 `.catch`、客户端三处 `void` 都有主人、`api/dispatch.ts` 没有漂着的 promise）⇒ 别再重扫这一族。**③ 不许拿「统一吞掉并记日志」当修红手段**——一次落盘失败是真损失，让它响比让它静默好。
  - **`rename` 为什么被拒：四位置实测的结论（2026-09-28，Windows 10.0.26200 / Node v25.7.0；复测法是下面四句，不留脚本）**——打开**目标** ⇒ 必定 EPERM 且目标留旧值（那笔落盘真的丢了）；打开**源 `.tmp`** ⇒ 照样成功（libuv 删除共享 ⇒「扫描器锁住临时文件」这条旧推断当场否掉，红消息印源路径只是 Node 的报告口径）；目标 / 源目录已删 ⇒ **ENOENT 不是 EPERM**（「afterAll 清了临时根目录」那族连错误码都对不上）；两个 `rename` 并发同目标 ⇒ EPERM（既有按文件名排队器覆盖的那一族）。本仓真实调用形状自然交错 **400 轮 0 命中** ⇒ **占用者在库外**（编辑器 / 索引器 / **另一个 node 进程**——对面持读句柄改名照样 EPERM；本仓唯一刻意持句柄的读点是本地书 `localbooks.getResource`，不在 `shelf.json` 上）。签名只定得到**种类**、定不到**名字**（要名字得在那一瞬抓句柄，本仓没这个通道）。同族对拍：Windows 上「边读边删」删得干净（钉子 `tests/services/localbooks.test.ts`「删一本正在被读的书」，**负结果**、没改 `discard` 顺序）——**同一把 Node 句柄删得掉、改不掉**（机制解释「删除要求持有者授予删除共享」是**推断**，别当已证）。
  - **跑门口径不变**：看到「全绿 + exit≠0」先看末尾是不是 `Unhandled`，是就重跑一次确认、并在汇报里如实写出那一次红——**别默认它是环境噪声**，也**别把「修掉了一个同族缺陷」当成「解释了这次红」**；同类现场按本条的方法查落盘序列与它的排队者，不要先加 sleep。
  - **待裁（新开一项，推荐 B）**：这笔耐久缺口怎么办——**A** 给低层 rename 加有限次重试并最终如实报错（治「一次瞬时锁丢一笔防抖写」；代价：写路径多时间与状态，与「不为绿而加重试」纪律只隔一线。**A 的实质是「替一个量不到的东西选上限」**——占用时长在库外、本仓无从测量，预算不足时 A 退化成 B，只是晚一秒才响）；**B** 维持现状（失败即失败，靠同一文件的下一次写覆盖，进度这类幂等写损失有限）；**C** 只把两处口径对齐（计时器那一支也归因日志）——**它只改「失败怎么被看见」，不改「失败会不会丢数据」**。**D 已量完即自我否决**（先 `unlink` 目标再 `rename`：实测确实免魔数免重试，但窗口内并发读拿到 ENOENT 会被 `readJson` 当成**空书架/空注册表**，且进程死在两步之间时目标不存在、数据只剩 `.tmp`——两条合起来正是「认不出来的缺席冒充成功」，比 A 坏一个量级；**登记在此只为不让下一个人再试**）。故 D 不进候选，A/B/C 才是真选项；读数如实记过，选哪条仍归人。
