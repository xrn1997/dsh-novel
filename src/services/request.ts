import { interpolateUrl, expandPageAngleList, URL_OPTION_SPLIT } from '../engine/index.js'
import iconv from 'iconv-lite'
import { parseObjectJson, stringTableOf } from './normalize.js'
import { absUrl } from './url.js'

/** 书源 URL 模板的请求形态（格式钉死这三种）：
 *  ① 纯 URL：`/search?q={{key}}`（支持相对 URL——按 bookSourceUrl 解析）
 *  ② URL+选项：`url,{"method":"POST","body":"...","charset":"gbk","headers":"{...}","webView":true}`
 *  选项 JSON 允许单引号形态（真实源大量存在——宽容引号但不猜结构）；
 *  headers 可为 JSON 字符串（双重编码——真实源常见形态）。 */
export interface RequestOption {
  method?: string
  body?: string
  charset?: string
  headers?: Record<string, string>
  /** 我们不支持 WebView——调用方按普通请求尝试并如实 warning */
  webView?: boolean
}

/**
 * 请求计划（原 SearchRequest，语义不变）：模板 + 变量 + baseUrl 的**唯一**可执行形态。
 * 选项语义（method 判定 / body 插值 / headers / POST 表单默认 urlencoded / charset）只在
 * assembleRequest 里解释一遍——此前 buildSearchRequest 与 engineFetch 各写一份、靠「同口径」注释同步。
 */
export interface RequestPlan {
  url: string
  /** 三态：GET（缺省）/ POST（带 body）/ HEAD（只看响应头、不带 body）——与对面 RequestMethod 同形 */
  method: 'GET' | 'POST' | 'HEAD'
  headers: Record<string, string>
  body?: string
  /** 声明的响应 charset（如 gbk）——解码优先级高于 Content-Type/嗅探 */
  charset?: string
  webView: boolean
}

/** 兼容别名：历史名字（搜索面/详情面旧 import 路径不改） */
export type SearchRequest = RequestPlan

/** `,{` 切分单点在 `engine/template.ts` 的 `URL_OPTION_SPLIT`（切分式与病史都记在那里）——
 *  本文件与 `engine/js-protocol.ts` 共用同一式，不再各抄一份。 */
/** searchUrl → { URL 部分, 选项 }。不含 `,{` → 选项 undefined。 */
export function parseUrlOption(template: string): { urlPart: string; option: RequestOption | undefined } {
  const m = URL_OPTION_SPLIT.exec(template)
  if (m === null) return { urlPart: template, option: undefined }
  // 切分口径：`\s*,\s*(?=\{)` 命中即**无条件切分** URL——选项 JSON 是否合法只决定「拿没拿到
  // 选项」，不决定「URL 干不干净」。曾把整串（含 `,{…}`）当 URL 发出 → 站点 404（弯引号等
  // 坏选项形态实证，矩阵行 `b-split-unconditional`）。
  const urlPart = template.slice(0, m.index).trimEnd()
  const option = parseOptionJson(template.slice(m.index + m[0].length))
  if (option === undefined) {
    // 留痕（同 normalize 的 header 口径）：让「选项没生效」可见，但不改变已切分的 URL。
    console.warn(`[dsh-novel] URL 选项不是合法 JSON，按无选项请求（URL 已切分）：${JSON.stringify(template)}`)
  }
  return { urlPart, option }
}

/** 选项 JSON：宽松引号解析归 `normalize.parseObjectJson` 单点（头与 URL 选项共用同一份——
 *  严格 JSON 优先，失败回退单引号交换，`{'a':'b'}` → `{"a":"b"}`）。 */
/** 本插件实现的 UrlOption 键集（书源格式的键集更大：retry/type/js/bodyJs/dnsIp/serverID/webJs/origin…） */
const KNOWN_OPTION_KEYS = ['method', 'body', 'charset', 'headers', 'webView']

function parseOptionJson(text: string): RequestOption | undefined {
  const obj = parseObjectJson(text)
  if (obj === undefined) return undefined
  // 未知键留痕（宁吵不瞒——与「选项 JSON 非法」那条 warn 同一先例）：静默丢弃会让人以为选项
  // 生效了。现量与键例见矩阵行 `b-opt-unknown-keys`。
  const unknown = Object.keys(obj).filter((k) => !KNOWN_OPTION_KEYS.includes(k))
  if (unknown.length > 0) {
    console.warn(`[dsh-novel] URL 选项含本插件未实现的键，已忽略：${unknown.join('、')}`)
  }
  const option: RequestOption = {}
  if (typeof obj.method === 'string') option.method = obj.method
  if (typeof obj.body === 'string') option.body = obj.body
  if (typeof obj.charset === 'string') option.charset = obj.charset.toLowerCase()
  if (obj.webView === true) option.webView = true
  const headers = parseHeaders(obj.headers)
  if (headers !== undefined) option.headers = headers
  return option
}

