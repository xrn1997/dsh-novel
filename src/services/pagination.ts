/** 翻页闸跟进（目录/正文共用）：现状真相与口径见 docs/design/services.md 与 CONTEXT.md「判到底」。 */
import { listValue } from './bridge.js'
import type { Page, SubRuleEval } from './bridge.js'
import { isSameChapterPage } from './chapter-page.js'
import { absUrlKeepOption, canonUrl } from './request.js'
import type { Facet } from '../engine/index.js'

export interface FollowOptions {
  maxPages: number
  /** 正文分页专用：入口章地址——候选下一页必须仍属本章，否则停（防串章启发式，无目录知识时的兜底） */
  sameChapterBase?: string
  /** 目录已知章节地址（防串章的正判据）：候选 == 其他章节 URL → 停。
   *  提供时**取代**启发式——「下一页」指向 `?id=..&cid=..&page=2` 这类非页码键分页地址时，
   *  启发式会误拦（实测一批源「一章只解析出一页」的根因），而目录知识是正判据。 */
  stopUrls?: Set<string>
}
export interface FollowResult<T> { items: T[]; pages: number; stoppedBy: 'end' | 'zero-new' | 'loop' | 'cap' | 'chapter-boundary' }

interface QueueEntry { url: string; chain: boolean }

/**
 * 翻页跟进：
 * - **next 规则按列表语义求值**（逐项绝对化 + 去重 + 丢空）：1 个候选 → 链式跟进
 *   （每页继续求值 next）；多个候选 → 全部抓取但**不递归翻页**（多候选意味着这一页已把
 *   同章各分页列全，再翻会越界）；
 * - 防环按 **URL 已见**，条目去重按 keyOf；
 * - 判到底三态：本页 0 条 → zero-new（空页之后的页不可信）；本页有条目但 0 新增 → loop
 *   （**部分重复不再停**——目录翻页只按 URL 防环、条目最后统一去重，站点页间重叠是常态，
 *   此前「出现重复条目即停」把重叠的真实页截断）；上限 → cap；
 * - 串章闸：stopUrls（目录知识：下一页 == 下一章 URL → 停）优先，
 *   无目录知识才回退路径启发式 isSameChapterPage（判不准宁漏页不串章）。
 */
export async function followPages<T>(
  startUrl: string, fetchPage: (url: string) => Promise<Page>,
  extract: (page: Page) => Promise<T[]>, nextRule: string,
  keyOf: (item: T) => string, opts: FollowOptions, facet: Facet, subEval: SubRuleEval,
): Promise<FollowResult<T>> {
  const items: T[] = []
  const seenKeys = new Set<string>()
  const seenUrls = new Set<string>()
  const stopSet = opts.stopUrls === undefined ? undefined : new Set([...opts.stopUrls].map((u) => canonUrl(u)))
  const queue: QueueEntry[] = [{ url: startUrl, chain: true }]
  let pages = 0
  let stoppedBy: FollowResult<T>['stoppedBy'] = 'end'
  outer: while (queue.length > 0) {
    const entry = queue.shift()!
    if (seenUrls.has(entry.url)) continue
    if (pages >= opts.maxPages) { stoppedBy = 'cap'; break }
    seenUrls.add(entry.url)
    const page = await fetchPage(entry.url)
    pages++
    const pageItems = await extract(page)
    let newCount = 0
    for (const it of pageItems) {
      const k = keyOf(it)
      if (seenKeys.has(k)) continue
      seenKeys.add(k); items.push(it); newCount++
    }
    if (pageItems.length === 0) { stoppedBy = 'zero-new'; break }   // 零新增闸：空页不追 next
    if (newCount === 0) { stoppedBy = 'loop'; break }               // 回环闸：整页零新增 = 到底/软404
    if (!entry.chain) continue // 多 URL 模式：本页不再求值 next
    // next 规则：**列表语义**（逐项绝对化 + 去重 + 丢空）
    const nv = await subEval(nextRule, { html: page.body, json: page.json, baseUrl: page.url }, facet, 'value')
    const rawList = listValue(nv, facet) ?? []
    const nexts: string[] = []
    for (const href of rawList) {
      const cand = absUrlKeepOption(href, page.url)
      if (cand === null || cand === '' || seenUrls.has(cand) || nexts.includes(cand)) continue
      nexts.push(cand)
    }
    // 串章闸：目录知识优先（候选 == 其他章节 URL → 到底）；启发式只在无目录知识时兜底
    for (const cand of nexts) {
      if (stopSet !== undefined) {
        if (stopSet.has(canonUrl(cand))) { stoppedBy = 'chapter-boundary'; break outer }
      } else if (opts.sameChapterBase !== undefined && !isSameChapterPage(cand, opts.sameChapterBase)) {
        stoppedBy = 'chapter-boundary'; break outer
      }
    }
    const chain = nexts.length === 1
    for (const cand of nexts) queue.push({ url: cand, chain })
  }
  return { items, pages, stoppedBy }
}
