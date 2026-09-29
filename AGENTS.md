# dsh-novel — 给 agent 的工作须知

DeepSeek Harness（DSH）的「小说」插件：导入 legado 书源 → 聚合搜索 → 书架 → 连续滚动阅读，并给 AI 助手六个小说工具（全锁 `dshnovel_` 前缀——宿主对工具重名直接抛错，插件专属前缀是与生态的硬边界，名字集合由 `tests/tools/tools.test.ts` 钉住）。双半产物：Node 半（Cordis 插件 + `/novel-api`，`src/{engine,services,api,tools}`）与浏览器半（左侧栏「小说」**全局面板**：书架 / 书城 / 书源管理三 tab，`src/client`）。

## 真相分层（按顺序读，别跳）

1. **`CONTEXT.md`** — 领域词汇表，每个词条点名它的**唯一实现**位置。命名新 module、改口径、写文档之前先读它：自造同义词会让同一概念长出第二份抄本。
2. **`docs/design/engine.md` / `services.md` / `client.md`** — 各子系统现状真相：模块地图、关键口径与**为什么**、被否决的方案、测试钉子、**已知开口**。改哪块读哪份（规则求值 → engine；抓取 / 书源 / 书架 / 路由 / 工具 → services；视图 / 阅读器 / 书源管理 tab → client）。**接活先扫一遍对应文档的「已知开口」**——需要拍板的未决项都列在那里。
2b. **`docs/design/legado-compat.md`** — legado 有、本插件**刻意不接**的能力面与理由（环境不适用清单）。它与 `tests/legado-coverage/` 成对：矩阵每行「不适用」都必须指向这里的锚点；对面 `data/entities/rule/*.kt` 的**每个字段**都要在矩阵里有归属，由 `tests/legado-coverage/upstream-fields.test.ts` 拿**仓内快照**的字段表逐字段回查（不现读对面 checkout），`tests/legado-coverage/coverage.test.ts` 验每行的证据。**这里没列出的缺席项就是欠账**，按矩阵 `open` 行排队；判「不适用」而不写进这份文档，等于把裁决写成遗忘。
3. **代码与测试** — 最终真相。设计文档与代码冲突时以代码为准，并顺手把文档改正。
4. **`docs/reference/`** — 外部事实（DSH 插件 API、tsdown 配置）。**`README.md`** — 用户面与命令。

## 硬约束（本仓的不变量，违反即回归）

- **wire 单点**：路由名与值形状只住 `src/shared/wire.ts`，Node 半与浏览器半消费同一份（`src/client/views/types.ts` 只是再导出桶）。
- **书目字段集**：加 / 改书架元数据字段 = 只改 `shared/wire.ts` 的 `SHELF_META` + `pickShelfMeta`，`Shelf` 与 dispatch 自动跟上；别在各处写逐字段 `typeof` 筛键的抄本。
- **宁炸不猜**：认不出的规则语法在**解析期**抛 `UnsupportedRuleError`，带段级定位；空结果冒充失败是本仓定的最高罪。
- **取值规约**：取位失败 → Miss、解析到空集合 → 空 List，两种值绝不折叠；唯一实现 `src/engine/select.ts` 的 `reducePicked`。
- **纯度门**：`src/client/**` 的运行时 import 只能来自平台模块表；`src/shared/wire.ts` 保持零运行时依赖（它被 inline 进 client bundle）。

## 改完必须验的门（默认全跳过，没人替你跑）

