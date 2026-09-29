# `java.ajax` 只有一种语义：同步返回 body；主线程撞不了就用 worker 透明重跑

legado 的宿主桥是同步的，而 Node 的 fetch 不是。书源脚本的主导写法是 `java.ajax(u).match(...)[1]`——**语义绝不能随拼写变**：曾经 `typeof java.ajax("…")` 给 `"string"`（走 worker）、`typeof java["ajax"]("…")` 给 `"object"`（主线程拿到 Promise），作者改成下标写法就静默换语义。

决定：主线程分支不返回 Promise，而是在发起宿主调用**之前**抛哨兵 `__dsh_sync_ajax_required__`；`evalJs` 最外层捕获后丢掉已收集的 logs，换 `syncAjax` 初始化在 worker 里重跑同一段。正则 `SYNC_WORKER_RE` 只是路由启发（刻意过近似），**只决定性能与稳健性，不决定语义**。哨兵在宿主调用之前抛 ⇒ 重跑不多打站点（钉子按 fetch 计数自证）。

同一族的第二条纪律：**两条求值路必须同口径**，且不许养第二份抄本。worker 源码是字符串常量，BOOTSTRAP / `wrapped` / jsLib 经 `workerData` 交付（`lib/` 是构建产物，安装链路给不出可解析的独立 worker 文件路径）；唯一无法跨 realm 共用的是脚本形态判别函数，worker 里留一份文本抄本，一致性由跨路钉子守。js 段「最后一个表达式即结果」的回落判别只在**编译期**（`new vm.Script`）做——按运行时异常类名判会把 `JSON.parse` 的运行时 SyntaxError 误当顶层 return 而静默回落，还会把脚本跑两遍。

被否决的方案：① 一律走 worker（每个 worker 各自分配共享内存，得先做 worker 池才谈得上，那是另一个项目）；② 加宽正则去猜动态别名（不可判定，等于继续把语义押在拼写上）；③ 让脚本自己 `await`（改不动既有源）；④ 影子会话 + 写回（为零发生场景引入活动部件）；⑤ 一律用函数体形态跑（书源主导写法不写 `return`，恒 undefined 会整批静默取空）。

**接受的残余**：脚本里不含那三个字面量的间接形态（解构 `const {ajax} = java`、`with (java)`）仍可能撞哨兵，后果是第一次 ajax 之前的非幂等写入被执行两遍；网络请求不受影响。将来的正确修法是先做 worker 池再一律走 worker，把重跑整条路删掉。

锚点：`src/engine/js-sandbox.ts` 的 `SYNC_AJAX_SENTINEL` / `SYNC_WORKER_RE` / `needsSyncBridge` / `WORKER_SRC` / `runAsScript`；`tests/engine/js-bindings.test.ts`；矩阵行 `h-java-ajax-sync`、`a-js-script-form`、`h-rhino-vs-vm`。
