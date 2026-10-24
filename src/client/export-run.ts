import { describeError } from './api.js'
import { saveBlob, streamExport } from './download.js'
import { zhTranslate } from './copy/index.js'
import type { CopyKey, Translate } from './copy/index.js'

/**
 * 范围导出流编排（从 ReaderView 的 ExportPanel 收出）：start(范围) / cancel / 状态三态 + 卸载 abort。
 *
 * 为什么收出来：整段原先住在 ReaderView 里硬 import 真实现，导出时序零测试覆盖。现编排自持、
 * 依赖经参数注入：视图只接线（onProgress → setState、按钮 → start/cancel、卸载 → dispose），
 * 时序归本 module 单测。
 */

/** 导出流依赖（ReaderDeps 的子面）：流式抓取 + 落盘 */
export interface ExportRunDeps {
  /** 流式导出：fetch 流读取 → Blob，进度按已收字节回调 */
  streamExport: typeof streamExport
  /** Blob → 浏览器下载 */
  saveBlob: typeof saveBlob
}

/** 生产依赖：模块级真实现打包——createExportRun 缺省即它，接线零变化 */
export const prodExportDeps: ExportRunDeps = { streamExport, saveBlob }

/** 导出状态：空闲 / 运行中（KB 进度 + 章数标题 + 范围）/ 失败（错误类目投影，与阅读链路 error 分家） */
export interface ExportRunState {
  running: boolean
  /** 已收字节数（KB） */
  kb: number
  /** 「共 N 章」标题用；流未给 total 时为空串 */
  total: string
  /** 本次导出范围（无参 start = null 即全本）；落盘文件名按它加范围后缀 */
  range: ExportRange | null
  /** 导出失败单独一条：code 可选（ApiClientError 才有），message 必有 */
  error: { code?: string; message: string } | null
}

/** 导出范围（1 基含端）+ 全书章数：范围后缀文件名与流参数共用一个值形状 */
export interface ExportRange { from: number; to: number; total: number }

/** 空闲态字面量（视图初始值与失败后的重试复位都用它） */
export const IDLE_EXPORT: ExportRunState = { running: false, kb: 0, total: '', range: null, error: null }

/** 落盘文件名：全本（或 1..total 全覆盖）= 书名.txt；部分 = 书名（第5-80章）.txt——
 *  部分导出不加后缀会让人把片段当全本存丢。后缀随当前语言（文件名同样是用户可见文案）。 */
function exportFileName(title: string, range: ExportRange | null, t: Translate = zhTranslate): string {
  if (range === null || (range.from <= 1 && range.to >= range.total)) return `${title}.txt`
  return `${title}${t('reader.export.fileRange', { from: range.from, to: range.to })}.txt`
}

/** 面板范围校验（纯函数，视图确认钮的唯一判据）：
 *  空串 / 非整数 / 倒置 / 越界 → 拒；total<1 = 目录未就绪，同样拒（不许在章数未知时开下）。
 *  理由回**文案键**而不是成句：翻译归视图的 `t`，校验本身保持纯函数。 */
export type RangeParse =
  | { ok: false; reason: CopyKey }
  | { ok: true; from: number; to: number }

export function parseRange(fromStr: string, toStr: string, total: number): RangeParse {
  if (!Number.isInteger(total) || total < 1) return { ok: false, reason: 'reader.export.reason.tocNotReady' }
  if (fromStr.trim() === '' || toStr.trim() === '') return { ok: false, reason: 'reader.export.reason.missing' }
  const from = Number(fromStr)
  const to = Number(toStr)
  if (!Number.isInteger(from) || !Number.isInteger(to)) return { ok: false, reason: 'reader.export.reason.notInteger' }
  if (from > to) return { ok: false, reason: 'reader.export.reason.reversed' }
  if (from < 1 || to > total) return { ok: false, reason: 'reader.export.reason.outOfRange' }
  return { ok: true, from, to }
}

/** 导出范围草稿：面板上那两个输入框的全部状态——**只有用户输入的两格**。
 *  缺省、档位算术、校验三件事只住这里——视图此前各持一份（openExport 写缺省、onPreset 算档位、
 *  onConfirm 再校验一次），四处各写一遍同一件事就是没有 locality。
 *  章数刻意不进草稿：它是视图的**活值**（当前目录长度），抄进草稿就会停在装配或开面板那一下的读数上
 *  （目录迟到 / 变化即失真）——调用方每次把当下章数传进来。 */
