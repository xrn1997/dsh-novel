import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseRule } from '../../src/engine/parse.js'
import { parseObjectJson } from '../../src/services/normalize.js'
import { probeJavaSurface } from '../java-surface.js'
import { JAVA_PROTOCOL } from '../../src/engine/js-protocol.js'
import { messageSkeleton } from '../content-audit-classify.js'
import { readSnapshot } from '../legado-coverage/upstream-facts.js'
import { COVERAGE, ROW_DEMAND } from '../legado-coverage/matrix.js'

/**
 * **解析面全库普查（`DSH_PARSE_CENSUS=1` 才跑；离线、秒级）**——「书源里写下的规则形态，本插件
 * 都能正确解析」这条目标的**进度读数口**（此前靠一份会消失的一次性脚本，且只跑了 `parseRule` 一面）：
 * - **面 A · 规则语法**：现库每条规则串（`raw` 的 rule 容器全集，含本仓字段映射没接的）过真实入口
 *   `parseRule`，收抛错骨架。
 * - **面 B · js 宿主调用**：静态抽 `java.<m>(` / `Packages.<a.b.C>` 调用名比对桥表。静态抽名连注释、
 *   死分支也采到，所以**读数给数量与样例、由人判**，断言只对「抽到且不在已知集合」的形态开火。
 * - **面 C · 桥可达性**：面 B 只问「挂没挂」，问不出「挂的是实现还是桩」——协议表有实现的名字
 *   不许在沙箱里仍被「需要安卓宿主环境」桩覆盖（`digestHex` 一族曾实现了却够不着）。
 * - **面 D · 需求读数表**：登记册那些「N 源带值」的复数入口一条命令全出，判据跟着数字印。**读数本身
 *   不判红**（分母随增删漂，钉死等于每次改库改测试；要防的是复数只能靠不入库的手写脚本）。判红三件
 *   与分母无关的事：表短了/整表全 0（空转）、`ROW_DEMAND` 绑定落空、零读数判据在合成样品上也为 0。
 *
 * 判断言：未知形态必须为 0——本仓拒绝过的语法、脚本调过的缺失桥方法，要么实现了，要么在在册集合里
 * 点名并写明去处，**新形态冒出来即红**。与 `upstream-fields.test.ts`（字段面有主吗）互补：那道门管
 * 字段归属，本门管规则串与脚本调用真能不能跑。数据源缺失即红不静默 skip；取值语义等价性归
 * `DSH_CONTENT_AUDIT` 真链路，URL 与请求侧形态在覆盖矩阵 B 组在册。
 *
 * **为什么没有「扫代码注释里的现量」这道门**（dry-run 后判不加，别再试）：`src/**` 上 19/41 处命中
 * 多半不是库读数（UI 空态、文件大小、审计分母、正则切词假命中），做对就得养四类豁免表——正是本仓
 * 拒绝的宽判据形状。注释里的数靠两件事管：本表那条命令（能被引用的数必须有键）+ AGENTS「引用前先重数」。
 */
const ON = process.env.DSH_PARSE_CENSUS === '1'

/** 书源的 rule 容器：本仓只映射其中一部分，这里取全集（含未映射字段） */
const RULE_CONTAINERS = ['rules', 'ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent', 'ruleExplore']

/**
 * **字段 → 实际由哪条消费者读它**。只有进规则引擎求值的字段才该过 `parseRule`，硬塞进来的都是
 * 假阳性（普查第一版把词表 `checkKeyWord` 报成了「本仓拒绝的语法」）。取值语义写在值里：
 * `rule-list`/`rule-value` 过 getElements/getString；`js` 进沙箱（面 B 管）；`regex`/`words`/`flag`
 * 各有消费者。未列出的按 `rule-value`（新字段冒出来由上游字段门拦）。
 */
