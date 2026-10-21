# 落盘只有一条按文件名排队的原子写；同步小文件例外

Status: accepted

低层只有一条 `writeFileAtomic`（临时文件 + rename，并**按文件名排队串行**），JSON 写与页面缓存共用它。并发 rename 同一目标在 Windows 上会互斥失败（EPERM），而缓存侧曾自抄一份**无排队**的写。入队必须先于任何 `await`（含建目录），否则「最后写的最后落盘」不成立。

**同步小文件是明确例外**：`src/services/source-session.ts` 的 `source-state.json` 由 `SourceSession` 同步 tmp+rename 落盘——脚本 `source.get` / `cache.get` 的方法面是同步的，不能等异步队列；命名仍复用 `tempPathOf` / `backupPathOf`，单线程同步调用不会互相插队，故不需要按文件名排队。读侧沿用本文的 ENOENT-vs-损坏判据：损坏时备份 + 抛 `CorruptJsonError`，不折叠成空表（下一笔写会把整张源状态覆盖掉）。

读侧同样单点：`readJson` 严格区分 **ENOENT → 用缺省值** 与 **存在但解析失败 → 备份 `.bak` + 日志 + 抛 `CorruptJsonError`**。把损坏折叠成 fallback 是数据丢失方向——下一次 `edit` 会用空表覆盖整文件，整库的源无告警消失。临时件与备份件的**命名约定只有一个住址**（`tempPathOf` / `backupPathOf` / `isAtomicTemp`），消费方按判据扫残留，不许自己写死 `.tmp` / `.bak` 去猜。

两处 `flush`（注册表与防抖写器）的合同都是「等齐落盘」，因此**刻意不设轮次上限**——加上限等于把逃逸窗口藏回注释。

被否决的方案：
- 先 `unlink` 目标再 `rename`：**已量完即自我否决**。实测确实免魔数免重试，但窗口内并发读拿到 ENOENT 会被当成「空书架 / 空注册表」，进程死在两步之间时目标不存在、数据只剩 `.tmp`——两条合起来正是「认不出来的缺席冒充成功」，比加有限次重试坏一个量级。登记只为不让下一个人再试。
- 各消费方自己写死后缀字面量；缓存自抄一份写路径。

**瞬态 EPERM / EBUSY 的处置**：低层 rename 对这两个码做 3 次有限重试（10/50/200ms），最终失败仍如实抛；`EACCES` 这类持久性权限错不重试（不把不可恢复的失败拖成延迟）。防抖写的定时器捕获 rejection 后记日志，`flush` 把定时器路径留下的失败如实抛给调用方——不再出现「门绿但进程 exit≠0」的未处理拒绝。同步小文件例外不含在这条异步重试路径内。

锚点：`src/services/storage.ts`（`writeFileAtomic` / `readJson` / `createDebouncedWriter`）；`src/services/source-session.ts`（同步例外）；`tests/services/storage.test.ts`；`tests/services/source-session.test.ts`。
