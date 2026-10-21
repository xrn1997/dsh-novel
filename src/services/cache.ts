import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ChapterEntry } from '../shared/wire.js'
import { writeFileAtomic } from './storage.js'
import { readValue, type ValueSource } from './value-source.js'

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
 * 写入后触发 prune：两目录总字节超上限 → 按 mtime 最旧先删（LRU 近似）。
 * 上限是活值：配置页改过上限后，下一次 prune 就按新值淘汰，不必重建缓存实例；
 * prune 开头读一次快照，两处比较共用它——读到一半换值会让「判超」与「删到够」用两个上限。
 *
 * 本模块回答「放在哪」与 toc 编解码，不回答「何时有效」：`epoch` / `slot` 是调用方给的不透明串
 * （算式在 `cache-epoch.ts`，裁决在 `reading.ts`）。旧代际文件不删——此后不再被写，
 * mtime 只可能更早，因此排在**新写入**之前；但 prune 是 mtime 近似、`read()` 不刷新 mtime，
 * 长期只读的热条目同样不会被读操作续命，可能先于旧代际被淘汰（如实记，不假装挤不掉热数据）。
 *
 * toc 的 (de)serialize 与坏字节裁决在本模块；内容正文仍只收发 string。
 */
export class PageCache {
  private readonly tocDir: string
  private readonly contentDir: string
  private readonly maxBytes: ValueSource<number>

  constructor(dir: string, maxBytes: ValueSource<number> = DEFAULT_CACHE_MAX_BYTES) {
    this.tocDir = path.join(dir, 'cache', 'toc')
    this.contentDir = path.join(dir, 'cache', 'content')
    this.maxBytes = maxBytes
  }

  async getToc(sourceId: string, bookKey: string, epoch: string): Promise<ChapterEntry[] | null> {
    return this.readToc(this.tocFile(sourceId, bookKey, epoch))
  }

  async setToc(sourceId: string, bookKey: string, epoch: string, chapters: readonly ChapterEntry[]): Promise<void> {
    await writeFileAtomic(this.tocFile(sourceId, bookKey, epoch), JSON.stringify(chapters))
    await this.prune()
  }

  async getContent(sourceId: string, bookKey: string, chIndex: number, slot: string): Promise<string | null> {
    return this.read(this.contentFile(sourceId, bookKey, chIndex, slot))
  }

  async setContent(sourceId: string, bookKey: string, chIndex: number, slot: string, data: string): Promise<void> {
    await writeFileAtomic(this.contentFile(sourceId, bookKey, chIndex, slot), data)
    await this.prune()
  }

  /** 文件名形状单点：代际 / 槽位是**不透明串**，本模块不解释它（有效性归 cache-epoch + reading） */
  private tocFile(sourceId: string, bookKey: string, epoch: string): string {
    return path.join(this.tocDir, `${sourceId}-${safeKey(bookKey)}-${epoch}.json`)
  }

  private contentFile(sourceId: string, bookKey: string, chIndex: number, slot: string): string {
    return path.join(this.contentDir, `${sourceId}-${safeKey(bookKey)}-${chIndex}-${slot}.txt`)
  }

  /** 总字节超上限 → 按 mtimeMs 升序删除直到 ≤ 上限；目录不存在直接返回 */
  async prune(): Promise<void> {
    const maxBytes = readValue(this.maxBytes)
    const files: { file: string; size: number; mtimeMs: number }[] = []
    for (const dir of [this.tocDir, this.contentDir]) {
      let names: string[]
      try {
        names = await fs.readdir(dir)
      } catch {
        continue
      }
      for (const name of names) {
        const file = path.join(dir, name)
        try {
          const st = await fs.stat(file)
          if (st.isFile()) files.push({ file, size: st.size, mtimeMs: st.mtimeMs })
        } catch {
          // stat 失败（并发删除等）→ 跳过该文件
        }
      }
    }
    let total = files.reduce((sum, f) => sum + f.size, 0)
    if (total <= maxBytes) return
    files.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const f of files) {
      if (total <= maxBytes) break
      try {
        await fs.unlink(f.file)
        total -= f.size
      } catch {
        // 删不掉（并发等）→ 继续删更旧的
      }
    }
  }

  private async read(file: string): Promise<string | null> {
    try {
      return await fs.readFile(file, 'utf8')
    } catch {
      return null
    }
  }

  /** 目录缓存是**域形状**，不是裸文本：坏字节与错形状都读作 miss（ADR 0017 的降级边界内），
   *  下一次抓取按同一代际重写；不新增清缓存出口（ADR 0012）。 */
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
