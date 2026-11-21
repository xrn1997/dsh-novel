# 用户正则的求值走 vm 死线：宁可废掉一条规则，不许钉住主线程

Status: accepted

书源规则里的正则是用户写的；一条合法、能编译、却病态的模式（嵌套量词遇上不匹配的长输入）在主线程上是指数级回溯，而插件与宿主同进程。本仓把**所有**过用户正则的求值收进 `engine/regex-guard.ts`：在 `node:vm` 的上下文里跑，用 vm 脚本执行的超时兜底——超时即抛 `RegexDeadlineError`，不赌回溯的形状与深度。决定：① **死线随工作量放宽**（基础预算 + 随文本量追加档，封顶）——写死一个数会把「大而合法」的整页扫描判成病态；算式只有 `deadlineFor` 一处，具体预算住实现。② **批量口径一趟一次 vm 往返，批内每条独立**：脚本每次 `test` 前把 `lastIndex` 归零，成功交回时恢复调用前的值；条目属性值在宿主侧取齐再交给脚本。③ **炸掉的那趟把 `lastIndex` 归零**（超时留下的半截游标会让下一次读出错值）。④ **超时不是空结果**：引擎侧转成带段级定位的 `RuleEvalError`，服务侧转成「这条规则不可用 + 留痕」；`RegexDeadlineError` 自己不带定位，也不是 `EngineError` 子类。被否决：静态黑名单 / 嵌套量词启发式；丢进 worker 线程（引擎求值语义是同步的）；只给 `js` 面加超时。**代价**：每趟多一次 vm 脚本执行；返回值跨 realm（`instanceof Array` 不成立，`Array.isArray` 成立），消费点不许用 realm 相关判据。

锚点：`src/engine/regex-guard.ts` 的 `deadlineFor` 与五条 `vm.Script`；`src/engine/errors.ts` 的 `RegexDeadlineError`；消费点 `src/engine/allinone.ts` / `src/engine/css.ts` / `src/engine/replace.ts` / `src/services/search-face.ts` 的 `startsDetail`；`tests/engine/regex-guard.test.ts`；`docs/development.md` 的「真链路门控」。
