# 界面规格（现行）

结构与层级以本文为准；像素值、断点、文案键的唯一定义在 `src/client/` 与 `tests/client/`，本文不抄读数。历史取舍在 git 与 `docs/adr/`，这里只写现在长什么样。架构形状与主人清单见 `docs/architecture.md`。

## 1. 入口与面板

- 槽位注册与三处入口见 `docs/architecture.md` §3；本节只说面板内的 tab 与跨 tab 现场。运行参数走插件详情页的配置卡（本文 §5）。
- 三个 tab 住 `src/client/views/NovelView.tsx` 的 `TABS`：**书架** / **书城** / **书源管理**，切换走 `navigate`。`src/client/store.ts` 的 `ViewRoute` 另有 `search` 与 `reader` 两态：它们是 tab 之下的沉浸流，顶部 tab 条不随行，返回即回原 tab。
- 跨 tab 现场是模块级的，切 tab 不丢：书架读面与落架账（`panelShelf`）、书源列表态（`sourceListUi`）、书城选中态（`cityStore`）、任务弹层入口（`requestJobOpen`）各自在场；它们的归属住在 `docs/architecture.md` §4 的「浏览器视图内路由与跨卸载现场」行，本节只说界面行为。状态层的任务入口可以切到书源 tab 并直接打开导入弹层或滚到任务卡。
- 面板只做呈现与投影：书架真相、搜索轮次、任务态都在 Node 半；客户端不持任何真相（见 `docs/architecture.md` §3）。

## 2. 基础状态

| 状态 | 表达 | 规则 |
| --- | --- | --- |
| 加载中 | 骨架占位 | 书架在 `panelShelf.books === null` 时给骨架；书城在途补骨架卡。骨架不等于空态 |
| 空 | `EmptyState` + 引导动作 | 书架空给导入引导；书城空只认「干净跑完」（`city-view-model.ts` 的 `bookListEmpty`） |
| 失败 | `ErrorBanner` 或场景内联错误 | **不折成空**：书架读失败落「不可用」而不是空架（`shelf.unavailable` + 内联失败行）；源清单读失败不落空表；目录未到不摆空目录 |
| 在途 | 按钮禁用 / 进行读条 | 书城换源立即提交；任务卡与体检各自报进度 |
| 不可用 | 入口不渲染 | 没有可渲染的东西时入口直接消失，不造禁用态冒充（`returnDepth` / `hasImportNotes` / `hasMore` 为假即不渲染） |
| 部分失败 | 失败源折叠点名 | 搜索里逐源失败不拖垮整页：失败源进页尾折叠区，点名 code / message / statusDetail |

错误有两条泳道：场景内联（`novel-err` 类，留在出事的块里，可重试）与全局通知（`src/client/transient.ts` 的 `pushError` / `pushOk`，sticky 的错误可带锚点做「定位」，成功提示按 TTL 熄灭）。两泳道都由 `src/client/views/bits.tsx` 的共用件承载。

## 3. 各视图与清单

### 3.1 书架（`src/client/views/ShelfView.tsx`）

- 头：标题、搜索框（关键字只作聚合搜索的跳转输入）、筛选与多选入口。
- 筛选住 `shelf-view-model.ts` 的 `SHELF_FILTERS`：全部 / 在读 / 未读 / 本地。
- 多选是组件态，切 tab 清零；筛选让位给批量条；「全选」只覆盖当前筛选可见；单本 ✕ 与「删除所选」都开确认模态。
- 未读 / 在读的判定依据进度读数，不在这里复述。

### 3.2 书城（`src/client/views/CityView.tsx`）

- 左栏：源列表（可搜）；选中源就地展开它自己声明的分类（可搜）。选源选类都立即提交，不攒「开始浏览」。
- 进入判据住 `city-entry.ts` 的 `decideCityEntry` / `resolveCitySelection`：自动那条路做源/分类回落，只问一次，然后提交或跟随。
- 态：在途补骨架；空态只认干净跑完；错误走横幅；无源是独立空态（`cityEmptyState === 'no-sources'`）；续页只认 `round.hasMore` + `loadMore`，尾行给本轮读数。
- 右侧书目是**按源**的，不跨源合并；顺序听源。

### 3.3 书源管理（`src/client/views/SettingsSection.tsx`）

