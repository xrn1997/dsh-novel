// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { rowAnchorOf, SourceList } from '../../src/client/views/SettingsSourceList.js'
import { makeDeps } from './fake-deps.js'
import type { FakeSettingsDeps, DepsOverrides } from './fake-deps.js'
import { resetSourceListUi, UNGROUPED } from '../../src/client/source-list.js'
import { pushError, pushOk, resetTransient, transientEntries } from '../../src/client/transient.js'
import type { SourcePublic } from '../../src/client/views/types.js'

/**
  * 接线层交互测试：启停开关的「乐观翻转 → 在途 → 失败即刻回滚
 * → error 泳道挂行锚点」整条时序，历史上住着真 bug（「原实现乐观态无人清零，开关会永久停在
 * 错误态」），却因为视图硬 import 真实现而**无法被测试驱动**。现在经 deps seam 注入假 adapter
  * （桩工厂统一到 tests/client/fake-deps.ts）。
 */

const src: SourcePublic = {
  id: 's1', name: '源A', baseUrl: 'https://a.com', enabled: true, groups: ['小说'],
  type: 'text', status: 'verified', importedAt: 0, hasHeader: false, hasAuth: false, authExpired: false, hasLoginUrl: false,
}

const view = (deps: FakeSettingsDeps): ReactNode =>
  <SourceList sources={[src]} job={null} onChanged={() => {}} onProbe={() => {}} onImport={() => {}} deps={deps} />

const checked = (): string | null => screen.getByRole('switch').getAttribute('aria-checked')

beforeEach(() => { resetSourceListUi(); resetTransient() })   // 模块级现场一次复位
afterEach(() => { cleanup(); resetTransient() })

/** 缺省 `pushError`/`pushOk` 是空 `vi.fn()`——真实瞬态层从未被写，`transientEntries()` 那条
 *  「在途不进泳道」的锁因此恒真（空断言）。这组替身**转发到真实模块**：调用数仍可断言，
 *  条目也真的落进 store，泳道读数与行内红边才是被测对象。 */
const realTransient = () => ({ pushError: vi.fn(pushError), pushOk: vi.fn(pushOk) })

