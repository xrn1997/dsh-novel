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

/** 等**当前**这轮后台搜索收手（`running` 之外即终态）。
 *
 *  与 `settleExploreRound` 同一口径：只等「不再是 running」，轮询到超时也不抛——抛不抛由调用方的
 *  断言决定，这里只负责「等」，否则一个慢站点会变成一句「没收尾」的假红。收手之后要读终态结果，
 *  调用方自己再取一次 `searchJobSnapshot`（本函数不代持快照：读什么由用例决定）。
 *
 *  圈数只此一处：两份同口径的等待各写一个数，迟早一边说等过、一边说没等够。预算取两条旧抄本
 *  原用的 500 圈 × 5ms（2.5s）：搜索一轮并发打多源、慢源由用例按需放行，比 explore 单轮宽，
 *  收进来时原样保留，不顺手缩水。 */
export async function settleSearchJob(svc: ReadingService): Promise<void> {
  for (let i = 0; i < 500 && svc.searchJobSnapshot(0)?.phase === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
}
