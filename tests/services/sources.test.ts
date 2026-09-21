import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { SourceRegistry } from '../../src/services/sources.js'
import { normalizeSource } from '../../src/services/normalize.js'
import { makeTempDir } from '../temp-dir.js'

const raw = { bookSourceName: 'A', bookSourceUrl: 'https://a.com', ruleContent: '@css:#c@text', header: '{"Cookie":"secret=1"}' }
async function tmp(): Promise<string> { return makeTempDir('novel-src-') }

describe('SourceRegistry', () => {
  it('edit(add) → flush → 重新 load 往返一致（raw 原样）', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const src = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    expect(src.id).toBeTruthy()
    expect(src.status).toBe('unverified')
    await reg.flush()
    const reg2 = await SourceRegistry.load(dir)
    expect(reg2.list()).toHaveLength(1)
    expect(reg2.get(src.id)!.raw).toEqual(raw)
    expect(reg2.get(src.id)!.rules.searchUrl).toBeNull()
  })
  it('edit(setStatus) 持久化 detail', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const src = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    await reg.edit((tx) => tx.setStatus(src.id, 'broken', '[search#段0] 没取到'))
    await reg.flush()
    expect((await SourceRegistry.load(dir)).get(src.id)).toMatchObject({ status: 'broken', statusDetail: '[search#段0] 没取到' })
  })
  it('setStatus 转 verified（无 detail）时清空旧 statusDetail，不残留失败原因', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const src = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    await reg.edit((tx) => tx.setStatus(src.id, 'broken', '上次失败原因'))
    expect(reg.get(src.id)!.statusDetail).toBe('上次失败原因')
    await reg.edit((tx) => tx.setStatus(src.id, 'verified'))
    expect(reg.get(src.id)!.statusDetail).toBeUndefined()
  })
  it('toPublic 不含 raw/rules/auth，只给状态位', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const src = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    const pub = reg.toPublic({ ...src, auth: { cookies: { secret: '1' }, expired: true } })
    expect(pub).not.toHaveProperty('raw')
    expect(pub).not.toHaveProperty('auth')
    expect(pub).not.toHaveProperty('rules')
    expect(pub).toMatchObject({ hasHeader: true, hasAuth: true, authExpired: true })
  })
  it('setAuth 录入后 flush 重载可见；toPublic 仍只给布尔位', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const src = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    expect(await reg.edit((tx) => tx.setAuth(src.id, { cookies: { token: 'SECRET' } }))).toBe(true)
    expect(await reg.edit((tx) => tx.setAuth('nope', { cookies: {} }))).toBe(false)
    await reg.flush()
    const reloaded = (await SourceRegistry.load(dir)).get(src.id)!
    expect(reloaded.auth?.cookies).toEqual({ token: 'SECRET' })
    expect(JSON.stringify(reloaded)).toContain('SECRET')     // 内部全量含凭据（落盘需要）
    const pub = (await SourceRegistry.load(dir)).toPublic(reloaded)
    expect(pub.hasAuth).toBe(true)
    expect(JSON.stringify(pub)).not.toContain('SECRET')      // 对外投影绝不含
    await reg.edit((tx) => tx.setAuth(src.id, undefined))
    expect(reg.get(src.id)!.auth).toBeUndefined()
  })
  it('remove 删除', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const src = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    expect(await reg.edit((tx) => tx.remove(src.id))).toBe(true)
    expect(reg.list()).toHaveLength(0)
    await reg.flush()
    expect((await SourceRegistry.load(dir)).list()).toHaveLength(0)
  })
  it('removeAll 批量删除：命中计数、未知 id 静默跳过、重复 id 幂等、一次落盘全落', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const a = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    const b = await reg.edit((tx) => tx.add(normalizeSource({ ...raw, bookSourceName: 'B', bookSourceUrl: 'https://b.com' })))
    const c = await reg.edit((tx) => tx.add(normalizeSource({ ...raw, bookSourceName: 'C', bookSourceUrl: 'https://c.com' })))
    expect(await reg.edit((tx) => tx.removeAll([a.id, 'nope', b.id, a.id]))).toBe(2)   // 未知跳过 + 重复幂等
    expect(reg.list().map((s) => s.id)).toEqual([c.id])
    await reg.flush()
    expect((await SourceRegistry.load(dir)).list().map((s) => s.id)).toEqual([c.id])
    expect(await reg.edit((tx) => tx.removeAll([]))).toBe(0)                            // 空列表 → 0
  })
  it('replace：原位替换保列表序、复用旧 id、status 复位 unverified、flush 重载一致', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const a = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    const b = await reg.edit((tx) => tx.add(normalizeSource({ ...raw, bookSourceName: 'B', bookSourceUrl: 'https://b.com' })))
    await reg.edit((tx) => tx.setStatus(b.id, 'broken', '旧规则坏了'))
    const out = await reg.edit((tx) => tx.replace(b.id, normalizeSource({ ...raw, bookSourceName: 'B2', bookSourceUrl: 'https://b2.com' })))
    expect(out.id).toBe(b.id)                                    // 复用旧 id（书架/引用不断）
    expect(reg.list().map((s) => s.name)).toEqual(['A', 'B2'])   // 原位保序
    expect(reg.list()[1].status).toBe('unverified')              // 复位待重验
    expect(reg.list()[1].baseUrl).toBe('https://b2.com')
    await reg.flush()
    expect((await SourceRegistry.load(dir)).get(b.id)!.name).toBe('B2')
    expect(a.id).toBeTruthy()
  })
  it('replace：id 不存在抛错；result 不 ok 抛错（与 add 同口径）', async () => {
    const reg = await SourceRegistry.load(await tmp())
    await expect(reg.edit((tx) => tx.replace('nope', normalizeSource(raw)))).rejects.toThrowError(/源不存在/)
    await expect(reg.edit((tx) => tx.replace('nope', normalizeSource({ bad: 1 })))).rejects.toThrowError(/只收 ok/)
  })
  it('setEnabled：置位 + flush 重载一致；未知 id false', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const a = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    expect(await reg.edit((tx) => tx.setEnabled(a.id, false))).toBe(true)
    expect(reg.get(a.id)!.enabled).toBe(false)
    expect(await reg.edit((tx) => tx.setEnabled('nope', false))).toBe(false)
    await reg.flush()
    expect((await SourceRegistry.load(dir)).get(a.id)!.enabled).toBe(false)
    await reg.edit((tx) => tx.setEnabled(a.id, true))
    expect(reg.get(a.id)!.enabled).toBe(true)
  })
  it('load 归一：早期数据缺 enabled 字段 → 默认启用（否则搜索面静默排除老源）', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const a = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    await reg.flush()
    // 手工把 enabled 键删掉，模拟早期 sources.json
    const file = path.join(dir, 'sources.json')
    const legacy = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, unknown>>
    for (const s of legacy) delete s.enabled
    await fs.writeFile(file, JSON.stringify(legacy), 'utf8')
    const reloaded = await SourceRegistry.load(dir)
    expect(reloaded.get(a.id)!.enabled).toBe(true)          // 缺省即启用
  })
})