describe('SourceList 启停开关接线（deps seam 驱动）', () => {
  it('rowAnchorOf：行锚点选择器与行内 data 属性同源（错误条「定位 →」与行内红边共用）', () => {
    expect(rowAnchorOf('x9')).toBe('[data-novel-source-row="x9"]')
  })

  it('开关挂 .novel-switch 且内含滑块 <i>（外观与位移全在样式层：类一丢就是无底无滑块的裸按钮，且搜不到报错）', () => {
    render(view(makeDeps()))
    const sw = screen.getByRole('switch')
    expect(sw.className).toContain('novel-switch')
    expect(sw.querySelector('i')).not.toBeNull()
  })

  it('成功路径：点击即乐观翻转（请求未回已是新态），回包后保持且静默', async () => {
    let resolveSend: (v: unknown) => void = () => { /* replaced below */ }
    const deps = makeDeps({ apiSend: vi.fn(() => new Promise((res) => { resolveSend = res })), ...realTransient() })
    render(view(deps))
    expect(checked()).toBe('true')                        // 初始：已启用（按钮语义=停用）

    fireEvent.click(screen.getByRole('switch'))
    expect(checked()).toBe('false')                       // 乐观翻转：请求还没回，展示已切

    resolveSend({})
    await waitFor(() => expect(deps.apiSend).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(checked()).toBe('false'))  // 回包后保持新态
    expect(deps.pushError).not.toHaveBeenCalled()         // 成功静默：开关翻转本身即反馈
    expect(deps.pushOk).not.toHaveBeenCalled()
    expect(transientEntries()).toEqual([])                // 真 store 里也没有回执条
  })

  it('失败路径：即刻回滚到服务端原态 + error 泳道挂行锚点（历史 bug 回归钉死）', async () => {
    const deps = makeDeps({
      apiSend: vi.fn(() => Promise.reject(new Error('boom'))),
      ...realTransient(),
    })
    render(view(deps))
    expect(checked()).toBe('true')

    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(deps.pushError).toHaveBeenCalledTimes(1))

    expect(checked()).toBe('true')                        // 回滚：不许永久停在错误的乐观态
    const [label, anchor] = deps.pushError.mock.calls[0]
    expect(String(label)).toContain('启停失败')
    expect(String(label)).toContain('boom')
    expect(anchor).toBe('[data-novel-source-row="s1"]')   // 全局条「定位 →」与行内红边共用的选择器
    expect(document.querySelector(anchor)?.getAttribute('data-novel-source-row')).toBe('s1')
    // 真瞬态层读数：只有那一枚 error（带行锚点），没有多余条目
    const entries = transientEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('error')
    expect(entries[0].label).toContain('启停失败')
    expect(entries[0].anchor).toBe('[data-novel-source-row="s1"]')
    // 行内红边由同一个真实 store 驱动（错误条与行内装饰不是两套判据）
    await waitFor(() => {
      expect(document.querySelector('[data-novel-source-row="s1"]')?.className).toContain('row-err')
    })
  })

  it('在途不进瞬态泳道（闪烁回归锁：秒级操作零占用，在途只有行内装饰）', async () => {
    let settle: (v: unknown) => void = () => { /* replaced below */ }
    const deps = makeDeps({ apiSend: vi.fn(() => new Promise((res) => { settle = res })), ...realTransient() })
    render(view(deps))
    fireEvent.click(screen.getByRole('switch'))
    // 请求在途：真瞬态层里没有任何条目，也没有错误（空断言不再靠空桩成立）
    expect(transientEntries()).toEqual([])
    expect(deps.pushError).not.toHaveBeenCalled()
    expect(screen.queryByRole('progressbar')).toBeNull()
    settle({})
    await waitFor(() => expect(checked()).toBe('false'))
    expect(transientEntries()).toEqual([])                // 成功静默，不在真 store 里补条
  })

  it('乐观值随服务端值让位：reload 落地即以服务端为准（粘滞乐观态——审查 2026 发现的真缺陷回归钉）', async () => {
    // 乐观值必须随服务端值让位：另一入口（selbar 批量停用 / AI 工具）改了服务端后，
    // reload 落地即以服务端为准，残留的 optimistic 不得顶住显示（key={s.id} 稳定，SourceRow 跨 reload 存活）。
    const deps = makeDeps()                                  // apiSend 缺省成功
    const off: SourcePublic = { ...src, enabled: false }
    const panel = (sources: SourcePublic[]): ReactNode =>
      <SourceList sources={sources} job={null} onChanged={() => {}} onProbe={() => {}} onImport={() => {}} deps={deps} />
    const { rerender } = render(panel([off]))
    expect(checked()).toBe('false')                          // 初始：停用

    fireEvent.click(screen.getByRole('switch'))
    expect(checked()).toBe('true')                           // 乐观翻转：请求未回已是新态
    await waitFor(() => expect(deps.apiSend).toHaveBeenCalledTimes(1))

    rerender(panel([{ ...off, enabled: true }]))             // reload 落地：服务端确认新态
    await waitFor(() => expect(checked()).toBe('true'))

    rerender(panel([{ ...off, enabled: false }]))            // 另一入口在服务端停用了它 → reload 再落地
    await waitFor(() => expect(checked()).toBe('false'))     // 行跟随服务端，不被残留乐观值顶住
  })
})

/** 停用 ≠ 免验（用户裁定）：停用只摘掉「参与聚合搜索」这一件事——行内验证入口
 *  按状态出，不随 enabled 消失，否则停用源点不动单源验证，却照样出现在待办收件箱的
 *  批量重验 id 集里，两个入口口径打架。 */
