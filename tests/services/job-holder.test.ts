import { describe, expect, it, vi } from 'vitest'
import { ChangeSignal, HostTie } from '../../src/services/job-holder.js'
import { must } from '../support/fixture.js'
import { jobHostDouble } from '../support/job-host.js'

/** 假宿主按活契约来：`start` 里同步 `run(job)`，输出由宿主持游标从 `spec.output` 拉
 *  （见 `tests/support/job-host.ts` 的头注——假体与实现一起按错契约写，测试就永远绿）。 */

describe('HostTie（任务与宿主登记之间的挂点）', () => {
  it('没有宿主即没有挂点：任务照跑，不登记也不建缓冲消费者', () => {
    expect(HostTie.open(undefined, { kind: 'novel-search', label: 'x' })).toBeNull()
  })

  it('登记一次：kind / label / 自报帽 / 输出拉源原样交给宿主', () => {
    const h = jobHostDouble()
    const tie = HostTie.open(h.host, { kind: 'novel-explore', label: '书城分类「玄幻」第 2 页' })
    expect(tie).not.toBeNull()
    const { spec } = h.last()
    expect(spec.kind).toBe('novel-explore')
    expect(spec.label).toBe('书城分类「玄幻」第 2 页')
    expect(spec.outputLimitBytes).toBeGreaterThan(0)
    // 输出面必须是**拉源**：宿主从不读 hooks 上的方法（旧镜像的 readOutput 就是死在这里）
    expect(spec.output).toHaveLength(1)
    expect(typeof spec.output?.[0]?.read).toBe('function')
    expect(must(h.last().hooks, 'hooks').done).toBeInstanceOf(Promise)
  })

  it('取消是记账 + 落点：reason 缺席落成「已取消」，onCancel 收到的是同一个串', () => {
    const h = jobHostDouble()
    const onCancel = vi.fn()
    const tie = must(HostTie.open(h.host, { kind: 'novel-search', label: 'x', onCancel }), 'HostTie.open(h.host, { kind: \'novel-se…')
    expect(tie.requested).toBe(false)
    must(h.last().hooks, 'hooks').cancel()
    expect(tie.requested).toBe(true)
    expect(tie.reason).toBe('已取消')
    expect(onCancel).toHaveBeenCalledWith('已取消')
    must(h.last().hooks, 'hooks').cancel('用户点了停止')
    expect(tie.reason).toBe('用户点了停止')
  })

  it('过程行走偏移拉源：按 nextOffset 取增量，同一个游标不重复交付', () => {
    const h = jobHostDouble()
    const tie = must(HostTie.open(h.host, { kind: 'novel-probe', label: 'x' }), 'HostTie.open(h.host, { kind: \'novel-pr…')
    tie.note('甲：verified')
    tie.note('乙：broken（Timeout）')
    const capture = h.last()
    const first = capture.read()
    expect(first).toContain('甲：verified')
    expect(first).toContain('乙：broken')
    expect(capture.read()).toBe('')                     // 游标已推进：只给增量
    expect(capture.readFrom(0).text).toContain('甲：verified')   // 另一个读者按绝对偏移读，仍看得到
  })

  it('settle 就是宿主等的那枚 done：结算一次即落终态，词汇表由宿主说了算', async () => {
    const h = jobHostDouble()
    const tie = must(HostTie.open(h.host, { kind: 'novel-import', label: 'x' }), 'HostTie.open(h.host, { kind: \'novel-im…')
    const done = must(h.last().hooks, 'hooks').done
    tie.settle({ status: 'completed' })
    await expect(done).resolves.toEqual({ status: 'completed' })
  })

  it('传入的尾缓冲即复用同一份（分类轮次「一轮一份」政策的落点）', () => {
    const h = jobHostDouble()
    const a = must(HostTie.open(h.host, { kind: 'novel-explore', label: '第 1 页' }), 'HostTie.open(h.host, { kind: \'novel-ex…')
    const b = must(HostTie.open(h.host, { kind: 'novel-explore', label: '第 2 页', tail: a.tail }), 'HostTie.open(h.host, { kind: \'novel-ex…')
    b.note('第二页的行')
    const first = must(h.captures[0], '第一页的登记')
    expect(first.read()).toContain('第二页的行')         // 早那批的读者按自己的游标读到共享缓冲里的新行
  })
})

describe('ChangeSignal（只发信号不发数据）', () => {
  it('退订口生效：退订后不再收信号，重复退订不炸', () => {
    const s = new ChangeSignal()
    const a = vi.fn()
    const off = s.subscribe(a)
    s.notify()
    off()
    off()
    s.notify()
    expect(a).toHaveBeenCalledTimes(1)
  })

  it('回调里退订别人，本轮其余订阅者不漏发（notify 先把监听者快照成数组）', () => {
    const s = new ChangeSignal()
    const order: string[] = []
    const offB = s.subscribe(() => { order.push('b'); offC() })
    const offC = s.subscribe(() => { order.push('c') })
    s.notify()
    expect(order).toEqual(['b', 'c'])                 // b 跑的时候退掉了 c，本轮 c 照旧收到
    s.notify()
    expect(order).toEqual(['b', 'c', 'b'])            // 只剩 b：c 的退订此后生效
    offB()
    s.notify()
    expect(order).toEqual(['b', 'c', 'b'])            // 全部退订后不再有信号
  })

  it('没有订阅者时 notify 就是空操作', () => {
    const s = new ChangeSignal()
    expect(() => s.notify()).not.toThrow()
  })
})
