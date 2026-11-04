import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { CorruptJsonError, PERSIST_WINDOW_MS, backupPathOf, isAtomicTemp, novelDir, readJson, tempPathOf, writeFileAtomic, writeJsonAtomic, createDebouncedWriter } from '../../src/services/storage.js'
import { log } from '../../src/services/log.js'
import { makeTempDir } from '../temp-dir.js'

afterEach(() => { vi.restoreAllMocks() })

async function tmp(): Promise<string> { return makeTempDir('novel-st-') }

function fsError(code: string, message = code): NodeJS.ErrnoException {
  const e = new Error(message) as NodeJS.ErrnoException
  e.code = code
  return e
}

describe('novelDir', () => {
  it('DSH_HOME 存在时取 $DSH_HOME/novel', () => {
    expect(novelDir({ DSH_HOME: 'D:/dh' })).toBe(path.join('D:/dh', 'novel'))
  })
  it('DSH_HOME 缺省取 ~/.dsh/novel', () => {
    expect(novelDir({})).toMatch(/[\\/]novel$/)
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

  it('瞬时 EPERM 有限重试后成功；持久 EPERM 重试用尽后如实抛', async () => {
    const dir = await tmp()
    const file = path.join(dir, 'retry.txt')
    const realRename = fs.rename.bind(fs)
    let calls = 0
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      calls += 1
      if (calls < 3) throw fsError('EPERM', 'file held')
      return realRename(from, to)
    })
    await writeFileAtomic(file, 'ok')
    expect(await fs.readFile(file, 'utf8')).toBe('ok')
    expect(calls).toBe(3)

    calls = 0
    vi.spyOn(fs, 'rename').mockImplementation(async () => {
      calls += 1
      throw fsError('EPERM', 'still held')
    })
    await expect(writeFileAtomic(file, 'x')).rejects.toMatchObject({ code: 'EPERM' })
    expect(calls).toBe(4)             // 首次 + 3 次退避
  }, 10_000)

  it('EACCES 不重试（持久性权限错直接如实抛）', async () => {
    const dir = await tmp()
    const file = path.join(dir, 'denied.txt')
    let calls = 0
    vi.spyOn(fs, 'rename').mockImplementation(async () => {
      calls += 1
      throw fsError('EACCES', 'denied')
    })
    await expect(writeFileAtomic(file, 'x')).rejects.toMatchObject({ code: 'EACCES' })
    expect(calls).toBe(1)
  })

  it('定时器路径的写失败会留下可见错误，flush 如实抛出（不成为 unhandled）', async () => {
    // flush 必须等真在途的写，不能只看 pending：定时器取走 pending 后 rename 仍在途，
    // 此时误判「没有挂起写」的 flush 会 resolve，失败只能留给下一次 flush——收尾时即未处理拒绝。
    // 这里用可控 rename 把窗口钉死：写真的在途，flush 必须等它并以同一个错误 reject。
    const dir = await tmp()
    const file = path.join(dir, 'debounced-fail.json')
    let rejectRename!: (e: unknown) => void
    const renameMock = vi.spyOn(fs, 'rename').mockImplementation(
      () => new Promise<void>((_resolve, reject) => { rejectRename = reject }),
    )
    const w = createDebouncedWriter(1)
    void w.schedule(file, { v: 1 })
    await vi.waitFor(() => { expect(renameMock).toHaveBeenCalled() }, { timeout: 5_000 })
    const flushed = w.flush(file)          // pending 已被定时器取走，rename 仍在途
    rejectRename(fsError('EACCES', 'denied'))
    await expect(flushed).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('定时器路径已记下的失败，由下一次 flush 取走（failed 表那条路）', async () => {
    // 与上一条互补：那里 flush 与定时器抢的是**在途**那一笔；这里定时器已失败收场，
    // flush 到来时既无 pending 也无 inflight，只能把记下的失败原样抛给调用方——
    // 否则同一笔失败只剩一条日志，调用方永远看不见。
    const dir = await tmp()
    const file = path.join(dir, 'debounced-recorded-fail.json')
    let rejectRename!: (e: unknown) => void
    const renameMock = vi.spyOn(fs, 'rename').mockImplementation(
      () => new Promise<void>((_resolve, reject) => { rejectRename = reject }),
    )
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined)
    const w = createDebouncedWriter(1)
    void w.schedule(file, { v: 1 })
    await vi.waitFor(() => { expect(renameMock).toHaveBeenCalled() }, { timeout: 5_000 })
    rejectRename(fsError('EACCES', 'denied'))
    await vi.waitFor(() => { expect(errorSpy).toHaveBeenCalled() }, { timeout: 5_000 })
    await expect(w.flush(file)).rejects.toMatchObject({ code: 'EACCES' })
  })
})

describe('createDebouncedWriter', () => {
  it('防抖窗口唯一主人：缺省用 storage 的 PERSIST_WINDOW_MS', async () => {
    // 窗口缺省不在各消费方手里各写一份：storage 的常量是唯一主人，注册表显式引用它，书架用缺省。
    // fake timers 下记录 setTimeout 实参：定时器只在 schedule 时开一次，延迟必须恰是常量本身。
    // 这里不用 vi.spyOn 记录：它的恢复值钉在「安装时那个函数」上，afterEach 的 restoreAllMocks 会把
    // fake clock 重新装回 global，后续用例等真 setTimeout 就永远等不到（spy 那条路会毒化本文件）。
    expect(PERSIST_WINDOW_MS).toBe(100)
    const dir = await tmp()
    vi.useFakeTimers()
    const fakeSetTimeout = globalThis.setTimeout
    const delays: Array<number | undefined> = []
    globalThis.setTimeout = ((cb: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      delays.push(delay)
      return fakeSetTimeout(cb, delay, ...args)
    }) as typeof globalThis.setTimeout
    try {
      void createDebouncedWriter().schedule(path.join(dir, 'default-window.json'), {})
      expect(delays).toEqual([PERSIST_WINDOW_MS])
    } finally {
      globalThis.setTimeout = fakeSetTimeout
      vi.useRealTimers()
    }
  })
  it('同文件连续调度合并为最后一次落地', async () => {
    const dir = await tmp()
    const file = path.join(dir, 'd.json')
    const w = createDebouncedWriter(10)
    void w.schedule(file, { v: 1 }); void w.schedule(file, { v: 2 }); void w.schedule(file, { v: 3 })
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
    void w.schedule(a, { x: 1 }); void w.schedule(b, { x: 2 })
    await w.flush()
    expect(await readJson(a, null)).toEqual({ x: 1 })
    expect(await readJson(b, null)).toEqual({ x: 2 })
  })
  it('flush 排到静默：第一轮在途期间新调度的写也必须在返回前落地', async () => {
    // flush 排的是「等齐」，不是调用那一刻的快照（pending 只取一次）。
    // 否则「第一轮 I/O 在途时又来一次 schedule」的写会留在计时器里——测试收尾把临时目录删了
    // 它才烧，rename 撞上 Windows 的 EPERM，成为未处理拒绝——用例全绿而退出码非 0。
    // 窗口刻意放到 10_000ms：这条用例里 b 绝不可能靠计时器落地，只能靠 flush 排干净——
    // 既不需要 sleep，也不给「放宽断言」留余地。
    const dir = await tmp()
    const a = path.join(dir, 'a.json'); const b = path.join(dir, 'b.json')
    const w = createDebouncedWriter(10_000)
    void w.schedule(a, { v: 1 })
    const p = w.flush()               // 第一轮只看见 a；a 的 mkdir/write 仍在途
    void w.schedule(b, { v: 2 })      // 就落在这个窗口里
    await p
    expect(await readJson(b, null)).toEqual({ v: 2 })
  })
  it('threshold 次 schedule 立即落盘，并让调用方等到写落地', async () => {
    const dir = await tmp()
    const file = path.join(dir, 'threshold.json')
    const w = createDebouncedWriter(10_000, { threshold: 2 })
    expect(w.schedule(file, { n: 1 })).toBeUndefined()
    await expect(w.schedule(file, { n: 2 })).resolves.toBeUndefined()
    expect(await readJson(file, null)).toEqual({ n: 2 })
  })
  it('threshold 写失败 reject 给触发它的调用方，后续 flush 不重复抛', async () => {
    const dir = await tmp()
    const file = path.join(dir, 'threshold-fail.json')
    const w = createDebouncedWriter(10_000, { threshold: 2 })
    expect(w.schedule(file, { n: 1 })).toBeUndefined()
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('denied'), { code: 'EACCES' }),
    )
    await expect(w.schedule(file, { n: 2 })).rejects.toMatchObject({ code: 'EACCES' })
    await expect(w.flush()).resolves.toBeUndefined()
  })
  it('阈值触发后计数复位：下一次 schedule 从 1 重新计', async () => {
    const dir = await tmp()
    const file = path.join(dir, 'threshold-reset.json')
    const w = createDebouncedWriter(10_000, { threshold: 2 })
    expect(w.schedule(file, { n: 1 })).toBeUndefined()
    await w.schedule(file, { n: 2 })
    expect(w.schedule(file, { n: 3 })).toBeUndefined()
    await w.flush()
    expect(await readJson(file, null)).toEqual({ n: 3 })
  })
  it('threshold 计数跨定时器写累计（ADR-0011 的「累计 N 次」）', async () => {
    const dir = await tmp()
    const file = path.join(dir, 'threshold-cumulative.json')
    const w = createDebouncedWriter(5, { threshold: 3 })
    expect(w.schedule(file, { n: 1 })).toBeUndefined()
    // 这一轮只问「落地了没有」：读回的形态由下面的断言管，所以按 unknown 读
    for (let i = 0; i < 100 && (await readJson<unknown>(file, null)) === null; i++) {
      await new Promise((r) => setTimeout(r, 5))              // 等定时器路径写真正落地
    }
    expect(await readJson(file, null)).toEqual({ n: 1 })      // 那一笔落地不清计数
    expect(w.schedule(file, { n: 2 })).toBeUndefined()
    await expect(w.schedule(file, { n: 3 })).resolves.toBeUndefined()
    expect(await readJson(file, null)).toEqual({ n: 3 })
  })
  it('retainFailure：调用方接住的失败仍留给下一次 flush，写成功即清账', async () => {
    const dir = await tmp()
    const file = path.join(dir, 'retained.json')
    const w = createDebouncedWriter(10_000)
    w.retainFailure(file, fsError('EACCES', 'denied'))
    await expect(w.flush(file)).rejects.toMatchObject({ code: 'EACCES' })
    w.retainFailure(file, fsError('EACCES', 'denied'))
    void w.schedule(file, { v: 1 })
    await w.flush()
    await expect(w.flush(file)).resolves.toBeUndefined()
  })
})

describe('原子写与备份的命名约定（唯一住址在 storage.ts）', () => {
  // 命名只住 storage.ts：清点若自己写死 `.tmp` / `.bak` 两个后缀去猜低层命名，改命名时两处会悄悄分叉。
  // 命名收在一处之后，改命名只会红一处。
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
