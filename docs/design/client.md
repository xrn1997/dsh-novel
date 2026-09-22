# 浏览器半（client）

本文是浏览器半的现状真相（single source）；领域词汇见 `CONTEXT.md`（阅读会话、bookKey、启停、书源注册表、wire 契约……一律用那里的词）。面向下一个改前端的人或 AI：只讲口径与理由，不讲操作步骤（操作步骤见 `README.md`）。

## 模块地图

入口与装载面：

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `src/client/index.tsx` | 浏览器半插件入口：注册「小说」**全局面板**（`sidebar.panellist` 图标行 + `main` keyed 槽同 id 双注册，2026-09 迁移；`conversation.view` 与 `settings.section` 注册先后撤除，单一归属） | `inject = ['slots','sessions']`、`apply` |
| `src/client/styles.tsx` | 唯一 token 层 + 标度（sp/fs/r/shadow/z/dur）+ 组件类（`<style data-novel-style>` 注入） | `NOVEL_CSS`、`NovelStyles` |

视图环（每个文件只做渲染与接线，含 `deps` 缺省）：

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `views/NovelView.tsx` | 根：顶部 tab 导航（书架/书城/书源管理）+ 按 `routeStore` 分发五分支（reader / search / city / sources / 兜底 shelf） | `NovelView` |
| `views/ShelfView.tsx` | 书架 tab：内容标题（书架 + N 本计数）+ 居中搜索簇（输入框 +「搜索」提交钮）+ 筛选簇（含「选择」入多选态）+ 封面网格（卡片带来源 chip）+ TXT 导入 + 删除确认（单本与批量同一个模态） | `ShelfView` |
| `views/CityView.tsx` | 书城 tab：未上线占位空态（内容上线后填充本分支） | `CityView` |
| `views/SearchView.tsx` | 搜索：提交后台任务 + 游标读快照（`search-job.ts`）+ 逐源分组（失败源折叠）+ 命中行双动作 | `SearchView` |
| `views/ReaderView.tsx` | 阅读器：渲染会话状态 + 实现 `ReaderPort` + 事件喂给会话；⤓ 钮弹导出范围面板（确认才开下） | `ReaderView`、`PrefsPanel`、`ExportPanel`、`CTRL_Z` |
| `views/SettingsSection.tsx` | 书源管理 tab 壳（原宿主设置「小说」区块整体搬入后打碎重组，2026 调度台 IA）：待办收件箱 + 任务槽 + 源列表接线 + 导入弹层 + 试跑下钻。**任务读数只读镜像、不自带轮询、不自带状态条**（2026-09 迁出，见 `NovelStatusOverlay`） | `SettingsSection`、`ProbePane` |
| `views/NovelStatusOverlay.tsx` | **常驻状态层**：注册在宿主 `shell.overlay`（root 作用域），全应用唯一的任务轮询实例 + `GlobalStatusBar`；点击任务泳道 = 记一次跨子树意图 + 路由去书源管理 | `NovelStatusOverlay` |
| `views/SettingsSourceList.tsx` | 源列表现场：状态/分组/文本过滤、行内开关（启停唯一入口）、选中动作条、统一删除模态（在途防重 + 焦点闭环）、行内「⋯」菜单、登录面板、批量验证运行卡 | `SourceList`、`ProbeRunCard` |
| `views/SettingsImportPane.tsx` | 导入现场：拖放主入口 + 粘贴小道 + 三态汇总（文案钉「选择或拖入 legado 书源文件」「导入是后台任务——提交后本窗自动关闭，任务在服务端继续」） | `ImportPane`、`ImportRunCard` |
| `views/SettingsStatusBar.tsx` | 全局状态条（瞬态层的呈现端） | `GlobalStatusBar` |
| `views/bits.tsx` | 共用小组件 | `StatusBadge`、`ErrorBanner`、`EmptyState`（`title`/`hint`/`actions`）、`ProgressBar`、`RunCard`、`jobPct`、`coverFallbackChar`、`SearchIcon` |
| `views/types.ts` | 再导出桶（wire 值形状）——**别在这里加第二份声明** | 全部为 type re-export |

逻辑（无 React、无 IO，可直接单测）：

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `reader-session.ts` | 阅读会话：时序编排持有者 + `ReaderPort` 定义 | `ReaderSession`、`ReaderSessionDeps`、`ReaderPort` |
| `api.ts` | `/novel-api` 同源 fetch：信封解析单点 + SSE 读流 | `apiGet`、`apiSend`、`apiUpload`、`apiEventStream`、`ApiClientError` |
| `deps.ts` | 三束依赖 seam（core / settings / reader） | `ClientCoreDeps`、`SettingsDeps`、`ReaderDeps`、`prodCoreDeps`、`prodDeps`、`prodReaderDeps` |
| `store.ts` | 轻量 store + 视图内路由 + 阅读偏好 | `createStore`、`useStore`、`routeStore`、`navigate`、`prefsStore`、`setPref` |
| `progress.ts` | 进度数学（锚点 ↔ 章 + 比例） | `locateChapter`、`anchorTop` |
| `reader-load.ts` | 懒加载决策（哨兵口径 + 前向流水） | `nextChapterIndex`、`nextLoadTarget` |
| `scrollport.ts` | 真实滚动容器探测（「谁在滚就按谁算」适配层） | `isScrollport`、`findScrollport`、`portScrollTop` 等 |
| `search-job.ts` | **搜索观察 module**：提交一次 + 游标观察（SSE 帧 / 快照轮询同 seam）+ **轮次身份裁决**——同轮按游标累积分组；换轮（快照 `job.id` ≠ 观察中轮次）= 丢旧累积 + `since=0` 恢复新轮完整基线 + 旧连接 abort（挂载即恢复上一轮） | `useSearchJob` |
| `source-list.ts` | 源过滤纯函数 + 列表现场 store | `filterSources`、`filterByStatus`、`filterByGroup`、`groupIcon`、`sourceListUi` |
| `source-list-view.ts` | 列表派生 view-model（纯函数） | `deriveSourceListView` |
| `source-inbox.ts` | 书源待办派生（纯函数）：全库源 → 坏源/未验证两集合（只看 status 不看 enabled——停用不是免验理由，停用的坏源照样置顶）；待办动作的 id 取数口也在这里 | `sourceInbox`、`inboxIds`、`SourceInbox` |
| `jobs.ts` | 后台任务面：提交 + **验证领域动作 `startSourceVerification`（三个验证入口的提交后编排单点——成功催任务读面 / 失败一处反馈；ids 点击时快照）** + **唯一轮询驱动 `useJobPolling`（住在 `NovelStatusOverlay`）** + 任务现场镜像 `useJobSurface`/`refreshJob` + 状态层点击意图 `requestJobOpen`/`useJobOpenRequest`/`takeJobOpen`（测试复位口 `resetJobSurface`） | `startImportJob`、`startBatchProbeJob`、`startSourceVerification`、`useJobPolling`、`useJobSurface`、`refreshJob` |
| `transient.ts` | 全局瞬态层（pending / ok / error） | `pushError`、`pushOk`、`pushPending`、`useTransient`、`useTransientFlag` |
| `toggle-feedback.ts` | 单源启停的反馈策略 + 行锚点 | `toggleFeedback`、`rowAnchorOf`、`ToggleFeedback` |
| `export-run.ts` | 范围导出时序（start(范围) / cancel / dispose）+ 范围校验与文件名单点 | `createExportRun`、`IDLE_EXPORT`、`parseRange` |
| `download.ts` | 流式导出（字节进度）+ Blob 落盘 | `streamExport`、`saveBlob` |
| `importer.ts` | 粘贴预检 + cookie 串解析 | `validateSourceJson`、`parseCookieString` |
| `shelf-delete.ts` | 删除确认文案：单本（本地书点名 dataDir 副本连删 + 原始文件不受影响）与批量（点名本数 + 其中 N 本为本地书） | `deleteBookCopy`、`deleteBooksCopy` |
| `shelf-view-model.ts` | 书架视图派生（纯函数）：筛选口径 + 卡片元信息/百分比唯一算式 + 来源 chip 文案口径 | `ShelfFilterKey`、`SHELF_FILTERS`、`filterShelfBooks`、`shelfCardMeta`、`shelfSourceTag` |
| `prefs-ui.ts` | 阅读偏好常量 | `FONT_STEPS`、`LINE_HEIGHTS`、`PAPER_PRESETS`、`MEASURES` |
| `util.ts` | 中立小工具 | `debounce`、`ls`、`paperInk`、`coverTintClass`、`sourceTintClass` |

## 装载面

- 视图（**全局面板，2026-09 迁移，用户拍板**）：双注册且必须同批——`slots.inject('sidebar.panellist')` + `slots.register({ id:'novel', order:20, label:'小说' }, NovelPanelIcon)`（root 作用域 list：宿主 sidebar shell 渲染行按钮 / `aria-current` 选中态 / tooltip，点击 = `ctx.layout.selectPanel(id)`；占用者只收 owner props `{ size, active }` 出一个图标，`active` 刻意不用——选中呈现归宿主行，不自造第二套）。**面板图标 = android-ebook 启动器前景字形**（用户指定）：外部资产 `xrn1997/android-ebook` 的 `module_app/src/main/res/drawable-v24/ic_launcher_foreground.xml`，pathData 原样搬、viewBox 裁掉自适应图标安全区留白（`0 0 1025 1025`，原 canvas 字形只占 ~47%，16px 行图标下会糊）、`fill="currentColor"` 随宿主行前景色走明暗；白色背板层刻意不搬（暗色主题下是块白斑）。来源与搬运用法的机器钉在 `tests/client/panel-registration.test.tsx`。与 `slots.inject('main')` + `slots.register({ key:'novel' }, NovelPanel)`（root 作用域 keyed：「Central panel selected by sidebar entry id」——侧栏选中同 id 行后 AppFrame 在中央面板渲染它；官方契约「selecting a missing main entry throws without changing the current selection」⇒ 两个座位在 `apply` 内同步注册，无半注册窗口）。**`conversation.view` 注册已撤除**（继 2026 IA 撤 `settings.section` 之后单一归属再收一档：小说只挂全局面板一个入口）。slot-only 路线不变：`uiConversation.views.register` 从来不需要，壳层对未注册 target 宽容。视图内状态口径不变（业务真相在服务端、交互现场在模块级 store）——keyed 槽切走即卸载组件树，回来照常恢复。座位契约与 host 证据见 `docs/reference/dsh-plugin-api.md` §10 证据 10c。
- **常驻状态层：`slots.inject('shell.overlay')` + `slots.register({ id:'novel-status', order:100 })` → `NovelStatusOverlay`**（2026-09，用户批准）。为什么必须是 `shell.overlay`：中央呈现座位一次只渲染一个面板（`conversation.view` 时代官方语义「rendered one at a time」；2026-09 迁移后的 `main` keyed 槽同样按侧栏选中渲染）——切走即卸载我们整棵 `NovelView`，住在面板内的状态条于是切走就没了读数，而任务其实在服务端照跑（口径与证据见 `docs/reference/dsh-plugin-api.md` §10）。`shell.overlay` 是 root 作用域、`list` 基数（新 `id` 与第一方 entry 并列，不遮蔽任何人）、默认 click-through——所以样式层 `.novel-shell-status` 自己 `position: fixed; inset: 0; pointer-events: none`，条身收回 `pointer-events: auto`。任务轮询单实例也一起搬进这一层（它是这份现场唯一的读者与写者），书源管理区改读 `jobSurface` 镜像。**2026-09 真机（重启宿主 + 跑真任务）修掉两条只有实盘会暴露的缺陷**：① 这一层**必须自带 `<NovelStyles/>` 与 `data-novel-scope`**——样式层原先只随 `NovelView` 注入，切到「对话」tab 即整棵消失（实测 `[data-novel-style]` 从 1 条变 0 条），而 `--novel-*` 定义在 `.novel-root, [data-novel-scope]` 上、宿主 overlay 子树里没有 `.novel-root` 祖先，少了这个属性就整棵取不到值（实测读数：底色 `rgba(0,0,0,0)`、圆角 0、字号退回 16px、`z-index` 由 `var(--novel-z-status)` 塌成 `auto`）。口径与「独立挂载点自带样式层」的 `SettingsSection` 先例同源；代价是小说视图在场时文档里有两份同一 CSS（约 49KB 文本），换两棵子树各自自足。② 条身锚点从「顶部通栏」改成「右下胶囊」——`top + left + right` 是从视图内区块头带来的写法，放进 `inset: 0` 的整帧 overlay 后实测读数为「y=6、左右各 8、宽 1264、高 26」，正盖在宿主会话标题行上，而条身 `pointer-events: auto` ⇒ 任务在跑期间那一带宿主自己的钮点不到。现规则：`bottom/right` 各 8px + `max-width: min(420px, …)`，实测胶囊 220×26 贴右下。
- 书源管理 tab（原设置区块）：**挂载点只有一个**——`routeStore` 的 `sources` 成员在 `NovelView` 内渲染 `SettingsSection`。历史形态：曾以 `slots.inject('settings.section')` + `slots.register({ id:'novel', order:100 })` 注册在宿主设置页；2026 IA 变更（用户拍板：书架/书城/书源管理并列）后注册**已撤除**——单一归属（轮询单实例、现场 store 单份），不搞双入口。`SettingsSection` 组件本体未动：deps 整壳注入（`SettingsDeps`）+ 自带 `NovelStyles` 与 `data-novel-scope`（token 锚点），在哪棵树渲染都自足——「宿主设置是另一棵 React 树所以要自带样式」的理由随之过时，但自足性保留（组件可测性不受挂载点影响）。**样式层注入随之改为宿主让位制**：同树两处各注一次等于 45KB CSS 进 DOM 两遍，故 `SettingsSection` 带 `withStyles`（缺省 true＝单飞仍自带），`NovelView` 挂载它时传 false。不用 effect/运行时探测去重：样式注入的钉子走 `renderToString`，effect 在其中根本不执行，而静态渲染里必须带上 `<style>`。
- 视图内路由（`routeStore`，无 URL 路由）：`shelf | city | sources | reader | search` **五成员**（2026 IA，用户拍板）。「小说」tab 打开即书架（兜底）；顶部 tab 导航 `.novel-tabs`（书架 | 书城 | 书源管理，`aria-pressed` + `role="group"`)在 shelf/city/sources 三分支常驻，reader/search 是 tab 之下的沉浸内容流（各有自己的返回导航），tab 不随行。`reader` 带 `sourceId/bookKey/title`，`search` 可带 `keyword`。

