import { describe, expect, it, vi } from 'vitest'
import { applyPreset, createExportRun, draftOf, parseRange, validRangeOf } from '../../src/client/export-run.js'
import type { ExportRunDeps, ExportRunState } from '../../src/client/export-run.js'
import { ApiClientError } from '../../src/client/api.js'
import { enTranslate, zhTranslate } from '../../src/client/copy/index.js'

/**
 * 范围导出流编排：此前整段住在 ReaderView（硬 import streamExport/saveBlob），
 * 零测试。现在收成独立 module——start/cancel/状态三态 + 卸载 abort 全部可被假 streamExport 驱动。
 */

interface Deferred {
  promise: Promise<Blob>
  resolve: (b: Blob) => void
  reject: (e: unknown) => void
}
function defer(): Deferred {
  let resolve: (b: Blob) => void = () => { /* replaced below */ }
  let reject: (e: unknown) => void = () => { /* replaced below */ }
  const promise = new Promise<Blob>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** 在途可观察的假导出流：挂 abort 监听（取消/卸载路径用），进度由用例按需回调 */
function hangingStream(): { streamExport: ExportRunDeps['streamExport']; aborted: () => boolean } {
  let aborted = false
  const streamExport = vi.fn((opts: Parameters<ExportRunDeps['streamExport']>[0]) => new Promise<Blob>((_res, rej) => {
    opts.signal.addEventListener('abort', () => {
      aborted = true
      rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    })
  }))
  return { streamExport, aborted: () => aborted }
}

const setup = (deps: ExportRunDeps, t = zhTranslate): { states: ExportRunState[]; run: ReturnType<typeof createExportRun> } => {
  const states: ExportRunState[] = []
  const run = createExportRun({
    sourceId: 's1', bookKey: 'k1', title: '斗罗', deps, t,
    onChange: (s) => { states.push(s) },
  })
  return { states, run }
}

describe('createExportRun：成功 / 失败（错误类目投影）/ 取消 / 卸载 abort', () => {
  it('成功：进度进状态（KB + 章数），收尾落盘并复位运行态', async () => {
    const blob = new Blob(['正文'])
    const saveBlob = vi.fn()
    const streamExport = vi.fn(async (opts: Parameters<ExportRunDeps['streamExport']>[0]) => {
      opts.onProgress(1536, '12')
      return blob
    })
    const { states, run } = setup({ streamExport, saveBlob })
    run.start()
    await vi.waitFor(() => expect(run.state.running).toBe(false))

    expect(saveBlob).toHaveBeenCalledWith(blob, '斗罗.txt')
    expect(states[0]).toEqual({ running: true, kb: 0, total: '', range: null, error: null })   // 起步即复位（无参 start = 全本）
    expect(states.some((s) => s.kb === 2 && s.total === '12')).toBe(true)             // 1536B → 2KB
    expect(run.state.error).toBeNull()
  })

  it('带范围 start：range 进状态、流收 from/to、文件名带范围后缀', async () => {
    const blob = new Blob(['正文'])
    const saveBlob = vi.fn()
    const streamExport = vi.fn(async (opts: Parameters<ExportRunDeps['streamExport']>[0]) => {
      opts.onProgress(1024, '76')
      return blob
    })
    const { states, run } = setup({ streamExport, saveBlob })
    run.start({ from: 5, to: 80, total: 100 })
    await vi.waitFor(() => expect(run.state.running).toBe(false))

    expect(streamExport.mock.calls[0][0]).toMatchObject({ from: 5, to: 80 })
    expect(saveBlob).toHaveBeenCalledWith(blob, '斗罗（第5-80章）.txt')
    expect(states[0].range).toEqual({ from: 5, to: 80, total: 100 })
    expect(run.state.total).toBe('76')                     // total-chapters 头 = 段内章数
  })

  it('整本范围 start（1..total）→ 文件名仍 书名.txt（全覆盖不是部分导出）', async () => {
    const saveBlob = vi.fn()
    const streamExport = vi.fn(async (opts: Parameters<ExportRunDeps['streamExport']>[0]) => {
      opts.onProgress(1, '100')
      return new Blob(['x'])
    })
    const { run } = setup({ streamExport, saveBlob })
    run.start({ from: 1, to: 100, total: 100 })
    await vi.waitFor(() => expect(run.state.running).toBe(false))
    expect(saveBlob.mock.calls[0][1]).toBe('斗罗.txt')
  })

  it('parseRange：倒置 / 越界 / 非整数 → 拒；合法 → ok（面板确认钮的判据）', () => {
    expect(parseRange('3', '1', 10)).toMatchObject({ ok: false, reason: 'reader.export.reason.reversed' })
    expect(parseRange('1', '11', 10)).toMatchObject({ ok: false, reason: 'reader.export.reason.outOfRange' })
    expect(parseRange('abc', '2', 10)).toMatchObject({ ok: false, reason: 'reader.export.reason.notInteger' })
    expect(parseRange('', '2', 10)).toMatchObject({ ok: false, reason: 'reader.export.reason.missing' })
    expect(parseRange('2', '2', 0)).toMatchObject({ ok: false, reason: 'reader.export.reason.tocNotReady' })   // 目录未就绪
    expect(parseRange('5', '80', 100)).toEqual({ ok: true, from: 5, to: 80 })
    expect(enTranslate('reader.export.reason.outOfRange', { total: 10 })).toBe('Range must be within chapters 1–10')
  })

  it('英文导出：文件名后缀随 t', async () => {
    const saveBlob = vi.fn()
    const streamExport = vi.fn(async () => new Blob(['x']))
    const { run } = setup({ streamExport, saveBlob }, enTranslate)
    run.start({ from: 5, to: 80, total: 100 })
    await vi.waitFor(() => expect(run.state.running).toBe(false))
    expect(saveBlob).toHaveBeenCalledWith(expect.any(Blob), '斗罗 (chapters 5-80).txt')
  })

  it('失败（ApiClientError 带 code）：错误类目投影——code + message 都进状态', async () => {
    const streamExport = vi.fn(async () => { throw new ApiClientError('ExportFailed', 500, '服务端导出失败') })
    const { run } = setup({ streamExport, saveBlob: vi.fn() })
    run.start()
    await vi.waitFor(() => expect(run.state.running).toBe(false))
    expect(run.state.error).toEqual({ code: 'ExportFailed', message: '服务端导出失败' })
  })

  it('失败（普通 Error 无 code）：只投影 message，不伪造 code', async () => {
    const streamExport = vi.fn(async () => { throw new Error('网络断了') })
    const { run } = setup({ streamExport, saveBlob: vi.fn() })
    run.start()
    await vi.waitFor(() => expect(run.state.running).toBe(false))
    expect(run.state.error).toEqual({ message: '网络断了' })
  })

  it('取消：cancel() 即断流，AbortError 静默（不算导出失败）', async () => {
    const { streamExport, aborted } = hangingStream()
    const { run } = setup({ streamExport, saveBlob: vi.fn() })
    run.start()
    run.cancel()
    await vi.waitFor(() => expect(run.state.running).toBe(false))
    expect(aborted()).toBe(true)
    expect(run.state.error).toBeNull()                   // 取消不是错误，不进错误条
  })

  it('卸载 abort：dispose() 即断流，不许孤儿抓取', async () => {
    const { streamExport, aborted } = hangingStream()
    const { run } = setup({ streamExport, saveBlob: vi.fn() })
    run.start()
    run.dispose()
    await vi.waitFor(() => expect(run.state.running).toBe(false))
    expect(aborted()).toBe(true)
    expect(run.state.error).toBeNull()
  })

  it('在途重入忽略：运行中再 start 不开第二路流（同钮再点是取消，不是重入）', () => {
    const d = defer()
    const streamExport = vi.fn(() => d.promise)
    const { run } = setup({ streamExport, saveBlob: vi.fn() })
    run.start()
    run.start()
    expect(streamExport).toHaveBeenCalledTimes(1)
  })

  it('进度回调丢 total：状态里 total 回退空串（标题不显示「共 N 章」）', async () => {
    const d = defer()
    const streamExport = vi.fn((opts: Parameters<ExportRunDeps['streamExport']>[0]) => {
      opts.onProgress(1024, null)
      return d.promise
    })
    const { run } = setup({ streamExport, saveBlob: vi.fn() })
    run.start()
    expect(run.state.kb).toBe(1)
    expect(run.state.total).toBe('')
    d.resolve(new Blob(['x']))
    await vi.waitFor(() => expect(run.state.running).toBe(false))
  })
})

/** 导出范围草稿：缺省 / 档位算术 / 校验的单一主人。视图此前三件事分住 openExport、onPreset、
 *  onConfirm 三处，面板再把 from/to/total 摊在三格 props 里——同一件事的第四份抄本。
 *  章数**不进草稿**：它是调用方每次现读的活值（当前目录长度），收进草稿就会停在开面板那一下的
 *  读数上——目录迟到即失真，预设也跟着回不到合法区间。 */
describe('export draft', () => {
  it('draftOf 给全本缺省', () => {
    expect(draftOf(12)).toEqual({ from: '1', to: '12' })
  })
  it('preset all 回到全本；preset rest 从下一章起', () => {
    // 档位不收草稿：两格全由 kind / currentChapter / total 派生，面板里用户改到哪都不影响这一步
    expect(applyPreset('all', 4, 12)).toEqual({ from: '1', to: '12' })
    expect(applyPreset('rest', 4, 12)).toEqual({ from: '5', to: '12' })
  })
  it('rest 在最后一章（0 基下标 = total - 1）= 只剩当章', () => {
    // 章下标 0 基：total 12 的最后一章是 11，rest 从 12 起、to 也是 12。
    expect(applyPreset('rest', 11, 12)).toEqual({ from: '12', to: '12' })
  })
  it('rest 在越界位（currentChapter = total）仍钳到 total（from 不越过 to）', () => {
    // 保留钳位用例，与上面那条真实最后一章分开：目录缩短后旧读数可以越界，
    // 越界同样不许产出 from > to（确认钮会凭空禁用，用户读不出为什么）。
    expect(applyPreset('rest', 12, 12)).toEqual({ from: '12', to: '12' })
  })
  it('validRangeOf 直接透出 parseRange 的判据', () => {
    expect(validRangeOf({ from: '3', to: '1' }, 12)).toEqual({
      ok: false, reason: 'reader.export.reason.reversed',
    })
    expect(validRangeOf({ from: '3', to: '5' }, 12)).toEqual({ ok: true, from: 3, to: 5 })
  })
  it('preset all 按调用方现给的 total 出全本（不沿用目录未就绪时的 0）', () => {
    // 钉住「total 是视图的活值」这条裁决：面板在目录未就绪时打开（视图草稿初值 draftOf(0)），
    // 目录到齐后点「整本」必须一步回到全本，而不是沿用草稿建成那一下的 0。
    expect(applyPreset('all', 0, 12)).toEqual({ from: '1', to: '12' })
  })
  it('preset rest 在当章 0（目录未就绪）时从第 1 章起：两格全由 kind / currentChapter / total 派生', () => {
    // 「不收草稿」是签名级的关闭（`applyPreset` 没有草稿形参，tsc 挡加宽对象透传），
    // 这里只钉 rest 分支在 0 位上的形状；旧实现以草稿为底会把多余格带进 setExpDraft，本用例不替那条作证。
    expect(applyPreset('rest', 0, 12)).toEqual({ from: '1', to: '12' })
  })
})
