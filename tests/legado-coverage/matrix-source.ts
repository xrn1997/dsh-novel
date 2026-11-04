import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 覆盖矩阵的**行源码**唯一读取口：矩阵本身是类型化数据，但「一条记录占一行」与 note 的
 * 排版纪律只有源码里看得见。按源码读矩阵的判据都从这里拿行，别再各自抄一份行语法。
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const MATRIX_PATH = join(ROOT, 'tests', 'legado-coverage', 'matrix.ts')
export const MATRIX_SOURCE = readFileSync(MATRIX_PATH, 'utf8')

export interface MatrixRowSource {
  id: string
  /** 这一行的源码（不含换行） */
  source: string
  /** 1 基行号 */
  line: number
  /** 这一行是否在同一条记录里闭合（`}` / `},`）——折行的记录在这里露馅 */
  complete: boolean
  /** note 字符串字面量的值；没有 note 或不是字符串字面量即缺席 */
  noteText?: string
}

/** 一条记录一行的判据：两空格缩进 + `{ id: '…'`。折行、改缩进或改引号即在这里露馅。 */
const ROW_START = /^ {2}\{ id: '([^']+)'/
const ROW_CLOSE = /\},?\s*$/

/** 读一个字符串字面量（单/双引号）；不是字面量即 undefined。 */
function literalAt(source: string, at: number): string | undefined {
  const quote = source[at]
  if (quote !== "'" && quote !== '"') return undefined
  let out = ''
  for (let i = at + 1; i < source.length; i++) {
    const ch = source.charAt(i)
    if (ch === '\\') {
      if (i + 1 >= source.length) return undefined
      out += source.charAt(i + 1)
      i++
      continue
    }
    if (ch === quote) return out
    out += ch
  }
  return undefined
}

function noteTextOf(source: string): string | undefined {
  const at = source.indexOf('note:')
  if (at < 0) return undefined
  let i = at + 'note:'.length
  while (source[i] === ' ' || source[i] === '\t') i++
  return literalAt(source, i)
}

export const MATRIX_ROWS: MatrixRowSource[] = MATRIX_SOURCE.split(/\r?\n/).flatMap((source, index) => {
  const id = ROW_START.exec(source)?.[1]
  if (id === undefined) return []
  const row: MatrixRowSource = {
    id,
    source,
    line: index + 1,
    complete: ROW_CLOSE.test(source),
  }
  const noteText = noteTextOf(source)
  if (noteText !== undefined) row.noteText = noteText
  return [row]
})

export const MATRIX_ROW_IDS: ReadonlySet<string> = new Set(MATRIX_ROWS.map((row) => row.id))

/** 读数时效锚的唯一写法：`YYYY-MM-DD`。 */
export const DATE_ANCHOR = /20\d\d-\d\d-\d\d/
const DATE_ANCHOR_GLOBAL = /20\d\d-\d\d-\d\d/g

export function dateAnchorsIn(text: string): string[] {
  return text.match(DATE_ANCHOR_GLOBAL) ?? []
}
