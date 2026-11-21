import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { SizeLedger } from './size-ledger.js'
import { writeFileAtomic, writeFileAtomicBytes } from './storage.js'
import type { ValueSource } from './value-source.js'

/** 段音频缓存的缺省上限（128 MiB，照 legado 流式模式的 LRU 口径）。**这个数是唯一主人**：配置表的缺省引它，别处不再写字面量。 */
export const DEFAULT_TTS_CACHE_MAX_BYTES = 128 * 1024 * 1024

/** 键的合法形状（md5 hex）。音频读口的 key 来自 HTTP query，非法串不许拼进磁盘路径——`has` / `open` 读作 miss，`put` 拒收。 */
const KEY_PATTERN = /^[0-9a-f]{32}$/

/**
 * 段音频的缓存键：引擎标识 + **实际请求** + 文本。`request` 由调用方给：HTTP 是求值后的 method/url/body，cordis 是服务身份 + 音色 + 语速。
 * 键跟实际请求走而不是原始参数——同一 spd 档内的两个语速、或模板不消费的音色，请求没变就该复用；模板带随机数的引擎本来就不该跨请求命中。
 */
export function ttsCacheKey(p: {
  engineId: string
  request: string
  text: string
}): string {
  const material = JSON.stringify([p.engineId, p.request, p.text])
  return createHash('md5').update(material).digest('hex')
}

/** 一条可读的音频缓存条目：`stream` 的所有权随返回值交给调用方（断连/出错由它销毁）。 */
export interface AudioResource {
  mediaType: string
  bytes: number
  stream: Readable
}

/** 条目的元读面（不碰字节）：除 `mediaType` 还报**这份字节里引擎自己应用了多少语速**（1 = 原速）。回执按「用户要的 ÷ 这一格」算补速：
 *  它是字节的属性，同一份字节被不同倍率重放时这一格必须还是当初写下的那个数。 */
export interface AudioMeta {
  mediaType: string
  appliedRate: number
}

/**
 * 段音频缓存（数据根下 `cache/tts`）：`<key>.bin` 存字节，`<key>.json` 侧车存 `mediaType` 与随字节定版的 `appliedRate`。侧车是**提交标记**：
 * 先写字节再写侧车，缺侧车/坏侧车的字节按 miss 读——缓存是派生数据，坏条目读作 miss，下一次 put 原地重写。
 * 容量账与 `PageCache` 共用 `SizeLedger`：容量与目录各自独立，但「写增量记账 / 定期实扫 / 按 mtime 最旧先删」的纪律只有一份。上限是活值，
 * 淘汰按**文件**粒度：可能只删掉条目的一半，孤儿由读口按 miss 处理。与 PageCache 一样读不刷新 mtime：长期只读的热条目可能先于旧代际被淘汰。
 */
export class TtsAudioCache {
  private readonly dir: string
  private readonly ledger: SizeLedger

  constructor(dir: string, maxBytes: ValueSource<number> = DEFAULT_TTS_CACHE_MAX_BYTES) {
    this.dir = dir
    this.ledger = new SizeLedger(dir, maxBytes)
  }

  /** 当前账的只读读数（诊断与测试用；淘汰判据不读它）。 */
  get totalBytes(): number {
    return this.ledger.totalBytes
  }

  /** 条目是否完整（非零字节 + 可解析侧车），坏条目一律 false、不抛。0 字节是「比没有更坏」：命中路径会一直回执一条永远发不出声的段，
   *  而音频缓存没有清缓存入口（`ADR-0068`）——按 miss 读，下一次 put 原地自愈。 */
  async has(key: string): Promise<boolean> {
    return (await this.meta(key)) !== null
  }

  /** 元读面（合成回执走这一条）：侧车可读且字节非零才回话；坏条目读作 miss（理由同 `has`）。 */
  async meta(key: string): Promise<AudioMeta | null> {
    if (!KEY_PATTERN.test(key)) return null
    const { bin, sidecar } = this.pathsOf(key)
    const meta = await this.readSidecar(sidecar)
    if (meta === null) return null
    try {
      const stat = await fs.stat(bin)
      return stat.isFile() && stat.size > 0 ? meta : null
    } catch {
      return null
    }
  }

