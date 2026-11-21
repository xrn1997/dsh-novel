# 落盘只有一条按文件名排队的原子写；同步小文件例外

Status: accepted

低层只有一条 `writeFileAtomic`（临时文件 + rename，并**按文件名排队串行**），JSON 写与页面缓存共用。并发 rename 同一目标在 Windows 上会互斥失败（EPERM），而缓存侧曾自抄一份无排队的写；入队必须先于任何 `await`（含建目录）。**同步小文件是明确例外**：`source-state.json` 由 `SourceSession` 同步 tmp+rename 落盘——脚本 `source.get` / `cache.get` 的方法面是同步的，不能等异步队列；命名仍复用 `tempPathOf` / `backupPathOf`，单线程同步调用不会互相插队。读侧同样单点：`readJson` 严格区分 **ENOENT → 用缺省值** 与 **存在但解析失败 → 备份 `.bak` + 日志 + 抛 `CorruptJsonError`**；把损坏折叠成 fallback 是数据丢失方向（下一次 `edit` 会用空表覆盖整文件）。临时件与备份件的命名约定只有一个住址（`tempPathOf` / `backupPathOf` / `isAtomicTemp`）。落盘调度只有 `createDebouncedWriter` 一份；`flush` 刻意不设轮次上限。瞬态 EPERM / EBUSY 做有限次重试，最终失败仍如实抛；`EACCES` 这类持久性权限错不重试。被否决：先 `unlink` 再 `rename`（两步之间并发读拿到 ENOENT、进程死在中途只剩 `.tmp`，是「认不出来的缺席冒充成功」）；各消费方写死后缀字面量。

锚点：`src/services/storage.ts`（`writeFileAtomic` / `readJson` / `createDebouncedWriter`）；`src/services/source-session.ts`（同步例外）；`tests/services/storage.test.ts`；`tests/services/source-session.test.ts`。
