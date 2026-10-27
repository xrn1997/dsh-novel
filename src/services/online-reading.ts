import { RuleEvalError } from '../engine/index.js'
import type { Facet } from '../engine/index.js'
import { detailContextOf, firstValue, itemContextsOf, staticTocUrl, tocUrlFromContext, urlFieldOf } from './bridge.js'
import type { Page, SubRuleEval } from './bridge.js'
import type { PageCache } from './cache.js'
import { contentSlot, rulesEpoch } from './cache-epoch.js'
import { normalizeChapterText } from './chapter-content.js'
import { contentToText } from './content.js'
import { ChapterNotFoundError, RuleMissingError, SourceNotFoundError } from './errors.js'
import { lruGet, lruSet } from './lru.js'
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
 * 在线阅读：一条在线书的**目录**与**正文**取值管线（缓存优先 → 目录在途去重 → 翻页跟进 → 缓存写回）。
 * 缓存键、在途身份、代际、翻页闸、subContent 与空正文策略只住这一处；本地/在线分流归
 * `book-content` 的 `BookContent`，门面只委托——
 * 为的是这几条语义不必拼齐整部门面部件就能被测到（裁决见 `docs/adr/0047`）。
 *
 * 刻意**不含**本地书：本地书不认识 HTTP 与在线缓存，塞进来会扩大 interface。
 * 缓存有效性判据仍由 `cache-epoch` 给，本模块只消费。
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

/** 目录在途请求的身份：同源同书还不够，代际与 refresh 也必须各占一条。
 *  只按源+书归并，后到的强制刷新会并入先到的普通读取、拿回它没打算要的旧结果；
 *  代际并入身份则让换规则后的读单独起飞——`toc` 起飞前取一次 `rulesEpoch`，在途写回按
 *  起飞时的代际落盘（`getTocInner`），旧在途与新读各走各的键，不需要取消通道。 */
function tocReadKey(sourceId: string, bookUrl: string, epoch: string, refresh: boolean): string {
  return JSON.stringify([sourceId, bookUrl, epoch, refresh])
}

/** 目录内存条目：规范化地址集合与目录同生共死，章节正文读取直接复用。
 *  两份值都是**共享**的（同一数组/集合交给每个读者），消费方不得原地改——要改先复制。 */
interface TocMemo {
  chapters: ChapterEntry[]
  /** 全目录的 `canonUrl` 结果：串章闸的 stopUrls，避免每章重规范化整本目录。 */
  canonicalUrls: Set<string>
}

/** 目录内存缓存上限：读面一次只读一本，留几本给换书/返回；超出按最久未用淘汰。 */
const TOC_MEMO_LIMIT = 8

export class OnlineReading {
  private readonly tocInflight = new Map<string, Promise<TocMemo>>()
  private readonly tocMemo = new Map<string, TocMemo>()
  /** refresh 写回即 +1：普通读只在自己起飞后没有 refresh 写回时才允许覆盖内存目录——
   *  在途普通读可能读的是刷新前的盘，晚到的旧结果不能把刚刷新的那一份盖回去。 */
  private memoWriteSeq = 0

  constructor(private readonly parts: OnlineReadingParts) {}

  /** 目录：进程内缓存优先（refresh 绕过）+ 磁盘缓存/in-flight 去重（身份见 `tocReadKey`）+ 翻页闸跟进。
   *  `async` 只为把源查找的抛错收成 rejection：HTTP 面与工具面都按 promise 消费，
   *  同步 throw 会漏出契约。在途登记在返回前同步完成——同身份的并发读仍能 join 到同一发。 */
  async toc(sourceId: string, bookUrl: string, opts?: { refresh?: boolean }): Promise<ChapterEntry[]> {
    return (await this.tocMemoOf(sourceId, bookUrl, opts)).chapters
  }

