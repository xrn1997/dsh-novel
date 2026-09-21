import { interpolateUrl, URL_OPTION_SPLIT } from '../engine/index.js'
import { absUrl } from './url.js'

/** legado URL 模板请求形态（官方文档 §URL必知必会 钉死）：
 *  ① 纯 URL：`/search?q={{key}}`（支持相对 URL——按 bookSourceUrl 解析）
 *  ② URL+选项：`url,{"method":"POST","body":"...","charset":"gbk","headers":"{...}","webView":true}`
 *  选项 JSON 允许单引号形态（真实源大量存在——宽容引号但不猜结构）；
 *  headers 可为 JSON 字符串（双重编码——legado 常见形态）。
 *  现状真相与口径：docs/design/services.md。 */
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
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
  /** 声明的响应 charset（如 gbk）——解码优先级高于 Content-Type/嗅探 */
  charset?: string
  webView: boolean
}

/** 兼容别名：历史名字（搜索面/详情面旧 import 路径不改） */
export type SearchRequest = RequestPlan

/** `,{` 切分单点在 `engine/template.ts` 的 `URL_OPTION_SPLIT`（legado paramPattern 原文、
 *  「不许空格曾让 165 条源的选项失效」病史都记在那里）——本文件与 `engine/js-protocol.ts`
 *  共用同一式，不再各抄一份。 */
/** searchUrl → { URL 部分, 选项 }。不含 `,{` → 选项 undefined。 */
export function parseUrlOption(template: string): { urlPart: string; option: RequestOption | undefined } {
  const m = URL_OPTION_SPLIT.exec(template)
  if (m === null) return { urlPart: template, option: undefined }
  // legado `AnalyzeUrl.analyzeUrl` 口径：paramPattern（`\s*,\s*(?=\{)`）命中即**无条件切分** URL——
  // 选项 JSON 是否合法只决定「拿没拿到选项」，不决定「URL 干不干净」。旧行为解析失败时把整串
  // （含 `,{…}`）当 URL 发出 → 站点 404（年代小说 chapterUrl 拼 `,{webView:“true”}` 弯引号形态实证；
  // legado 对它同样解析失败，但 URL 已在解析**之前**切干净，只是没有选项）。
  const urlPart = template.slice(0, m.index).trimEnd()
  const option = parseOptionJson(template.slice(m.index + m[0].length))
  if (option === undefined) {
    // 留痕（同 normalize 的 header 口径）：让「选项没生效」可见，但不改变已切分的 URL。
    console.warn(`[dsh-novel] URL 选项不是合法 JSON，按无选项请求（URL 已切分）：${JSON.stringify(template)}`)
  }
  return { urlPart, option }
}

