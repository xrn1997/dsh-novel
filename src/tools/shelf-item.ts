import type { ShelfBook } from '../shared/wire.js'
import { SHELF_META } from '../shared/wire.js'

/** 工具面书架条目的投影形状：字段、JSON schema 与 picker 同住这张表。
 *  `SHELF_META` 仍是书目元数据字段集的唯一主人；这里只声明「工具这一面投影哪些键」，
 *  刻意不投影的三项由 `SHELF_ITEM_EXCLUDED` 点名。加一个 SHELF_META 字段时，
 *  要么进这张表、要么进排除表，下面的编译期断言会逼你选一个。 */
type ShelfItemFieldSpec = {
  type: 'string' | 'integer' | 'number' | 'object'
  required?: true
  description: string
  additionalProperties?: boolean
  properties?: Record<string, ShelfItemFieldSpec>
}

export const SHELF_ITEM_EXCLUDED = ['coverUrl', 'intro', 'totalChapters'] as const

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
