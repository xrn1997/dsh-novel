import { saveBlob, streamExport } from './download.js'

/**
 * 范围导出流编排（从 ReaderView 的 ExportPanel 收出）：start(范围) / cancel / 状态三态 + 卸载 abort。
 *
 * 此前整段住在 ReaderView 里并硬 import streamExport/saveBlob——阅读器因此是三个主视图里
 * 唯一不吃 deps 的（ShelfView/SearchView 都吃且有 views-wiring 测试），导出时序零覆盖。
 * 现在编排自持、依赖经参数注入：视图只接线（onProgress → setState、按钮 → start/cancel、
 * 卸载 → dispose），时序归本 module 单测。
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
 *  部分导出不加后缀会让人把片段当全本存丢 */
function exportFileName(title: string, range: ExportRange | null): string {
  if (range === null || (range.from <= 1 && range.to >= range.total)) return `${title}.txt`
  return `${title}（第${range.from}-${range.to}章）.txt`
}

/** 面板范围校验（纯函数，视图确认钮的唯一判据）：
 *  空串 / 非整数 / 倒置 / 越界 → 拒；total<1 = 目录未就绪，同样拒（不许在章数未知时开下） */
export type RangeParse =
  | { ok: false; reason: string }
  | { ok: true; from: number; to: number }

export function parseRange(fromStr: string, toStr: string, total: number): RangeParse {
  if (!Number.isInteger(total) || total < 1) return { ok: false, reason: '目录未就绪' }
  if (fromStr.trim() === '' || toStr.trim() === '') return { ok: false, reason: '请输入章节号' }
  const from = Number(fromStr)
  const to = Number(toStr)
  if (!Number.isInteger(from) || !Number.isInteger(to)) return { ok: false, reason: '章节号需为整数' }
  if (from > to) return { ok: false, reason: '起始章不能大于结束章' }
  if (from < 1 || to > total) return { ok: false, reason: `范围需在 1–${total} 章内` }
  return { ok: true, from, to }
}

/** AbortError 判定：取消/卸载是主动行为，不许当成导出失败弹错误条 */
function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'name' in e && e.name === 'AbortError'
}

/** 错误类目投影：ApiClientError 带 code（导出失败可分类呈现）；普通 Error 只有 message，不伪造 code */
function errorOf(e: unknown): { code?: string; message: string } {
  const code = typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : undefined
  const message = e instanceof Error ? e.message : String(e)
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
  /** 状态变化回调（视图的 setState 接线口） */
  onChange: (state: ExportRunState) => void
}): ExportRun {
  const deps = ctx.deps ?? prodExportDeps
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
        deps.saveBlob(blob, exportFileName(ctx.title, range))
      }, (e: unknown) => {
        if (!isAbort(e)) set({ error: errorOf(e) })
      }).finally(() => set({ running: false }))
    },
    cancel: (): void => { ctrl?.abort() },
    dispose: (): void => { ctrl?.abort() },
  }
}
