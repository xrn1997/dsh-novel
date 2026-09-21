import type { ChapterEntry } from './reading.js'

/**
 * 范围导出核心：串行逐章 + 章间节流 + 失败即停 + abort 即停。范围**由调用方裁好**
 * （判据单点在 `api/dispatch.ts`），本 module 只在越界时抛——见 `ExportOptions.from` 注。
 * 限流敬畏是第一原则——绝不并行抓章；getChapter 缓存优先语义即天然断点续传。
 */
export interface ExportDeps {
  getToc(sourceId: string, bookKey: string): Promise<ChapterEntry[]>
  getChapter(sourceId: string, bookKey: string, index: number): Promise<string>
  /** 测试注入假 sleep；生产缺省真实 setTimeout */
  sleep?: (ms: number) => Promise<void>
}
export interface ExportOptions {
  /** 用于章节头《书名》与路由层文件名 */
  title: string
  /** 章间节流毫秒（配置 exportDelayMs） */
  delayMs: number
  /** 起始章（1 基含端）。**必须已裁剪**：越界裁剪与「缺省 = 全本」是路由层的策略单点
   *  （它要在首包前拿这些数去写 `x-novel-total-chapters` / `x-novel-range`），本 module
   *  不再抄第二份判据——此前两边各写一份 `clip` 与同一句「导出范围非法」，而这里的 clip
   *  对唯一调用方恒等。越界只可能来自新调用方，故按前置条件抛，不静默产废包。 */
  from: number
  /** 结束章（1 基含端）。同 `from`。 */
  to: number
  signal?: AbortSignal
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function* exportBook(
  deps: ExportDeps, sourceId: string, bookKey: string, opts: ExportOptions,
): AsyncGenerator<string> {
  const sleep = deps.sleep ?? realSleep
  yield '\uFEFF'                                             // BOM：Windows 记事本兼容
  const toc = await deps.getToc(sourceId, bookKey)
  const { from, to } = opts
  // 空目录 / 越界 / 倒置合起来判：它们说的是同一件事——[from, to] 不是 toc 的一段。
  // 曾经这两类各自有静默出口（空目录只发 BOM、倒置靠 clip 折回来），现在没有：
  // 越界继续往下跑会印出「《书名》· undefined」的废包，那比抛错坏得多。
  if (from < 1 || to > toc.length || from > to) {
    throw new Error(`导出范围越界：[${from}, ${to}] 不在 [1, ${toc.length}] 内（裁剪归路由层）`)
  }
  for (let i = from - 1; i <= to - 1; i++) {
    if (opts.signal?.aborted === true) return
    let text: string
    try {
      text = await deps.getChapter(sourceId, bookKey, i)
    } catch (e) {
      // 失败即停：HTTP 首包后状态码不可改，用文本标记告知文件不完整；重跑只补缺章。
      // 章号用绝对 i+1（不是段内序号）——与目录、阅读器进度同一套坐标
      const reason = e instanceof Error ? e.message.split('\n')[0] : String(e)
      yield `\n[导出中断于第 ${i + 1} 章《${toc[i].name}》：${reason}]\n`
      return
    }
    yield `《${opts.title}》· ${toc[i].name}\n\n${text}\n\n`
    if (i < to - 1) await sleep(opts.delayMs)                // 段内 k-1 次：段末章后不睡
  }
}
