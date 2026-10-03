import { absUrl, auxFieldOf, auxUrlFieldOf, fieldOf, firstValue, itemContextsOf, kindFieldOf, makeSubEval, resolveHeaders, urlFieldOf, wordCountFieldOf } from './bridge.js'
import { formatIntro } from './content.js'
import { fetchTextPage } from './fetcher.js'
import type { Fetcher } from './fetcher.js'
import { absUrlKeepOption, buildSearchRequest, fetchInitOf } from './request.js'
import type { SearchHit } from '../shared/wire.js'
import type { NovelSource } from './types.js'

/**
 * 发现面（书城分类）单源一次抓取：「发一次分类页请求并取回该分类的书目」的唯一实现。
 * 与搜索面同构，差别只有两处——URL 模板与规则来源：
 * 请求组装归 `request.buildSearchRequest`（`trimFirstPage` 就是原生方言「首页把 `/{{page}}` 段裁掉」
 * 那条既有语义，分类首页带 `/1` 的站点直接 404），抓取+解码归 `fetcher.fetchTextPage`（超时单点），
 * 条目取值归 `bridge` 的 `fieldOf`/`urlFieldOf`/`aux*` 一族与 `content.formatIntro`——
 * 本模块只持有分类面特有的编排，不复制其中任何一件。
 *
 * 规则缺失是**结果**（`ok:false`）：编排方要把它记成「这个源这个分类没有结果」，
 * 与抓取/解码失败（上抛，由编排方归类）分列——整轮不因此失败。
 */

export type KindPageResult =
  | { ok: false; code: 'RuleMissing'; message: string }
  | { ok: true; hits: SearchHit[] }

/** 一个源在一次分类抓取里要用的那**一整套**条目规则（键名即本模块内的位置，不另立模型字段）。 */
interface ExploreRules {
  list: string | null; name: string | null; author: string | null; url: string | null
  cover: string | null; intro: string | null; last: string | null
  kind: string | null; wordCount: string | null
}

/** 规则来源的整套切换：对面语义是「`ruleFind.ruleSearch.list` 非空就整套用它，否则整套回落通用
 *  搜索规则」，判据只看列表规则一条。**不许逐字段回落**——半套（列表用发现面的、书名用通用搜索的）
 *  会把源的意图读歪，且这种歪法在条目上表现为「标题全是另一个选择器的产物」而无人察觉。 */
function rulesFor(source: NovelSource): ExploreRules {
  const r = source.rules
  return r.ruleExploreList === null
    ? {
      list: r.ruleBookList, name: r.ruleBookName, author: r.ruleAuthor, url: r.ruleBookUrl,
      cover: r.ruleCoverUrl, intro: r.ruleIntro, last: r.ruleLastChapter,
      kind: r.ruleKind, wordCount: r.ruleWordCount,
    }
    : {
      list: r.ruleExploreList, name: r.ruleExploreName, author: r.ruleExploreAuthor, url: r.ruleExploreBookUrl,
      cover: r.ruleExploreCoverUrl, intro: r.ruleExploreIntro, last: r.ruleExploreLastChapter,
      kind: r.ruleExploreKind, wordCount: r.ruleExploreWordCount,
    }
}

/** 发一次分类页请求并取回条目。
 *  **第几页由调用方给**（缺省第 1 页）：一轮里抓哪些页、抓几页是编排方的事——书城先摊开首页，
 *  再翻才是用户点出来的（跨源翻页的代价是「分类数 × 页数」的请求数，所以「翻」不能是默认行为）。
 *  条目提取逐字段照 `ReadingService.searchOne` 的两档口径：书名非空才算书目，作者/书地址是裸奔项
 *  （缺即丢该条目），封面/简介/最新章节/分类/字数坏规则只丢该字段——两档的分野及其理由单点在
 *  `bridge.metaFieldOf`，此处不另立第三档。 */
