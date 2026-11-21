# 在途工作归服务端：写任务一槽、搜索另开一槽；停止不是失败；进度以带游标的快照为真相

Status: accepted

**分槽**：`SourceJobs` 只有一个写任务槽（导入 / 批量验证，运行中再提交 → `JobRunningError` → 409）；聚合搜索是**读**，由 `SearchJobs` 另持一槽——让搜索挡住一次导入等于惩罚探索动作。代价：宿主侧可同时存在两条 novel 任务，UI 的「任何任务在途即禁用」只管写任务。**分工**：宿主 `ctx.jobs` 管身份与生命周期，本仓持有者管业务计数、失败分桶与**整轮结果 + 游标**；过程行是有界尾缓冲、经 `JobSpec.output` 拉源接进 `job_output`（形状与偏移读归 `ADR-0034`）。**停止不是失败也不是放弃**：停止 = 不再往下搜，已搜出的命中一律留在页面上；服务端把本轮立即结算成终态；`cancelled` 走契约字段而不是比对中文。退出页面不是停止；再搜是替换本轮的新一轮。被否决：以错误呈现停止；给 wire 的 `phase` 加 `killed` 态；打断在途请求；任务态持久化。**进度通道**：地基是带游标的显式快照查询（`{added, next}`），SSE 帧体就是同一份快照、两通道共用一个游标；刻意不用 `EventSource`（它把游标交给浏览器），不走 Session 事件 + projection。**任务刻意不传 `owner`**：任务由浏览器 HTTP 请求触发，手里没有 live agent 实例；`owner` 的官方语义是「拥有者是活 agent，其析构会 cancel 该任务」，硬凑一个 agent 等于把「切走界面就完蛋」请回来。准入闸是「没有已挂载 controller 服务该 owner 就拒绝 start」，官方出路正是从非 scoped 上下文自挂 controller；本仓拿的是身份、生命周期与随服务卸载而终止，不是呈现。

锚点：`src/services/import-job.ts`（`JobRunningError` / `cancelledOut` / `settle`）；`src/services/job-holder.ts`（`JobHostSpec` / `JobHost` / `HostTie` / `ChangeSignal`）；`src/services/search-job.ts`；`src/client/search-job.ts`；`src/client/api.ts` 的 `apiEventStream`；`src/index.ts` 的 `attachController`；`tests/client/search-job-round-identity.test.tsx`、`tests/services/search-job.test.ts`、`tests/services/job-holder.test.ts`。