describe('SourceList 行内验证入口与启停正交（编排收进 jobs.ts 领域动作）', () => {
  const panel = (over: Partial<SourcePublic>, depsOver: DepsOverrides = {}): {
    node: ReactNode; deps: FakeSettingsDeps; onChanged: ReturnType<typeof vi.fn>
  } => {
    const deps = makeDeps(depsOver)
    const onChanged = vi.fn()
    const node = <SourceList sources={[{ ...src, ...over }]} job={null} onChanged={onChanged} onProbe={() => {}} onImport={() => {}} deps={deps} />
    return { node, deps, onChanged }
  }

  it('停用 + 未验证 → 仍出「验证」钮，点击只验这一源；提交成功不就地重取源列表', async () => {
    const { node, deps, onChanged } = panel({ enabled: false, status: 'unverified' })
    render(node)
    fireEvent.click(screen.getByText('验证'))
    await waitFor(() => expect(deps.startBatchProbeJob).toHaveBeenCalledWith(['s1']))
    // 验证起任务 → 读任务：命中任务的出口是 refreshJob，不走 onChanged（后者属改源的口径，
    // 与待办/批量入口一致）；提交成功后「催任务读面」的观测钉在 jobs-verify.test.ts
    // （缺省 refresh = refreshJob → 轮询立刻重拉）。
    await new Promise((r) => setTimeout(r, 20))
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('行内验证失败 → 与其余入口同一份反馈文案「启动验证失败：…」（不再有第二份抄本）', async () => {
    const { node, deps } = panel({ status: 'unverified' },
      { startBatchProbeJob: vi.fn(async () => { throw new Error('boom') }) })
    render(node)
    fireEvent.click(screen.getByText('验证'))
    await waitFor(() => expect(deps.pushError).toHaveBeenCalledTimes(1))
    expect(String(deps.pushError.mock.calls[0][0])).toContain('启动验证失败')
    expect(String(deps.pushError.mock.calls[0][0])).toContain('boom')
  })

  it('停用 + 坏源 → 仍出「重验」钮（异常还在，停用不是免验理由）', () => {
    render(panel({ enabled: false, status: 'broken' }).node)
    expect(screen.getByText('重验')).toBeTruthy()
  })

  it('已验证的停用源不出验证/重验（钮随状态出，与启停无关）', () => {
    render(panel({ enabled: false, status: 'verified' }).node)
    expect(screen.queryByText('验证')).toBeNull()
    expect(screen.queryByText('重验')).toBeNull()
  })
})

/** 分组下拉「未分组」伪选项（增补）：无分组源不属于任何真实组——没有这个入口就定位不到 */
describe('SourceList 分组下拉「未分组」伪选项', () => {
  const ungrouped: SourcePublic = { ...src, id: 's2', name: '源B', baseUrl: 'https://b.com', groups: [] }
  const renderWith = (sources: SourcePublic[]): HTMLSelectElement => {
    render(<SourceList sources={sources} job={null} onChanged={() => {}} onProbe={() => {}} onImport={() => {}} deps={makeDeps()} />)
    return screen.getByLabelText('按分组过滤') as HTMLSelectElement
  }

  it('有无分组源 → 出现「未分组（n）」选项；选中后只显示无分组源', () => {
    const sel = renderWith([src, ungrouped])
    expect([...sel.options].find((o) => o.value === UNGROUPED)?.textContent).toBe('未分组（1）')

    fireEvent.change(sel, { target: { value: UNGROUPED } })
    expect(screen.getByText('源B')).toBeTruthy()      // 无分组源入选
    expect(screen.queryByText('源A')).toBeNull()      // 有分组源被排除
  })

  it('计数为 0 → 不渲染该选项（不添噪声）', () => {
    const sel = renderWith([src])
    expect([...sel.options].some((o) => o.value === UNGROUPED)).toBe(false)
  })
})