## 阅读会话：时序唯一持有者

「目录 → 存档恢复 → 逐章懒加载 → 预取 → 进度落盘」的编排全部住 `reader-session.ts`；视图只做三件事：渲染会话状态、把 DOM 测量实现成 `ReaderPort`、把 scroll/resize 事件喂进会话。

- **为什么**：`progress` / `reader-load` / `scrollport` 三个纯函数模块只是把复杂度挪走——真 bug（在途被占、两帧未落定、切章强制存 vs 防抖存、陈旧闭包）原住在视图的 ref 协调里，无 seam 可测。会话持有状态与策略后，这些时序第一次能被单测驱动（`tests/client/reader-session.test.ts`）。
- **被否决**：把时序留在视图 + 只抽纯函数。历史上视图里五个「防陈旧闭包」ref 就是这条路线的产物。
- **DOM 测量经 `ReaderPort` 注入**：`measureAnchors / scrollTop / setScrollTop / viewHeight / scrollHeight / sentinelOffset / chapterOffset`。视图实现它（两套坐标系只在这一个对象里换算），测试给可编程假 port。会话不碰 DOM ⇒ 无需 jsdom 即可测时序。
- **单在途槽**（`inflight`）：滚动风暴/同章并发只发一次请求；在途期间的目录直达只置 `pendingJump`，在途释放后由 `settlePendingLoad()` 补拉（否则该次点击无声消失、`pendingJump` 永挂）。刚失败过的同一章不自动重试——等用户点「重试」。
- **阅读位置是状态**（`position{chapterIndex, offsetRatio}`）：**唯一真相**。滚动测量、目录选中、存档恢复都只是**修正**它，落盘策略只由单点 `commit(cause, …)` 判定——cause ∈ {`restore` 站定不写、`jump`/`cross` 立即落、`scroll` 防抖落}。为什么要有这条：此前「读到哪儿」是每次滚动现算的一次性输出、没有状态，于是每条时序路径各自决定何时落盘，2026-09-22 的四个真机缺陷（恢复被预取抢槽、旧值迟到覆盖、选中零落盘、跳字回退）全落在这一族。位置一旦是状态，「何时写」与「视口是否动过」就解耦了。
- **进度落盘**：切章**强制存**（不等防抖），同章滚动**2s 防抖存**（窗口属会话构造参数，测试收紧）；两者不同是因为「读到哪一章」是用户可感知的导航事件，「读到章内哪儿」是连续量。走**同一条防抖队列**（挂起位里只剩最新一次读数，迟到的旧值无处可存——此前跨章直发、同章挂防抖两条路，实测 PUT 序列 `19 → 0`：存档停在跳章前那一章）。**退出会话（`dispose`）走 flush 不走 cancel**——防抖窗口内的最后一段章内偏移否则静默丢；无待发值时 flush 不发请求（不许造幽灵写口）。`open()` 里仍是 `cancel`：重开/换书不该把上一本的残值补存一次。
- **恢复位预约**：目录一发布就要**占住**在途槽，直到存档章问回来（`RESTORE_SLOT`）。这一条不是防御性代码：视图的 `checkPreload` 在目录发布那一刻就会开火（哨兵此时是正文里唯一元素、就在视口顶），而存档章要等 `fetchShelf` 回来才知道；先前不占槽时预取先抢走槽，`open()` 的恢复 `load` 走到 `inflight !== null` 半路静默返回——**进度恢复整条丢失**（真机：切会话回来 / 退出再进都变成第一章）。占槽也让那次必然作废的第 0 章预取不发出去。
- **「有没有读过」判据单点**：`shared/wire.ts` 的 `hasProgress`（`chapterIndex > 0 || offsetRatio > 0`）——会话的存档恢复与书架卡片的在读/未读筛选、进度行同源。此前两处各写一份且相反（卡片算了比例、阅读器只看章号），同一条存档「在读」与「没读过」互相矛盾：读第 1 章的人进度永远恢复不了，进书后视口那次读数还会把它抹成 `(0,0)`（真机存档 `(0, 0.9999) → (0,0)`）。存档章越出目录（换源/目录变短）→ clamp 到最后一章，不许落成空白阅读器。
- **恢复定位**：存档章 + `offsetRatio` → 双帧（`afterFrames`，视图 = rAF 双帧）后按 `anchorTop` 落滚动位。两帧是必需的：首帧只保证 DOM 在，第二帧才保证布局落定、锚点可测。
- **锚点带章高，换算两侧同源**：`ChapterAnchor{index,start,height}`，跨度 = **该章实测高度**（`locateChapter` 与 `anchorTop` 同一个跨度，于是互逆；`anchorTop` 结果夹在可滚动范围内）。此前存侧借「到下一章的距离」、取侧借「内容剩余高度」——同一个比例两边算出不同像素，且最后一个已载章（正是用户正在读的那一章）的 next 缺失 → 比例恒 0，章内位置根本存不进去。
- **预取与已载窗口跟着视口走**：预取目标 = **视口章之后**第一个未载章（不是「最大已载章 +1」）；已载集裁到「视口章所属的连续区间」。未载章不进 DOM，所以缺的章会被跳过——只增不裁时，跳 50 再跳回 10 的 DOM 顺序是 `[0,10,50]`（读完第 11 章接第 51 章）。裁窗口只在视口章已载时做（它在途时裁会把用户手上的正文清空）。
- **错误**：加载成功即清 `error`；`retry()` 分叉——章失败重拉该章（`failedIndex`），进入/目录失败则重开。视图的 `onRetry` 必须接 `session.retry()`，**不能**接导出态复位（那对会话错误是空操作，红条会永久粘屏）。
- **`totalChapters` 幂等回写**：只在书在架且缺该字段时补一次，走 `shelfBody.patch` 只发一个字段。
- 书架拉不到不阻断进入（`catch` 后从头读）。

## 持久化与状态归属

- **业务数据不进 store**：书架、源列表、目录、正文每次挂载经 `/novel-api` 拉取，组件内 `useState` 持有。`store.ts` 只承担三类**跨卸载要活下来**的现场：视图内路由（`routeStore`）、阅读偏好（`prefsStore`）、以及各 module 自建的现场 store（`sourceListUi`、transient 队列）。**为什么**：复制一份服务端数据到本地 store 就会产生第二真相与一致性维护成本；而「工作现场」（642 源的过滤/勾选、字号、错误条目）卸载即清零才是不可接受的。
  **这条口径的适用边界（2026-09 已在搜索上落一次先例）**：官方 `slots` 扩展规则与 `web-client` 分层表把「业务与传输状态」判给 Cordis service / Client model，并明写「UI 包…不在 component store 中复制 transport state」。本条的**动机**（不留第二真相）与官方一致，冲突只在**手段**。现在的做法是把**真相留在服务端**、浏览器侧只留一份**可丢弃的投影**：在途工作与结果由服务端持有（后台任务 + 显式快照查询），组件挂载时按游标重读，卸载即整体丢弃——既不复制第二真相，也不再有「卸载清零 = 结果丢失」。搜索这一路已按此落地（`search-job.ts`）；写任务的现场镜像 `jobSurface` 同构。**仍未拍板的是手段的下一档**：这些镜像要不要升格成官方意义上的 Client model / `ctx.sessionProjections` 投影（见「已知开口」第 8 条）。**在此之前新代码照搜索这条走**，别再往组件 `useState` 里塞在途操作。
- 阅读偏好持久化在 localStorage（键 `dsh-novel.prefs`：字号 / 行距 / **栏宽** / 纸色 / 控制器深色），**进度不进 prefs**——进度归服务端书架（`ShelfBook.progress`），这样换浏览器/换机器仍从同一处读。手风琴折叠态的 localStorage 键随手风琴退役一并消失——书源管理 tab 无折叠态。
- localStorage 读写统一走 `util.ls`（无 DOM / 坏 JSON 退内存 Map，不炸）：`renderToString`、SSR 与测试环境都得活。
- **SSR 快照**：三处 `useSyncExternalStore`（`store.ts`、`ReaderView` 读会话、`transient.useTransientFlag`）都传了第三参 `getServerSnapshot`——缺了 `renderToString` 直接抛；`useTransientFlag` 的 SSR 快照是 `false`（无标记）。

## 属性与可访问性

视觉之外的口径（改这些选择器/属性会打掉测试或宿主钩子）：

- 数据属性是**钩子**不是装饰：`data-novel-view="shelf|city|sources|search|reader"`（样式层 `:has` 判在场性）、`data-novel-root`（收 composer 用）、`data-novel-scope`（token 层锚点，书源管理区块必需）、`data-novel-sentinel`（预取边界）、`data-chapter=<i>`（章块）、`data-novel-source-row=<id>`（错误锚点，与 `rowAnchorOf` 同源）、`data-novel-job-status`（状态条任务泳道）、`data-novel-shell-status`（常驻状态层的视口锚：`position: fixed; inset: 0`，本身 click-through，条身收回 pointer-events）、`data-novel-run-card` / `data-novel-source-list` / `data-novel-job-slot`（状态条跳转目标）、`data-novel-inbox`（含 `="empty|ok"`）/ `data-novel-todo="broken|unverified"`（待办箱钩子）、`data-novel-dropzone` / `data-novel-source-filter` / `data-novel-status-filter` / `data-novel-group-filter` / `data-novel-edit-toggle` / `data-novel-import-open` / `data-novel-selbar`。
- **状态类属性也是样式选择器**（视图不写行内色的第三条路）：`data-status="verified|broken|unverified"`（`.novel-badge` 取色）、`aria-checked`（`.novel-switch` 的底色与滑块位移）、`aria-current="true"`（目录抽屉的当前章）、`data-busy`（开关在途）、`data-idx=<i>`（抽屉条目定位，`aria-current` 由视图挪到这一条上）。颜色的主人始终是 `styles.tsx`。
- 语义属性：顶部 tab / 筛选 pills / 偏好 chip 的 `aria-pressed`、目录钮 `aria-expanded`、行内「⋯」菜单 `aria-haspopup`、进度条 `role="progressbar"` + `aria-valuenow`（只写在 `bits.ProgressBar` 一份里）、删除按钮与偏好钮 `aria-label`、装饰性状态点与 emoji `aria-hidden`。
- **主操作的承载元素必须是真 `<button>`**（不是 `div[role=button]+onClick`）：书架卡片、引导卡、搜索命中行都是。理由朴素——`div[role=button]` 只绑鼠标，键盘按 Enter 什么都不发生（WCAG 2.1.1/4.1.2）。配套口径：**同一行内的第二个动作（删除 ✕、「＋ 加书架」）是主钮的兄弟，不是后代**，否则读屏念「按钮 内含 按钮」。卡片钮写显式 `aria-label="阅读《书名》"`——不写的话无障碍名 = 格内文字拼接（首字色块那个字也在内）。守卫 `ui-system.test.tsx` 扫 `[role="button"]` 与 `button button`，出现即红。
  - 唯一例外是导入区的拖放区（要收 drop/drag 事件、内容是块级组合）：保留 `div[role=button] tabindex=0`，但**自带 keydown**（Enter/Space 打开文件选择）。
- 焦点可见：`--novel-ring`（= `--novel-brand`）+ `outline-offset: 2px` 统一覆盖 btn/input/textarea/chip/seg/卡片/命中行/抽屉项/开关/拖放区；`.novel-searchbox` 靠 `:focus-within`（输入框自身 `outline:none`）；`.novel-btn.primary` 上环色换 `--novel-text`（brand 压 brand 等于没有）。`.novel-dark` 必须重钉 `--novel-ring`——自定义属性在声明处算完即继承（同 brand 派生色那个坑）。
- 与指针无关的 affordance：只有 hover 才显形的东西必须有第二条路。删除 ✕ 在 `@media (hover: none)` 下常驻可见；卡片 hover 的抬升/投影在无 hover 能力时关掉（触屏上「按下去才浮起」是错觉）。动效另有 `@media (prefers-reduced-motion: reduce)` 一刀关净。
- 颜色一律读 `--novel-*` 局部 token（视觉规则里不散写宿主 token，也不写死品牌 hex）；只有 token 定义处与「正文层」色值允许字面量。**本层 token 引用自足守卫**：`ui-system.test.tsx` 扫样式层与视图里每个 `var(--novel-*)`，未在 `styles.tsx` 定义即红——`theme-tokens` 只钉宿主 `--dsw-*` 真名，管不住本层抄错的名字（口径见下节「标度」）。

## 标度（样式层的第二份契约）

`styles.tsx` 除了配色 token，还持一套**尺寸标度**，视觉规则只准读它们：