const FIELD_CONSUMERS: Record<string, 'rule-list' | 'rule-value' | 'js' | 'regex' | 'words' | 'flag'> = {
  bookList: 'rule-list', chapterList: 'rule-list', ruleBookList: 'rule-list', ruleChapterList: 'rule-list',
  downloadUrls: 'rule-list', relatedBooks: 'rule-list', ruleContentList: 'rule-list',
  nextContentUrl: 'rule-value', nextTocUrl: 'rule-value', ruleNextContentUrl: 'rule-value', ruleNextTocUrl: 'rule-value',
  formatJs: 'js', preUpdateJs: 'js', webJs: 'js', callBackJs: 'js', coverDecodeJs: 'js',
  ruleContentDecode: 'js', imageDecode: 'js', payAction: 'js', ruleReview: 'js',
  sourceRegex: 'regex', replaceRegex: 'regex', ruleReplaceRegex: 'regex', ruleSourceRegex: 'regex',
  checkKeyWord: 'words', ruleCheckKeyWord: 'words',
  canReName: 'flag', isVolume: 'flag', isVip: 'flag', isPay: 'flag', imageStyle: 'flag', ruleImageStyle: 'flag',
  // authorPrefix / authorPattern / ruleBookAuthor 这类是**字面量前后缀**，直接拼接，不过规则引擎
  authorPrefix: 'flag', ruleBookAuthor: 'flag', authorPattern: 'flag', bookListUrl: 'flag',
  init: 'rule-value', ruleInit: 'rule-value',
}

/** 非规则字段不计入 parseRule 分母，但要报出来：它们是「书源读得出、本仓字段都没取」的候选面 */
const isRuleField = (field: string) => {
  const kind = FIELD_CONSUMERS[field]
  return !kind || kind.startsWith('rule-')
}

interface RuleSite { src: string; where: string; rule: string; usage: 'list' | 'value' }

/** 收集一个源里所有「会当规则求值」的字符串（数组元素逐个收，如 nextContentUrl: [..]） */
function collectRules(entry: any): RuleSite[] {
  const raw = entry?.raw ?? entry ?? {}
  const src = String(entry?.name ?? raw.bookSourceName ?? '?')
  const out: RuleSite[] = []
  for (const container of RULE_CONTAINERS) {
    const box = raw[container]
    if (typeof box === 'string') {
      // 字符串化容器（本仓导入时二次 parse；容器本身也可能是 JSON 文本，两种形态都要接）
      try { collectBox(container, JSON.parse(box), src, out) } catch { /* 坏 JSON 由导入面点名，不在这里重复判 */ }
      continue
    }
    if (box && typeof box === 'object') collectBox(container, box, src, out)
  }
  return out
}

function collectBox(container: string, box: Record<string, unknown>, src: string, out: RuleSite[]) {
  for (const [field, value] of Object.entries(box)) {
    if (!isRuleField(field)) continue
    const usage = FIELD_CONSUMERS[field] === 'rule-list' ? 'list' : 'value'
    const vals = Array.isArray(value) ? value : [value]
    for (const v of vals) {
      if (typeof v === 'string' && v.trim() !== '') out.push({ src, where: `${container}.${field}`, rule: v, usage })
    }
  }
}

/** 递归抽出任意 JSON 里的字符串（脚本面用：jsLib 与各 @js: 段都在其中） */
function allStrings(node: unknown, acc: string[] = []): string[] {
  if (typeof node === 'string') acc.push(node)
  else if (Array.isArray(node)) for (const v of node) allStrings(v, acc)
  else if (node && typeof node === 'object') for (const v of Object.values(node)) allStrings(v, acc)
  return acc
}

/**
 * **零读数的反空转样品**：真库上的 0 有两种成因——真没人用，或判据接不上任何东西，表里长得一样。
 * 每条「当下为 0」的判据都必须在这条样品上数出非 0；加新的零读数判据时把形状塞进来。
 */
const KITCHEN_SINK: any = {
  bookSourceName: '反空转样品',
  searchUrl: '/search?q={{key}}&retry=1&charset=gbk',
  preUpdateJs: '@js:1',
  ruleToc: { formatJs: '@js:title', chapterUrl: 'a@href##reSegment##paragraphTitle' },
  ruleContent: { content: 'java.refreshExplore("x"); source.setVariable("k", "v")' },
  // 节点导航形状：`jsoupNodeNav` 判据当下为 0，按上方的规矩塞进样品
  ruleBookInfo: { intro: 'result.parent().children(0).elementSiblingIndex()' },
}

