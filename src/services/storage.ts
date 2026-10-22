import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { log } from './log.js'

/** 数据根目录：$DSH_HOME ?? ~/.dsh，再拼 'novel'（布局钉死） */
export function novelDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(home, 'novel')
}

/** 原子写与损坏备份的命名约定——**唯一住址在这里**。
 *  病根（一处隐式耦合）：删书的清点原先自己写死 `.tmp` / `.bak` 去猜低层留下的名字，
 *  「今天两处都对」靠的是没人改过命名，而不是有守卫。改成一个名字的现在：低层写与消费方
 *  （`localbooks.discard`）都从这里取值，改名只红一处。 */
const TEMP_SUFFIX = '.tmp'
const BACKUP_SUFFIX = '.bak'

/** 那次原子写的临时件路径（与主文件同目录；pid + 随机段避免并发撞名） */
export function tempPathOf(file: string): string {
  return `${file}.${process.pid}.${Math.random().toString(36).slice(2)}${TEMP_SUFFIX}`
}

/** 损坏 JSON 的备份路径 */
export function backupPathOf(file: string): string {
  return `${file}${BACKUP_SUFFIX}`
}

/** 目录项 `entry`（**裸文件名**，不带目录）是不是 `file` 那次原子写留下的残留 */
export function isAtomicTemp(file: string, entry: string): boolean {
  return entry.startsWith(`${path.basename(file)}.`) && entry.endsWith(TEMP_SUFFIX)
}

/** 数据文件存在但解析失败——与「文件不存在」是两回事，见 readJson。 */
export class CorruptJsonError extends Error {
  constructor(readonly file: string, override readonly cause: unknown) {
    const why = cause instanceof Error ? cause.message : String(cause)
    super(`数据文件损坏，拒绝按空结果继续（原文件已备份为 ${backupPathOf(file)}）：${file}（${why}）`)
    this.name = 'CorruptJsonError'
  }
}

/**
 * 读 JSON 文件：
 * - **文件不存在（ENOENT）** → fallback（首启无 sources.json/shelf.json 是常态）；
 * - **存在但解析失败** → 备份为 `<file>.bak` + 打日志 + 抛 CorruptJsonError。
 *
 * 解析失败绝不能折叠成 fallback：SourceRegistry.load 会把截断/损坏的 sources.json 读成空注册表，
 * 随后任一次 edit 落盘都会用新状态覆盖整文件——用户整库的源无告警消失（数据丢失方向）。
 */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw e                                  // 权限/IO 错误也不许伪装成空结果
  }
  try {
    return JSON.parse(raw) as T
  } catch (e) {
    await fs.copyFile(file, backupPathOf(file)).catch(() => undefined)
    log.error(`${file} 解析失败，已备份为 ${backupPathOf(file)}，拒绝按空结果继续：`, e)
    throw new CorruptJsonError(file, e)
  }
}

/** 同文件写串行化：并发 rename 同一目标在 Windows 上互斥失败（EPERM——批量导入与并发读正文
 *  都实测炸过）。按文件名排队，后写等前写落地再 rename，语义不变（最终落盘的仍是最后一次写的
 *  数据）。这是**所有**落盘的唯一低层写路径：注册表/书架 JSON 与 PageCache 正文共用
 *  （PageCache 曾自抄一份无排队的写，与导出/工具并发抓同章即 EPERM→500）。 */
const renameChains = new Map<string, Promise<void>>()

/** 瞬时 rename 冲突的有限重试：Windows 上杀软/索引器短暂持有目标文件会报 EPERM/EBUSY。
 *  只重这两个码；EACCES 这类持久性权限错直接抛，不把不可恢复的失败拖成延迟。 */
const RENAME_RETRYABLE = new Set(['EPERM', 'EBUSY'])
const RENAME_RETRY_DELAYS_MS = [10, 50, 200]
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function renameWithRetry(tmp: string, file: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (!RENAME_RETRYABLE.has(code ?? '') || attempt >= RENAME_RETRY_DELAYS_MS.length) throw e
      await sleep(RENAME_RETRY_DELAYS_MS[attempt]!)
    }
  }
}

