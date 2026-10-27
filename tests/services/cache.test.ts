import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { PageCache, safeKey } from '../../src/services/cache.js'
import { makeTempDir } from '../temp-dir.js'

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
    const prune = vi.spyOn(PageCache.prototype, 'prune')
    for (let i = 1; i <= 5; i++) await c.setContent('s', 'k', i, 'e', 'x'.repeat(10))
    expect(prune).not.toHaveBeenCalled()
  })
  it('覆盖同一槽位不把旧字节重复计入总量', async () => {
    const c = new PageCache(await tmp(), 1000)
    const prune = vi.spyOn(PageCache.prototype, 'prune')
    for (let i = 0; i < 20; i++) await c.setContent('s', 'k', 0, 'e', 'x'.repeat(100))
    expect(prune).not.toHaveBeenCalled()
  })
  it('未超上限时也按间隔实扫，外部新增的超限文件会被发现并淘汰', async () => {
    const dir = await tmp()
    const c = new PageCache(dir, 100)
    await c.setContent('s', 'k', 0, 'e', 'x')
    const ext = path.join(dir, 'cache', 'content', 'ext-0-e.txt')
    await fs.writeFile(ext, 'y'.repeat(200))
    // 估算只认得本实例写入的 33 字节；外部文件要等下一次全量对账才会被计入。
    for (let i = 1; i <= 32; i++) await c.setContent('s', 'k', i, 'e', 'z')
    await expect(fs.access(ext)).rejects.toThrow()
  })
  it('超过上限的写入仍触发一次全量 prune', async () => {
    const c = new PageCache(await tmp(), 100)
    const prune = vi.spyOn(PageCache.prototype, 'prune')
    await c.setContent('s', 'k', 0, 'e', 'x'.repeat(60))
    expect(prune).not.toHaveBeenCalled()
    await c.setContent('s', 'k', 1, 'e', 'x'.repeat(60))
    expect(prune).toHaveBeenCalledTimes(1)
  })
  it('全量对账与写入交叠时，不把并发那笔写从账上抹掉', async () => {
    const c = new PageCache(await tmp(), 10_000_000)
    // 120 个文件让实扫跨多个 tick，好让下面这笔写落在扫描期间
    for (let i = 0; i < 120; i++) await c.setContent('s', 'k', i, 'e', 'x')
    const racing = c.setContent('s', 'k', 120, 'e', 'y'.repeat(400))
    const fullScan = c.prune()
    await Promise.all([racing, fullScan])
    // 整份替换快照会让这 400 字节从索引里消失，下一次覆盖同一路径时按全新字节重计
    const total = (c as unknown as { totalBytes: number }).totalBytes
    expect(total).toBeGreaterThanOrEqual(520)
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
