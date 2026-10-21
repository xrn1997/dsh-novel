import { describe, expect, it } from 'vitest'
import { summarizeRound } from '../../src/shared/round-summary.js'
import type { SearchGroup, SearchHit } from '../../src/shared/wire.js'

const hit = (title: string, url: string | null): SearchHit => ({
  title, author: null, url, coverUrl: null, intro: null, lastChapterName: null, kind: null, wordCount: null,
})
const group = (sourceId: string, hits: SearchHit[], error?: SearchGroup['error']): SearchGroup =>
  ({ sourceId, sourceName: sourceId, status: 'unverified', hits, ...(error === undefined ? {} : { error }) })

describe('summarizeRound：一轮只分区一次，读数各数各的', () => {
  const groups = [
    group('s1', [hit('斗罗', 'u1'), hit('无关', 'u2')]),
    group('s2', []),
    group('s3', [], { code: 'ECONNRESET', message: '不可达' }),
  ]
  const { parts, counts } = summarizeRound('斗罗', groups)

  it('searched 数回来的组（含失败组）', () => expect(counts.searched).toBe(3))
  it('answered 数答话的组，零条也算；failed 数带 error 的组', () => {
    expect(counts.answered).toBe(2)
    expect(counts.failed).toBe(1)
  })
  it('hits / kept / suspect 只汇总答话组', () => {
    expect(counts).toMatchObject({ hits: 2, kept: 1, suspect: 1 })
  })
  it('parts 保留失败组，归并面自己跳过', () => {
    expect(parts.map((p) => p.group.sourceId)).toEqual(['s1', 's2', 's3'])
  })
})
