import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FULL_SCAN_EVERY, SizeLedger } from '../../src/services/size-ledger.js'
import { makeTempDir } from '../temp-dir.js'

/**
 * 字节账的扫描节奏（`ADR-0068` 的那份共用纪律）：全扫只在「估算超限」或「写满间隔」时发生。
 * 这里钉四件事——扫描窗口里落进来的那笔写既不能从账上消失，也不能把对账计数拖住；
 * 在途已有一发扫描时后来的写并入这一轮，不各起一轮（持续预取那种「一路都在写」的形状下，
 * 逐写各扫一次就是把 `afterWrite` 头部注释要避免的 O(n²) 原样请回来）；并入的那几笔在本轮
 * 淘汰里同样不动；刚写入的一条不参与本轮淘汰。并入的保留登记只在本轮有效——下一轮它们必须
 * 照常按 mtime 参与淘汰，否则残留的保留集会让下一轮多护住旧写、账停在上限之上。
 *
 * 窗口不是靠「两个写并发」碰出来的：实扫要等 readdir 真的挂住才算在途，所以这里把 readdir
 * 做成一道闸，扫描停在读目录那一步时再把成串的写放进来。
 *
 * `FULL_SCAN_EVERY` 从实现引（不在本文件抄字面量）：实现改档位时那份副本不会跟着变，
 * 「每 N 次写对账一次」的用例名就会撒谎。
 */

afterEach(() => { vi.restoreAllMocks() })

/** 让下一发 readdir 挂住（其后的照常放行）：返回扫描次数读数与放行闸 */
function gateNextReaddir(): { scans: () => number, release: () => void } {
  let release = (): void => { throw new Error('扫描没停在 readdir 上') }
  const gate = new Promise<void>((resolve) => { release = resolve })
  const realReaddir = fs.readdir
  const spy = vi.spyOn(fs, 'readdir')
  let gated = false
  spy.mockImplementation((async (d: string, o?: unknown) => {
    const names = await (realReaddir as (p: string, opts?: unknown) => Promise<string[]>)(d, o)
    if (!gated) { gated = true; await gate }      // 只有第一发扫描挂住
    return names
  }) as typeof fs.readdir)
  return { scans: () => spy.mock.calls.length, release: () => { release() } }
}