describe('load 内容形态迁移（bookSourceType 编码订正的存量收敛）', () => {
  it('raw.bookSourceType=2 的存量源：type 由误标的 text 重推为 image（legado 2=图片）；enabled 不动', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    await reg.edit((tx) => tx.add(normalizeSource(raw)))
    await reg.edit(() => {
      const s = reg.list()[0]
      s.type = 'text'                                    // 迁移前的存量误标形态
      s.raw = { ...(s.raw as Record<string, unknown>), bookSourceType: 2 }
    })
    await reg.flush()
    const re = (await SourceRegistry.load(dir)).list()[0]
    expect(re.type).toBe('image')                        // legado BookSourceType 真值：2=图片
    expect(re.enabled).toBe(true)                        // 迁移不动启用态
  })
  it('未知数值（如 4）的存量源：按 raw 重推为 unknown——退出参与集，但不打 status（探针会洗白）', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    await reg.edit((tx) => tx.add(normalizeSource(raw)))
    await reg.edit(() => {
      const s = reg.list()[0]
      s.raw = { ...(s.raw as Record<string, unknown>), bookSourceType: 4 }
    })
    await reg.flush()
    const re = (await SourceRegistry.load(dir)).list()[0]
    expect(re.type).toBe('unknown')
    expect(re.enabled).toBe(true)                         // 只出参与集，不动启用态
  })
  it('存量 raw 无 bookSourceType 字段 → text（Native 方言根本不产这个字段，缺省是合法形态）', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    await reg.edit((tx) => tx.add(normalizeSource(raw)))
    await reg.flush()
    const re = (await SourceRegistry.load(dir)).list()[0]
    expect(re.type).toBe('text')
  })
  it('raw.ruleBookInfo.init 存在而 rules 缺 ruleDetailInit → load 按 raw 重推（init 换根映射的存量收敛——QQ 源真机判别实证：缺键则换根静默不生效、tocUrl 回退 → EmptyToc）', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    await reg.edit((tx) => tx.add(normalizeSource({
      bookSourceName: 'QQ', bookSourceUrl: 'https://qq.example.com', ruleContent: 'x',
      ruleBookInfo: { init: '$.data.bookInfo', name: '$.name' },
    })))
    expect(reg.list()[0].rules.ruleDetailInit).toBe('$.data.bookInfo')   // 入库时已映射
    await reg.edit(() => {
      const s = reg.list()[0]
      delete (s.rules as unknown as Record<string, unknown>).ruleDetailInit          // 模拟旧版派生的存量形态
    })
    await reg.flush()
    expect((await SourceRegistry.load(dir)).list()[0].rules.ruleDetailInit).toBe('$.data.bookInfo')
  })
  it('raw 无 init 而 rules 键缺席 → load 补 null（NormalizedRules 是 required 形状，键应恒在场）', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    await reg.edit((tx) => tx.add(normalizeSource(raw)))
    await reg.edit(() => {
      const s = reg.list()[0]
      delete (s.rules as unknown as Record<string, unknown>).ruleDetailInit
    })
    await reg.flush()
    expect((await SourceRegistry.load(dir)).list()[0].rules.ruleDetailInit).toBeNull()
  })
})

