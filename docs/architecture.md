# 架构与形状

这份文档只回答两个问题：**系统分成哪几块、为什么这么切；某条语义的主人在谁头上**。它是 explanation——给读懂代码提供地图，不给代码充当副本。

不在这里的东西，各有各的家：**真机读数与欠账**在 `tests/legado-coverage/matrix.ts` 的行 `note`（那是唯一读数口）；**决策与它当初被否决的替代方案**在 `docs/adr/`；**用户可见的事实与全部命令**在 `README.md`；**术语的定义**在 `CONTEXT.md`；**"怎么做"**在代码自己。这里一条读数都不列——列了就是第二份抄本，且必然腐烂。

## 1. 双半形态

同一个仓库产两半，运行在两个地方，靠一份契约对齐：

```
      浏览器（宿主前端）                     Node（宿主进程）
  ┌────────────────────────┐            ┌──────────────────────────┐
  │ src/client  全局面板   │  HTTP/JSON │  src/api    /novel-api   │
  │  书架 · 书城 · 书源管理 │ ─────────▶ │  src/tools  六个 agent 工具│
  │  只有视图与可丢弃投影   │            │  src/services domain 门面 │
  └────────────────────────┘            │  src/engine 规则引擎(纯)   │
           ▲                            └──────────────────────────┘
           │  值形状与路由名：src/shared/wire.ts（两半 import 同一份）
```

- 浏览器半是 CJS 单文件闭包工厂，经宿主的模块装载器进场，bundle 内每个 `require` 由宿主**冻结的平台模块表**解答——这决定了它不能带运行时依赖出去（`docs/adr/0021`）。
- Node 半是 Cordis 插件：入口导出配置 schema 与 `apply`，在 `apply` 里挂三条注册（prefix 路由、工具、常驻 effect）。装配声明与安装许可由宿主的兼容闸把关（`docs/adr/0020`）。
- **浏览器半不读任何运行时配置、也不需要 API base**：同源根相对 fetch，前缀由 wire 单点持有。
- 改动生效分两条路：浏览器半靠宿主的 HMR 热推；Node 半必须重启宿主。契约升级要**两半同批**上线（`docs/adr/0019`）。

## 2. Node 半的分层与依赖方向

```
engine/    规则串 → 值。纯函数、零 IO、零内部状态、段级定位；@js 沙箱在这层
   ▲
services/  domain 门面 + 部件：抓取 / 书源注册表 / 书架 / 缓存 / 本地书 / 后台任务
   ▲
api/  ·  tools/        ← 两个平行的**投影面**，不是上下两层
   ▲
index.ts 组合根：配置 → 缺省值 → 部件装配 → 三条注册
```

- **`api` 与 `tools` 各只拥有什么**：`api/dispatch.ts` 只做传输关注点（方法守卫、body 形状、信封、流式与响应头），业务判据一律抛给门面动词；`tools` 只 `import type` 门面，每个 `execute` 都是门面动词的调用，自己只拥有缺键投影与 render。所以「UI、AI 工具、探针三个面共用同一条链路」不是口号而是 import 事实。
- **绕过门面在类型上不可表达**：门面的部件全是构造期的私有成员，外部三面拿不到。
- 方向上的两处**刻意破例**都有理由，别当违规清理：选项切分常量放引擎侧（桥不能 import 服务层）；`services/url.ts` 存在的唯一理由是拆 request ↔ bridge 的环。
- 反向依赖的硬约束：`services` 不 import `api`（服务层的错误类型由路由层映射成状态码）；EPUB 子树不认识书架与 HTTP。
- 持久化模型不另立形状：`services/types.ts` 把状态枚举与书目形状**反向 re-export** 自 wire——契约不是服务层的私有形状，是两半共用的那一份。

## 3. 引擎：层间只走两种值

词法与文法（零 IO）→ 求值 → 宿主层（沙箱 / 协议表 / 纯工具 / DOM）。层间流通的只有 `EngineValue` 五态（miss / value / list / nodes / matches，定义单点在 `engine/types.ts`）与**带段级定位的错误**（格式化单点在 `engine/errors.ts`）。

一条不对称要记住：**面（`Facet`）不改变求值语义**，它只进错误定位与 trace；**用途（`RuleUsage`）改变形状**，且只有这一个轴被允许改变形状（`docs/adr/0007`）。把它们混为一谈会生出「面决定语义」的假口径。

