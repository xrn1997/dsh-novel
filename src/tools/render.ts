import type { ShelfItem } from './shelf-item.js'

/**
 * 工具面的**纯文本投影**：规范值 → 模型读到的那一段文案。
 *
 * 为什么单独立家：render 是工具的 interface（模型只读这一份）；若六个 render 都内联在
 * `tools.ts` 的 `defineTool` 里，只有 search 有断言——其余五个的文案改动没有测试能拦住。
 * 纯函数可以直接喂规范值，不用起服务层；各工具定义只负责把 `text()` 包上。
 *
 * 规范值缺块即炸，不编「书目缺失」式回执：缺键投影归 `tools/project.ts`，render 只投影
 * 已声明的规范值。
 */

export interface SearchRenderValue {
  books: Array<{
    title: string
    author?: string
    sourceCount: number
    sources: Array<{ sourceName: string; url?: string }>
  }>
  failed: Array<{ sourceName: string; code: string }>
  searched: number
  answered: number
  filtered: number
  truncated?: string
}

/** 搜索结果：摘要行恒在；缺作者整键缺席（不印幽灵）；截断省略号按**行数**判。 */
export function renderSearch(v: SearchRenderValue): string {
  const lines = v.books.map((b) => `《${b.title}》${b.author === undefined ? '' : ` / ${b.author}`} · ${b.sourceCount} 家源：${
    b.sources.slice(0, 3).map((s) => `${s.sourceName}(${s.url ?? '无地址'})`).join('；')}${b.sources.length > 3 ? '…' : ''}`)
  const fails = v.failed.map((f) => `${f.sourceName}：${f.code}`).join('；')
  return `${v.books.length} 本（跑了 ${v.searched} 家、答话 ${v.answered} 家、滤去 ${v.filtered} 条不相关）：${
    lines.length === 0 ? '' : `\n${lines.join('\n')}`}`
    + `${v.failed.length === 0 ? '' : `\n${v.failed.length} 家未答话：${fails}`}`
    + `${v.truncated === undefined ? '' : `\n${v.truncated}`}`
}

export interface ReadRenderValue {
  bookKey: string
  chapterIndex: number
  chapterName: string
  text: string
}

/** 正文：只印前 2000 字，规范值含全文。 */
export function renderRead(v: ReadRenderValue): string {
  return `《${v.bookKey}》第 ${v.chapterIndex} 章（${v.chapterName}）共 ${v.text.length} 字：\n${v.text.slice(0, 2000)}${v.text.length > 2000 ? '…（截断，规范值含全文）' : ''}`
}

export interface TocRenderValue {
  bookKey: string
  total: number
  chapters: Array<{ chapterIndex: number; name: string }>
}

/** 目录规范值的章数上限：千章目录的 JSON 可达数百 KB，整份喂进 AI 上下文会挤掉正文。
 *  超限后 `total` 仍是全书章数、`chapterIndex` 仍可直接读任意章，只是超限部分的章名不在
 *  规范值里——render 如实报「只含前 N 章」，不假装目录被取全了。 */
export const TOC_CHAPTERS_CAP = 1000

/** 目录：只印前 10 章；规范值超 TOC_CHAPTERS_CAP 时说明只含前 N 章。 */
export function renderToc(v: TocRenderValue): string {
  const shown = v.chapters.slice(0, 10).map((c) => `[${c.chapterIndex}] ${c.name}`).join('\n')
  const omitted = v.total > v.chapters.length
    ? `\n…（截断，规范值只含前 ${v.chapters.length} 章，全书共 ${v.total} 章）`
    : v.total > 10 ? '\n…（截断，规范值含全部）' : ''
  return `《${v.bookKey}》共 ${v.total} 章：\n${shown}${omitted}`
}

export interface ShelfListRenderValue { books?: ShelfItem[] }
export interface ShelfBookRenderValue { book?: ShelfItem }
export interface ShelfRemoveRenderValue { removed?: boolean }
export type ShelfBookAction = 'add' | 'save_progress'

