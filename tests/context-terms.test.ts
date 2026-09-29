import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { withoutComments } from './without-comments.js'

/**
 * `CONTEXT.md` 每条「唯一实现」句点名的记号必须在生产代码里现查得到。
 *
 * 为什么要机器门而不是信任这份表：它是接活时最先读的一页，指着不存在的符号比没有更糟——
 * `detectTailJs` 那种「符号删了、文档还留着」的病史就出在这里。判据按**符号**查（剥注释后的
 * src/** 与仓库根 `*.ts`），注释里提一嘴不算实现；矩阵行 id 形态另走 `matrix.ts`。
 *
 * 第二条门守词汇表自身的两条承诺：**每个词条都点名实现位置**（不许退化成散文 glossary）、
 * **不许指已出库的东西**（本仓只剩 `README.md` / `AGENTS.md` / 本表三份文档）。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CONTEXT = readFileSync(join(ROOT, 'CONTEXT.md'), 'utf8')

/** 生产代码 = src/ 全部 .ts/.tsx + 仓库根的 .ts 配置（构建期守卫住在 tsdown.config.ts） */
function productionText(): string {
  const chunks: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'lib', '.git', '.superpowers'].includes(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (/\.(ts|tsx)$/.test(e.name)) chunks.push(withoutComments(readFileSync(p, 'utf8')))
    }
  }
  walk(join(ROOT, 'src'))
  for (const e of readdirSync(ROOT, { withFileTypes: true })) {
    if (e.isFile() && /\.ts$/.test(e.name)) chunks.push(withoutComments(readFileSync(join(ROOT, e.name), 'utf8')))
  }
  return chunks.join('\n')
}
const CODE = productionText()
const MATRIX_SRC = readFileSync(join(ROOT, 'tests', 'legado-coverage', 'matrix.ts'), 'utf8')

interface Term { name: string; body: string; line: number }
function terms(): Term[] {
  const lines = CONTEXT.split('\n')
  const out: Term[] = []
  let cur: Term | null = null
  lines.forEach((l, i) => {
    const m = /^\*\*(.+?)\*\*:\s*$/.exec(l)
    if (m) { cur = { name: m[1], body: l, line: i + 1 }; out.push(cur); return }
    if (cur && l.trim() !== '') cur.body += `\n${l}`
    if (l.trim() === '') cur = null
  })
  return out
}

/** 反引号里的记号：路径 / 标识符 / 矩阵行 id 三类才回查，其余（键名、CSS、短语）跳过 */
function anchors(body: string): string[] {
  return [...body.matchAll(/`([^`]+)`/g)].map((m) => m[1])
}
const isPath = (t: string) => /\.[tj]sx?$/.test(t) && !t.includes(' ')
const isSymbol = (t: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(t)
const isMatrixRow = (t: string) => /^[a-k]-[a-z0-9-]+$/.test(t)

function pathExists(t: string): boolean {
  return existsSync(join(ROOT, t)) || existsSync(join(ROOT, 'src', t))
}

describe('CONTEXT.md 的词条与锚点', () => {
  const T = terms()

  it('表里有词条（解析器不能对着空表报绿）', () => {
    expect(T.length).toBeGreaterThan(20)
  })

  it('每个词条都点名仓内锚点', () => {
    const bad = T.filter((t) => anchors(t.body).length === 0).map((t) => `${t.line} ${t.name}`)
    expect(bad, `这些词条没点任何实现锚点：\n${bad.join('\n')}`).toEqual([])
  })

  it('写出的源文件路径必须在场', () => {
    const bad: string[] = []
    for (const t of T) for (const a of anchors(t.body)) if (isPath(a) && !pathExists(a)) bad.push(`${t.name} → ${a}`)
    expect(bad, `路径漂了：\n${bad.join('\n')}`).toEqual([])
  })

  it('点名的符号在生产代码里现查得到（注释不算命中）', () => {
    const bad: string[] = []
    for (const t of T) {
      for (const a of anchors(t.body)) {
        if (!isSymbol(a) || isPath(a)) continue
        if (CODE.includes(a)) continue
        if (MATRIX_SRC.includes(a)) continue
        bad.push(`${t.name} → ${a}`)
      }
    }
    expect(bad, `符号查不到（改名/删除后词条还留着即红）：\n${bad.join('\n')}`).toEqual([])
  })

  it('引用的矩阵行 id 在册', () => {
    const bad: string[] = []
    for (const t of T) for (const a of anchors(t.body)) if (isMatrixRow(a) && !MATRIX_SRC.includes(`id: '${a}'`)) bad.push(`${t.name} → ${a}`)
    expect(bad, `指向不存在的矩阵行：\n${bad.join('\n')}`).toEqual([])
  })
})

describe('CONTEXT.md 不许指着已出库的东西', () => {
  it('不提已删的设计文档、词表外的兼容文档与已撤的守卫', () => {
    const DEAD = /docs\/(design|reference)\/|compat\/README\.md|(?<!-)coverage\.test\.ts|citation-liveness|matrix-pointers|docs-module-symbols|docs-references|docs-pinned-copy|known-open/
    const hits = CONTEXT.split('\n').map((l, i) => ({ l, i })).filter(({ l }) => DEAD.test(l))
    expect(hits.map(({ i, l }) => `${i + 1} ${l.trim().slice(0, 90)}`), '本仓在册文档只有 README / AGENTS / CONTEXT').toEqual([])
  })
})
