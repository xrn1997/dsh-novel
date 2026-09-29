# 在途工作归服务端：写任务一槽、搜索另开一槽；停止不是失败；进度以带游标的快照为真相

**分槽**：`SourceJobs` 只有一个写任务槽（导入 / 批量验证，运行中再提交 → `JobRunningError` → 409）；聚合搜索是**读**，由 `SearchJobs` 另持一槽。让搜索挡住一次导入等于**惩罚探索动作**。代价如实：宿主侧可同时存在两条 novel 任务，UI 的「任何任务在途即禁用」判据只管写任务——这两条长得像 bug，是这条裁决的必然形状。

**分工**：宿主 `ctx.jobs` 管身份与生命周期（`<kind>-N`、终态、协作式取消、随服务卸载而终止）；本仓持有者管业务计数、失败分桶与**整轮结果 + 游标**——宿主只有 `label` 与一行 `detail`，装不下几百源规模的东西。

**停止不是失败也不是放弃**：停止 = 不再往下搜，已搜出的命中一律留在页面上；服务端把本轮立即结算成终态，读面分组一个不清。`cancelled` 走**契约字段**而不是去比对那句中文——刷新后重读同一轮要能分清「这是用户停的、不是搜挂了」，靠文案承载 UI 语义等于把判据寄在一条会变的字符串上。退出页面**不是**停止（本轮照跑完，保留期内可翻）；再搜是替换本轮的新一轮。被否决：以错误呈现停止；给 wire 的 `phase` 加 `killed` 态（对 UI 的判据两个终态无区别，加一态要动跨半契约与三处判据、收益为零）；打断在途请求（半路写回的源更脏）；任务态持久化（源已按批落盘、导入幂等可重跑，YAGNI）。

**进度通道**：地基是**带游标的显式快照查询**（`{added, next}`），SSE 帧体就是同一份快照、两通道共用一个游标，任一时刻只有一条通道在推进游标。理由：宿主口径写死「普通转发通知不会 replay，需要可靠恢复的 stateful domain 必须提供 baseline / cursor / 显式 query」——推送永远需要一条查询兜底，那就不如自己控制两条。**刻意不用 `EventSource`**：它自带重连与 `Last-Event-ID`，等于把游标交给浏览器，与本仓「游标握在客户端、两条通道同源」相反，还会逼出第二份合并代码。不走 Session 事件 + projection：常驻呈现位是 root 作用域、会话无关，而 projection 的读面按会话作用域走。

**任务刻意不传 `owner`**（这条此前在仓内只有实现、没有口径）：任务由浏览器的 HTTP 请求触发，手里没有 live agent 实例；`owner` 的官方语义是「拥有者是活 agent，其析构会 cancel 该任务」——硬凑一个 agent 当 owner 等于把「切走界面就完蛋」换个形式请回来。准入闸是「没有已挂载 controller 服务该 owner 就拒绝 start」，官方出路正是从非 scoped 上下文自挂 controller，我们拿的是**身份、生命周期、随服务卸载而终止**，不是呈现：宿主 job 面没有连续进度，百分比与「跳回现场」仍归本插件。

锚点：`src/services/import-job.ts`（`JobRunningError` / `JobHostSpec` / `cancelledOut` / `settle`）；`src/services/search-job.ts`（分槽、`shouldStop`、`subscribe` 只发信号）；`src/client/search-job.ts`；`src/client/api.ts` 的 `apiEventStream`；`src/index.ts` 的 `attachController`；`tests/client/search-job-round-identity.test.tsx`、`tests/services/search-job.test.ts`。
