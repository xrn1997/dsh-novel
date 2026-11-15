import type { ShelfBook } from '../shared/wire.js'
import { SHELF_META } from '../shared/wire.js'

/** 工具面书架条目的投影形状：字段、JSON schema 与 picker 同住这张表。
 *  `SHELF_META` 仍是书目元数据字段集的唯一主人；这里只声明「工具这一面投影哪些键」，
 *  刻意不投影的键由 `SHELF_ITEM_EXCLUDED` 点名。`ShelfBook` 的**每一个**键——无论书目元数据
 *  还是系统状态（`bookKey` / `progress` / `addedAt` / `listen`）——要么进这张表、要么进排除表：
 *  这条两向断言的家是 `tests/tools/schema-contract.test.ts` 的 `_ShelfWire`（编译期相等），
 *  本文件下面那条只管元数据那一族。
 *  `listen`（按书听书位置）是**播放态**细节轨：工具面的书架只给「读到哪」（`progress`），
 *  不带播放态（段号 / 引擎 / 音色 / 语速），故只占排除表。 */
type ShelfItemFieldSpec = {
  type: 'string' | 'integer' | 'number' | 'object'
  required?: true
  description: string
  additionalProperties?: boolean
  properties?: Record<string, ShelfItemFieldSpec>
}

export const SHELF_ITEM_EXCLUDED = ['coverUrl', 'intro', 'totalChapters', 'listen'] as const

export const SHELF_ITEM_FIELDS = {
  sourceId: { type: 'string', required: true, description: '源 id' },
  bookKey: { type: 'string', required: true, description: '书籍键（详情页 URL）' },
  title: { type: 'string', required: true, description: '书名' },
  author: { type: 'string', description: '作者' },
  lastChapterName: { type: 'string', description: '最新章名' },
  kind: { type: 'string', description: '分类' },
  wordCount: { type: 'string', description: '字数（站点文案原样）' },
  progress: {
    type: 'object', required: true, description: '{chapterIndex, offsetRatio, updatedAt}', additionalProperties: false,
    properties: {
      chapterIndex: { type: 'integer', required: true, description: '章序（0 起）' },
      offsetRatio: { type: 'number', required: true, description: '章内比例（0~1）' },
      updatedAt: { type: 'integer', required: true, description: '更新时间戳' },
    },
  },
  addedAt: { type: 'integer', required: true, description: '加入时间戳' },
} as const satisfies Partial<Record<keyof ShelfBook, ShelfItemFieldSpec>>

export type ShelfItemField = keyof typeof SHELF_ITEM_FIELDS
export type ShelfItem = Pick<ShelfBook, ShelfItemField>
const SHELF_ITEM_KEYS = Object.keys(SHELF_ITEM_FIELDS) as ShelfItemField[]

/** 一条书架记录 → 工具面投影（null/undefined 键交给 `project()` 整键省略）。 */
export function pickShelfItem(b: ShelfBook): ShelfItem {
  return Object.fromEntries(SHELF_ITEM_KEYS.map((k) => [k, b[k]])) as ShelfItem
}

/** 元数据那一族的覆盖闸：`SHELF_META` 里除投影 / 排除之外的键不许存在。
 *  系统状态字段（`bookKey` / `progress` / `addedAt` / `listen`）不经过元数据表，
 *  它们的全量覆盖由 `tests/tools/schema-contract.test.ts` 的 `_ShelfWire` 两向钉。 */
type MissingShelfMeta = Exclude<
  keyof typeof SHELF_META,
  ShelfItemField | (typeof SHELF_ITEM_EXCLUDED)[number]
>
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T
type _ShelfMetaCovered = Assert<MissingShelfMeta extends never ? true : false>
/** 嵌套的 `progress` schema 也绑回 wire：键集两向相等，改 `ShelfProgress` 而漏改 schema 当场红。 */
type _ShelfProgressCovered = Assert<Eq<
  keyof ShelfBook['progress'],
  keyof (typeof SHELF_ITEM_FIELDS)['progress']['properties']
>>
export type { _ShelfMetaCovered, _ShelfProgressCovered }
