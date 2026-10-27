import fs from 'node:fs'
import path from 'node:path'
import type { SourceSession } from '../engine/index.js'
import { log } from './log.js'
import { backupPathOf, CorruptJsonError, tempPathOf } from './storage.js'

type Bucket = 'vars' | 'cache' | 'cookies'

interface State {
  vars: Record<string, Record<string, string>>
  strings: Record<string, string>
  cache: Record<string, Record<string, string>>
  cookies: Record<string, Record<string, string>>
}

// 四张表用无原型对象：键来自源 baseUrl / 脚本变量名，`__proto__` 之类的键不许改到表原型
const emptyState = (): State => ({
  vars: Object.create(null) as State['vars'],
  strings: Object.create(null) as State['strings'],
  cache: Object.create(null) as State['cache'],
  cookies: Object.create(null) as State['cookies'],
})

const BUCKETS: readonly Bucket[] = ['vars', 'cache', 'cookies']

function corrupt(file: string, cause: unknown): never {
  try { fs.copyFileSync(file, backupPathOf(file)) } catch { /* 备份失败仍要抛：不拿空表继续 */ }
  log.error(`${file} 解析失败，已尝试备份为 ${backupPathOf(file)}，拒绝按空结果继续：`, cause)
  throw new CorruptJsonError(file, cause)
}

/** 读侧与 storage.readJson 同判据：ENOENT → 空表；存在但损坏 → 备份 + 抛（不折叠成空表，
 *  否则下一次写入会用空表覆盖掉全部源变量/会话 cookie）。 */
function readState(file: string): State {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
    throw e
  }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch (e) { corrupt(file, e) }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    corrupt(file, new Error('根不是对象'))
  }
  const obj = parsed as Record<string, unknown>
  const state = emptyState()
  for (const bucket of BUCKETS) {
    const table = obj[bucket]
    if (table === undefined) continue
    if (table === null || typeof table !== 'object' || Array.isArray(table)) {
      corrupt(file, new Error(`${bucket} 不是对象`))
    }
    for (const [key, entries] of Object.entries(table)) {
      if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) {
        corrupt(file, new Error(`${bucket}.${key} 不是键值表`))
      }
      const pairs: Record<string, string> = Object.create(null) as Record<string, string>
      for (const [k, v] of Object.entries(entries)) {
        if (typeof v !== 'string') corrupt(file, new Error(`${bucket}.${key}.${k} 不是字符串`))
        pairs[k] = v
      }
      state[bucket][key] = pairs
    }
  }
  if (obj.strings !== undefined) {
    if (obj.strings === null || typeof obj.strings !== 'object' || Array.isArray(obj.strings)) {
      corrupt(file, new Error('strings 不是对象'))
    }
    for (const [k, v] of Object.entries(obj.strings)) {
      if (typeof v !== 'string') corrupt(file, new Error(`strings.${k} 不是字符串`))
      state.strings[k] = v
    }
  }
  return state
}

/** 源状态持久化：写操作只标脏（脚本方法面同步），求值边界/卸载时 flush 一次整份落盘——
 *  同一段脚本的多次 set 合并成一次写；跨重启保留源变量/单串槽/cache/cookie 垫片。
 *
 *  **同步写是 ADR 0013 的刻意例外**：SourceSession 的方法面是同步的（脚本 `source.get`/`cache.get`
 *  不能等 IO），所以 flush 用同一种 tmp+rename（命名仍走 storage 的 `tempPathOf`/`backupPathOf`），
 *  由单线程同步调用保证同一文件的写不会互相插队。写失败只记日志、不打断读链路，脏标记留到
 *  下一次 flush 重试；进程崩溃最多丢当前求值批的写入（源状态是派生数据）。 */
class PersistentMap extends Map<string, string> {
  constructor(entries: Record<string, string>, private readonly onChange: () => void) {
    super()
    // 不能在 super(...) 里喂 entries：那会调用被覆写的 set，而 onChange 参数属性尚未赋值
    for (const [k, v] of Object.entries(entries)) Map.prototype.set.call(this, k, v)
  }

  override set(k: string, v: string): this {
    super.set(k, v)
    this.onChange()
    return this
  }

