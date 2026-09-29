import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 测试临时目录登记簿：单一 owner 管 mkdtemp 的生命周期。用例各自 mkdtemp 用完即弃会往 %TEMP% 漏
 * 上百个目录，清理纪律散在几十处无法收敛——故收进一处：helper 只登记，setup.ts 每个测试文件
 * 结束时统一 rm。
 * 不在此文件直接 afterAll：helper 惰性 import 时顶层 suite 已开始收集，afterAll 挂不到文件级
 * 生命周期（实测钩子不触发、目录照漏）；setupFiles 每个文件前求值，注册的 afterAll 必触发。
 */

const dirs = new Set<string>()

/** 建一个带随机后缀的临时目录；返回路径，生命周期归 setup.ts 的文件级清理。 */
export async function makeTempDir(prefix = 'novel-test-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  dirs.add(dir)
  return dir
}

/** setup.ts 专用：取出并清空本文件已登记的目录。 */
export function takeRegisteredDirs(): string[] {
  const out = [...dirs]
  dirs.clear()
  return out
}

/**
 * 登记「写侧收尾」——删目录前必须先等这些 promise 落地。Shelf 用 100ms 尾沿防抖写，钩子先删、
 * timer 随后触发又把父目录建回来（「复活」不是删失败，重试治不了）；唯一步骤是先 flush 再删。
 * 测试自持的 Shelf/ReadingService 用 `trackService` 登记；删除本身另有二次 rm 兜底（setup.ts）。
 */
const cleanups: Array<() => Promise<void>> = []

function registerCleanup(fn: () => Promise<void>): void {
  cleanups.push(fn)
}

/** setup.ts 专用：等全部写侧收尾；单个失败不拖累其余，也绝不打挂测试。 */
export async function drainCleanups(): Promise<void> {
  const pending = cleanups.splice(0, cleanups.length)
  const results = await Promise.allSettled(pending.map((fn) => fn()))
  for (const r of results) {
    if (r.status === 'rejected') cleanupWarn(`[setup] 写侧收尾失败：${String(r.reason)}`)
  }
}

/**
 * 排障日志开关：`NOVEL_TEST_DEBUG=1` 才打印。清理是卫生不是断言，
 * 平时不该往测试输出里刷行（此前 77 个文件各刷 2 行）。
 */
export function debugLog(msg: string): void {
  if (process.env.NOVEL_TEST_DEBUG === '1') console.log(msg)
}

/** 同上，但用 warn。 */
export function debugWarn(msg: string): void {
  if (process.env.NOVEL_TEST_DEBUG === '1') console.warn(msg)
}

/**
 * **清理失败**专用告警：**默认打印**（不受 NOVEL_TEST_DEBUG 门控）——
  * 清理失败是观测性问题，默认静默等于零断言；常规进展用 debugLog。
 */
export function cleanupWarn(msg: string): void {
  console.warn(msg)
}

/** 任何带 flush() 的服务（Shelf / SourceRegistry / ReadingService）——只取删目录前必须等落地的那一面。 */
interface Flushable { flush(): Promise<void> }

/**
 * 服务登记守卫：每个实例只登记一次写侧收尾，幂等——同一个 Service 在多处被接住也不会重复 flush。
 * WeakSet 不阻碍 GC，且服务被换掉后旧条目自然消失。
 */
const registered = new WeakSet<object>()

/** 把服务交给登记簿：删目录前先 `flush()`（幂等，可安心在每个创建点都写一行）。 */
export function trackService<T extends Flushable>(svc: T): T {
  if (!registered.has(svc)) {
    registered.add(svc)
    registerCleanup(async () => { await svc.flush() })
  }
  return svc
}
