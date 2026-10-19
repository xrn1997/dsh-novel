import { apiEventStream, apiGet, apiSend, apiUpload } from './api.js'
import { saveBlob, streamExport } from './download.js'
import { fetchJobStatus, getLastImportJob, startBatchProbeJob, startImportJob } from './jobs.js'
import { pushError, pushOk } from './transient.js'
import { JOB_POLL_MS } from './util.js'

/**
 * client 依赖 seam：束按**读者**切，不按方便切。
 *
 * 为什么收窄：视图硬 import 真实现时，接线层的 bug（乐观态不回滚、陈旧回调、误导性空态）无法被
 * 测试驱动——interface 即测试面。而一条测试要构造的成员数就是它的固定成本：原先所有吃「核心束」的
 * 读者都被迫提供 `apiUpload`（只有书架读）与 `apiEventStream`（只有两条观察通道读），
 * 那两位的成本付在每一个用例上，收益落在零个用例上。
 *
 * 分工：
 * - `ClientCoreDeps` = 三视图与浮层真正共用的那四件（两条 wire 口 + 瞬态上报两位）。
 * - `JobWatchDeps` = 观察一条后台任务所需的通道（`useSearchJob` / `useExploreJob` 只吃这个）。
 * - `JobViewDeps` = 把观察通道嵌进界面的读者（搜索结果页、书籍详情浮层、书城）。
 * - `ShelfDeps` = 需要原始字节上传的读者（书架）。
 * - `SettingsDeps` / `ReaderDeps` = 各自加面（任务面 / 导出流）。
 * - `RowActionDeps` = 行与行内浮层那一级：一发写请求 + 两句上报（壳层把宽束原样传下来即可）。
 *
 * `pushOk` 在核心束而非设置束：书架的本地上传是异步的，落地时用户可能已切走，那条成功必须有
 * 地方说（见 ShelfView 的 alive 闸）。
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

/** 观察一条在跑的后台任务所需的通道：读面 + 推送加速器 + 节奏。
 *  节奏是 seam 的一格而不是常量：观察通道的节拍原先只有常量一个家，测试要驱动「等到下一拍」
 *  就得干等墙钟（一条用例 700ms 起）。缺省仍是 `JOB_POLL_MS`——生产接线零变化。 */
export interface JobWatchDeps {
  apiGet: typeof apiGet
  apiSend: typeof apiSend
  /** SSE 读流（推送加速器；连不上时通道自己回落快照轮询） */
  apiEventStream: typeof apiEventStream
  jobPollMs?: number
}

/** 把任务观察嵌进界面的读者：搜索结果页、书籍详情浮层、书城 */
export interface JobViewDeps extends ClientCoreDeps, JobWatchDeps {}

/** 需要原始字节上传的读者（本地书导入：TXT / EPUB 按内容分流） */
export interface ShelfDeps extends ClientCoreDeps {
  apiUpload: typeof apiUpload
}

/** 三视图的生产依赖：模块级真实现的打包——视图缺省即它，接线零变化 */
export const prodCoreDeps: ClientCoreDeps = { apiGet, apiSend, pushError, pushOk }

/** **行内动作**读者的依赖面：一发写请求 + 两句上报。行与浮层里的每一条都一样只管动作，
 *  既不读面、也不观察任务——`jobs.ts` 的 `JobStatusDeps` 是同一先例的更早一份。
 *  宽束仍由整壳读者（`SearchView` / `CityBookSheet` / `SourceList` 的壳层）持有并原样传下来。 */
export interface RowActionDeps extends Pick<ClientCoreDeps, 'apiSend' | 'pushOk' | 'pushError'> {}

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

/** 阅读区依赖束：核心束超集 + 导出流（streamExport/saveBlob）。
 *  ReaderView 此前是三个主视图里唯一不吃 ClientCoreDeps 的——口径自此与 ShelfView/SearchView 齐平。 */
export interface ReaderDeps extends ClientCoreDeps {
  /** 流式导出（fetch 流读取 → Blob）与落盘下载；编排归 export-run.ts */
  streamExport: typeof streamExport
  saveBlob: typeof saveBlob
  /** 进度防抖窗口（缺省 2s，见 ReaderSession 构造）——测试收紧，免得用例拿墙钟干等整个防抖窗
   *  （观察通道的 `jobPollMs` 同一先例） */
  saveDebounceMs?: number
}

/** 阅读区生产依赖：模块级真实现的打包——视图缺省即它，接线零变化 */
export const prodReaderDeps: ReaderDeps = { ...prodCoreDeps, streamExport, saveBlob }