/**
 * **面 D · 需求读数表**：登记册「N 源带值」的复数入口（这些数是裁定的输入，分母天天漂，而临时
 * 手写脚本活不过一轮——`canReName` 3→5、桥面把独立合集的数当本库等三处漂都是这么来的）。
 * 读数不进断言，钉的是「复数有一条命令」：`DSH_PARSE_CENSUS=1` 出全表。每条都带**判据原文**——
 * 同一个键经常有两种数法（非空 168 vs 带发现面 172、`head` 子串撞 `header`），抄数就连判据一起抄。
 */
const nonEmpty = (v: unknown): boolean => typeof v === 'string' ? v.trim() !== '' : v !== undefined && v !== null && v !== ''
const boxField = (raw: any, box: string, field: string): boolean => {
  const b = raw?.[box]
  return !!b && typeof b === 'object' && (b as any)[field] !== undefined && nonEmpty((b as any)[field])
}
const rawField = (raw: any, field: string): boolean => nonEmpty(raw?.[field])
const anyStr = (raw: any, re: RegExp): boolean => allStrings(raw).some((s) => re.test(s))
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
 * 整串 raw 扫会把文件后缀、URL 段、js 属性访问算进来（曾量出 107 源的假读数）；取这些字段前
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
const cssSelectorStrings = (raw: any): string[] => CSS_SELECTOR_PATHS.map((p) =>
  p.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), raw),
).filter((v): v is string => typeof v === 'string' && v.trim() !== '')
  .map((v) => v.replace(/\{\{[\s\S]*?\}\}|<js>[\s\S]*?<\/js>|@js:[\s\S]*/gi, ''))

