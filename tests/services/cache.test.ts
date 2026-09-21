import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { PageCache, safeKey } from '../../src/services/cache.js'
import { makeTempDir } from '../temp-dir.js'

async function tmp(): Promise<string> { return makeTempDir('novel-cache-') }

describe('PageCache', () => {
  // epoch/slot 对 PageCache 是不透明串（有效性算式归 cache-epoch.ts）——测试传字面量即可
  it('toc set/get 往返；miss → null', async () => {
    const c = new PageCache(await tmp())
    expect(await c.getToc('s', 'k', 'e')).toBeNull()
    await c.setToc('s', 'k', 'e', '[{"name":"第1章"}]')
    expect(await c.getToc('s', 'k', 'e')).toBe('[{"name":"第1章"}]')
    expect(await c.getToc('s', 'k', 'e2')).toBeNull()   // 换代际即换文件：旧条目不被新代际读到
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
