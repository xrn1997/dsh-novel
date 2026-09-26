import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 数据根目录：$DSH_HOME ?? ~/.dsh，再拼 'novel'（布局钉死） */
export function novelDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(home, 'novel')
}

/** 原子写与损坏备份的命名约定——**唯一住址在这里**。
 *  病根（2026 评审记的隐式耦合）：删书的清点原先自己写死 `.tmp` / `.bak` 去猜低层留下的名字，
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
  constructor(readonly file: string, readonly cause: unknown) {
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
 * 随后任一次 edit 落盘都会用新状态覆盖整文件——用户的 642 条源无告警消失（数据丢失方向）。
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
    console.error(`[dsh-novel] ${file} 解析失败，已备份为 ${backupPathOf(file)}，拒绝按空结果继续：`, e)
    throw new CorruptJsonError(file, e)
  }
}

/** 同文件写串行化：并发 rename 同一目标在 Windows 上互斥失败（EPERM——
 *  实测批量导入 642 源并发 importOne 时 25 次炸在 sources.json rename）。按文件名排队，
 *  后写等前写落地再 rename，语义不变（最终落盘的仍是最后一次写的数据）。
 *  这是**所有**落盘的唯一低层写路径：注册表/书架 JSON 与 PageCache 正文共用（历史分叉：
 *  PageCache 曾自抄一份无排队的 writeAtomic，阅读 + 导出/工具并发抓同章实测 30/80 EPERM→500）。 */
const renameChains = new Map<string, Promise<void>>()

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
    await fs.rename(tmp, file)
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

/** 进程内防抖合并连续写：窗口内同文件多次 schedule 只落最后一次；flush 等待全部落地 */
export function createDebouncedWriter(delayMs = 100) {
  const pending = new Map<string, { data: unknown; timer: ReturnType<typeof setTimeout>; waiters: (() => void)[] }>()
  const flushOne = (file: string): Promise<void> => {
    const p = pending.get(file)
    if (!p) return Promise.resolve()
    clearTimeout(p.timer)
    pending.delete(file)
    return writeJsonAtomic(file, p.data).then(() => p.waiters.forEach((r) => r()))
  }
  return {
    schedule(file: string, data: unknown): void {
      const old = pending.get(file)
      if (old) clearTimeout(old.timer)
      const entry = { data, timer: setTimeout(() => void flushOne(file), delayMs), waiters: old?.waiters ?? [] }
      pending.set(file, entry)
    },
    flush(file?: string): Promise<void> {
      const files = file ? [file] : [...pending.keys()]
      return Promise.all(files.map(flushOne)).then(() => undefined)
    },
  }
}