export const DEMAND_KEYS: Array<{ key: string; label: string; test: (raw: any) => boolean }> = [
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
  { key: 'reSegment', label: 'raw 全串含 reSegment 字样（子串宽判据；矩阵 g-paragraph-title 另一侧判据是快照规则实体字段表面，两边本就不同）', test: (r) => anyStr(r, /reSegment/) },
  { key: 'paragraphTitle', label: 'raw 全串含 paragraphTitle 字样（同上）', test: (r) => anyStr(r, /paragraphTitle/) },
  { key: 'javaRefreshExplore', label: '调用名 `java.refreshExplore(` 出现（按 raw 全串；「会不会被执行」要逐处读上下文，本表只给上界，见矩阵 h-source-refresh-explore）', test: (r) => anyStr(r, /java\.refreshExplore\s*\(/) },
  { key: 'sourceStateStore', label: '调用名 `source.{setVariable,getVariable,getKey,put,get}(` 出现（上界：静态写容器≠需要跨重启存活）', test: (r) => anyStr(r, /\bsource\.(?:setVariable|getVariable|getKey|put|get)\s*\(/) },
  { key: 'jsLib', label: 'jsLib 非空', test: (r) => rawField(r, 'jsLib') },
  // 探针关键词：`services/types.ts` 的 probeKeyword 词条曾引一个漂掉的数——注释里的数没有复数
  // 入口就会这样过期。键放这儿，词条只指这条命令。
  { key: 'probeKeyword', label: 'ruleSearch.checkKeyWord 非空（顶层 checkKeyWord 也算；探针首词的需求方）', test: (r) => boxField(r, 'ruleSearch', 'checkKeyWord') || rawField(r, 'checkKeyWord') },
  { key: 'nonTextSource', label: '非文本源（bookSourceType 有值且不是 0/"0"）', test: (r) => r?.bookSourceType !== undefined && r?.bookSourceType !== 0 && r?.bookSourceType !== '0' && r?.bookSourceType !== null && r?.bookSourceType !== '' },
  // URL 页码形态 `<a,b,c>`：判据在**这里唯一地**写死（分桶重叠曾造出假负结果，订正见矩阵
  // d-search-paging）——剥 js 与 `{{}}` 后 URL 位仍含 `<…>` 组，按**源**去重；别的宽度只作历史
  // 读数留在矩阵行，不当第二个主人。
  {
    key: 'pageAngleListUrl',
    label: 'URL 位（searchUrl/exploreUrl）剥掉 js 片段与 {{}} 后仍含 <…> 组（按源去重；矩阵 b-page-angle-list 的主判据）',
    test: (r) => [r?.searchUrl, r?.exploreUrl].some((v) =>
      typeof v === 'string'
      && /<[^<>]+>/.test(v.replace(/\{\{[\s\S]*?\}\}|<js>[\s\S]*?<\/js>|@js:[\s\S]*/gi, ''))),
  },
  {
    key: 'headerLenientOnly',
    label: '静态 header 严格 JSON 解析不了、但单引号宽松能解析（按源；矩阵 b-header-static 的主判据——这类头对面读得出、旧版本仓静默丢）',
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
  // 发现面 exploreUrl 三档形态（矩阵 d-explore-three-forms；分母＝非空 exploreUrl）。**优先级写死**：
  // js → JSON（`[`/`{` 开头）→ 剩下含 `::` 算文本——次序是三档互斥且和等于非空总数的前提。
  // 2026-09-28 复算与行里读数一致（37 / 71 / 60，和 168）。
  {
    key: 'exploreFormJs',
    label: 'exploreUrl 非空且以 @js: 或 <js> 开头（要过沙箱；矩阵 d-explore-three-forms 三档之一）',
    test: (r) => { const t = typeof r?.exploreUrl === 'string' ? r.exploreUrl.trim() : ''
      return t !== '' && /^(@js:|<js>)/i.test(t) },
  },
  {
    key: 'exploreFormJson',
    label: 'exploreUrl 非空、不是 js 形态且以 [ 或 { 开头（声明式 JSON；矩阵 d-explore-three-forms 三档之二）',
    test: (r) => { const t = typeof r?.exploreUrl === 'string' ? r.exploreUrl.trim() : ''
      return t !== '' && !/^(@js:|<js>)/i.test(t) && (t.startsWith('[') || t.startsWith('{')) },
  },
  {
    key: 'exploreFormTitleUrl',
    label: 'exploreUrl 非空、非 js、非 JSON 且含 :: （声明式「标题::URL」多行；矩阵 d-explore-three-forms 三档之三）',
    test: (r) => { const t = typeof r?.exploreUrl === 'string' ? r.exploreUrl.trim() : ''
      return t !== '' && !/^(@js:|<js>)/i.test(t) && !(t.startsWith('[') || t.startsWith('{')) && t.includes('::') },
  },
]

/**
 * 在册已知形态（**按族**登记，不是按整条骨架——骨架被 messageSkeleton 归一成长度类，逐条登记会把门
 * 变成天天改的白名单）。代价如实：**同族内的新样例不报红**，所以每次跑要看「N× M源」读数变化，
 * 别只盯红/绿。普查头一跑登记过 4 族，3 族已逐一收口（见各矩阵行），留下的这一族仍在被拒。
 * 表只为让**新**形态冒出来即红：加条目必须先有矩阵行 id，实现了就删条目——留着当墓碑会被误读成裁决。
 */
const KNOWN_RULE_SHAPES: Record<string, string> = {
  '无法识别的段类型（default 段白名单之外）（规则片段: "#"':
    '无 `@` 单段（`kind: "0"` 等）——取值路径 = `attr(整串)` → 也取空；矩阵 `a-bare-index-segment` 记为不适用（guard 族），非欠账',
}

/**
 * 在册已知桥缺口：脚本用得到、本仓没挂、已在矩阵行排队的 `java.*` 方法名。只为让**新**缺口冒出来
 * 即红、不给存量挡红：加条目必须先有矩阵行 id。下面三条全部来自换分母那批（2026-09-22，本库之外
 * 另取两份公开合集，`DSH_PARSE_CENSUS_FILE` 指过去可复现）——本库从未用过它们。
 */
const KNOWN_BRIDGE_GAPS: Record<string, string> = {
  t2s: '繁简词典不在本仓，且对面在转换前还会跑自家补丁词典——换轮子（opencc 一类）得到的文本与对面不逐字相等，要拍板：矩阵 h-java-t2s',
  cacheFile: '裁决已有（真实文件 API = 数据外泄面），这一条的作用是确认该裁决真有需求方：矩阵 h-java-cache-file',
  toURL: '返回的是 JVM URL 对象；先看清那 1 源真调了哪些成员再造壳：矩阵 h-java-tourl',
}

/** 本仓 `java` 挂载面：**问沙箱本体**，探钢单点在 `tests/java-surface.ts`——第二个消费者
 * （`host-methods.test.ts`）出现后两处各探必漂；为什么只能问沙箱本体写在那个文件头上。 */

/** 脚本侧 `java` 对象的权威定义：从**仓内快照**读公开 fun 名（含重载去重）。
 *  快照由 `tests/legado-coverage/capture-upstream-snapshot.test.ts` 在开发阶段生成——
 *  本普查（连同其他两条判据）运行时不依赖任何外部 checkout。 */
function upstreamJavaNames(): Set<string> {
  const out = new Set(readSnapshot().javaMethods)
  expect(out.size, `快照里的 java 方法名过少（${out.size}），判据已失效——刷新快照`).toBeGreaterThan(50)
  return out
}

describe.skipIf(!ON)('解析面全库普查（DSH_PARSE_CENSUS=1）', () => {
  const sj = process.env.DSH_PARSE_CENSUS_FILE
    ?? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'novel', 'sources.json')

  it('现库全部规则串过 parseRule + 全部脚本的桥调用名比对桥表', async () => {
    if (!fs.existsSync(sj)) {
      throw new Error(
        `解析面普查读不到书源库：${sj}\n` +
        '  它是在册判据，不做静默跳过——设 DSH_PARSE_CENSUS_FILE 指到 sources.json，' +
        '或导入书源后再跑。',
      )
    }
    const parsed = JSON.parse(fs.readFileSync(sj, 'utf8'))
    const entries: any[] = Array.isArray(parsed) ? parsed : (parsed.sources ?? [])
    expect(entries.length, '普查分母为空').toBeGreaterThan(0)

    // ── 面 A：规则语法 ──────────────────────────────────────────────
    const sites = entries.flatMap(collectRules)
    const ruleRejects = new Map<string, { n: number; srcs: Set<string>; sample: string }>()
    for (const s of sites) {
      try {
        parseRule(s.rule, 'rule', s.usage)
      } catch (e: any) {
        const sk = `${e?.name ?? 'Error'} | ${messageSkeleton(String(e?.message ?? ''))}`
        const hit = ruleRejects.get(sk) ?? { n: 0, srcs: new Set<string>(), sample: s.rule.slice(0, 160) }
        hit.n++; hit.srcs.add(s.src)
        if (hit.sample.startsWith('') && hit.n === 1) hit.sample = `${s.where} ← ${s.rule.slice(0, 160)}`
        ruleRejects.set(sk, hit)
      }
    }

    // ── 面 B：js 宿主调用 ───────────────────────────────────────────
    const { names: mounted, stubs } = await probeJavaSurface()
    const upstream = upstreamJavaNames()
    const javaCalls = new Map<string, { n: number; srcs: Set<string> }>()
    const packages = new Map<string, { n: number; srcs: Set<string> }>()
    entries.forEach((e, i) => {
      for (const text of allStrings(e?.raw ?? e)) {
        for (const m of text.matchAll(/\bjava\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
          const hit = javaCalls.get(m[1]) ?? { n: 0, srcs: new Set<string>() }
          hit.n++; hit.srcs.add(String(e?.name ?? `#${i}`)); javaCalls.set(m[1], hit)
        }
        for (const m of text.matchAll(/\bPackages\.((?:[A-Za-z_][A-Za-z0-9_]*\.)*(?:[A-Z][A-Za-z0-9_]*))/g)) {
          const hit = packages.get(m[1]) ?? { n: 0, srcs: new Set<string>() }
          hit.n++; hit.srcs.add(String(e?.name ?? `#${i}`)); packages.set(m[1], hit)
        }
      }
    })
    // 缺口只在「这个公开方法确实在脚本面上」时才成立；本来就没有的名字（脚本写错、别的 fork、
    // 私有扩展）只报读数，不判红——否则把源脚本的坏冒成我们的欠。
    const notMounted = [...javaCalls.entries()].filter(([n]) => !mounted.has(n))
    const bridgeGaps = notMounted.filter(([n]) => upstream.has(n))
    const notUpstream = notMounted.filter(([n]) => !upstream.has(n))

    // ── 读数（报告，不是通过率）─────────────────────────────────────
    const fmt = (m: Map<string, { n: number; srcs: Set<string> }>, key: string) =>
      [...m.entries()].sort((a, b) => b[1].n - a[1].n)
        .map(([k, v]) => `    ${String(v.n).padStart(4)}×  ${v.srcs.size}源  ${k}`).join('\n')
    console.log(
      `\n[parse-census] 分母 ${entries.length} 源 / 规则串 ${sites.length} 条 / ` +
      `java.* 调用名 ${javaCalls.size} 种（未挂 ${bridgeGaps.length} 种）/ Packages 引用 ${packages.size} 种`,
    )
    if (ruleRejects.size) {
      console.log(`[parse-census] 本仓拒绝的规则语法形态 ${ruleRejects.size} 种：`)
      for (const [sk, v] of [...ruleRejects.entries()].sort((a, b) => b[1].n - a[1].n)) {
        console.log(`    ${String(v.n).padStart(4)}×  ${v.srcs.size}源  ${sk}\n             例: ${v.sample}`)
      }
    }
    if (bridgeGaps.length) {
      console.log(`[parse-census] 脚本调了、快照里有、本仓没挂的 java.* 方法 ${bridgeGaps.length} 种：`)
      console.log(fmt(new Map(bridgeGaps), 'name'))
      // **两类分开展印**：在册那几条**只报不红**（登记过的缺席）——「需求方出现了」只在这行的
      // 非 0 里看得见，别以为门会替它响（矩阵 h-java-unmounted-uncalled 的重开条件曾误写成「门会红」）。
      const rostered = bridgeGaps.filter(([n]) => KNOWN_BRIDGE_GAPS[n]).map(([n]) => n)
      const unlisted = bridgeGaps.filter(([n]) => !KNOWN_BRIDGE_GAPS[n]).map(([n]) => n)
      console.log(`    在册只报：${rostered.join(' / ') || '无'} ｜ 未在册即红：${unlisted.join(' / ') || '无'}`)
    }
    if (notUpstream.length) {
      console.log(`[parse-census] 快照的 java 方法集里也没有的调用名 ${notUpstream.length} 种（不判红，只报）：`)
      console.log(fmt(new Map(notUpstream), 'name'))
    }
    if (packages.size) {
      console.log('[parse-census] Packages 引用（按包名聚合，含本仓已挂的 org.jsoup/jsoup 元素桥）：')
      console.log(fmt(packages, 'pkg'))
    }

    // ── 面 D：需求读数表（登记册那些「N 源带值」的复数入口）────────────
    const demand = DEMAND_KEYS.map((d) => ({ key: d.key, label: d.label, test: d.test, hits: entries.filter((e: any) => d.test(e?.raw ?? e)).length }))
    // 当下数出 0 的判据，必须在反空转样品上数得出东西来——否则那个 0 分不清「没人用」与「判据坏了」。
    const silentZero = demand.filter((d) => d.hits === 0 && !d.test(KITCHEN_SINK)).map((d) => d.key)
    console.log(`[parse-census] 需求读数（分母 ${entries.length} 源；括号内是判据，不是键名——同一个键常有两种数法）：`)
    for (const d of demand) console.log(`    ${String(d.hits).padStart(4)} 源  ${d.label}`)
    // `##` 这条**故意标注分母**：本表只数「过规则引擎的字段」，矩阵 a-replace-tail-* 是「raw 全容器扫」，
    // 两边数字本就该不同——在这里另写一条更弱的判据就是给同一个量造第二份抄本。
    console.log(`    ${String(sites.filter((s) => s.rule.includes('##')).length).padStart(4)} 条  含 ## 的规则串（判据=过规则引擎的字段集，窄于矩阵行的 raw 全容器口径）`)

    // ── 面 D 对账：矩阵 ROW_DEMAND 把「note 里引用的数」绑到可复算的来源 ──────
    // 键取自本表 hits 与**面 B 已算好的调用名集**（`java.<名>` 走后者，不另立判据）。断言只有一条
    // 硬的：绑的东西必须存在（行 id 在册、键算得出）；**数不一致只打印漂移不判红**——那是某天的
    // 现量，增删源后必然不等，判红等于把门变成天天改的白名单。
    const hitsByKey = new Map<string, number>(demand.map((d) => [d.key, d.hits]))
    // `java.<名>` 一类键：先按快照方法名铺 0（没人调就是 0，正是绑定要回答的），再用面 B 实测覆盖
    // ——只从 javaCalls 起步会让「零调用」的键算不出来，而零恰恰是绑定要能表达的值。
    for (const name of upstream) hitsByKey.set('java.' + name, 0)
    for (const [name, v] of javaCalls) hitsByKey.set('java.' + name, v.srcs.size)
    const rowIds = new Set(COVERAGE.map((r) => r.id))
    const badBinding: string[] = []
    const drift: string[] = []
    for (const [id, list] of Object.entries(ROW_DEMAND)) {
      if (!rowIds.has(id)) badBinding.push(`ROW_DEMAND 里的行 id「${id}」在矩阵里不存在（改名/删行没同步绑定表）`)
      for (const b of list) {
        const live = hitsByKey.get(b.key)
        if (live === undefined) { badBinding.push(`${id} 绑的键「${b.key}」面 D 与面 B 都算不出来`); continue }
        if (live !== b.n) drift.push(`${id} · ${b.key}：记的 ${b.n}（截至 ${b.asOf}）→ 现算 ${live}`)
      }
    }
    console.log(drift.length
      ? `[parse-census] 需求读数漂移 ${drift.length} 处（只提示，不判红）：\n  ${drift.join('\n  ')}`
      : `[parse-census] 需求读数对账：${Object.keys(ROW_DEMAND).length} 行绑定的读数与现算一致`)
    expect(badBinding, `读数绑定指向了不存在的东西：\n  ${badBinding.join('\n  ')}`).toEqual([])

    // ── 面 C：桥可达性对账（协议表有真实现的名字，不许在沙箱里仍是抛错桩；病史见文件头面 C）──
    const clobbered = JAVA_PROTOCOL.map(r => r.name).filter(n => stubs.has(n))

    // ── 断言：未知形态为 0 ─────────────────────────────────────────
    // 读数不判红，判据的**形状**判红：表短了、整表全 0、或零读数判据在合成样品上也数不出。
    expect(demand.length, '需求读数表条目过少，判据在空转').toBeGreaterThan(15)
    expect(demand.some((d) => d.hits > 0), '需求读数表整表为 0：键名或判据错了').toBe(true)
    // 逐条零读数防空转：真库数出 0 的判据必须在合成样品上数出非 0——「0 需求方」那几行的裁决
    // 整条架在「0 是真 0」上，而判据接不上东西时也会报 0。
    expect(silentZero, `这些判据当下为 0、在反空转样品上也为 0（分不清「没人用」与「判据坏了」）：${silentZero.join(', ')}`).toEqual([])
    const knownFamilies = Object.keys(KNOWN_RULE_SHAPES)
    const unknownShapes = [...ruleRejects.keys()].filter(s => !knownFamilies.some(k => s.includes(k)))
    const unknownBridge = bridgeGaps.map(([n]) => n).filter(n => !KNOWN_BRIDGE_GAPS[n])
    expect(
      { unknownShapes, unknownBridge, clobbered },
      `出现未在册的新形态。\n  规则语法：${unknownShapes.join(' || ') || '无'}\n` +
      `  js 桥：${unknownBridge.join(' / ') || '无'}\n` +
      `  桩吃掉真实现：${clobbered.join(' / ') || '无'}\n` +
      '  处理：能实现就实现并删掉在册条目；要排队就补矩阵行 + 写进 KNOWN_* 并注明去处。',
    ).toEqual({ unknownShapes: [], unknownBridge: [], clobbered: [] })
  })
})
