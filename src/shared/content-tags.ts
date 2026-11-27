import type { ContentTag } from './wire.js'

/** 行内短语级内容标签：行内排版、不占独立纵向块带。
 *  两个消费者共用这一份：正文渲染器判链接里的块级子节点（`<button>` 只收短语级，多出来的要降级），
 *  阅读几何把滚出视口的行内节点挡在空档判据之外（`client/reader-geometry.ts` 的 `isFlowNovelNode`）。
 *  新增短语级标签只改这里，两处自动跟上。 */
export const PHRASING_TAGS: ReadonlySet<ContentTag> = new Set(['span', 'strong', 'em', 'code', 'sup', 'sub'])
