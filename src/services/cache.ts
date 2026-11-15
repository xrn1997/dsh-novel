import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ChapterEntry } from '../shared/wire.js'
import { SizeLedger } from './size-ledger.js'
import { writeFileAtomic } from './storage.js'
import type { ValueSource } from './value-source.js'

/** 磁盘缓存上限（缺省 200MB）。**这个数是唯一主人**：缺省装配处 `src/config.ts` 的 schema `.default()`
 *  也引它，别在配置表里再写一遍字面量（两份会被改岔）。 */
export const DEFAULT_CACHE_MAX_BYTES = 200 * 1024 * 1024

/**
 * 文件名安全键：`encodeURIComponent(bookKey)`；结果 >100 字符时改为
 * 前 60 字符 + '~' + sha1(bookKey) 前 10 位（确定性，规避文件名长度上限）。
 */
export function safeKey(bookKey: string): string {
  const enc = encodeURIComponent(bookKey)
  if (enc.length <= 100) return enc
  const hash = createHash('sha1').update(bookKey).digest('hex').slice(0, 10)
  return `${enc.slice(0, 60)}~${hash}`
}

/**
 * 正文/目录文件缓存（novel 根目录下 `cache/toc` 与 `cache/content`）。
 * 写入按落盘字节增量记账：估算超上限立即全量 prune，否则每 FULL_SCAN_EVERY 次写实扫对账一次
 * （外部增删只能靠实扫发现）。prune 时两目录总字节超上限 → 按 mtime 最旧先删（LRU 近似）。
 * 上限是活值：配置页改过上限后，下一次 prune 就按新值淘汰，不必重建缓存实例；
 * prune 开头读一次快照，两处比较共用它——读到一半换值会让「判超」与「删到够」用两个上限。
 *
 * 本模块回答「放在哪」与 toc 编解码，不回答「何时有效」：`epoch` / `slot` 是调用方给的不透明串
 * （算式在 `cache-epoch.ts`，裁决在 `online-reading.ts`）。旧代际文件不删——此后不再被写，
 * mtime 只可能更早，因此排在**新写入**之前；但 prune 是 mtime 近似、`read()` 不刷新 mtime，
 * 长期只读的热条目同样不会被读操作续命，可能先于旧代际被淘汰（如实记，不假装挤不掉热数据）。
 *
 * toc 的 (de)serialize 与坏字节裁决在本模块；内容正文仍只收发 string。
 */
export class PageCache {
  private readonly tocDir: string
  private readonly contentDir: string
  private readonly ledger: SizeLedger

  constructor(dir: string, maxBytes: ValueSource<number> = DEFAULT_CACHE_MAX_BYTES) {
    this.tocDir = path.join(dir, 'cache', 'toc')
    this.contentDir = path.join(dir, 'cache', 'content')
    this.ledger = new SizeLedger([this.tocDir, this.contentDir], maxBytes)
  }

  /** 当前账的只读读数（诊断与测试用；淘汰判据不读它）。 */
  get totalBytes(): number {
    return this.ledger.totalBytes
  }

  async getToc(sourceId: string, bookKey: string, epoch: string): Promise<ChapterEntry[] | null> {
    return this.readToc(this.tocFile(sourceId, bookKey, epoch))
  }

  async setToc(sourceId: string, bookKey: string, epoch: string, chapters: readonly ChapterEntry[]): Promise<void> {
    const file = this.tocFile(sourceId, bookKey, epoch)
    const data = JSON.stringify(chapters)
    await this.write(file, data)
  }

  async getContent(sourceId: string, bookKey: string, chIndex: number, slot: string): Promise<string | null> {
    return this.read(this.contentFile(sourceId, bookKey, chIndex, slot))
  }

  async setContent(sourceId: string, bookKey: string, chIndex: number, slot: string, data: string): Promise<void> {
    await this.write(this.contentFile(sourceId, bookKey, chIndex, slot), data)
  }

  /** 写入 + 记账的唯一机械（两处写口共用）：**先登记保留再落盘**，与 `TtsAudioCache.put` 同一纪律
   *  ——落盘窗口里若正好有一轮 prune 在扫，这一条也不能被删：回执 / 调用方已经拿到「写成功」，
   *  淘汰它等于让刚写下的缓存下一次读口回 miss。`SizeLedger` 的保留集只护本轮，之后按 mtime 正常参与。 */
  private async write(file: string, data: string): Promise<void> {
    const release = this.ledger.reserve([file])
    try {
      await writeFileAtomic(file, data)
      await this.ledger.afterWrite([{ file, bytes: Buffer.byteLength(data, 'utf8') }], new Set([file]))
    } finally {
      release()
    }
  }

  /** 文件名形状单点：代际 / 槽位是**不透明串**，本模块不解释它（有效性归 cache-epoch + online-reading） */
  private tocFile(sourceId: string, bookKey: string, epoch: string): string {
    return path.join(this.tocDir, `${sourceId}-${safeKey(bookKey)}-${epoch}.json`)
  }

  private contentFile(sourceId: string, bookKey: string, chIndex: number, slot: string): string {
    return path.join(this.contentDir, `${sourceId}-${safeKey(bookKey)}-${chIndex}-${slot}.txt`)
  }

  /** 容量账的修剪入口（测试与调用方同一条；具体纪律住 `SizeLedger`）。 */
  async prune(): Promise<void> {
    await this.ledger.prune()
  }

  private async read(file: string): Promise<string | null> {
    try {
      return await fs.readFile(file, 'utf8')
    } catch {
      return null
    }
  }

  /** 目录缓存是**域形状**，不是裸文本：坏字节与错形状都读作 miss（ADR-0017 的降级边界内），
   *  下一次抓取按同一代际重写；不新增清缓存出口（ADR-0012）。 */
  private async readToc(file: string): Promise<ChapterEntry[] | null> {
    const raw = await this.read(file)
    if (raw === null) return null
    try {
      const value: unknown = JSON.parse(raw)
      return isChapterEntries(value) ? value : null
    } catch {
      return null
    }
  }
}

function isChapterEntries(value: unknown): value is ChapterEntry[] {
  return Array.isArray(value) && value.every((item) => {
    if (typeof item !== 'object' || item === null) return false
    const row = item as Record<string, unknown>
    if (typeof row.name !== 'string' || typeof row.url !== 'string') return false
    for (const key of ['isVip', 'isVolume', 'isPay'] as const) {
      if (row[key] !== undefined && typeof row[key] !== 'boolean') return false
    }
    return row.updateTime === undefined || typeof row.updateTime === 'string'
  })
}
