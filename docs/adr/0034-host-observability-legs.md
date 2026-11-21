# 宿主可观测面的两条腿：日志 console + ctx.logger，任务过程行走 output 拉源

Status: accepted

**日志**：Node 半的留痕出口收成 `services/log.ts` 一处，组合根装 **console + 宿主 `ctx.logger` 双腿**。console 腿保本机 stdout；logger 腿把同一条消息送进宿主 ring buffer。宿主日志面缺省只放行 error/info，warn 仍走 console，启动类信息走 info；尾随 `Error` 只在 logger 腿成形成文本（宿主对对象参数按 JSON 格式化，未成形的 Error 会塌成 `{}`），console 腿直传原样参数以保住 stderr 栈形。组合根 dispose 时把模块级 sink 复位回 console。engine 的 unhandledRejection 防线不 import services（依赖方向红线），缺省 sink 自持前缀；来源识别与致命语义见 `ADR-0059`。**任务过程行**：宿主 `ctx.jobs` 的输出是**拉**——`JobSpec.output` 是拉源数组，注册表按自己持有的**字节游标**调 `read(fromByte)`，终态前再排空一次；hooks 面只有 `{ cancel, done }`，没有 append/log/write。本仓用 `JobTail` 交**有界、偏移可读**的过程行：按字节帽从头丢并如实报数，`readFrom(from)` 只交那一段（每个读者各持游标）。过程行只回答「这一轮跑到哪」；整轮结果与业务明细仍住各持有者的快照读面。

被否决：只走宿主 logger（warn/debug 被宿主缺省阈值吞掉，级别语义被交给宿主配置）；只走 console（宿主日志面一条收不到）；过程行 append 进任务面板（`JobHooks` 只有 `{ cancel, done }`，按宿主发布的活契约接线，不按转述文档接线）；整轮结果塞 `job_output`（输出面是有界过程通道，不是快照读面）；JobTail 对单行严格截断（单行超帽丢的是最新进度——帽是**保留缓冲**的帽，最终截断归宿主 `job_output`）。

**代价**：宿主日志面会出现 logger name 与消息前缀双标识，warn 默认不进宿主 ring buffer；`outputLimitBytes` 不是单次读取的严格上界（单行超帽保留、丢弃横幅不计，游标落在行中间时从行首重发一小段）；分类续页共享同一轮尾缓冲，读者越多重复读的字节越多；过程行永远不是业务真相——以上均不改变 `ADR-0018` 的结果归属。

锚点：`src/services/log.ts` 的 `log` / `setLogSink`；`src/index.ts` 的双腿 adapter 与 sink 复位；`src/services/job-tail.ts` 的 `JobTail` / `readFrom` / `DEFAULT_JOB_OUTPUT_BYTES`；`src/services/job-holder.ts` 的 `JobHostSpec` / `JobOutputSource`；`src/services/import-job.ts` / `search-job.ts` / `explore-job.ts`；`tests/index.test.ts`、`tests/services/job-tail.test.ts`、`tests/services/job-holder.test.ts`、`tests/engine/unhandled-guard.test.ts`；`ADR-0020`（`ctx.jobs` 的本地窄镜像）。
