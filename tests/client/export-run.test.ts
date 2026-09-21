import { describe, expect, it, vi } from 'vitest'
import { createExportRun, parseRange } from '../../src/client/export-run.js'
import type { ExportRunDeps, ExportRunState } from '../../src/client/export-run.js'
import { ApiClientError } from '../../src/client/api.js'

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

const setup = (deps: ExportRunDeps): { states: ExportRunState[]; run: ReturnType<typeof createExportRun> } => {
  const states: ExportRunState[] = []
  const run = createExportRun({
    sourceId: 's1', bookKey: 'k1', title: '斗罗', deps,
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
    expect(parseRange('3', '1', 10)).toMatchObject({ ok: false })
    expect(parseRange('1', '11', 10)).toMatchObject({ ok: false })
    expect(parseRange('abc', '2', 10)).toMatchObject({ ok: false })
    expect(parseRange('', '2', 10)).toMatchObject({ ok: false })   // Number('') = 0 < 1
    expect(parseRange('2', '2', 0)).toMatchObject({ ok: false })   // 目录未就绪
    expect(parseRange('5', '80', 100)).toEqual({ ok: true, from: 5, to: 80 })
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
