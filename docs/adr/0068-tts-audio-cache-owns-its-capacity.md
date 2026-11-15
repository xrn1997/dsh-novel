# 听书音频缓存独立容量账，与页面缓存共用修剪纪律

Status: accepted

段音频缓存（数据根下 `cache/tts`）有自己的目录与上限，不寄居页面缓存；两者只共用「写增量记账 / 定期实扫 / 按 mtime 最旧先删」这一份机制（`services/size-ledger.ts` 的 `SizeLedger`），容量与淘汰次序互不挤占。

## 背景

听书按段合成、边播边预取，写入频次与体积分布都与目录 / 正文页缓存不同：一段音频可能远大于一页正文，而预取会连续写多段。若两套缓存共用一个上限，听书预取会把页面缓存挤掉，反之亦然；但两套缓存对「什么时候全扫、怎么按 mtime 淘汰、扫描期间有并发写怎么办」的纪律又是同一套。

## 决定

- **容量与目录独立**：`TtsAudioCache` 构造时只收 `cache/tts` 与 `ttsCacheMaxBytes`；页面缓存的上限与两个目录不受影响。
- **机制只有一份**：写增量、`FULL_SCAN_EVERY` 对账、超限立即全扫、按 mtime 升序删除、同轮只留一发扫描（扫描在途时后来的写并入这一轮，不各起一轮）、扫描窗口里的写补回重建后的索引、刚写入的那一条不参与本轮淘汰——全部住 `SizeLedger`；两种缓存只保留各自的读口、写口与提交标记。
- **写前预约保留**：写入方在落盘**之前**把目标文件登记进保留集（`SizeLedger.reserve`），因此落盘窗口里恰好开始的一轮扫描也删不掉它。回执一旦发出，音频读口必须还能按同一个键取到字节；「刚写入的一条本轮不动」不能只靠 mtime 排序碰运气。
- **先字节后侧车**：`<key>.bin` 落盘后再写 `<key>.json` 侧车；侧车是提交标记，缺侧车 / 坏侧车的字节按 miss 读，下一次 put 原地重写。
- **上限是活值**：配置页改过 `ttsCacheMaxBytes` 后，下一次 prune 就按新值淘汰，不必重建缓存实例。

## 边界

- 不提供「清缓存」入口：失效靠键与 LRU，不靠删除动作（`ADR-0012`）。
- 不做跨缓存共享配额：页面缓存与音频缓存各自守自己的上限。
- 读不刷新 mtime：长期只读的热条目不会被读操作续命，可能先于旧代际被淘汰。

## 被否方案

- **寄居 `PageCache`**：要么共享上限（互相挤占），要么在 `PageCache` 里开第二个账本；后者会把「页面缓存的实例」变成两套无关缓存的容器，能力按名字混在一起。
- **各抄一份容量纪律**：两套账的并发与全扫边界很容易只改到一边；这正是 `SizeLedger` 要消除的抄本。
- **按条目原子删（bin + sidecar 一起）**：prune 是按文件遍历的，删一半的窗口由读口按 miss 处理即可；为原子性引入目录锁，代价大于收益。

锚点：`src/services/size-ledger.ts` 的 `SizeLedger` / `SizeLedger.reserve`；`src/services/tts-cache.ts` 的 `TtsAudioCache` / `DEFAULT_TTS_CACHE_MAX_BYTES`；`src/services/cache.ts` 的 `PageCache`；`tests/services/size-ledger.test.ts`；`tests/services/tts-cache.test.ts`；`tests/services/cache.test.ts`；`docs/architecture.md` 的缓存容量账两行；`ADR-0012`。
