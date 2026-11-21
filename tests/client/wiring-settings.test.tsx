// @vitest-environment jsdom
import { fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetJobSurface, useJobPolling } from '../../src/client/jobs.js'
import { resetSourceInboxUi } from '../../src/client/source-inbox-ui.js'
import { SettingsSection } from '../../src/client/views/SettingsSection.js'
import type { JobState, SourcePublic } from '../../src/client/views/types.js'
import { ROUTES } from '../../src/shared/wire.js'
import { pick } from '../support/fixture.js'
import { makeDeps } from './fake-deps.js'
import type { DepsOverrides, FakeSettingsDeps } from './fake-deps.js'
import { installWiringLifecycle } from './wiring-harness.js'

/**
 * 设置区块整壳的接线（调度台 IA）：源列表取数与重取、待办任务卡的忽略与作废、状态带读数、
 * 导入弹层的焦点与闭环、终态刷新的记账。观测面与源列表都走注入的 SettingsDeps。
 */

installWiringLifecycle()

describe('SettingsSection 整壳接线（调度台 IA：待办箱 + 弹层闭环；SettingsDeps 注入）', () => {
  const unverifiedSrc: SourcePublic = {
    id: 'u1', name: '未验源', baseUrl: 'https://u.com', enabled: true, aiSearch: false, groups: [],
    type: 'text', status: 'unverified', importedAt: 0, hasHeader: false, hasAuth: false, authExpired: false, hasLoginUrl: false,
  }
  const brokenSrc: SourcePublic = {
    id: 'b1', name: '坏源甲', baseUrl: 'https://b.com', enabled: true, aiSearch: false, groups: [],
    type: 'text', status: 'broken', importedAt: 0, hasHeader: false, hasAuth: false, authExpired: false, hasLoginUrl: false,
  }
  const doneImportJob: JobState = {
    id: 'imp1', kind: 'import', phase: 'done', total: 1, done: 1,
    counts: { ok: 1, failed: 0, dupSkipped: 0, replaced: 0 },
    issues: [], fileErrors: [], startedAt: 0,
  }
  const settingsDeps = (over: DepsOverrides = {}, sources: SourcePublic[] = [unverifiedSrc]): FakeSettingsDeps =>
    makeDeps({ apiGet: vi.fn(async (path: string) => (path === 'sources' ? sources : null)), ...over })

  // 忽略现场是模块级 store（source-inbox-ui.ts）：不复位会让上一个用例的「已忽略」漏进
  // 下一个用例的「卡该在」（先例 resetSourceListUi / resetTransient）；jobSurface 同理——
  // 本文件的验证编排用例经 useJobPolling 驱动真实轮询写镜像。
  beforeEach(() => { resetSourceInboxUi(); resetJobSurface() })

  it('源列表经 deps.apiGet 加载（整壳注入后子组件不吃 prodDeps 缺省）', async () => {
    const deps = settingsDeps()
    render(createElement(SettingsSection, { deps }))
    await waitFor(() => expect(document.querySelector('[data-novel-source-list]')).not.toBeNull())
    await waitFor(() => expect(screen.getAllByText('未验源').length).toBeGreaterThan(0))   // 名字同时在待办卡与表格行（多匹配属正常）
    expect(deps.apiGet).toHaveBeenCalledWith('sources')
  })

  it('批量启停成功后源列表按服务端重取数：行开关即刻翻转（不重读就停在旧态，逼用户重开视图）', async () => {
    // 假服务端：启停写口真的改内存里的 enabled，取数口回读——只有客户端重新 GET 过，
    // 行开关的 aria-label 才会从「停用 X」变成「启用 X」。
    const server: SourcePublic[] = [{ ...unverifiedSrc }]
    const deps = makeDeps({
      apiGet: vi.fn(async (path: string) => (path === 'sources' ? server.map((s) => ({ ...s })) : null)),
      apiSend: vi.fn(async (target: { method: string; path: string }, body?: unknown) => {
        if (target.path === ROUTES.sourcesBatchEnabled.path) {
          const { ids, enabled } = body as { ids: string[]; enabled: boolean }
          for (const s of server) if (ids.includes(s.id)) s.enabled = enabled
        }
        return {}
      }),
    })
    render(createElement(SettingsSection, { deps }))
    await screen.findByRole('switch', { name: '停用 未验源' })          // 初始 enabled:true
    fireEvent.click(screen.getByText('编辑'))
    fireEvent.click(screen.getByLabelText('选择 未验源'))
    fireEvent.click(screen.getByText('停用所选'))
    await waitFor(() => expect(deps.apiSend).toHaveBeenCalledWith(
      ROUTES.sourcesBatchEnabled, { ids: ['u1'], enabled: false }))
    await screen.findByRole('switch', { name: '启用 未验源' })           // 服务端已停用 → 界面跟上
  })

  it('待办收件箱：坏源/未验证成任务卡（反常置顶，卡面不印计数）；「一键验证」走注入 deps', async () => {
    const deps = settingsDeps({}, [unverifiedSrc, brokenSrc])
    render(createElement(SettingsSection, { deps }))
    expect(await screen.findByText('? 未验证')).toBeTruthy()
    expect(screen.getByText('✗ 坏源')).toBeTruthy()
    // 读数只印一遍：读数的唯一住址是列表头状态带，卡标题带计数就是两份抄本各说各话
    expect(screen.queryByText('✗ 坏源 1')).toBeNull()
    expect(screen.queryByText('? 未验证 1')).toBeNull()
    const brokenCard = document.querySelector('[data-novel-todo="broken"]')
    expect(brokenCard, '坏源任务卡未渲染').not.toBeNull()
    expect(within(brokenCard as HTMLElement).getByText('坏源甲')).toBeTruthy()   // 名单在卡内
    fireEvent.click(screen.getByText('一键验证'))
    await waitFor(() => expect(deps.startBatchProbeJob).toHaveBeenCalledWith(['u1']))
  })

  it('待办卡可忽略：卡收起而读数留在状态带；「重新显示」把忽略掉的卡全开回来（不留黑洞）', async () => {
    const deps = settingsDeps({}, [unverifiedSrc, brokenSrc])
    render(createElement(SettingsSection, { deps }))
    await screen.findByText('批量重验')
    fireEvent.click(screen.getByLabelText('忽略 坏源 提示'))
    expect(document.querySelector('[data-novel-todo="broken"]')).toBeNull()
    expect(screen.getByText('一键验证')).toBeTruthy()              // 只收起点的那一张
    expect(screen.getByText('坏源 1')).toBeTruthy()                // 提示能关，读数不能跟着消失
    expect(screen.getByText(/已忽略 1 张/)).toBeTruthy()           // 忽略态看得见
    fireEvent.click(screen.getByText('重新显示'))
    expect(document.querySelector('[data-novel-todo="broken"]')).not.toBeNull()
  })

  it('忽略过的那批整批消失后再回来，提示照旧出现：失效记录跟着取数落动作废，不替用户记住他没做过的「已看过」', async () => {
    // 忽略按**成员签名**记账，签名一模一样就遮；所以清单落地时必须作废失效记录——删光坏源
    // 后再导入同一批 id 会复现签名，残留记录会吞掉一张用户从未忽略过的卡。
    // 作废挂在「清单落地的那一处」（SettingsSection 的 reload），不挂 effect 等人记得调。
    const { unmount } = render(createElement(SettingsSection, { deps: settingsDeps({}, [brokenSrc]) }))
    await screen.findByText('批量重验')
    fireEvent.click(screen.getByLabelText('忽略 坏源 提示'))
    expect(document.querySelector('[data-novel-todo="broken"]')).toBeNull()
    unmount()

    render(createElement(SettingsSection, { deps: settingsDeps({}, []) }))    // 这批坏源都没了
    await waitFor(() => expect(document.querySelector('[data-novel-source-list]')).not.toBeNull())
    unmount()

    render(createElement(SettingsSection, { deps: settingsDeps({}, [brokenSrc]) }))   // 又导入同一批
    await waitFor(() => expect(document.querySelector('[data-novel-todo="broken"]')).not.toBeNull())
  })

  it('列表头状态带：五个读数按全库算，非 0 的 未验证/坏源 带语义色类', async () => {
    const deps = settingsDeps({}, [unverifiedSrc, brokenSrc, { ...unverifiedSrc, id: 'u2', name: '未验源二', enabled: false }])
    const { container } = render(createElement(SettingsSection, { deps }))
    const band = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('[data-novel-src-stats]')
      if (el === null) throw new Error('状态带未渲染')     // throw 而非 expect(null)：waitFor 的返回类型才收窄到 HTMLElement
      return el
    })
    expect(band.textContent).toContain('共 3 个源')
    expect(band.textContent).toContain('已启用 2')
    expect(band.textContent).toContain('已停用 1')
    expect(band.textContent).toContain('未验证 2')      // 停用源照旧计入（停用 ≠ 免验）
    expect(band.textContent).toContain('坏源 1')
    const brokenStat = [...band.querySelectorAll('span')].find((s) => s.textContent === '坏源 1')
    expect(brokenStat?.className).toContain('err')      // 非 0 → 吃 err 色
  })

  it('0 源（删光了）：列表头与「＋ 导入书源」必须在场，且能点开弹层', async () => {
    // 0 源时组件不许 early-return：提示指向的「＋ 导入书源」必须真的在树上，且能打开弹层。
    // **先等取数落定再查按钮**：sources 为 null 的首帧照样渲染列表头，边等边查会拿到随后被卸载
    // 的节点，点它没反应的假绿比红更贵。
    const deps = settingsDeps({}, [])
    render(createElement(SettingsSection, { deps }))
    await screen.findByText(/还没有书源/)
    const btn = screen.getByRole('button', { name: '＋ 导入书源' })
    fireEvent.click(btn)
    await waitFor(() => expect(screen.getByText(/选择或拖入 legado 书源文件/)).toBeTruthy())
  })

  it('取数失败：不把失败伪装成「还没有书源」，且同一句错误只说一遍、导入入口照样可达', async () => {
    const deps = settingsDeps({ apiGet: vi.fn(async () => { throw new Error('boom') }) })
    render(createElement(SettingsSection, { deps }))
    await waitFor(() => expect(screen.getByText(/源列表加载失败：boom/)).toBeTruthy())
    expect(screen.queryByText(/还没有书源/)).toBeNull()          // 失败不许伪装成空态（宁炸不猜）
    expect(screen.queryByText(/源列表暂时不可用/)).toBeNull()      // 同一个失败不在两处各抄一句
    expect(screen.getByRole('button', { name: '＋ 导入书源' })).toBeTruthy()
  })

  it('加载中（sources 仍为 null）不报读数：状态带不在场，也不许出现「共 0 个源」', async () => {
    const deps = makeDeps({ apiGet: vi.fn(() => new Promise<never>(() => {})) })
    const { container } = render(createElement(SettingsSection, { deps }))
    await new Promise((r) => setTimeout(r, 30))
    expect(container.querySelector('[data-novel-src-stats]')).toBeNull()
    expect(container.textContent).not.toContain('共 0 个源')      // 未知不冒充「0 个源」这条结论
    expect(container.querySelector('[data-novel-source-list]')).not.toBeNull()
  })

  it('全健康源 → 待办区整块不渲染（零待办不常驻；「查过了且没事」由状态带的 0 来说）', async () => {
    const healthy: SourcePublic = { ...unverifiedSrc, id: 'h1', name: '健康源', status: 'verified' }
    const deps = settingsDeps({}, [healthy])
    const { container } = render(createElement(SettingsSection, { deps }))
    await waitFor(() => expect(container.querySelector('[data-novel-src-stats]')).not.toBeNull())
    expect(container.querySelector('[data-novel-inbox]')).toBeNull()
    expect(screen.getByText('未验证 0')).toBeTruthy()
    expect(screen.getByText('坏源 0')).toBeTruthy()
  })

  it('顺序不变量：待办区在源列表表格之前（反常置顶）', async () => {
    const deps = settingsDeps({}, [unverifiedSrc, brokenSrc])
    const { container } = render(createElement(SettingsSection, { deps }))
    await screen.findByText('批量重验')
    // 顺序断言走 DOM 比较而非 innerHTML.indexOf——innerHTML 里 <style>（NovelStyles）注入的
    // CSS 文本先出现，字符串匹配会打到规则文本上（`.novel-table` 规则在 `.novel-inbox` 之前=假红）
    const inbox = container.querySelector('[data-novel-inbox]')
    const table = container.querySelector('.novel-table')
    expect(inbox, '待办区未渲染').not.toBeNull()
    expect(table, '表格未渲染').not.toBeNull()
    expect((inbox as Element).compareDocumentPosition(table as Element) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
  })

  it('「批量重验」= 坏源集合的处置动作（ids 经 source-inbox 纯派生，点击时快照）', async () => {
    const deps = settingsDeps({}, [unverifiedSrc, brokenSrc])
    render(createElement(SettingsSection, { deps }))
    fireEvent.click(await screen.findByText('批量重验'))
    await waitFor(() => expect(deps.startBatchProbeJob).toHaveBeenCalledWith(['b1']))
  })

  it('待办处置动作（三入口同口径）：提交成功即催任务读面；源列表等任务收尾才刷新', async () => {
    const fetchJobStatus = vi.fn(async () => null)
    const deps = settingsDeps({ fetchJobStatus }, [unverifiedSrc, brokenSrc])
    render(createElement(SettingsSection, { deps }))
    renderHook(() => useJobPolling({ fetchJobStatus }))    // 观测面：常驻层同款轮询驱动
    await waitFor(() => expect(fetchJobStatus).toHaveBeenCalledTimes(1))
    fireEvent.click(await screen.findByText('批量重验'))
    await waitFor(() => expect(deps.startBatchProbeJob).toHaveBeenCalledWith(['b1']))
    // 验证起任务 → 读任务：提交成功催读面（jobs.ts 领域动作缺省 refresh → 立刻重拉，不等 1s 拍）
    await waitFor(() => expect(fetchJobStatus).toHaveBeenCalledTimes(2))
    // 不就地重取源列表：源状态要等任务收尾（终态 reload 另有按 job.id 的记账，下方用例钉）
    expect(deps.apiGet.mock.calls.filter((c) => c[0] === 'sources').length).toBe(1)
  })

  it('任务终态 → 源列表刷新按 job.id 只记一次；同一终态轮询再多拍不重复 reload，新一轮终态再刷一次', async () => {
    let current: JobState | null = null
    const fetchJobStatus = vi.fn(async () => current)
    const deps = settingsDeps({ fetchJobStatus })
    const readsOf = (): number => deps.apiGet.mock.calls.filter((c) => c[0] === 'sources').length
    render(createElement(SettingsSection, { deps }))
    renderHook(() => useJobPolling({ fetchJobStatus }))
    await waitFor(() => expect(readsOf()).toBe(1))                    // 挂载 reload
    const doneProbe: JobState = {
      id: 'p1', kind: 'batch-probe', phase: 'done', total: 2, done: 2,
      counts: { ok: 2, failed: 0, dupSkipped: 0, replaced: 0 },
      issues: [], fileErrors: [], startedAt: 0,
    }
    current = doneProbe
    await waitFor(() => expect(readsOf()).toBe(2), { timeout: 4000 }) // 终态落地 → reload 恰一次
    current = { ...doneProbe }                                        // 同 id 终态再来几拍（轮询每拍写新对象）
    await new Promise((r) => setTimeout(r, 2500))
    expect(readsOf()).toBe(2)                                         // 记账不重复
    current = { ...doneProbe, id: 'p2' }                              // 新一轮终态 → 再刷一次
    await waitFor(() => expect(readsOf()).toBe(3), { timeout: 4000 })
  })

  it('导入弹层：默认关闭；「＋ 导入书源」打开（拖放区在场），Esc 收起', async () => {
    const deps = settingsDeps()
    render(createElement(SettingsSection, { deps }))
    await waitFor(() => expect(document.querySelector('[data-novel-source-list]')).not.toBeNull())
    expect(screen.queryByText(/选择或拖入 legado 书源文件/)).toBeNull()   // 弹层默认关（低频任务不常驻）
    fireEvent.click(screen.getByText('＋ 导入书源'))
    expect(screen.getByText(/选择或拖入 legado 书源文件/)).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText(/选择或拖入 legado 书源文件/)).toBeNull())
  })

  it('有任务在跑时「＋ 导入书源」禁用（单任务槽不允许导入）', async () => {
    const running: JobState = {
      id: 'p-run', kind: 'batch-probe', phase: 'running', total: 2, done: 0,
      counts: { ok: 0, failed: 0, dupSkipped: 0, replaced: 0 },
      issues: [], fileErrors: [], startedAt: 0,
    }
    const fetchJobStatus = vi.fn(async () => running)
    const deps = settingsDeps({ fetchJobStatus })
    render(createElement(SettingsSection, { deps }))
    renderHook(() => useJobPolling({ fetchJobStatus }))
    const btn = await screen.findByRole<HTMLButtonElement>('button', { name: '＋ 导入书源' })
    await waitFor(() => expect(btn.disabled).toBe(true))
  })

  it('导入完成态「去验证」：弹层内回调 → startBatchProbeJob(未验证 ids) + 弹层收起（闭环）', async () => {
    const deps = settingsDeps({ lastImportJob: () => doneImportJob })
    render(createElement(SettingsSection, { deps }))
    fireEvent.click(await screen.findByText('＋ 导入书源'))
    fireEvent.click(await screen.findByText(/去验证 1 个未验证源/))
    await waitFor(() => expect(deps.startBatchProbeJob).toHaveBeenCalledWith(['u1']))
    await waitFor(() => expect(screen.queryByText('选择或拖入 legado 书源文件')).toBeNull())
  })

  it('提交导入 → 弹层自动关闭（onSubmitted 口径：任务在服务端继续，结果经待办回流）', async () => {
    const deps = settingsDeps()
    render(createElement(SettingsSection, { deps }))
    fireEvent.click(await screen.findByText('＋ 导入书源'))
    const input = document.querySelector('input[type="file"]')
    expect(input).not.toBeNull()
    const file = new File(['[{"bookSourceName":"A"}]'], 'a.json', { type: 'application/json' })
    fireEvent.change(input as Element, { target: { files: [file] } })
    await waitFor(() => expect(deps.startImportJob).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByText('选择或拖入 legado 书源文件')).toBeNull())
  })

  it('源列表加载失败 → 显式错误；待办箱不渲染（不拿未知当「✓ 全部良好」）', async () => {
    const deps = settingsDeps({ apiGet: vi.fn(async () => { throw new Error('boom') }) })
    render(createElement(SettingsSection, { deps }))
    await waitFor(() => expect(screen.getByText(/源列表加载失败：boom/)).toBeTruthy())
    expect(screen.queryByText('一键验证')).toBeNull()
    expect(screen.queryByText(/全部源状态良好/)).toBeNull()
  })

  it('「去验证」提交失败 → pushError 显式呈现（回调不返回 Promise 就吞掉 rejection）', async () => {
    const deps = settingsDeps({
      lastImportJob: () => doneImportJob,
      startBatchProbeJob: vi.fn(async () => { throw new Error('网络失败') }),
    })
    render(createElement(SettingsSection, { deps }))
    fireEvent.click(await screen.findByText('＋ 导入书源'))
    fireEvent.click(await screen.findByText(/去验证 1 个未验证源/))
    await waitFor(() => expect(deps.pushError).toHaveBeenCalledWith(expect.stringContaining('启动验证失败')))
    expect(String(pick(pick(deps.pushError.mock.calls, 0), 0))).toContain('网络失败')
  })

  it('导入弹层焦点不被壳层重渲染劫持（useJobPolling 1s 轮询 tick → 新 onClose 闭包；mount-scoped 口径）', async () => {
    // 焦点 effect 不得依赖 [onClose]：onClose 是壳层每 render 新造的内联箭头 → 轮询每秒重渲染
    // → effect 重跑 → 焦点每秒被劫回「关闭」钮。挂载作用域化后焦点必须原地不动。
    const deps = settingsDeps()
    const { rerender } = render(createElement(SettingsSection, { deps }))
    fireEvent.click(await screen.findByText('＋ 导入书源'))
    const closeBtn = screen.getByText('关闭')
    expect(document.activeElement).toBe(closeBtn)        // 入场焦点在关闭钮
    const dropzone = document.querySelector('[data-novel-dropzone]') as HTMLElement
    expect(dropzone).not.toBeNull()
    dropzone.focus()                                     // 用户把焦点移进弹层内容
    rerender(createElement(SettingsSection, { deps }))   // 模拟轮询 tick 的壳层重渲染 ×2
    rerender(createElement(SettingsSection, { deps }))
    expect(document.activeElement).toBe(dropzone)        // 回归：重渲染不得把焦点劫回关闭钮
    fireEvent.keyDown(document, { key: 'Escape' })       // Esc 监听不因挂载作用域化丢注册（走 ref 调最新闭包）
    await waitFor(() => expect(screen.queryByText(/选择或拖入 legado 书源文件/)).toBeNull())
  })
})