describe('SizeLedger 的全扫间隔', () => {
  /** 建好索引、写到 31 笔（未触发全扫），再挂上 readdir 闸 */
  async function setup(): Promise<{ dir: string, ledger: SizeLedger, scans: () => number, release: () => void }> {
    const dir = await makeTempDir('novel-ledger-')
    const ledger = new SizeLedger(dir, 10_000)   // 上限远大于总量：淘汰不参与，只看间隔
    const fileOf = (i: number): string => path.join(dir, `f${i}`)
    const put = async (i: number): Promise<void> => {
      await fs.writeFile(fileOf(i), 'x'.repeat(10))
      await ledger.afterWrite([{ file: fileOf(i), bytes: 10 }])
    }
    await put(0)                                 // 首写实扫建索引
    for (let i = 1; i < FULL_SCAN_EVERY - 1; i++) await put(i)   // 文件 0…30：31 笔写
    return { dir, ledger, ...gateNextReaddir() }
  }

  it('扫描在途的写补回新账，计数照常清零：下一笔未超限的写不再全扫', async () => {
    const { dir, ledger, scans, release } = await setup()
    const fileOf = (i: number): string => path.join(dir, `f${i}`)

    await fs.writeFile(fileOf(32), 'x'.repeat(10))
    await fs.writeFile(fileOf(33), 'x'.repeat(10))
    const duringScan = ledger.afterWrite([{ file: fileOf(32), bytes: 10 }])   // 计数到 32 → 全扫 → 卡在 readdir
    await vi.waitFor(() => expect(scans()).toBe(1))
    const raced = ledger.afterWrite([{ file: fileOf(33), bytes: 10 }])        // 这一笔落在扫描窗口里
    release()
    await Promise.all([duringScan, raced])

    expect(ledger.totalBytes, '扫描窗口里的写不能从账上消失').toBe(33 * 10)

    // 探针继续留着：后面若真又扫了一次，得看得见
    const before = scans()
    await fs.writeFile(fileOf(34), 'x'.repeat(10))
    await ledger.afterWrite([{ file: fileOf(34), bytes: 10 }])
    expect(ledger.totalBytes).toBe(34 * 10)
    expect(scans(), '计数已清零：未超限的写不该再全扫').toBe(before)
  })

  it('在途扫描吸收并发写：一串写只扫一轮，不各扫一轮', async () => {
    const { dir, ledger, scans, release } = await setup()
    const fileOf = (i: number): string => path.join(dir, `f${i}`)
    const burst = Array.from({ length: 9 }, (_, k) => 32 + k)   // 第 32…40 笔
    for (const i of burst) await fs.writeFile(fileOf(i), 'x'.repeat(10))

    const writes = burst.map((i) => ledger.afterWrite([{ file: fileOf(i), bytes: 10 }]))
    await vi.waitFor(() => expect(scans()).toBe(1))
    release()
    await Promise.all(writes)

    expect(scans(), '九笔并发写该共用那一发扫描').toBe(1)
    expect(ledger.totalBytes, '并发写一笔都不能从账上丢').toBe(40 * 10)
  })

  it('扫描中途才登记的保留集本轮也不删：并入那一轮的写不被顺手淘汰', async () => {
    const dir = await makeTempDir('novel-ledger-keep-')
    const ledger = new SizeLedger(dir, 150)
    const a = path.join(dir, 'a')
    const b = path.join(dir, 'b')
    await fs.writeFile(a, 'x'.repeat(100))
    await ledger.afterWrite([{ file: a, bytes: 100 }])          // 建索引：账 100

    const gate = gateNextReaddir()
    await fs.writeFile(b, 'x'.repeat(60))
    const overCap = ledger.afterWrite([{ file: b, bytes: 60 }]) // 160 > 150 → 全扫 → 卡在 readdir
    await vi.waitFor(() => expect(gate.scans()).toBe(1))

    // 扫描在途时把最旧那条重写大并点名保留它：这一笔仍超限 → 保留集登记到在途那一轮
    await fs.writeFile(a, 'x'.repeat(120))
    // 重写会把 mtime 顶到最新，那样淘汰本来就轮不到它；按最旧钉回去才是这一条要钉的形状
    const oldest = new Date(Date.now() - 60_000)
    await fs.utimes(a, oldest, oldest)
    const raced = ledger.afterWrite([{ file: a, bytes: 120 }], new Set([a]))
    gate.release()
    await Promise.all([overCap, raced])

    expect(await fs.stat(a).then(() => true), '登记保留的那条不该被本轮删掉').toBe(true)
    await expect(fs.stat(b)).rejects.toThrow()                  // 淘汰照做，只是换了对象
    expect(ledger.totalBytes).toBe(120)
  })

  it('扫描期间并入本轮保留集的写，下一轮照常参与淘汰（残留的保留登记只多护一轮）', async () => {
    const dir = await makeTempDir('novel-ledger-scan-keep-')
    const ledger = new SizeLedger(dir, 150)
    const a = path.join(dir, 'a')
    const b = path.join(dir, 'b')
    const c = path.join(dir, 'c')
    await fs.writeFile(a, 'x'.repeat(100))
    await ledger.afterWrite([{ file: a, bytes: 100 }])          // 建索引：账 100

    const gate = gateNextReaddir()
    await fs.writeFile(b, 'x'.repeat(60))
    const first = ledger.afterWrite([{ file: b, bytes: 60 }])    // 160 > 150 → 全扫 → 卡在 readdir
    await vi.waitFor(() => expect(gate.scans()).toBe(1))

    // 扫描在途时写 c 并点名保留：本轮文件清单已读、见不到 c，但这份保留登记会并进本轮
    await fs.writeFile(c, 'x'.repeat(100))
    const oldest = new Date(Date.now() - 120_000)
    await fs.utimes(c, oldest, oldest)                           // 下一轮它是 mtime 最旧的淘汰对象
    const raced = ledger.afterWrite([{ file: c, bytes: 100 }], new Set([c]))
    gate.release()
    await Promise.all([first, raced])

    // 第一轮只删得掉清单里最旧的 a；c 不在清单里，按并发写补回账上
    await expect(fs.stat(a), '第一轮淘汰最旧的 a').rejects.toThrow()
    expect(await fs.stat(c).then(() => true)).toBe(true)

    // 第二轮没有新的保留登记：并入上一轮的 c 已不是「本轮刚写入」，按 mtime 最旧先删
    await ledger.prune()
    await expect(fs.stat(c), '残留的保留登记不该把 c 护到下一轮').rejects.toThrow()
    expect(await fs.stat(b).then(() => true)).toBe(true)
  })

  it('写入前预约保留：落盘窗口里的一轮扫描不删它（回执不会指向 404）', async () => {
    const dir = await makeTempDir('novel-ledger-reserve-')
    let cap = 100
    const ledger = new SizeLedger(dir, () => cap)
    const a = path.join(dir, 'a')
    const b = path.join(dir, 'b')
    await fs.writeFile(a, 'x'.repeat(80))
    await ledger.afterWrite([{ file: a, bytes: 80 }])

    // 与 TtsAudioCache.put 同序：先预约，再落盘；b 按最旧钉回去，确保淘汰本来会先选它
    const release = ledger.reserve([b])
    await fs.writeFile(b, 'x'.repeat(40))
    const oldest = new Date(Date.now() - 60_000)
    await fs.utimes(b, oldest, oldest)
    await ledger.prune()
    expect(await fs.stat(b).then(() => true), '预约中的文件不该被本轮删掉').toBe(true)
    await expect(fs.stat(a), '淘汰照做，只是换了对象').rejects.toThrow()

    cap = 30
    release()
    await ledger.prune()
    await expect(fs.stat(b)).rejects.toThrow()
  })
})
