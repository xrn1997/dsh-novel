# 注册表只暴露 `edit` / `flush`：「改了忘落盘」在接口上不可表达

`SourceRegistry` 对外只有 `edit(recipe)` / `flush()` / `list()` / `get()` / `toPublic()`——原先那 7 个公开 mutator 与公开 `persist()` 全删。动机是曾有九处调用点手工配对「mutator + persist」（顺序约束只活在注释里），谁忘了 persist 就是静默丢数据。现在 recipe 同步执行、一次 `edit` 内的多步变更对外不可分割，落盘策略住模块内部（累计达阈的那次 `edit` 等写落地，否则尾沿防抖后台合并），调用方不知道粒度存在——节流常量也从任务运行器搬进了注册表。

同族的两条纪律：
- **存量迁移只有一条读路**：九条幂等迁移全在 `load()` 里；接新规则字段做存量收敛走 `normalize` 的 `deriveRuleField`（直接跑导入侧那份展平），不许再写第二个自己解释 raw 的函数——第二条读路必然与导入侧的容器/优先级口径分叉，恒覆盖会把正确值改写成交不出来看的 `null`。自带容器优先级的字段是例外：只能只填缺席的键。
- 书架侧共用同一条防抖写口径（`createDebouncedWriter`），不给它开第二套落盘路径。

锚点：`src/services/sources.ts`（`SourceEdit` / `PERSIST_EVERY` / `load`）；`src/services/normalize.ts` 的 `deriveRuleField`；`src/services/shelf.ts`；`tests/services/sources.test.ts`。