`pnpm test` 全绿只证明引擎 / 服务 / 契约 / 前端逻辑：**不证明**任何真实站点可用性、也不证明安装链路。`pnpm typecheck` 必须与 `pnpm test` 同批跑：tests 在 tsconfig 内而 vitest 不查类型，props 缝加宽而某个测试文件没跟上只有 tsc 抓得住（2026 审查实证：整轮 UI 改版 944 测试全绿、typecheck 红）。改动抓取、规则引擎、打包链路时，`README.md`「测试」节的**四条真链路门控**（`DSH_REPROBE` / `DSH_CONTENT_AUDIT` / `COMPAT_CAPTURE` / `DSH_INSTALL_CHECK`；另有一条真浏览器验收门 `DSH_EPUB_BROWSER`，它只跑本机浏览器与本地书、不访问站点）是唯一自动化验证——按那里的命令跑对应那条，并把结论如实写进汇报。注意：探针（reprobe）只验**搜索面**，「verified」不证明正文可读；正文链路（目录/正文规则、翻页、js 沙箱）的真机口径是 `DSH_CONTENT_AUDIT=1`（全链路审计 + 失败分桶；**它是审计报告，不设通过率断言**——分桶读数要人判，代码只断言每个注册源都进了审计）。新写/改写的注释与文档顺手过一遍文档纪律「高度规范」的自测问题（抄写形由 `tests/comment-altitude.test.ts` 随 `pnpm test` 兜底，步骤叙述靠人/agent 判断）。

跑 `pnpm test` 前确认依赖装全：缺 `jsdom` / `@testing-library/react` 会让 16 个前端测试文件假红（报 `Cannot find module`）。

- **取门的退出码，别看管道说了什么**：`pnpm test | grep` 或 `| tail` 之后退出码是 grep / tail 的，红会被吃掉还留一句「全绿」（2026-09-28 实证：那样跑出的「1910 tests 全绿」现场其实是 1 failed，而那句话写进了提交正文）。跑门一律分两步：先把输出灌进文件，再单独打印退出码；汇报里把**退出码连同计数**一起抄。**同一条命令里别把提交串在跑门后面**——`pnpm test; git add … && git commit` 这种链式的下一环看的是 `grep`/`git` 的成败，退出码取到了也照样会带红提交（2026-09-28 就犯过一次）。**跑门与提交必须是两条命令**，红就先修。

**`tests/legado-coverage/` 的兼容判据六门随 `pnpm test` 默认跑，且运行时不依赖任何外部 checkout**——
其中三门的分母是**仓内快照** `compat/upstream/snapshot.json`（对面源根路径集 / 7 个规则实体的字段表 /
java 宿主方法名集，三个分母各有门在管：路径集与规则实体类名→`citation-liveness`、字段表→`upstream-fields`、
方法名集→`host-methods`）；另三门吃矩阵与设计文档自身：`coverage`（矩阵每行的证据 + **读数时效戳**：`open` 行的 note
必须带 `2026-MM-DD` 复核戳，且**任何状态**的行只要写了 `N 源` 这类现量读数就必须带日期锚——今日复核或写明出处批次皆可，
无日期即红：`open` 行是待办队列，最危险的行不是「还没做」，是上一批库上的读数被当现状用）、`inventory-coverage`（在册
`UNITS` 的每个能力单元各挂 ≥2 条真实存在的矩阵行——它的分母是矩阵本身，**不读快照**）、
`matrix-pointers`（**矩阵行 id 是个锚，两侧都要查**：「矩阵 `<id>`」形态的指针必须指到在册的行，
反向每条 `open` 行的 id 必须在 `docs/design/*.md`/`CONTEXT.md`/`README.md` 里可达——只活在矩阵里的
缺席项，读那份设计文档的人根本走不到它）。快照由 `capture-upstream-snapshot.test.ts` 在**开发阶段**从对面 checkout 抽一次
（`DSH_CAPTURE_UPSTREAM=1`，需 `DSH_LEGADO_REF` 指路）；日常跑门只读快照，快照不在场即红，
**不要**改成 skip-if-missing——那正是本仓删掉的旧失效模式（见下一条纪律）。

## 文档纪律

