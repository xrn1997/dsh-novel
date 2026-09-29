import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 文档的引用活性：`README.md` / `AGENTS.md` / `CONTEXT.md` / `docs/**\/*.md` 不许指着读者拿不到的东西。
 *
 * 三件事，都因为本仓真栽过：
 * 1. **路径必须在场**——文档改了文件名而引用没跟上，读者就会去开一个不存在的文件；
 * 2. **不许写行号**（`file.ext:123` 形态）——行号随任何一次编辑漂移，校它等于造一道天天假红、
 *    终被习惯性忽略的门；要指实现就指符号锚；
 * 3. **不许指已出库的文档与已撤的守卫**，也不许把 `.superpowers/` 的过程产物当证据。
 *
 * 与 `context-terms.test.ts` 的分工：那份管**词汇表**点名的符号能不能现查得到；这一份管
 * **全部文档**的路径与引用形态。两个判据不同，合成一份只会互相拖累（词汇表的符号判据套到 ADR
 * 上会把「对面叫 `getElementsByClass`」这类外部符号判成悬空）。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 在册的散文文档：这三份 + docs/ 下的全部 .md */
function docFiles(): string[] {
  const top = ['README.md', 'AGENTS.md', 'CONTEXT.md'].filter((f) => existsSync(join(ROOT, f)))
  const walk = (dir: string, out: string[]): string[] => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) walk(rel, out)
      else if (e.name.endsWith('.md')) out.push(rel)
    }
    return out
  }
  return [...top, ...walk('docs', [])]
}

const FILES = docFiles()
/** 反引号里的路径：必须含 `/` 且带代码/文档扩展名（裸文件名与运行时数据路径不在判据内） */
const PATH_TOKEN = /`([A-Za-z0-9_./-]*\/[A-Za-z0-9_.-]+\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml))`/g
/** ADR 互引允许省掉 `.md`：`docs/adr/0007-usage-axis-single` 或 `docs/adr/0007` */
const ADR_REF = /`docs\/adr\/([0-9]{4}[A-Za-z0-9-]*)`/g
/** 构建产物与跑门产物：它们在盘上但故意不入库，文档可以正当提到 */
const GENERATED = [/^lib\//, /^compat\/report\.md$/]
const isGenerated = (p: string) => GENERATED.some((re) => re.test(p))
const LINE_REF = /\b[A-Za-z0-9_./-]+\.(?:ts|tsx|js|mjs|json|md|yml):[0-9]{2,}\b/g
/** `.superpowers/` 的**具体产物**（两级以下路径）不许当证据；单纯提这个目录作为「过程产物写哪」是正当的 */
const DEAD = /docs\/design\/|docs\/reference\/|compat\/README\.md|(?<![-\w])coverage\.test\.ts|citation-liveness|matrix-pointers|docs-module-symbols|docs-references|docs-pinned-copy|known-open|\.superpowers\/[A-Za-z0-9_-]+\/?[A-Za-z0-9_.-]*\.(?:md|json|ts|js|cjs|mjs)/

function resolveInRepo(p: string): boolean {
  if (existsSync(join(ROOT, p))) return true
  return p.startsWith('src/') ? false : existsSync(join(ROOT, 'src', p))
}

describe('文档里的路径引用必须在场', () => {
  it('扫描面非空（守卫不许对着空集合报绿）', () => {
    expect(FILES.length).toBeGreaterThan(5)
    expect(FILES.filter((f) => f.startsWith('docs/adr/')).length, 'ADR 一份都不在？').toBeGreaterThan(5)
  })

  it('反引号里的仓内路径逐个存在', () => {
    const bad: string[] = []
    for (const rel of FILES) {
      const text = readFileSync(join(ROOT, rel), 'utf8')
      for (const m of text.matchAll(PATH_TOKEN)) {
        const p = m[1]
        if (isGenerated(p)) continue
        if (!resolveInRepo(p)) bad.push(`${rel} → ${p}`)
      }
      for (const m of text.matchAll(ADR_REF)) {
        const numOrSlug = m[1]
        const hit = FILES.some((f) => f === `docs/adr/${numOrSlug}.md` || f.startsWith(`docs/adr/${numOrSlug}-`))
        if (!hit) bad.push(`${rel} → docs/adr/${numOrSlug}（ADR 不在册）`)
      }
    }
    expect(bad, `悬空路径引用：\n${bad.join('\n')}`).toEqual([])
  })
})

describe('引用形态纪律', () => {
  it('不许写行号（会随任何一次编辑漂移）', () => {
    const bad: string[] = []
    for (const rel of FILES) {
      const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n')
      lines.forEach((l, i) => {
        for (const m of l.matchAll(LINE_REF)) bad.push(`${rel}:${i + 1} → ${m[0]}`)
      })
    }
    expect(bad, `行号形态的引用（改指符号锚）：\n${bad.join('\n')}`).toEqual([])
  })

  it('不许指已出库的文档、已撤的守卫或过程产物目录', () => {
    const bad: string[] = []
    for (const rel of FILES) {
      const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n')
      lines.forEach((l, i) => {
        const m = DEAD.exec(l)
        if (m) bad.push(`${rel}:${i + 1} → ${m[0]}`)
      })
    }
    expect(bad, `读者拿不到的出处：\n${bad.join('\n')}`).toEqual([])
  })
})

describe('ADR 编号与形状', () => {
  /** 索引页 `docs/adr/README.md` 不是 ADR：它没有编号，也不该被要求点名锚点 */
  const adrs = FILES.filter((f) => /^docs\/adr\/\d{4}-.*\.md$/.test(f)).sort()

  it('编号连续不重号（改名重排会留下断号，断号即有人抄不到那一页）', () => {
    expect(adrs.length, '一篇 ADR 都没扫到？').toBeGreaterThan(5)
    const nums = adrs.map((f) => Number(/^docs\/adr\/(\d{4})-/.exec(f)![1]))
    expect(nums.some(Number.isNaN), 'ADR 文件名必须是 NNNN-slug.md').toBe(false)
    const sorted = [...nums].sort((a, b) => a - b)
    const gaps: string[] = []
    for (let n = sorted[0]; n <= sorted[sorted.length - 1]; n++) if (!sorted.includes(n)) gaps.push(String(n))
    expect(gaps, `断号：${gaps.join(', ')}（只许追加，不许重排）`).toEqual([])
  })

  it('每篇第一行是标题、并点名锚点', () => {
    const bad = adrs.filter((f) => {
      const text = readFileSync(join(ROOT, f), 'utf8')
      return !/^# \S/.test(text) || !text.includes('锚点：')
    })
    expect(bad, `缺标题或缺「锚点：」那一行：${bad.join(', ')}`).toEqual([])
  })
})
