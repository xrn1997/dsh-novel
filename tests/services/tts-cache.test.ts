import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { buffer } from 'node:stream/consumers'
import { DEFAULT_TTS_CACHE_MAX_BYTES, TtsAudioCache, ttsCacheKey } from '../../src/services/tts-cache.js'
import { SizeLedger } from '../../src/services/size-ledger.js'
import { makeTempDir } from '../temp-dir.js'
import { must } from '../support/fixture.js'

/**
 * 段音频缓存：`<key>.bin` + `<key>.json`（mediaType 侧车）。
 * 容量账与 PageCache 同一条纪律（写入增量记账、到点实扫对账、超限按 mtime 淘汰），
 * 但它是独立主人——`PageCache` 不认识音频，本类也不碰 toc/正文。
 */

async function tmp(): Promise<string> { return makeTempDir('novel-tts-cache-') }

afterEach(() => { vi.restoreAllMocks() })

/** 让下一发 readdir 在**读目录之前**挂住：扫描停在那里时把写入放进来，好让新文件落在本轮候选里。
 *  与 `size-ledger.test.ts` 的闸同形（那里在读完之后挂，用于验证扫描窗口的并发写）。 */
function gateNextReaddir(): { scans: () => number, release: () => void } {
  let release = (): void => { throw new Error('扫描没停在 readdir 上') }
  const gate = new Promise<void>((resolve) => { release = resolve })
  const realReaddir = fs.readdir
  const spy = vi.spyOn(fs, 'readdir')
  let gated = false
  spy.mockImplementation((async (d: string, o?: unknown) => {
    if (!gated) { gated = true; await gate }
    return (realReaddir as (p: string, opts?: unknown) => Promise<string[]>)(d, o)
  }) as typeof fs.readdir)
  return { scans: () => spy.mock.calls.length, release: () => { release() } }
}

const keyOf = (text: string): string =>
  ttsCacheKey({ engineId: 'e1', request: 'GET http://x.test/tts', text })

const KEY_A = keyOf('甲')
const KEY_B = keyOf('乙')

describe('ttsCacheKey', () => {
  it('md5 hex 且确定：同一请求同键，换任一位即换键', () => {
    const base = { engineId: 'builtin:baidu', request: 'GET http://a.test/tts?x=1', text: '你好' }
    const key = ttsCacheKey(base)
    expect(key).toMatch(/^[0-9a-f]{32}$/)
    expect(ttsCacheKey(base)).toBe(key)
    const variants = [
      { ...base, engineId: 'http:1' },
      { ...base, request: 'GET http://b.test/tts?x=1' },
      { ...base, text: '你好。' },
    ]
    for (const variant of variants) expect(ttsCacheKey(variant)).not.toBe(key)
  })

  it('编码无分隔符歧义：请求与文本的切分不同不撞键', () => {
    const a = ttsCacheKey({ engineId: 'e', request: 'a', text: 'b' })
    const b = ttsCacheKey({ engineId: 'e', request: 'a|b', text: '' })
    expect(a).not.toBe(b)
  })
})

