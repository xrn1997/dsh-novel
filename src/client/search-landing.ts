import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SearchHit } from '../shared/wire.js'
import { markPanelShelfLanded, panelShelf } from './panel-shelf.js'
import { addAllReceipt, isSeatLanded } from './search-view-model.js'
import type { AddAllReceipt, RowRef } from './search-view-model.js'
import type { ShelfAddOutcome, ShelfSeatInput } from './shelf-action.js'
import { useStore } from './store.js'

/**
 * 搜索结果页的**落架现场**：面板期里哪些架位已经落过、哪一本的「都加架」还在途，以及两条加架入口
 * 的排队。写口仍是 `shelf-action.addShelfSeat`，架位算式仍是 `search-view-model` 的四条纯函数；
 * 本 module 只持在途排队，落架账住 `panel-shelf`，回执措辞仍归视图。
 *
 * 落架账住 `panel-shelf`（面板期投影，`ADR-0046`）：逐源行会随折叠卸载，账与书架读取面同住一份
 * 投影后，「都加架」与「＋ 加书架」仍读同一份。真相仍在服务端：账是「这一发 PUT 我们发成功过」。
 */
export interface SearchLanding {
  /** 面板期里落过架的架位（凭地址认，口径住 `services/shelf.ts` 的 `Shelf`） */
  landed: ReadonlySet<string>
  /** 「都加架」在途的书行键（按书）：按钮一行一个，全局态会把没点过的行一起禁用。 */
  adding: ReadonlySet<string>
  /** 行上入架态；无地址的行永远未落（架位口径同上） */
  isLanded(hit: SearchHit): boolean
  /** 加一条：成功才记账，成败都从返回值给，绝不抛 */
  add(row: RowRef): Promise<ShelfAddOutcome>
  /** 一本的「都加架」：只发有地址且本轮未落架的行，逐行一发幂等 PUT，最后给三笔回执账 */
  addAll(bookKey: string, rows: RowRef[]): Promise<AddAllReceipt>
}

/** 命中行 → 加架输入：只并进架位身份（源 + 地址），书目字段整条命中照交——字段集归 `SHELF_META`
 *  单表，在这里再列一遍就是第二份抄本。无地址给 null：这样的行本就没有动作。 */
function seatInputOf(row: RowRef): ShelfSeatInput | null {
  const url = row.hit.url
  return url === null ? null : { ...row.hit, sourceId: row.sourceId, url }
}

export function useSearchLanding(deps: {
  addSeat: (input: ShelfSeatInput) => Promise<ShelfAddOutcome>
}): SearchLanding {
  /** 写口存 ref：视图传的是内联闭包，直接进依赖会让 `add` / `addAll` 每次渲染换身份。 */
  const addSeat = useRef(deps.addSeat)
  useEffect(() => { addSeat.current = deps.addSeat }, [deps.addSeat])

  const [adding, setAdding] = useState<ReadonlySet<string>>(() => new Set())
  const { landed } = useStore(panelShelf)

  const add = useCallback(async (row: RowRef): Promise<ShelfAddOutcome> => {
    const input = seatInputOf(row)
    // 无地址是界面产不出来的形状（死行不给动作、`addAll` 先滤掉）：这里收口成失败，不抛也不发空 PUT。
    if (input === null) return { ok: false, error: null }
    const outcome = await addSeat.current(input)
    if (outcome.ok) markPanelShelfLanded([input.url])
    return outcome
  }, [])

  const addAll = useCallback(async (bookKey: string, rows: RowRef[]): Promise<AddAllReceipt> => {
    const addable = rows.filter((r) => r.hit.url !== null)
    // 已落过架的行不再发；`landed` 快照取在 await 之前：`stillMissing` 数的是点下去那一刻还缺的。
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
