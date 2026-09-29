import { apiEventStream, apiGet, apiSend, apiUpload } from './api.js'
import { saveBlob, streamExport } from './download.js'
import { fetchJobStatus, getLastImportJob, startBatchProbeJob, startImportJob } from './jobs.js'
import { pushError, pushOk } from './transient.js'

/**
 * client 依赖 seam 分两层（三主视图共用的核心束 + 按区扩展的加面）：
 *
 * ClientCoreDeps = 三视图需要的最小束：wire 请求 + 瞬态上报。为什么注入：视图硬 import 真实现
 * 时，接线层的 bug（乐观态不回滚、陈旧回调、误导性空态）无法被测试驱动——现在 interface 即
 * 测试面，生产缺省 prodCoreDeps（接线不变），测试给假 adapter。
 *
 * pushOk 在核心束而非设置束：书架的本地上传是异步的，落地时用户可能已切走，那条成功必须有
 * 地方说（见 ShelfView 的 alive 闸）。
 *
 * SettingsDeps = 核心束超集（+任务面）；ReaderDeps = 核心束超集（+导出流）——三主视图同口径。
 */
export interface ClientCoreDeps {
  /** wire GET（信封解包） */
  apiGet: typeof apiGet
  /** wire 请求（PUT/POST/DELETE 信封面） */
  apiSend: typeof apiSend
  /** 原始字节上传（本地书导入：TXT / EPUB 按内容分流） */
  apiUpload: typeof apiUpload
  /** SSE 读流（搜索进度的推送加速器；连不上时调用方回落快照轮询） */
  apiEventStream: typeof apiEventStream
  /** 瞬态层：错误上报（带锚点可选） */
  pushError: typeof pushError
  /** 瞬态层：显式保存类成功（少而淡策略，TTL 自动退场） */
  pushOk: typeof pushOk
}

/** 三视图的生产依赖：模块级真实现的打包——视图缺省即它，接线零变化 */
export const prodCoreDeps: ClientCoreDeps = { apiGet, apiSend, apiUpload, apiEventStream, pushError, pushOk }

/** 设置区依赖束：核心束超集 + 任务面 */
export interface SettingsDeps extends ClientCoreDeps {
  /** 后台任务提交（导入 / 批量验证）与最近导入任务缓存的读口 */
  startImportJob: typeof startImportJob
  startBatchProbeJob: typeof startBatchProbeJob
  lastImportJob: () => ReturnType<typeof getLastImportJob>
  /** 任务状态拉取（已接线：常驻状态层 `NovelStatusOverlay` 把整个 deps 交给 `jobs.ts` 的
   *  `useJobPolling`，轮询经它取数并写 `jobSurface`——测试可换确定性时钟） */
  fetchJobStatus: typeof fetchJobStatus
}

/** 生产依赖：模块级真实现的打包——视图缺省即它，接线零变化 */
export const prodDeps: SettingsDeps = {
  ...prodCoreDeps,
  pushOk,
  startImportJob,
  startBatchProbeJob,
  lastImportJob: getLastImportJob,
  fetchJobStatus,
}

/** 阅读区依赖束：核心束超集 + 导出流（streamExport/saveBlob）。
 *  ReaderView 此前是三个主视图里唯一不吃 ClientCoreDeps 的——口径自此与 ShelfView/SearchView 齐平。 */
export interface ReaderDeps extends ClientCoreDeps {
  /** 流式导出（fetch 流读取 → Blob）与落盘下载；编排归 export-run.ts */
  streamExport: typeof streamExport
  saveBlob: typeof saveBlob
  /** 进度防抖窗口（缺省 2s，见 ReaderSession 构造）——测试收紧，免得用例拿墙钟干等整个防抖窗
   *  （jobs 轮询「测试可换确定性时钟」同一先例） */
  saveDebounceMs?: number
}

/** 阅读区生产依赖：模块级真实现的打包——视图缺省即它，接线零变化 */
export const prodReaderDeps: ReaderDeps = { ...prodCoreDeps, streamExport, saveBlob }