/** 选项 JSON：严格 JSON 优先；失败回退单引号交换（`{'a':'b'}` → `{"a":"b"}`——真实源大量存在） */
function parseOptionJson(text: string): RequestOption | undefined {
  const tryParse = (t: string): Record<string, unknown> | undefined => {
    try {
      const v = JSON.parse(t) as unknown
      return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined
    } catch { return undefined }
  }
  const obj = tryParse(text) ?? tryParse(text.replace(/'/g, '"'))
  if (obj === undefined) return undefined
  const option: RequestOption = {}
  if (typeof obj.method === 'string') option.method = obj.method
  if (typeof obj.body === 'string') option.body = obj.body
  if (typeof obj.charset === 'string') option.charset = obj.charset.toLowerCase()
  if (obj.webView === true) option.webView = true
  const headers = parseHeaders(obj.headers)
  if (headers !== undefined) option.headers = headers
  return option
}

/** headers 两形态：对象直通；字符串（双重编码的 JSON）再 parse 一次——非法 → undefined（不猜） */
function parseHeaders(v: unknown): Record<string, string> | undefined {
  let obj: unknown = v
  if (typeof v === 'string') {
    try { obj = JSON.parse(v) } catch { return undefined }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val
  }
  return out
}

/**
 * 选项语义的唯一主人：模板 + 变量 + baseUrl（null = 不做绝对化，@js ajax 形态用）→ 请求计划。
 * method 判定 / body 插值 / POST 表单默认 urlencoded / headers / charset 全部只在这里解释一遍
 * （此前 buildSearchRequest 与 engineFetch 各写一份，靠「与对方同口径」注释同步——上轮搜索面统一前的同款病）。
 * 相对 URL 按 baseUrl 解析（官方「支持相对URL」；此前直接喂 fetch 是 148 条失败的根因）。
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
  const url = baseUrl === null ? interpolated : (absUrl(interpolated, baseUrl) ?? interpolated)
  const method = (option?.method ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET'
  const plan: RequestPlan = { url, method, headers: { ...(option?.headers ?? {}) }, webView: option?.webView === true }
  if (option?.body !== undefined) plan.body = interpolateUrl(option.body, vars)
  if (option?.charset !== undefined) plan.charset = option.charset
  // POST 表单体默认 urlencoded（浏览器表单同款语义）：不补的话 Node fetch 发 text/plain，
  // PHP 等表单端点 $_POST 解析不到字段（帝国 CMS 搜索收空关键词返回空页——99% 的 POST 源都踩这个）
  if (plan.body !== undefined && !Object.keys(plan.headers).some((k) => k.toLowerCase() === 'content-type')) {
    plan.headers['Content-Type'] = 'application/x-www-form-urlencoded'
  }
  return plan
}

/**
 * fetch init 姿态的单点（此前 search-face / reading / bridge 三处各组装一遍）：
 * GET **不带 method 键**（fetch 缺省即 GET）；POST 带 method 与插值后的 body。
 * baseHeaders（如源级 headerOf）打底，计划 headers 覆盖同名。
 */
export function fetchInitOf(
  plan: RequestPlan, baseHeaders?: Record<string, string>,
): { headers: Record<string, string>; method?: string; body?: string } {
  const init: { headers: Record<string, string>; method?: string; body?: string } = {
    headers: { ...(baseHeaders ?? {}), ...plan.headers },
  }
  if (plan.method === 'POST') {
    init.method = 'POST'
    if (plan.body !== undefined) init.body = plan.body
  }
  return init
}

/** URL 尾部 `,{option}` 后缀切分（章节/下一页 URL 常带——legado 嗅探语义）。
 *  只认「逗号 + 完整 JSON 对象收尾」形态（严格 JSON 或单引号形态），正文里的 `{a,b}` 不误剥。
 *  `suffix` 是**原文**（含逗号），绝对化后原样接回——选项语义由 assembleRequest 在抓取时解释。 */
export function splitUrlOption(href: string): { url: string; suffix: string | null } {
  const m = URL_OPTION_SPLIT.exec(href)
  if (m === null) return { url: href, suffix: null }
  // 同 parseUrlOption 的 legado 口径（BookChapter.getAbsoluteURL 无条件 substringBefore(paramPattern)）：
  // paramPattern 命中即切、**不校验尾段是不是合法 JSON**——后缀原文保留给抓取时的 assembleRequest
  // 解释（解析失败 → 无选项 + warn，URL 已干净）；`{a,b}` 形态不受影响（逗号后不是 `{`，正则不命中）。
  return { url: href.slice(0, m.index).trimEnd(), suffix: href.slice(m.index) }
}

/** URL 尾部的 `,{"webView":true}` 选项后缀剥离（兼容入口——语义即 splitUrlOption().url）。
 *  我们不支持 WebView，但抓取层会按普通请求带选项照常尝试（assembleRequest 解释其余选项）。 */
export function stripUrlOption(href: string): string {
  return splitUrlOption(href).url
}

/** 绝对化并保留选项后缀（章节/下一页 URL 的组装口径——legado BookChapter.getAbsoluteURL：
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

