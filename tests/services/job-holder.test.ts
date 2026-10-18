import { describe, expect, it, vi } from 'vitest'
import { ChangeSignal, HostTie } from '../../src/services/job-holder.js'
import type { JobHost, JobHostSpec } from '../../src/services/job-holder.js'

/** 记下 spec 的假宿主：本模块对宿主的契约只有「start 里同步取 hooks」这一条，测试就钉这一条 */
type HostHooks = ReturnType<JobHostSpec['run']>
function fakeHost(): { host: JobHost; specs: JobHostSpec[]; hooks: HostHooks[] } {
  const specs: JobHostSpec[] = []
  const hooks: HostHooks[] = []
  return {
    specs, hooks,
    host: {
      start(spec): string {
        specs.push(spec)
        hooks.push(spec.run())            // 宿主契约：start() 内同步调 run()
        return `novel-${specs.length}`
      },
    },
  }
}

describe('HostTie（任务与宿主登记之间的挂点）', () => {
  it('没有宿主即没有挂点：任务照跑，不登记也不建缓冲消费者', () => {
    expect(HostTie.open(undefined, { kind: 'novel-search', label: 'x' })).toBeNull()
  })

  it('登记一次：kind / label / 自报帽原样交给宿主', () => {
    const f = fakeHost()
    const tie = HostTie.open(f.host, { kind: 'novel-explore', label: '书城分类「玄幻」第 2 页' })
    expect(f.specs).toHaveLength(1)
    expect(f.specs[0].kind).toBe('novel-explore')
    expect(f.specs[0].label).toBe('书城分类「玄幻」第 2 页')
    expect(f.specs[0].outputLimitBytes).toBeGreaterThan(0)
    expect(tie).not.toBeNull()
  })

  it('取消是记账 + 落点：reason 缺席落成「已取消」，onCancel 收到的是同一个串', () => {
    const f = fakeHost()
    const onCancel = vi.fn()
    const tie = HostTie.open(f.host, { kind: 'novel-search', label: 'x', onCancel })!
    expect(tie.requested).toBe(false)
    f.hooks[0].cancel()
    expect(tie.requested).toBe(true)
    expect(tie.reason).toBe('已取消')
    expect(onCancel).toHaveBeenCalledWith('已取消')
    f.hooks[0].cancel('用户点了停止')
    expect(tie.reason).toBe('用户点了停止')
  })

  it('过程行是拉模型：一次 readOutput 交出「上次读之后」的全部行，再读即空', () => {
    const f = fakeHost()
    const tie = HostTie.open(f.host, { kind: 'novel-probe', label: 'x' })!
    tie.note('甲：verified')
    tie.note('乙：broken（Timeout）')
    const first = f.hooks[0].readOutput!()
    expect(first).toContain('甲：verified')
    expect(first).toContain('乙：broken')
    expect(f.hooks[0].readOutput!()).toBe('')          // 消费式：不给第二个读者重放
  })

  it('settle 就是宿主等的那枚 done：结算一次即落终态，词汇表由宿主说了算', async () => {
    const f = fakeHost()
    const tie = HostTie.open(f.host, { kind: 'novel-import', label: 'x' })!
    const done = f.hooks[0].done
    tie.settle({ status: 'completed' })
    await expect(done).resolves.toEqual({ status: 'completed' })
  })

  it('传入的尾缓冲即复用同一份（分类轮次「一轮一份」政策的落点）', () => {
    const f = fakeHost()
    const a = HostTie.open(f.host, { kind: 'novel-explore', label: '第 1 页' })!
    const b = HostTie.open(f.host, { kind: 'novel-explore', label: '第 2 页', tail: a.tail })!
    b.note('第二页的行')
    expect(f.hooks[0].readOutput!()).toContain('第二页的行')   // 早那批的消费者读得到
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