- 组成：待办收件箱（`InboxSection`，可忽略 / 重新显示）、任务槽（`ProbeRunCard`）、源列表（`SettingsSourceList.tsx` 的 `SourceList`）与导入弹层（`SettingsImportPane.tsx` 的 `ImportPane`）。
- 导入：拖放 / 多选文件，另有折叠的粘贴道；提交即关弹层，结果回待办。
- 列表：状态带、文本 / 状态 / 分组过滤、编辑态批量条、六列表格、前端分页（步长是代码里的常量，尾钮按它追加）。
- 行：状态徽标、验证 / 重验、试跑下钻（`ProbePane`，带状态徽标与错误横幅）、「⋯」菜单、最右 `role=switch` 启停。启停是乐观写，失败回滚并在行锚点标红边。
- 删除源走确认模态；启停不做二次确认。

### 3.4 搜索（`src/client/views/SearchView.tsx`）

- 入口：书架头搜索框（带关键字跳转）与搜索页表单；`route.keyword` 消费一次即摘除。
- 结果页：进度读数 + 收口摘要（`client/copy/search-summary.ts` 的 `searchSummarySegments`）。
- 空态两分支：没有可搜的源 / 搜了但零命中。
- 默认按书视图（`search-view-model.ts` 的 `deriveRound`，只收 `kept`）：每本一组逐源行，「都加架」三态，回执分三笔（成功 / 仍缺 / 无地址）。
- 逐源详情降级到页尾 `<details>`：组头带状态徽标，suspect 组在组内折叠，失败源折叠并点名错误；无地址的命中渲染为 dead 行，不给可点入口。

### 3.5 阅读器（`src/client/views/ReaderView.tsx`）

- 连续滚动，只渲染已载章节；预取判据住 `reader-load.ts` 的 `nextLoadTarget`（哨兵 + 两屏），`ReaderSession` 的 `checkPreload` 与 `pruneToViewport` 把 DOM 裁到视口连续区间。
- 进度：`ReaderSession` 的 `commit` 四个来源——恢复不写、跳转与跨章立落、滚动防抖——统一落到 `saveProgress`。
- 浮层住 `reader-surfaces.ts` 的 `ReaderSurface`：偏好 / 目录 / 导出 / 补充正文 / 导入注释，**至多一角**；`openSurface` / `closeAll` 管开合，只有偏好与导出带遮罩，Esc 归属由 `escOwner` 判（模态优先）。
- 离开一问：`reader-scene.ts` 的 `ReaderScene` 只在书不在架（`onShelf === 'off'`）时问「加入书架」；入架成功才离开，失败只落内联错误、留在阅读器。

## 4. 浮层与危险动作

- **带遮罩**（`src/client/views/dialog.tsx` 的 `Dialog`）：删书确认（单 / 批）、离开阅读器的入架一问、删源确认（单 / 批）、导入弹层（wide）、书籍详情（drawer）。
- **不带遮罩**：目录抽屉、阅读注释面板、导入注释面板、书源「⋯」菜单、行内登录、书架导入回执、全局状态层与状态条。
- 模态契约（Esc、入场焦点、Tab 圈、关闭后还焦、scrim 与 dialog 标记）只在 `src/client/views/dialog.tsx` 定义一次，五处浮层共读同一份。
- **危险层级**：确认框的主按钮用 `danger solid`（实心红）；行内删除用 `danger`（安静红）；启停这类可逆动作不设确认；导出先过范围面板再发。当前没有「清缓存」这类入口——缓存失效靠指纹入名，不提供删除式清理（`ADR-0012`）。

## 5. 插件设置页的运行参数卡

- 挂点：宿主插件详情页的 `plugins.bundle.config` 槽位（按 bundle 包名寻址的 keyed 子槽位），由 `src/client/config-page.tsx` 的 `registerConfigPage` 注册。
- 卡片按四组排：搜索 / 阅读 / 存储 / 网络（`GROUPS`）。只渲染运行时可活更的字段（volatile）——启动期字段（如 `dataDir`）不出现在这里。
- 每行：是否已覆盖的标记与单项重置（`resetField`）、预设 chip、宿主回读值、非法值内联报错。保存 / 只读 / 不可用 / 失败四态归宿主 `SettingsForm`，卡片不自造。
- 保存即写活配置，下一次读数生效，不重载插件；volatile 更新事件只在 Node 端留痕。
