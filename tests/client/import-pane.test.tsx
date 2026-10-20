// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { CopyProvider, enTranslate } from '../../src/client/copy/index.js'
import { ImportPane } from '../../src/client/views/SettingsImportPane.js'
import { makeDeps } from './fake-deps.js'
import type { SettingsDeps } from '../../src/client/deps.js'
import type { JobState } from '../../src/client/views/types.js'

/**
 * 导入区接线测试：ImportPane 有 deps seam 却此前零 jsdom 驱动测试——
 * submitFiles / importPaste / 失败上报全裸奔。本文件经假 deps 把三条路径钉死：
 * 文件直通提交、粘贴小道提交、任务失败的 pushError 上报（不许静默吞掉）。
 * 桩工厂统一到 tests/client/fake-deps.ts。
 */

const pane = (deps: SettingsDeps, over: Partial<{ job: JobState | null; refresh: () => void }> = {}): ReactNode => (
  <ImportPane
    job={over.job ?? null}
    refresh={over.refresh ?? (() => {})}
    unverifiedCount={0}
    onVerifyUnverified={() => {}}
    deps={deps}
  />
)

/** 隐藏 file input——无 testid，按选择器取并兜底断言 */
function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')
  if (input === null) throw new Error('找不到隐藏的 file input')
  return input
}

const runningImport: JobState = {
  id: 'imp1', kind: 'import', phase: 'running', total: 10, done: 4,
  counts: { ok: 3, failed: 1, dupSkipped: 1, replaced: 0 },
  issues: [], fileErrors: [], startedAt: 0,
}

afterEach(cleanup)

describe('ImportPane 接线（deps seam 驱动）', () => {
  it('文件导入：隐藏 input 选中文件 → startImportJob 拿到 [{name,text}] 并立即 refresh', async () => {
    const deps = makeDeps()
    const refresh = vi.fn()
    const { container } = render(pane(deps, { refresh }))
    const input = fileInput(container)

    const file = new File(['[{"bookSourceName":"A"}]'], 'a.json', { type: 'application/json' })
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(deps.startImportJob).toHaveBeenCalledTimes(1))
    expect(deps.startImportJob).toHaveBeenCalledWith([{ name: 'a.json', text: '[{"bookSourceName":"A"}]' }])
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))   // 提交成功立即拉一轮状态，不等下个 1s
    expect(deps.pushError).not.toHaveBeenCalled()
  })

  it('文件导入失败：pushError 上报「导入提交失败」——不许静默吞掉', async () => {
    const deps = makeDeps({ startImportJob: vi.fn(async () => { throw new Error('boom') }) })
    const { container } = render(pane(deps))
    const file = new File(['x'], 'a.json')
    fireEvent.change(fileInput(container), { target: { files: [file] } })

    await waitFor(() => expect(deps.pushError).toHaveBeenCalledTimes(1))
    expect(String(deps.pushError.mock.calls[0][0])).toContain('导入提交失败')
    expect(String(deps.pushError.mock.calls[0][0])).toContain('boom')
  })

  it('粘贴小道：格式预检通过后按钮放行 → startImportJob 收「粘贴内容」单条任务', async () => {
    const deps = makeDeps()
    const refresh = vi.fn()
    render(pane(deps, { refresh }))
    const textarea = screen.getByPlaceholderText('粘贴 legado 书源 JSON（对象或数组）')
    fireEvent.change(textarea, { target: { value: '[{"bookSourceName":"A","bookSourceUrl":"https://a.com","ruleContent":"x"}]' } })

    // 预检有 300ms 防抖——等校验条出现、校验通过后按钮才放行
    const btn = await screen.findByText('导入粘贴内容', {}, { timeout: 2000 })
    await waitFor(() => expect(btn.getAttribute('disabled')).toBeNull())
    fireEvent.click(btn)
    await waitFor(() => expect(deps.startImportJob).toHaveBeenCalledTimes(1))
    expect(deps.startImportJob).toHaveBeenCalledWith([{ name: '粘贴内容', text: '[{"bookSourceName":"A","bookSourceUrl":"https://a.com","ruleContent":"x"}]' }])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('粘贴内容解析失败：错误条呈现且导入按钮保持禁用（坏输入不放行）', async () => {
    const deps = makeDeps()
    render(pane(deps))
    fireEvent.change(screen.getByPlaceholderText('粘贴 legado 书源 JSON（对象或数组）'), { target: { value: '{bad json' } })
    await screen.findByText(/JSON 解析失败或空数组/, {}, { timeout: 2000 })
    expect(screen.getByText('导入粘贴内容').getAttribute('disabled')).not.toBeNull()
    expect(deps.startImportJob).not.toHaveBeenCalled()
  })

  it('预检坏条目：整句按原样拼出（条数 + 缺字段点名，碎片拼接不丢字符）', async () => {
    // 这句由「条数句 + 逐条点名 + 省略尾」三段拼成；碎片的空格/分隔符一旦多一个少一个，
    // 用户读到的就是两截贴错的句子——整句断言是本用例的全部价值。
    render(pane(makeDeps()))
    fireEvent.change(screen.getByPlaceholderText('粘贴 legado 书源 JSON（对象或数组）'), {
      target: { value: '[{"bookSourceName":"坏源"}]' },
    })
    await screen.findByText(
      '1 条，其中 1 条缺字段（仍可导入，缺的会逐条报）：「坏源」缺 bookSourceUrl/ruleContent',
      {}, { timeout: 2000 })
  })

  it('预检坏条目超过 3 条：省略尾报「还有」的条数，不把总数当追加数', async () => {
    render(pane(makeDeps()))
    fireEvent.change(screen.getByPlaceholderText('粘贴 legado 书源 JSON（对象或数组）'), {
      target: { value: '[{"bookSourceName":"A"},{"bookSourceName":"B"},{"bookSourceName":"C"},{"bookSourceName":"D"}]' },
    })
    await screen.findByText(/等 1 条/, {}, { timeout: 2000 })
  })

  it('import 任务运行中：拖放区替换为运行卡（data-novel-run-card）', () => {
    render(pane(makeDeps(), { job: runningImport }))
    expect(screen.getByText(/导入中/)).toBeTruthy()
    expect(screen.queryByText('选择或拖入 legado 书源文件（.json，可多选）')).toBeNull()
  })

  it('onSubmitted（弹层口径）：提交成功即回调——壳层据此关闭弹层，任务在服务端继续', async () => {
    const deps = makeDeps()
    const onSubmitted = vi.fn()
    const { container } = render(
      <ImportPane job={null} refresh={() => {}} unverifiedCount={0} onVerifyUnverified={() => {}}
        onSubmitted={onSubmitted} deps={deps} />
    )
    const file = new File(['[{"bookSourceName":"A"}]'], 'a.json', { type: 'application/json' })
    fireEvent.change(fileInput(container), { target: { files: [file] } })
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1))
  })

  it('onSubmitted 失败半场不触发：提交失败留在弹层内（pushError 上报，不许关窗装成功）', async () => {
    const deps = makeDeps({ startImportJob: vi.fn(async () => { throw new Error('boom') }) })
    const onSubmitted = vi.fn()
    const { container } = render(
      <ImportPane job={null} refresh={() => {}} unverifiedCount={0} onVerifyUnverified={() => {}}
        onSubmitted={onSubmitted} deps={deps} />
    )
    const file = new File(['x'], 'a.json')
    fireEvent.change(fileInput(container), { target: { files: [file] } })
    await waitFor(() => expect(deps.pushError).toHaveBeenCalledTimes(1))
    expect(onSubmitted).not.toHaveBeenCalled()
  })

  it('完成回执的「查看明细」：issue 与坏文件逐条点名（jobIssueLabel 的渲染接线）', () => {
    // 本文件的既有用例都走 `issues: []`，明细区的渲染接线一直没被断言；这条补上。
    const done: JobState = {
      id: 'imp2', kind: 'import', phase: 'done', total: 2, done: 2,
      counts: { ok: 1, failed: 1, dupSkipped: 0, replaced: 0 },
      issues: [{ kind: 'failed', name: '源甲', detail: '缺少 ruleSearch' }],
      fileErrors: [{ file: 'bad.json', error: '不是 JSON' }],
      startedAt: 0,
    }
    render(pane(makeDeps({ lastImportJob: () => done })))
    fireEvent.click(screen.getByText('查看明细'))
    expect(screen.getByText('失败 源甲')).toBeTruthy()
    expect(screen.getByText('bad.json：不是 JSON')).toBeTruthy()
  })
})

