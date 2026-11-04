import { parseObjectJson } from '../../src/services/normalize.js'
import { exploreKindsFormOf } from '../../src/services/explore-url.js'

/**
 * 面 D 需求读数表的键与判据：登记册「N 源带值」的复数入口（这些数是裁定的输入，分母随源增删而漂 ⇒
 * 复数必须有固定命令，临时手写脚本不作数，异库样本的数更不许当本库读数）。
 * 读数不进断言，钉的是「复数有一条命令」：`DSH_PARSE_CENSUS=1` 出全表。每条都带**判据原文**——
 * 同一个键经常有两种数法（非空 vs 带发现面、`head` 子串撞 `header`），抄数就连判据一起抄。
 */
export type RawSource = Record<string, unknown>

/** 普查输入是外来 JSON（书源库文件）：边界处判形一次，之后按 `RawSource` 走。 */
export const isRecord = (v: unknown): v is RawSource => typeof v === 'object' && v !== null

/** 递归抽出任意 JSON 里的字符串（脚本面用：jsLib 与各 @js: 段都在其中） */
export function allStrings(node: unknown, acc: string[] = []): string[] {
  if (typeof node === 'string') acc.push(node)
  else if (Array.isArray(node)) for (const v of node) allStrings(v, acc)
  else if (node && typeof node === 'object') for (const v of Object.values(node)) allStrings(v, acc)
  return acc
}

const nonEmpty = (v: unknown): boolean => typeof v === 'string' ? v.trim() !== '' : v !== undefined && v !== null && v !== ''
const boxField = (raw: RawSource | undefined, box: string, field: string): boolean => {
  const b = raw?.[box]
  if (!isRecord(b)) return false
  return b[field] !== undefined && nonEmpty(b[field])
}
const rawField = (raw: RawSource | undefined, field: string): boolean => nonEmpty(raw?.[field])
const anyStr = (raw: unknown, re: RegExp): boolean => allStrings(raw).some((s) => re.test(s))
/** 任一层键叫 `name` 且值非空（`boxField` 只到顶层的一个容器，而 `rules` 那种归一化容器在更深处） */
const hasKeyDeep = (node: unknown, name: string): boolean => {
  if (Array.isArray(node)) return node.some((v) => hasKeyDeep(v, name))
  if (node && typeof node === 'object') {
    const rec = node as Record<string, unknown>
    if (name in rec && nonEmpty(rec[name])) return true
    return Object.values(rec).some((v) => hasKeyDeep(v, name))
  }
  return false
}

/**
 * CSS 选择器位的取值路径（矩阵 `a-css-case-insensitive-match` 的上界判据用）。必须限路径：
 * 整串 raw 扫会把文件后缀、URL 段、js 属性访问算进来（读数会被撑成假量级）；取这些字段前
 * 先剥 js 片段。
 */
const CSS_SELECTOR_PATHS = [
  'searchUrl', 'exploreUrl',
  'ruleSearch.bookList', 'ruleSearch.name', 'ruleSearch.author', 'ruleSearch.bookUrl', 'ruleSearch.coverUrl',
  'ruleSearch.intro', 'ruleSearch.kind', 'ruleSearch.lastChapter', 'ruleSearch.wordCount',
  'ruleBookInfo.init', 'ruleBookInfo.name', 'ruleBookInfo.author', 'ruleBookInfo.kind', 'ruleBookInfo.wordCount',
  'ruleBookInfo.intro', 'ruleBookInfo.coverUrl', 'ruleBookInfo.lastChapter', 'ruleBookInfo.bookUrl', 'ruleBookInfo.canReName',
  'ruleToc.chapterList', 'ruleToc.chapterName', 'ruleToc.chapterUrl', 'ruleToc.updateTime', 'ruleToc.isVolume', 'ruleToc.isVip',
  'ruleContent.content', 'ruleContent.title', 'ruleContent.replaceRegex', 'ruleContent.nextContentUrl', 'ruleContent.subContent',
]
const cssSelectorStrings = (raw: RawSource | undefined): string[] => CSS_SELECTOR_PATHS.map((p) =>
  p.split('.').reduce<unknown>((o, k) => (isRecord(o) ? o[k] : undefined), raw),
).filter((v): v is string => typeof v === 'string' && v.trim() !== '')
  .map((v) => v.replace(/\{\{[\s\S]*?\}\}|<js>[\s\S]*?<\/js>|@js:[\s\S]*/gi, ''))

