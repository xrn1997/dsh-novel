import { Buffer } from 'node:buffer'

/** 宿主 job 输出面的帽（UTF-8 字节）——唯一主人：spec 里自报的 `outputLimitBytes` 用它。
 *  它是 `JobTail` **保留缓冲**的帽，不是 `read()` 的严格上界（单行超帽保留、换行与横幅不计）；
 *  最终截断归宿主 `job_output`。这不进用户配置：它是「给模型看的 tail 有多大」的取舍，
 *  不是运维可调的旋钮。 */
export const DEFAULT_JOB_OUTPUT_BYTES = 32 * 1024

/** 宿主 `ctx.jobs` 的输出面是**拉**：注册表在我们 `run()` 返回的 hooks 上调 `readOutput?(): string`
 *  （唯一消费点是 `job_output` 工具），一次调用要交出「上次读之后」的全部增量。
 *  本 buffer 只做两件事：按字节帽从头丢（丢必如实报数），以及把已交付/未交付分开。
 *  帽是**保留缓冲**的帽，不是 `read()` 输出的严格上界：单行本身超帽时保留最后一行
 *  （丢它等于丢最新进度），行间换行与丢弃横幅也不计字节；`outputLimitBytes` 的
 *  最终截断归宿主 `job_output` 那侧。业务明细与整轮结果不在这里——那归各持有者的
 *  快照读面（ADR 0018 的分工）。 */
export class JobTail {
  private lines: string[] = []
  private bytes = 0
  private delivered = 0
  private dropped = 0
  private reportedDropped = 0

  constructor(private readonly maxBytes: number) {}

  push(line: string): void {
    this.lines.push(line)
    this.bytes += Buffer.byteLength(line, 'utf8')
    while (this.bytes > this.maxBytes && this.lines.length > 1) {
      const droppedLine = this.lines.shift()
      if (droppedLine === undefined) break
      this.bytes -= Buffer.byteLength(droppedLine, 'utf8')
      this.dropped++
      this.delivered = Math.max(0, this.delivered - 1)
    }
  }

  /** 消费式：返回上次 read 之后的新行。只有**新增丢弃**的那批才在开头报一行；
   *  数字是累计丢弃数（不是本批增量）。宿主面的最终截断措辞归它自己。 */
  read(): string {
    const pending = this.lines.slice(this.delivered)
    this.delivered = this.lines.length
    if (pending.length === 0) return ''
    const isLossy = this.dropped > this.reportedDropped
    this.reportedDropped = this.dropped
    const lossy = isLossy ? `[早期输出已丢弃 ${this.dropped} 行，超 ${this.maxBytes} 字节帽]\n` : ''
    return lossy + pending.join('\n')
  }
}
