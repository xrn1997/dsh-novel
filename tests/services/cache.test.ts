import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { PageCache, safeKey } from '../../src/services/cache.js'
import { FULL_SCAN_EVERY, SizeLedger } from '../../src/services/size-ledger.js'
import { makeTempDir } from '../temp-dir.js'
import { gateNextReaddir } from '../support/fs-gate.js'

async function tmp(): Promise<string> { return makeTempDir('novel-cache-') }

afterEach(() => { vi.restoreAllMocks() })

describe('PageCache', () => {
  // epoch/slot 对 PageCache 是不透明串（有效性算式归 cache-epoch.ts）——测试传字面量即可
  it('toc set/get 往返；miss → null', async () => {
    const c = new PageCache(await tmp())
    expect(await c.getToc('s', 'k', 'e')).toBeNull()
    await c.setToc('s', 'k', 'e', [{ name: '第1章', url: 'https://x/1' }])
    expect(await c.getToc('s', 'k', 'e')).toEqual([{ name: '第1章', url: 'https://x/1' }])
    expect(await c.getToc('s', 'k', 'e2')).toBeNull()   // 换代际即换文件：旧条目不被新代际读到
  })
  it('坏字节 / 错形状读作 miss，不抛', async () => {
    const dir = await tmp()
    const c = new PageCache(dir)
    const file = path.join(dir, 'cache', 'toc', `s-${safeKey('k')}-e.json`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    for (const bad of ['{oops', '{}', '[{"name":1,"url":"u"}]', '[{"name":"n"}]']) {
      await fs.writeFile(file, bad, 'utf8')
      await expect(c.getToc('s', 'k', 'e')).resolves.toBeNull()
    }
  })
  it('content 按章节索引与槽位隔离', async () => {
    const c = new PageCache(await tmp())
    await c.setContent('s', 'k', 0, 'slot0', '第1章正文')
    await c.setContent('s', 'k', 1, 'slot1', '第2章正文')
    expect(await c.getContent('s', 'k', 0, 'slot0')).toBe('第1章正文')
    expect(await c.getContent('s', 'k', 0, 'slotX')).toBeNull()   // 同 index 换槽位不串配
    expect(await c.getContent('s', 'k', 7, 'slot0')).toBeNull()
  })
  it('prune 超上限按 mtime 淘汰最旧，未超不删', async () => {
    const dir = await tmp()
    const c = new PageCache(dir, 200)
    await c.setContent('s', 'old', 0, 'e', 'x'.repeat(150))
    // mtime 用 utimes 显式拉开确定值（sleep 20ms 在慢 CI 上不足以保证顺序）
    // 布局钉死：cache/content/<sourceId>-<safeKey>-<chIndex>-<slot>.txt
    const oldFile = path.join(dir, 'cache', 'content', 's-old-0-e.txt')
    const oldT = new Date(Date.now() - 10_000)
    await fs.utimes(oldFile, oldT, oldT)
    await c.setContent('s', 'new', 0, 'e', 'y'.repeat(150))
    await c.prune()
    expect(await c.getContent('s', 'new', 0, 'e')).toBe('y'.repeat(150))
    expect(await c.getContent('s', 'old', 0, 'e')).toBeNull()
  })
  it('maxBytes 是活值：调低后下一次 prune 按新上限淘汰', async () => {
    const dir = await tmp()
    let max = 400
    const c = new PageCache(dir, () => max)
    await c.setContent('s', 'old', 0, 'e', 'x'.repeat(150))
    const oldFile = path.join(dir, 'cache', 'content', 's-old-0-e.txt')
    const oldT = new Date(Date.now() - 10_000)
    await fs.utimes(oldFile, oldT, oldT)
    await c.setContent('s', 'new', 0, 'e', 'y'.repeat(150))
    max = 200
    await c.prune()
    expect(await c.getContent('s', 'old', 0, 'e')).toBeNull()
    expect(await c.getContent('s', 'new', 0, 'e')).toBe('y'.repeat(150))
  })
  it('未超上限的连续写入不触发全量 prune', async () => {
    const c = new PageCache(await tmp(), 10_000)
    await c.setContent('s', 'k', 0, 'e', 'x')
    // 容量纪律住 SizeLedger；写路径是 PageCache.write → SizeLedger.afterWrite → SizeLedger.prune，
    // 所以钉的必须是 SizeLedger.prototype.prune（钉 PageCache.prototype.prune 永远等不到这次调用）
    const prune = vi.spyOn(SizeLedger.prototype, 'prune')
    for (let i = 1; i <= 5; i++) await c.setContent('s', 'k', i, 'e', 'x'.repeat(10))
    expect(prune).not.toHaveBeenCalled()
  })
  it('覆盖同一槽位不把旧字节重复计入总量', async () => {
    const c = new PageCache(await tmp(), 1000)
    const prune = vi.spyOn(SizeLedger.prototype, 'prune')
    for (let i = 0; i < 20; i++) await c.setContent('s', 'k', 0, 'e', 'x'.repeat(100))
    // 增量记账若按「整笔字节累加」而不是「新字节减旧字节」，同一键的 100 字节会被记成 2000，
    // 超上限后每笔写都触发全量 prune——这条红
    expect(prune, '覆盖写把旧字节重复计入，账目超限后每写必全扫').not.toHaveBeenCalled()
    expect(c.totalBytes).toBeLessThanOrEqual(1000)
  })
  it('未超上限时也按间隔实扫，外部新增的超限文件会被发现并淘汰', async () => {
    const dir = await tmp()
    const c = new PageCache(dir, 100)
    await c.setContent('s', 'k', 0, 'e', 'x')
    const ext = path.join(dir, 'cache', 'content', 'ext-0-e.txt')
    await fs.writeFile(ext, 'y'.repeat(200))
    // 估算只认得本实例写入的 33 字节；外部文件要等下一次全量对账才会被计入。
    // 间隔从实现引（不抄字面量）：改档位时这条副本不会跟着变，用例名就撒谎了。
    for (let i = 1; i <= FULL_SCAN_EVERY; i++) await c.setContent('s', 'k', i, 'e', 'z')
    await expect(fs.access(ext)).rejects.toThrow()
  })
  it('超过上限的写入仍触发一次全量 prune', async () => {
    const c = new PageCache(await tmp(), 100)
    // 容量纪律住 SizeLedger；PageCache.prune 只是对外的同一条入口。
    const prune = vi.spyOn(SizeLedger.prototype, 'prune')
    await c.setContent('s', 'k', 0, 'e', 'x'.repeat(60))
    expect(prune).not.toHaveBeenCalled()
    await c.setContent('s', 'k', 1, 'e', 'x'.repeat(60))
    expect(prune).toHaveBeenCalledTimes(1)
  })
  // 120 个文件让实扫跨多个 tick，好让下面这笔写落在扫描期间。串行落盘在并行 worker 下会排队，
  // 缺省 5s 在忙机器上会假红（这条验的是「对账不抹掉并发写」，不是速度）：给它更宽的死线。
  it('全量对账与写入交叠时，不把并发那笔写从账上抹掉', async () => {
    const c = new PageCache(await tmp(), 10_000_000)
    // 120 个文件让实扫跨多个 tick，好让下面这笔写落在扫描期间
    for (let i = 0; i < 120; i++) await c.setContent('s', 'k', i, 'e', 'x')
    const racing = c.setContent('s', 'k', 120, 'e', 'y'.repeat(400))
    const fullScan = c.prune()
    await Promise.all([racing, fullScan])
    // 整份替换快照会让这 400 字节从索引里消失，下一次覆盖同一路径时按全新字节重计
    expect(c.totalBytes).toBeGreaterThanOrEqual(520)
  }, 20_000)
  it('写入前预约保留：落盘窗口里的一轮扫描不删刚写入的那一条（回执不能指向 miss）', async () => {
    const dir = await tmp()
    const contentDir = path.join(dir, 'cache', 'content')
    await fs.mkdir(contentDir, { recursive: true })
    // 外部旧文件：不在本实例账上，但实扫看得见；mtime 更旧，先被淘汰
    const external = path.join(contentDir, 'ext-old.txt')
    await fs.writeFile(external, 'o'.repeat(100))
    const oldT = new Date(Date.now() - 10_000)
    await fs.utimes(external, oldT, oldT)

    const c = new PageCache(dir, 50)                      // 上限比旧文件小、比新条目更小
    const gate = gateNextReaddir()
    // 本实例的第一笔写：落盘之后 while 建索引的那一发 readdir 停在闸上——保留集仍握着
    const writing = c.setContent('s', 'k', 0, 'e', 'y'.repeat(150))
    await vi.waitFor(() => expect(gate.scans()).toBe(1))
    // 这一轮扫描看得见刚写入的文件（已落盘）：没有预约保留它就会被当成最旧的淘汰对象删掉
    await c.prune()
    expect(await c.getContent('s', 'k', 0, 'e'), '预约保留的刚写入条目仍在').toBe('y'.repeat(150))
    gate.release()
    await writing
    expect(await c.getContent('s', 'k', 0, 'e'), '写完之后的读口仍拿得到字节').toBe('y'.repeat(150))
  })
})

describe('safeKey', () => {
  it('短 URL 保留可读，文件系统安全', () => {
    expect(safeKey('https://a.com/book/1')).not.toMatch(/[\\/:*?"<>|]/)
  })
  it('长 URL 走 sha1 混合且确定性', () => {
    const long = 'https://a.com/' + 'x'.repeat(300)
    expect(safeKey(long)).toBe(safeKey(long))
    expect(safeKey(long).length).toBeLessThanOrEqual(72)
  })
})