| 标度 | 档位 | 口径 |
|---|---|---|
| `--novel-sp-0..7` | 2/4/6/8/12/16/24/32 | 间距（padding/gap/margin）。散值（3/5/7/11/13/18/22px）的代价不是丑，是同一层里读者判断不出哪一档才是意图，改一处无从对齐其余三十处 |
| `--novel-fs-xs..xl` | 11/12/13/14/16/19 | 字阶。**中文最小 11px**——10px 的「本地」角标笔画会糊成一团 |
| `--novel-r-xs/sm/md/lg` | 4/6/8/12 | 圆角（封面/徽丸 / 按钮/输入件 / 面板/抽屉 / 模态） |
| `--novel-shadow-1/-2/-pop` | 三档 | 贴页 / 浮起 / 模态。投影无宿主 token，字面量只住这里 |
| `--novel-dur` / `--novel-ease` | .15s / `cubic-bezier(.2,0,0,1)` | 动效。全部可被 `prefers-reduced-motion` 关净 |
| `--novel-z-*` | status 5 < mask 10 < panel 11 < toolbar 12 < modal 30 | 浮层层级**单表** |

- **z 序两半各有主人、由测试缝起来**：控制器层三级住在 `ReaderView` 的 `CTRL_Z`（行内 style，`reader-ctrl-z.test.ts` 钉「组件真用这套常量」），样式层两级住 `--novel-z-*`。`ui-system.test.tsx` 断言 `--novel-z-toolbar/panel/mask` 与 `CTRL_Z` **同名同值**、并钉全序；视图里出现裸 `zIndex: <数字>` 即红。为什么不用一个源：`CTRL_Z` 必须是 JS（sticky 工具栏的 stacking context 不变量要在渲染输出里断言），而 `--novel-z-*` 必须是 CSS（模态与状态条由类定位）。
- `--novel-pct` 是**值槽**不是颜色：唯一由行内写入的动态量（进度段、章进度细线都只写它），推进由样式层 `transform: scaleX(var(--novel-pct))` 完成。它在 token 层有定义（`= 0`）有两个理由：一是视图行内写、样式读的这一路必须在词表里在册，否则 token 自足守卫误判；二是**改 width 为 transform** 本身是性能口径——一屏几十张卡 + 搜索条 + 运行卡同时在途时，`width` 每帧触发布局，`scaleX` 只走合成。

## 控制器层与正文层

- **正文层永不接宿主 token**：纸张色由 prefs 固定，字色由 `paperInk(paper)` 按感知亮度（WCAG 线性化 + Rec.709，阈值 0.35）择深/浅二值。**为什么**：皮肤 token 是半透明玻璃值，压在自选纸张色上没有对比；写死深色字在自选深纸上等于隐形。**被否决**：正文层跟随主题（`--novel-*` 参考的是宿主层板，不是纸张）。
- **深浅主题靠引用宿主语义 token**（`--dsw-alias-*`），光/暗由宿主 `body[data-ds-dark-theme]` 覆盖，本层不做深浅判断。踩过的坑：`--dsw-alias-border-l` 是不存在的假名（宿主只有 `l1..l4`），引用它不报错、只静默落回硬编码 fallback。
- `darkController` 是用户显式选择，因此 `.novel-dark` 允许字面量钉暗底值，且必须重钉 `--novel-layer-1` 与四个 brand 派生色（自定义属性在声明处算完即继承，换 brand 不会回填上层派生值）。`novel-dark` 挂**工具栏根**而不只挂 Aa 面板——否则是「暗面板 + 亮工具栏」。
- **Aa 面板 z 序不变量**（`CTRL_Z = { toolbar: 12, mask: 10, panel: 11 }`）：sticky 工具栏自建 stacking context，面板的 z-index 只在工具栏内部有效；工具栏 ≤ 遮罩时，透明遮罩反压整层，点击被吞 = 「Aa 能弹出但点不了」。目录抽屉与 Aa 面板**及导出范围面板**互斥（开任一先关其余两者）、永不同场，三者共用**一条 Esc 与同一层遮罩**（`expOpen` 与 `ctrlOpen` 同候遮罩渲染）；抽屉现在是**浮层**（0 宽槽 absolute 子件），所以它的 z 走 `--novel-z-panel`（与 `CTRL_Z.panel` 同值，由守卫钉住两侧一致）——正文在它下面，压字要有底。行内 z 只留工具栏/遮罩/面板三处。
- **导出 = 先选范围再开下（2026 用户拍板，替代「一点就全下」）**：⤓ 钮 idle 时**只开 `ExportPanel` 不发请求**（确认前零请求是接线钉子），面板内起止章输入 + 「整本 / 当前章起」预设 + 确认/取消；校验单点 `export-run.parseRange`（空串 / 非整数 / 倒置 / 越界 / 目录未就绪一律禁确认——**宁可不发不发废包**），视图不再自拼第二份判据。运行中面板换进度视图（`ExportRunState` 投影，可就地取消）；工具栏⤓ 钮 running 时仍是取消钮。文件名口径在 `export-run.exportFileName`：全本（或 1..total 全覆盖）= `书名.txt`，部分 = `书名（第5-80章）.txt`——部分导出不加后缀会让人把片段当全本存丢。wire 侧 `queries.exportBook` 的 `from/to` 缺席即全本（零参数旧链接向后兼容）；**越界裁剪与倒置判据的单点在 `api/dispatch.ts`**（`exportBook` 只接受裁好的范围，越界即抛，不再自己抄一份 clip），见 `docs/design/services.md`「章节范围导出」节。
- **阅读器呈现层**：布局归样式类——`.novel-rdr-bar`（细工具栏：‹书架 · 居中书名 · ⤓（范围面板入口）/Aa/目录 + 下沿 2px 章进度细线 `.novel-rdr-trail`）、`.novel-rdr-body`（正文列 + 章头 `h2` 居中）、`.novel-rdr-main`（阅读区：正文与抽屉槽所在的 flex 行，`align-items: flex-start`）；行内只留 prefs 驱动的纸色/字色/字号/行距/栏宽与 `CTRL_Z`。章头用 `h2` 不用 `h3`：阅读器这一屏没有更高标题占位，从 h3 起等于给读屏一份断了头的大纲。
- **阅读区 full-bleed 纸面**：纸张色涂在 `.novel-rdr-main`（行内 `style={{background}}`），**不涂在正文列上**；`.novel-rdr` 另有 `min-height: 100vh` 兜住「正文短于一屏时下面漏底色」。旧做法纸色跟着正文列走，宽屏下就是一张 680px 的窄带飘在宿主底色里（实测 1500px 视口左右各漏底 410px）——那不是留白，是**纸没铺开**。现口径：纸铺满、字排窄（实测 900/1400/1800px 三档 `paper_w` 恒等于容器宽，正文列恒 680px / 38 字）。
- **正文栏宽是值槽 + 用户旋钮**：`.novel-rdr-body { max-width: var(--novel-measure) }`，缺省 `36em` 住 token 层、行内由 `prefs.measure` 覆写（`MEASURES` 四档：窄 28 / 中 32 / 标准 36 / 宽 44；Aa 面板「栏宽（每行约 N 字）」一行）。`em` 让它**随字号缩放**——旧实现 padding 写死「列宽 640px」，字号旋钮越大每行字越少（实测 12px → 53 字/行、28px → 23 字/行，两端都出舒适区）；`em` 后标准档恒在 38 字上下，44em 档实测 824px / 46 字。
- **目录抽屉：锚视口、且不切走正文宽度**——结构是 **0 宽 sticky 槽（`.novel-drawer-slot`）+ absolute 抽屉本体**。三版死法各不相同，逐版记账（都在样式层 `.novel-drawer-slot` 注释里）：
  - ① flex 兄弟 + sticky 但**高度无上限**：912 条目录比正文还高，flex 行高 = max(正文, 目录) → 整页撑到两万多像素。
  - ② `absolute` 锚 `.novel-rdr-main`：不撑页了，但 absolute 锚的是**内容盒起点**（= 正文开头），读到第 500 章点「目录」，抽屉画在你头顶上方两万 px 处；且 `max-height: calc(100% - 20px)` 的 100% 也是正文高度（复刻实测：父高 2400px、视口 766px 时约束算出 2380px，形同虚设）。
  - ③ 兄弟 + sticky + `max-height: 100vh`（本轮上一版）：锚对了、也不撑页了，但**可滚动的 flex 列里条目会在滚动发生之前先被 `flex-shrink` 压扁**——实测 60 条目录每条只剩 12px 高（850px 内容塞进 678px 容器）+ `overflow: hidden` 裁字 = 一叠互相咬住的细条。**加视口上限才暴露它**，②的上限形同虚设所以从不触发。
  - 现方案的两处修正：条目 `flex: none`（守卫钉死）+ 槽 `width: 0`。槽 sticky 所以跟随视口，本体 absolute 所以不占列宽；实测视口 766px 下正文回到 **680px / 38 字/行**（③ 是 399px / 22 字），条目 **29px** 高、内部真滚动，滚到 y=9000 后抽屉 `top` 仍是 44px。窄屏时抽屉压在正文上——选章是瞬时态，**压字可接受、挤列不可接受**。
  - 刻意不用 `position: fixed`：那要赌宿主祖先链没有 `transform`/`filter`/`contain`（有则 fixed 的包含块被它抢走）。sticky 这条路已被 sticky 工具栏在本环境实测证明可用。
- **抽屉条目被 memo 住，当前章高亮走 `aria-current` 单点移动**：`drawerItems = useMemo(..., [toc, session, sourceId])` + 一个 effect 把 `aria-current` 挪到 `[data-idx="当前章"]` 上。为什么：抽屉挂在 `ReaderView` 里，会话每次 notify（载章/清错/跨章）都会重跑本组件，逐条现造 = 每次白造 toc.length 个元素（千章书），而多数时候抽屉是关着的。样式与语义同一个源（`[aria-current="true"]` 选择器），所以不需要 `.cur` 类，也不需要把 `currentChapter` 塞进 memo 依赖。
- **跨章可见性走低频量**：会话新增 `currentChapter`，**只在 `chapterIndex` 变化时写 store**（同章滚动仍走防抖落盘、不唤醒渲染）。消费者两个：工具栏章进度细线、目录当前章高亮。章内百分比刻意不做——那才是每帧量，会让整棵阅读器每帧重渲染。
- **滚动容器 = `.novel-main` 自己（五分支同一条 overflow 链，2026-09-21 修复）**：`.novel-root` 定高 `overflow:hidden`、`.novel-main` `flex:1 + overflow-y:auto`，阅读器一视同仁不放开——`scrollport.ts` 从正文向上探测「谁在滚」（现即 `.novel-main`），进度锚点与回跳一律按探测结果算，不赌容器身份。滚动事件在 `document` 的 capture 阶段收（scroll 不冒泡但捕获经过 document），rAF 合帧。
  **病史（放开规则已删，别加回来）**：阅读器曾有 `.novel-root/.novel-main:has([data-novel-view="reader"]) { overflow: visible }` 两条放开规则，把正文交给宿主 resident scrollport（`[data-conversation-scroll]`）承载——那是 conversation.view 时代的前提（当时该 scrollport 确是祖先，工具栏 sticky 也靠祖先链无其他滚动容器）。a9f35f7 迁全局面板后，祖先链变成宿主 `centerCol`/`frame` 双 `overflow:hidden` + `html,body{height:100%}`，**整条链上没有任何可滚容器、文档也被 frame 的 hidden 挡死**：放开 = 滚轮无处可滚、正文 24247px 被裁在 807px 首屏、scroll 事件永不开火 → 进度落盘/预取哨兵/跳章定位一并失效（`scrollport.ts` 头注列的正是这套症状）。只有阅读器中招：书架/搜索本就没有放开规则、`.novel-main` 自己正常滚。**为什么没测试拦住**：jsdom 无排版引擎量不出滚动，smoke 只断言选择器字面在场；迁移提交自己记账了两条 composer `:has`「几何性失效」，漏了这条——它不是选择器失效（选择器仍命中），是它**保证的前提**（链上有 scrollport）没了。诊断用三链差分探针钉死（真 `NOVEL_CSS` + 真阅读器 DOM + headless Edge 真 wheel，唯一变量 = 宿主祖先链：迁移前链可滚到 1800、迁移后链纹丝不动、迁移后链拔掉放开规则即恢复、`port=.novel-main`），回归钉子在 `smoke.test.tsx`「阅读器：不放开 overflow」。
- **无排版环境下的预取会拉完全书（判据不动，别误读成产品开销）**：jsdom 里 `getBoundingClientRect` 恒 0 → 哨兵偏移 0，而 `viewHeight()` 落到 `window.innerHeight` → 「边界已进 3 屏」每次都成立 → 一章接一章自限链跑到全书（实测 toc=912 时 chapterCalls=912、92s）。生产里正文会变高、链条自限，所以 `nextLoadTarget` 的判据是对的；要量产品渲染开销得去真浏览器（本机 headless 渲染复现件默认只出 60 章的图，设 `HARNESS_TOC=912` 即复现该连锁；该复现件属过程产物不入库，此处只记读数）。
- 样式层还用 `:has` 做两件事：小说 view 在场时收掉宿主常驻 composer 的**默认层**（只藏 `[data-chain-overlay-fallback]` 那一层——整座 `display:none` 会吞掉提问/审批等兄弟接管件）与配套的列宽拖拽把手（兄弟选择器 `~`，不误伤对话视图）。**2026-09 全局面板迁移后这两条选择器几何性失效**：小说子树不再与对话区 composer 同株，规则永不命中——保留不删（smoke 守卫仍扫它们在场，且 `conversation.view` 座位仍在宿主里服务 chat/trajectory）；真要清理由下一次样式层打扫一并做。

## 书架 + 进度