describe('英文渲染：导入区', () => {
  it('导入标题与粘贴入口走 en 字典', () => {
    render(<CopyProvider value={enTranslate}>{pane(makeDeps())}</CopyProvider>)
    // 弹层标题住壳层 Dialog（这棵子树只渲面板），面板以分组名承载同一句；
    // 「粘贴内容」是粘贴道的分组名（也是提交任务时那条记录的名字），不另造可见文案。
    expect(screen.getByLabelText('Import sources')).toBeTruthy()
    expect(screen.getByLabelText('Paste content')).toBeTruthy()
    expect(screen.getByText('Choose or drop legado source files (.json, multiple allowed)')).toBeTruthy()
    expect(screen.getByText('Import', { selector: 'button' })).toBeTruthy()
  })

  it('预检坏条目：英文整句的单位、冒号与分隔符都按 en 字典拼', async () => {
    render(<CopyProvider value={enTranslate}>{pane(makeDeps())}</CopyProvider>)
    fireEvent.change(screen.getByPlaceholderText('Paste legado source JSON (object or array)'), {
      target: { value: '[{"bookSourceName":"Bad"}]' },
    })
    await screen.findByText(
      '1 entry, 1 with missing fields (still importable; missing fields are reported one by one): “Bad” is missing bookSourceUrl/ruleContent',
      {}, { timeout: 2000 })
  })

  it('预检坏条目超过 3 条：英文省略尾只说「还有」的条数', async () => {
    render(<CopyProvider value={enTranslate}>{pane(makeDeps())}</CopyProvider>)
    fireEvent.change(screen.getByPlaceholderText('Paste legado source JSON (object or array)'), {
      target: { value: '[{"bookSourceName":"A"},{"bookSourceName":"B"},{"bookSourceName":"C"},{"bookSourceName":"D"}]' },
    })
    await screen.findByText(/and 1 more entry/, {}, { timeout: 2000 })
  })
})
