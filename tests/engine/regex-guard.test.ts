import { describe, expect, it } from 'vitest'
import { RegexDeadlineError } from '../../src/engine/errors.js'
import {
  deadlineFor, guardedFilter, guardedMatchAll, guardedOnlyOneReplace, guardedReplace, guardedTest,
  REGEX_DEADLINE_BASE_MS, REGEX_DEADLINE_MAX_MS,
} from '../../src/engine/regex-guard.js'
import { must } from '../support/fixture.js'

/** 经典灾难回溯形态：合法、能编译，但对不匹配的长串是指数级 */
const CATASTROPHIC = /^(?:a+)+$/
const BLOWUP = `${'a'.repeat(40)}b`
const MB = 1024 * 1024

describe('regex-guard：正常语义与原生一致', () => {
  it('test / 全局 replace / OnlyOne / 整页扫描', () => {
    expect(guardedTest(/b/, 'abc')).toBe(true)
    expect(guardedTest(/^b/, 'abc')).toBe(false)
    expect(guardedReplace(/\s+/g, 'a b', '-')).toBe('a-b')
    // OnlyOne 口径：产物是首个匹配那一段（不是原文只改一处）；无匹配给空串
    expect(guardedOnlyOneReplace(/(a)(b)/, 'xabyab', '$2$1')).toBe('ba')
    expect(guardedOnlyOneReplace(/X/, 'abc', '-')).toBe('')
    // 未参与的 (x)? 组落空串，零长度匹配强制前进（不死循环）
    expect(guardedMatchAll(/(\d)(?:_(\d))?/g, 'a1_2 b3')).toEqual([['1_2', '1', '2'], ['3', '3', '']])
    expect(guardedMatchAll(/(?:)/g, 'ab')).toHaveLength(3)
    // 批量过滤：缺属性的条目不命中；命中项原样交回
    const items = [{ v: '/read/12.html' }, { v: '/book/1' }, {}]
    expect(guardedFilter(items, /^\/read\/\d+/, (x) => x.v)).toEqual([items[0]])
  })
  it('matchAll 入口断言：非全局正则当场 TypeError，不许伪装成死线错误（那是另一种病）', () => {
    expect(() => guardedMatchAll(/a/, 'a'), 'exec 不推进游标的正则会打满死线被误诊成灾难性回溯').toThrow(TypeError)
    expect(() => guardedMatchAll(/a/, 'a')).not.toThrow(RegexDeadlineError)
    expect(guardedMatchAll(/a/y, 'a'), '粘滞正则的 exec 推进游标，不进这条断言').toEqual([['a']])
  })
})

describe('regex-guard：死线（灾难回溯只许废掉这一条正则）', () => {
  it('test / replace 在死线内抛 RegexDeadlineError，而不是钉住主线程', () => {
    expect(() => guardedTest(CATASTROPHIC, BLOWUP)).toThrow(RegexDeadlineError)
    expect(() => guardedReplace(CATASTROPHIC, BLOWUP, 'x')).toThrow(RegexDeadlineError)
  })
  it('matchAll / filter 本层也在死线内抛（不靠调用点各自兜着）', () => {
    expect(() => guardedMatchAll(new RegExp(CATASTROPHIC.source, 'g'), BLOWUP)).toThrow(RegexDeadlineError)
    const items = Array.from({ length: 3000 }, (_x, i) => ({ v: `/x/${i}` }))
    items.push({ v: BLOWUP })
    expect(() => guardedFilter(items, CATASTROPHIC, (i) => i.v)).toThrow(RegexDeadlineError)
  })
  it('错误点名正则与实际给的时间预算（读数要能回查是哪条规则、给了多久）', () => {
    let err: RegexDeadlineError | null = null
    try { guardedTest(CATASTROPHIC, BLOWUP) } catch (e) { err = e as RegexDeadlineError }
    expect(err, '病态正则该抛').not.toBeNull()
    expect(err).toBeInstanceOf(RegexDeadlineError)
    expect(must(err, '抛出的 RegexDeadlineError').pattern).toBe(CATASTROPHIC.source)
    expect(must(err, '抛出的 RegexDeadlineError').deadlineMs, '几十字符的规则花的是基础预算，不是封顶值').toBe(REGEX_DEADLINE_BASE_MS)
  })
  it('超时把那把全局正则的 lastIndex 归零：半截状态不许留给下一次', () => {
    const re = /(x)|(?:(a+)+$)/g
    expect(() => guardedMatchAll(re, `x${BLOWUP}`)).toThrow(RegexDeadlineError)
    expect(re.lastIndex, '炸在中间位置：留着它，下一次同正则会从半截起步读出错值').toBe(0)
  })
  it('成功路径不动 lastIndex（原生 test 的推进语义照旧）', () => {
    const re = /a/g
    expect(guardedTest(re, 'ba')).toBe(true)
    expect(re.lastIndex, '守卫不许顺手"修正"原生语义，那是第二种行为').toBe(2)
  })
  it('批量过滤对每个条目独立求值：全局/粘滞正则不跨条目吃 lastIndex，成功路径恢复原值', () => {
    const items = ['/read/0.html', '/read/1.html', '/read/2.html', '/read/3.html', '/read/4.html', '/read/5.html']
      .map((v) => ({ v }))
    const global = /read\/\d+/g
    global.lastIndex = 3
    expect(guardedFilter(items, global, (x) => x.v), '全局 test 的推进不许跨条目吃掉下一条').toEqual(items)
    expect(global.lastIndex, '批量过滤交回后原值不变：它没有替调用方推进游标的契约').toBe(3)
    const sticky = /\/read\/\d+/y
    expect(guardedFilter(items, sticky, (x) => x.v), '粘滞正则逐条从头锚定，与一条一条新建等价').toEqual(items)
  })
  it('批量过滤超时同样归零 lastIndex：半截游标不许留给下一次', () => {
    const re = /(x)|(?:(a+)+$)/g
    re.lastIndex = 7
    expect(() => guardedFilter([{ v: BLOWUP }], re, (i) => i.v)).toThrow(RegexDeadlineError)
    expect(re.lastIndex).toBe(0)
  })
})

