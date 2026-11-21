# `java.ajax` 只有一种语义：同步返回 body；主线程撞不了就用 worker 透明重跑

Status: accepted

书源脚本按**同步**语义写，主导写法是 `java.ajax(u).match(...)[1]`——语义绝不能随拼写变（曾 `typeof java.ajax("…")` 走 worker、`typeof java["ajax"]("…")` 在主线程拿到 Promise）。决定：主线程分支不返回 Promise，而是在发起宿主调用**之前**抛哨兵 `__dsh_sync_ajax_required__`；`evalJs` 最外层捕获后丢掉已收集的 logs，换 `syncAjax` 初始化在 worker 里重跑同一段。正则 `SYNC_WORKER_RE` 只是路由启发，**只决定性能与稳健性，不决定语义**；哨兵在宿主调用之前抛，重跑不多打站点。同一族的第二条纪律：两条求值路必须同口径——worker 源码是字符串常量，BOOTSTRAP / `wrapped` / jsLib 经 `workerData` 交付，求值序列两路共用同一函数，路由谓词由协议表派生；js 段「最后一个表达式即结果」的回落判别只在**编译期**做。被否决：一律走 worker（需先做 worker 池）、加宽正则猜动态别名、让脚本自己 `await`、影子会话 + 写回、一律用函数体形态跑。接受的残余：解构 `const {ajax} = java` / `with (java)` 仍可能撞哨兵，第一次 ajax 之前的非幂等写入会执行两遍；网络请求不受影响。

锚点：`src/engine/js-protocol.ts` 的 `SYNC_AJAX_SENTINEL` 与 `SYNC_WORKER_RE`（桥壳由 `asyncBridgeSource` 生成）；`src/engine/js-sandbox.ts` 的 `needsSyncBridge` / `runInContextVm` / `WORKER_SRC` 与 BOOTSTRAP 拼装；`tests/engine/js-bindings.test.ts`；`tests/engine/js-protocol.test.ts` 的 async 行闸；矩阵行 `h-java-ajax-sync`、`a-js-script-form`、`h-rhino-vs-vm`。
