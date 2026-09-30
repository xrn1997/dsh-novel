# dsh-novel — 给 agent 的工作须知

DeepSeek Harness（DSH）的「小说」插件：导入 legado 书源 → 聚合搜索 → 书架 → 连续滚动阅读，并给 AI 助手六个小说工具（名字全部锁 `dshnovel_` 前缀——宿主对工具重名直接抛错，插件专属前缀是与生态的硬边界，名字集合由 `tests/tools/tools.test.ts` 钉住）。双半产物：Node 半（Cordis 插件 + `/novel-api`，`src/{engine,services,api,tools}`）与浏览器半（左侧栏「小说」**全局面板**：书架 / 书城 / 书源管理三 tab，`src/client`）。

## 真相在哪（按顺序读）

1. **`CONTEXT.md`** — 领域词汇表，每个词条点名它的**唯一实现**符号。命名新 module、改口径、写文档之前先查它：自造同义词会让同一概念长出第二份抄本。
2. **`docs/architecture.md`** — 形状与归属：分几块、为什么这么切、某条语义该去哪改（唯一主人清单）。它**不装读数与决策**，只给地图。
3. **`docs/adr/`** — 决策与它当初被否决的替代方案，每篇一个编号文件。**只追加**：推翻一条就写一篇标 superseded，别改写历史，也别重排编号（断号即有人抄不到那一页）。
4. **代码注释** — 局部口径的家。每条口径的「为什么、约束」就地写在实现它的那个符号头上（见下面「高度规范」）；跨子系统的全局论述才进 architecture.md。
5. **`tests/legado-coverage/matrix.ts`** — 「彻底兼容 legado」的唯一读数口：一行一条 legado 语义，三态归属 + 证据 + 裁决理由 + 复核戳。
6. **`README.md`** — 用户面与命令。
7. **代码与测试** — 最终真相。文档、注释、矩阵行与代码冲突时以代码为准，并顺手把上面几处改正。

> 分工只有一条要记：**读数 / 决策 / 现状是三种寿命不同的东西**，分别住矩阵行 `note`、`docs/adr/`、`docs/architecture.md`。把它们写回同一份文件，就是这一层曾经膨胀到单份 480 行的原因。

## 硬约束（本仓的不变量，违反即回归）

- **wire 单点**：路由名与值形状只住 `src/shared/wire.ts`，Node 半与浏览器半消费同一份（`src/client/views/types.ts` 只是再导出桶）。
- **书目字段集**：加 / 改书架元数据字段 = 只改 `shared/wire.ts` 的 `SHELF_META` + `pickShelfMeta`，`Shelf` 与 dispatch 自动跟上；别在各处写逐字段 `typeof` 筛键的抄本。
- **宁炸不猜**：认不出的规则语法在**解析期**抛 `UnsupportedRuleError`，带段级定位；空结果冒充失败是本仓定的最高罪。
- **取值规约**：取位失败 → Miss、解析到空集合 → 空 List，两种值绝不折叠；唯一实现 `src/engine/select.ts` 的 `reducePicked`。
- **纯度门**：`src/client/**` 的运行时 import 只能来自平台模块表；`src/shared/wire.ts` 保持零运行时依赖（它被 inline 进 client bundle）。构建成败由 `tsdown.config.ts` 的 `dsh-novel-bundle-purity` 把住，改平台模块表要对着宿主发布物重读，别凭记忆。

## 改完必须验的门（默认全跳过，没人替你跑）

`pnpm test` 全绿只证明引擎 / 服务 / 契约 / 前端逻辑：**不证明**任何真实站点可用性、也不证明安装链路。`pnpm typecheck` 必须与 `pnpm test` **同批跑**：tests 在 tsconfig 内而 vitest 不查类型，props 缝加宽而某个测试文件没跟上，只有 tsc 抓得住。

改动抓取 / 规则引擎 / 打包链路时，README「测试」节那几条门控（`DSH_REPROBE` / `DSH_CONTENT_AUDIT` / `COMPAT_CAPTURE` / `DSH_INSTALL_CHECK` / `DSH_EPUB_BROWSER` / `DSH_PARSE_CENSUS`）是唯一自动化验证——按那里的命令跑对应那条，并把结论**如实**写进汇报。注意分工：reprobe 只验**搜索面**，`verified` 不证明正文可读，正文口径是 `DSH_CONTENT_AUDIT`，而它是**审计报告**、不设通过率断言（分桶读数要人判）；`DSH_EPUB_BROWSER` 只跑本机浏览器与本地书、不访问站点。

**取门的退出码，别看管道说了什么**：`pnpm test | grep` 之后退出码是 grep 的，红会被吃掉还留一句「全绿」。跑门一律两步：先把输出灌进文件，再单独打印退出码，汇报里把**退出码连同计数**一起抄。**跑门与提交必须是两条命令**——链式的下一环看的是别人的退出码，红也就跟着提交了。

跑 `pnpm test` 前确认依赖装全：缺 `jsdom` / `@testing-library/react` 会让前端测试文件假红（报 `Cannot find module`）。