describe('regex-guard：死线随工作量放宽（大而合法不许被误判成病态）', () => {
  it('deadlineFor：基础预算 + 每满一 MB 追加一档，封顶', () => {
    expect(deadlineFor(0)).toBe(REGEX_DEADLINE_BASE_MS)
    expect(deadlineFor(MB - 1)).toBe(REGEX_DEADLINE_BASE_MS)
    expect(deadlineFor(MB)).toBe(REGEX_DEADLINE_BASE_MS + 100)
    expect(deadlineFor(2.5 * MB)).toBe(REGEX_DEADLINE_BASE_MS + 200)
    expect(deadlineFor(60 * MB)).toBe(REGEX_DEADLINE_MAX_MS)
  })
  it('几 MB 的正常整页扫描照常跑完（改前是慢但成功，改后不许变成规则错误）', () => {
    // 体积靠段间填充凑到几 MB，而不是靠匹配数：vm 死线是墙钟口径，行数组构造才是耗时大头，
    // 几十万次匹配在共享核 CI 上会挤爆预算——这条钉的是「大体积触发放宽档后不误判」，不是吞吐量。
    const page = ('<p>第 1 条</p>' + '填'.repeat(30)).repeat(60_000)
    expect(page.length, '样本没到两 MB 量级，这条就没测到东西').toBeGreaterThan(2 * MB)
    expect(guardedMatchAll(/<p>第 (\d+) 条<\/p>/g, page)).toHaveLength(60_000)
  })
  it('批量过滤共用放宽后的预算：几千条正常属性不误伤（批大小不是病态信号）', () => {
    const items = Array.from({ length: 5_000 }, (_x, i) => ({ v: `/read/${i}.html` }))
    expect(guardedFilter(items, /^\/read\/\d+/, (i) => i.v)).toHaveLength(5_000)
  })
  it('大批量里混进一条病态值：照样在死线内抛，预算放宽不等于放弃守卫', () => {
    const items = Array.from({ length: 2_000 }, (_x, i) => ({ v: `/read/${i}` }))
    items.push({ v: BLOWUP })
    expect(() => guardedFilter(items, /^(?:a+)+$/, (i) => i.v)).toThrow(RegexDeadlineError)
  })
})

describe('regex-guard：跨 realm 的返回值如实（消费点不许用 realm 判据）', () => {
  it('matchAll / filter 的数组在 vm realm 里构造：Array.isArray 成立，instanceof 不成立', () => {
    const rows = guardedMatchAll(/(\d)/g, 'a1b2')
    expect(Array.isArray(rows)).toBe(true)
    expect(rows).not.toBeInstanceOf(Array)
    expect(rows[0]).not.toBeInstanceOf(Array)
    expect(rows).toEqual([['1', '1'], ['2', '2']])
  })
  it('filter 交回的是宿主原物：按对象同一性可辨', () => {
    const items = [{ v: '/read/1' }, { v: '/book/2' }]
    const kept = guardedFilter(items, /^\/read\//, (i) => i.v)
    expect(kept).toHaveLength(1)
    expect(kept[0]).toBe(items[0])
  })
  it('属性值在宿主侧取齐：attrOf 里再走一次守卫求值也不串（守卫窗口内没有宿主回调）', () => {
    const items = [{ v: '/read/1' }, { v: '/book/2' }]
    const kept = guardedFilter(items, /^\/read\//, (i) => (guardedTest(/\/\d+$/, i.v) ? i.v : undefined))
    expect(kept).toEqual([items[0]])
  })
})