  /** 写入一段音频。先字节后侧车：侧车落地才算这条缓存生效。`appliedRate` 随字节定版（引擎之后换口径也改不动已落盘这段）；非法值
   *  直接拒收——说明产字节的那支算法坏了，写进去只会让命中路径拿一个没人能解释的差额去放音。 */
  async put(key: string, bytes: Buffer, mediaType: string, appliedRate: number): Promise<void> {
    if (!KEY_PATTERN.test(key)) throw new Error(`音频缓存键非法：${key}`)
    if (!Number.isFinite(appliedRate) || appliedRate <= 0) {
      throw new Error(`音频缓存的应用语速非法：${String(appliedRate)}`)
    }
    const { bin, sidecar } = this.pathsOf(key)
    const sidecarText = JSON.stringify({ mediaType, appliedRate } satisfies AudioMeta)
    // 先登记保留、再落盘：落盘窗口里若正好有一轮 prune 在扫，这两个文件也不能被删——回执已经发出去了。
    const release = this.ledger.reserve([bin, sidecar])
    try {
      await writeFileAtomicBytes(bin, bytes)
      await writeFileAtomic(sidecar, sidecarText)
      await this.ledger.afterWrite([
        { file: bin, bytes: bytes.byteLength },
        { file: sidecar, bytes: Buffer.byteLength(sidecarText, 'utf8') },
      ], new Set([bin, sidecar]))
    } finally {
      release()
    }
  }

  /** 打开一条缓存；缺字节/0 字节/坏侧车/非法键 → null。打开与取大小收在同一个 try（先 stat 再开会有窗口，句柄还可能在错误路径上泄漏）。 */
  async open(key: string): Promise<AudioResource | null> {
    if (!KEY_PATTERN.test(key)) return null
    const { bin, sidecar } = this.pathsOf(key)
    const meta = await this.readSidecar(sidecar)
    if (meta === null) return null
    let handle: FileHandle | null = null
    try {
      handle = await fs.open(bin, 'r')
      const { size } = await handle.stat()
      // 0 字节与 miss 同义（理由同 `has`）：别把一条空音频发成 200
      if (size === 0) {
        await handle.close().catch(() => undefined)
        return null
      }
      // 成功路径不关句柄：流的所有权随返回值交给调用方
      return { mediaType: meta.mediaType, bytes: size, stream: handle.createReadStream() }
    } catch {
      await handle?.close().catch(() => undefined)
      return null
    }
  }

  /** 容量账的修剪入口（测试与调用方同一条；具体纪律住 `SizeLedger`）。 */
  async prune(): Promise<void> {
    await this.ledger.prune()
  }

  /** 侧车 → 元读面。缺文件/坏 JSON/错形状一律 null（坏条目读作 miss）。`appliedRate` 缺席或坏值也读作 miss：拿 1 或请求倍率去猜，
   *  会在曾应用服务端语速的源上双重加速、在没应用的源上凭空补速——判「不知道」而不是猜一档（下一次 put 原地自愈）。 */
  private async readSidecar(file: string): Promise<AudioMeta | null> {
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch {
      return null
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const entry = value as Record<string, unknown>
    const mediaType = entry.mediaType
    if (typeof mediaType !== 'string' || mediaType.trim() === '') return null
    const appliedRate = entry.appliedRate
    if (typeof appliedRate !== 'number' || !Number.isFinite(appliedRate) || appliedRate <= 0) return null
    return { mediaType, appliedRate }
  }

  /** 键 → 两枚文件。键已过 `KEY_PATTERN`，不含路径分隔符。 */
  private pathsOf(key: string): { bin: string; sidecar: string } {
    return { bin: path.join(this.dir, `${key}.bin`), sidecar: path.join(this.dir, `${key}.json`) }
  }
}
