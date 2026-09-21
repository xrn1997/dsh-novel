import type { ProbeErrorCode, ProbeResult } from '../shared/wire.js'
export type { ProbeResult, ProbeErrorCode } from '../shared/wire.js'
import { firstValue } from './bridge.js'
import { fetchSearchPage, searchErrorCodeOf } from './search-face.js'
import type { Fetcher } from './fetcher.js'
import type { NovelSource } from './types.js'

/** 探针关键词序列：单字「书」在个别站被搜索程序停用（实测 aijjxs 对「书」0 命中、其余词 1 命中）——
 * 首词 0 命中时逐词重试，任一命中即 verified；全部 0 命中才判 broken。 */
const PROBE_KEYS = ['书', '小说', '的'] as const

/**
 * search 面探针：真发一次搜索请求（关键词按 PROBE_KEYS 逐词重试），
 * ruleBookList ≥1 条目且首条 ruleBookName 非空 → ok；引擎/抓取错误按类归 code
 * 如实透出（message 用 e.message——引擎错误已含段级定位）；不吞错。
 * 只有「请求成功但 0 命中」换词重试——网络/规则异常立即返回，不多打请求。
 *
 * 请求语义全部走搜索面（search-face.ts）：模板解析/请求组装/超时/解码与聚合搜索同一实现——
 * timeoutMs 缺省时探针与搜索同认 ReadingService 的 searchTimeoutMs（此前探针只靠 fetcher 固定 15s）。
 */
export async function probeSource(
  source: NovelSource, fetcher: Fetcher, opts?: { timeoutMs?: number; jsTimeoutMs?: number },
): Promise<ProbeResult> {
  try {
    for (const key of PROBE_KEYS) {
      const page = await fetchSearchPage(source, key, fetcher, opts?.timeoutMs, opts?.jsTimeoutMs)
      if (!page.ok) return fail('RuleMissing', page.message, 0)
      if (page.items.length === 0) continue // 换下一词（0 命中可能是词被停用，非源坏）
      const nameRule = source.rules.ruleBookName
      if (nameRule === null) return fail('RuleMissing', '源未声明 ruleBookName', 0)   // 搜索面已拦；此处为类型收窄
      // usage='value'：与搜索面取书名同口径（`reading.ts` 对同一 ruleBookName、同一 item
      // 用 'value'）。规则以属性终端收尾（`@onclick`/`@_src`）时两种用途结果不同——
      // 探针漏传该参数会把搜索面读得出书名的源判成「首条书名为空」的坏源（2026-09 审查）。
      const first = firstValue(await page.subEval(nameRule, { html: page.items[0], baseUrl: page.landedUrl }, 'search', 'value'), 'search')
      if (first === null || first.trim() === '') {
        return fail('RuleEvalError', `首条书名为空（段 ruleBookName: ${nameRule}）`, page.items.length)
      }
      return { ok: true, itemCount: page.items.length, firstTitle: first, probedAt: Date.now() }
    }
    return fail('RuleEvalError',
      `搜索列表 0 命中（关键词${PROBE_KEYS.map((k) => `「${k}」`).join('')}均无结果；段 ruleBookList: ${source.rules.ruleBookList}）`, 0)
  } catch (e) {
    return { ok: false, itemCount: 0, firstTitle: null, error: { code: searchErrorCodeOf(e), message: messageOf(e) }, probedAt: Date.now() }
  }
}

function fail(code: ProbeErrorCode, message: string, itemCount: number): ProbeResult {
  return { ok: false, itemCount, firstTitle: null, error: { code, message }, probedAt: Date.now() }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
