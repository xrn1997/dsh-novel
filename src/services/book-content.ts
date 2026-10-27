import { LOCAL_SOURCE_ID, planarNavigation } from '../shared/wire.js'
import type { BookNavigation, ChapterContent, ChapterEntry } from '../shared/wire.js'
import { normalizeChapterText } from './chapter-content.js'
import { LocalNotMountedError } from './errors.js'

/**
 * 书内容读面：目录、导航与正文的**唯一**业务入口。本地书与在线书是两个适配器，
 * 三个读动词（以及上层的内容读取）不再各自判 `__local__`；来源**展示**判据
 * （如门面的 `sourceNameOf`、书目筛选）仍按本地源常量判来源身份，不属于内容读取分流。
 *
 * 为什么在门面与两个来源之间再放一层：三个读动词此前各写一次
 * `sourceId === LOCAL_SOURCE_ID ? local : online`；更要紧的是正文文字规约只在线那条路上过，
 * 本地 TXT 直接把切片原样交出去（CRLF、连续空行留在导出与 AI 读到的正文里）。
 * 文字规约是本读面的**契约**：两个适配器的 `chapterContent` 出口都过
 * `normalizeChapterText`（幂等），EPUB 的 rich 树不解释。
 *
 * 刻意**不**把本地书塞进 `OnlineReading`（`docs/adr/0047`）：在线那条只认识 HTTP 与文件缓存，
 * 本地适配器不认识它们；本模块只拥有「按来源分流 + 文字规约」，不拥有两边各自的取数语义。
 */
export interface BookContentLocal {
  getToc(bookKey: string): Promise<ChapterEntry[]>
  getNavigation(bookKey: string): Promise<BookNavigation>
  getChapterContent(bookKey: string, index: number): Promise<ChapterContent>
}

export interface BookContentOnline {
  toc(sourceId: string, bookUrl: string, opts?: { refresh?: boolean }): Promise<ChapterEntry[]>
  chapterText(sourceId: string, bookKey: string, index: number, opts?: { refresh?: boolean }): Promise<string>
}

export interface BookContentParts {
  /** 本地书未挂载（无 LocalBooks 部件）时给 null；此时读本地书抛 LocalNotMountedError */
  local: BookContentLocal | null
  online: BookContentOnline
}

export class BookContent {
  constructor(private readonly parts: BookContentParts) {}

  /** 目录：本地适配器读持久化目录；在线适配器走缓存/在途去重/翻页那条管线。
   *  三个读动词一律 `async`：分流与「本地书未挂载」的抛错收成 rejection，HTTP 面与工具面
   *  都按 promise 消费，不要求调用方自己 try/catch 同步段。 */
  async toc(sourceId: string, bookUrl: string, opts?: { refresh?: boolean }): Promise<ChapterEntry[]> {
    if (this.isLocal(sourceId)) return this.requireLocal().getToc(bookUrl)
    return this.parts.online.toc(sourceId, bookUrl, opts)
  }

  /** 目录导航：本地 EPUB 读原生 nav/NCX；其余按线性目录派生平面树（派生单点在 wire）。 */
  async navigation(sourceId: string, bookUrl: string): Promise<BookNavigation> {
    if (this.isLocal(sourceId)) return this.requireLocal().getNavigation(bookUrl)
    const chapters = await this.toc(sourceId, bookUrl)
    return { chapters, items: planarNavigation(chapters) }
  }

  /** 章节正文（图文面）：本地 EPUB 返回 rich；TXT 与在线返回 text。
   *  text 一律在这里过行规约——这是两个适配器共同的出口契约，调用方不必知道来源。 */
  async chapterContent(
    sourceId: string, bookKey: string, index: number, opts?: { refresh?: boolean },
  ): Promise<ChapterContent> {
    if (this.isLocal(sourceId)) {
      return normalizeText(await this.requireLocal().getChapterContent(bookKey, index))
    }
    const text = await this.parts.online.chapterText(sourceId, bookKey, index, opts)
    return normalizeText({ kind: 'text', text })
  }

  private isLocal(sourceId: string): boolean {
    return sourceId === LOCAL_SOURCE_ID
  }

  private requireLocal(): BookContentLocal {
    if (this.parts.local === null) throw new LocalNotMountedError()
    return this.parts.local
  }
}

/** text 过行规约；rich 原样（结构映射由 chapter-content 的投影负责）。幂等，重复过手无害。 */
function normalizeText(content: ChapterContent): ChapterContent {
  return content.kind === 'text' ? { kind: 'text', text: normalizeChapterText(content.text) } : content
}