## 兼容判据（`pnpm test` 默认跑，运行时不依赖任何外部 checkout）

`tests/legado-coverage/` 四门：**`status-evidence`**（逐行验证据可回查：`implemented` 的实现符号在剥注释后的代码里、钉子用例在测试里；`not-applicable` 必须写明裁决理由；`open` 必须带 `2026-MM-DD` 复核戳，且任何 `N 源` 形态的现量读数都要有日期锚——最危险的不是「还没做」，是旧批读数被当现状用）、**`inventory-coverage`**（每个能力单元各挂 ≥2 条真实矩阵行，分母是矩阵本身）、**`upstream-fields`** 与 **`host-methods`**（后两门的分母是**仓内快照** `compat/upstream/snapshot.json`：对面源根路径集 / 规则实体字段表 / java 宿主方法名集）。

快照由开发阶段的 `DSH_CAPTURE_UPSTREAM=1`（需 `DSH_LEGADO_REF` 指路）从对面 checkout 抽一次。**快照不在场即红，不要改成 skip-if-missing**——「静默转 skip、无一物变红」是这扇门专门删掉的旧失效模式。

判「不适用」而不写理由，等于把裁决写成遗忘：理由写进那一行的 `note`，别写进注释、更别再开一份文档。

## 文档纪律

- **过程文档不入库**：逐任务计划、审查报告、任务简报、一次性扫描脚本写在本机 `.superpowers/`（已 gitignore）。`main` 只保留当前真相。
- **原地更新，不新增副本**：改口径就改实现处那段注释 / 那个矩阵行；改**决策**才追加一篇 ADR，并给被推翻的那篇标 superseded。新起一份份 spec / plan 会让真相分叉。
- **高度规范**：注释与文档承担**为什么 / 口径 / 裁决 / 证据**，不承担代码细节——实现步骤复述、控制流描述、表达式与调用链的抄写都不许；「怎么做」的家是代码自己。自测问题：*这句删掉，读者丢的是「为什么」还是「怎么做」？*只丢后者就删或升高度。要指实现就指**符号锚**（函数/常量名、抛错消息原文、矩阵行 id），不抄表达式——抄写形由 `tests/comment-altitude.test.ts` 随 `pnpm test` 兜底。
- **同一事实只住一个家**：真机读数住矩阵行 `note`、局部口径住代码注释、决策与被否决的方案住 `docs/adr/`、跨子系统形状住 `docs/architecture.md`、用户可见事实住 `README.md`、术语住 `CONTEXT.md`。写作时先问「这句属于哪家」——不属于任何一家的句子就是抄本。
- **引用活性：不许指着读者拿不到的东西**。不写行号（`file.ext:123` 形态会随任何一次编辑漂移）；不指已出库或不存在的文件；不拿 `.superpowers/` 里的过程产物当证据。外部出处（对面 legado 的 `.kt` 路径与符号）只许出现在三处：`README.md`（致谢）、`tests/legado-coverage/matrix.ts`（登记册）、快照刷新工具 `tests/legado-coverage/{upstream-facts.ts,capture-upstream-snapshot.test.ts}`；其余地方只讲本仓自己的口径。
- **词汇优先**：新概念先进 `CONTEXT.md` 点名它的唯一实现，再写代码——反过来做会让同一个东西有两个名字。
- **文档面的引用活性有门**：`tests/docs-liveness.test.ts` 随 `pnpm test` 扫 README / AGENTS / CONTEXT / `docs/**`——路径不在场、行号形态、指已出库文档或过程产物，都红；ADR 编号断号也红。词汇表点名的符号能不能现查得到，另有一道 `tests/context-terms.test.ts`。
- **提交**：conventional commits（`feat|fix|test|docs|refactor|chore(scope): 中文说明`），正文讲**为什么**。

## 环境坑（配置文件里看不出来的）

- **`lib/` 是构建产物且不入库**：任何从源码目录链进 profile 的安装方式都不会替你构建它——先 `pnpm build`，否则整个插件树拒绝挂载（`plugin tree failed to load` + `ERR_MODULE_NOT_FOUND`）。
- **改动生效路径分两半**：`lib/client.js` 的 mtime / size 一变，`dsh-client-hmr` 自动推给浏览器热更新（前提是 `pnpm dev` 或手动 `pnpm build` 让产物真的重生成）；Node 半不在热重载链路内，改完要重启宿主。
- **出站代理**：DSH 的 Node 进程走 undici，**不读系统代理**；只有代理能到的站点必须配 `proxyUrl`，否则表现为「浏览器能开、插件打不开」。
- **运行时数据不在仓库**：书源 / 书架 / 缓存 / 本地书住 `~/.dsh/novel/`（`dataDir` 可改）。
- **`compat/report.md` 是跑门产物**：`pnpm test:compat` 每次覆盖写，已 gitignore；它的分母是 `compat/fixtures/` 下的 fixture，**不是站点可用率**。
