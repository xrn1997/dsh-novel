/**
 * `EngineValue` 变体的收窄取口（引擎用例共用）。
 *
 * 引擎值是一个判别联合（`miss` / `value` / `list` / `nodes` / `matches`），而
 * `expect(v.kind).toBe('nodes')` 不会让编译器跟着收窄——于是旧写法满篇
 * `(v as any).nodes`。这里把「断言形状 + 取出该支的值」收成一处：形状不符即抛，
 * 与 `tests/support/fixture.ts` 的越界抛错同口径（夹具与断言脱节时要的是「哪一支
 * 不对」，不是深处冒出来的 TypeError）。
 *
 * 只做收窄，不改变任何被断言的值：`nodesOf(v)` 在 `v.kind === 'nodes'` 时就是 `v.nodes`。
 */
import type { Cheerio } from 'cheerio'
import { isTag } from 'domhandler'
import type { AnyNode, Element } from 'domhandler'
import type { EngineValue } from '../../src/engine/types.js'

function variant<K extends EngineValue['kind']>(v: EngineValue, kind: K): Extract<EngineValue, { kind: K }> {
  if (v.kind !== kind) throw new Error(`期望 ${kind}，实际 ${v.kind}`)
  // 上一行已把判别键钉死；这里只让编译器跟上这条判定。
  return v as Extract<EngineValue, { kind: K }>
}

export const nodesOf = (v: EngineValue): Cheerio<AnyNode> => variant(v, 'nodes').nodes
export const itemsOf = (v: EngineValue): string[] => variant(v, 'list').items
export const detailOf = (v: EngineValue): string => variant(v, 'miss').detail
export const valueTextOf = (v: EngineValue): string => variant(v, 'value').text
export const rowsOf = (v: EngineValue): string[][] => variant(v, 'matches').rows

/** `v.text ?? v.items` 的收窄写法：value → text，list → items，其余变体 undefined（不抛） */
export const textOrItemsOf = (v: EngineValue): string | string[] | undefined =>
  v.kind === 'value' ? v.text : v.kind === 'list' ? v.items : undefined

/** 节点集里的元素（非标签节点即夹具/断言脱节） */
export function elementOf(n: AnyNode): Element {
  if (!isTag(n)) throw new Error('期望元素节点，实际非标签节点')
  return n
}