/** 书架列表：空架是一句结论，不是零行。 */
export function renderShelfList(v: ShelfListRenderValue): string {
  const books = v.books
  if (books === undefined) throw new Error('dshnovel_shelf list 回执缺少 books')
  if (books.length === 0) return '书架是空的。'
  return books.map((b) => {
    const p = b.progress
    return `《${b.title}》${b.author === undefined ? '' : ` / ${b.author}`} 读到第 ${p.chapterIndex} 章（${Math.round(p.offsetRatio * 100)}%）`
  }).join('\n')
}

/** 单本回执：add / save_progress 两个动作共用。 */
export function renderShelfBook(action: ShelfBookAction, v: ShelfBookRenderValue): string {
  const b = v.book
  if (b === undefined) throw new Error(`dshnovel_shelf ${action} 回执缺少 book`)
  return action === 'add'
    ? `已加书：《${b.title}》`
    : `已存进度：《${b.title}》读到第 ${b.progress.chapterIndex} 章`
}

export function renderShelfRemove(v: ShelfRemoveRenderValue): string {
  if (typeof v.removed !== 'boolean') throw new Error('dshnovel_shelf remove 回执缺少 removed')
  return `已移出书架（removed=${String(v.removed)}）`
}

export interface SourceRenderItem {
  sourceId: string
  name: string
  baseUrl: string
  enabled: boolean
  type: string
  status: string
  statusDetail?: string
}

export interface SourceListRenderValue { sources?: SourceRenderItem[] }
export interface SourceProbeRenderValue {
  ok?: boolean
  itemCount?: number
  firstTitle?: string
  error?: { code: string; message: string }
}
export interface SourceToggleRenderValue { enabled?: boolean; sourceId?: string }
export interface SourceRemoveRenderValue { sourceId?: string; removed?: boolean }

export function renderSourceList(v: SourceListRenderValue): string {
  const sources = v.sources
  if (sources === undefined) throw new Error('dshnovel_source list 回执缺少 sources')
  const on = sources.filter((s) => s.enabled).length
  return `共 ${sources.length} 个源（启用 ${on}）：${sources.slice(0, 10).map((s) => `${s.name}（${s.status}${s.enabled ? '' : '，已停用'}）`).join('；')}${sources.length > 10 ? '…（截断，规范值含全部）' : ''}`
}

export function renderSourceProbe(v: SourceProbeRenderValue): string {
  if (typeof v.ok !== 'boolean') throw new Error('dshnovel_source probe 回执缺少 ok')
  if (v.ok) {
    if (v.itemCount === undefined) throw new Error('dshnovel_source probe 成功回执缺少 itemCount')
    return `源可用：命中 ${v.itemCount} 条，首条「${v.firstTitle ?? ''}」`
  }
  if (v.error === undefined) throw new Error('dshnovel_source probe 失败回执缺少 error')
  return `源不可用：${v.error.code} ${v.error.message}`
}

export function renderSourceToggle(v: SourceToggleRenderValue): string {
  if (typeof v.enabled !== 'boolean' || v.sourceId === undefined) {
    throw new Error('dshnovel_source enable/disable 回执缺少 enabled/sourceId')
  }
  return `已${v.enabled ? '启用' : '停用'}源 ${v.sourceId}`
}

export function renderSourceRemove(v: SourceRemoveRenderValue): string {
  if (v.sourceId === undefined || typeof v.removed !== 'boolean') {
    throw new Error('dshnovel_source remove 回执缺少 sourceId/removed')
  }
  return `已删除源 ${v.sourceId}（removed=${String(v.removed)}）`
}

export interface ImportOutcomeRender {
  name: string
  ok: boolean
  dupSkipped?: boolean
  missing?: Array<{ field: string; message: string }>
}

export interface ImportRenderValue { outcomes?: ImportOutcomeRender[] }

/** 导入逐条回执：失败点名缺什么、去重命中说明保留已有、成功标注未验证。 */
export function renderImport(v: ImportRenderValue): string {
  const outcomes = v.outcomes
  if (outcomes === undefined) throw new Error('dshnovel_import_source 回执缺少 outcomes')
  return outcomes.map((o) => {
    if (!o.ok) return `✗ ${o.name}：缺 ${(o.missing ?? []).map((m) => m.field).join('、')}`
    if (o.dupSkipped === true) return `↷ ${o.name}：同址已有可用源，按址去重保留已有（未新增）`
    return `✓ ${o.name}（已导入，未验证——用 dshnovel_source probe 验证）`
  }).join('\n')
}