/** headers 两形态：对象直通；字符串（双重编码的 JSON）再宽松解析一次（同 `parseObjectJson`
 *  口径——单引号形态对面读得出，这里同样读得出）；非法 → undefined（不猜）。
 *  「哪些键活着」走 `normalize.stringTableOf` 单点。 */
function parseHeaders(v: unknown): Record<string, string> | undefined {
  const obj = parseObjectJson(v)
  if (obj === undefined) return undefined
  return stringTableOf(obj)
}

/**
 * 表单体按声明 charset 转义：POST 的表单体（含 `{{key}}` 代入的关键词）按声明的 charset 逐段编码
 * （`option.charset` 在场即转义——当前**没有**「这份 body 是不是表单」的形状判别，默认
 * `urlencoded` 头还是在转义之后才补（`assembleRequest`）；「只在体非 JSON/XML 且未显式声明
 * Content-Type 才转义」是还没落地的意图，连同「逐字段编码」「`escape` 特例」两件事一起登记在
 * 矩阵 `b-opt-charset-form-fidelity`（本仓这条只是子集）。
 * JSON 体不是表单，转义它只会毁掉它——故那里要拍板的是补判别还是删这句）。
 * 为什么只重编码**非 ASCII**：本仓的体已过 interpolateUrl 的 UTF-8 转义，若对整串按 charset 重编码，
 * 会把 `%E4%B9%A6` 二次编码成 `%25E4%B9%A6`；故转义段先按 UTF-8 解码、直写字符直接用，再按 charset
 * 逐字节转义——同一关键词得到同一字节串，且不二次编码。
 * UTF-8 别名与 iconv 认不出的 charset 一律原样返回（认不出的由解码链的 DecodeError 点名，不在此猜）。
 * 真机实证（GBK 站发 UTF-8 关键词恒 0 命中）：见矩阵行 `b-opt-charset`。
 */
