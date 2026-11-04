import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COVERAGE } from './matrix.js'
import { DATE_ANCHOR, MATRIX_ROWS, dateAnchorsIn } from './matrix-source.js'
import { withoutComments } from '../without-comments.js'

/**
 * 矩阵三态的证据门（判据①②的机器那一半）。每行只能归入 implemented / not-applicable / open，
 * 归进去就要留下可回查的证据，否则「已支持」「不适用」都只是自称：
 *   implemented → `impl` 的符号必须在实现文件里现查得到（**剥注释后**，注释里提一嘴不算实现），
 *                 `test` 的用例标题片段必须在测试文件里在场；
 *   not-applicable → `note` 必须写明裁决理由（判「不适用」而不写理由 = 把裁决写成遗忘）；
 *   open → `note` 必须带 `2026-MM-DD` 复核戳（最危险的不是「还没做」，是把过期读数当现状）。
 *
 * 另钉两条表自身的形状：id 唯一（同一能力被抄成两行即红）、**一行一条记录**（本表一半按行读：
 * 审计脚本、`inventory-coverage`，把一条记录折成多行会让这些读数静默漏掉它）。
 *
 * 裁决理由只住本行 `note`，不指任何设计文档：仓里没有第二份兼容裁决文档，指出去就是悬空引用。
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

function fileText(rel: string): string | null {
  const p = join(ROOT, rel)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

describe('implemented 行的证据必须现查得到', () => {
  const rows = COVERAGE.filter((r) => r.status === 'implemented')

  it('每条 implemented 都给 impl 与 test', () => {
    const bad = rows.filter((r) => !r.impl || !r.test).map((r) => r.id)
    expect(bad, `缺 impl / test 证据：${bad.join(', ')}`).toEqual([])
  })

  it('impl 的文件在场，符号在剥注释后的代码里查得到', () => {
    const bad: string[] = []
    for (const r of rows) {
      if (!r.impl) continue
      const [file, symbol] = r.impl
      const code = fileText(file)
      if (code === null) { bad.push(`${r.id}: 实现文件不在场 ${file}`); continue }
      if (!withoutComments(code).includes(symbol)) bad.push(`${r.id}: ${file} 里查不到 ${symbol}`)
    }
    expect(bad, `实现证据漂了：\n${bad.join('\n')}`).toEqual([])
  })

  it('test 的文件在场，用例标题片段在场', () => {
    const bad: string[] = []
    for (const r of rows) {
      if (!r.test) continue
      const [file, snippet] = r.test
      const code = fileText(file)
      if (code === null) { bad.push(`${r.id}: 测试文件不在场 ${file}`); continue }
      if (!code.includes(snippet)) bad.push(`${r.id}: ${file} 里没有用例片段 ${JSON.stringify(snippet)}`)
    }
    expect(bad, `钉子证据漂了：\n${bad.join('\n')}`).toEqual([])
  })
})

describe('not-applicable 与 open 行的说明纪律', () => {
  it('判「不适用」的行都写明理由', () => {
    const bad = COVERAGE.filter((r) => r.status === 'not-applicable')
      .filter((r) => !r.note || r.note.trim().length < 20)
      .map((r) => r.id)
    expect(bad, `not-applicable 缺裁决理由：${bad.join(', ')}`).toEqual([])
  })

  it('open 行都带复核时效戳（2026-MM-DD）', () => {
    const bad = COVERAGE.filter((r) => r.status === 'open')
      .filter((r) => !r.note || !DATE_ANCHOR.test(r.note))
      .map((r) => r.id)
    expect(bad, `open 行没有日期锚，读数会被当成现状：${bad.join(', ')}`).toEqual([])
  })

  it('写了「N 源」这类现量读数的行必须带日期锚（不限状态）', () => {
    // 「现库有 N 源在用」是会随用户增删漂移的数，没有日期锚的数等于没有出处——
    // 最危险的不是「还没做」，是过期读数被当现状用。设计常量（如「每源截断 50 条」）
    // 不在此判据内：那是要实现的形状，不是量出来的事实。
    const READING = /[0-9]+ ?个?源/
    const bad = COVERAGE.filter((r) => r.note && READING.test(r.note) && !DATE_ANCHOR.test(r.note)).map((r) => r.id)
    expect(bad, `现量读数缺日期锚：${bad.join(', ')}`).toEqual([])
  })

  it('note 不排成时间线：一条读数最多挂一个日期锚', () => {
    const bad: string[] = []
    for (const row of MATRIX_ROWS) {
      if (row.noteText === undefined) continue
      const anchors = dateAnchorsIn(row.noteText)
      if (anchors.length > 1) bad.push(`${row.id} 挂了 ${anchors.length} 个日期`)
    }
    expect(bad, `这些行把读数写成了时间线：\n${bad.join('\n')}`).toEqual([])
  })
})

describe('矩阵表自身的形状', () => {
  it('行 id 唯一', () => {
    const seen = new Set<string>()
    const dup = COVERAGE.filter((r) => (seen.has(r.id) ? true : (seen.add(r.id), false))).map((r) => r.id)
    expect(dup, `重复的矩阵行 id：${dup.join(', ')}`).toEqual([])
  })

  it('一条记录占一行（本表一半按行读）', () => {
    const sourceIds = MATRIX_ROWS.map((row) => row.id)
    expect(sourceIds, '源码里的行 id 与数组不一致——有记录没按行读出来').toEqual(COVERAGE.map((row) => row.id))
    const folded = MATRIX_ROWS.filter((row) => !row.complete).map((row) => row.id)
    expect(folded, `这些记录折成了多行：${folded.join(', ')}`).toEqual([])
  })

  it('note 里不许指着已出库的文档或已删的守卫', () => {
    const DEAD = /docs\/(design|reference)\/|CONTEXT\.md|compat\/README\.md|coverage\.test\.ts|citation-liveness|matrix-pointers|docs-module-symbols|docs-references|docs-pinned-copy|known-open/
    const bad: string[] = []
    for (const r of COVERAGE) {
      const text = `${r.capability} ${r.note ?? ''} ${r.impl?.join(' ') ?? ''} ${r.test?.join(' ') ?? ''}`
      const m = DEAD.exec(text)
      if (m) bad.push(`${r.id} → ${m[0]}`)
    }
    expect(bad, `悬空引用（裁决理由只准写进 note）：\n${bad.join('\n')}`).toEqual([])
  })
})