describe('TtsAudioCache', () => {
  it('put/has/open 往返：字节与 mediaType 原样可读，侧车落盘', async () => {
    const dir = await tmp()
    const cache = new TtsAudioCache(dir, 10_000)
    expect(await cache.has(KEY_A)).toBe(false)
    expect(await cache.open(KEY_A)).toBeNull()

    const bytes = Buffer.from([0x49, 0x44, 0x33, 0x00, 0xff])
    await cache.put(KEY_A, bytes, 'audio/mpeg')

    expect(await cache.has(KEY_A)).toBe(true)
    const res = must(await cache.open(KEY_A), '缓存条目')
    expect(res.mediaType).toBe('audio/mpeg')
    expect(res.bytes).toBe(bytes.length)
    expect(await buffer(res.stream)).toEqual(bytes)

    const sidecar: unknown = JSON.parse(await fs.readFile(path.join(dir, `${KEY_A}.json`), 'utf8'))
    expect(sidecar).toEqual({ mediaType: 'audio/mpeg' })
  })

  it('缺侧车 / 坏侧车 / 只有字节 → miss（缓存是派生数据，坏条目读作 miss 不抛）', async () => {
    const dir = await tmp()
    const cache = new TtsAudioCache(dir, 10_000)
    await cache.put(KEY_A, Buffer.from([1, 2, 3]), 'audio/wav')
    const sidecar = path.join(dir, `${KEY_A}.json`)

    await fs.rm(sidecar)
    expect(await cache.has(KEY_A)).toBe(false)
    expect(await cache.open(KEY_A)).toBeNull()

    await fs.writeFile(sidecar, '{oops', 'utf8')
    expect(await cache.has(KEY_A)).toBe(false)

    await fs.writeFile(sidecar, JSON.stringify({ mediaType: 42 }), 'utf8')
    expect(await cache.open(KEY_A)).toBeNull()

    // 只有字节没有侧车：不是一条完整条目
    const orphan = keyOf('孤儿')
    await fs.writeFile(path.join(dir, `${orphan}.bin`), Buffer.from([9]))
    expect(await cache.has(orphan)).toBe(false)
    expect(await cache.open(orphan)).toBeNull()
  })

  it('非法键 → 读口 miss、写口拒收（HTTP query 来的串不许拼进磁盘路径）', async () => {
    const dir = await tmp()
    const cache = new TtsAudioCache(dir, 10_000)
    for (const bad of ['../shelf', 'A'.repeat(32), 'a'.repeat(31), '']) {
      expect(await cache.has(bad), bad).toBe(false)
      expect(await cache.open(bad), bad).toBeNull()
    }
    await expect(cache.put('../shelf', Buffer.from([1]), 'audio/wav')).rejects.toThrow(/缓存键/)
  })

  it('0 字节 bin 按 miss：不冒充可读缓存，下一次 put 原地自愈', async () => {
    const dir = await tmp()
    const cache = new TtsAudioCache(dir, 10_000)
    // 0 字节只能从外部来（合成链在入缓存前就挡掉空音频）：读到它就等于回执一条永远不出声的段
    await cache.put(KEY_A, Buffer.alloc(0), 'audio/wav')
    expect(await cache.has(KEY_A), '空字节不是一条完整条目').toBe(false)
    expect(await cache.open(KEY_A)).toBeNull()

    // 按 miss 读之后能自愈：同键再 put 一次就是一条完整条目
    await cache.put(KEY_A, Buffer.from([1, 2]), 'audio/wav')
    expect(await cache.has(KEY_A)).toBe(true)
    const res = must(await cache.open(KEY_A), '自愈后的音频')
    expect(await buffer(res.stream)).toEqual(Buffer.from([1, 2]))
  })

  it('prune 超上限按 mtime 淘汰最旧；未超不删', async () => {
    let max = 10_000
    const dir = await tmp()
    const cache = new TtsAudioCache(dir, () => max)
    await cache.put(KEY_A, Buffer.alloc(100, 1), 'audio/wav')
    const old = new Date(Date.now() - 10_000)
    await fs.utimes(path.join(dir, `${KEY_A}.bin`), old, old)
    await fs.utimes(path.join(dir, `${KEY_A}.json`), old, old)
    await cache.put(KEY_B, Buffer.alloc(100, 2), 'audio/wav')

    await cache.prune()
    expect(await cache.has(KEY_A)).toBe(true)
    expect(await cache.has(KEY_B)).toBe(true)

    // 单条 = 100 字节字节流 + 25 字节侧车；两条放得下、一条放不下
    max = 150
    await cache.prune()
    expect(await cache.has(KEY_A)).toBe(false)
    expect(await cache.has(KEY_B)).toBe(true)
  })

  it('写入即触发 prune：增量记账超上限不等下次显式 prune', async () => {
    const dir = await tmp()
    const cache = new TtsAudioCache(dir, 150)
    await cache.put(KEY_A, Buffer.alloc(100, 1), 'audio/wav')
    expect(await cache.has(KEY_A)).toBe(true)
    // mtime 用 utimes 显式拉开确定值（写入间隔在快盘上可能落在同一毫秒）
    const old = new Date(Date.now() - 10_000)
    await fs.utimes(path.join(dir, `${KEY_A}.bin`), old, old)
    await fs.utimes(path.join(dir, `${KEY_A}.json`), old, old)
    await cache.put(KEY_B, Buffer.alloc(100, 2), 'audio/wav')
    expect(await cache.has(KEY_B)).toBe(true)
    expect(await cache.has(KEY_A)).toBe(false)
  })

  it('单段就超上限：刚写入的那一条不被本轮淘汰（回执不能指向 404）', async () => {
    const dir = await tmp()
    const cache = new TtsAudioCache(dir, 150)
    await cache.put(KEY_A, Buffer.alloc(100, 1), 'audio/wav')
    await cache.put(KEY_B, Buffer.alloc(200, 2), 'audio/wav')
    // 上限小于这一段：删光旧的仍守不住，那就临时超着——把刚发出去的回执删掉是更坏的失败
    expect(await cache.has(KEY_B), '刚写入的段必须还在').toBe(true)
    expect(await cache.has(KEY_A)).toBe(false)
    const res = must(await cache.open(KEY_B), '刚写入段的读口')
    expect((await buffer(res.stream)).subarray(0, 2)).toEqual(Buffer.from([2, 2]))
  })

  it('写入前预约保留：落盘窗口里的一轮扫描不删刚 put 的条目（回执不能指向 404）', async () => {
    const dir = await tmp()
    // 外部旧文件：不在本实例账上，但实扫看得见；mtime 更旧，先被淘汰
    const external = path.join(dir, 'ext-old.bin')
    await fs.writeFile(external, 'o'.repeat(100))
    const oldT = new Date(Date.now() - 10_000)
    await fs.utimes(external, oldT, oldT)

    const cache = new TtsAudioCache(dir, 50)      // 上限比旧文件小、比新条目更小
    const gate = gateNextReaddir()
    // 本实例的第一笔写：字节与侧车都落盘之后，建索引的那一发 readdir 停在闸上——保留集仍握着
    const writing = cache.put(KEY_B, Buffer.alloc(150, 2), 'audio/wav')
    await vi.waitFor(() => expect(gate.scans()).toBe(1))
    // 这一轮扫描看得见刚写入的两枚文件：没有预约保留，bin 会被当成最旧的淘汰对象删掉
    await cache.prune()
    expect(await cache.has(KEY_B), '预约保留的刚写入条目仍在').toBe(true)
    gate.release()
    await writing
    expect(await cache.has(KEY_B), '写完之后的读口仍拿得到字节').toBe(true)
  })

  it('覆盖同一键不把旧字节重复计入总量', async () => {
    const dir = await tmp()
    const cache = new TtsAudioCache(dir, 300)
    // 容量纪律住 SizeLedger；写路径是 put → SizeLedger.afterWrite → SizeLedger.prune
    const prune = vi.spyOn(SizeLedger.prototype, 'prune')
    for (let i = 0; i < 5; i++) await cache.put(KEY_A, Buffer.alloc(100, 1), 'audio/wav')
    // 账本读数是判据本身：重复计入会把同一键的 100 字节记成 500，超上限后每写必全扫
    expect(prune, '覆盖写把旧字节重复计入').not.toHaveBeenCalled()
    expect(cache.totalBytes).toBeLessThanOrEqual(300)
    expect(await cache.has(KEY_A)).toBe(true)
  })

  it('外部删文件后：读口按实扫给 miss，prune 从磁盘重建账本，下次 put 重写', async () => {
    const dir = await tmp()
    const cache = new TtsAudioCache(dir, 10_000)
    await cache.put(KEY_A, Buffer.alloc(300, 7), 'audio/wav')
    expect(cache.totalBytes).toBeGreaterThanOrEqual(325)

    await fs.rm(path.join(dir, `${KEY_A}.bin`))
    await fs.rm(path.join(dir, `${KEY_A}.json`))
    expect(await cache.has(KEY_A)).toBe(false)
    expect(await cache.open(KEY_A)).toBeNull()

    await cache.prune()
    expect(cache.totalBytes).toBe(0)

    await cache.put(KEY_A, Buffer.from([7]), 'audio/ogg')
    const res = must(await cache.open(KEY_A), '重建后的缓存条目')
    expect(res.mediaType).toBe('audio/ogg')
    expect(await buffer(res.stream)).toEqual(Buffer.from([7]))
  })

  it('缺省上限是 128 MiB（单点常量，配置表引它）', () => {
    expect(DEFAULT_TTS_CACHE_MAX_BYTES).toBe(128 * 1024 * 1024)
  })
})
