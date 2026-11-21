# 听书音频缓存独立容量账，与页面缓存共用修剪纪律

Status: accepted

段音频缓存（数据根下 `cache/tts`）有自己的目录与上限，不寄居页面缓存；两者只共用「写增量记账 / 定期实扫 / 按 mtime 最旧先删」这一份机制（`services/size-ledger.ts` 的 `SizeLedger`），容量与淘汰次序互不挤占。理由：听书按段合成、边播边预取，写入频次与体积分布都与页面缓存不同，共用上限会互相挤掉；但两套缓存对全扫、mtime 淘汰与扫描并发写的纪律又是同一套。

## 决定

- **容量与目录独立**：`TtsAudioCache` 构造时只收 `cache/tts` 与 `ttsCacheMaxBytes`。
- **机制只有一份**：写增量、`FULL_SCAN_EVERY` 对账、超限立即全扫、按 mtime 升序删除、同轮只留一发扫描、扫描窗口里的写补回重建后的索引、刚写入的那一条不参与本轮淘汰——全部住 `SizeLedger`。
- **写前预约保留**：写入方在落盘之前把目标文件登记进保留集（`SizeLedger.reserve`），落盘窗口里恰好开始的一轮扫描也删不掉它。
- **先字节后侧车**：`<key>.bin` 落盘后再写 `<key>.json` 侧车；侧车是提交标记，缺侧车 / 坏侧车的字节按 miss 读。
- **上限是活值**：配置页改过 `ttsCacheMaxBytes` 后，下一次 prune 就按新值淘汰。

## 边界

- 不提供「清缓存」入口：失效靠键与 LRU，不靠删除动作（`ADR-0012`）。
- 不做跨缓存共享配额；读不刷新 mtime（热条目可能先于旧代际被淘汰）。

## 被否方案

- 寄居 `PageCache`：要么共享上限互相挤占，要么在 `PageCache` 里开第二个账本，能力按名字混在一起。
- 各抄一份容量纪律：并发与全扫边界很容易只改到一边。
- 按条目原子删（bin + sidecar 一起）：为原子性引入目录锁，代价大于收益。

锚点：`src/services/size-ledger.ts` 的 `SizeLedger` / `SizeLedger.reserve`；`src/services/tts-cache.ts` 的 `TtsAudioCache` / `DEFAULT_TTS_CACHE_MAX_BYTES`；`src/services/cache.ts` 的 `PageCache`；`tests/services/size-ledger.test.ts`；`tests/services/tts-cache.test.ts`；`tests/services/cache.test.ts`；`docs/architecture.md` 的缓存容量账两行；`ADR-0012`。
