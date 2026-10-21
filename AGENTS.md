# dsh-novel — 给 agent 的工作须知

DeepSeek Harness（DSH）的「小说」插件：导入 legado 书源 → 聚合搜索 → 书架 → 连续滚动阅读，并给 AI 助手六个小说工具（名字全部锁 `dshnovel_` 前缀——宿主对工具重名直接抛错，插件专属前缀是与生态的硬边界，名字集合由 `tests/tools/tools.test.ts` 钉住）。双半产物：Node 半（Cordis 插件 + `/novel-api`，`src/{engine,services,api,tools}` + `src/config.ts` 配置缝）与浏览器半（左侧栏「小说」**全局面板**：书架 / 书城 / 书源管理三 tab，`src/client`）。

## 真相在哪（按顺序读）

1. **`CONTEXT.md`** — 领域词汇表，每个词条点名它的**唯一实现**符号。命名新 module、改口径、写文档之前先查它：自造同义词会让同一概念长出第二份抄本。
2. **`docs/architecture.md`** — 形状与归属：分几块、为什么这么切、某条语义该去哪改（唯一主人清单）。它**不装读数与决策**，只给地图。
3. **`docs/adr/`** — 决策与当前仍被否决的替代方案，每篇一个编号文件。状态、索引、`锚点：` 与取代规则住 `docs/adr/ADR-FORMAT.md`；编号只追加、别重排（断号即有人抄不到那一页）。
4. **代码注释** — 局部口径的家。每条口径的「为什么、约束」就地写在实现它的那个符号头上（高度要求见 `docs/AGENTS.md` 的写作规则）；跨子系统的全局论述才进 architecture.md。
5. **`tests/legado-coverage/matrix.ts`** — 「彻底兼容 legado」的唯一读数口：一行一条 legado 语义，三态归属 + 证据 + 裁决理由 + 复核戳。
6. **`docs/AGENTS.md`** — 文档分层、放置判据、写作规则与生命周期；ADR 格式在 `docs/adr/ADR-FORMAT.md`。
7. **`README.md`** — 用户面事实与产品命令；贡献者的构建、门控与发版流程在 `docs/development.md`，提交/PR/发版边界在 `CONTRIBUTING.md`，发布历史在 `CHANGELOG.md`。
8. **代码与测试** — 最终真相。文档、注释、矩阵行与代码冲突时以代码为准，并顺手把上面几处改正。

> 分工只有一条要记：**读数 / 决策 / 现状是三种寿命不同的东西**，分别住矩阵行 `note`、`docs/adr/`、`docs/architecture.md`。把它们写回同一份文件，就是这一层曾经膨胀到单份 480 行的原因。

## 硬约束（本仓的不变量，违反即回归）

- **wire 单点**：路由名、值形状与写路由的 body 形状（构造器 + 读口）只住 `src/shared/wire.ts`，Node 半与浏览器半消费同一份（`src/client/views/types.ts` 只是再导出桶）。
- **书目字段集**：加 / 改书架元数据字段 = 只改 `shared/wire.ts` 的 `SHELF_META` + `pickShelfMeta`，`Shelf` 与 dispatch 自动跟上；别在各处写逐字段 `typeof` 筛键的抄本。
- **宁炸不猜**：认不出的规则语法在**解析期**抛 `UnsupportedRuleError`，带段级定位；空结果冒充失败是本仓定的最高罪。
- **取值规约**：取位失败 → Miss、解析到空集合 → 空 List，两种值绝不折叠；唯一实现 `src/engine/select.ts` 的 `reducePicked`。
- **纯度门**：`src/client/**` 的运行时 import 只能来自平台模块表；`src/shared/wire.ts` 保持零运行时依赖（它被 inline 进 client bundle）。构建成败由 `tsdown.config.ts` 的 `dsh-novel-bundle-purity` 把住，改平台模块表要对着宿主发布物重读，别凭记忆。
- **客户端文案单点**：`src/client/**` 的可见文案（中文原文与英文译文；单位、格式名、错误码、装饰字形与插件卡片元信息除外）只住 `src/client/copy/**`，组件经 `useCopy()`、非 React 函数经 `Translate` 参数取词；宿主 locale 服务可选读（`ctx.get('locale')`），缺席回退中文。服务端错误原文与 AI 工具描述不在这一层。机器面是 `tests/client/copy-guard.test.ts`（AST 扫字符串 / 模板串 / JSX 文本里的中文，注释不算；英文译文由 `EN` 的逐键镜像与评审兜底），白名单只许收不上屏的数据/注释，或与语言无关的装饰字形、模板，且每条带理由。

## 改完必须验的门（默认全跳过，没人替你跑）