链语义是单点：一条链只有一份 generator，两个驱动器对链本身零知识；js 段是唯一需要跨 `await` / 跨线程的段，所以它是唯一的 `yield` 点，也是唯一允许把宿主能力带进求值层的口子（`docs/adr/0005`）。

文法区域（`{{…}}` / `@put:{…}` / `<js>`）先于任何切分被整体剥离，判据只住在 `engine/grammar.ts`——区域里的 `||`、`&&`、`@`、`$1` 是代码内容而不是文法记号。构词与解析同属一处，方言拼串走 round-trip 自校验。

引擎能离线跑，是这套切分的直接后果：网络、二进制、UA 全是注入函数，所以解析面普查可以拿真入口跑全库规则串，不需要站点也不需要宿主。

## 4. 唯一主人清单

某条语义"该去哪改"的对照表。写第二份之前先查这里。

| 语义 | 唯一主人 | 它不回答什么 |
| --- | --- | --- |
| 路由名 / 值形状 / body 构造器 | `shared/wire.ts` | 业务判据 |
| 书目元数据字段集 | `shared/wire.ts` 的 `SHELF_META` + `pickShelfMeta` | 读取面投影（`sourceName` 刻意不进表） |
| 规则文法（构词 + 解析 + 区域） | `engine/grammar.ts` | 求值 |
| 段识别与切分次序（含隐式 CSS 回落） | `engine/parse.ts` | 空态裁决 |
| 空态裁决（Miss vs 空 List） | `engine/select.ts` 的 `reducePicked` | 服务层的值收口 |
| 组合符形状与驱动长度 | `engine/combine.ts`（读 `usage`） | 链衔接 |
| 行模板的判定与绑定 | `engine/regex-row.ts`（同一份文法的两面） | 模板字面段 |
| `EngineValue → 单串` | `engine/js-utils.ts` 的 `engineValueToString` | 业务字段语义 |
| 宿主方法面（名字 / 挂载 / 分派） | `engine/js-protocol.ts` 的协议表，加一个方法 = 表加一行 | 真实网络 |
| 选项语义（模板 → 请求计划） | `services/request.ts` 的 `assembleRequest` + `fetchInitOf` | 网络与解码 |
| 出站（超时 / 代理 / 解码 / 状态） | `services/fetcher.ts`，`@js` 复用同一出口 | 缓存与业务 |
| 一次搜索请求的完整语义（含嗅探） | `services/search-face.ts` | 聚合与游标 |
| 值投影（`EngineValue` → 业务串） | `services/bridge.ts` 的三种投影 | 空态判定 |
| 文字输出 | `services/content.ts` + `services/chapter-content.ts` | 图文排版 |
| 缓存「放在哪」 | `services/cache.ts` | 何时有效 |
| 缓存「还有效吗」 | `services/cache-epoch.ts`（代际 + 槽位），裁决在 `services/reading.ts` | 清理策略 |
| 入库规则（什么算同一本书源） | `services/intake.ts` | 呈现与计数 |
| 源清单与落盘 | `services/sources.ts` 的注册表（只有 `edit` / `flush`） | 任务节流 |
| 原子写与 JSON 读的两分判别 | `services/storage.ts` | domain 的合并写策略 |
| 翻页何时停 | `services/pagination.ts` 的 `followPages` | 站点结构解析 |
| 本地书身份与分流 | `services/localbooks.ts` | EPUB 包内解析（`services/epub/`） |
| 聚合搜索的参与集 | `services/participation.ts` 的 `participates`（发现面谓词 `exploreParticipates` 同文件） | 源清单读写 |
| 错误类目 → HTTP | `services/errors.ts` + `api/wire.ts`（两分法） | 路由自检错误 |
| 整轮搜索结果 | `services/search-job.ts`（Node 半持有） | wire 形状 |
| 一次分类页请求的完整语义（含整套规则回落） | `services/explore-face.ts` 的 `fetchKindPage` | 整轮编排与跨源归并 |
| 分类词表（有哪些分类、各被多少源声明） | `services/explore.ts` 的 `kindsOf` / `sourcesOfKind` | 站点侧分类的同义归并（本仓不造同义词表） |
| 一轮分类抓取的编排（批并行 / 完成序交付 / 快照写回） | `services/explore.ts` 的 `runExploreKind` | 轮次状态与终态 |
| 整轮分类结果 | `services/explore-job.ts`（Node 半持有，读面给全量快照） | wire 形状 |
| 同一本书的跨源归并 | `services/merge.ts` 的 `mergeBooks` | 字段级择优（取首次出现那一份） |
| 逐条目取值装配（求值上下文 → 一条命中） | **今天没有主人，两份抄本刻意接受**：`services/explore-face.ts` 与 `services/reading.ts` 各一份 | 两份的规则来源本就不同（发现面整套切换 vs 通用搜索面）；第三处消费者出现时再抽公共装配 |
| 分类快照的存放与时效 | `services/explore-cache.ts` 的 `KindCache` + `services/cache-epoch.ts` 的 `exploreEpoch` | 目录 / 正文文件缓存（`rulesEpoch`） |
| 缺省值 | 五个各自主人（见 `tests/services/defaults.test.ts` 钉的常量） | 第二处字面量 |
| 浏览器视图内路由与跨卸载现场 | `client/store.ts` + 各模块级现场 store | 业务真相 |
| 阅读时序 | `client/reader-session.ts` | DOM 测量实现 |
| 章节窗口与预取判据 | `client/reader-load.ts` | 会话状态 |
| 阅读位置 ⇄ 像素 | `client/progress.ts`（两侧同跨度才互逆） | 落盘时机 |
| 视觉 token 与标度 | `client/styles.tsx`（唯一 token 层） | 视图局部布局 |
| 兼容读数与裁决 | `tests/legado-coverage/matrix.ts` 的行 | 复述进文档 |