  /** 目录 + 规范化地址集一起取：章节正文既要目录知识，也要 stopUrls；两者只算一次。 */
  private async tocMemoOf(
    sourceId: string, bookUrl: string, opts?: { refresh?: boolean },
  ): Promise<TocMemo> {
    const s = this.requireSource(sourceId)
    // 代际在起飞前算一次，读与写共用同一个值：在途请求写的就是它起飞时的代际，
    // 换规则后的读永远看不见（这就是「旧在途写回」不需要取消通道的原因）
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
        // refresh 的结果也写回非 refresh 槽：下一次普通读取看到的是刚刷新的目录。
        // 普通读只有起飞后没发生过 refresh 写回才写：并发时宁少存一次，也不让旧目录盖回新目录。
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

  /** 章节正文（**文字面**）：缓存优先（refresh 跳过）；目录缺章报错；多页串接；
   *  **首屏**的 Miss 与零命中抛 RuleEvalError 不吞（续页取空按到底收手，见 `chapterText` 的 extract 口径）。
   *  本地书不走这里。 */
  async chapterText(sourceId: string, bookKey: string, chIndex: number, opts?: { refresh?: boolean }): Promise<string> {
    const s = this.requireSource(sourceId)
    const epoch = rulesEpoch(s.rules, s.baseUrl, 'content')
    // 目录上移到缓存读取之前：正文槽位含章名（挡章序位移串配，见 cache-epoch.contentSlot，
    // 矩阵行 `g-cache-slot-chapter-name`）。代价如实记：热正文缓存不再能单独服务一章——
    // 目录缺失时会真发一次目录抓取（章名只存在于目录里，这是必然代价不是疏忽）。
    const tocMemo = await this.tocMemoOf(sourceId, bookKey)
    const toc = tocMemo.chapters
    // 双边守卫：只拦上界会让负数绕过 → toc[-1].name TypeError → 500；
    // HTTP 面有 /^\d+$/ 而工具面无下限，守卫必须盖住两面入口。
    if (chIndex < 0 || chIndex >= toc.length) throw new ChapterNotFoundError(chIndex, toc.length)
    const target = toc[chIndex]
    const slot = contentSlot(epoch, target.name)
    if (opts?.refresh !== true) {
      const cached = await this.parts.cache.getContent(sourceId, bookKey, chIndex, slot)
      if (cached !== null) {
        // 代际只覆盖规则、不覆盖代码版本：升级后仍会读到旧提取代码写下的条目（如 @html 源的
        // 带标签正文）——出边界再收一次口（contentToText 幂等），旧条目照样无害。
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
    // 变量注入：`book`（bookUrl/name…——36小说网 ruleChapterUrl 用 book.bookUrl.replace）
    // 与 `chapter`（title/index/url——正文脚本 `chapter.title` 广泛使用）
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
    // 「空正文必炸」管的是**首屏**：跟进链上的续页取不出正文，只说明这一章到此为止，
    // 不许把已经拼好的首屏一起判死（真机形状：最后一章的「下一章」链接指向书详情页，
    // 那页没有正文容器；若整章抛错，前两页的正文会一并丢掉）。
    // 首屏那一半一字未放宽：空正文仍然抛、仍然不写缓存（矩阵行 `g-content-empty-exception`）。
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
      // 正文契约是纯文本：@html 类规则收回的是 HTML 片段（否则一串 <p> 原样打给读者）——
      // 先转纯文本再走行规约（矩阵行 `g-html-to-text`）
      const plain = normalizeChapterText(contentToText(text))
      if (plain.trim() === '') {
        // 零命中不得静默：把空正文当正常结果写进缓存会让整章 0 字节，用户只见「不出正文」。
        // 报错带规则与落点（请求地址 + 实际落地地址，两者不同即被跳转走了）——矩阵行 `g-content-empty-exception`。
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
        // 串章闸：候选「下一页」== 目录里其他章节 URL → 到底。
        // 目录知识是正判据——路径启发式会把 `?id=..&cid=..&page=2` 这类非页码键分页误判成串章
        // （「一章只解析出一页」的根因之一）；启发式仅在无目录知识时兜底（见 pagination.ts）。
        // 规范化集合随目录缓存一次，当前章用 except 放行——不每章复制整表。
        stopUrls: tocMemo.canonicalUrls,
        stopUrlExcept: canonUrl(target.url),
      },
    )
    let text = result.items.join('\n')
    // subContent 在**拼页之后**求值（上游 BookContent.kt 口径：循环结束后用 analyzeRule 的末页上下文），
    // 以 http 开头时先把那页取回来当子正文；取不到/为空静默跳过——它是追加物，不该把整章判死。
    if (subContentRule !== null && lastPage.page !== null) {
      const sub = firstValue(
        await subEval(subContentRule, { html: lastPage.page.body, json: lastPage.page.json, baseUrl: lastPage.page.url }, 'content', 'value'),
        'content',
      )
      if (sub !== null && sub.trim() !== '') {
        const raw = sub.trim()
        const body = /^https?:\/\//i.test(raw) ? await fetchSourceText(this.parts.request, s, raw) : raw
        const plainSub = normalizeChapterText(contentToText(body))
        if (plainSub.trim() !== '') text += '\n' + plainSub
      }
    }
    await this.parts.cache.setContent(sourceId, bookKey, chIndex, slot, text)
    return text
  }

  /** 单页目录的取值与缓存写回（`toc` 的在途身份与代际由调用方算好）。 */
  private async getTocInner(s: NovelSource, bookUrl: string, epoch: string, opts?: { refresh?: boolean }): Promise<ChapterEntry[]> {
    if (opts?.refresh !== true) {
      const cached = await this.parts.cache.getToc(s.id, bookUrl, epoch)
      if (cached !== null) return cached
    }
    // 目录三规则任一缺失不得降级 `?? ''`——空串规则返回整页文本，宁炸不猜
    // 列表选择器：ruleChapterList（对象方言）；平铺方言缺它时回退 ruleBookList（平铺口径：
    // 搜索/目录共用列表规则，两方言列表不同——矩阵行 `d-book-list-fallback`）
    const { ruleChapterName, ruleChapterUrl } = s.rules
    const listRule = s.rules.ruleChapterList ?? s.rules.ruleBookList
    if (listRule === null || ruleChapterName === null || ruleChapterUrl === null) {
      throw new RuleMissingError('toc', 'ruleChapterList/ruleBookList',
        `源「${s.name}」缺目录规则（ruleChapterList/ruleBookList 之一 + ruleChapterName/ruleChapterUrl）——无法构建目录`)
    }
    // `book` 变量：目录规则常见 `book.bookUrl`（36小说网 chapterUrl）与 `book.origin`
    // （努努书坊 ruleTocUrl `{{book.origin}}/e/...`——源站点域名即注册表 baseUrl）
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
        // 章节 URL 常带 `,{"webView":true}` 等选项后缀（嗅探语义）——**保留后缀落库**，
        // 抓取时由 fetchPage → assembleRequest 解释（矩阵行 `b-url-option-on-chapter-url`）；
        // URL 取不到时回退目录页地址——不整条丢弃（「url null → 跳过」会把整站目录清成 0 章，
        // 矩阵行 `f-toc-url-fallback`）
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
      // 逐章回退只服务「个别条目缺链接」；**每一条都回退** = ruleChapterUrl 整体失效，
      // 静默产出指向目录页自身的 toc 是拿合法形状冒充成功（宁炸不猜）。
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

  /**
   * next 规则短路：null → 单页提取（无翻页发现能力，直接 end）；
   * 非 null → 走翻页闸 followPages。followPages 收到的 nextRule 永远非空。
   */
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

  /** 抓取一页：URL 可带 `,{option}` 选项后缀（章节/下一页/目录 URL 的嗅探语义）——
   *  选项语义走 assembleRequest 单点，charset 声明进解码链（优先级最高）；
   *  `webView`/`webJs` 选项走真浏览器（`b-opt-webview`），浏览器 cookie 回灌 HTTP jar。 */
  private async fetchPage(s: NovelSource, url: string): Promise<Page> {
    const plan = assembleRequest(url, {}, s.baseUrl)
    return this.parts.request.fetchPage(s, plan)
  }

}

// ── 模块级纯函数（逐条口径写在各条头上）─────────────────────────────

/** tocUrl 解析（钉死）：null→bookUrl **全串**（回退即「目录在本书地址上」——抓取仍按选项发请求）；
 *  纯静态 URL → 字面绝对化，不抓详情页；其余（带 `{{$.…}}` 插值段的 URL 模板与一切规则形态）
 *  → 按**详情上下文**过规则引擎求值（init 换根后嵌套字段才有解；按空 vars 插值会留下残地址
 *  → 0 章）。本函数只剩「什么时候需要详情页」这一件事：短路判据与上下文求值分别住
 *  `bridge.staticTocUrl` / `bridge.tocUrlFromContext`（`detailReadOf` 共用同一份）。
 *  求值走调用方的 subEval（完整上下文单点——jsLib/vars/fetch/source 全可见）。 */
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

/** 上游 `String.isTrue` 口径：空/字面 null 与整串 `false|no|not|0|0.0` 为假，其余非空为真。 */
function isTrueRuleValue(v: string | null): boolean {
  if (v === null) return false
  const t = v.trim()
  if (t === '' || t.toLowerCase() === 'null') return false
  return !/^(?:false|no|not|0|0\.0)$/i.test(t)
}
