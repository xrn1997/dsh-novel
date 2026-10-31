import { describe, expect, it } from 'vitest'
import {
  guardedFilter, guardedMatchAll, guardedOnlyOneReplace, guardedReplace, guardedTest, RegexDeadlineError,
} from '../../src/engine/regex-guard.js'

/** 经典灾难回溯形态：合法、能编译，但对不匹配的长串是指数级 */
const CATASTROPHIC = /^(?:a+)+$/

describe('regex-guard：正常语义与原生一致', () => {
  it('test / 全局 replace / OnlyOne / 整页扫描', () => {
    expect(guardedTest(/b/, 'abc')).toBe(true)
    expect(guardedTest(/^b/, 'abc')).toBe(false)
    expect(guardedReplace(/\s+/g, 'a b', '-')).toBe('a-b')
    // OnlyOne 口径：产物是首个匹配那一段（不是原文只改一处）；无匹配给空串
    expect(guardedOnlyOneReplace(/(a)(b)/, 'xabyab', '$2$1')).toBe('ba')
    expect(guardedOnlyOneReplace(/X/, 'abc', '-')).toBe('')
    // 未参与的 (x)? 组落空串（对面口径），零长度匹配强制前进（不死循环）
    expect(guardedMatchAll(/(\d)(?:_(\d))?/g, 'a1_2 b3')).toEqual([['1_2', '1', '2'], ['3', '3', '']])
    expect(guardedMatchAll(/(?:)/g, 'ab')).toHaveLength(3)
    // 批量过滤：缺属性的条目不命中；命中项原样交回
    const items = [{ v: '/read/12.html' }, { v: '/book/1' }, {}]
    expect(guardedFilter(items, /^\/read\/\d+/, (x) => x.v)).toEqual([items[0]])
  })
})

describe('regex-guard：死线（灾难回溯只许废掉这一条正则）', () => {
  it('test / replace 在死线内抛 RegexDeadlineError，而不是钉住主线程', () => {
    expect(() => guardedTest(CATASTROPHIC, `${'a'.repeat(40)}b`)).toThrow(RegexDeadlineError)
    expect(() => guardedReplace(CATASTROPHIC, `${'a'.repeat(40)}b`, 'x')).toThrow(RegexDeadlineError)
  })
})