function encodeFormCharset(body: string, charset: string): string {
  if (!iconv.encodingExists(charset) || /^utf-?8$/i.test(charset.replace(/_/g, '-'))) return body
  const encode = (text: string): string =>
    [...iconv.encode(text, charset)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('')
  return body.replace(/%[0-9A-Fa-f]{2}(?:%[0-9A-Fa-f]{2})*|[^\x00-\x7F]+/g, (run) => {
    const text = run.startsWith('%') ? decodePercentRun(run) : run
    if (text === null || /^[\x00-\x7F]*$/.test(text)) return run
    return encode(text)
  })
}

/** 转义段按 UTF-8 解码；不是合法 UTF-8（早已被别的编码器编过的字节）→ null，调用方原样保留 */
function decodePercentRun(run: string): string | null {
  const hex = run.match(/%[0-9A-Fa-f]{2}/g) ?? []
  const bytes = Buffer.from(hex.map((h) => parseInt(h.slice(1), 16)))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch { return null }
}

/**
 * 选项语义的唯一主人：模板 + 变量 + baseUrl（null = 不做绝对化，@js ajax 形态用）→ 请求计划。
 * method 判定 / body 插值 / POST 表单默认 urlencoded / headers / charset 全部只在这里解释一遍
 * （曾两处各写一份、靠「与对方同口径」注释同步）。相对 URL 按 baseUrl 解析（官方「支持相对URL」；
 * 曾直接喂 fetch，相对 URL 全数打不到）。
 * trimFirstPage：Native 分页语义——模板以 `/{{page}}` 结尾时首页裁掉页码段（带 /1 站点直接 404）。
 */
export function assembleRequest(
  template: string, vars: Record<string, string | number>, baseUrl: string | null,
  opts?: { trimFirstPage?: boolean },
): RequestPlan {
  const { urlPart, option } = parseUrlOption(template)
  const effective = opts?.trimFirstPage === true && vars.page === 1 && urlPart.endsWith('/{{page}}')
    ? urlPart.slice(0, -'/{{page}}'.length)
    : urlPart
  const interpolated = interpolateUrl(effective, vars)
  // 页码角列表 `<a,b,c>`：在 key/js 求值之后、选项切分之前替换。
  // 本仓放在插值之后（同一位置），只对 URL 段生效——选项 JSON 含尖括号的形态现库无（矩阵行
  // `b-page-angle-list`），差异不可观测。
  const withPageList = expandPageAngleList(interpolated, typeof vars.page === 'number' ? vars.page : null)
  const url = baseUrl === null ? withPageList : (absUrl(withPageList, baseUrl) ?? withPageList)
  // method 三态（对面把 POST/HEAD 各分一支、其余落 GET——出处与对读记录见矩阵行 `b-opt-method-head`）：
  // HEAD 此前被并进「不是 POST 就 GET」那条路 → 声明 HEAD 的源实际发的是 GET（降级当成了实现）。
  const rawMethod = (option?.method ?? 'GET').toUpperCase()
  const method: RequestPlan['method'] = rawMethod === 'POST' ? 'POST' : rawMethod === 'HEAD' ? 'HEAD' : 'GET'
  const plan: RequestPlan = { url, method, headers: { ...(option?.headers ?? {}) }, webView: option?.webView === true }
  // HEAD 是「只看响应头」的方法，**不发 body**（对面同规则）：声明了 body 也丢掉，
  // 免得把表单体连同 urlencoded 头一起发出去，把一次元数据探测变成真的写请求。
  if (option?.body !== undefined && method !== 'HEAD') {
    const raw = interpolateUrl(option.body, vars)
    plan.body = option.charset === undefined ? raw : encodeFormCharset(raw, option.charset)
  }
  if (option?.charset !== undefined) plan.charset = option.charset
  // POST 表单体默认 urlencoded（浏览器表单同款语义）：不补的话 Node fetch 发 text/plain，
  // PHP 等表单端点 $_POST 解析不到字段（站点收空关键词返回空页）
  if (plan.body !== undefined && !Object.keys(plan.headers).some((k) => k.toLowerCase() === 'content-type')) {
    plan.headers['Content-Type'] = 'application/x-www-form-urlencoded'
  }
  return plan
}

/**
 * fetch init 姿态的单点（此前 search-face / reading / bridge 三处各组装一遍）：
 * GET **不带 method 键**（fetch 缺省即 GET）；POST 带 method 与插值后的 body；
 * HEAD 带 method 且**不带 body**（与对面同口径：HEAD 是元数据探测，不该把体发出去）。
 * baseHeaders（如源级 headerOf）打底，计划 headers 覆盖同名。
 */
export function fetchInitOf(
  plan: RequestPlan, baseHeaders?: Record<string, string>,
): { headers: Record<string, string>; method?: string; body?: string } {
  const init: { headers: Record<string, string>; method?: string; body?: string } = {
    headers: { ...(baseHeaders ?? {}), ...plan.headers },
  }
  if (plan.method === 'HEAD') init.method = 'HEAD'
  if (plan.method === 'POST') {
    init.method = 'POST'
    if (plan.body !== undefined) init.body = plan.body
  }
  return init
}

/** URL 尾部 `,{option}` 后缀切分（章节/下一页 URL 常带——嗅探语义）。
 *  只认「逗号 + 完整 JSON 对象收尾」形态（严格 JSON 或单引号形态），正文里的 `{a,b}` 不误剥。
 *  `suffix` 是**原文**（含逗号），绝对化后原样接回——选项语义由 assembleRequest 在抓取时解释。 */
export function splitUrlOption(href: string): { url: string; suffix: string | null } {
  const m = URL_OPTION_SPLIT.exec(href)
  if (m === null) return { url: href, suffix: null }
  // 同 parseUrlOption 的切分口径（命中即无条件取串首部分，不做尾段 JSON 校验）：
  // 命中即切、**不校验尾段是不是合法 JSON**——后缀原文保留给抓取时的 assembleRequest
  // 解释（解析失败 → 无选项 + warn，URL 已干净）；`{a,b}` 形态不受影响（逗号后不是 `{`，正则不命中）。
  return { url: href.slice(0, m.index).trimEnd(), suffix: href.slice(m.index) }
}

/** URL 尾部的 `,{"webView":true}` 选项后缀剥离（兼容入口——语义即 splitUrlOption().url）。
 *  我们不支持 WebView，但抓取层会按普通请求带选项照常尝试（assembleRequest 解释其余选项）。 */
export function stripUrlOption(href: string): string {
  return splitUrlOption(href).url
}

/** 绝对化并保留选项后缀（章节/下一页 URL 的组装口径：
 *  URL 部分按 baseUrl 绝对化，`",{option}"` 接回）。此前先 strip 再绝对化 → POST/charset
 *  选项在目录落库时被丢弃，API 型章节端点（POST body 模板）全部退化成裸 GET。 */
export function absUrlKeepOption(href: string, base: string): string | null {
  const { url, suffix } = splitUrlOption(href)
  const abs = absUrl(url, base)
  if (abs === null) return null
  return suffix === null ? abs : abs + suffix
}

/** 比对口径（串章闸/防环）：剥选项后缀 → URL 归一化（new URL().href）；解析失败回原文。
 *  目录章地址与「下一页」候选都过这一层再比对——选项/编码差异不参与判等。 */
export function canonUrl(u: string, base?: string): string {
  const { url } = splitUrlOption(u)
  try { return new URL(url, base).href } catch { return url }
}

/** 搜索面入口（历史名字保留）：assembleRequest 的搜索专用薄壳 */
export function buildSearchRequest(
  template: string, vars: Record<string, string | number>, baseUrl: string,
  opts?: { trimFirstPage?: boolean },
): RequestPlan {
  return assembleRequest(template, vars, baseUrl, opts)
}