/**
 * **零读数的反空转样品**：现库上的 0 有两种成因——真没人用，或判据接不上任何东西，表里长得一样。
 * 每条「当下为 0」的判据都必须在这条样品上数出非 0；加新的零读数判据时把形状塞进来。
 */
export const KITCHEN_SINK: RawSource = {
  bookSourceName: '反空转样品',
  searchUrl: '/search?q={{key}}&retry=1&charset=gbk',
  preUpdateJs: '@js:1',
  ruleToc: { formatJs: '@js:title', chapterUrl: 'a@href##reSegment##paragraphTitle' },
  ruleContent: { content: 'java.refreshExplore("x"); source.setVariable("k", "v")', subContent: 'text.正文' },
  // 节点导航形状：判据在面 D 键 `jsoupNodeNav`（读数现算在那张表）——形状塞进样品是为了反空转
  ruleBookInfo: { intro: 'result.parent().children(0).elementSiblingIndex()' },
  // 非文本源形状：`nonTextSource` 判据当下为 0，按上方的规矩塞进样品
  bookSourceType: 1,
}

export const DEMAND_KEYS: Array<{ key: string; label: string; test: (raw: RawSource | undefined) => boolean }> = [
  { key: 'exploreUrl', label: '顶层 exploreUrl 非空（D1 的主判据）', test: (r) => rawField(r, 'exploreUrl') },
  { key: 'exploreUrlRuleExploreOnly', label: '只带 ruleExplore 容器、exploreUrl 为空（D1 的"另一半"）', test: (r) => !rawField(r, 'exploreUrl') && allStrings(r?.ruleExplore).some((s) => s.trim() !== '') },
  { key: 'exploreBookList', label: 'ruleExplore.bookList 非空（自带列表规则的发现面源）', test: (r) => boxField(r, 'ruleExplore', 'bookList') },
  { key: 'searchUrlPage', label: 'searchUrl 含 {{page}}（D2 搜索翻页）', test: (r) => anyStr(r?.searchUrl ?? r?.ruleSearch, /\{\{\s*page\s*\}\}/) },
  { key: 'tocIsVip', label: 'ruleToc.isVip 非空（D3 / 审计唯一 residual）', test: (r) => boxField(r, 'ruleToc', 'isVip') },
  { key: 'tocIsVolume', label: 'ruleToc.isVolume 非空（D3）', test: (r) => boxField(r, 'ruleToc', 'isVolume') },
  { key: 'tocUpdateTime', label: 'ruleToc.updateTime 非空（D3）', test: (r) => boxField(r, 'ruleToc', 'updateTime') },
  { key: 'contentTitle', label: 'ruleContent.title 非空（D4）', test: (r) => boxField(r, 'ruleContent', 'title') },
  { key: 'contentSubContent', label: 'ruleContent.subContent 非空', test: (r) => boxField(r, 'ruleContent', 'subContent') },
  { key: 'concurrentRate', label: 'concurrentRate 非空（D5 源级限速）', test: (r) => rawField(r, 'concurrentRate') },
  { key: 'enabledCookieJar', label: 'enabledCookieJar 为真（布尔，不是串）', test: (r) => r?.enabledCookieJar === true || r?.enabledCookieJar === 'true' },
  // 这两条是**子串宽判据**不是权威读数（真口径按 URL 尾 `,{…}` 切分，权威见矩阵
  // b-opt-charset-form-fidelity 与 b-opt-retry）；这里没有 URL 上下文可复用，两边数字本就该不同。
  { key: 'charsetOption', label: '某处字符串含 charset 字样（子串宽判据，权威见矩阵 b-opt-charset-form-fidelity）', test: (r) => anyStr(r, /charset/i) },
  { key: 'retryOption', label: '某处字符串含 retry 字样（同上；矩阵 b-opt-retry 记的是按真入口 0 源）', test: (r) => anyStr(r, /retry/i) },
  { key: 'loginUrl', label: 'loginUrl 非空（登录面：URL 形态 vs js 形态见下两条）', test: (r) => rawField(r, 'loginUrl') },
  { key: 'loginUrlJsForm', label: 'loginUrl 是 js 形态（含 @js: 或 <js>）', test: (r) => anyStr(r?.loginUrl, /@js:|<js>/) },
  { key: 'loginCheckJs', label: 'loginCheckJs 非空', test: (r) => rawField(r, 'loginCheckJs') },
  { key: 'loginUi', label: 'loginUi 非空', test: (r) => rawField(r, 'loginUi') },
  { key: 'searchKind', label: 'ruleSearch.kind 非空', test: (r) => boxField(r, 'ruleSearch', 'kind') },
  { key: 'searchWordCount', label: 'ruleSearch.wordCount 非空', test: (r) => boxField(r, 'ruleSearch', 'wordCount') },
  { key: 'detailKind', label: 'ruleBookInfo.kind 非空', test: (r) => boxField(r, 'ruleBookInfo', 'kind') },
  { key: 'detailWordCount', label: 'ruleBookInfo.wordCount 非空', test: (r) => boxField(r, 'ruleBookInfo', 'wordCount') },
  { key: 'canReName', label: 'ruleBookInfo.canReName 非空（值形态是字符串 "1"/"true"）', test: (r) => boxField(r, 'ruleBookInfo', 'canReName') },
  { key: 'preUpdateJs', label: 'preUpdateJs 非空（任一容器）', test: (r) => boxField(r, 'ruleToc', 'preUpdateJs') || rawField(r, 'preUpdateJs') },
  { key: 'bookSourceComment', label: 'bookSourceComment 非空（脚本经 source.* 读它）', test: (r) => rawField(r, 'bookSourceComment') },
  // 下面五条把「本库 0 需求方」的行也纳入同一入口：零读数比非零更容易悄悄失效
  // （非零要动手做才会发现错，零只需要下一个人信它）。
  { key: 'tocFormatJs', label: '任一层 ruleToc.formatJs 非空（含归一化 rules 容器；矩阵 c-toc-format-js 的重开条件就是这条冒出 1 源）', test: (r) => hasKeyDeep(r?.ruleToc, 'formatJs') || boxField(r, 'ruleToc', 'formatJs') },
  { key: 'reSegment', label: 'raw 全串含 reSegment 字样（子串宽判据；矩阵 g-paragraph-title 的另一侧是规则字段表，两边本就不同）', test: (r) => anyStr(r, /reSegment/) },
  { key: 'paragraphTitle', label: 'raw 全串含 paragraphTitle 字样（同上）', test: (r) => anyStr(r, /paragraphTitle/) },
  { key: 'javaRefreshExplore', label: '调用名 `java.refreshExplore(` 出现（按 raw 全串；「会不会被执行」要逐处读上下文，本表只给上界，见矩阵 h-source-refresh-explore）', test: (r) => anyStr(r, /java\.refreshExplore\s*\(/) },
  { key: 'sourceStateStore', label: '调用名 `source.{setVariable,getVariable,getKey,put,get}(` 出现（上界：静态写容器≠需要跨重启存活）', test: (r) => anyStr(r, /\bsource\.(?:setVariable|getVariable|getKey|put|get)\s*\(/) },
  { key: 'jsLib', label: 'jsLib 非空', test: (r) => rawField(r, 'jsLib') },
  // 探针关键词：`services/types.ts` 的 probeKeyword 词条只指这条命令，不写数——注释里的数没有
  // 复入口，会静默过期。
  { key: 'probeKeyword', label: 'ruleSearch.checkKeyWord 非空（顶层 checkKeyWord 也算；探针首词的需求方）', test: (r) => boxField(r, 'ruleSearch', 'checkKeyWord') || rawField(r, 'checkKeyWord') },
  { key: 'nonTextSource', label: '非文本源（bookSourceType 有值且不是 0/"0"）', test: (r) => r?.bookSourceType !== undefined && r.bookSourceType !== 0 && r.bookSourceType !== '0' && r.bookSourceType !== null && r.bookSourceType !== '' },
  // URL 页码形态 `<a,b,c>`：判据在**这里唯一地**写死（分桶重叠会造出假负结果，见矩阵
  // d-search-paging）——剥 js 与 `{{}}` 后 URL 位仍含 `<…>` 组，按**源**去重；别的宽度只在矩阵行
  // 留读数，不当第二个主人。
  {
    key: 'pageAngleListUrl',
    label: 'URL 位（searchUrl/exploreUrl）剥掉 js 片段与 {{}} 后仍含 <…> 组（按源去重；矩阵 b-page-angle-list 的主判据）',
    test: (r) => [r?.searchUrl, r?.exploreUrl].some((v) =>
      typeof v === 'string'
      && /<[^<>]+>/.test(v.replace(/\{\{[\s\S]*?\}\}|<js>[\s\S]*?<\/js>|@js:[\s\S]*/gi, ''))),
  },
  {
    key: 'headerLenientOnly',
    label: '静态 header 严格 JSON 解析不了、但单引号宽松能解析（按源；矩阵 b-header-static 的主判据——这类头读得出，宽松半边漏了就是静默丢）',
    test: (r) => {
      const h = r?.header
      if (typeof h !== 'string' || /^\s*(@js:|<js>)/i.test(h)) return false
      // 「严格解析不了、宽松能解析」的宽松半边走 normalize.parseObjectJson 单点
      //（严格 → 单引号交换两步都在里面；这里只需判「严格这步失败」）
      try { JSON.parse(h); return false } catch {
        return parseObjectJson(h) !== undefined
      }
    },
  },
  {
    key: 'uppercaseCssSelector',
    label: '选择器位出现含大写的 class / 属性值 token（**上界、不是需求方**：只有页面里实际大小写不一致才是受害者，判据与来历见矩阵 a-css-case-insensitive-match）',
    test: (r) => cssSelectorStrings(r).some((s) => {
      const re = /\.([A-Za-z_][\w-]*)|\[\s*[\w-]+\s*[=~^$*|]?=\s*["']?([^\]"']+)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(s)) !== null) { if (/[A-Z]/.test(m[1] ?? m[2] ?? '')) return true }
      return false
    }),
  },
  // 节点导航（矩阵 h-jsoup-live-node-navigation）：判据是**调用形**，当下为 0 故形状已塞进
  // KITCHEN_SINK。命中不等于受害者（可能包在 try 里），但「有没有人写这个形状」只有它能回答。
  {
    key: 'jsoupNodeNav',
    label: '调用形 `.parent(|.children(|.elementSiblingIndex(|.nextElementSibling(|.previousElementSibling(|.siblings(|.closest(|.next(|.prev(|.index(` 出现（上界：会不会被执行要逐处读上下文；矩阵 h-jsoup-live-node-navigation）',
    test: (r) => anyStr(r, /\.(?:parent|children|elementSiblingIndex|nextElementSibling|previousElementSibling|siblings|closest|next|prev|index)\s*\(/),
  },
  // 登录面三档形态（矩阵 b-login-ui）：非空总数已有键 `loginUi`，这两条把「形态」也变成可重算的
  {
    key: 'loginUiRowUiJson',
    label: 'loginUi 非空且以 [ 开头（RowUi JSON 数组形态；矩阵 b-login-ui 三档之一）',
    test: (r) => typeof r?.loginUi === 'string' && r.loginUi.trim().startsWith('['),
  },
  {
    key: 'loginUiJsForm',
    label: 'loginUi 非空且以 @js: 或 <js> 开头（脚本生成形态；矩阵 b-login-ui 三档之二）',
    test: (r) => typeof r?.loginUi === 'string' && /^\s*(@js:|<js>)/i.test(r.loginUi),
  },
  // 发现面 exploreUrl 三档形态（矩阵 d-explore-three-forms；分母＝非空 exploreUrl）。
  // **判据的主人不在这里**：三档由 `services/explore-url.ts` 的 `exploreKindsFormOf` 分
  // （优先级写死在那边：js → JSON → 含 `::` 的文本，⇒ 三档互斥），这里只按它的返回值切档。
  // 行里的读数由矩阵行负责，本表只现算。
  {
    key: 'exploreFormJs',
    label: 'exploreUrl 是 js 形态（要过沙箱；矩阵 d-explore-three-forms 三档之一）',
    test: (r) => exploreKindsFormOf(r?.exploreUrl) === 'js',
  },
  {
    key: 'exploreFormJson',
    label: 'exploreUrl 是 JSON 形态（以 [ 或 { 开头；矩阵 d-explore-three-forms 三档之二）',
    test: (r) => exploreKindsFormOf(r?.exploreUrl) === 'json',
  },
  {
    key: 'exploreFormTitleUrl',
    label: 'exploreUrl 是「标题::URL」文本形态（含 :: 的多行；矩阵 d-explore-three-forms 三档之三）',
    test: (r) => exploreKindsFormOf(r?.exploreUrl) === 'text',
  },
]

export const DEMAND_KEY_NAMES: ReadonlySet<string> = new Set(DEMAND_KEYS.map((d) => d.key))
