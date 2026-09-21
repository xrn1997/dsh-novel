// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useJobPolling } from '../../src/client/jobs.js'
import { SourceList } from '../../src/client/views/SettingsSourceList.js'
import { makeDeps } from './fake-deps.js'
import type { FakeSettingsDeps } from './fake-deps.js'
import { resetSourceListUi } from '../../src/client/source-list.js'
import { ROUTES } from '../../src/shared/wire.js'
import type { JobState, SourcePublic } from '../../src/client/views/types.js'

/**
 * 选中动作条 + 删除确认流的接线测试。
 * 2026 调度台改版（用户逐项裁定）的口径变化，本文件随之重写：
 * - 删除确认统一为**模态二次确认**（与书架删书同款口径：点名后果 + 登录态提示 +
 *   Esc/遮罩取消 + 焦点闭环 + ids 点击时快照）；
 * - 「>20 条手输『删除』」双强度确认与「危险区（整库级快捷批量）」退役——
 *   batchConfirmKind 已随之删除（`source-batch.ts` 整模块退役，取数口归 `source-inbox.ts`），
 *   对应 describe 从 logic.test.ts 移除；
 * - 行内「⋯」溢出菜单提供单源删除入口（低频动作收纳）。
 * 启停/验证批量的写口载荷、失败上报、在途防重复提交口径不变。
 *
 * **onChanged 是「重取源列表」的出口 Mock**（启停/删除成功后必须被调）。自验证编排收拢起
 * 「验证 → 催任务读面」不再走 props——收进 `jobs.ts` 的领域动作 `startSourceVerification`
 * （缺省 refresh = refreshJob），读面观测经 `useJobPolling` 轮询驱动的取数计数。
 * 病史：曾经 refresh/onChanged 都传空函数，于是批量启停接错出口（该重取源列表却只重启了
 * 轮询）在本文件完全测不出来，实机表现为点完启停界面停在旧值（2026-09 回归）——
 * 「启停 → 源列表 / 验证 → 任务读面」的分工断言仍钉在两个用例里，只是观测面换了。
 */

const src = (over: Partial<SourcePublic> & { id: string }): SourcePublic => ({
  name: over.id, baseUrl: `https://${over.id}.com`, enabled: true, groups: [],
  type: 'text', status: 'verified', importedAt: 0, hasHeader: false, hasAuth: false, authExpired: false,
  ...over,
})

const S1 = src({ id: 's1', name: '源一' })
const S2 = src({ id: 's2', name: '源二' })
const S3 = src({ id: 's3', name: '源三', hasAuth: true })

const runningProbe: JobState = {
  id: 'p1', kind: 'batch-probe', phase: 'running', total: 3, done: 1,
  counts: { ok: 1, failed: 0, dupSkipped: 0, replaced: 0 },
  issues: [], fileErrors: [], startedAt: 0,
}

/** 「重取源列表」出口 Mock：启停/删除成功后必须被调（验证的「催任务读面」不走 props） */
let onChanged: ReturnType<typeof vi.fn>

const view = (deps: FakeSettingsDeps, sources: SourcePublic[] = [S1, S2, S3], job: JobState | null = null): ReactNode =>
  <SourceList sources={sources} job={job} onChanged={onChanged} onProbe={() => {}} onImport={() => {}} deps={deps} />

/** 进编辑态并勾选指定行（复选框 aria-label = `选择 ${name}`） */
function selectRows(names: string[]): void {
  fireEvent.click(screen.getByText('编辑'))
  for (const n of names) fireEvent.click(screen.getByLabelText(`选择 ${n}`))
}

/** 选中动作条上的按钮（disabled 断言用原生属性） */
function selbarButton(label: string): HTMLElement {
  const bar = document.querySelector<HTMLElement>('[data-novel-selbar]')
  expect(bar, '选中动作条未出现').not.toBeNull()
  const btn = [...(bar as HTMLElement).querySelectorAll('button')].find((b) => b.textContent?.trim() === label)
  expect(btn, `动作条上找不到「${label}」`).toBeDefined()
  return btn as HTMLElement
}

beforeEach(() => { resetSourceListUi(); onChanged = vi.fn() })
afterEach(cleanup)

