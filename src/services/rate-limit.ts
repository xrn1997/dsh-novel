export interface RateRule {
  /** 窗口内允许的请求数 */
  limit: number
  /** 窗口长度（毫秒） */
  intervalMs: number
}

/**
 * 源级 `concurrentRate` 解析（对齐上游 ConcurrentRateLimiter）：
 * - `a/b` → a 次 / b 毫秒；
 * - 裸数字 N → 1 次 / N 毫秒（上游的「非并发实际为 1/N 毫秒」口径）；
 * - 空、非数字、非正数 → 不限速（null）。
 */
export function parseConcurrentRate(raw: unknown): RateRule | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  const text = String(raw).trim()
  if (text === '') return null
  if (text.includes('/')) {
    const [a, b] = text.split('/')
    const intervalMs = Number(b)
    // 先取整再验：0.5/1000 的 limit 取整后是 0，按「非正数」拒绝，别交给限速器
    // 当成「窗口内 0 次」的退化规则（那会退化成不限速）。
    const limit = Math.floor(Number(a))
    if (!Number.isFinite(limit) || !Number.isFinite(intervalMs) || limit <= 0 || intervalMs <= 0) return null
    return { limit, intervalMs }
  }
  const intervalMs = Number(text)
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null
  return { limit: 1, intervalMs }
}

interface Clock {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** 滑动窗口限速器：窗口内最多 limit 次；第 limit+1 次等到最早一次滑出窗口。
 *  **每次 acquire 先清过期头**：只在 sleep 分支里清会让空闲超过窗口后头部永久滞留，
 *  后续请求全部跳过等待（源级 concurrentRate 多数只是数字间隔，空闲头滞留会让限速形同虚设；
 *  现量见矩阵 `b-concurrent-rate`）。
 *  **acquire 串行入队**：并发调用若各自看到「窗口还有余量」就会同时放行，超过 limit；
 *  排队后第二个调用一定在第一个记账之后才看窗口。 */
export class RateLimiter {
  private readonly times: number[] = []
  private readonly rule: RateRule | null
  private tail: Promise<void> = Promise.resolve()

  constructor(rule: RateRule | null, private readonly clock: Clock = {}) {
    this.rule = rule
  }

  acquire(): Promise<void> {
    const run = this.tail.then(() => this.tick())
    this.tail = run.catch(() => undefined)
    return run
  }

  private async tick(): Promise<void> {
    const rule = this.rule
    if (rule === null) return
    const now = (): number => this.clock.now?.() ?? Date.now()
    const sleep = (ms: number): Promise<void> =>
      this.clock.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms))

    for (;;) {
      const at = now()
      while (this.times.length > 0 && at - this.times[0]! >= rule.intervalMs) this.times.shift()
      if (this.times.length < rule.limit) {
        this.times.push(at)
        return
      }
      await sleep(rule.intervalMs - (at - this.times[0]!))
    }
  }
}
