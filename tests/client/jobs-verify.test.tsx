// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetJobSurface, startSourceVerification, useJobPolling } from '../../src/client/jobs.js'

/**
 * 书源验证领域动作（验证编排收拢）的 seam 测试。
 * 评审缺陷：三个验证入口的提交后编排散落调用者（有的催任务读面、有的重拉源列表，维护者必须
 * 记住何时用哪种；失败文案两份抄本一改即漂）。修法：`startSourceVerification` 收拢「提交 → 成功
 * 催读面 / 失败一处反馈」，入口只表达「验证哪些源」；终态的源列表刷新归 `reloadedJob` 记账
 * （另钉在 views-wiring）。
 */

describe('startSourceVerification：验证提交的编排单点', () => {
  beforeEach(resetJobSurface)

  it('成功 → 催任务读面（注入 refresh 恰一次）；ids 按点击时快照提交，调用方事后变异不影响', async () => {
    const refresh = vi.fn()
    const startBatchProbeJob = vi.fn(async () => ({ jobId: 'p1' }))
    const pushError = vi.fn()
    const ids = ['s1', 's2']
    const p = startSourceVerification(ids, { startBatchProbeJob, pushError, refresh })
    ids.push('s3')                                   // 调用方数组事后变异不许进已提交载荷
    await p
    expect(startBatchProbeJob).toHaveBeenCalledWith(['s1', 's2'])
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(pushError).not.toHaveBeenCalled()
  })

  it('失败 → 一处反馈「启动验证失败：…」（文案单点），不催读面，且不向上抛（入口都是 void 调用）', async () => {
    const refresh = vi.fn()
    const pushError = vi.fn()
    await startSourceVerification(['s1'], {
      startBatchProbeJob: vi.fn(async () => { throw new Error('boom') }),
      pushError,
      refresh,
    })
    expect(pushError).toHaveBeenCalledTimes(1)
    expect(String(pushError.mock.calls[0][0])).toContain('启动验证失败')
    expect(String(pushError.mock.calls[0][0])).toContain('boom')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refresh 缺省 = 生产口径 refreshJob：常驻轮询驱动立刻重拉一次（不等下一个 1s 拍）', async () => {
    const fetchJobStatus = vi.fn(async () => null)
    renderHook(() => useJobPolling({ fetchJobStatus }))
    await waitFor(() => expect(fetchJobStatus).toHaveBeenCalledTimes(1))   // 挂载即拉
    await startSourceVerification(['s1'], {                                 // 不传 refresh
      startBatchProbeJob: vi.fn(async () => ({ jobId: 'p1' })),
      pushError: vi.fn(),
    })
    await waitFor(() => expect(fetchJobStatus).toHaveBeenCalledTimes(2))   // 缺省 refreshJob → 立刻重拉
  })
})