## 5. seam：可测性怎么落

- **纯函数面**直接单测，不造宿主替身：`parseRule`、`reducePicked`、`evalCss`、`evalXPath`、`evalJsonPath`、`applyReplaces`、`interpolateUrl`、`appendTail`、`bindRegexRow`、`engineValueToString`，以及客户端的 `source-list-view` / `shelf-view-model` / `source-inbox` / `reader-load` / `progress`。
- **注入垫片**是测试进出的口子（不是换模块替身）：引擎侧 `EvalContext` 的 fetch 族 / `evaluateRef` / `subEval` / `SourceSession` / 超时预算；服务侧 fetcher 与注入的时钟/目录；客户端三束 deps（核心 / 设置 / 阅读器）+ `ReaderPort`；浏览器位置用例走仓内最小宿主壳，它只证明「卸载与重挂」那一半契约。
- **两条求值路必须同口径**（主线程与 worker），由按 fetch 计数自证的跨路钉子守——这是 `docs/adr/0005` 的产物。
- 客户端的测试手法是**假 adapter 驱动真实组件**，不是渲染快照；服务端的路由测试用真 HTTP server 承载（`api/dispatch.ts` 不依赖 Cordis，纯构造器）。
- **门的分工别混**：解析面普查管「能不能解析」，重探只证搜索面，正文审计是**报告**不设通过率，compat 回放的分母是 fixture，真浏览器门只跑本机与本地书，安装门控不起宿主。各自承诺什么写在 `README.md` 的门控节，不在这里复述。

## 6. 数据与生命周期

- 运行时数据全部住数据根（默认 `~/.dsh/novel/`，`dataDir` 可改）：源清单、书架与进度、页面缓存、本地书副本。构建产物 `lib/` 不入库；`compat/report.md` 是跑门产物。
- 读面与写面：源清单与书架都是**内存活体 + 按文件名排队的原子写**；「不存在」与「损坏」绝不折叠（`docs/adr/0013`）；本地发布与入架之间不建跨文件事务，接受的窗口写进 `docs/adr/0014`。
- 缓存有效性靠指纹入名而不是删除式失效，所以**没有清缓存出口是设计而非缺失**（`docs/adr/0012`）。
- 任务生命周期：身份与终态在宿主注册表，业务明细与整轮结果在本仓持有者；写任务一槽、搜索另开一槽；任务态不持久化（`docs/adr/0018`）。

## 7. 阅读路径建议

- 要改抓取或规则语义：`CONTEXT.md` 找术语 → 本文件第 4 节找主人 → 去那个符号头上读注释 → 查 `docs/adr/` 有没有对应裁决。
- 要加一个书架元数据字段：只改 `SHELF_META`（第 4 节第一行就是它）。
- 要判断「legado 某写法该不该支持」：先查矩阵有没有那一行；没有就先落一行，再动手。
- 要改宿主接入方式：先读 `docs/adr/0020`、`docs/adr/0021`，再动 `package.json` / `tsdown.config.ts`。
