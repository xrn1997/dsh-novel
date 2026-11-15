import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { SizeLedger } from './size-ledger.js'
import { writeFileAtomic, writeFileAtomicBytes } from './storage.js'
import type { ValueSource } from './value-source.js'

/** 段音频缓存的缺省上限（128 MiB，照 legado 流式模式的 LRU 口径）。**这个数是唯一主人**：
 *  配置表的缓存容量缺省引它，别在配置表里再写一遍字面量。 */
export const DEFAULT_TTS_CACHE_MAX_BYTES = 128 * 1024 * 1024

/** 键的合法形状（`ttsCacheKey` 的 md5 hex）。音频读口的 key 来自 HTTP query，
 *  非法串不许拼进磁盘路径——`has` / `open` 把它们读作 miss，`put` 直接拒收。 */
const KEY_PATTERN = /^[0-9a-f]{32}$/

/**
 * 段音频的缓存键：引擎标识 + **实际请求** + 文本。
 *
 * `request` 由调用方给：HTTP 源是求值后的 method/url/body，cordis 源是服务身份 + 音色 + 语速。
 * 键跟实际请求走而不是跟原始参数走——同一 spd 档内的两个语速、或模板不消费的音色，请求没变就
 * 该复用；反过来，模板里带随机数的引擎本来就不该跨请求命中。用 JSON 数组编码而不是裸拼接：
 * 字段之间没有分隔符歧义。
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

/**
 * 段音频缓存（数据根下 `cache/tts`）：`<key>.bin` 存字节，`<key>.json` 侧车存 `mediaType`。
 * 侧车是**提交标记**：先写字节再写侧车，缺侧车/坏侧车的字节按 miss 读——缓存是派生数据，
 * 坏条目读作 miss（与 PageCache 的坏字节裁决同口径），下一次 put 原地重写。
 *
 * 容量账与 `PageCache` 共用 `SizeLedger`：容量与目录各自独立（音频缓存不挤占页面缓存的上限），
 * 但「写增量记账 / 定期实扫 / 按 mtime 最旧先删」的纪律只有一份。上限是活值：配置页改过后，
 * 下一次 prune 就按新值淘汰。淘汰按**文件**粒度：极端情况下可能只删掉条目的一半；留下的孤儿
 * 由读口按 miss 处理，等下一次按 mtime 轮到它时再清掉——不会冒充一条可读缓存。
 *
 * 与 PageCache 一样，读不刷新 mtime：长期只读的热条目不会被读操作续命，可能先于旧代际被淘汰
 * （如实记，不假装读操作能挤掉冷数据）。
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

  /** 条目是否完整（非零字节 + 可解析的侧车）。坏侧车/缺字节/0 字节一律 false，不抛。
   *  0 字节是「比没有更坏」的那种条目：它会让命中路径一直回执一条永远发不出声的段，
   *  而音频缓存没有清缓存入口（`ADR-0068`）——按 miss 读，下一次 put 原地自愈。 */
  async has(key: string): Promise<boolean> {
    if (!KEY_PATTERN.test(key)) return false
    const { bin, sidecar } = this.pathsOf(key)
    if (await this.readMediaType(sidecar) === null) return false
    try {
      const stat = await fs.stat(bin)
      return stat.isFile() && stat.size > 0
    } catch {
      return false
    }
  }

  /** 写入一段音频。先字节后侧车：侧车落地才算这条缓存生效（崩溃不留「半条可读音频」）。 */
  async put(key: string, bytes: Buffer, mediaType: string): Promise<void> {
    if (!KEY_PATTERN.test(key)) throw new Error(`音频缓存键非法：${key}`)
    const { bin, sidecar } = this.pathsOf(key)
    const sidecarText = JSON.stringify({ mediaType })
    // 先登记保留、再落盘：落盘窗口里若正好有一轮 prune 在扫，这两个文件也不能被删——
    // 回执已经发出去了，淘汰它等于让音频读口对同一个键回 404。
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

  /** 打开一条缓存；缺字节/0 字节/坏侧车/非法键 → null。打开与取大小收在同一个 try（先开句柄再
   *  stat）：先 stat 再开会有「stat 到了、开之前被删」的窗口，句柄还可能在错误路径上泄漏。 */
  async open(key: string): Promise<AudioResource | null> {
    if (!KEY_PATTERN.test(key)) return null
    const { bin, sidecar } = this.pathsOf(key)
    const mediaType = await this.readMediaType(sidecar)
    if (mediaType === null) return null
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
      return { mediaType, bytes: size, stream: handle.createReadStream() }
    } catch {
      await handle?.close().catch(() => undefined)
      return null
    }
  }

  /** 容量账的修剪入口（测试与调用方同一条；具体纪律住 `SizeLedger`）。 */
  async prune(): Promise<void> {
    await this.ledger.prune()
  }

  /** 侧车 → mediaType；缺文件/坏 JSON/错形状一律 null（坏条目读作 miss，不是失败）。 */
  private async readMediaType(file: string): Promise<string | null> {
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
    const mediaType = (value as Record<string, unknown>).mediaType
    return typeof mediaType === 'string' && mediaType.trim() !== '' ? mediaType : null
  }

  /** 键 → 两枚文件。键已过 `KEY_PATTERN`，不含路径分隔符。 */
  private pathsOf(key: string): { bin: string; sidecar: string } {
    return { bin: path.join(this.dir, `${key}.bin`), sidecar: path.join(this.dir, `${key}.json`) }
  }
}
