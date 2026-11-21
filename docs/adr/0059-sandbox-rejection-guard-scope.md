# 进程级未处理 rejection 防线只收沙箱 realm 的 promise，非沙箱来源交回宿主

Status: accepted

legado 脚本会自建 fire-and-forget 的异步工作，其 rejection 在 `evalJs` 返回之后才悬空触发；Node 15+ 把未处理 rejection 当致命错误，所以本仓在加载期挂一条进程级 `unhandledRejection` 监听器。但监听器是进程级的，它同样会接住宿主与别的插件的 rejection——等于替整个宿主让掉致命语义。决定：沙箱引导脚本在 vm realm 的 `Promise.prototype` 打一个 realm 标（`SANDBOX_REALM_MARK`），防线只拦截**带标**的 promise；非沙箱来源如实记 error，并在「唯一监听者是我们 + 宿主没有自选 `--unhandled-rejections` 策略」时用 `process.nextTick` 恢复 Node 的默认致命语义。插件自己的引擎错误类先于来源判定：reason 命中 `isEngineError` / `RegexDeadlineError` 时按内部错误记 error、不致命化。订阅按 sink 计数，最后一份释放才摘监听器；console 兜底只在没有真 sink 时顶替，真 sink 到场就退场（两份都收会在 stderr 出现两遍）。为什么按 promise 认不按 reason 认：脚本能 reject 任何值，reason 上没有可靠的来源信息；标打在 `Promise.prototype` 而不是构造器上，是因为 async 函数创建的是 intrinsic `%Promise%`。边界：worker 路径的 rejection 不经过这条监听器；engine 仍不 import services，sink 由组合根注入。被否决：接住全部一律按沙箱噪声记；不挂防线；只跑脚本期间挂 finally 摘；只按 reason 判。代价：宿主侧未处理 rejection 会恢复致命（与没装本插件时一致）；宿主显式选 `warn` / `none` 时防线尊重它、只留日志。

锚点：`src/engine/rejection-guard.ts` 的 `SANDBOX_REALM_MARK` / `acquireRejectionGuard` / `hostWantsFatalRejections`；`src/engine/js-sandbox.ts` 的 `BOOTSTRAP` 与求值入口的一次 acquire；`src/index.ts` 的 guard effect；`tests/engine/unhandled-guard.test.ts`；`ADR-0004`、`ADR-0034`。
