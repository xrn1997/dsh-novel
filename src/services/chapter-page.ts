/**
 * 章节分页判定（防串章闸；判据按「同源 + 路径比对」，见下）。
 *
 * 为什么需要：站点末页的「下一页」常指向**下一章**——笔趣阁正文规则就写着
 * `nextPageUrl: .prenext span:last-child a@href`。闭眼跟进会把后续章节拼进本章：
 * 实测第 1 章被拼成 35,846 字 / 648 段（≈50 章，撞页数上限才停）。
 *
 * 判据（同源为前提，路径比对）：
 *  ① 路径（去扩展名）完全相等 → 同章；查询参数须一致，或只由页码类键构成（`?page=2` 这类
 *     标准分页放行——路径相同 + 页码键明确，串不了章；`?cid=2` 这类非页码键一律按不同章拦下）；
 *  ② 候选路径以入口路径为前缀 → 同章（分页后缀形态：`/c/1p2`、`/3943720-2`、`/x_2`）；
 *  ③ 其余一律视为**不同章**，停止跟进。
 * 取舍：判不准时**宁漏页不串章**——非页码键查询分页真要支持，需在书源里显式声明分页模板。
 */

/** 去掉结尾扩展名（`/c/1.html` → `/c/1`；仅用于比对，不参与输出） */
export function stripExtension(path: string): string {
  return path.replace(/\.[A-Za-z0-9]+$/, '')
}

/** 页码类查询键（放行标准分页；其余非页码键按「另一篇内容」拦下） */
const PAGE_PARAM_RE = /^(?:page|p|pg|pn|pageno|pagenum|page_no|page_num|pageindex|page_index|页码)$/i

function isPagingQuery(params: URLSearchParams): boolean {
  const keys = [...params.keys()]
  return keys.length > 0 && keys.every((k) => PAGE_PARAM_RE.test(k))
}

interface PageRef { origin: string; path: string; search: string }

/** 归一为可比对形态（同源校验 + 去扩展名）；解析失败 → null */
function pageRefOf(url: string, base: string): PageRef | null {
  let parsed: URL
  try {
    parsed = new URL(url, base)
  } catch {
    return null
  }
  return { origin: parsed.origin, path: stripExtension(parsed.pathname), search: parsed.search }
}

/**
 * 候选 URL 是否仍属入口章（同章才允许继续跟进）。
 * @param url 候选下一页地址（规则取到后已绝对化的）  @param chapterBaseUrl 目录给出的入口章地址
 */
export function isSameChapterPage(url: string, chapterBaseUrl: string): boolean {
  const candidate = pageRefOf(url, chapterBaseUrl)
  const entry = pageRefOf(chapterBaseUrl, chapterBaseUrl)
  if (candidate === null || entry === null) return false
  if (candidate.origin !== entry.origin) return false          // 跨站「下一页」不是本章续页
  if (candidate.path === entry.path) {
    if (candidate.search === entry.search) return true         // 同页（含重复链接）
    const params = new URLSearchParams(candidate.search)
    return entry.search === '' ? isPagingQuery(params) : `?${params.toString()}` === entry.search
  }
  // 前缀形态（分页后缀）：候选带查询即判不准 → 拦下
  return candidate.search === '' && candidate.path.startsWith(entry.path)
}