- 首页 IA（2026 两轮演进，用户逐轮拍板）：小说视图顶部是 **tab 导航 `.novel-tabs`**（书架 | 书城 | 书源管理，`role="group"` + `aria-pressed`，激活态 brand 弱底 + 强调字）——三者并列，选择即切换下方内容；曾短暂存在的「书城预留位占位 chip」（`.novel-shelf-city`/`.novel-city-ph`）已随之**退役**：占位不如真导航（书城未上线点开是 `CityView` 诚实空态，内容上线后填充该分支，导航结构不用再改）。书架 tab 内容顶栏**三行**：**行1** = 内容标题「书架」+ 灰字计数「N 本」（`.novel-shelf-count` span，结构与批准的交互 mock 同构；`white-space: nowrap`）。**行2** = 搜索簇单独一行 `.novel-shelf-search`（`flex: 1 1 100%`；form = 搜索框 + **「搜索」提交钮**（与搜索页同款 `type="submit"` + `.novel-btn primary`——Enter 是隐藏交互，可见按钮才是显式入口，用户提议；搜索页早有同款先例，书架缺它是不一致）；form 基准 460px（380 框 + 钮 + 间距）可收缩、不写死 width；**整簇 `justify-content: center` 居中**——用户实机反馈拍板：书架主操作是「找书」，居中给顶栏视觉焦点，不再与左下网格抢左边缘；`.novel-searchbox`：放大镜图标 + 无边框输入装进**层底**圆角容器，focus 描边走强调色；placeholder 钉子「搜书名 / 作者」；簇尾灰字「聚合全部书源」随簇居中）。**行3** = 书架筛选簇 `.novel-shelf-filter`（`flex: 1 1 100%`，有书才渲染；`.novel-seg` 全部/在读/未读/本地，`aria-pressed`，整段 `role="group"`）+ 簇尾灰字排序说明。搜索页顶栏用同款 `.novel-searchbox`（`bits.SearchIcon` 共用）。**为什么这样排**（两轮实测病史）：① 旧「工具组与同行 flex item（旧 `.novel-shelf-tools`）被 Chrome 的折行算法算成 min-content 量级假设主尺寸——四件东西需要 706px 被算成 651px、只剩两件时被挤到 215px（探针实测），搜索框与导入钮在标题旁折行堆叠；改成显式三行（`flex: 1 1 100%` 独占行）后不存在这条折行路径。② 排序灰字的 `margin-left: auto` 把它钉到 1600px 列最右端（实测 x1472 vs pills x75）＝悬浮碎片，已删——书架顶栏从此**没有任何 `margin-left: auto`**（书城预留位随 tab 化退役，「右半留给书城」不再需要预留位形态；守卫原话留档：要贴右请先确认那块还要不要）。③ 搜索独占一行的 IA 理由：聚合搜索是「找新书」入口，书架筛选（pills）是架上内容的过滤，两个语义组不混排。**顶栏整行 `flex-wrap` + 标题 nowrap** 不变：宿主会话列可拖窄，实测死宽 260px 时 380px 列里标题被压成 22px（一个字一行竖排）；守卫钉住：head `flex-wrap`、标题 `nowrap`、`.novel-shelf-search`/`.novel-shelf-filter` 各自 `flex: 1 1 100%`、搜索框 form `flex: 0 1 Npx` 且无固定 width、`.novel-shelf-sort`/`.novel-shelf-filter` 不许 `margin-left: auto`。筛选口径住 `shelf-view-model.ts`：`reading` = 有实质进度（`chapterIndex > 0 || offsetRatio > 0`）、`unread` = 补集、`local` = `sourceId === LOCAL_SOURCE_ID`（**正交维度**——本地书是文件级操作的对象）。
- 网格：`repeat(auto-fill, minmax(116px,1fr))`（116 而非 104：宽屏下 12 列时封面仍要认得出书名首字），**一格 = `.novel-cell` 里的两个兄弟按钮**（`.novel-card` 打开钮 + `.novel-card-x` 删除钮；打开钮带显式 `aria-label="阅读 <书名>"`）；卡片 = 封面 + 标题 + 元信息灰行 + 2px 进度条（无进度不出条）；hover **与 `:focus-visible`** 有底色/抬升/投影三件套。网格末位常驻引导卡 = **「导入本地书籍」**（`.novel-card-ghost`，点击触发隐藏 file input）：工具栏「导入 TXT」钮随顶栏重排移除，导入职责单一归这张卡；旧「搜一本书」引导卡退役——搜索职责已由行2搜索框显式承担，同一职责不留第二个入口。空书架（真零本）走 EmptyState 分支不渲染整网格，导入卡以 `.novel-grid.solo` 单卡居中兜底（空态文案是测试钉子，原文「书架空空——上方搜一本书开始阅读」不动；加载失败分支不出导入卡——服务端不可达时导入同样会失败）。封面 2:3 + `loading="lazy"`；无封面或 `onError` → 书名首字色块（`coverFallbackChar` + `coverTintClass` 四档，token 层 `--novel-cover-1..4` + color-mix 提亮渐变与顶部高光——**降级封面是有质感的封面，不是灰色占位符**，浅色宿主下它是书架的视觉锚点；hex 不出 `styles.tsx`）。
- 内容列上限 `.novel-wrap` **按场景分档**（`--novel-wrap-max` 值槽）：书架 1600px、搜索 1100px，缺省 900px。为什么不是一份通吃：900px 是「文档阅读宽度」的度量，套在缩略图画廊上实测 1400px 屏两侧各空 226px、1800px 各空 426px，而网格明明还能长出更多列（卡片停在 7 列 × 115px）；改成画廊 fill（同屏 10–12 列）、文字列表留可读行长上限。两条上限由守卫钉住（含「搜索必须窄于书架」这条关系，防止有人顺手抹平）。
- 首次加载渲染**骨架卡**（8 张 `.novel-sk`，按同一网格占位）而不是「加载中…」一行字：文字→整屏网格的一跳会顶掉用户刚看清的位置。shimmer 在 `prefers-reduced-motion` 下关净。
- 卡片元信息与百分比的**唯一算式**住 `shelf-view-model.shelfCardMeta`（在读有总数 → `721/1162 章 · 62%`；未读 → `未开始 · N 章` 且 pct 归 null；缺总数 → `读至第 N 章`；本地 → `本地 TXT · x%`）；`chapterIndex` 0 基存档、展示转 1 基。已知开口的「百分比算式已收敛一处、剩两处」那条，其 shelf 内联分量已收敛于此。
- 删除：卡片 ✕ → **模态确认**（`.novel-modal-mask`/`.novel-modal`，`role="dialog"` + `aria-modal` + `aria-labelledby` 指向含书名的标题；Esc / 点遮罩取消；确认钮 `.novel-btn.danger.solid` 危险色；在途禁双击）→ `DELETE shelf/:key`。**模态是焦点闭环**：入场焦点在「取消」、Tab 圈在框内、关闭后焦点还给触发它的那张卡片的 ✕（旧实现只挡 Esc，Tab 能一路走出框外——对话框还挂在屏幕上，人已经在下面的书架里了）。**成功才本地过滤并关模态；失败留在框内**就地报 `删除失败：…`，可重试可取消，卡片保留（乐观删除的回滚半场归接线测试钉死）。文案口径：在线书点名「阅读进度记录一并删除」；本地书点名删的是 **DSH 数据目录中的副本**（默认 `~/.dsh/novel/local/`，随 `dataDir`）并明示**原始文件不受影响**——服务端真相就是删 `dataDir/local/` 下的 uuid 副本 + 元数据（`LocalBooks.remove`，插件从不持有用户原始文件路径，`BOOK_KEY_RE` 严格 uuid 校验兼防路径穿越）；文案不说清这个区分，用户会误以为动了自己硬盘上的原件（`deleteBookCopy`，钉子在 `shelf-delete.test.ts`）。接线测试另有 Esc / 遮罩取消两道钉子：取消零 DELETE 请求。
- 加载失败不伪装成空架：`setBooks([])` + `loadError` 双写，空态文案按有无错误分叉。
- **来源 chip（封面左下）**：色点 + 源名。色点按 `sourceId` 派生四档（`util.sourceTintClass`，与首字色块同一份四档 token——hex 仍不出样式层），于是同源同色、异源异色，一屏之内一眼分得出来源不同。文案口径归 `shelf-view-model.shelfSourceTag`：**本地书不出 chip**（本地身份已由封面「本地」与角标承担，同一事实不给第三个说法）；服务端 join 不到源名（源已被删）落灰字「来源已删除」。来源名是**读取面投影**（`GET /shelf` 的 `ShelfEntry.sourceName`，服务端 list 时 join 注册表，见 services.md §10），**不是落盘书目字段**：源改名/同址换源即时生效，源一删就如实说没了，绝不拿快照旧名糊过去。位置钉在封面左下——右上归删除 ✕、左上归本地角标与多选勾选标记，四个角各司其职（`.novel-cover-box` 是封面定位盒，由此不再靠封面自身 margin 撑间距）。
- **批量删除（多选态）**：行3 筛选簇尾的「选择」入态——筛选簇让位给批量条（复用书源管理同款 `.novel-selbar` 与同款词汇：**已选 N / 全选 / 清空选择 / 删除所选 / 退出**），卡片点击改为勾选（`aria-pressed` 如实、`aria-label` 换成「选择/取消选择《书名》」、勾选标记是卡内装饰 span 而非第二个控件），单本 ✕ 与「导入本地书籍」引导卡退场（同一职责不留第二个入口）。**「全选」= 当前筛选可见的书**——筛选在多选态定格，这条口径才有唯一答案（这正是让筛选簇让位的原因）。选择态是**现场**（组件 state，切 tab 重挂载即清零——残留一批旧勾选去撞下一次删除，比丢现场危险得多；与筛选 pill 同一条口径，刻意不进 `store.ts`）。确认走**同一个模态**（焦点闭环、Esc/遮罩取消零请求两条钉子都不动）：`pendingDel` 记 `{ books, batch }`，**入口决定路径**——✕ 走 `DELETE shelf/:key`（文案照旧「删除《书名》？」），「删除所选」走**一次** `POST shelf/batch-delete { keys }`（keys = 点击时快照；文案「删除选中的 N 本书？」，含本地书时点名「其中 N 本为本地书」+ 副本连删与**原始文件不受影响**）。成功才本地过滤 + 清勾选（批量另退多选态），失败留在框内可就地重试（与单本一致，不学源删除那条「失败即收模态」——两条口径各自成立，理由见源删除节）。钉子：`shelf-batch.test.tsx`。
- 本地 TXT 导入：隐藏 file input → `POST local/import?name=<文件名>`（octet-stream）→ 服务端返回 `{ bookKey, title, sourceId }` → 直接进阅读器。文件名只作 query 参数，正文以字节流上行；本地书的源身份与解析全归服务端。**落地时要过 alive 闸**（`ShelfView` 的 `aliveRef`）：`navigate` 住在模块级 store、与组件存活无关，所以在卸载后的 `.then` 里照样会执行——不加闸就等于「导入完成把用户从别的 tab 拽进阅读器」（实测缺陷）。两个半场都不许静默：在场走场景内红条（可就地重试），已切走走瞬态层（成功进 ok 泳道、失败进 error 泳道）。
- 本地书在书架上有专属呈现：封面位直接写「本地」（`.novel-cover-fallback.sm`）+ 角标「本地」而不是取首字（源身份固定，与在线书区分），删除确认文案另点名副本连删与原始文件不受影响。

## 搜索：提交后台任务、游标读快照、失败折叠

- **一轮搜索是 Node 半的后台任务**：`POST search/job {keyword}` → `{ jobId }`，此后浏览器半只做一件事——盯住这一轮（接线单点 `search-job.ts` 的 `useSearchJob`：SSE 优先、快照轮询兜底，节奏 `POLL_MS = 600`，一次只让一个读在飞）。批循环、并发、整轮结果持有全在服务端（`services/search-job.ts` 持有 + `searchProgressive` 运行）。**搜索页不再调 `search/plan`**：本轮总数由快照的 `total` 交代，少一次往返，也断了「客户端拿 plan 自己跑批」这条重复路径（路由本身留给工具面与外部调用方，README 照录）。
  **为什么搬**：宿主把 `conversation.view` 定为「一次只渲染一个」，切 tab 即卸载组件——旧的浏览器半循环把结果握在 `useState` 里，离开界面即清零、回来整轮重打（双份代价，实测数字见已知开口）。搬过来之后「离开界面」与「任务是否完成」脱钩：卸载只是停掉这条连接与这块表，重挂载从 `since=0` 重读一遍就全回来，**含切走期间才搜完的源**。
