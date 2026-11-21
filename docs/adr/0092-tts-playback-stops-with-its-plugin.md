# 听书播放层随插件卸载收口：常驻跨面板，不跨插件

Status: accepted

`ADR-0072` 把听书会话放进模块级常驻播放层，让阅读器子树卸载时声音不断。插件**自身**被卸载是另一条边界：宿主拆掉客户端 fiber、撤走槽位注册，再把模块图重新 import 成一份新的——旧模块里的播放单例与它正在放的 Audio 不会跟着消失。那一路声音没有控制面，还会继续合成、推进、按节拍写位置；宿主侧再点一次听书，新模块起播，两路叠在一起。故插件生命周期终点必须把播放层一并收口。

## 背景

客户端热替换与插件停用 / 升级都走同一条路：宿主销毁旧 fiber（`ctx.effect` 的清理逐个跑），再把模块图重新 import 成新的一份。模块级现场（播放会话、两只 Audio 槽、位置防抖）全部落在旧模块的闭包里；浏览器不会因为「模块没人 require 了」就停掉一个正在播放的 `Audio`。症状分两步显形：控制面先整块消失，耳朵里却还在念；再点「听书」，新模块从共用的消费位置起播，于是两重奏。

## 决定

- **插件卸载 = 播放层生命周期终点**：接线层（`src/client/index.tsx` 的 `apply`）注册一条 fiber 清理，调 `disposeTtsPlayer()` → `ListenSession.dispose()`。
- **收口动作是「先落位置，再停声，最后放介质」**：flush 位置防抖窗口里的最后一笔，复用 `stopListening` 的停声与代际作废，再 `releaseAll` 放掉两条分支的介质并摘掉 `pagehide` 挂钩。不得只把读数写成「不在放」——读数不是介质已停的证明。
- **在途起播一并作废**：起播取数 / 等语音表的 await 窗口里还没有活会话，`stopListening` 会早退、不抬代际；收口先自己抬一次会话代际，迟到的 `startSession` 回来只退场。
- **视图卸载不调它**：面板切走、阅读器卸载、关书都不结束会话；这条清理只归 fiber 生命周期。
- **不跨热替换交接会话**：新模块从共用消费位置与按书 `listen` 参数重新起播，不把旧会话搬过去。

## 边界

- 仍不做宿主后台任务；宿主进程结束、页面关闭时播放随浏览器一起结束。
- 收口只作用于本插件自己的播放层。
- 位置落盘仍是尽力而为：卸载瞬间那次写失败不阻断收口。
- 收口不区分「用户正在听」与「会话已暂停」：介质一律放掉。

## 被否方案

- 让旧会话继续放，等用户自己发现：控制面已经不存在，它还会继续合成、推进与落盘。
- 只在读数说「在放」时停声：读数与介质现场可能不同步。
- 把会话挂到 `window` 全局，热替换后重新接管：在插件生命周期之外再养一个不受 `ctx.effect` 约束的持有者。
- 在 `pagehide` 里代替卸载收口：客户端热替换时页面还在，两者不是同一件事。

锚点：`src/client/index.tsx` 的 `apply`（`dsh-novel: tts playback` 清理）；`src/client/tts/player.ts` 的 `disposeTtsPlayer`；`src/client/tts/listen-session.ts` 的 `ListenSession.dispose` / `stopListening` / `runSeq`；`src/client/tts/playback-branches.ts` 的 `releaseAll`；`src/client/tts/bytes-output.ts` 的 `release`；`src/client/tts/direct-output.ts` 的 `release`；`tests/client/tts-plugin-lifecycle.test.ts`、`tests/client/tts-session.test.ts`；`ADR-0072`、`ADR-0087`。
