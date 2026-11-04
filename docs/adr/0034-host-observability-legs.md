# 宿主可观测面的两条腿：日志 console + ctx.logger，任务过程行走 output 拉源

Status: accepted

**日志**：Node 半的留痕出口收成 `services/log.ts` 一处，组合根装 **console + 宿主 `ctx.logger` 双腿**。console 腿保本机 stdout 可见性；logger 腿把同一条消息送进宿主 ring buffer。宿主日志面按级别阈值过滤，缺省只放行 error/info，warn/debug 默认被滤掉——所以 warn 仍走 console，启动类信息走 info 才进得了宿主面。尾随 `Error` 只在 logger 腿成形成文本（宿主侧对对象参数按 JSON 格式化，未成形的 Error 会塌成 `{}`）；console 腿直传原样参数以保住 stderr 栈形。组合根 dispose 时把模块级 sink 复位回 console，避免卸载后晚到的留痕指向旧 ctx。engine 的 unhandledRejection 防线不 import services（依赖方向红线），缺省 sink 自持前缀；组合根在第一次跑脚本前把日志缝注入。防线的**来源识别、订阅计数与致命语义恢复**归 `ADR-0059`。

**任务过程行**：宿主 `ctx.jobs` 的输出是**拉**——`JobSpec.output` 是拉源数组，注册表按自己持有的**字节游标**调 `read(fromByte)`，终态前再排空一次；hooks 面只有 `{ cancel, done }`，没有 `readOutput`，也没有 append/log/write。本仓用 `JobTail` 交**有界、偏移可读**的过程行：按字节帽从头丢并如实报数，`readFrom(from)` 只交那一段（不是消费式：每个读者各持游标，谁也不吃谁的内容）。整轮结果、业务计数与明细仍住各持有者的快照读面（`ADR-0018`），过程行只回答「这一轮跑到哪」。搜索行把**源状态**与**结果条数**分成两轴，条数用 cap 后实际进快照的数并附截断前原始数；书城行同样标明源状态；导入的文件级解析失败与批量验证预筛掉的无效 id 也各留一行。分类续页复用同一轮的尾缓冲：两个读者各持游标，早页那份登记读到的是共享缓冲里它还没读过的行（含后页），互不扰动。

被否决的做法：

- **只走宿主 logger**：warn/debug 被宿主缺省阈值吞掉，stdout 也变暗；逼每个留痕点改写级别去迁就 exporter 阈值，等于把级别语义交给宿主配置。
- **只走 console**：宿主日志面（ring buffer / 启动诊断）一条都收不到，与宿主可观测面对齐的打算落空。
- **把过程行 append 进任务面板**：`JobHooks` 只有 `{ cancel, done }`（`run(job)` 的句柄上才有 `append`/`updateProgress`），任务面板只渲 kind/label/status/detail/elapsed；本仓按宿主发布的活契约接线，不按转述文档接线。
- **把整轮结果塞进 `job_output`**：输出面是有界的过程通道，不是快照读面；几百源规模的结果仍归各持有者的游标/全量快照。
- **让 JobTail 对单行也做严格截断**：单行超帽时丢它等于丢最新进度；帽定位为**保留缓冲**的帽，最终截断归宿主 `job_output`。

**代价**：宿主日志面会出现 logger name 与消息前缀双标识；warn 默认不进宿主 ring buffer；`outputLimitBytes` 不是单次读取的严格上界（单行超帽保留、丢弃横幅不计；游标落在行中间时从行首重发一小段）；分类续页的共享缓冲让每个读者都能看到整段保留窗口（按各自游标），读者越多重复读的字节越多；过程行永远不是业务真相。以上都是可观测面的取舍，不改变 `ADR-0018` 的结果归属。

锚点：`src/services/log.ts` 的 `log` / `setLogSink`；组合根 `src/index.ts` 的双腿 adapter 与 sink 复位；`src/services/job-tail.ts` 的 `JobTail` / `readFrom` / `DEFAULT_JOB_OUTPUT_BYTES`；`src/services/job-holder.ts` 的 `JobHostSpec` / `JobOutputSource`（三个持有者只挂点、不各抄一份）；三类持有者 `src/services/import-job.ts` / `search-job.ts` / `explore-job.ts`；钉子 `tests/index.test.ts`、`tests/services/job-tail.test.ts`、`tests/services/job-holder.test.ts`、`tests/services/{import,search,explore}-job.test.ts`、`tests/support/job-host.ts`、`tests/engine/unhandled-guard.test.ts`。宿主自报的 `outputLimitBytes` 跟实际接手的 `JobTail.maxBytes` 走，不另报缺省。`ctx.jobs` 的形状以 `job-holder.ts` 的本地窄镜像为准（不引宿主类型包，判据见 `ADR-0020`）。
