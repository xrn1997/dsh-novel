import { describe, expect, it } from 'vitest'
import { SourceIntake, dedupKey } from '../../src/services/intake.js'
import { SourceRegistry } from '../../src/services/sources.js'
import { normalizeSource } from '../../src/services/normalize.js'
import { makeTempDir } from '../temp-dir.js'

/**
 * 源入库：normalize → 批内去重 → 按址去重 → add/replace 的唯一实现。
 * 后台导入任务与同步 importOne（工具面）都必须走这里——少了去重，同一 baseUrl 可重复入库。
 * 一个 SourceIntake 实例 = 一批；批内留首条与库内语义分列，不混用。
 */
const raw = (n: string, url: string): Record<string, unknown> => ({
  bookSourceName: n, bookSourceUrl: url, ruleContent: '@css:#c@text',
})

async function mkReg(): Promise<SourceRegistry> {
  const dir = await makeTempDir('novel-intake-')
  return SourceRegistry.load(dir)
}

describe('SourceIntake 入库语义', () => {
  it('新址 → added 且落库一条', async () => {
    const registry = await mkReg()
    const intake = new SourceIntake(registry)
    const d = await intake.intake(raw('A', 'https://a.com'))
    expect(d.kind).toBe('added')
    expect(registry.list()).toHaveLength(1)
  })

  it('批内重复（同一 intake 实例）→ 留首条，后续 skipped reason=batch', async () => {
    const registry = await mkReg()
    const intake = new SourceIntake(registry)
    await intake.intake(raw('A1', 'https://a.com'))
    const d2 = await intake.intake(raw('A2', 'https://a.com'))
    expect(d2).toMatchObject({ kind: 'skipped', reason: 'batch', name: 'A2' })
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0].name).toBe('A1')
  })

  it('已有 verified 同址 → skipped reason=verified，保留已有（入库规则：已有可用者优先）', async () => {
    const registry = await mkReg()
    const first = await registry.edit((tx) => tx.add(normalizeSource(raw('旧', 'https://a.com'))))
    await registry.edit((tx) => tx.setStatus(first.id, 'verified', undefined, 1))
    const intake = new SourceIntake(registry)                 // 快照在建档后构造
    const d = await intake.intake(raw('新', 'https://a.com'))
    expect(d).toMatchObject({ kind: 'skipped', reason: 'verified', name: '新' })
    expect((d as { existing?: { id: string } }).existing?.id).toBe(first.id)
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0].name).toBe('旧')
  })

  it('已有 broken/unverified 同址 → replaced（复用旧 id，内容更新）', async () => {
    const registry = await mkReg()
    const first = await registry.edit((tx) => tx.add(normalizeSource(raw('旧', 'https://a.com'))))
    const intake = new SourceIntake(registry)
    const d = await intake.intake(raw('新', 'https://a.com'))
    expect(d.kind).toBe('replaced')
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]).toMatchObject({ id: first.id, name: '新' })
  })

  it('同址脏数据多条 → replace 时清同键其余条目（历史收敛到一条）', async () => {
    const registry = await mkReg()
    const first = await registry.edit((tx) => tx.add(normalizeSource(raw('旧1', 'https://a.com'))))
    await registry.edit((tx) => tx.add(normalizeSource(raw('旧2', 'https://a.com/'))))
    expect(registry.list()).toHaveLength(2)
    const intake = new SourceIntake(registry)
    const d = await intake.intake(raw('新', 'https://a.com'))
    expect(d).toMatchObject({ kind: 'replaced', clearedRest: 1 })
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0].id).toBe(first.id)
  })

  it('dedupKey 口径：尾斜杠与首尾空白视为同址，大小写不魔改', () => {
    expect(dedupKey(' https://a.com/ ')).toBe('https://a.com')
    expect(dedupKey('https://A.com/B/')).toBe('https://A.com/B')
  })

  it('normalize 失败 → failed，名称兜底（bookSourceName 空串 → (未命名)）', async () => {
    const registry = await mkReg()
    const intake = new SourceIntake(registry)
    const d = await intake.intake({ bookSourceName: '' })
    expect(d).toMatchObject({ kind: 'failed', name: '(未命名)' })
    expect((d as { missing: unknown[] }).missing.length).toBeGreaterThan(0)
    expect(registry.list()).toHaveLength(0)
  })
})
