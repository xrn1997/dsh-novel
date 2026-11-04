import { Buffer } from 'node:buffer'

/** 宿主 job 输出面的帽（UTF-8 字节）——唯一主人：spec 里自报的 `outputLimitBytes` 用它。
 *  它是 `JobTail` **保留缓冲**的帽，不是单次读取的严格上界（单行超帽时保留最后一行，
 *  丢弃横幅不计字节）；最终截断归宿主 `job_output`。这不进用户配置：它是「给模型看的 tail 有多大」
 *  的取舍，不是运维可调的旋钮。 */
export const DEFAULT_JOB_OUTPUT_BYTES = 32 * 1024

/** 一次读取的投影。`text` 是游标之后那一段——正常情况就是 `[from, nextOffset)`，两处会偏离：
 *  `from` 落在行中间时从那一行行首重发（重复几个字节），`lossy` 时开头多一行丢弃横幅（横幅
 *  不计入偏移，所以 `nextOffset` 仍落在项边界上）。`lossy` 表示 `from` 落在已丢弃区，调用方
 *  读到的不是它以为自己没读过的那批（读数如实，但不报错——宿主契约同款）——宿主据此在
 *  `job_output` 里标一个 gap。形状与宿主 `JobOutputSource.read` 的返回同构：注册表按自己持有的游标来拉，
 *  我们只按偏移交字节。 */
export interface JobTailRead {
  text: string
  nextOffset: number
  lossy: boolean
}

/** 一项 = 一行连同结尾换行；`start` 是它的起始字节偏移，`bytes` 预先算好（UTF-8）。
 *  三者同住一条记录，偏移与内容不会各走各的。 */
interface TailEntry {
  readonly text: string
  readonly start: number
  readonly bytes: number
}

/** 过程行的**偏移可读**缓冲：宿主（或其 `job_output` 工具）拿着上次的 `nextOffset` 来拉增量。
 *
 *  为什么是偏移而不是「内部游标 + 一次读完」：拉模型有不止一个读者（注册表的泵、终态前的最后一次
 *  排空、以及可能的绝对偏移读），而「读一次就清空」的缓冲只能服务一个读者；第二个读者要么读到空，
 *  要么替第一个读者把内容吃掉。偏移读让每个读者各持游标、谁也不吃谁的内容（丢弃横幅是唯一的共享
 *  状态：同一批丢弃只报一次，别的读者靠 `lossy` 与宿主侧的 gap 标记知道断点）。
 *
 *  偏移按**项边界**推进：每行连同结尾换行一起计入字节数，所以正常路径下 `nextOffset` 落在
 *  某个项边界（`from` 越过尾部时按 `from` 原样回，见 `readFrom`）；若调用方给的 `from` 落在
 *  行中间（不该发生，只有跨读者游标才会），从那一行**行首**重发——重复几个字节好过丢字节。 */
export class JobTail {
  /** 每项都以 '\n' 结尾：偏移与字节数一一对应，`start` 都落在项边界上。 */
  private readonly entries: TailEntry[] = []
  /** 已写入的总字节数（= 下一个项的起始偏移）。 */
  private total = 0
  /** 仍保留的第一项的起始偏移：小于它的 `from` 一律算 lossy。 */
  private head = 0
  /** 因超帽被丢弃的行数（累计）。 */
  private dropped = 0
  /** 已经对读者报过的丢弃数：横幅只在「新增丢弃」的那一批出现。 */
  private reportedDropped = 0
  readonly maxBytes: number

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes
  }

  push(line: string): void {
    const text = `${line}\n`
    const bytes = Buffer.byteLength(text, 'utf8')
    this.entries.push({ text, start: this.total, bytes })
    this.total += bytes
    // 至少留一项：单行本身超帽时保留最后一行（丢掉它等于丢掉最新进度）。
    while (this.total - this.head > this.maxBytes && this.entries.length > 1) {
      const gone = this.entries.shift()
      if (gone === undefined) break
      this.head = gone.start + gone.bytes
      this.dropped += 1
    }
  }

  /** 按字节偏移读。不是消费式：读不清空缓冲，读者各自的游标由调用方持有——缓冲没长、也不在
   *  已丢弃区时，同一个 `from` 再读一次得到同一份文本（丢弃横幅只对第一份 lossy 读取出现一次）。 */
  readFrom(from: number): JobTailRead {
    const start = Math.max(from, this.head)
    const lossy = from < this.head
    const banner = lossy && this.dropped > this.reportedDropped
      ? `[早期输出已丢弃 ${this.dropped} 行，超 ${this.maxBytes} 字节帽]\n`
      : ''
    let text = ''
    for (const entry of this.entries) {
      if (entry.start + entry.bytes <= start) continue
      text += entry.text
    }
    if (lossy) this.reportedDropped = this.dropped
    return { text: banner + text, nextOffset: Math.max(this.total, from), lossy }
  }
}