- **投递通道：SSE 优先、快照轮询兜底**，两条共用同一份合并代码与同一条游标。`GET search/job-stream` 的每帧就是 `search/job-status` 的那一份 `{ job }` 快照，所以客户端没有「推送态」与「查询态」两套判定；任一时刻只有一条通道在推进游标（两条同时在飞会把同一批命中累加两遍），规则是「流在就不问，流断才轮询」，终态帧由客户端自己 `abort` 关流。**为什么选自有 SSE 而不是 Session 事件 + projection**：② 已把常驻呈现位定在 `shell.overlay`（`root` 作用域、会话无关），而 projection 的读面按会话作用域走——把进度挂到会话上，正好与常驻层要「在任何界面都说得出口」的前提冲突。加之官方明写通知不 replay（`docs/reference/dsh-plugin-api.md` §9），projection 那条路仍然需要一条同样的显式快照查询兜底，等于两条都要写。刻意**不用 `EventSource`**：它自带重连与 `Last-Event-ID`，等于把游标交给浏览器，与「客户端握着游标」这条口径相反——故走 `fetch` + 流读取（`api.ts` 的 `apiEventStream`）。
- **限流口径变了，且更克制**：旧的是浏览器半 3 批并发 × 每批 20 源、批内服务端 5 并行（≈15 条在途）；现在是服务端单一 `searchParallel`（缺省 5）条在途，没有「多批叠加」这条路。被否决：把 `searchParallel` 调到 15 去「还原」旧吞吐——旧数字本来就是两侧各写一份并发常数的产物。
- **陈旧响应防线换了主人**：轮次身份就是服务端 `jobId`。累积器（`id`/`since`/`groups`）握在 ref，回包先比对身份，被新一轮替换或已卸载即丢弃（历史 bug 形态：一轮迟到批次污染二轮结果）。挂载恢复与提交走同一条路，所以「恢复先回来、提交后落地」也不会互相覆盖（提交的结果后置且说了算）。
- **轮次身份与游标不可分开**：服务端读面是**单槽 + 数字游标**——别的页面（或本页另一次提交）启动新一轮后，旧连接 / 旧游标读回来的快照是**新轮按旧游标切的片**（评审复现：id 停在 A、keyword 已是 B、分组 `['A-result','B-second']`，B-first 被旧游标吃掉）。观察 module 的裁决：每个回包（SSE 帧或轮询）先验 `job.id === acc.id`；不一致即**换轮收尾**——旧累积整体丢弃、`since=0` 显式重读新轮完整基线、旧连接 abort、按新轮重建观察。**裁决：旧观察者跟随最近一轮**（服务端只保留一轮，跟随是唯一能收敛的语义）；被否决：只改 id 继续追加（A/B 混排）、只丢帧继续等旧任务（单槽下旧轮永远等不到下一帧）。三种时序钉在 `tests/client/search-job-round-identity.test.tsx`（同一观察 interface 覆盖 SSE 帧与快照查询两种 adapter，「服务端」是真实 `SearchJobs` 持有者，假的只有传输）。与上一条各管各的：本页提交换的是 ref 引用（`acc.current !== a`），跨页面换的是 `job.id`——两道闸缺一即漏。
- **停止搜索钮（`POST search/job-cancel`）**：跑着就在进度行内出现一个「停止搜索」（`.novel-prog-text` 本就是 flex + gap，钮不加行内 style）。语义按用户口径钉死：**停止 = 不再往下搜，已搜出来的命中一律留在页面上**——服务端只是把本轮立即结算成终态（宿主侧 `killed`），读面的分组一个不清；在途的最多 `searchParallel` 条不撤回（回来仍计入本轮，但要再进一次页面才看得到）。三点边界写清：① 停止不禁止再搜——钮随 `running` 消失，「搜索」钮即刻可点，再搜是**替换**本轮的新一轮；② 收口行前缀「已停止 · 」而不是错误红条（`cancelled` 为真时客户端强制清 `error`）；③ 退出页面**不是**停止（本轮照跑完，30 分钟内可翻）。`SearchJobSnapshot.cancelled` 是**契约字段**而不是「去比对那句中文」：判据上契约，刷新后重读同一轮才知道「这是用户停的、不是搜挂了」。
- **两种失败分开报**：某源未响应是分组里的 `error`（照旧折叠成一行 `details`）；提交失败 / 读面失败是页面级「搜索中断」。读不到就收手，不再排下一次（历史形态：spinner 到天荒地老）；提交失败**不清已在手上的结果**——服务端没起新轮，旧结果仍是真相。
- 渲染：进度 = 一条 4px `ProgressBar`（brand 填充）+ 灰字「已搜 done/total 家书源」（`data-novel-search-progress` 容器）；**完成那一刻进度条不倒退、收口行常驻**——「本轮搜过 N 家 · 命中 M 本（来自 K 家）· J 家未响应」（`sumRound`，**N = 游标累积下来的分组数 = 真搜完的源数**，不是快照 `total`；旧实现整块消失，用户分不清「搜完了」还是「断了」。2026-09 真机抓到这条算式在「停止」出现后开始谎报：计划 431 家、实搜 29 家，文案却写「本轮搜过 431 家」——因为 `total` 是参搜计划；进度条同一处毛病（收尾态写死 100%，29/431 也显示满格），两处一起改成只认 `groups.length` 与 `done/total`）。有命中的源成组列出（组间 gap 24px，组头 hairline 下边线；组头 = 源名 + **`bits.StatusBadge`（verified→「可用」中文映射——原始状态字不进 UI）** + 本数灰字；组头原先「绿点 + 带点的徽标」双重点，点不携带徽标之外的信息，去掉）；命中行 = 发丝分隔线列表（容器 `.novel-row` + 主钮 `.novel-row-main` + 兄弟动作钮，末行无线；hover 与 `:focus-visible` 行底 + 书名变强调色，「＋ 加书架」hover 描边走 brand）+ 两行（标题 / 作者 · 最新章节灰字）；失败源折叠进 `<details class="novel-fail">`（点名 code / message / statusDetail）。
- 快照 `total === 0`（源全停用 / 未导入）→ 显式空态「没有参与搜索的书源」，与「搜了没命中」区分开（否则只剩一条 0% 进度条）。
- 命中行两个动作：点主钮 = 先加架（进度保存依赖书架条目）再进阅读器；「＋ 加书架」只加架（已加过置灰「已在书架」；它是主钮的**兄弟**，所以不再需要 `stopPropagation`，也就没有「冒泡忘拦 → 点加架顺手跳进阅读器」这类隐患）。`hit.url` 为 undefined/null 时该行渲染成 `.novel-row-dead`（竖排两行、无 hover 可点态）；空串 `''` 仍会走进可点分支——见已知开口的「`hit.url` 是空串时会用空 bookKey 加书」。
- 从首页带关键词跳进来时，`route.keyword` 作为初始 state 并在首个 effect 里**提交一轮**（只认挂载时那一次，不订阅后到的路由变化；`useRef` 一次性闸防 StrictMode 同实例二次 effect）。**提交即摘除关键词**：`navigate({ name: 'search' })` 把 route 收成无关键词成员——`route.keyword` 的语义是「书架刚交来的搜索意图」，**消费一次就失效**。为什么必须摘：`routeStore` 是跨卸载存活的现场（store.ts），不摘的话「退出小说界面再进」（route 还带着关键词重新挂载）与「从书架新鲜跳入」在挂载时不可分，重挂载会无条件再提交一轮，而服务端搜索读面是**单槽**（`services/search-job.ts` 的 `start`：新提交即替换，旧轮在跑则被杀）——整轮从头重搜、目标站点白挨一遍（2026 真机实测 bug，用户报告）。摘除后重挂载只剩「挂载即恢复」一条路（读 `since=0` 快照、零提交）；配套 UX：恢复出的轮次回填空输入框（`filled` ref 每挂载至多一次、只在框为空时，不抢正在输入的内容）。刻意不做的替代：服务端按同关键词去重（`POST` 的「搜索」是显式动作，同关键词再搜就该是新一轮——要区分的是**挂载**与**显式提交**，这个判据只有客户端知道）；服务端单槽语义不动（读面两轮并存才是第二真相）。
- **每源命中截断**在服务端（`SEARCH_HITS_CAP_PER_SOURCE = 50`）：浏览器半不再持有无上界的整轮结果，所以截断要有主。整轮结果保留 `SEARCH_JOB_RETENTION_MS`（30 分钟），过期读作「无任务」而不是空结果。
- **两条退出路径要分清**：切走页面 / 关浏览器**不**停止服务端那一轮（见上面「一轮搜索是 Node 半的后台任务」）；要停就按「停止搜索」（上面那条）。此外宿主 `ctx.jobs` 侧的 kill 通向同一个 `SearchJobs.cancel()`——两个入口一套语义，不留第二套取消实现。


## 书源管理 tab 的 IA（调度台，2026 打碎重组，用户逐项拍板）

组织原则：**按用户任务组织，不按功能容器**。被推翻的旧 IA 前提（逐项经过用户否决）：642 行 CRUD 表格当主角、状态 chips 兼职总览、导入常驻一个手风琴区（宿主设置页竖栏遗产）、危险区专区 + 大批量手输口令、单纯左右分栏（「没必要」）、「舰队快照」式黑话读数条。现结构：

