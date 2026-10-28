# dsh-novel — 给 agent 的工作须知

DeepSeek Harness（DSH）的「小说」插件：导入 legado 书源 → 聚合搜索 → 书架 → 连续滚动阅读，并给 AI 助手六个小说工具（名字全部锁 `dshnovel_` 前缀——宿主对工具重名直接抛错，插件专属前缀是与生态的硬边界，名字集合由 `tests/tools/tools.test.ts` 钉住）。双半产物：Node 半（Cordis 插件 + `/novel-api`，`src/{engine,services,api,tools}` + `src/config.ts` 配置缝）与浏览器半（左侧栏「小说」**全局面板**：书架 / 书城 / 书源管理三 tab，`src/client`）。

## 先读哪份

| 你要回答的问题 | 读 |
| --- | --- |
| 用户怎么装、怎么用、数据在哪 | `README.md` |
| 这个词在本仓指什么 | `CONTEXT.md` |
| 系统分成哪几块、某条语义归谁 | `docs/architecture.md`（§4 是唯一主人清单） |
| 界面现在长什么样、有哪些状态与层级 | `docs/ui-spec.md` |
| 怎么构建、怎么验、怎么发版、有哪些环境坑 | `docs/development.md` |
| 怎么提交、PR、发版边界 | `CONTRIBUTING.md` |
| 每个版本改了什么、升级注意 | `CHANGELOG.md` |
| 当初为什么这么定、否掉了什么 | `docs/adr/`（索引 `docs/adr/README.md`；规范 `docs/adr/ADR-FORMAT.md`） |
| 文档该放哪、什么时候更新/归档 | `docs/AGENTS.md` |
| issue / 标签 / 领域文档约定 | `docs/agents/*` |

**一条事实只住一个家**：动手前先在 `docs/architecture.md` §4 找到主人；同一判据不要在第二处再写一遍。代码与测试是最终真相；文档与代码冲突时，改文档。文档分层、放置与生命周期见 `docs/AGENTS.md`；进行中的计划住 GitHub Issues 或本机 `.superpowers/`，不入库。根 `AGENTS.md` 预算 ≤ 8,000 字符。

## 必须过的门

1. **`pnpm test` 与 `pnpm typecheck` 同批跑**：tests 在 tsconfig 内而 vitest 不查类型，props 缝加宽而某个测试文件没跟上，只有 tsc 抓得住。`pnpm test` 全绿只证明引擎 / 服务 / 契约 / 前端逻辑：**不证明**任何真实站点可用性，也不证明安装链路。
2. **`pnpm lint`**：把界面那一头**未豁免**的 react-hooks 依赖数组（`src/client` 里仍在的 `eslint-disable` 是存量豁免清单，不在本门覆盖内）；仓内方向与值环由 `tests/layering.test.ts` 随 `pnpm test` 把，不额外要一条命令。
3. **真链路门控**：改动抓取 / 规则引擎 / 打包链路，或改相关性判据 / 按书归并时，按 `docs/development.md` 的「门（自动）」跑对应那条，并把结论**如实**写进汇报。注意分工：`DSH_REPROBE` 只验**搜索面**，`verified` 不证明正文可读；正文口径是 `DSH_CONTENT_AUDIT`，它是**审计报告**、不设通过率断言（分桶读数要人判）；`DSH_SEARCH_FILTER_AUDIT` 也是**报告**，唯一断言只是判据自洽（分档不丢条）；`DSH_EPUB_BROWSER` 只在本机浏览器里量渲染与几何，不起服务也不访问站点。
4. **legado 兼容四门**（`pnpm test` 默认跑，运行时不依赖任何外部 checkout）：`status-evidence` 逐行验证据可回查——`implemented` 的实现符号在剥注释后的代码里、钉子用例在测试里，`not-applicable` 必须写明裁决理由，`open` 必须带复核戳，任何 `N 源` 形态的现量读数都要有日期锚（最危险的不是「还没做」，是旧批读数被当现状用）；`inventory-coverage` 要求每个能力单元各挂 ≥2 条真实矩阵行；`upstream-fields` 与 `host-methods` 的分母是仓内快照 `compat/upstream/snapshot.json`。快照由开发阶段的 `DSH_CAPTURE_UPSTREAM=1`（需 `DSH_LEGADO_REF` 指路）抽一次；**快照不在场即红，不要改成 skip-if-missing**——「静默转 skip、无一物变红」是这扇门专门删掉的旧失效模式。
5. **取门的退出码，别看管道说了什么**：跑门与提交必须是两条命令；完整口径见 `docs/development.md`。
6. **跑 `pnpm test` 前确认依赖装全**：缺 `jsdom` / `@testing-library/react` 会让前端测试文件假红（报 `Cannot find module`）。

