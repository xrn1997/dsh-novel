import { hitFieldsOf, itemContextsOf, makeSubEval } from './bridge.js'
import { isNativeSource } from './normalize.js'
import { buildSearchRequest } from './request.js'
import type { SourceRequest } from './source-request.js'
import type { SearchHit } from '../shared/wire.js'
import type { NovelSource } from './types.js'

/**
 * 发现面（书城分类）单源一次抓取：「发一次分类页请求并取回该分类的书目」的唯一实现。
 * 与搜索面同构，差别只有两处——URL 模板与规则来源：
 * 请求组装归 `request.buildSearchRequest`（首页裁页那条语义的主人是 `request.assembleRequest`），
 * 抓取+解码归 `source-request.SourceRequest.fetchText`（限速/动态头/loginCheck 的装配与超时单点），
 * 条目装配归 `bridge.hitFieldsOf`（与聚合搜索同一份，档位与槽序的理由住那里）——
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
 *  条目装配不在本模块：一套规则加一个条目上下文怎么收成一条书目，单点在 `bridge.hitFieldsOf`
 *  （两档档位与理由也住那里）。 */
export async function fetchKindPage(
  source: NovelSource, kindUrl: string, request: SourceRequest, timeoutMs?: number, jsTimeoutMs?: number,
  page = 1,
): Promise<KindPageResult> {
  // 「这次用哪份模板」的判据（本函数是它的主人，裁决与被否决的方案见 `docs/adr/0027`）：
  // **先问源级模板 `ruleExploreUrl` 在场吗**——在场就用它（它带的就是原生分页语义，`{{kind}}` 填入口
  // 地址、`{{page}}` 走首页裁页）；平铺 raw 顶层写了同名键时非原生方言也走得进这一格，所以**方言
  // 不决定它的有无**。源级缺席才按方言兜底：legado 的分类入口**自带**整条模板（自带 `{{page}}`，
  // 还可能带请求修饰串后缀），拿它当模板且不裁页；原生方言没写就如实 RuleMissing——不许拿 slug 当
  // 模板，拼出「站点根地址 + slug」是替源猜布局（宁炸不猜）。
  // 一句话：**方言只决定兜底，不决定优先。**
  const sourceTemplate = source.rules.ruleExploreUrl
  const template = sourceTemplate ?? (isNativeSource(source.raw) ? null : kindUrl)
  const R = rulesFor(source)
  const name = R.name
  // 书名规则缺失按**规则缺失**回报，而不是产出一串没有标题的书目：对面在这种源上会静默给 0 本，
  // 本仓的口径是「空结果不得冒充失败」，反过来让「读不出任何东西」冒充成一次正常空分类同样不许。
  if (template === null || name === null) {
    const missing = [
      // 缺模板这一支只有原生方言会走到：legado 的分类入口自带地址，地址为空的条目在导入侧就不进城
      // （判空尺见 `explore-url.parseExploreKinds`），这里拿不到空入口。
      template === null ? 'ruleFind.url' : null,
      name === null ? '书名规则' : null,
    ].filter((x): x is string => x !== null)
    return { ok: false, code: 'RuleMissing', message: `发现规则缺失：缺 ${missing.join('、')}` }
  }
  const subEval = makeSubEval(request.fetcherFor(source), source,
    jsTimeoutMs === undefined ? undefined : { jsTimeoutMs })
  // 裁页跟着「本次用的是哪份模板」走，不跟着方言走：源级模板带的就是原生分页语义（首页不裁的代价见
  // `request.assembleRequest`）；分类自带地址那一份怎么翻页是源自己写死的，替它裁等于改它的语义。
  // 变量恒给 kind 与 page 两个：模板里没写的占位不参与替换（判据见 `engine/template.isPlaceholder`），
  // 多带一个用不到的变量在黑盒上没有签名，故不为它另立用例。
  const plan = buildSearchRequest(template, { kind: kindUrl, page }, source.baseUrl,
    { trimFirstPage: sourceTemplate !== null })
  const { text, landedUrl } = await request.fetchText(source, plan,
    timeoutMs === undefined ? undefined : { timeoutMs })
  // 列表规则缺失（发现面整套覆盖里 list 恒非空，故只可能来自回落那一侧）：空规则求值即空列表，
  // 是「这个分类没条目」不是「规则没了」——与搜索面同一条口径，不折叠成失败。
  if (R.list === null) return { ok: true, hits: [] }
  // 求值与相对链接基准 = 落地地址（浏览器语义，与搜索/目录/正文面同口径）
  const contexts = itemContextsOf(await subEval(R.list, { html: text, baseUrl: landedUrl }, 'search', 'list'), landedUrl)
  const hits: SearchHit[] = []
  for (const ctx of contexts) {
    const hit = await hitFieldsOf(
      { name, author: R.author, url: R.url, cover: R.cover, intro: R.intro,
        last: R.last, kind: R.kind, wordCount: R.wordCount },
      subEval, ctx, landedUrl,
    )
    if (hit !== null) hits.push(hit)
  }
  return { ok: true, hits }
}
