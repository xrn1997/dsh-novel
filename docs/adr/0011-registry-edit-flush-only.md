# 注册表的变更口只有 `edit` / `flush`：变更与落盘收成一个配方

Status: accepted

`SourceRegistry` 的变更口只有 `edit(recipe)` / `flush()`；`list()` / `get()` / `toPublic()` 是读取面（`list` / `get` 返回活体引用，调用方约定只读，`SourceIntake` 的地址索引依赖这一份）。不设裸 mutator 与公开 `persist()`：变更与落盘靠调用点手工配对时，顺序约束只活在注释里，谁忘一次就是一次静默丢数据。recipe 同步执行，一次 `edit` 内的多步变更对外不可分割；落盘机制（防抖 / 阈值计数 / 失败账）住 `createDebouncedWriter`（阈值触发的那次 `edit` 等写落地），阈值 `PERSIST_EVERY` 住注册表、窗口 `PERSIST_WINDOW_MS` 住 writer；阈值计数跨定时器/flush 累计，只有阈值触发才复位。写失败经阈值触发的 `edit` 或 `flush` 如实抛出；recipe 自己已抛错时，注册表把写失败记进 writer 的失败账，由下一次 `flush` 抛（`retainWriteFailure` 是显式移交口，不自动记两份）。存量收敛走同一条 flush：迁移后的落盘失败会让 `load` 失败。两条纪律：存量迁移只有 `load()` 一个触发点，逐字段机械与覆盖策略住 `rehydrateStoredSource`（自带容器优先级的字段只能只填缺席的键）；注册表与书架共用同一条防抖写口径，不开第二套落盘路径。

锚点：`src/services/sources.ts`（`SourceEdit` / `PERSIST_EVERY` / `load` / `retainWriteFailure`）；`src/services/normalize.ts` 的 `rehydrateStoredSource`；`src/services/storage.ts` 的 `createDebouncedWriter` / `PERSIST_WINDOW_MS`（失败账 `retainFailure`）与 `src/services/shelf.ts`；`tests/services/sources.test.ts`。