- **过程文档不入库**：逐任务计划、审查报告、任务简报、一次性扫描脚本写在本机 `.superpowers/`（已 gitignore）。`main` 只保留当前真相，仓库里不留迭代记录。
- **设计变更原地更新** `docs/design/*.md`：改口径就改那一节，把「已知开口」里已解决的那条删掉。新起一份一份的 spec / plan 会让真相分叉。
- **写清理由与被否决的方案**：口径的「为什么」是这些文档不可替代的部分；只抄结论等于没写。
- **高度规范（2026-09-29 立）**：注释与文档承担**为什么 / 口径 / 裁决 / 证据**，**不承担代码细节**——实现步骤复述、控制流描述、表达式与调用链的抄写，「怎么做」的家是代码自己。自测问题：*这句删掉，读者丢的是「为什么」还是「怎么做」？*只丢后者就删或升高度。要指实现就指**符号锚**（函数/常量名、抛错消息原文、矩阵行 id），不抄表达式——抄写形有 `tests/comment-altitude.test.ts` 随 `pnpm test` 兜底。完善不算肿：长而有为什么是好注释；修订史与测量过程叙事不入库（git log 承载演进）。同一事实只住一个家：真机读数住矩阵行 note、口径与裁决住 design docs、就地「为什么」住代码注释。**机器门强制的不可压例外**：读数旁的日期锚、已知开口的编号与可批默认、矩阵 `impl`/`test` 指针、模块表符号列。曾把「写清理由」执行成多段叙事与代码细节搬运（2026-09-29 梳理过一轮才立此条），别再让它们互相掩护着长回去。
- **代码注释自足**：注释讲清口径与理由即可；要引用就引仓内存活文档（`docs/design/*`、`docs/reference/*`、`README.md`、`CONTEXT.md`），不写已出库文档的章节号或任务号。
- **文档引用用可 grep 的锚点，不写行号**：符号名、抛错消息原文、测试标题片段——行号会随注释的任何一次编辑漂移（本仓踩过：注释一剥，`parse.ts` 里那个行号就从 throw 变成了 `}`）。这条有机器守卫：`tests/legado-coverage/citation-liveness.test.ts` 扫跟踪文本里的 `.md/.ts/.tsx/.mjs`，`file.ext:123` 形态即红（`docs/reference/` 豁免——那里的行号指宿主发布物，属外部事实记录；裸 `:123`（不带文件名）机器认不出，靠本纪律管）。同族的另外两道：`tests/docs-references.test.ts`（文档里写的源文件路径必须在场）、`tests/docs-module-symbols.test.ts`（**两层**：三份模块表第三列的符号、以及 `CONTEXT.md` 每条「唯一实现」句点名的记号，都必须在生产代码里现查得到——`detectTailJs` 那种「符号删了、文档还留着」由它挡；后者算仓库根的 `*.ts`，构建期守卫住在 `tsdown.config.ts`，且**历史名字不许穿反引号**，那是给门开豁免名单以外的唯一正当写法）。再同族的一条：**按编号引用别家文档的「已知开口第 N 条」也归 `citation-liveness.test.ts` 管**——重排某一节不会报「找不到」，只会静默指向另一条，比缺锚更难发现；所以删掉已收口的条目时**留编号空洞、不要重排**（engine.md 第 19 条就是这么处理的，空洞的理由写在那一节头上）。
- **引用活性：不许指着读者拿不到的东西**（同上一门的另一半，2026-09-22 实证——兼容判据的分母原先写在不入库的手抄笔记里，笔记一消失检查静默转 skip，无一物变红）：
  - **外部出处只许出现在四处**：`README.md`（致谢与门控说明）、`tests/legado-coverage/matrix.ts`、`docs/design/legado-compat.md`（裁决表）、以及刷新工具 `tests/legado-coverage/upstream-facts.ts` 与 `capture-upstream-snapshot.test.ts`。其余所有地方（`src/**` 注释、`docs/design/engine.md`/`services.md`/`client.md`、测试注释）**讲本仓口径与理由，不点对面文件与符号**；要给出处就指矩阵行 id。这条有机器守卫（`citation-liveness.test.ts` 的白名单断言）。
  - 引对面 legado 的文件必须写成**带目录的相对路径**（相对 `app/src/{main,test}/java/io/legado/app/`），且必须能在**快照路径集**里现查。光凭文件名不算：同名文件在对面不止一份（`help/book/` 与 `model/webBook/` 下各有一份内容实体类，行数差一个数量级），不带目录的引用会落到另一份上。
  - `.superpowers/` 只许是**工具自己写出的输出目录**（在 `citation-liveness.test.ts` 的 `OUTPUT_DIRS` 登记理由），拿过程产物当证据即红——读数写进文档本身，或引仓内在册的东西。
  - 判据的分母只能是在册数据或**仓内快照**（`compat/upstream/snapshot.json`）。快照不在场即**红**，不许 skip——它是入库内容，谁 clone 都拿得到。
