import { promises as fs } from 'node:fs'
import path from 'node:path'
import { readValue, type ValueSource } from './value-source.js'

/** 全量对账间隔：外部增删只能靠实扫发现；上限判据不靠它——估算超限会立即全扫。
 *  导出给测试引（别在测试里抄一份字面量：实现改档位时那份副本不会跟着变，测试名就撒谎了）。 */
export const FULL_SCAN_EVERY = 32

/** prune 的缺省保留集：显式调用（对账、测试）没有「刚写入的那一条」要护。 */
const EMPTY_KEEP: ReadonlySet<string> = new Set()

/**
 * 多目录文件字节账（LRU 近似）：`PageCache` 与 `TtsAudioCache` 共用这一份纪律。
 *
 * 写入按落盘字节增量记账，估算超上限立即全量 prune，否则每 `FULL_SCAN_EVERY` 次写实扫对账一次；
 * prune 时总量超上限 → 按 mtime 最旧先删（LRU 近似）。上限是活值：配置页改过后，下一次 prune
 * 就按新值淘汰。淘汰按**文件**粒度（与两处缓存同尺）：极端情况下可能只删掉条目的一半；留下的
 * 孤儿由各读口按 miss 处理，等下一次按 mtime 轮到它时再清掉——不会冒充一条可读缓存。
 *
 * 读不刷新 mtime：长期只读的热条目不会被读操作续命，可能先于旧代际被淘汰（如实记，不假装
 * 读操作能挤掉冷数据）。
 */
export class SizeLedger {
  private readonly dirs: readonly string[]
  private readonly maxBytes: ValueSource<number>
  /** 已落盘文件的大小索引：首次写入后实扫一次，之后按写增量维护。 */
  private sizes: Map<string, number> | null = null
  private bytes = 0
  private writesSinceFullScan = 0
  private indexPromise: Promise<Map<string, number>> | null = null
  /** 扫描在途：这期间落进来的写先记着，整份重建索引后补回新账（否则那笔写从账上消失）。 */
  private scanning = false
  private writesDuringScan: Array<{ file: string; bytes: number }> = []
  /** 同一时刻只留一发扫描：在途时后来的写并入这一轮（保留集累加、等同一份结果），
   *  而不是各排一次全扫——持续预取那种「一路都在写」的形状下，逐写排队就等于逐写全扫。
   *  并入的保留登记只在**那一轮**有效，扫描收尾时清空（见 `pruneOnce`）。 */
  private running: Promise<void> | null = null
  private pendingKeep = new Set<string>()
  /** 写入前的保留登记：文件还没落盘（或刚落盘、afterWrite 还没排上）时也要挡住扫描。
   *  与 `keep` 的区别是**登记时机**——它必须在字节写下去之前发生，才盖得住落盘窗口。 */
  private readonly reserved = new Set<string>()

  constructor(dirs: string | readonly string[], maxBytes: ValueSource<number>) {
    this.dirs = typeof dirs === 'string' ? [dirs] : dirs
    this.maxBytes = maxBytes
  }

  /** 写入前登记一组文件路径；返回的释放函数在写完后调用。保留期间任何 prune 都不删它们。 */
  reserve(files: readonly string[]): () => void {
    for (const file of files) this.reserved.add(file)
    return () => {
      for (const file of files) this.reserved.delete(file)
    }
  }

  /** 当前账的只读读数（诊断与测试用；淘汰判据不读它）。 */
  get totalBytes(): number {
    return this.bytes
  }

  /** 写后增量记账；只在估算超限或到全量对账间隔时扫描目录。
   *  每写一次都 readdir+stat 会让长书的缓存写入退化成 O(n²)，而上限只要求最终守住。
   *  `keep` = 本轮刚写入的那几条：它们不参与这一轮的淘汰。 */
  async afterWrite(
    entries: ReadonlyArray<{ file: string; bytes: number }>,
    keep?: ReadonlySet<string>,
  ): Promise<void> {
    const indexed = await this.ensureIndex()
    // await 期间可能已有 prune 重建索引：增量必须记到当前索引与当前总量上，别用旧引用
    const sizes = this.sizes ?? indexed
    for (const entry of entries) {
      this.bytes += entry.bytes - (sizes.get(entry.file) ?? 0)
      sizes.set(entry.file, entry.bytes)
    }
    if (this.scanning) this.writesDuringScan.push(...entries)
    this.writesSinceFullScan += 1
    if (this.bytes <= readValue(this.maxBytes) && this.writesSinceFullScan < FULL_SCAN_EVERY) return
    await this.prune(keep)
  }

