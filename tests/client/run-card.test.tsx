// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { focusRunCard } from '../../src/client/run-card.js'
import { RunCard } from '../../src/client/views/bits.js'
import { NOVEL_CSS } from '../../src/client/styles.js'
import { ProbeRunCard } from '../../src/client/views/SettingsSourceList.js'
import { ImportRunCard } from '../../src/client/views/SettingsImportPane.js'
import type { JobState } from '../../src/client/views/types.js'

/**
 * 运行卡双胞胎抽共：ProbeRunCard（SettingsSourceList）与 ImportRunCard（SettingsImportPane）
 * 共用外框浮层、progress bar、counts 尾行、「可以关掉页面，任务在服务端继续」文案，差异仅在
 * label/meta 文案与 dupSkipped 行。改公共外壳先跑本文件：它钉死两卡的公共部分与各自差异
 * （含 total=0 防除零与内联 hex 归零）。
 */

const job = (over: Partial<JobState> = {}): JobState => ({
  id: 'j1', kind: 'batch-probe', phase: 'running', total: 10, done: 4,
  counts: { ok: 3, failed: 1, dupSkipped: 2, replaced: 0 },
  issues: [], fileErrors: [], startedAt: 0,
  ...over,
})

afterEach(cleanup)

describe('RunCard 公共外壳（抽共）', () => {
  it('ProbeRunCard：进度段 + counts 尾行 + 「可关页面」文案原样保留', () => {
    render(<ProbeRunCard job={job()} />)
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('40')
    expect(screen.getByText('验证中…')).toBeTruthy()
    expect(screen.getByText('已验证 3')).toBeTruthy()
    expect(screen.getByText('· 未通过 1')).toBeTruthy()
    expect(screen.getByText('可以关掉页面，任务在服务端继续')).toBeTruthy()
  })

  it('total=0 防除零：pct 归 0（不是 NaN）', () => {
    render(<ProbeRunCard job={job({ total: 0, done: 0 })} />)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0')
  })

  it('ImportRunCard：已新增 + dupSkipped/failed 条件行渲染', () => {
    render(<ImportRunCard job={job({ kind: 'import', counts: { ok: 5, failed: 2, dupSkipped: 1, replaced: 0 } })} />)
    expect(screen.getByText('导入中…')).toBeTruthy()
    expect(screen.getByText('已新增 5')).toBeTruthy()
    expect(screen.getByText('· 重复跳过 1')).toBeTruthy()
    expect(screen.getByText('· 失败 2')).toBeTruthy()
  })

  it('ImportRunCard：零 dupSkipped/failed 不渲染对应行（原条件语义不丢）', () => {
    render(<ImportRunCard job={job({ kind: 'import', counts: { ok: 5, failed: 0, dupSkipped: 0, replaced: 0 } })} />)
    expect(screen.queryByText(/重复跳过/)).toBeNull()
    expect(screen.queryByText(/失败/)).toBeNull()
  })

  it('外壳零内联 brand hex：底/描边由 --novel-brand-soft / --novel-brand-line 派生（住在样式层，行内一个 style 都不留）', () => {
    const { container } = render(<ProbeRunCard job={job()} />)
    const card = container.querySelector('[data-novel-run-card]')
    expect(card).not.toBeNull()
    expect(card?.getAttribute('style'), '行内 style 是 token 漂移的入口').toBeNull()
    expect(card?.className).toContain('novel-run-card')
    // 真不变量在样式层：这两处必须是 brand 派生 token，而不是任何字面量
    const rule = NOVEL_CSS.slice(NOVEL_CSS.indexOf('.novel-group.novel-run-card'))
    expect(rule.slice(0, rule.indexOf('}'))).toContain('var(--novel-brand-soft)')
    expect(rule.slice(0, rule.indexOf('}'))).toContain('var(--novel-brand-line)')
  })

  it('RunCard 本体是插槽件：label / meta / counts 按传入渲染', () => {
    render(<RunCard kind="probe" label="自定义中…" meta="meta 文案" pct={30} counts={<span>counts 文案</span>} />)
    expect(screen.getByText('自定义中…')).toBeTruthy()
    expect(screen.getByText('meta 文案')).toBeTruthy()
    expect(screen.getByText('counts 文案')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('30')
  })
})

/**
 * 任务去现场的第三跳：状态层点任务泳道后，`SettingsSection` 要在卡片挂载之后把它带进视野。
 * 卡片挂载即登记，消费方只调 `focusRunCard`；不许退回按属性选择器现查。
 * jsdom 没有排版引擎，滚动调用本身用替身量。
 * 现场按任务种类分桶：导入卡与验证卡可以同时在树上（缓存回执 + 在跑任务），
 * 去现场与卸载都必须只作用自己那一种——按「最后登记者」取卡的写法会滚错卡。
 */
describe('focusRunCard：运行卡现场注册表（按任务种类分桶）', () => {
  const cardOf = (container: HTMLElement): HTMLElement => {
    const card = container.querySelector('[data-novel-run-card]')
    expect(card, 'RunCard 的根节点是现场登记点').not.toBeNull()
    return card as HTMLElement
  }

  it('滚的是已挂载卡片的根节点，居中落位', () => {
    const { container } = render(<RunCard kind="probe" label="验证中…" meta="4/10" pct={40} counts={null} />)
    const card = cardOf(container)
    const into = vi.fn()
    card.scrollIntoView = into
    focusRunCard('probe')
    expect(into).toHaveBeenCalledTimes(1)
    expect(into.mock.instances[0], '滚动落点必须是卡片根节点').toBe(card)
    expect(into).toHaveBeenCalledWith({ block: 'center' })
  })

  it('卸载即清空登记：再调用返回 false 且不碰旧节点', () => {
    const view = render(<RunCard kind="probe" label="验证中…" meta="4/10" pct={40} counts={null} />)
    const card = cardOf(view.container)
    const into = vi.fn()
    card.scrollIntoView = into
    view.unmount()
    expect(focusRunCard('probe')).toBe(false)
    expect(into).not.toHaveBeenCalled()
  })

  it('重新挂载的卡片接管现场：去现场跟着最后一棵渲染树', () => {
    const first = render(<RunCard kind="probe" label="验证中…" meta="4/10" pct={40} counts={null} />)
    const oldCard = cardOf(first.container)
    const oldInto = vi.fn()
    oldCard.scrollIntoView = oldInto
    first.unmount()
    const second = render(<RunCard kind="probe" label="验证中…" meta="6/10" pct={60} counts={null} />)
    const newCard = cardOf(second.container)
    const newInto = vi.fn()
    newCard.scrollIntoView = newInto
    focusRunCard('probe')
    expect(oldInto).not.toHaveBeenCalled()
    expect(newInto).toHaveBeenCalledWith({ block: 'center' })
  })

  it('导入卡与验证卡同时在场：去现场各滚各的，卸载只清自己那一种', () => {
    // 真实现场：验证任务在跑时打开导入弹层，导入卡（可能来自 getLastImportJob 缓存）后登记。
    // 旧「最后登记者赢」在这棵树上会让 focusRunCard('probe') 滚到导入卡。
    const probeView = render(<ProbeRunCard job={job()} />)
    const importView = render(<ImportRunCard job={job({ kind: 'import', counts: { ok: 5, failed: 0, dupSkipped: 0, replaced: 0 } })} />)
    const probeCard = cardOf(probeView.container)
    const importCard = cardOf(importView.container)
    const probeInto = vi.fn()
    const importInto = vi.fn()
    probeCard.scrollIntoView = probeInto
    importCard.scrollIntoView = importInto

    focusRunCard('probe')
    expect(probeInto.mock.instances[0], '看验证卡的意图必须落在验证卡上').toBe(probeCard)
    expect(importInto).not.toHaveBeenCalled()

    focusRunCard('import')
    expect(importInto.mock.instances[0], '看导入卡的意图必须落在导入卡上').toBe(importCard)
    expect(probeInto).toHaveBeenCalledTimes(1)

    importView.unmount()
    expect(() => focusRunCard('import')).not.toThrow()
    expect(importInto).toHaveBeenCalledTimes(1)
    focusRunCard('probe')
    expect(probeInto, '卸载导入卡不许清掉验证卡的登记').toHaveBeenCalledTimes(2)
  })
})
