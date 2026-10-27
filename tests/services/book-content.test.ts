import { describe, expect, it } from 'vitest'
import { BookContent } from '../../src/services/book-content.js'
import { LocalNotMountedError } from '../../src/services/errors.js'
import { LOCAL_SOURCE_ID } from '../../src/shared/wire.js'
import type { BookNavigation, ChapterContent, ChapterEntry } from '../../src/shared/wire.js'

const entries: ChapterEntry[] = [{ name: '在线一', url: 'https://a/1' }]

function fakes(over: {
  localText?: string
  onlineText?: string
  localContent?: ChapterContent
} = {}) {
  const calls: string[] = []
  const local = {
    getToc: async (bookKey: string): Promise<ChapterEntry[]> => {
      calls.push(`local:toc:${bookKey}`)
      return [{ name: '本地一', url: `${bookKey}#0` }]
    },
    getNavigation: async (bookKey: string): Promise<BookNavigation> => {
      calls.push(`local:nav:${bookKey}`)
      return { chapters: [{ name: '本地一', url: `${bookKey}#0` }], items: [] }
    },
    getChapterContent: async (bookKey: string, index: number): Promise<ChapterContent> => {
      calls.push(`local:ch:${bookKey}:${index}`)
      return over.localContent ?? { kind: 'text', text: over.localText ?? ' 甲 \r\n\r\n乙 ' }
    },
  }
  const online = {
    toc: async (sourceId: string, bookUrl: string, opts?: { refresh?: boolean }): Promise<ChapterEntry[]> => {
      calls.push(`online:toc:${sourceId}:${bookUrl}:${String(opts?.refresh)}`)
      return entries
    },
    chapterText: async (
      sourceId: string, bookKey: string, index: number, opts?: { refresh?: boolean },
    ): Promise<string> => {
      calls.push(`online:ch:${sourceId}:${bookKey}:${index}:${String(opts?.refresh)}`)
      return over.onlineText ?? ' 甲 \r\n\r\n乙 '
    },
  }
  return { calls, local, online }
}

describe('BookContent', () => {
  it('本地 TXT 与在线正文过同一文字规约（CRLF、首尾空白、连续空行）', async () => {
    const { local, online } = fakes()
    const bc = new BookContent({ local, online })
    expect(await bc.chapterContent(LOCAL_SOURCE_ID, 'local:x', 0)).toEqual({ kind: 'text', text: '甲\n\n乙' })
    expect(await bc.chapterContent('src', 'https://a/1', 0)).toEqual({ kind: 'text', text: '甲\n\n乙' })
  })

  it('本地 rich 原样通过（结构映射归 chapter-content 的投影）', async () => {
    const rich: ChapterContent = { kind: 'rich', documentId: 'd0', nodes: [{ kind: 'text', text: ' 甲 ' }] }
    const { local, online } = fakes({ localContent: rich })
    const bc = new BookContent({ local, online })
    expect(await bc.chapterContent(LOCAL_SOURCE_ID, 'local:x', 0)).toBe(rich)
  })

  it('目录：本地走本地适配器，在线走在线适配器并透传 refresh', async () => {
    const { calls, local, online } = fakes()
    const bc = new BookContent({ local, online })
    expect((await bc.toc(LOCAL_SOURCE_ID, 'local:x')).map((c) => c.name)).toEqual(['本地一'])
    expect((await bc.toc('src', 'https://a/1', { refresh: true })).map((c) => c.name)).toEqual(['在线一'])
    expect(calls).toEqual(['local:toc:local:x', 'online:toc:src:https://a/1:true'])
  })

  it('导航：本地读原生导航，在线按线性目录派生平面树', async () => {
    const { calls, local, online } = fakes()
    const bc = new BookContent({ local, online })
    expect((await bc.navigation(LOCAL_SOURCE_ID, 'local:x')).items).toEqual([])
    const derived = await bc.navigation('src', 'https://a/1')
    expect(derived.chapters).toEqual(entries)
    expect(derived.items).toEqual([{
      id: 't0',
      label: '在线一',
      target: { kind: 'chapter', index: 0, anchorId: null },
      children: [],
    }])
    expect(calls).toEqual(['local:nav:local:x', 'online:toc:src:https://a/1:undefined'])
  })

  it('本地书未挂载：读本地内容抛 LocalNotMountedError，在线不受影响', async () => {
    const { online } = fakes()
    const bc = new BookContent({ local: null, online })
    await expect(bc.chapterContent(LOCAL_SOURCE_ID, 'local:x', 0)).rejects.toBeInstanceOf(LocalNotMountedError)
    expect((await bc.chapterContent('src', 'https://a/1', 0)).kind).toBe('text')
  })

  it('在线正文的 refresh 透传（本地目录/正文没有 refresh 语义，忽略）', async () => {
    const { calls, local, online } = fakes()
    const bc = new BookContent({ local, online })
    await bc.chapterContent('src', 'https://a/1', 2, { refresh: true })
    await bc.chapterContent(LOCAL_SOURCE_ID, 'local:x', 3, { refresh: true })
    expect(calls).toEqual(['online:ch:src:https://a/1:2:true', 'local:ch:local:x:3'])
  })
})