describe('load 分组迁移（逗号粘连存量收敛）', () => {  it('早期形态「A,B 一段」在 load 时拆开并落盘；幂等', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const src = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    // 回灌脏数据（当年只按 \ 拆的产物）——直改活体对象，包进 edit 以标脏落盘
    await reg.edit(() => { src.groups = ['快速书源 ⚡,通常书源 📂', '小说'] })
    await reg.flush()
    const reg2 = await SourceRegistry.load(dir)
    expect(reg2.get(src.id)!.groups).toEqual(['快速书源 ⚡', '通常书源 📂', '小说'])
    expect((await SourceRegistry.load(dir)).get(src.id)!.groups)   // 再载不变（幂等）
      .toEqual(['快速书源 ⚡', '通常书源 📂', '小说'])
  })
})
describe('load 名称迁移（前缀图标收敛）', () => {
  it('⚡📂打头的装饰前缀在 load 时剥掉并落盘；幂等', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const src = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    await reg.edit(() => { src.name = '⚡📂旧名' })               // 回灌脏数据（迁移前的存量形态）
    await reg.flush()
    const reg2 = await SourceRegistry.load(dir)
    expect(reg2.get(src.id)!.name).toBe('旧名')
    expect((await SourceRegistry.load(dir)).get(src.id)!.name).toBe('旧名')   // 再载不变（幂等）
  })
})

describe('edit 原子变更 + 合并落盘', () => {
  it('edit 后不 flush：内存可见、磁盘未写；flush 后重载一致', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const src = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    expect(reg.get(src.id)).toBeTruthy()                                     // 内存即见
    await expect(fs.readFile(path.join(dir, 'sources.json'), 'utf8')).rejects.toThrow()   // 磁盘未写
    await reg.flush()
    expect((await SourceRegistry.load(dir)).get(src.id)!.name).toBe('A')
  })
  it('20 次变更阈值强制落盘（无需 flush 即重载可见）', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    for (let i = 0; i < 20; i++) {
      await reg.edit((tx) => tx.add(normalizeSource({ ...raw, bookSourceName: `S${i}`, bookSourceUrl: `https://s${i}.com` })))
    }
    expect((await SourceRegistry.load(dir)).list()).toHaveLength(20)         // 第 20 次触发强制写
  })
  it('并发 edit：两次变更都完整生效、互不吞并', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const [a] = await Promise.all([
      reg.edit((tx) => tx.add(normalizeSource(raw))),
      reg.edit((tx) => tx.add(normalizeSource({ ...raw, bookSourceName: 'B', bookSourceUrl: 'https://b.com' }))),
    ])
    expect(reg.list()).toHaveLength(2)
    await reg.flush()
    expect((await SourceRegistry.load(dir)).list()).toHaveLength(2)
    expect(a.id).toBeTruthy()
  })
  it('recipe 抛错：edit reject，已同步发生的变更照常标脏可落盘（finally 语义）', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    await expect(reg.edit((tx) => { tx.add(normalizeSource(raw)); throw new Error('boom') })).rejects.toThrow('boom')
    expect(reg.list()).toHaveLength(1)                                        // 同步已发生的变更在内存
    await reg.flush()
    expect((await SourceRegistry.load(dir)).list()).toHaveLength(1)           // 落得下去（不静默丢）
  })
})
