# 注册表的变更口只有 `edit` / `flush`：变更与落盘收成一个配方

Status: accepted

`SourceRegistry` 的变更口只有 `edit(recipe)` / `flush()`（`list()` / `get()` / `toPublic()` 是读取面，不提供变更方法；`list` / `get` 返回活体引用，调用方约定只读——`SourceIntake` 的地址索引依赖这一份，直接改字段不会落盘，这是接口的已知边界；另有一个不碰源形状的 `retainWriteFailure(error)`，只把调用方接住的写失败移交给收尾 `flush`）——原先那 7 个公开 mutator 与公开 `persist()` 全删。动机是曾有九处调用点手工配对「mutator + persist」（顺序约束只活在注释里），谁忘了 persist 就是静默丢数据。现在 recipe 同步执行、一次 `edit` 内的多步变更对外不可分割，落盘机制（防抖 / 阈值计数 / 失败账）住 `createDebouncedWriter`（累计达阈的那次 `edit` 等写落地，否则尾沿防抖后台合并），阈值与窗口的取值仍住注册表（`PERSIST_EVERY` / `PERSIST_WINDOW_MS`），调用方不知道粒度存在——节流常量也从任务运行器搬进了注册表。阈值计数跨定时器/flush 写累计，只有阈值触发才复位——`flush` 不重置计数，否则频繁 flush 会让「累计 N 次」的阈值永不触发。落盘失败经阈值触发的 `edit` 或 `flush` 如实抛出，不再静默吞（ADR-0013）。`recipe` 自己已在抛错时，阈值写失败不能覆盖它：注册表把失败记进 writer 的失败账，由下一次 `flush` 如实抛（同一文件下一次写成功即清账）。`recipe` 成功时，写失败直接抛给 `edit` 调用方；调用方若接住后仍要让收尾 `flush` 看见，用 `retainWriteFailure(error)` 显式移交——不自动记两份，避免同一个错重复报给无关的收尾。存量收敛走同一条 flush：迁移后的落盘失败会让 `load` 失败，不再带着只在内存里的收敛继续跑。批量任务里写失败的归属（不冒充站点判据）见 `ADR-0017`。

同族的两条纪律：
- **存量迁移只有一条读路**：触发点只有 `load()`；逐字段机械与覆盖策略住 `normalize.rehydrateStoredSource`（直接跑导入侧那份展平），不许再写第二个自己解释 raw 的函数——第二条读路必然与导入侧的容器/优先级口径分叉，恒覆盖会把正确值改写成交不出来看的 `null`。自带容器优先级的字段是例外：只能只填缺席的键。
- 注册表与书架共用同一条防抖写口径（`createDebouncedWriter`），不给任何一方开第二套落盘路径。

锚点：`src/services/sources.ts`（`SourceEdit` / `PERSIST_EVERY` / `load` / `retainWriteFailure`）；`src/services/normalize.ts` 的 `rehydrateStoredSource`；`src/services/storage.ts` 的 `createDebouncedWriter`（失败账 `retainFailure`）与 `src/services/shelf.ts`（共用的那一方）；`tests/services/sources.test.ts`。
