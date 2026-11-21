import { RuleEvalError } from '../engine/index.js'
import type { Facet } from '../engine/index.js'
import { detailContextOf, firstValue, itemContextsOf, staticTocUrl, tocUrlFromContext, urlFieldOf } from './bridge.js'
import type { Page, SubRuleEval } from './bridge.js'
import type { PageCache } from './cache.js'
import { contentSlot, rulesEpoch } from './cache-epoch.js'
import { normalizeChapterText } from '../shared/chapter-text.js'
import { contentToText } from './content.js'
import { ChapterNotFoundError, RuleMissingError, SourceNotFoundError } from './errors.js'
import { lruGet, lruSet } from './lru.js'
import { log } from './log.js'
import { followPages } from './pagination.js'
import type { FollowResult } from './pagination.js'
import { absUrlKeepOption, assembleRequest, canonUrl, stripUrlOption } from './request.js'
import type { Shelf } from './shelf.js'
import type { SourceEval } from './source-eval.js'
import { fetchSourceText } from './source-request.js'
import type { SourceRequest } from './source-request.js'
import type { NovelSource } from './types.js'
import type { ChapterEntry } from '../shared/wire.js'

/**
 * 在线阅读：一条在线书的**目录**与**正文**取值管线（缓存优先 → 目录在途去重 → 翻页跟进 → 缓存写回）。缓存键、在途身份、
 * 代际、翻页闸、subContent 与空正文策略只住这一处；本地/在线分流归 `book-content`（`ADR-0047`），本模块刻意**不含**本地书。
 */

/** 一次在线阅读的部件注入面：源查找、书架镜像、文件缓存、出站请求与源求值各交一格。 */
export interface OnlineReadingParts {
  sourceOf(id: string): NovelSource | undefined
  shelf: Shelf
  cache: PageCache
  request: SourceRequest
  sourceEvalFor(source: NovelSource): SourceEval
  tocMaxPages: number
  contentMaxPages: number
}

/** 目录在途请求的身份：同源同书还不够，代际与 refresh 也必须各占一条——只按源+书归并，后到的强制刷新会并入先到的普通读取、
 *  拿回旧结果；代际并入身份让换规则后的读单独起飞，旧在途与新读各走各的键，不需要取消通道。 */
function tocReadKey(sourceId: string, bookUrl: string, epoch: string, refresh: boolean): string {
  return JSON.stringify([sourceId, bookUrl, epoch, refresh])
}

/** 目录内存条目：规范化地址集合与目录同生共死。两份值都是**共享**的，消费方不得原地改——要改先复制。 */
interface TocMemo {
  chapters: ChapterEntry[]
  /** 全目录的 `canonUrl` 结果：串章闸的 stopUrls，避免每章重规范化整本目录。 */
  canonicalUrls: Set<string>
}

/** 目录内存缓存上限：读面一次只读一本，留几本给换书/返回；超出按最久未用淘汰。 */
const TOC_MEMO_LIMIT = 8