- **待办收件箱（首屏答案）**：`source-inbox.ts` 纯派生（broken/unverified 两集合，**只看 status 不看 enabled**——停用只是不参与聚合搜索，停用的坏源/未验证照样置顶；2026-09 裁定：停用 ≠ 免验）→ 任务卡 `auto-fit` 网格（`repeat(auto-fit, minmax(260px, 340px))`：宽屏并排、窄屏自动堆叠——横跨整列的长条在 1600px 内容列下中间空、动作钮孤悬列尾，实测用户反馈）。每卡只留**处置动作**（坏源 → 批量重验；未验证 → 一键验证），逐源排查归列表行内「试跑」（待办是任务摘要，不放重复入口——用户裁定）。**2026-09 状态化（用户裁定：待办是「提示」，不是台账）**：① 卡标题**不印计数**，卡面 = 状态名 + 成员名单 + 处置动作——读数的唯一住址移到列表头**状态带**（`source-list-view.ts` 的 `stats`），同一条数不印第二遍，且卡可忽略后读数不能跟着提示一起消失；② 每卡「✕ 忽略」按**成员签名**记账（判据 `signatureOf` / `visibleInboxCards` 在 `source-inbox.ts`，现场在 `source-inbox-ui.ts` 的模块级 store）——成员集一变（新坏源 / 新导入未验证）签名不再命中，提示**自动复现**，这就是"提示"与"永久静音"的分界（被否决：源级持久静音——用户明确不要求"关掉就再也不出来"，而跨重启的静音要落到源实体上：wire 字段 + 服务端读写 + 迁移，范围大一档；真要持久，`source-inbox-ui.ts` 是唯一住址，对照 `prefsStore` 走 localStorage 的先例）；忽略态折成头行「已忽略 N 张 · 重新显示」，能关就能开回来，不留黑洞；每次取数后 `pruneInboxMuted` 一次，只保留仍能遮住当前卡的记录——否则「删光这批再导入同一批 id」会继承一次用户没做过的"已看过"（幽灵记录，与「已删源留在勾选集里」同类）；③ **零待办整块不渲染**（全健康 / 全部被忽略 / 0 源）：原先常驻的「✓ 全部源状态良好」是一块永远正确的区域，而「查过了且没事」这条结论现在由状态带的 `未验证 0 · 坏源 0` 承担；0 源的引导也归列表自己的空态（同一句话不在两处抄）。**加载中 / 加载失败 → 不渲染**不变（不拿未知当良好，宁炸不猜）。任务收尾 reload → 待办集合自动收敛，状态带与卡一起跟上。
- **任务槽**：验证类任务运行卡（`ProbeRunCard`）渲染在待办箱下方（`data-novel-job-slot`）；导入任务运行卡在导入弹层内（kind 分家口径延续）。`job` 自 2026-09 起是**跨子树共享**：轮询单实例住常驻状态层（`NovelStatusOverlay`），本区经 `useJobSurface()` 读镜像、经 `refreshJob()` 催一次重拉——**不再在壳层实例化 hook**（原「只在壳层一次」的动机是不双轮询，如今由唯一驱动实例保证，且比 props 下发更强：切 tab 也不停）。状态条跳转改成**意图信令**：点 import 泳道 → `requestJobOpen(...)` + 路由去 sources，本区 `useJobOpenRequest()` 消费后开弹层并 `takeJobOpen()` 清空（同一意图不重放）；点 probe 泳道 → 先退回列表再滚到任务卡，所以原先「在试跑子视图里点『点此查看』是 no-op」那条开口一并消解。任务收尾按 `job.id` 记账一次 reload。
- **源列表（资产清单）**：列表头 = 标题 + **状态带**（`data-novel-src-stats`：共 N · 已启用 M · 已停用 K · 未验证 X · 坏源 Y，过滤生效时再挂「当前过滤 K」）+ 文本过滤 + **状态下拉**（chips 退役：下拉只做过滤不做总览）+ 分组下拉（选项集按**全库**聚合计数、不随过滤缩水的语义决策不变，带计数）+「编辑/完成」切换 +「＋ 导入书源」。**状态带是读数的唯一住址**（2026-09）：计数由 `source-list-view.ts` 的 `stats` 单点派生，**算全库不看过滤**（它是资产总读数，「当前过滤」另有其位）、**停用源照旧计入**未验证/坏源（停用 ≠ 免验，与待办集合同口径，`source-list-view.test.ts` 有防漂移钉断言两者相等）、**0 也显示**（「坏源 0」本身就是结论，且数字位忽隐忽现会让这条带子一直抖）、**纯读数不可点**（点数字去过滤 = 把 2026 已否决的「带计数状态 chips」请回来；过滤另有三个下拉）。**状态带只在真有数据可报时在场**：加载中（`sources` 仍 null）与 0 源都不出——前者是拿未知冒充结论，后者由空态那句话代劳。**表头常驻，0 源与取数失败只换表体**（2026-09 实机 bug）：这里曾对 0 源整块 early-return 一句「还没有书源——点右上『＋ 导入书源』」，而那颗钮正住在被一起跳过的表头里 = 提示指向一个不存在的控件（`docs-pinned-copy` 守的是文档↔src，守不到"同一棵树里指个不存在的控件"，故这条另有 jsdom 钉）。表头是工具条，导入是与源数无关的顶层动作；表体三态 = 失败 → **不出声**（壳层那条红字更全，同一个失败不抄两遍，也不许把失败伪装成「还没有书源」）/ 取到 0 源 → 空态引导 / 其余（含加载中）→ 表格。浏览态**行内动作常驻**：按状态出 验证/重验 + 试跑（排查主路径；**验证/重验不看 `enabled`**——停用源照样能单点验，与待办箱的批量重验同口径，曾挂过的 `!enabled` 门造成「批量能验、单点不能验」的自相矛盾，2026-09 裁定撤除；**无行内「启用」文字钮**——启停唯一入口 = 最右开关，重复入口曾让操作列内容宽随状态漂移、右缘按钮组不对齐，用户实机反馈）+「⋯」溢出菜单（登录态 / 试跑 trace / 删除——低频动作收纳，点页面任意处收起；`.novel-menu` 浮层，锚点 `.novel-actions`）。编辑态：行复选框 + 选中动作条（启用/停用/验证/删除所选 + 清空选择；表头复选框 = 全选**当前过滤结果**）。**批量动作的收尾口径（2026-09 实机 bug 后定）**：① 成功后重读哪一面按「改了什么」分家——启停改的是源本身 → `onChanged`（重新 GET `sources`），验证起的是后台任务 → **不走视图回调**：提交收进 `jobs.ts` 的领域动作 `startSourceVerification`（2026-09 架构审视：提交成功 → 催任务读面（`refreshJob()`）；失败 → 一处反馈，文案单点「启动验证失败：…」。待办箱、行内「验证/重验」、批量条三个验证入口同一条路；源列表的刷新归任务终态——`reloadedJob` 按 `job.id` 记账一次，提交口不再抢跑），两者不可互换（曾经批量启停也走「重启轮询」出口，于是写完没人重取源列表：行开关、「已启用 M」计数、「停用」过滤全停在点之前的值，只有重开视图才跟上）；② **做完一轮留在编辑态且勾选保留**（这批源启停完还在列表里，勾选就是它们的现场——留着才能连着点「验证所选」或改主意再停用，不必重勾；被否决：清勾选（我 2026-09 的第一版实现，用户实机否掉：「已选状态栏没了，不应该」）与弹回浏览态（更早的实现，借 `setEditMode(false)` 顺手清勾选，连带把编辑态一起退了）。清勾选只在**删除**成功后做：对象已不存在，勾选留着是幽灵 id。「清空选择」钮走 `clearSelection()`（此前它调的是 `setEditMode(false)`，名实不符：连编辑态一起退）。失败半场两个出口都不触发，且勾选留着可就地重试。「验证全部未验证」上移待办箱，列表不再重复该入口。**在途禁用口径（2026 审查补记）**：任务运行中启用/停用/验证三写口禁用——服务端**单任务槽**（`import-job.begin` 运行中抛 `JobRunningError`，import/probe 互斥），在途再提交本就无处可去；删除所选**不禁**——删除不是任务（同步 `sourcesBatchDelete`），且 `runBatchProbe` 对任务中被删的源点名跳过（「源不存在（运行中被删除，已跳过）」），服务端明确支持验证途中删源，模态确认即是二次确认（2026 用户拍板：验证在途**可以删**，前提 = 无并发安全问题。安全三层证据：① Node 单事件循环 + 注册表单写入径 `edit`（recipe 同步执行 = 对外不可分割）；② `runBatchProbe` 逐条重查注册表，探针前被删 → 点名「运行中被删除」跳过；③ `setStatus` 对已删除 id 首行 `if (!s) return false` 优雅 no-op（不抛、不复活幽灵源），同文件并发写由 rename 链串行——最窄交错窗口（探针在途删被探源）钉在 `import-job.test.ts` 对应用例）。过滤管线（状态 → 分组 → 文本交集）、前端分页 `PAGE_SIZE=100`、六列宽单点 `.novel-tr.src` + 容器查询收列（量表格自身宽度不量视口——会话列可拖）、**状态带同套退化**（`.novel-list-head` 挂 `container-type: inline-size`，窄于断点时隐藏 `.slim` = 已停用/未验证/坏源，只留「共 N · 已启用 M」——牺牲顺序按"丢了还能从哪儿要回来"排：这三项下拉里都能再筛出来，且宽列就在同一屏），列表现场模块级 store（`sourceListUi`，下钻返回不丢）——口径全部不变；分组图例/「未分组」伪选项口径同前。
- **删除 = 统一模态二次确认**（与书架删书同款口径）：触发（批量条「删除所选」/ ⋯菜单「删除」）→ ids **点击时快照** → 模态点名后果（带登录态源点名「cookie 失效需重新录入」+「删除不可恢复」+「停用 ≠ 删除，随时可开回」）→ 确认钮危险色实心；Esc / 点遮罩取消零写口；**焦点闭环**（入场焦点在取消、Tab 圈在框内、关闭后焦点还给触发件——**触发件由调用方显式传 `opener`**：批量条钮传 `e.currentTarget`、行内 ⋯ 传该行的 ⋯ 钮 ref。不能读 `document.activeElement`：⋯ 菜单项在模态挂载前就随菜单卸载了，读到的是 body，jsdom 钉死过这条（2026-09 审查））。危险区专区与「>20 条手输『删除』」退役（`batchConfirmKind` 与之同删，双强度确认再无第二入口）。**实现注记（2026 审查）**：与书架删书的三点刻意差异——① 源删除模态**失败即收模态**、错误进全局状态条（书架失败**留在框内**就地重试：单本书删除要即时反馈 vs 批量删除失败通常要回列表重新排查，两种失败姿势不同，各自钉死在测试里）；② 确认钮带**在途防重**（与书架 `delBusy` 同款：双击只发一次 POST，确认钮在途 disabled +「删除中…」）；③ 删除成功 `clearSelection()` + `onChanged()`（已删 id 留在选择集里是幽灵勾选——动作条还喊「已选 N」而表里只剩几行，下一轮批量动作会把死 id 一起提交；失败不清，现场留着重试）。待办箱动作按钮在**任何**任务在途时禁用（不限 probe kind）——同单任务槽契约（审查建议按 kind 收窄，以服务端契约驳回：放行一个必然 409 的请求没有意义）。
- **导入 = 弹层 + 待办闭环**：「＋ 导入书源」→ `ImportModal`（`.novel-modal.wide`，Esc / 遮罩 / 关闭钮退出）内含 `ImportPane`（拖放主入口 + 粘贴小道 + 运行卡 + 完成汇总 +「去验证」；文件为主入口，粘贴是小体量/调试小道，>200KB 提示改用文件）。提交成功经 `onSubmitted` 自动关弹层，任务在服务端跑（进度走全局状态条），完成 → reload → 新导入源以「未验证」卡**流入待办箱**——闭环不留原地；「去验证」回调 = 待办同一条 `verifyIds` 提交口（失败 pushError 显式呈现，历史 bug：此处曾吞 rejection）。
- **试跑下钻**：`ProbePane` 替换整视图（「← 返回源列表」），失败显式呈现的接线口径不变。
- **呈现层不变量**：视图零行内 style；六列 `grid-template-columns` 住 `.novel-tr.src` 单点（改一列只动一处）；状态色归 `--novel-status-*` token；行内开关 `[aria-checked]` / `[data-busy]` 选择器 + `transform: translateX()` 位移（不改布局位置）、停用行 `.novel-tr.off` 内容变灰但**开关不变灰**（停用态最需要能被点回来）；`.novel-actions` 不是 `.novel-td`，故停用行的行内验证/重验钮同样不吃 opacity——「停用 ≠ 免验」在呈现层也不打折；拖放区三态由类给（`.dragging`/`.busy`）且自带 keydown——本层唯一保留 `div[role=button]` 的承载件（要收 drop/drag 事件、内容是块级组合）；汇总条左侧 3px 竖条说成败（`.novel-result`/`.err`）不整块刷红。

## 开关的乐观更新与回滚

- 行：点击即翻转本地 `optimistic`；在途用 `savingN` 计数装饰（写 `data-busy` → `.novel-switch[data-busy="true"]` 给降透明 + `cursor:wait` + title「保存中…」）；失败即刻 `setOptimistic(null)` 回滚，成功与失败都调 `onChanged()` 让服务端结果二次校准。**为什么**：642 行列表的全量 reload 有一拍延迟，没有乐观反馈用户会以为「点不动」。
- 反馈策略（`toggle-feedback.ts`）：**秒级乐观操作不进瞬态泳道**——`inFlight()` 故意留空，成功也静默（开关翻转本身即反馈）；只有失败进 error 泳道并挂行锚点。**为什么**：状态条原先是流内元素，挂上就把下面整块顶下去 35px、settle 弹回，单源启停往返只 13~20ms ⇒ 用户看到「一帧下沉回弹」= 闪烁（真机逐帧量过）。配套第二半修复：状态条改成 absolute 浮层 + 宿主 relative 锚点，泳道来去不再参与布局。
- 行锚点（`rowAnchorOf(id)` = `[data-novel-source-row="<id>"]`）是错误条目「定位 →」跳转与行内 `.row-err` 红边共用的同一个选择器：行内从内容层降为装饰层，文案全部归条。
- 行内 `.row-err` 的显隐走 `useTransientFlag`（原始值快照）——642 行逐条订阅，快照翻转才唤醒对应行，全量重渲染不可接受。

## 瞬态层

一个模块级有序队列（`transient.ts`），三种生命周期：`pending`（settle 即移除、多条聚合计数）、`ok`（少而淡，TTL 2.5s 自动退场；只有显式保存类进条）、`error`（sticky，手动 dismiss，携带 anchor）。**呈现端自 2026-09 起住在视图环之外**：`GlobalStatusBar` 由 `NovelStatusOverlay` 渲染，注册在宿主 `shell.overlay`（root 作用域）——于是书架 / 搜索 / 阅读器 / 甚至切走小说 tab 之后都看得见错误与任务，不再只有坐在书源管理 tab 时才有效。泳道形状（栏数 / 弱底 / 光标）住样式类 `.novel-lane.cols-1|cols-err|cols-job`——此前由 `statusLane()` 工厂每次渲染现造五个 style 对象，样式表里搜不到这些规则。容器仍钉 `class="novel-status-bar"` 且**零行内 style**（transient.test 断言）。**范围**：这是通用层；书架/搜索的散落错误（`loadError`/`delError`/`importError`/`searchError`）服务于场景内重试，尚未接入。

## API 客户端与错误呈现

- `api.ts` 是信封解析单点：`{ok:true,value}` → value；`{ok:false,error}` → 抛 `ApiClientError`（带 `code` / `status` / 可选 `segment`）；非 JSON 或网络层 → `ApiClientError('NetworkError', …)`。`apiUpload` 走 octet-stream（本地 TXT），响应仍走信封。
- query 构造不在此处：参数名与序列化归 `shared/wire.ts` 的 `queries` / `encodeQuery`（此前四处各拼一份，改名无处编译报错）。
- 段级定位呈现：`ErrorBanner` 在有 `segment` 时渲染「`facet`#段`segmentIndex`」徽标 + `code: message` 红字 + 「重试」。规则求值失败因此能指到出错的段，而不是只说「解析失败」。
- 进度不做整体 reject：搜索的单源失败由服务端写成该组的 `error`（浏览器半不再合成「批次错误组」——「批次」这个概念随浏览器侧分批循环一起退了），状态条/运行卡用同一 `jobPct` 与同一 `ProgressBar` 元素。

## 三束依赖注入（seam）

`ClientCoreDeps`（`apiGet/apiSend/apiUpload/apiEventStream/pushError/pushOk`）→ `SettingsDeps`（+ 任务面）→ `ReaderDeps`（+ 导出流）。ShelfView / SearchView 吃核心束，ReaderView 吃阅读束，SettingsSection 吃设置束并向下透传；生产缺省 `prod*Deps` 让接线零变化。`pushOk` 原住设置束、2026-09 下移到核心束：书架的异步导入在用户切走后也要有地方说一声（见下「本地 TXT 导入」），成功反馈不是设置区特权。

**为什么**：视图此前硬 import 真实现（「自造依赖」），历史上真正的 bug——乐观态不回滚、陈旧回调、误导性空态、探针失败假死——全住在接线层且无法被测试驱动。现在 interface 即测试面，`tests/client/views-wiring.test.tsx` 等用假 adapter 驱动**真实组件**。

## 跨半契约的消费面

- 客户端只依赖 `src/shared/wire.ts` 的**路由名与值形状**；`views/types.ts` 只是再导出桶，加字段/改形状去 wire 改，别在客户端加第二份。
- 常量也归 wire：`LOCAL_SOURCE_ID`（本地书保留源 id），客户端不再手抄 `'__local__'`。
- `SHELF_META` + `pickShelfMeta` 是书目 7 字段「名称 × 类型判别 × 归一化」的唯一主人：`shelfBody.addBook` 与 `shelfBody.patch` 都从 pick 派生 ⇒ 加一个书目字段只改这张表。
- 写侧三形态（全在 `shelfBody`）：带 `title` = **加书**；带 `progress` = **更新进度**（不在架 400）；带 `patch` = 对在架书打补丁（缺席键保值 ⇒ ReaderView 回写 `totalChapters` 只发一个字段）。`progress` 服务端校验 `chapterIndex` 非负整数、`offsetRatio ∈ [0,1]`。
- 「加书」与「进阅读器」是两段：点行直接阅读时先 PUT 加书（失败 `catch` 掉）再 `navigate`，因为进度落盘依赖书架条目。
- bookKey 是 URL 或 `local:<uuid>`，进路径前必须 `encodeURIComponent`（归 `paramRoutes.shelfKey`）。

## 热更新与装载

- 产物：`lib/client.js` 是 CJS 单文件闭包工厂（`window.__ModuleLoader__.load({ id:'@xrn1997/dsh-novel', factory })`），平台模块表内的 specifier（react / react-dom / `@deepseek-ai/dsh-client-*`）留给注入的 `require`，其余全 inline。构建期纯度门拦 Node 内建与平台表外的 `@deepseek-ai/*` **值** import ⇒ `shared/wire.ts` 必须零运行时依赖（它会被整个 inline 进 client bundle）。
- 热更新链路：`dsh-client-hmr` 每 500ms `stat` 一遍各插件 client bundle，按 **mtime + size** 判变 → `clientModuleHost.rebuilt(id)` → `/plugins/events` SSE 推 `rebuilt` 帧 → 浏览器半的 HMR 接收器重载。
- **生效条件**：`lib/client.js` 这个文件本身要变（即需 `pnpm dev` / `tsdown --watch` 或手动 `pnpm build`）；Node 半（其余 `src/`）不在热重载链路内，改完要重启 `dsh web`。样式住 bundle 内的 `<style>`，随 bundle 整体替换。