/** 临时文件 + rename 原子写（低层、纯文本）；自动建父目录。序列化归调用方。
 *  入队先于任何 await（含 mkdir）：否则「谁先排进链」由 mkdir 完成顺序决定，
 *  最后调用的那次不保证最后落盘——注释承诺的「最终落盘的是最后一次写的数据」就不成立。 */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  const prev = renameChains.get(file) ?? Promise.resolve()
  // 链值 = 上一次写的结果（吞掉其错误——排队者只关心「轮到我」，不被前者的失败带崩）
  const run = prev.catch(() => undefined).then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = tempPathOf(file)
    await fs.writeFile(tmp, data, 'utf8')
    await renameWithRetry(tmp, file)
  })
  const tail = run.catch(() => undefined)
  renameChains.set(file, tail)
  try {
    await run
  } finally {
    if (renameChains.get(file) === tail) renameChains.delete(file) // 自己是链尾才清（有后继排队则留给后继）
  }
}

/** 临时文件 + rename 原子写（JSON）；与 writeFileAtomic 同一低层路径 */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(data, null, 2))
}

/** 进程内防抖合并连续写：窗口内同文件多次 schedule 只落最后一次；flush 等待全部落地。
 *  可选 `threshold`：累计到第 N 次 schedule 时立即写，并把「这次写落地」交给调用方 await——
 *  计数跨定时器/flush 写累计，只有阈值触发才复位（ADR 0011 的「累计 N 次」）；
 *  阈值与窗口的取值由调用方给（如 `SourceRegistry` 的 `PERSIST_EVERY`），防抖/计数/排队/失败合同只住这里。 */