export async function fetchKindPage(
  source: NovelSource, kindUrl: string, fetcher: Fetcher, timeoutMs?: number, jsTimeoutMs?: number,
  page = 1,
): Promise<KindPageResult> {
  const template = source.rules.ruleExploreUrl
  const R = rulesFor(source)
  // 书名规则缺失按**规则缺失**回报，而不是产出一串没有标题的书目：对面在这种源上会静默给 0 本，
  // 本仓的口径是「空结果不得冒充失败」，反过来让「读不出任何东西」冒充成一次正常空分类同样不许。
  if (template === null || R.name === null) {
    const missing = [
      template === null ? 'ruleFind.url' : null,
      R.name === null ? '书名规则' : null,
    ].filter((x): x is string => x !== null)
    return { ok: false, code: 'RuleMissing', message: `发现规则缺失：缺 ${missing.join('、')}` }
  }
  const subEval = makeSubEval(fetcher, source, jsTimeoutMs === undefined ? undefined : { jsTimeoutMs })
  // 首页裁页在此**不需要方言判定**（搜索面那一处要）：只有原生方言的书源声明 `ruleFind`，
  // 发现面值住在 `ruleExploreUrl`，而它只可能由原生映射落位 ⇒ 走到这里的模板必是原生分页语义。
  // `trimFirstPage` 恒为 true（不随页码变）：裁页那段只在「模板以 `/{{page}}` 结尾 ∧ page === 1」
  // 时才生效——这是 `request.assembleRequest` 的既有语义，第 2 页因此自然带着页码段。
  // 在这里再判一次页码就是把归属别人的判断抄成第二份，两份迟早会分叉。
  const plan = buildSearchRequest(template, { kind: kindUrl, page }, source.baseUrl, { trimFirstPage: true })
  const { text, landedUrl } = await fetchTextPage(fetcher, plan.url,
    { ...fetchInitOf(plan, await resolveHeaders(fetcher, source, { jsTimeoutMs })), timeoutMs }, plan.charset)
  // 列表规则缺失（发现面整套覆盖里 list 恒非空，故只可能来自回落那一侧）：空规则求值即空列表，
  // 是「这个分类没条目」不是「规则没了」——与搜索面同一条口径，不折叠成失败。
  if (R.list === null) return { ok: true, hits: [] }
  // 求值与相对链接基准 = 落地地址（浏览器语义，与搜索/目录/正文面同口径）
  const contexts = itemContextsOf(await subEval(R.list, { html: text, baseUrl: landedUrl }, 'search', 'list'), landedUrl)
  const hits: SearchHit[] = []
  for (const ctx of contexts) {
    const title = firstValue(await subEval(R.name, ctx, 'search', 'value'), 'search')
    if (title === null || title.trim() === '') continue   // 书名非空才算书目
    const [author, href, cover, intro, last, kind, wordCount] = await Promise.all([
      fieldOf(subEval, R.author, ctx, 'search'),
      urlFieldOf(subEval, R.url, ctx, 'search'),
      auxUrlFieldOf(subEval, R.cover, ctx, 'search'),
      auxFieldOf(subEval, R.intro, ctx, 'search'),
      auxFieldOf(subEval, R.last, ctx, 'search'),
      kindFieldOf(subEval, R.kind, ctx, 'search'),
      wordCountFieldOf(subEval, R.wordCount, ctx, 'search'),
    ])
    hits.push({
      title, author,
      // 书地址保留 `,{option}` 后缀落库（URL 即请求规格，与搜索结果/章节 URL 同源）
      url: href === null ? null : absUrlKeepOption(href, landedUrl),
      coverUrl: cover === null ? null : absUrl(cover, landedUrl),
      // 简介是展示文本：净化 + 截断（搜索面口径，不认渲染指令前缀）；Miss 仍是 null，不折成空串
      intro: intro === null ? null : formatIntro(intro),
      lastChapterName: last, kind, wordCount,
    })
  }
  return { ok: true, hits }
}