## 测试钉子（`tests/client/` 与两条仓级守卫）

| 测试 | 钉死什么 |
|---|---|
| `reader-session.test.ts` | 时序全集：无存档/有存档恢复+双帧定位、**进书恢复位预约（目录发布即来的预取不许抢在途槽）**、`totalChapters` 幂等回写、目录失败进 error、单在途槽去重、切章强制存 vs 同章防抖存、**切章强制存作废同章防抖窗里的旧值**、**目录直达选中即落盘（章在途/视口没动也要落）**、**`dispose` flush 防抖窗口内的进度 vs 无待发值不造幽灵写口**、哨兵预取与读尽不动、目录直达（未载先拉 / 未渲染不清 `pendingJump` / 在途挡下后补拉）、成功清 error 与两种 retry |
| `views-wiring.test.tsx` | ProbePane 失败不再假死；书架加载失败不伪装空架、删除失败保留卡片、**来源 chip：源名渲染 / join 不到落「来源已删除」/ 本地书不出 chip**、**本地 TXT 导入落地时用户已切走 → 不越权 `navigate`，且成功/失败两个半场各自上报**（在场走场景内红条、切走走 `pushOk` / `pushError`；另有「仍在场仍照常进阅读器」的正向钉防过度收敛）；搜索提交走 `POST search/job` 且此后只有快照读取（无 `search?keyword=` 批请求）、**挂载即恢复**（服务端有结果 → 直接渲染且零提交）、陈旧回包按 jobId 身份丢弃、`total=0` 与「没命中」两分支空态、读面失败显式中断且不再排下一次、提交失败不清已在手上的结果、**推送可用时读数全从帧里来（本轮零次快照轮询）且终态帧自己关流**（假 `apiEventStream` 缺省「立刻结束零帧」= 没有推送可用，故其余用例天然是轮询路径）；**卸载后零请求 + 重挂载从 `since=0` 重读且不再提交**（旧行为实测：卸载后仍发 2 批、重挂载整轮重打）、**route 带关键词的重挂载（退出小说界面再进的真机路径）同样零提交、进度从服务端快照恢复**（route.keyword 提交即摘除——见搜索节；实测 bug：routeStore 跨卸载存活 → 重挂载无条件 submit → 单槽替换掉在跑的同一轮、整轮从头重搜）、**StrictMode 双挂载下两次恢复读只落地一次**（分组不重复累加）、**停止搜索三钉**（没这一轮不给钮 / 提交后立刻有钮 → 点它只发 `search/job-cancel` / 终态`cancelled` 帧后命中全留、「已停止 · 」前缀在场、无「搜索中断」红条、死钮消失且「搜索」钮可再点；**收口行只报实搜完的组数且 `progressbar` 的 `aria-valuenow` 停在真实比例**——真机实测 431 家计划 / 29 家实搜曾报「搜过 431 家」且进度满格）；**调度台壳接线**（**批量启停后源列表按服务端重取数**——假服务端回读 `enabled`，行开关即刻跟上（2026-09 实机 bug：接错出口 → 界面停在旧值）、待办任务卡 + 一键验证/批量重验走注入 deps（提交成功即催任务读面、不就地重取源列表）且**卡面不印计数**；**任务终态源列表刷新按 `job.id` 只记账一次**（同终态轮询多拍不重复 reload，新一轮终态再刷一次）、**卡可「✕ 忽略」**（该卡收起而读数仍在工作、只关点的那张、「已忽略 N 张 · 重新显示」开回来）、**状态带五读数**（全库口径、非 0 的坏源带 err 色类）、**零待办整块待办区不渲染**（全健康时读数由状态带的 0 给）、加载/取数失败待办不渲染、待办区在表格之前、导入弹层默认关 + Esc 收起、提交即关弹层、完成态「去验证」闭环、导入弹层焦点不被壳层重渲染劫持（轮询 tick 重渲染：焦点原地不动、Esc 仍收起））；ReaderView 取数/导出走注入 deps、导出错误带 code；**导出三钉：点⤓只弹「导出范围」面板不开流、面板确认才 `streamExport` 且全本落盘 `书名.txt`、范围倒置禁确认且校验期零请求**；**NovelView tab 切换三分支**（书城=占位空态、书源管理=小说视图内渲染、回书架=首页回归；routeStore 测后复位） |
| `search-job-round-identity.test.tsx` | **轮次身份与游标不可分开**（观察 module seam：真实 `SearchJobs` 持有者 + 假传输 adapter）：另一观察者换轮（SSE 帧带新轮切片）→ 不混轮不缺组、`since=0` 恢复新轮完整基线、旧连接 abort 且新轮重开一条观察；旧 since 读新任务（轮询路径）→ 收敛新轮完整基线、B-first 不丢、恢复走显式 `since=0` 重读；基线与连接之间换轮 → 首帧即触发换轮恢复，同样收敛完整基线 |
| `settings-toggle.test.tsx` | 开关点即翻转、失败即刻回滚 + error 挂行锚点、**在途不进泳道**（零条目、无 progressbar）、**乐观值随服务端值让位**（reload 落地即以服务端为准——粘滞乐观态回归钉）；`onImport` props 缝（required；漏改只有 tsc 抓得住）；「未分组」伪选项出现/计数 0 不渲染；**行内验证入口与启停正交**（停用+未验证出「验证」、停用+坏源出「重验」、点击只验这一源经 `startSourceVerification` 提交（`startBatchProbeJob([id])` 是它的 wire 口），**提交成功不就地重取源列表**（验证 → 催任务读面），失败文案与其余入口同为「启动验证失败：…」（不再有第二份抄本），已验证的停用源两个钮都不出） |
| `toggle-feedback.test.ts` | 反馈策略：`inFlight` 零条目、成功静默、失败带锚点、连点不累积；`rowAnchorOf` 与行 data 属性同源 |
| `transient.test.ts` | pending 结算幂等/转错误、ok TTL 退场、error sticky、聚合计数；状态条四条渲染分支（现由 `NovelStatusOverlay` 呈现）+ 空闲零占用 + 浮层类名（锚是 `.novel-shell-status`）；**反向钉：`SettingsSection` 不再自带状态条** |
| `status-overlay.test.tsx` | **常驻状态层**（视图环之外）：任务在跑 → 泳道与 `100/642` 读数在场且与任何 tab 无关、空闲整块不渲染、点 import 泳道 = 路由去 sources + 记 `import` 意图、点 probe 泳道 = 记 `probe`（`takeJobOpen()` 取走即清空）；**自带样式层与 token 锚点**（`[data-novel-shell-status]` 有 `data-novel-scope` 且子树含 `[data-novel-style]`——真机：视图卸载后裸文字）；**条身锚右下非通栏**（规则含 `bottom:`/`right:`/`max-width`，出现 `top:` 或 `left:` 即红） |
| `panel-registration.test.tsx` | **注册面：小说 = 全局面板**（seam = `apply(ctx)` + 假 slots 服务）：注入 `sidebar.panellist` + `main` 两座位且 `conversation.view` 撤除、id/key 同为「novel」、panellist 占用者吃 owner props `{size, active}` 出 `aria-hidden` svg（无障碍名归宿主行的 label）、main 占用者真的渲染 NovelView（`.novel-root` / 样式层 / tab 导航）、`shell.overlay` 常驻层注册不变、每个注册都在 `ctx.effect` 内；**面板图标资产来源钉**：pathData 原样来自 android-ebook `ic_launcher_foreground.xml`（viewBox `0 0 1025 1025` + `fill=currentColor`，防随手换回通用图标） |
| `reader-load.test.ts` | 预取窗口跟着视口（`nextChapterIndex(chapters, from)` 取视口章之后第一个未载章——旧口径「最大已载章 +1」在倒退跳章后会取到远端）、单在途、哨兵严格小于 `(1+2) 屏`、滚过头仍加载 |
| `scrollport.test.ts` | 「谁在滚」判据（可滚 + 内容超出）、向上落到宿主 scrollport、无容器 → null |
| `progress.ts` / `logic.test.ts` | `locateChapter`/`anchorTop` **互逆且尾章同样往返**（跨度 = 章高；旧版本尾章取回章顶）、锚点边界、`anchorTop` 越界回 0 与结果夹在可滚动范围内、debounce、store 语义、api 信封与 `NetworkError`、`streamExport` 单调字节进度；`batchConfirmKind`/手输口令确认随危险区退役移除 |
| `paper-ink.test.ts` | 纸张色 → 字色的阈值行为（含 3 位 hex、非 hex 回退、L=0.35 分水岭） |
| `reader-ctrl-z.test.ts` | 工具栏 stacking context 压过遮罩，且组件真的用这套常量 |
| `source-list-view.test.ts` | 分组选项集不随过滤缩水（全库聚合）、过滤管线三维交集、disabled 维正交、分页、全选作用域、`authCountOf`（删除模态点名口径）、**`stats` 状态带五读数**（全库口径、停用源照旧计入未验证/坏源、**与待办集合相等的防漂移钉**）；chip 计数/快捷批量 id 集随 chips 与危险区退役移除（id 集归 `source-inbox.test.ts`） |
| `source-list-batch.test.tsx` | 选中动作条三写口的载荷与半场（**成功各归对出口**：启停/删除 → `onChanged` 重取源列表；验证 → `jobs.ts` 领域动作催任务读面——经 `useJobPolling` 取数计数观测，不走 props；失败两个出口都不触发且勾选留着，验证失败文案统一「启动验证失败：…」）、在途禁重复提交、**启停/删除成功进反馈条且计数取服务端回包**（`updated`/`removed`，不是"我勾了几个"）、**做完留在编辑态且勾选保留**（删除才清勾选）；**删除统一模态二次确认**：数量/书名点名、登录态 cookie 失效提示、Esc/遮罩零写口、焦点闭环（入场取消 → 关闭还给触发件）、失败半场收模态不触发 onChanged、⋯菜单单源删除与点外收起；**确认在途防重**（双击「确认删除」只发一次 POST）、ids **快照语义动态钉**（模态开着改选中集，提交仍是开模时 ids）、重渲染不扰焦点（轮询闭包不劫焦点、Esc 关闭还焦给触发件）、**⋯ 菜单删除路焦点还给该行 ⋯ 钮**（触发项先卸载，读 activeElement 即落 body） |
| `source-inbox.test.ts` | 待办派生：broken/unverified 分集合、**只看 status 不看 enabled**（停用的坏源仍进待办、停用的未验证仍一键可验）、空库/全健康双空、`inboxIds` 快照取数口；**卡与忽略**：`inboxCards`（成员为空不出卡）、`signatureOf` 与源序无关、`visibleInboxCards` 命中签名即隐藏、**成员集一变自动复现**、`pruneInboxMuted` 只留仍能遮住当前卡的记录（删光再导入同批 id 不继承"已看过"；现场 store 在 `source-inbox-ui.ts`） |
| `smoke.test.tsx` | SSR 可渲染五分支（shelf/city/sources/reader/search）；导入弹层口径（ImportPane 子面自带拖放+粘贴、壳层默认不挂弹层、触发钮在场）；源列表状态/分组下拉 + 浏览态无复选框 + 危险区/chips/手风琴退役不出现 + 待办箱数据未到不渲染；列表级操作在表格之前；样式层随视图注入**且全树恰一条**（sources 分支宿主注入后子组件让位；`SettingsSection` 单飞仍自带一条）、宿主 composer/把手收口选择器、未载章不进 DOM |
| `ui-system.test.tsx` | **呈现层不变量守卫**：本层 `var(--novel-*)` 引用自足（视图与样式层都扫，先剥注释）、`--novel-z-*` 与 `CTRL_Z` 同名同值且全序成立、视图零裸 `zIndex` 数字、正文栏宽值槽 `--novel-measure` 为 em 且不留 calc(50%、**纸色不涂正文列 + `.novel-rdr` 一屏 min-height**、**内容列上限书架 ≥1600 / 搜索 ≥1100 且搜索窄于书架**、抽屉槽 sticky + 宽 0 + 本体 absolute + `100vh` 上限、**抽屉条目 `flex: none`**（可滚动 flex 列里条目会被压扁，见控制器层 ③）、顶栏 `flex-wrap`/标题 `nowrap`/搜索框独行（`.novel-shelf-search` 与 `.novel-shelf-filter` 各 `flex: 1 1 100%`）且基准弹性宽（form `flex: 0 1 Npx`、无固定 width）/书架顶栏零 `margin-left: auto`（`.novel-shelf-sort`/`.novel-shelf-filter` 出现即红）/顶部 tab 导航 `.novel-tabs` 在场且激活态可见（`.novel-tabs button.on`）/焦点环列表含 `.novel-tabs button`/**横向溢出守卫**（scoped `box-sizing: border-box` 圈住 `.novel-root` 与 `[data-novel-scope]` 两棵树——content-box 下 `.novel-wrap` 外廓恒超容器宽，窄列底部出横滚条；探针实测 vp=970 修复前 main sw=1002 → 修复后 970=cw）/**源列表操作列定宽**（`.novel-tr.src` 第5轨 148px 右锚——auto 轨让右缘按钮组随状态漂移）、**状态带退化在位**（`.novel-list-head` 是容器查询锚 + `@container` 窄列隐 `.slim`，但状态带本体被隐藏/绝对定位即红——读数唯一住址不能整条消失；断点 1000px 由渲染台实测，见调度台 IA 节）、六类交互件各有 `:focus-visible`、`@media (hover: none)` 让 ✕ 常驻、`prefers-reduced-motion` 在位、进度段 `transform: scaleX` 且 bits 不再写行内 width、源列表列宽单点（视图不含列字面量）、卡片与命中行是真 `<button>`（`[role="button"]`/`button button` 出现即红）、抽屉恰有一条 `aria-current`、**用例后 `afterEach(cleanup)`**（vitest 未开 globals ⇒ RTL 的自动清理不注册；漏了 `screen.*` 会命中上一个用例的元素——「命中行是可聚焦按钮」那条长期读的是书架卡片＝假绿） |
| `theme-tokens.test.ts` | 宿主词表守卫（`--dsw-*` 必须是宿主真名，含「假 token 不存在」的自证）+ hex 字面量守卫（视图内联品牌 hex 即红，白名单只放 token 定义处与正文层色值） |
| `run-card.test.tsx` | 运行卡外壳：零行内 style（brand 派生色改由样式层 `.novel-group.novel-run-card` 持 `--novel-brand-soft/-line`）、counts 与条件行、progressbar 三件套；RunCard 文案钉「可以关掉页面，任务在服务端继续」（设置页旧文案随调度台退役） |
| `jobs-poll.test.tsx` | **驱动 `useJobPolling` 的时序**（与住在哪个组件无关）：挂载即拉、`refreshJob()` 重拉、取数失败保留旧值但置 `stale`、1s 节拍与卸载停轮询（假时钟）；结果写 `jobSurface` 镜像，`resetJobSurface()` 是跨用例复位口 |
| `jobs-verify.test.tsx` | **`startSourceVerification` 领域动作**（编排单点）：成功 → 催任务读面恰一次 + ids 按点击时快照（调用方数组事后变异不进载荷）；失败 → 反馈恰一次且文案单点「启动验证失败：…」、不催读面、不向上抛；refresh 缺省 = 生产 `refreshJob` → 常驻轮询驱动立刻重拉（不等 1s 拍） |
| `docs-pinned-copy.test.ts` | 文档钉子文案 ↔ src/ 双侧一致（文档教人认的界面文案必须真实存在，反向钉子必须在文档有引用；2026 审查建议落地，清单手工维护） |
| `import-pane.test.tsx` / `importer.test.ts` | 文件/粘贴两条提交路径与失败上报、**`onSubmitted` 弹层口径**（成功即回调关弹层、失败不回调——不许关窗装成功）、预检（对象方言不误杀、一好一坏不连坐）、cookie 串解析、过滤/分组纯函数、列表 store 语义 |
| `export-run.test.ts` | 导出三态：进度投影、错误类目投影（不伪造 code）、取消/卸载 abort 静默、在途重入忽略；范围：range 进状态、流收 from/to、文件名后缀（部分加 / 全覆盖不加）、`parseRange` 六种拒绝与合法 |
| `shelf-delete.test.ts` | 删除文案两形态：单本（本地书点名 dataDir 副本连删 + 原始文件不受影响）；批量（点名本数、含本地书时报「其中 N 本为本地书」、清一色本地书不冒充在线）（手风琴折叠态测试随模块退役一并删除） |
| `shelf-batch.test.tsx` | 书架多选批量删除接线：进态/退出零请求、点卡片=勾选（不进阅读器、零请求、`aria-pressed` 与 aria-label 换形）、**「全选」只认当前筛选可见**（筛选簇在多选态让位）、单本 ✕ 与导入引导卡退场；「删除所选」→ 模态点名本数 → **恰一次** `POST shelf/batch-delete` 且 keys 是点击时快照 → 成功清勾选并退态、未点名的留着；**批量失败留框内可就地重试**（卡片与勾选都保留）；Esc 取消零请求且现场不清；单本 ✕ 仍走 `DELETE shelf/:key`（两条入口不串） |
| `shelf-view-model.test.ts` | 书架 view-model 纯函数（零 React）：`filterShelfBooks` 筛选口径（`reading` = 有实质进度、`unread` = 补集、`local` = `LOCAL_SOURCE_ID` 正交维；不过滤时不共享底层数组）、`shelfCardMeta` 卡片元信息与百分比**唯一算式**（0 基章数展示 1 基、未读 `pct: null` 不出条、缺 `totalChapters` 退章节文字、越界 clamp 到 100）、`coverTintClass` 首字色块四档派生（空标题回 t1、可复现、四档真被用起来）、`shelfSourceTag` 来源 chip 口径（源名直出、join 不到 → 「来源已删除」、本地书 → null）、`sourceTintClass` 色点四档派生（同源恒同档、四档真被用起来） |

## 已知开口

1. **登录脚本（`runLogin`）在 UI 上不可达**。服务端已实现两形态：`POST sources/:id/auth { runLogin:true }` 会返回 `{ mode:'manual', loginUrl }`（URL 形态，不注入 WebView）或沙箱执行 JS 形态的 `loginUrl`（空产出 → 422 `LoginFailed`，不写登录态）；但 `views/SettingsSourceList.tsx` 的 `SourceAuthPane` 里那个「去登录」按钮（`window.open(source.baseUrl, '_blank')`）既没走 `runLogin` 取真正的 `loginUrl`，也没有触发 JS 形态。`README.md` 已宣称「cookie 录入与 `loginUrl` 脚本执行」。
2. **`hit.url` 是空串时会用空 bookKey 加书**：`views/SearchView.tsx` 里 `HitRow` 的守卫 `hit.url === undefined || hit.url === null` 只挡 `undefined` / `null`（这两者渲染成不可点行），**空串 `''` 会走进可点分支**——`HitRow.add()` 与 `HitRow.read()` 都用 `hit.url ?? ''` 当 bookKey，于是发出 `PUT /novel-api/shelf/`（空路径段）并带着空 bookKey 跳阅读路由。修法二选一：守卫改成 falsy 判断，或在 wire 层保证 `url` 用 `null` 而不是空串。
3. **hex 守卫可绕过**：`tests/client/theme-tokens.test.ts` 的 `scanHex` 里那条 `text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)` 只认 hex 写法，`rgba(...)` / `color-mix(...)` / 颜色名不会被抓。当前实测（本轮收敛后）：`src/client` 里 `color-mix` 15 处、`rgba()` 15 处，**全部在 `styles.tsx`**（视图与逻辑层为零——此前设置区视图里还有 4 处内联 `color-mix`，随行内样式收敛进 `.novel-btn.danger` / `--novel-err-line` 而消失）。这些内联值引用的是 `--novel-*` token（换 brand 会跟随），故与历史 bug 不同，属口径宽松；真要收紧得把 `rgb()/color-mix()` 也纳入扫描（会牵动 token 层自身，需要一次专门拍板）。
4. **百分比算式已收敛一处、剩两处**：书架卡片的百分比与元信息已收敛进 `shelf-view-model.shelfCardMeta`（唯一算式，含 clamp 与「未读不出条」口径，`shelf-view-model.test.ts` 钉死）；仍各算一份的是 `views/bits.tsx` 的 `jobPct`（不 clamp，total=0 防除零）与 `views/SearchView.tsx` 内联的 `Math.min(100, Math.round((progress.done / progress.total) * 100))`（搜索进度按源数，与 jobPct 的任务口径不同源，是否合并待拍板）。
5. **`pushPending` 当前无生产消费者**：`transient.ts` 的 `pushPending` 保留为通用层能力（`toggle-feedback.ts` 的 `toggleFeedback.inFlight()` 故意留空），「正在保存 N 项…」聚合泳道无生产者；直测在 `transient.test.ts`。
6. **两条依赖宿主内核版本的 CSS 特性待真机确认（低危）**：① `.novel-table { container-type: inline-size }` + `@container` 收「地址」列；② `@media (hover: none)` 让删除 ✕ 在无 hover 能力的设备上常驻。①的推演依据是：本仓已依赖 `:has()`（收 composer 与抽屉互斥等），`:has` 与 `@container` 同为 Chromium 105 落地，宿主既然跑得动前者就跑得动后者——但这是**推演不是实测**（本地渲染台跑在另一个浏览器上，量的是规则本身成立）。失败后果都可控：①退化成六列挤一行（ellipsis 裁字，不溢出），②退化成触屏上 ✕ 不明显（本就在改前的状态）。真机各扫一眼即可销账。
7. **早期设计与计划文档里的这几条已被代码推翻**（那些文档已出库、不再保留副本；照抄即回归）：
   - 旧文档记视图环注册走 `ctx.uiConversation.views.register({ target:'novel' })`；代码是 `slots.inject('conversation.view')` + `slots.register({ id:'novel' })`（`src/client/index.tsx` 的 `apply`）。
   - 旧文档记 `--dsw-alias-border-l` 是宿主真 token 并在测试里断言它在位；该 token **不存在**（宿主别名层是 `l1..l4`），代码已改用 `--dsw-alias-border-l2/l4/l1`。守卫在 `tests/client/theme-tokens.test.ts`：一条用例断言 client 源码引用的每个 `--dsw-*` 都在宿主词表内，另一条反向断言假 token 不在词表内（`HOST_TOKENS.has('--dsw-alias-border-l') === false`；`border-l` / `bg-layer-4` 是两个踩过的坑）。
   - 旧文档记正文懒加载用 `IntersectionObserver` 触发；代码用「未载边界哨兵相对视口 top + 2 屏余量」的纯函数判据（`scrollport.ts` 测过：阅读器自己的容器 `clientHeight == scrollHeight`，靠容器 scrollTop/scrollHeight 的两个方向都失效）。
   - 旧文档（信息架构 v2 之前的视图树）记有「书籍详情」视图与 `detail` 路由、以及 `sources` 全局路由深链；代码已删除 `DetailView`，其后 `Route` 一度只剩 `shelf | reader | search` 三成员、源管理迁入宿主设置页。**2026 IA 再演进（用户拍板）**：`Route` 五成员（`shelf | city | sources | reader | search`），书源管理以**视图内 tab** 形态回归主界面（仍是视图内路由、无 URL 深链），`settings.section` 注册撤除——单一归属。
   - 旧文档记搜索失败源组「组头显示源状态徽标」；**该差异已在简约版呈现中消除**：有命中的组头现为 `bits.StatusBadge`（verified→「可用」中文映射，`renderGroups`），失败折叠区口径不变——只点名 `code` 与 `message`（`views/SearchView.tsx` 的 `renderGroups` 里失败源的 `<details>` 块）。
8. **聚合搜索后台化 + 全局面板迁移均已落地；还剩一处「离开即作废」**：
   **已修（本轮）**：`views/SearchView.tsx` 曾把在途循环与结果都握在组件 `useState` + `useRef` 里，`views/NovelView.tsx` 切 tab 即换分支（组件卸载）。jsdom 实测（100 源 → 5 批 / 并发 3）：**卸载时已发 3 批、卸载后仍发出 2 批**，整轮跑完而结果无人接收；重挂载后同一关键词整轮重打（`plan` 1→2、批次 2→4），而服务端只缓存目录 / 正文、**不缓存搜索**——所以「离开即完蛋」是双份代价：结果丢 + 目标站点被重复打一轮。现在批循环与整轮结果都在 Node 半（`services/search-job.ts` + 门面 `startSearchJob`），生命周期登记给宿主 `ctx.jobs`（kind `novel-search`），读面是带游标的显式快照，推送走同一份快照的 SSE 版（上面「搜索」节的两通道口径）；浏览器半只剩「提交 + 看」，切走停表、切回重读（钉子见测试钉子节的 `views-wiring.test.tsx`）。顺带退掉了浏览器侧的分批循环（它的存在只是为了拿增量与进度条，属重复实现的一侧）。
   **仍是开口（按重要性）**：
   ① `views/SettingsSection.tsx` 的 `ProbePane` 单源试跑结果随卸载丢，回来要重跑——它是「一次请求一个结果」的短任务，量级远小于搜索，是否也搬进任务面待拍板。
   ② **真机两件事已销账（2026-09-19，重启宿主 + 跑真任务）**：`attachController('dsh-novel')` 被接受——`novel-search`（431 家参搜）与 `novel-probe`（20 家批量验证）都在宿主里真跑起来了，准入闸没拒；常驻层确实注册进 `shell.overlay`（宿主 `.pI_x6G_overlayLayer`：`inset: 0` + `z-index: 20` + 默认 click-through），并当场量出两条只有实盘会暴露的缺陷（样式层与 token 锚点不自带、条身沿用顶部通栏压住宿主会话标题行），修法与读数见「装载面」节。两条副产品一并记账：无主任务**其实显示在宿主会话头部的任务面板里**（推翻 `docs/reference/dsh-plugin-api.md` 9c 那条推断，已就地改正——于是常驻层的价值要重述为「数字进度 + 跳回现场」而不是「让任务被看见」），以及「停止」后的收口数字谎报（已修）。
   **为什么这是结构问题而不是接线疏漏**：宿主的中央呈现座位一次只渲染一个面板——`conversation.view` 时代是壳层 `renderSlot('conversation.view', …, { only: active.id })`；2026-09 迁移后小说住 `main` keyed 槽（侧栏选中同 id 的 `sidebar.panellist` 行才渲染，切面板即卸载），座位内的任何东西都活不过切走。而官方 `slots` 扩展规则要求「业务与传输状态留在所属 Cordis service 或 Client model 中」。规范解与三条进度投递通道的对照见 `docs/reference/dsh-plugin-api.md` §9/§10。
   **实现注记**：服务端聚合搜索只有一份——`services/reading.ts` 的 `searchProgressive`（内部按 `searchParallel` 跑批），`search()` 是它的薄壳，HTTP 面、AI 工具 `dshnovel_search` 与后台任务三个消费方共用同一循环。
9. **阅读器是「单章窗口 + 只往前接」，不提供往回翻页**：未载章不进 DOM，预取只补视口章之后的第一章，已载集裁到视口所在连续区间（见「阅读会话」节的预取与窗口口径）。于是恢复/跳章之后，视图里只有目标那一章——往上滚没有上一章，只能走目录。这是「渲染只出已载章 ⇒ 滚动高度才等于已读内容高」这条口径的直接代价（有它，预取判据与进度锚点才成立），刻意保留；要往回翻得引入占位高度或双向补载，属产品口径变更，需要单独拍板。
