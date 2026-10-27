import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SearchHit } from '../shared/wire.js'
import { markPanelShelfLanded, panelShelf } from './panel-shelf.js'
import { addAllReceipt, isSeatLanded } from './search-view-model.js'
import type { AddAllReceipt, RowRef } from './search-view-model.js'
import type { ShelfAddOutcome, ShelfSeatInput } from './shelf-action.js'
import { useStore } from './store.js'

/**
 * 搜索结果页的**落架现场**：面板期里哪些架位已经落过、哪一本的「都加架」还在途，
 * 以及逐条 / 整本两条加架入口的排队。写口仍是 `shelf-action.addShelfSeat`（幂等 PUT，由视图
 * 以 `addSeat` 注入），架位算式仍是 `search-view-model` 的四条纯函数；本 module 只持在途排队，
 * 落架账住 `panel-shelf`，回执选哪条通道、说什么话仍归视图——措辞是界面的事，不是落架的事实。
 *
 * 落架账住在 `panel-shelf`（面板期投影，为什么不再放组件 state 见 `docs/adr/0046`）：逐源行
 * 随展开区收起而整块离开 DOM，切去阅读器再回来组件 state 也会被卸载洗掉；账与书架读取面同住
 * 一份投影后，「都加架」与「＋ 加书架」仍读同一份，重挂载后也不会重新写「＋ 加书架」。
 * 真相仍在服务端：投影里的账是「这一发 PUT 我们发成功过」，幂等写口兜住其余。
 */
export interface SearchLanding {
  /** 面板期里落过架的架位（凭地址认，口径住 `services/shelf.ts` 的 `Shelf`） */
  landed: ReadonlySet<string>
  /** 「都加架」在途的书行键（按书）。为何不是全局布尔：按钮一行一个，全局态会把没点过的
   *  行一起禁用、标签也跟着写错。 */
  adding: ReadonlySet<string>
  /** 行上入架态；无地址的行永远未落（架位口径同上） */
  isLanded(hit: SearchHit): boolean
  /** 加一条：成功才记账，成败都从返回值给，绝不抛 */
  add(row: RowRef): Promise<ShelfAddOutcome>
  /** 一本的「都加架」：只发有地址且本轮未落架的行，逐行一发幂等 PUT，最后给三笔回执账 */
  addAll(bookKey: string, rows: RowRef[]): Promise<AddAllReceipt>
}

/** 命中行 → 加架输入：只并进架位身份（源 + 地址），书目字段整条命中照交。
 *  为什么不再逐字段挑：字段集归 `SHELF_META` 单表，`bodies.shelfAdd` 走 `pickShelfMeta` 把表外键
 *  整键丢弃——在这里再列一遍就是字段集的第二份抄本，新字段会「表里有、这个入口里没有」。
 *  无地址给 null：这样的行在界面上本就没有动作（渲染成死行），替它造一发空架位 PUT
 *  就是写进一条没有书面的架位。 */
function seatInputOf(row: RowRef): ShelfSeatInput | null {
  const url = row.hit.url
  return url === null ? null : { ...row.hit, sourceId: row.sourceId, url }
}

export function useSearchLanding(deps: {
  addSeat: (input: ShelfSeatInput) => Promise<ShelfAddOutcome>
}): SearchLanding {
  /** 写口存 ref：视图传的是内联闭包（每次渲染都是新函数），直接进依赖会让 `add` / `addAll`
   *  每次渲染换身份，行手里的事件句柄还没用就过期。effect 更新保证读到最新的那一份。 */
  const addSeat = useRef(deps.addSeat)
  useEffect(() => { addSeat.current = deps.addSeat }, [deps.addSeat])

  const [adding, setAdding] = useState<ReadonlySet<string>>(() => new Set())
  const { landed } = useStore(panelShelf)

  const add = useCallback(async (row: RowRef): Promise<ShelfAddOutcome> => {
    const input = seatInputOf(row)
    // 无地址是界面产不出来的形状（死行不给动作、`addAll` 先滤掉）：这里把类型收口成失败，
    // 不抛也不发空架位 PUT。
    if (input === null) return { ok: false, error: null }
    const outcome = await addSeat.current(input)
    if (outcome.ok) markPanelShelfLanded([input.url])
    return outcome
  }, [])

  const addAll = useCallback(async (bookKey: string, rows: RowRef[]): Promise<AddAllReceipt> => {
    const addable = rows.filter((r) => r.hit.url !== null)
    // 已落过架的行不再发（多半是用户先单加过一条）：把同一件事写成两次，回执也会重复报账。
    // `landed` 的快照取在 await 之前：`stillMissing` 数的是「点下去那一刻还缺的」减去这次落成的。
    const todo = addable.filter((r) => !isSeatLanded(landed, r.hit))
    setAdding((prev) => new Set(prev).add(bookKey))
    try {
      const outcomes = await Promise.all(todo.map((r) => add(r)))
      // 成功的那几条已由 `add` 自己记账（逐条与整本共用同一条落架路径），这里只算回执。
      return addAllReceipt({ rows, landed, todo, outcomes })
    } finally {
      // 在途读数只属于这一次点击：成、败、异常都退场，按钮不许卡在「加架中…」。
      setAdding((prev) => {
        if (!prev.has(bookKey)) return prev
        const next = new Set(prev)
        next.delete(bookKey)
        return next
      })
    }
  }, [add, landed])

  const isLanded = useCallback((hit: SearchHit): boolean => isSeatLanded(landed, hit), [landed])

  return useMemo(() => ({ landed, adding, isLanded, add, addAll }), [landed, adding, isLanded, add, addAll])
}