## 硬约束

- **wire 单点**：路由名、值形状与写路由的 body 形状（构造器 + 读口）只住 `src/shared/wire.ts`，Node 半与浏览器半消费同一份（`src/client/views/types.ts` 只是再导出桶）。
- **书目字段集**：加 / 改书架元数据字段 = 改 `shared/wire.ts` 的 `SHELF_META` + `pickShelfMeta`；工具面投影的覆盖由 `tools/shelf-item.ts` 的编译期断言逼你选投影或排除，别在各处写逐字段 `typeof` 筛键的抄本。
- **宁炸不猜**：认不出的规则语法在**解析期**抛 `UnsupportedRuleError`，带段级定位；空结果冒充失败是本仓定的最高罪。判「不适用」而不写理由，等于把裁决写成遗忘：理由写进矩阵那一行的 `note`。
- **取值规约**：取位失败 → Miss、解析到空集合 → 空 List，两种值绝不折叠；唯一实现 `src/engine/select.ts` 的 `reducePicked`。
- **纯度门**：`src/client/**` 的运行时 import 只能来自平台模块表；`src/shared/wire.ts` 保持零运行时依赖（它被 inline 进 client bundle）。构建成败由 `tsdown.config.ts` 的 `dsh-novel-bundle-purity` 把住，改平台模块表要对着宿主发布物重读，别凭记忆。
- **兼容性事实单源**：宿主兼容窗口与真机名单的事实源是 `package.json`；README 与徽章是投影，文档门校验。
- **客户端文案单点**：`src/client/**` 的可见文案（中文原文与英文译文；单位、格式名、错误码、装饰字形与插件卡片元信息除外）只住 `src/client/copy/**`，组件经 `useCopy()`、非 React 函数经 `Translate` 参数取词；宿主 locale 服务可选读（`ctx.get('locale')`），缺席回退中文。机器面是 `tests/client/copy-guard.test.ts`，白名单只许收不上屏的数据/注释，或与语言无关的装饰字形、模板，且每条带理由。

## 实现前先验

- 宿主公开面以 `tsdown.config.ts` 的 `PLATFORM_MODULES` 与宿主发布物为准；不要从历史日志或旧 ADR 的路径抄平台模块名。
- 改动前先看 `docs/adr/` 有没有相关裁决；翻案按 `docs/adr/ADR-FORMAT.md` 落字，别在正文里层层打补丁。
- 命名新概念前先查 `CONTEXT.md`：自造同义词会让同一概念长出第二份抄本。

## 环境坑

- **`lib/` 是构建产物且不入库**：先 `pnpm build`，否则整个插件树拒绝挂载（`plugin tree failed to load` + `ERR_MODULE_NOT_FOUND`）。
- **改动生效路径分两半**：浏览器半由宿主 HMR 热推，Node 半必须重启宿主。
- **出站代理**：DSH 的 Node 进程走 undici，**不读系统代理**；只有代理能到的站点必须配 `proxyUrl`，否则表现为「浏览器能开、插件打不开」。
- **运行时数据不在仓库**：书源 / 书架 / 缓存 / 本地书住 `$DSH_HOME/novel/`（缺省 `~/.dsh/novel/`；`dataDir` 可改）。
- **`compat/report.md` 是跑门产物**：`pnpm test:compat` 每次覆盖写，已 gitignore；它的分母是 `compat/fixtures/` 下的 fixture，**不是站点可用率**。

## Agent skills

### Issue tracker

工单住在本仓的 GitHub Issues（用 `gh` CLI）。见 `docs/agents/issue-tracker.md`。

### Triage labels

五角色用默认标签串：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文（仓根一份 `CONTEXT.md` + `docs/adr/`）。见 `docs/agents/domain.md`。