- **书源「现量」一律按 `raw`（原始书源 JSON）数，别按规范化后的顶层键数**（2026-09-22 实证：`lastChapter` 按顶层键量是 0 源、按 `raw` 量是 142 源非空——导入改名成 `ruleLastChapter`/`ruleDetailLastChapter` 了）。分母随用户增删漂，引用前先重数。
- **形态计数要用真入口，别用正则**（同日实证：正则数「JSONPath 过滤器 24 源在用」全是假阳性——命中的是 js 里 `new RegExp('[?&]…')` 这类字面量；真把 4170 条规则串过 `parseRule` 后该形态零命中）。规则语法面与 js 桥面的现量口径是 `DSH_PARSE_CENSUS=1 pnpm vitest run tests/engine/parse-census.test.ts`：它顺带断言「本仓拒绝的语法族 / 脚本在调而桥没挂的方法 ⊆ 在册集合」，新形态冒出来即红；**同一道门还印一张「需求读数表」**——登记册里那些「N 源带值」（发现面 / 翻页 / 章节标记 / 限速 / 登录面 / 桥面方法…）一条命令重算，判据印在数字旁边（同一个键常有两种数法）。**那张表里的读数不判红**：分母随用户增删漂，钉死读数等于每次改库都要改测试，要防的是"复数只能靠手写一次性脚本"（那些脚本不入库，读数却还活着——2026-09-28 就这样纠出三处漂）。判红的是两件**与分母无关**的事：**绑定落空**（矩阵 `ROW_DEMAND` 把登记行 note 里引用的数挂到这张表或桥面调用名集上，行 id 被改名/删掉、或那个键再也算不出来 = 指着不存在的地址）、**零读数空转**（当下数出 0 的判据必须在合成样品 `KITCHEN_SINK` 上数得出非 0，否则那个 0 分不清「真没人用」与「判据接不上任何东西」——非零要动手做才会被撞破，零只需要下一个人继续信它，而好些登记行的整条裁决就架在「这个 0 是真 0」上）。
- **提交**：conventional commits（`feat|fix|test|docs|refactor|chore(scope): 中文说明`），正文讲**为什么**——本仓的历史风格是长正文 + 证据串联。

## 环境坑（配置文件里看不出来的）

- **`lib/` 是构建产物且不入库**：任何从源码目录链进 profile 的安装方式都不会替你构建它——先 `pnpm build`，否则整个插件树拒绝挂载（`plugin tree failed to load` + `ERR_MODULE_NOT_FOUND`）。
- **改动生效路径分两半**：`lib/client.js` 的 mtime / size 一变，`dsh-client-hmr` 自动推给浏览器热更新（前提是 `pnpm dev` 或手动 `pnpm build` 让产物真的重生成）；Node 半不在热重载链路内，改完要重启 `dsh web`。
- **出站代理**：DSH 的 Node 进程走 undici，**不读系统代理**；只有代理能到的站点必须配 `proxyUrl`，否则表现为「浏览器能开、插件打不开」。
- **运行时数据不在仓库**：书源 / 书架 / 缓存 / 本地书住 `~/.dsh/novel/`（`dataDir` 可改）。