export function createDebouncedWriter(delayMs = 100, opts: { threshold?: number } = {}) {
  type PendingWrite = { data: unknown; timer: ReturnType<typeof setTimeout> }
  const pending = new Map<string, PendingWrite>()
  const counts = new Map<string, number>()
  const threshold = opts.threshold ?? Number.POSITIVE_INFINITY
  // 已离开 pending、尚未落地的写。定时器一触发 pending 就删了，rename 在途这段窗口若不算「挂起」，
  // flush 会误判静默而提前 resolve——失败只剩「下一次 flush」可接，进程收尾时即未处理拒绝。
  const inflight = new Map<string, Promise<void>>()
  // 定时器触发的写没有调用方可接 rejection；失败留在这里，下一次 flush 如实抛给调用方
  const failed = new Map<string, unknown>()
  const takeFailure = (file?: string): { error: unknown } | undefined => {
    if (file !== undefined) {
      if (!failed.has(file)) return undefined
      const error = failed.get(file)
      failed.delete(file)
      return { error }
    }
    const first = failed.keys().next()
    if (first.done === true) return undefined
    const error = failed.get(first.value)
    failed.delete(first.value)
    return { error }
  }
  /** 摘一笔挂起写（清计时器）；摘走后它的失败归调用方的合同管。
   *  阈值计数**不在这里**复位：定时器/flush 写不清零，只有阈值触发那一次清零。 */
  const takePending = (file: string): PendingWrite | undefined => {
    const p = pending.get(file)
    if (!p) return undefined
    clearTimeout(p.timer)
    pending.delete(file)
    return p
  }
  /** 开写 + 在途登记（inflight 只摘自己：后继写可能已顶替）；失败合同由调用侧的入口定 */
  const launchWrite = (file: string, job: Promise<void>): Promise<void> => {
    inflight.set(file, job)
    const settled = (): void => { if (inflight.get(file) === job) inflight.delete(file) }
    job.then(settled, settled)
    return job
  }
  /** 落盘的唯一开写口：成功清旧失败账，rejection 原样留给调用侧。
   *  有人接的（阈值路径 / flush）默认如实抛给调用方、**不记账**——调用方已直接接住；
   *  调用方若要把失败留给下一次 flush（如注册表在 recipe 已抛错时），显式用 `retainFailure` 记一笔。 */
  const startWrite = (file: string, p: PendingWrite): Promise<void> =>
    launchWrite(file, writeJsonAtomic(file, p.data).then(() => { failed.delete(file) }))
  /** 定时器触发的那一笔：摘走挂起写后落盘。这一支没有调用方可接 rejection，所以失败由这里
   *  记账（留给下一次 flush 如实抛）并留下日志现场——两份重复的写代码就此收成一份开写口。 */
  const flushDeferred = (file: string): void => {
    const p = takePending(file)
    if (!p) return
    startWrite(file, p).catch((e: unknown) => {
      failed.set(file, e)
      log.error(`防抖落盘失败（等待下一次写重试）：${file}`, e)
    })
  }
  /** 摘走挂起写并落盘，失败如实抛（调用方是阈值路径或 flush）；没挂起的只等在途那笔
   *  （flush 的静默口径：计时器已触发、rename 在途的窗口也算挂起）。 */
  const flushOne = (file: string): Promise<void> => {
    const p = takePending(file)
    if (!p) return inflight.get(file) ?? Promise.resolve()
    return startWrite(file, p)
  }
  return {
    /** 阈值触发时返回本次写的 promise（失败如实抛），否则返回 undefined（交给防抖窗口）。 */
    schedule(file: string, data: unknown): Promise<void> | undefined {
      const old = pending.get(file)
      if (old) clearTimeout(old.timer)
      const count = (counts.get(file) ?? 0) + 1
      counts.set(file, count)
      const entry = {
        data,
        timer: setTimeout(() => {
          // 定时器路径没有调用方可接 rejection；日志与记账都归 flushDeferred
          flushDeferred(file)
        }, delayMs),
      }
      pending.set(file, entry)
      if (count < threshold) return undefined
      // 阈值触发即复位（与旧 `mutations = 0` 同口径）；定时器与 flush 写都不碰计数。
      counts.delete(file)
      return flushOne(file)
    },
    /** 调用方接住了一次写失败、但仍要让下一次 flush 看见时，把它记入失败账；
     *  同一文件下一次写成功即清账。注册表用它把阈值失败留给收尾 flush（recipe 已抛错时尤其）。 */
    retainFailure(file: string, error: unknown): void {
      failed.set(file, error)
    },
    /** 等齐落盘：排到**静默**，不是排「调用那一刻的快照」。
     *  只取一次快照的话，第一轮 I/O 在途时新 `schedule` 的那笔写留在计时器里——flush 已返回、
     *  进程收尾后它才自己烧：Windows 上表现为 `rename` 撞 EPERM 的未处理拒绝（门绿 exit≠0 的现场）。
     *  「挂起」同时算计时器里的 pending 与已开写未落地的 inflight：定时器触发后到 rename 落地之间的
     *  窗口也归 flush 管，否则在途失败会让 flush 提前返回、把错误丢给下一次。
     *  终止条件是「这一轮没有挂起写」，**刻意不设轮次上限**：加上限等于把同一个逃逸窗口藏回去。
     *  指定 file 时只等那一支（没有它的挂起写就立即 resolve）；定时器路径失败的写也会在这里抛出。 */
    async flush(file?: string): Promise<void> {
      for (;;) {
        const files = file === undefined
          ? [...new Set([...pending.keys(), ...inflight.keys()])]
          : pending.has(file) || inflight.has(file) ? [file] : []
        if (files.length === 0) {
          const failure = takeFailure(file)
          if (failure !== undefined) throw failure.error
          return
        }
        try {
          await Promise.all(files.map((f) => flushOne(f)))
        } catch (e) {
          const failure = takeFailure(file)
          throw failure === undefined ? e : failure.error
        }
      }
    },
  }
}
