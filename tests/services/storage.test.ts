import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { CorruptJsonError, backupPathOf, isAtomicTemp, novelDir, readJson, tempPathOf, writeFileAtomic, writeJsonAtomic, createDebouncedWriter } from '../../src/services/storage.js'
import { makeTempDir } from '../temp-dir.js'

async function tmp(): Promise<string> { return makeTempDir('novel-st-') }

describe('novelDir', () => {
  it('DSH_HOME 存在时取 $DSH_HOME/novel', () => {
    expect(novelDir({ DSH_HOME: 'D:/dh' } as NodeJS.ProcessEnv)).toBe(path.join('D:/dh', 'novel'))
  })
  it('DSH_HOME 缺省取 ~/.dsh/novel', () => {
    expect(novelDir({} as NodeJS.ProcessEnv)).toMatch(/[\\/]novel$/)
  })
})

describe('readJson / writeJsonAtomic', () => {
  it('不存在的文件返回 fallback', async () => {
    const dir = await tmp()
    expect(await readJson(path.join(dir, 'nope.json'), { a: 1 })).toEqual({ a: 1 })
  })
  it('原子写后可读回，且不留 .tmp 残留', async () => {
    const dir = await tmp()
    const file = path.join(dir, 'x.json')
    await writeJsonAtomic(file, { n: 42 })
    expect(await readJson(file, null)).toEqual({ n: 42 })
    const residue = (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))
    expect(residue).toHaveLength(0)
  })
  it('存在但损坏 → CorruptJsonError + 备份 .bak，绝不返回 fallback（数据丢失方向）', async () => {
    const dir = await tmp()
    const file = path.join(dir, 'sources.json')
    await fs.writeFile(file, '[{"id":"a","name":"A"', 'utf8')
    await expect(readJson(file, [])).rejects.toBeInstanceOf(CorruptJsonError)
    expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe('[{"id":"a","name":"A"')
    expect(await fs.readFile(file, 'utf8')).toBe('[{"id":"a","name":"A"')  // 原文件不动
  })
})

describe('writeFileAtomic（PageCache/JSON 共用低层）', () => {
  it('并发写同一文件串行落地，全部 resolve、无 .tmp 残留、内容完整', async () => {
    const dir = await tmp()
    const file = path.join(dir, 'c.txt')
    await Promise.all(Array.from({ length: 40 }, (_, i) => writeFileAtomic(file, `v${i}`)))
    expect(await fs.readFile(file, 'utf8')).toBe('v39')
    const residue = (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))
    expect(residue).toHaveLength(0)
  })
})

describe('createDebouncedWriter', () => {
  it('同文件连续调度合并为最后一次落地', async () => {
    const dir = await tmp()
    const file = path.join(dir, 'd.json')
    const w = createDebouncedWriter(10)
    w.schedule(file, { v: 1 }); w.schedule(file, { v: 2 }); w.schedule(file, { v: 3 })
    await w.flush()
    expect(await readJson(file, null)).toEqual({ v: 3 })
  })
  it('flush 在无挂起写时立即 resolve', async () => {
    const w = createDebouncedWriter(10)
    await expect(w.flush()).resolves.toBeUndefined()
  })
  it('不同文件互不影响', async () => {
    const dir = await tmp()
    const a = path.join(dir, 'a.json'); const b = path.join(dir, 'b.json')
    const w = createDebouncedWriter(10)
    w.schedule(a, { x: 1 }); w.schedule(b, { x: 2 })
    await w.flush()
    expect(await readJson(a, null)).toEqual({ x: 1 })
    expect(await readJson(b, null)).toEqual({ x: 2 })
  })
})

describe('原子写与备份的命名约定（唯一住址在 storage.ts）', () => {
  // 病根：删书的清点原先自己写死 `.tmp` / `.bak` 两个字面量去猜低层写的命名——今天两处都对，
  // 靠的是「没人改过命名」，不是有守卫。命名收在一处之后，改命名只会红一处。
  const target = path.join(path.sep + 'x', 'local', 'b1.json')

  it('tempPathOf 产出的裸名，正是 isAtomicTemp 认的那一个', () => {
    expect(isAtomicTemp(target, path.basename(tempPathOf(target)))).toBe(true)
  })

  it('四种「不是这本书的原子写残留」都不误认', () => {
    expect(isAtomicTemp(target, 'b1.json.bak')).toBe(false)          // 备份不是 temp
    expect(isAtomicTemp(target, 'b2.json.1.abc.tmp')).toBe(false)    // 别的书的残留
    expect(isAtomicTemp(target, 'b1.json.tmp.1')).toBe(false)        // 后缀不在末尾
    expect(isAtomicTemp(target, 'b1.txt')).toBe(false)               // 连前缀都不对
  })

  it('backupPathOf 与 readJson 实际留下的备份同名', async () => {
    const dir = await tmp()
    const file = path.join(dir, 'c.json')
    await fs.writeFile(file, '{这不是 JSON', 'utf8')
    await expect(readJson(file, null)).rejects.toBeInstanceOf(CorruptJsonError)
    expect(await fs.readFile(backupPathOf(file), 'utf8')).toBe('{这不是 JSON')
  })
})
