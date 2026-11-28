import { beforeEach, describe, expect, it } from 'vitest'
import {
  MOYU_ACTION_MARKS,
  MOYU_PIN_RELEASE_PX,
  MOYU_TICK_CHARS,
  MOYU_TICK_MS,
  actionMarkFor,
  chapterFileName,
  extractMoyuTurnBlocks,
  moyuChapterPath,
  isMainLine,
  isPinnedToTail,
  nextPhase,
  projectLines,
} from '../../src/client/moyu-stream.js'
import { DEFAULT_PREFS, prefsStore, setPref } from '../../src/client/store.js'
import type { ChapterContent } from '../../src/shared/wire.js'

describe('Moyu reading preferences', () => {
  beforeEach(() => setPref(DEFAULT_PREFS))

  it('defaults to the DSH stream presentation', () => {
    expect(prefsStore.get()).toMatchObject({
      readingMode: 'scroll',
      lastNormalMode: 'scroll',
      moyuStyle: 'dsh',
      moyuReveal: 'stream',
    })
  })

  it('remembers the last normal mode when entering and leaving Moyu', () => {
    setPref({ readingMode: 'page' })
    setPref({ readingMode: 'moyu' })
    expect(prefsStore.get().lastNormalMode).toBe('page')

    setPref({ readingMode: 'scroll' })
    expect(prefsStore.get().lastNormalMode).toBe('scroll')

    setPref({ readingMode: 'moyu' })
    setPref({ readingMode: 'page' })
    expect(prefsStore.get()).toMatchObject({ readingMode: 'page', lastNormalMode: 'page' })
  })
})

describe('Moyu stream projection', () => {
  it('pins the reveal cadence and compact action marks', () => {
    expect([MOYU_TICK_MS, MOYU_TICK_CHARS, MOYU_PIN_RELEASE_PX]).toEqual([70, 6, 40])
    expect(MOYU_ACTION_MARKS).toEqual(['▸', '»', '⇣', '✎'])
    expect([0, 1, 2, 3, 4].map(isMainLine)).toEqual([true, false, false, false, true])
    expect([1, 2, 3, 5, 6, 7, 9].map(actionMarkFor)).toEqual(['▸', '»', '⇣', '✎', '▸', '»', '⇣'])
  })

  it('truncates by code point and skips empty lines', () => {
    expect(projectLines(['A😀B', '', '第二行'], 2)).toEqual([
      { text: 'A😀', done: false, index: 0 },
    ])
    expect(projectLines(['A😀B', '第二行'], 4)).toEqual([
      { text: 'A😀B', done: true, index: 0 },
      { text: '第', done: false, index: 1 },
    ])
  })

  it('derives phase from reveal progress and chapter position', () => {
    expect(nextPhase(0, 0, false)).toBe('streaming')
    expect(nextPhase(2, 5, false)).toBe('streaming')
    expect(nextPhase(5, 5, false)).toBe('chapter-ready')
    expect(nextPhase(5, 5, true)).toBe('complete')
  })

  it('releases the tail pin only beyond the threshold', () => {
    expect(isPinnedToTail({ scrollHeight: 500, scrollTop: 460, clientHeight: 40 })).toBe(true)
    expect(isPinnedToTail({ scrollHeight: 500, scrollTop: 419, clientHeight: 40 })).toBe(false)
  })

  it('sanitizes and truncates chapter file names by code point', () => {
    expect(chapterFileName(0, '第1章 开头: before/after')).toBe('0001_开头_ before_after.ts')
    expect(chapterFileName(9, '')).toBe('0010_chapter.ts')
    expect(chapterFileName(1, '😀'.repeat(40))).toBe(`0002_${'😀'.repeat(32)}.ts`)
    expect(moyuChapterPath(0, '第1章 风起沛县')).toBe('chapters/0001_风起沛县.ts')
  })

  it('extracts canonical text paragraphs and ordered rich attachments', () => {
    expect(extractMoyuTurnBlocks({ kind: 'text', text: '第一段\n\n第二段' })).toEqual([
      { kind: 'paragraph', text: '第一段', paragraphIndex: 0, nodeId: null },
      { kind: 'paragraph', text: '第二段', paragraphIndex: 1, nodeId: null },
    ])

    const rich: ChapterContent = {
      kind: 'rich',
      documentId: 'doc',
      nodes: [
        { kind: 'element', id: 'p1', tag: 'p', children: [{ kind: 'text', text: '图文一段' }], rowSpan: null, colSpan: null, start: null, value: null },
        { kind: 'image', id: 'img1', resourceId: 'asset.png', alt: '插图', width: 320, height: 180 },
        {
          kind: 'link', id: 'link1', role: 'noteref', target: { kind: 'supplement', documentId: 'note', anchorId: null },
          children: [{ kind: 'text', text: '注' }],
        },
        { kind: 'element', id: 'p2', tag: 'p', children: [{ kind: 'text', text: '图文二段' }], rowSpan: null, colSpan: null, start: null, value: null },
      ],
    }
    expect(extractMoyuTurnBlocks(rich)).toEqual([
      { kind: 'paragraph', text: '图文一段', paragraphIndex: 0, nodeId: 'p1' },
      { kind: 'image', resourceId: 'asset.png', alt: '插图', width: 320, height: 180, paragraphIndex: 0, nodeId: 'img1' },
      { kind: 'link', text: '注', target: { kind: 'supplement', documentId: 'note', anchorId: null }, role: 'noteref', paragraphIndex: 0, nodeId: 'link1' },
      { kind: 'paragraph', text: '图文二段', paragraphIndex: 2, nodeId: 'p2' },
    ])
  })

  it('does not duplicate inline link text or image placeholders inside rich paragraphs', () => {
    const rich: ChapterContent = {
      kind: 'rich',
      documentId: 'doc-inline',
      nodes: [{
        kind: 'element', id: 'p-inline', tag: 'p', children: [
          { kind: 'text', text: '正文' },
          { kind: 'link', id: 'note-inline', role: 'noteref', target: { kind: 'supplement', documentId: 'note', anchorId: null }, children: [
            { kind: 'text', text: '脚注' },
            { kind: 'image', id: 'img-inline', resourceId: 'inline.png', alt: '内嵌图', width: 10, height: 10 },
          ] },
        ], rowSpan: null, colSpan: null, start: null, value: null,
      }],
    }
    expect(extractMoyuTurnBlocks(rich)).toEqual([
      {
        kind: 'paragraph', text: '正文脚注', paragraphIndex: 0, nodeId: 'p-inline',
        segments: [
          { kind: 'text', text: '正文' },
          { kind: 'link', text: '脚注', target: { kind: 'supplement', documentId: 'note', anchorId: null }, role: 'noteref', nodeId: 'note-inline' },
        ],
      },
      { kind: 'image', resourceId: 'inline.png', alt: '内嵌图', width: 10, height: 10, paragraphIndex: 0, nodeId: 'img-inline' },
    ])
  })
})