`pnpm test` 全绿只证明引擎 / 服务 / 契约 / 前端逻辑：**不证明**任何真实站点可用性、也不证明安装链路。`pnpm typecheck` 必须与 `pnpm test` **同批跑**：tests 在 tsconfig 内而 vitest 不查类型，props 缝加宽而某个测试文件没跟上，只有 tsc 抓得住。`pnpm lint` 把界面那一头**未豁免**的 react-hooks 依赖数组（`src/client` 里仍在的 `eslint-disable` 是存量豁免清单，不在本门覆盖内），仓内方向与值环由 `tests/layering.test.ts` 随 `pnpm test` 把，不额外要一条命令。

改动抓取 / 规则引擎 / 打包链路，或改相关性判据 / 按书归并时，`docs/development.md` 的「测试与真链路门控」那几条门控（`DSH_REPROBE` / `DSH_CONTENT_AUDIT` / `DSH_SEARCH_FILTER_AUDIT` / `COMPAT_CAPTURE` / `DSH_INSTALL_CHECK` / `DSH_EPUB_BROWSER` / `DSH_WEBVIEW` / `DSH_PARSE_CENSUS`）是唯一自动化验证——按那里的命令跑对应那条，并把结论**如实**写进汇报。注意分工：reprobe 只验**搜索面**，`verified` 不证明正文可读，正文口径是 `DSH_CONTENT_AUDIT`，而它是**审计报告**、不设通过率断言（分桶读数要人判）；`DSH_SEARCH_FILTER_AUDIT` 真打聚合搜索、量相关性分档与按书归并的读数，同为**报告**、唯一断言只是判据自洽（分档不丢条），供裁「去虚字放行」那条偏离与那把归并键的焊错面；`DSH_EPUB_BROWSER` 只在本机浏览器里量渲染与几何（本地书正文、组件排版），不起服务也不访问站点。

**取门的退出码，别看管道说了什么**：跑门与提交必须是两条命令；完整口径见 `docs/development.md` 的「测试与真链路门控」。

跑 `pnpm test` 前确认依赖装全：缺 `jsdom` / `@testing-library/react` 会让前端测试文件假红（报 `Cannot find module`）。

## 兼容判据（`pnpm test` 默认跑，运行时不依赖任何外部 checkout）

`tests/legado-coverage/` 四门：**`status-evidence`**（逐行验证据可回查：`implemented` 的实现符号在剥注释后的代码里、钉子用例在测试里；`not-applicable` 必须写明裁决理由；`open` 必须带 `2026-MM-DD` 复核戳，且任何 `N 源` 形态的现量读数都要有日期锚——最危险的不是「还没做」，是旧批读数被当现状用）、**`inventory-coverage`**（每个能力单元各挂 ≥2 条真实矩阵行，分母是矩阵本身）、**`upstream-fields`** 与 **`host-methods`**（后两门的分母是**仓内快照** `compat/upstream/snapshot.json`：对面源根路径集 / 规则实体字段表 / java 宿主方法名集）。

快照由开发阶段的 `DSH_CAPTURE_UPSTREAM=1`（需 `DSH_LEGADO_REF` 指路）从对面 checkout 抽一次。**快照不在场即红，不要改成 skip-if-missing**——「静默转 skip、无一物变红」是这扇门专门删掉的旧失效模式。

判「不适用」而不写理由，等于把裁决写成遗忘：理由写进那一行的 `note`，别写进注释、更别再开一份文档。

## 文档

- 文档该放哪、怎么写、什么时候归档：`docs/AGENTS.md`；ADR 的状态、索引与锚点：`docs/adr/ADR-FORMAT.md`。
- 一条事实只住一个家；当前事实只写现在时；过程文档留在本机 `.superpowers/`，不入库。
- 根 `AGENTS.md` 预算 ≤ 8,000 字符；改完文档跑 `pnpm test` 的文档门（`tests/docs-liveness.test.ts`；改 `CONTEXT.md` 另过 `tests/context-terms.test.ts`）；改代码注释由 `tests/comment-altitude.test.ts` 另把。
- 提交用 conventional commits（`feat|fix|test|docs|refactor|chore(scope): 中文说明`），正文讲为什么；完整约定见 `CONTRIBUTING.md`。

## 环境坑（配置文件里看不出来的）

- **`lib/` 是构建产物且不入库**：先 `pnpm build`，否则整个插件树拒绝挂载（`plugin tree failed to load` + `ERR_MODULE_NOT_FOUND`）。完整说明见 `docs/development.md` 的「构建与日常开发」。
- **改动生效路径分两半**：浏览器半由宿主 HMR 热推，Node 半必须重启宿主；前提与细节见 `docs/development.md` 的「构建与日常开发」。
- **出站代理**：DSH 的 Node 进程走 undici，**不读系统代理**；只有代理能到的站点必须配 `proxyUrl`，否则表现为「浏览器能开、插件打不开」。
- **运行时数据不在仓库**：书源 / 书架 / 缓存 / 本地书住 `~/.dsh/novel/`（`dataDir` 可改）。
- **`compat/report.md` 是跑门产物**：`pnpm test:compat` 每次覆盖写，已 gitignore；它的分母是 `compat/fixtures/` 下的 fixture，**不是站点可用率**。