export interface ExportDraft { from: string; to: string }

/** 全本缺省（打开面板那一下） */
export function draftOf(total: number): ExportDraft {
  return { from: '1', to: String(total) }
}

/** 档位：all = 全本；rest = 当前章的下一章起。
 *  total 由调用方按当下目录现给（不进草稿）：目录在面板开着时才到齐，这一次传递就把草稿的旧读数冲正。
 *  rest 在最后一章时钳到 total——from 越过 to 会让确认钮凭空禁用，用户读不出为什么。
 *  不收草稿入参：两格全由 kind / currentChapter / total 决定，草稿在这里没有可贡献的值。收进来只为凑
 *  签名，就会逼出一个 `{ ...d, ... }` 的空底——结构上更宽的对象可赋值给 `ExportDraft`（如带 total 的），
 *  多余的格便经由那个空底原样流回 `setExpDraft`，正是「草稿不沾派生读数」这条要挡的。 */
export function applyPreset(
  kind: 'all' | 'rest', currentChapter: number, total: number,
): ExportDraft {
  if (kind === 'all') return draftOf(total)
  const from = Math.min(currentChapter + 1, total)
  return { from: String(from), to: String(total) }
}

/** 确认钮的唯一判据（视图只渲染 reason，不自己判；面板另有「共 N 章」与输入框 max 这类活读数，
 *  直接读 total，不归这里）；章数同样按调用方现给的活值 */
export function validRangeOf(d: ExportDraft, total: number): RangeParse {
  return parseRange(d.from, d.to, total)
}

/** AbortError 判定：取消/卸载是主动行为，不许当成导出失败弹错误条 */
function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'name' in e && e.name === 'AbortError'
}

/** 错误类目投影：ApiClientError 带 code（导出失败可分类呈现）；普通 Error 只有 message，不伪造 code。
 *  客户端网络错误在这里就落成当前语言（快照的口径与 job 层一致：语言取生成时那一次）。 */
function errorOf(e: unknown, t: Translate = zhTranslate): { code?: string; message: string } {
  const code = typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : undefined
  const message = describeError(e, t)
  return code === undefined ? { message } : { code, message }
}

/** 一次导出运行的控制柄：state 为只读快照，变化经 onChange 推给视图 */
export interface ExportRun {
  readonly state: ExportRunState
  /** 发起导出（带范围 = 部分导出；无参 = 全本。在途重复调用忽略——同钮再点是取消，不是重入） */
  start: (range?: ExportRange | null) => void
  /** 取消在途导出（AbortError 静默：不算失败） */
  cancel: () => void
  /** 卸载收尾：abort 在途流，不许孤儿抓取 */
  dispose: () => void
}

export function createExportRun(ctx: {
  sourceId: string
  bookKey: string
  title: string
  /** 依赖束：缺省生产实现；测试注入假 streamExport/saveBlob */
  deps?: ExportRunDeps
  /** 文案语言：落盘文件名与网络错误在**生成时**定语言（与 job store 同一条已知限制）；
   *  缺省 zh 让未接 locale 的调用方与既有测试保持中文。 */
  t?: Translate
  /** 状态变化回调（视图的 setState 接线口） */
  onChange: (state: ExportRunState) => void
}): ExportRun {
  const deps = ctx.deps ?? prodExportDeps
  const t = ctx.t ?? zhTranslate
  let state: ExportRunState = IDLE_EXPORT
  let ctrl: AbortController | null = null
  const set = (patch: Partial<ExportRunState>): void => {
    state = { ...state, ...patch }
    ctx.onChange(state)
  }
  return {
    get state(): ExportRunState { return state },
    start: (range: ExportRange | null = null): void => {
      if (state.running) return
      const c = new AbortController()
      ctrl = c
      set({ running: true, kb: 0, total: '', range, error: null })
      void deps.streamExport({
        sourceId: ctx.sourceId,
        bookKey: ctx.bookKey,
        title: ctx.title,
        from: range?.from,
        to: range?.to,
        onProgress: (bytes, total) => set({ kb: Math.round(bytes / 1024), total: total ?? '' }),
        signal: c.signal,
      }).then((blob) => {
        deps.saveBlob(blob, exportFileName(ctx.title, range, t))
      }, (e: unknown) => {
        if (!isAbort(e)) set({ error: errorOf(e, t) })
      }).finally(() => set({ running: false }))
    },
    cancel: (): void => { ctrl?.abort() },
    dispose: (): void => { ctrl?.abort() },
  }
}
