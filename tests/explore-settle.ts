import type { ReadingService } from '../src/services/reading.js'

/** 等**当前**这轮分类浏览收手（`running` 之外即终态）。
 *
 *  只等「不再是 running」，**不带轮次身份断言**：续页会把同一轮重新点亮（同 id），拿 id 当闸会
 *  在续页那一段白等。轮询到超时也不抛——抛不抛由调用方的断言决定，这里只负责「等」，
 *  否则一个慢站点会变成一句「没收尾」的假红。
 *
 *  圈数只此一处：两份同口径的等待各写一个数，迟早一边说等过、一边说没等够。 */
export async function settleExploreRound(svc: ReadingService): Promise<void> {
  for (let i = 0; i < 200 && svc.exploreJobSnapshot()?.phase === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
}