  override delete(k: string): boolean {
    const removed = super.delete(k)
    if (removed) this.onChange()
    return removed
  }

  override clear(): void {
    super.clear()
    this.onChange()
  }
}

export class FileSourceSession implements SourceSession {
  private state: State
  private readonly file: string
  private readonly maps = new Map<string, PersistentMap>()
  /** 内存已变、盘未落：同一批脚本写入合并成一次同步写。 */
  private dirty = false

  constructor(dir: string) {
    this.file = path.join(dir, 'source-state.json')
    this.state = readState(this.file)
  }

  private persist(): void {
    if (!this.dirty) return
    this.syncMaps()
    try {
      const tmp = tempPathOf(this.file)
      fs.writeFileSync(tmp, JSON.stringify(this.state), 'utf8')
      fs.renameSync(tmp, this.file)
      this.dirty = false
    } catch (e) {
      // 不打断读链路；保留 dirty，下一次 flush 重试（源状态是派生数据，正文/书架另有原子写）
      log.error(`源状态落盘失败（下一次 flush 重试）：${this.file}`, e)
    }
  }

  /** 加载过的 Map 才是该源的真相：落盘前一次性折回 state，避免每次 set 都整表 Object.fromEntries。 */
  private syncMaps(): void {
    for (const [id, map] of this.maps) {
      const sep = id.indexOf('\n')
      const bucket = id.slice(0, sep) as Bucket
      const sourceKey = id.slice(sep + 1)
      if (map.size > 0 || this.state[bucket][sourceKey] !== undefined) {
        this.state[bucket][sourceKey] = Object.fromEntries(map)
      }
    }
  }

  private mapOf(bucket: Bucket, sourceKey: string, create: boolean): Map<string, string> | undefined {
    const id = `${bucket}\n${sourceKey}`
    const held = this.maps.get(id)
    if (held !== undefined) return held
    const entries = this.state[bucket][sourceKey]
    if (entries === undefined && !create) return undefined
    const map = new PersistentMap(entries ?? {}, () => { this.dirty = true })
    this.maps.set(id, map)
    return map
  }

  cookieJar(sourceKey: string): Map<string, string> {
    return this.mapOf('cookies', sourceKey, true)!
  }

  sourceVars(sourceKey: string): Map<string, string> {
    return this.mapOf('vars', sourceKey, true)!
  }

  peekSourceVars(sourceKey: string): Map<string, string> | undefined {
    return this.mapOf('vars', sourceKey, false)
  }

  sourceString(sourceKey: string): string {
    return this.state.strings[sourceKey] ?? ''
  }

  setSourceString(sourceKey: string, value: string | null): void {
    if (value === null) delete this.state.strings[sourceKey]
    else this.state.strings[sourceKey] = value
    this.dirty = true
  }

  cacheStore(sourceKey: string): Map<string, string> {
    return this.mapOf('cache', sourceKey, true)!
  }

  /** 删源时清掉该源的全部源级状态（键值表/单串槽/cache/cookie 垫片）。
   *  sourceKey 是脚本侧键（`baseUrl`），不是书源 id——调用方负责按 id 取 baseUrl。
   *  删完当场落盘（不押到下一次 flush），并把句柄从 `maps` 摘掉：此后那个 Map 的写入不再进账——
   *  已删源的状态不许靠一条晚到的写复活。 */
  forget(sourceKey: string): void {
    let changed = false
    for (const bucket of BUCKETS) {
      if (this.state[bucket][sourceKey] !== undefined) {
        delete this.state[bucket][sourceKey]
        changed = true
      }
      this.maps.delete(`${bucket}\n${sourceKey}`)
    }
    if (this.state.strings[sourceKey] !== undefined) {
      delete this.state.strings[sourceKey]
      changed = true
    }
    if (changed) {
      this.dirty = true
      this.persist()
    }
  }

  /** 求值边界/卸载时落盘；没有脏数据时零 I/O。 */
  flush(): void {
    this.persist()
  }
}

export function createFileSourceSession(dir: string): FileSourceSession {
  return new FileSourceSession(dir)
}