/** 追加地址进日志前脱敏：定位需要 origin + path，query / fragment 里的签名、过期 token 不该进宿主持久日志；解析不出就截断。 */
function redactSubUrl(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.origin}${url.pathname}${url.search === '' ? '' : '?…'}${url.hash === '' ? '' : '#…'}`
  } catch {
    return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw
  }
}

/** 脱敏错误消息里自带的地址：`FetchError` 的措辞就带 `<url>`，只脱敏单独打印的链接不够。 */
function redactUrlsIn(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>）)]+/gi, (url) => redactSubUrl(url))
}

export class OnlineReading {
  private readonly tocInflight = new Map<string, Promise<TocMemo>>()
  private readonly tocMemo = new Map<string, TocMemo>()
  /** refresh 写回即 +1：普通读只在自己起飞后没有 refresh 写回时才允许覆盖内存目录——晚到的旧结果不能把刚刷新的那一份盖回去。 */
  private memoWriteSeq = 0
  private readonly parts: OnlineReadingParts

  constructor(parts: OnlineReadingParts) {
    this.parts = parts
  }

  /** 目录：进程内缓存优先（refresh 绕过）+ 磁盘缓存/in-flight 去重（身份见 `tocReadKey`）+ 翻页闸跟进。`async` 只为把源查找的
   *  抛错收成 rejection；在途登记在返回前同步完成——同身份的并发读仍能 join 到同一发。 */
  async toc(sourceId: string, bookUrl: string, opts?: { refresh?: boolean }): Promise<ChapterEntry[]> {
    return (await this.tocMemoOf(sourceId, bookUrl, opts)).chapters
  }

  /** 目录 + 规范化地址集一起取：章节正文既要目录知识，也要 stopUrls；两者只算一次。 */
  private async tocMemoOf(
    sourceId: string, bookUrl: string, opts?: { refresh?: boolean },
  ): Promise<TocMemo> {
    const s = this.requireSource(sourceId)
    // 代际在起飞前算一次，读与写共用同一个值：在途请求写的就是它起飞时的代际，换规则后的读永远看不见。
    const epoch = rulesEpoch(s.rules, s.baseUrl, 'toc')
    const memoKey = tocReadKey(sourceId, bookUrl, epoch, false)
    if (opts?.refresh !== true) {
      const hit = lruGet(this.tocMemo, memoKey)
      if (hit !== undefined) return hit
    }
    const key = tocReadKey(sourceId, bookUrl, epoch, opts?.refresh === true)
    const inflight = this.tocInflight.get(key)
    if (inflight !== undefined) return inflight
    const writeSeq = this.memoWriteSeq
    const p = this.getTocInner(s, bookUrl, epoch, opts)
      .then((chapters) => {
        const memo: TocMemo = {
          chapters,
          canonicalUrls: new Set(chapters.map((c) => canonUrl(c.url))),
        }
        // refresh 的结果也写回非 refresh 槽：普通读只有起飞后没发生过 refresh 写回才写——并发时宁少存一次，也不让旧目录盖回新目录。
        if (opts?.refresh === true) {
          lruSet(this.tocMemo, memoKey, memo, TOC_MEMO_LIMIT)
          this.memoWriteSeq += 1
        } else if (this.memoWriteSeq === writeSeq) {
          lruSet(this.tocMemo, memoKey, memo, TOC_MEMO_LIMIT)
        }
        return memo
      })
      .finally(() => { this.tocInflight.delete(key) })
    this.tocInflight.set(key, p)
    return p
  }

  /** 章节正文（**文字面**）：缓存优先（refresh 跳过）；目录缺章报错；多页串接；**首屏**的 Miss 与零命中抛 RuleEvalError
   *  不吞（续页取空按到底收手）。本地书不走这里。 */
  async chapterText(sourceId: string, bookKey: string, chIndex: number, opts?: { refresh?: boolean }): Promise<string> {
    const s = this.requireSource(sourceId)
    const epoch = rulesEpoch(s.rules, s.baseUrl, 'content')
    // 目录上移到缓存读取之前：正文槽位含章名（挡章序位移串配，矩阵 `g-cache-slot-chapter-name`）。代价如实记：热正文缓存不再能
    // 单独服务一章——目录缺失时会真发一次目录抓取（章名只存在于目录里，这是必然代价）。
    const tocMemo = await this.tocMemoOf(sourceId, bookKey)
    const toc = tocMemo.chapters
    // 双边守卫合并在取位处：负数与越上界同样取不到，取位失败按 404 那一类交回；HTTP 面有 /^\d+$/ 而工具面无下限，守卫须盖住两面。
    const target = toc[chIndex]
    if (target === undefined) throw new ChapterNotFoundError(chIndex, toc.length)
    const slot = contentSlot(epoch, target.name)
    if (opts?.refresh !== true) {
      const cached = await this.parts.cache.getContent(sourceId, bookKey, chIndex, slot)
      if (cached !== null) {
        // 代际只覆盖规则、不覆盖代码版本：升级后仍会读到旧提取代码写下的条目——出边界再收一次口（contentToText 幂等）。
        const text = contentToText(cached)
        // 空正文一律当未命中：0 字节缓存会永远吐空（不要静默写入），借此失效重取
        if (text.trim() !== '') return text
      }
    }
    const ruleContent = s.rules.ruleContent
    if (ruleContent === null) {
      // 正文规则缺失不得降级 `?? ''`
      throw new RuleMissingError('content', 'ruleContent', `源「${s.name}」缺正文规则 ruleContent`)
    }
    // 变量注入：`book`（规则里存在拿 book.bookUrl 做字符串替换的写法）与 `chapter`（title/index/url——正文脚本广泛使用）；
    // 按面注入的字段清单见矩阵行 `h-book-mirror-fields`。
    const shelfBook = this.parts.shelf.get(bookKey)
    const subEval = this.parts.sourceEvalFor(s)
      .subEval({
        book: { bookUrl: bookKey, origin: s.baseUrl, tocUrl: bookKey, ...(shelfBook === undefined ? {} : { shelfBook }) },
        chapter: {
          title: target.name, index: chIndex, url: target.url, baseUrl: target.url,
          vip: target.isVip === true, volume: target.isVolume === true, pay: target.isPay === true,
          updateTime: target.updateTime ?? '',
        },
      })
    // 「空正文必炸」管的是**首屏**：跟进链上的续页取不出正文只说明这一章到此为止，不许把已拼好的首屏一起判死（最后一章的
    // 「下一章」常指向书详情页，那页没有正文容器）。首屏那一半一字未放宽：空正文仍然抛、仍然不写缓存（矩阵 `g-content-empty-exception`）。
    // 续页交空数组即可——`followPages` 的 zero-new 闸本就负责停跟进。
    const subContentRule = s.rules.ruleContentSubContent ?? null
    let pageSeq = 0
    // 取值走对象字段而不是局部 let：extract 在闭包里赋值，TS 的流分析不会把那次赋值算进来
    const lastPage: { page: Page | null } = { page: null }
    const extract = async (page: Page): Promise<string[]> => {
      const firstPage = pageSeq++ === 0
      lastPage.page = page
      const v = await subEval(ruleContent, { html: page.body, json: page.json, baseUrl: page.url }, 'content', 'value')
      const text = firstValue(v, 'content')
      if (text === null) {
        if (firstPage) {
          throw new RuleEvalError('正文规则没取到内容', {
            facet: 'content', segmentIndex: 0, segmentRaw: ruleContent, hits: 0,
          })
        }
        return []
      }
      // 正文契约是纯文本：@html 类规则收回的是 HTML 片段——先转纯文本再走行规约（矩阵 `g-html-to-text`）。
      const plain = normalizeChapterText(contentToText(text))
      if (plain.trim() === '') {
        // 零命中不得静默：把空正文当正常结果写进缓存会让整章 0 字节。报错带规则与落点（请求地址 + 实际落地地址）。
        if (!firstPage) return []
        const landed = page.requestedUrl === undefined || page.requestedUrl === page.url
          ? page.url
          : `${page.requestedUrl} → ${page.url}`
        throw new RuleEvalError(`正文规则零命中（段 ruleContent: ${ruleContent}；页面落点 ${landed}）`, {
          facet: 'content', segmentIndex: 0, segmentRaw: ruleContent, hits: 0,
        })
      }
      return [plain]
    }
    const result = await this.followOrSingle(
      target.url,
      (u) => this.fetchPage(s, u),
      extract,
      s.rules.nextPageUrl,         // null → 短路单页（该源无翻页发现能力，不做 next 跟进）
      (text) => text,              // 整页文本做 key：重复页触发回环闸
      this.parts.contentMaxPages,
      'content',
      subEval,
      {
        // 串章闸：候选「下一页」== 目录里其他章节 URL → 到底。目录知识是正判据——路径启发式会把 `?cid=..&page=2` 这类
        // 非页码键分页误判成串章；启发式仅在无目录知识时兜底（见 pagination.ts）。规范化集合随目录缓存一次，当前章用 except 放行。
        stopUrls: tocMemo.canonicalUrls,
        stopUrlExcept: canonUrl(target.url),
      },
    )
    let text = result.items.join('\n')
    // subContent 在**拼页之后**求值（用循环结束那一刻的末页上下文），以 http 开头时先把那页取回来当子正文；链接坏了不许把整章判死。
    let subFetchFailed = false
    if (subContentRule !== null && lastPage.page !== null) {
      const sub = firstValue(
        await subEval(subContentRule, { html: lastPage.page.body, json: lastPage.page.json, baseUrl: lastPage.page.url }, 'content', 'value'),
        'content',
      )
      if (sub !== null && sub.trim() !== '') {
        const raw = sub.trim()
        // 「取回失败」与「取回后为空」是两种值，不许折叠（同 `ADR-0002` 那一族）：空 = 这源此刻确实没有追加段，落缓存没问题；
        // 失败 = 我们不知道——一次瞬时 503 若跟着落盘，「缺追加段的残章」就钉在这个槽位上。因此失败照读、留痕，但**不落缓存**。
        let body = raw
        if (/^https?:\/\//i.test(raw)) {
          try {
            body = await fetchSourceText(this.parts.request, s, raw)
          } catch (e) {
            body = ''
            subFetchFailed = true
            log.warn(`子正文取回失败（源「${s.name}」第 ${chIndex + 1} 章「${target.name}」，追加地址 ${redactSubUrl(raw)}）：`
              + `${redactUrlsIn(e instanceof Error ? e.message : String(e))}——本次只交正文页，且不落缓存`)
          }
        }
        const plainSub = normalizeChapterText(contentToText(body))
        if (plainSub.trim() !== '') text += '\n' + plainSub
      }
    }
    if (!subFetchFailed) await this.parts.cache.setContent(sourceId, bookKey, chIndex, slot, text)
    return text
  }

  /** 单页目录的取值与缓存写回（`toc` 的在途身份与代际由调用方算好）。 */
  private async getTocInner(s: NovelSource, bookUrl: string, epoch: string, opts?: { refresh?: boolean }): Promise<ChapterEntry[]> {
    if (opts?.refresh !== true) {
      const cached = await this.parts.cache.getToc(s.id, bookUrl, epoch)
      if (cached !== null) return cached
    }
    // 目录三规则任一缺失不得降级 `?? ''`——空串规则返回整页文本。列表选择器：对象方言取 ruleChapterList，平铺方言缺它时回退
    // ruleBookList（矩阵行 `d-book-list-fallback`）。
    const { ruleChapterName, ruleChapterUrl } = s.rules
    const listRule = s.rules.ruleChapterList ?? s.rules.ruleBookList
    if (listRule === null || ruleChapterName === null || ruleChapterUrl === null) {
      throw new RuleMissingError('toc', 'ruleChapterList/ruleBookList',
        `源「${s.name}」缺目录规则（ruleChapterList/ruleBookList 之一 + ruleChapterName/ruleChapterUrl）——无法构建目录`)
    }
    // `book` 变量：目录规则常见 `book.bookUrl`（章地址由它替换出来）与 `book.origin`（ruleTocUrl 用 `{{book.origin}}` 拼目录页）；
    // 按面注入的字段清单见矩阵行 `h-book-mirror-fields`。
    const tocShelfBook = this.parts.shelf.get(bookUrl)
    const subEval = this.parts.sourceEvalFor(s)
      .subEval({
        book: { bookUrl, origin: s.baseUrl, tocUrl: bookUrl, ...(tocShelfBook === undefined ? {} : { shelfBook: tocShelfBook }) },
      })
    const tocUrl = await tocUrlOf(s.rules.ruleTocUrl, s.rules.ruleDetailInit, bookUrl,
      () => fetchSourceText(this.parts.request, s, bookUrl), subEval)
    const isVipRule = s.rules.ruleChapterIsVip ?? null
    const isVolumeRule = s.rules.ruleChapterIsVolume ?? null
    const isPayRule = s.rules.ruleChapterIsPay ?? null
    const updateTimeRule = s.rules.ruleChapterUpdateTime ?? null
    const extract = async (page: Page): Promise<ChapterEntry[]> => {
      const listV = await subEval(listRule, { html: page.body, json: page.json, baseUrl: page.url }, 'toc', 'list')
      const out: ChapterEntry[] = []
      let fellBack = 0
      for (const ctx of itemContextsOf(listV, page.url)) {
        const name = firstValue(await subEval(ruleChapterName, ctx, 'toc', 'value'), 'toc')
        // 章地址是 URL 位（多命中取首项，理由单点在 bridge.urlFieldOf，矩阵行 `b-url-value-first-item`）
        const href = await urlFieldOf(subEval, ruleChapterUrl, ctx, 'toc')
        const flagOf = async (rule: string | null): Promise<boolean> =>
          rule !== null && isTrueRuleValue(firstValue(await subEval(rule, ctx, 'toc', 'value'), 'toc'))
        const vip = await flagOf(isVipRule)
        const volume = await flagOf(isVolumeRule)
        const pay = await flagOf(isPayRule)
        const updateTime = updateTimeRule === null
          ? undefined
          : firstValue(await subEval(updateTimeRule, ctx, 'toc', 'value'), 'toc') ?? undefined
        // 章节 URL 常带 `,{"webView":true}` 等选项后缀——**保留后缀落库**，抓取时由 fetchPage → assembleRequest 解释（矩阵
        // `b-url-option-on-chapter-url`）；URL 取不到时回退目录页地址（`url null → 跳过` 会把整站目录清成 0 章，矩阵 `f-toc-url-fallback`）。
        const missing = href === null || href.trim() === ''
        const url = href !== null && href.trim() !== '' ? absUrlKeepOption(href, page.url) : page.url
        if (name !== null && url !== null) {
          if (missing) fellBack++
          out.push({
            name, url,
            ...(vip ? { isVip: true } : {}),
            ...(volume ? { isVolume: true } : {}),
            ...(pay ? { isPay: true } : {}),
            ...(updateTime === undefined ? {} : { updateTime }),
          })
        }
      }
      // 逐章回退只服务「个别条目缺链接」；**每一条都回退** = ruleChapterUrl 整体失效，静默产出指向目录页自身的 toc 是拿合法形状冒充成功。
      if (out.length > 0 && fellBack === out.length) {
        throw new RuleEvalError(
          `目录 URL 规则未取到任何章节地址（段 ruleChapterUrl: ${ruleChapterUrl}；${out.length} 条全部回退目录页 ${page.url}）`,
          { facet: 'toc', segmentIndex: 0, segmentRaw: ruleChapterUrl, hits: 0 },
        )
      }
      return out
    }
    const result = await this.followOrSingle(
      tocUrl,
      (u) => this.fetchPage(s, u),
      extract,
      s.rules.nextTocUrl,          // null → 短路单页（该源无翻页发现能力，不做 next 跟进）
      (c) => c.url,
      this.parts.tocMaxPages,
      'toc',
      subEval,
    )
    const chapters = result.items
    await this.parts.cache.setToc(s.id, bookUrl, epoch, chapters)
    return chapters
  }

  /** 短路：next 规则 null → 单页提取（无翻页发现能力，直接 end）；非 null → 走翻页闸 followPages（收到的 nextRule 永远非空）。 */
  private async followOrSingle<T>(
    startUrl: string,
    fetchPage: (url: string) => Promise<Page>,
    extract: (page: Page) => Promise<T[]>,
    nextRule: string | null,
    keyOf: (item: T) => string,
    maxPages: number,
    facet: Facet,
    subEval: SubRuleEval,
    followOpts?: { sameChapterBase?: string; stopUrls?: ReadonlySet<string>; stopUrlExcept?: string },
  ): Promise<FollowResult<T>> {
    if (nextRule === null) {
      const page = await fetchPage(startUrl)
      return { items: await extract(page), pages: 1, stoppedBy: 'end' }
    }
    return followPages(startUrl, fetchPage, extract, nextRule, keyOf, { maxPages, ...followOpts }, facet, subEval)
  }

  private requireSource(id: string): NovelSource {
    const s = this.parts.sourceOf(id)
    if (s === undefined) throw new SourceNotFoundError(id)
    return s
  }

  /** 抓取一页：URL 可带 `,{option}` 选项后缀——选项语义走 assembleRequest 单点，charset 声明进解码链；`webView`/`webJs` 选项走真浏览器，浏览器 cookie 回灌 HTTP jar。 */
  private async fetchPage(s: NovelSource, url: string): Promise<Page> {
    const plan = assembleRequest(url, {}, s.baseUrl)
    return this.parts.request.fetchPage(s, plan)
  }

}

// ── 模块级纯函数（逐条口径写在各条头上）─────────────────────────────

/** tocUrl 解析（钉死）：null→bookUrl **全串**（抓取仍按选项发请求）；纯静态 URL → 字面绝对化，不抓详情页；其余（插值模板与规则
 *  形态）→ 按**详情上下文**过引擎（init 换根后嵌套字段才有解；按空 vars 插值会留下残地址 → 0 章）。短路判据与上下文求值分别住
 *  `bridge.staticTocUrl` / `bridge.tocUrlFromContext`；求值走调用方的 subEval。 */
export async function tocUrlOf(
  ruleTocUrl: string | null, ruleDetailInit: string | null,
  bookUrl: string, detailHtml: () => Promise<string | null>, subEval: SubRuleEval,
): Promise<string> {
  if (ruleTocUrl === null) return bookUrl
  const direct = staticTocUrl(ruleTocUrl, bookUrl)
  if (direct !== null) return direct
  const html = await detailHtml()
  if (html === null) return bookUrl
  // 解析 base 剥 `,{option}`（选项不属于链接解析域）
  const dctx = await detailContextOf(ruleDetailInit, html, stripUrlOption(bookUrl), subEval)
  return tocUrlFromContext(ruleTocUrl, dctx, bookUrl, subEval)
}

/** 规则值折布尔的口径（本仓唯一实现）：空/字面 null 与整串 `false|no|not|0|0.0` 为假，其余非空为真。 */
function isTrueRuleValue(v: string | null): boolean {
  if (v === null) return false
  const t = v.trim()
  if (t === '' || t.toLowerCase() === 'null') return false
  return !/^(?:false|no|not|0|0\.0)$/i.test(t)
}
