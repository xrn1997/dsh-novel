import { bodies, paramOps } from '../shared/wire.js'
import type { ShelfMetaPatch } from '../shared/wire.js'
import type { RowActionDeps } from './deps.js'

/**
 * 加架动作的唯一实现：搜索页、书籍详情浮层、阅读器三处原先各抄一份
 * 「PUT `paramOps.shelfPut` + `bodies.shelfAdd`」——三份抄本一旦漂移，同一个架位就会
 * 长出两种 patch 语义。路径与 body 仍归 wire 单点，这里只把「成功/失败两种结局」收成一个
 * **不抛**的返回值：行内动作要的不是 rejection，而是「这一发到底落没落架」。
 *
 * `url` 就是架位身份（bookKey）：入参把它与书目元数据一起收，调用方不必在视图里另拼键；
 * 元数据字段集不在这份类型里重复列——`SHELF_META` 仍是唯一主人，这里的交集只声明「必须有
 * sourceId / title / 地址」这三格。
 *
 * `ok:false` 带原始错误而不是文案：视图各有各的回执通道与措辞（`deps.pushError` /
 * 浮层内联错误），把翻译提前到这里就等于给错误文案开第二个家。
 */

/** 一条命中落进书架的输入：架位身份（`url`）+ 书目元数据（字段集归 `SHELF_META`） */
export type ShelfSeatInput = ShelfMetaPatch & { sourceId: string; title: string; url: string }

/** 一发加架的结局：`ok:true` 给落下的架位；失败原样带回错误，绝不抛 */
export type ShelfAddOutcome = { ok: true; bookKey: string } | { ok: false; error: unknown }

export async function addShelfSeat(
  input: ShelfSeatInput,
  deps: Pick<RowActionDeps, 'apiSend'>,
): Promise<ShelfAddOutcome> {
  const { url, sourceId, ...meta } = input
  try {
    await deps.apiSend(paramOps.shelfPut.at(url),
      bodies.shelfAdd(sourceId, meta as ShelfMetaPatch & { title: string }))
    return { ok: true, bookKey: url }
  } catch (error) {
    return { ok: false, error }
  }
}
