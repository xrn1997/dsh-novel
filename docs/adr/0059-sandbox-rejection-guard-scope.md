# 进程级未处理 rejection 防线只收沙箱 realm 的 promise，非沙箱来源交回宿主

Status: accepted

legado 脚本会自建 fire-and-forget 的异步工作，其 rejection 在 `evalJs` 返回之后才悬空触发；Node 15+ 把未处理 rejection 当致命错误，所以本仓在加载期挂一条进程级 `unhandledRejection` 监听器接住它们。但监听器是**进程级**的：它同样接住了宿主与别的插件的 rejection，并一律标成「沙箱脚本产生」——等于替整个宿主让掉了致命语义，还把别人的真 bug 记成脚本噪声。决定：沙箱引导脚本在 vm realm 的 `Promise.prototype` 打一个 realm 标（`SANDBOX_REALM_MARK`），防线只拦截**带标**的 promise；非沙箱来源如实记 error，并在「唯一监听者是我们 + 宿主没有自选 `--unhandled-rejections` 策略」时用 `process.nextTick` 恢复 Node 的默认致命语义。插件自己的引擎错误类先于来源判定：reason 命中 `isEngineError` / `RegexDeadlineError` 时按插件内部错误记 error、不致命化——来源标判的是噪声归属，不是 bug 归属。订阅按 sink 计数，最后一份释放才摘监听器；console 兜底只在没有真 sink 时顶替，真 sink 到场就让它退场——两份都收会让同一条 rejection 在 stderr 上出现两遍，而兜底那份订阅没有释放点（每次跑脚本都会 acquire），会熬过插件卸载、把监听器与致命语义一起留在进程里。

**为什么按 promise 认，不按 reason 认**：脚本能 reject 任何值（数字、字符串、宿主错误对象），reason 上没有可靠的来源信息；`unhandledRejection` 的第二个参数就是 promise 本体，realm 标是唯一站得住的归属证据。标打在 `Promise.prototype` 而不是构造器上，是因为 async 函数创建的是 intrinsic `%Promise%`——给全局构造器打标会漏掉大多数悬空链。唯一的 reason 例外是插件自己的引擎错误类：它们的实例只由本仓代码创建（桥接给脚本的是 realm 里新建的 Error），先于来源判定按内部错误记 error；即便脚本经某条桥拿到同一个对象再 reject，代价也只是日志升到 error 档，不会改变致命语义。

**边界**：worker 路径（含 `java.ajax` 同步桥脚本）在独立 isolate 里跑，它的 rejection 不会到达主线程这条监听器，realm 标在那里也不被消费——worker 的失败由 worker 自己的错误通道交回。非沙箱来源里，插件自己的错误类不走致命化（见上）；其余非沙箱来源才恢复致命。这条防线不是通用错误钩子，不接管宿主或别的插件的错误处置；engine 仍不 import services，sink 由组合根注入。

**被否方案**：

- **维持「接住全部、一律按沙箱噪声记」**：掩盖别的插件的真 bug，且读数说谎——「宁炸不猜」在进程级被反过来执行。
- **不挂防线**：一条 fire-and-forget 的源就能把宿主进程带走（导入书源时逐源跑脚本会命中）。
- **「只跑脚本期间挂、finally 摘」**：rejection 在返回之后才到，摘了照样漏。
- **只按 reason 是否引擎错误类分档**：覆盖不了脚本 reject 的任意值；realm 标仍是来源判定的主判据，引擎错误类只是先于它的一个插件内部例外。

**代价**：宿主侧未处理 rejection 会恢复致命（与没装本插件时一致）——这正是意图：这个决定不该由插件替宿主做。插件自己的引擎错误类例外：它们只记 error、不致命化，代价是「自己的 bug」与「外来的错误」被分成两档处置。宿主若显式以 `--unhandled-rejections` 选 `warn` / `none` 启动（等号与空格两种写法都算），防线尊重它、只留日志；argv 里的显式模式优先于 `NODE_OPTIONS`。`strict` 由 Node 自己崩（监听器不会被调用，也不该指望这条防线出声）。

锚点：`src/engine/js-sandbox.ts` 的 `SANDBOX_REALM_MARK` / `ensureUnhandledGuard` / `restoreDefault` / `BOOTSTRAP`；组合根 `src/index.ts` 的 guard effect；钉子 `tests/engine/unhandled-guard.test.ts`（含真实沙箱悬空 rejection 的集成用例）；`ADR-0004`（沙箱边界）；`ADR-0034`（日志两条腿与 sink 注入）。
