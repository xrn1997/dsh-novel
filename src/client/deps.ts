import { apiEventStream, apiGet, apiSend, apiUpload } from './api.js'
import { saveBlob, streamExport } from './download.js'
import { fetchJobStatus, getLastImportJob, startBatchProbeJob, startImportJob } from './jobs.js'
import { pushError, pushOk } from './transient.js'
import { JOB_POLL_MS } from './util.js'

/**
 * client 依赖 seam：束按**读者**切，不按方便切。
 * 为什么收窄：视图硬 import 真实现时接线层的 bug 无法被测试驱动——interface 即测试面。一条用例要
 * 构造的成员数就是固定成本：被逼提供用不上的面，成本付在每个用例上、收益落在零个用例上。
 *
 * 分工：`ClientCoreDeps` = 三视图与浮层共用的四件；`JobWatchDeps` = 观察一条后台任务的通道；
 * `JobViewDeps` = 把观察通道嵌进界面的读者；`ShelfDeps` = 需要原始字节上传的读者；
 * `SettingsDeps` / `ReaderDeps` = 各自加面；`RowActionDeps` = 行内动作（一发写请求 + 两句上报）。
 * `pushOk` 在核心束而非设置束：书架的本地上传落地时用户可能已切走，那条成功必须有地方说。
 */
export interface ClientCoreDeps {
  /** wire GET（信封解包） */
  apiGet: typeof apiGet
  /** wire 请求（PUT/POST/DELETE 信封面） */
  apiSend: typeof apiSend
  /** 瞬态层：错误上报（带锚点可选） */
  pushError: typeof pushError
  /** 瞬态层：显式保存类成功（少而淡策略，TTL 自动退场） */
  pushOk: typeof pushOk
}

/** 观察一条在跑的后台任务所需的通道：读面 + 推送加速器 + 节奏。节奏是 seam 的一格而非常量——
 *  节拍必须可注入，否则测试要驱动「等到下一拍」就得干等墙钟。缺省仍是 `JOB_POLL_MS`。 */
export interface JobWatchDeps {
  apiGet: typeof apiGet
  apiSend: typeof apiSend
  /** SSE 读流（推送加速器；连不上时通道自己回落快照轮询） */
  apiEventStream: typeof apiEventStream
  jobPollMs?: number
}

/** 把任务观察嵌进界面的读者：搜索结果页、书籍详情浮层、书城 */
export type JobViewDeps = ClientCoreDeps & JobWatchDeps

/** 需要原始字节上传的读者（本地书导入：TXT / EPUB 按内容分流） */
export interface ShelfDeps extends ClientCoreDeps {
  apiUpload: typeof apiUpload
}

/** 三视图的生产依赖：模块级真实现的打包——视图缺省即它，接线零变化 */
export const prodCoreDeps: ClientCoreDeps = { apiGet, apiSend, pushError, pushOk }

/** **行内动作**读者的依赖面：一发写请求 + 两句上报。行与浮层里的每一条都只管动作，既不读面、
 *  也不观察任务；宽束仍由整壳读者持有并原样传下来。 */
export type RowActionDeps = Pick<ClientCoreDeps, 'apiSend' | 'pushOk' | 'pushError'>

/** 观察通道的生产依赖 */
export const prodJobWatchDeps: JobWatchDeps = { apiGet, apiSend, apiEventStream, jobPollMs: JOB_POLL_MS }

/** 搜索结果页 / 书籍详情浮层 / 书城的生产依赖 */
export const prodJobViewDeps: JobViewDeps = { ...prodCoreDeps, ...prodJobWatchDeps }

/** 书架的生产依赖 */
export const prodShelfDeps: ShelfDeps = { ...prodCoreDeps, apiUpload }

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
  startImportJob,
  startBatchProbeJob,
  lastImportJob: getLastImportJob,
  fetchJobStatus,
}

/** 阅读区依赖束：核心束超集 + 导出流（streamExport/saveBlob）；阅读区只加这两件。 */
export interface ReaderDeps extends ClientCoreDeps {
  /** 流式导出（fetch 流读取 → Blob）与落盘下载；编排归 export-run.ts */
  streamExport: typeof streamExport
  saveBlob: typeof saveBlob
  /** 进度防抖窗口（缺省 2s）——测试收紧，免得用例拿墙钟干等整个防抖窗。 */
  saveDebounceMs?: number
}

/** 阅读区生产依赖：模块级真实现的打包——视图缺省即它，接线零变化 */
export const prodReaderDeps: ReaderDeps = { ...prodCoreDeps, streamExport, saveBlob }