  /** 总字节超上限 → 按 mtimeMs 升序删除直到 ≤ 上限；目录不存在时实扫得空集。实扫同时重建大小索引。
   *  扫描窗口里落进来的写不丢：先记下，索引整份重建后按差额补回新账——所以计数可以放心清零。
   *  （早先的做法是「有并发写就不重建、也不清零」，代价是对账一直排不上，持续预取时几乎每写都要
   *  重扫一遍，正是这里要避免的 O(n²)。）
   *  `keep` 里的路径本轮不删：上限再小也不该把这次刚写入、回执已经发出去的那一条挤掉——
   *  极端情况（单条本身就超上限）允许这一轮临时超上限，下一次写入自然把它当最旧的淘汰。
   *  在途已有一发扫描时不再另起一轮：等那一发，保留集并进去。 */
  prune(keep: ReadonlySet<string> = EMPTY_KEEP): Promise<void> {
    for (const file of keep) this.pendingKeep.add(file)
    if (this.running !== null) return this.running
    const run = this.pruneOnce()
    this.running = run
    return run.finally(() => { this.running = null })
  }

  private async pruneOnce(): Promise<void> {
    const keep = this.pendingKeep
    this.pendingKeep = new Set()
    const maxBytes = readValue(this.maxBytes)
    this.scanning = true
    this.writesDuringScan = []
    const files = await this.scanFiles()
    let total = files.reduce((sum, f) => sum + f.size, 0)
    const deleted = new Set<string>()
    if (total > maxBytes) {
      files.sort((a, b) => a.mtimeMs - b.mtimeMs)
      for (const f of files) {
        if (total <= maxBytes) break
        // 保留集读三份：本轮开局的那一份、扫描中途才登记上来的（并入本轮的那几笔写），
        // 以及写入前就预约的（落盘窗口里的文件）。
        if (keep.has(f.file) || this.pendingKeep.has(f.file) || this.reserved.has(f.file)) continue
        try {
          await fs.unlink(f.file)
          total -= f.size
          deleted.add(f.file)
        } catch {
          // 删不掉（并发等）→ 继续删更旧的
        }
      }
    }
    const raced = this.writesDuringScan
    this.writesDuringScan = []
    this.scanning = false
    // 本轮并入的保留登记到此为止：它们只该护住「扫描在途时刚落的那几笔写」，不清掉下一轮会把
    // 它们当成新的本轮 keep，让那一轮把本可淘汰的旧写多护一次、账停在上限之上。
    this.pendingKeep = new Set()
    const kept = deleted.size === 0 ? files : files.filter((f) => !deleted.has(f.file))
    const sizes = this.reindex(kept)
    // 补回扫描窗口的写：同一文件实扫已经量到就只补差额，实扫没见到的按新字节入账
    for (const entry of raced) {
      this.bytes += entry.bytes - (sizes.get(entry.file) ?? 0)
      sizes.set(entry.file, entry.bytes)
    }
    this.writesSinceFullScan = 0
  }

  /** 首次写入后建索引：目录里已有的文件（含刚写入的）只需实扫一次，之后按写增量维护。 */
  private async ensureIndex(): Promise<Map<string, number>> {
    if (this.sizes !== null) return this.sizes
    if (this.indexPromise === null) {
      this.indexPromise = this.buildIndex().finally(() => { this.indexPromise = null })
    }
    return this.indexPromise
  }

  private async buildIndex(): Promise<Map<string, number>> {
    return this.reindex(await this.scanFiles())
  }

  /** 索引重建单点：sizes 与 totalBytes 必须一起换，分开写会让「估算」与「逐文件账」不同步。 */
  private reindex(files: ReadonlyArray<{ file: string; size: number }>): Map<string, number> {
    const sizes = new Map(files.map((f) => [f.file, f.size]))
    this.sizes = sizes
    this.bytes = files.reduce((sum, f) => sum + f.size, 0)
    return sizes
  }

  /** 缓存目录实扫：prune 与首次建索引共用，文件名/大小/mtime 一次取齐。 */
  private async scanFiles(): Promise<Array<{ file: string; size: number; mtimeMs: number }>> {
    const files: Array<{ file: string; size: number; mtimeMs: number }> = []
    for (const dir of this.dirs) {
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
    return files
  }
}