describe('选中动作条：启用/停用/验证所选（写口载荷 + 成功重读对出口 + 失败上报）', () => {
  it('启用所选：POST batch-enabled {ids, enabled:true} → 重取源列表（onChanged）+ 反馈条报服务端计数，留在编辑态且勾选保留', async () => {
    // 服务端只改了 1 个（未知 id 静默跳过是其契约）：条上要说 updated，不是"我勾了 2 个"
    const deps = makeDeps({ apiSend: vi.fn(async () => ({ updated: 1 })) })
    render(view(deps))
    selectRows(['源一', '源二'])
    fireEvent.click(screen.getByText('启用所选'))

    await waitFor(() => expect(deps.apiSend).toHaveBeenCalledWith(
      'POST', ROUTES.sourcesBatchEnabled.path, { ids: ['s1', 's2'], enabled: true }))
    // 启停改的是源本身 → 必须重取 sources（onChanged）。曾经这里走的是「重启任务轮询」
    // 的出口，写成功后没人重读，界面停在旧值、要重开视图才对（2026-09 实机 bug）；
    // 对向断言（验证 → 催任务读面、不重取源列表）在「验证所选」用例，经轮询取数计数观测。
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(deps.pushOk).toHaveBeenCalledWith('已启用 1 个源')   // 批量必须有条：被改的行可能在屏幕外
    // 这批源做完启停**还在列表里**，勾选就是它们的现场：留着才能连着点「验证所选」/改主意
    // 再停用，不必重勾（2026-09 用户裁定：清勾选「不应该」）
    expect(screen.getByText('完成')).toBeTruthy()                      // 还在编辑态
    expect(document.querySelector('[data-novel-selbar]')).not.toBeNull()
    expect((screen.getByLabelText('选择 源一') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('选择 源二') as HTMLInputElement).checked).toBe(true)
    expect(deps.pushError).not.toHaveBeenCalled()
  })

  it('停用所选：同端点 enabled:false，同样走重取源列表', async () => {
    const deps = makeDeps()
    render(view(deps))
    selectRows(['源三'])
    fireEvent.click(screen.getByText('停用所选'))
    await waitFor(() => expect(deps.apiSend).toHaveBeenCalledWith(
      'POST', ROUTES.sourcesBatchEnabled.path, { ids: ['s3'], enabled: false }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(document.querySelector('[data-novel-selbar]')).not.toBeNull()
  })

  it('验证所选：startBatchProbeJob(选中 ids) 经注入 deps 提交；成功催任务读面（不重取源列表）', async () => {
    const fetchJobStatus = vi.fn(async () => null)
    const deps = makeDeps()
    render(view(deps))
    renderHook(() => useJobPolling({ fetchJobStatus }))   // 观测面：常驻轮询驱动（生产同款读面）
    await waitFor(() => expect(fetchJobStatus).toHaveBeenCalledTimes(1))
    selectRows(['源一', '源三'])
    fireEvent.click(screen.getByText('验证所选'))
    await waitFor(() => expect(deps.startBatchProbeJob).toHaveBeenCalledWith(['s1', 's3']))
    // 与启停的分工不变：验证起的是后台任务 → 催任务读面（编排收进 jobs.ts 领域
    // 动作的缺省 refresh）；源列表要等任务收尾才变（收尾 reload 归 SettingsSection 的
    // reloadedJob 记账，另行钉在 views-wiring）。读数即刻重拉 = 轮询取数 +1（不等 1s 拍）。
    await waitFor(() => expect(fetchJobStatus).toHaveBeenCalledTimes(2))
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('验证所选失败：与其余入口同一份反馈「启动验证失败：…」；任务读面与源列表都不动，勾选留着可重试', async () => {
    const fetchJobStatus = vi.fn(async () => null)
    const deps = makeDeps({ startBatchProbeJob: vi.fn(async () => { throw new Error('boom') }) })
    render(view(deps))
    renderHook(() => useJobPolling({ fetchJobStatus }))
    await waitFor(() => expect(fetchJobStatus).toHaveBeenCalledTimes(1))
    selectRows(['源一'])
    fireEvent.click(screen.getByText('验证所选'))
    await waitFor(() => expect(deps.pushError).toHaveBeenCalledTimes(1))
    expect(String(deps.pushError.mock.calls[0][0])).toContain('启动验证失败')
    expect(String(deps.pushError.mock.calls[0][0])).toContain('boom')
    expect(onChanged).not.toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchJobStatus).toHaveBeenCalledTimes(1)                     // 失败不催读面
    expect(document.querySelector('[data-novel-selbar]')).not.toBeNull() // 勾选留着：失败不许清现场
  })

  it('清空选择：只退勾选，不退出编辑态（钮写的是「清空选择」，此前连带把编辑态一起退了）', () => {
    render(view(makeDeps()))
    selectRows(['源一'])
    fireEvent.click(screen.getByText('清空选择'))
    expect(document.querySelector('[data-novel-selbar]')).toBeNull()
    expect(screen.getByText('完成')).toBeTruthy()          // 还在编辑态
    fireEvent.click(screen.getByLabelText('选择 源二'))      // 复选框仍在，直接接着勾
    expect(document.querySelector('[data-novel-selbar]')).not.toBeNull()
  })

  it('失败半场：pushError 上报「操作失败」+ 原因；两个重读出口都不触发（服务端没变就不重拉），勾选留着可重试', async () => {
    const deps = makeDeps({ apiSend: vi.fn(() => Promise.reject(new Error('boom'))) })
    render(view(deps))
    selectRows(['源一'])
    fireEvent.click(screen.getByText('启用所选'))
    await waitFor(() => expect(deps.pushError).toHaveBeenCalledTimes(1))
    expect(String(deps.pushError.mock.calls[0][0])).toContain('操作失败')
    expect(String(deps.pushError.mock.calls[0][0])).toContain('boom')
    expect(onChanged).not.toHaveBeenCalled()
    expect(document.querySelector('[data-novel-selbar]')).not.toBeNull()   // 勾选留着：失败不许把现场一起清掉
  })

  it('在途防重复提交：批量任务运行中（probing）三个写按钮禁用；删除走模态确认仍可打开（可先攒着）', async () => {
    const deps = makeDeps()
    render(view(deps, [S1, S2, S3], runningProbe))
    selectRows(['源一'])
    expect(selbarButton('启用所选').hasAttribute('disabled')).toBe(true)
    expect(selbarButton('停用所选').hasAttribute('disabled')).toBe(true)
    expect(selbarButton('验证所选').hasAttribute('disabled')).toBe(true)
    expect(selbarButton('删除所选').hasAttribute('disabled')).toBe(false)
  })
})

describe('删除：统一模态二次确认（2026 改版——手输口令与危险区退役）', () => {
  it('删除所选 → 模态点名数量；确认后 POST batch-delete {ids}（点击时快照）+ 勾选清空 + 反馈条', async () => {
    const deps = makeDeps({ apiSend: vi.fn(async () => ({ removed: 2 })) })
    render(view(deps))
    selectRows(['源一', '源二'])
    fireEvent.click(screen.getByText('删除所选'))

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('删除所选 2 个源？')).toBeTruthy()
    expect(screen.queryByText(/带登录态/)).toBeNull()          // 无登录态源：不虚构提示

    fireEvent.click(screen.getByText('确认删除'))
    await waitFor(() => expect(deps.apiSend).toHaveBeenCalledWith(
      'POST', ROUTES.sourcesBatchDelete.path, { ids: ['s1', 's2'] }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(deps.pushOk).toHaveBeenCalledWith('已删除 2 个源')
    expect(deps.pushError).not.toHaveBeenCalled()
    // 已删 id 留在选择集里 = 幽灵勾选：动作条还喊「已选 2」而表里只剩 1 行，
    // 下一轮批量动作会把死 id 一起提交
    await waitFor(() => expect(document.querySelector('[data-novel-selbar]')).toBeNull())
    expect(screen.getByText('完成')).toBeTruthy()               // 删除也不弹回浏览态（与启停同口径）
  })

  it('带登录态源点名：模态提示 cookie 失效（authCount 经派生 view-model）', () => {
    const deps = makeDeps()
    render(view(deps))
    selectRows(['源一', '源三'])
    fireEvent.click(screen.getByText('删除所选'))
    expect(screen.getByText(/其中 1 个带登录态，删除后 cookie 失效/)).toBeTruthy()
  })

  it('Esc 取消：模态收起且零 DELETE 请求（取消不许有写口）', () => {
    const deps = makeDeps()
    render(view(deps))
    selectRows(['源一'])
    fireEvent.click(screen.getByText('删除所选'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(deps.apiSend).not.toHaveBeenCalled()
  })

  it('点遮罩取消：同样零请求', () => {
    const deps = makeDeps()
    render(view(deps))
    selectRows(['源一'])
    fireEvent.click(screen.getByText('删除所选'))
    fireEvent.click(document.querySelector('.novel-modal-mask') as Element)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(deps.apiSend).not.toHaveBeenCalled()
  })

  it('焦点闭环：入场焦点在「取消」；关闭后焦点还给触发件（与书架删书同款口径）', () => {
    const deps = makeDeps()
    render(view(deps))
    selectRows(['源一'])
    const opener = screen.getByText('删除所选')
    opener.focus()                                       // jsdom 的 click 不聚焦（真实浏览器会）——焦点断言先显式聚焦
    fireEvent.click(opener)
    expect(document.activeElement?.textContent).toBe('取消')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement?.textContent).toBe('删除所选')
  })

  it('confirmDelete 失败半场：pushError 上报「批量删除失败」，模态照常收起，onChanged 不触发且勾选留着', async () => {
    const deps = makeDeps({ apiSend: vi.fn(() => Promise.reject(new Error('磁盘只读'))) })
    render(view(deps))
    selectRows(['源一'])
    fireEvent.click(screen.getByText('删除所选'))
    fireEvent.click(screen.getByText('确认删除'))

    await waitFor(() => expect(deps.pushError).toHaveBeenCalledTimes(1))
    expect(String(deps.pushError.mock.calls[0][0])).toContain('批量删除失败')
    expect(String(deps.pushError.mock.calls[0][0])).toContain('磁盘只读')
    expect(screen.queryByRole('dialog')).toBeNull()       // 失败也收模态（错误进全局条，可重开）
    expect(onChanged).not.toHaveBeenCalled()
    expect(document.querySelector('[data-novel-selbar]')).not.toBeNull()   // 没删成就不清勾选（现场留着重试）
  })

  it('确认在途防重：双击「确认删除」只发一次 POST（危险动作不许有双写窗口——与书架 delBusy 同款口径）', async () => {
    let resolveSend: (v: unknown) => void = () => { /* replaced below */ }
    const deps = makeDeps({ apiSend: vi.fn(() => new Promise((res) => { resolveSend = res })) })
    render(view(deps))
    selectRows(['源一'])
    fireEvent.click(screen.getByText('删除所选'))
    fireEvent.click(screen.getByText('确认删除'))
    fireEvent.click(screen.getByText('确认删除'))         // 第二击：即使事件到达，confirmDelete 的 delBusy 闸也拒之门外
    expect(deps.apiSend).toHaveBeenCalledTimes(1)
    resolveSend({ removed: 1 })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('ids 是点击时快照：模态开着时改选中集，确认提交的仍是开模时的 ids（快照不是重算）', async () => {
    const deps = makeDeps()
    render(view(deps))
    selectRows(['源一', '源二'])
    fireEvent.click(screen.getByText('删除所选'))
    fireEvent.click(screen.getByLabelText('选择 源三'))   // 模态开着：现场再勾一个（jsdom 无遮罩命中测试，事件直达复选框）
    fireEvent.click(screen.getByText('确认删除'))
    await waitFor(() => expect(deps.apiSend).toHaveBeenCalledWith(
      'POST', ROUTES.sourcesBatchDelete.path, { ids: ['s1', 's2'] }))   // 不含 s3——pending.ids 是开模时的快照
  })

  it('重渲染不扰焦点：父层 re-render（任务轮询 1s 一次的新闭包）不重抢焦点，Esc 关闭后焦点仍还给触发件', () => {
    const deps = makeDeps()
    const { rerender } = render(view(deps))
    selectRows(['源一'])
    const opener = screen.getByText('删除所选')
    opener.focus()                                       // jsdom 的 click 不聚焦（真实浏览器会）——先显式聚焦
    fireEvent.click(opener)
    expect(document.activeElement?.textContent).toBe('取消')   // 入场焦点
    ;(screen.getByText('确认删除') as HTMLElement).focus()      // 用户把焦点移进模态
    expect(document.activeElement?.textContent).toBe('确认删除')
    // 壳层重渲染 × 2（模拟 useJobStatus 轮询 tick：新 job 对象 → SourceList 重渲染 → 新 onCancel 闭包）。
    // 旧实现：effect 依赖 [onCancel] → 每次重渲染 cleanup+重跑 → 焦点被劫回「取消」、
    // opener 被重捕获成模态内按钮（关闭时焦点落 body）。挂载作用域化后焦点必须原地不动。
    rerender(view(deps))
    rerender(view(deps))
    expect(document.activeElement?.textContent).toBe('确认删除')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement?.textContent).toBe('删除所选')   // 还焦给触发件（opener 由调用方传入）
  })

  it('行内「⋯ → 删除」单源：模态点名书名《源一》；「停用 ≠ 删除」提示在场', () => {
    const deps = makeDeps()
    render(view(deps))
    fireEvent.click(screen.getByLabelText('更多动作 源一'))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    expect(screen.getByText('删除《源一》？')).toBeTruthy()
    expect(screen.getByText(/停用 ≠ 删除/)).toBeTruthy()
    // 焦点闭环对这条路也必须成立：菜单项点完即随菜单卸载，旧实现读 document.activeElement
    // 拿到的是 body（取消后焦点掉 body，2026-09 审查发现的空承诺）——归还对象是行内 ⋯ 钮。
    expect(document.activeElement?.textContent).toBe('取消')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).toBe(screen.getByLabelText('更多动作 源一'))
  })

  it('「⋯」菜单：点页面任意处收起（浮层不留悬空）', () => {
    render(view(makeDeps()))
    fireEvent.click(screen.getByLabelText('更多动作 源一'))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.click(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
