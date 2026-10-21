import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 文档的引用活性：根目录的在册散文文档（`README.md` / `AGENTS.md` / `CONTEXT.md` / `CONTRIBUTING.md` / `CHANGELOG.md`）
 * 与 `docs/**\/*.md` 不许指着读者拿不到的东西。
 *
 * 引用活性五条判据，前三条因为本仓真栽过，后两条补两个盲区：
 * 1. **路径必须在场**——文档改了文件名而引用没跟上，读者就会去开一个不存在的文件；
 * 2. **不许写行号**（`file.ext:123` 形态）——行号随任何一次编辑漂移，校它等于造一道天天假红、
 *    终被习惯性忽略的门；要指实现就指符号锚；
 * 3. **不许指已出库的文档与已撤的守卫**，也不许把 `.superpowers/` 的过程产物当证据；
 * 4. **ADR 索引必须与文件一一对应**——新增 ADR 不补索引，索引页就会漏掉它；
 * 5. **Markdown 链接的路径与标题锚点必须在场**——反引号路径由第 1 条管，链接形态单独管。
 *
 * 另有一组骨架检查：核心文档在场、根 AGENTS 字符预算与指针、ADR `Status` 形状；命令仍是 `pnpm test`。
 *
 * 与 `context-terms.test.ts` 的分工：那份管**词汇表**点名的符号能不能现查得到；这一份管
 * **全部文档**的路径与引用形态。两个判据不同，合成一份只会互相拖累（词汇表的符号判据套到 ADR
 * 上会把「对面叫 `getElementsByClass`」这类外部符号判成悬空）。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 在册的散文文档：根目录这几份 + docs/ 下的全部 .md */
function docFiles(): string[] {
  const top = ['README.md', 'AGENTS.md', 'CONTEXT.md', 'CONTRIBUTING.md', 'CHANGELOG.md'].filter((f) => existsSync(join(ROOT, f)))
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
/** 索引页 `docs/adr/README.md` 不是 ADR：它没有编号，也不该被要求点名锚点 */
const ADRS = FILES.filter((f) => /^docs\/adr\/\d{4}-.*\.md$/.test(f)).sort()
/** 反引号里的路径：必须含 `/` 且带代码/文档扩展名（裸文件名与运行时数据路径不在判据内） */
const PATH_TOKEN = /`([A-Za-z0-9_./-]*\/[A-Za-z0-9_.-]+\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml))`/g
/** ADR 互引允许省掉 `.md`：`docs/adr/0007-usage-axis-single` 或 `docs/adr/0007` */
const ADR_REF = /`docs\/adr\/([0-9]{4}[A-Za-z0-9-]*)`/g
/** 构建产物与跑门产物：它们在盘上但故意不入库，文档可以正当提到 */
const GENERATED = [/^lib\//, /^compat\/report\.md$/]
const isGenerated = (p: string) => GENERATED.some((re) => re.test(p))
const LINE_REF = /\b[A-Za-z0-9_./-]+\.(?:ts|tsx|js|mjs|json|md|yml):[0-9]{2,}\b/g
/** `.superpowers/` 的**具体产物**（两级以下路径）不许当证据；单纯提这个目录作为「过程产物写哪」是正当的 */
const DEAD = /docs\/developing\.md|docs\/design\/|docs\/reference\/|compat\/README\.md|(?<![-\w])coverage\.test\.ts|citation-liveness|matrix-pointers|docs-module-symbols|docs-references|docs-pinned-copy|known-open|\.superpowers\/[A-Za-z0-9_-]+\/?[A-Za-z0-9_.-]*\.(?:md|json|ts|js|cjs|mjs)/

function resolveInRepo(p: string): boolean {
  if (existsSync(join(ROOT, p))) return true
  return p.startsWith('src/') ? false : existsSync(join(ROOT, 'src', p))
}

interface DocFile { path: string; text: string }

/** 代码围栏内的行不算文档链接；返回逐行文本，围栏行置空以保留行号。 */
function stripFencedLines(text: string): string[] {
  let inFence = false
  return text.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return '' }
    return inFence ? '' : line
  })
}

/** 标题 slug 按 GitHub 口径：小写、去标点、逐空格换连字符（中文保留）。 */
function headingSlugs(text: string): Set<string> {
  const out = new Set<string>()
  for (const line of stripFencedLines(text)) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const raw = m[2].replace(/`/g, '').replace(/<[^>]+>/g, '')
    const slug = raw.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-')
    out.add(slug)
  }
  return out
}

/** 索引表格里的裸编号与 ADR 文件名必须一一对应。 */
function adrIndexProblems(indexText: string, files: string[]): string[] {
  const indexed = [...indexText.matchAll(/^\| `(\d{4})`/gm)].map((m) => m[1])
  const fileNums = files
    .filter((f) => /^\d{4}-/.test(f))
    .map((f) => f.slice(0, 4))
    .sort()
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const n of indexed) {
    if (seen.has(n)) dupes.add(n)
    seen.add(n)
  }
  const missing = fileNums.filter((n) => !seen.has(n)).map((n) => `索引缺少 ADR ${n}`)
  const stale = [...seen]
    .filter((n) => !fileNums.includes(n))
    .sort()
    .map((n) => `索引指向不存在的 ADR ${n}`)
  const repeated = [...dupes].sort().map((n) => `索引重复登记 ADR ${n}`)
  return [...missing, ...stale, ...repeated]
}

/** inline Markdown 链接；reference-style 不在本门。代码围栏与行内代码里的 `](` 不算。 */
function markdownLinks(text: string): { line: number; target: string }[] {
  const out: { line: number; target: string }[] = []
  stripFencedLines(text).forEach((line, i) => {
    const clean = line.replace(/`[^`]*`/g, '')
    for (const m of clean.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      out.push({ line: i + 1, target: m[1] })
    }
  })
  return out
}

/** 本仓 GitHub 绝对链接映射回仓内路径；其余外链不校。 */
function githubLocalTarget(url: string): { path: string; fragment: string } | null {
  const m = /^https:\/\/github\.com\/xrn1997\/dsh-novel\/(?:blob|tree)\/main\/([^#?]+)(?:#(.+))?$/.exec(url)
  if (!m) return null
  return { path: decodeURIComponent(m[1]), fragment: m[2] ? decodeURIComponent(m[2]) : '' }
}

/** Markdown 链接的路径与标题锚点必须在场；外链只校本仓 GitHub 绝对链接。 */
function linkProblems(docs: DocFile[], fileExists: (path: string) => boolean): string[] {
  const byPath = new Map(docs.map((d) => [d.path, d.text]))
  const problems: string[] = []
  for (const doc of docs) {
    const dir = posix.dirname(doc.path)
    for (const { line, target } of markdownLinks(doc.text)) {
      const external = /^[a-z][a-z0-9+.-]*:/i.test(target)
      let path: string
      let fragment: string
      if (external) {
        const local = githubLocalTarget(target)
        if (!local) continue
        path = local.path
        fragment = local.fragment
      } else {
        if (target.startsWith('/')) continue
        const hash = target.indexOf('#')
        const rawPath = hash === -1 ? target : target.slice(0, hash)
        fragment = hash === -1 ? '' : decodeURIComponent(target.slice(hash + 1))
        path = rawPath === '' ? doc.path : posix.normalize(posix.join(dir, rawPath))
      }
      if (isGenerated(path)) continue
      if (!fileExists(path)) {
        problems.push(`${doc.path}:${line} → ${target}（文件不在场）`)
        continue
      }
      if (fragment === '') continue
      const text = byPath.get(path)
      if (text === undefined) {
        problems.push(`${doc.path}:${line} → ${target}（目标不是 Markdown，不能校标题锚点）`)
        continue
      }
      if (!headingSlugs(text).has(fragment)) {
        problems.push(`${doc.path}:${line} → ${target}（标题锚点不在场）`)
      }
    }
  }
  return problems
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
  it('编号连续不重号（改名重排会留下断号，断号即有人抄不到那一页）', () => {
    expect(ADRS.length, '一篇 ADR 都没扫到？').toBeGreaterThan(5)
    const nums = ADRS.map((f) => Number(/^docs\/adr\/(\d{4})-/.exec(f)![1]))
    expect(nums.some(Number.isNaN), 'ADR 文件名必须是 NNNN-slug.md').toBe(false)
    const sorted = [...nums].sort((a, b) => a - b)
    const gaps: string[] = []
    for (let n = sorted[0]; n <= sorted[sorted.length - 1]; n++) if (!sorted.includes(n)) gaps.push(String(n))
    expect(gaps, `断号：${gaps.join(', ')}（只许追加，不许重排）`).toEqual([])
  })

  it('每篇第一行是标题、并点名锚点', () => {
    const bad = ADRS.filter((f) => {
      const text = readFileSync(join(ROOT, f), 'utf8')
      return !/^# \S/.test(text) || !text.includes('锚点：')
    })
    expect(bad, `缺标题或缺「锚点：」那一行：${bad.join(', ')}`).toEqual([])
  })

  it('每篇紧跟标题有 Status 行', () => {
    const bad = ADRS.filter((f) => {
      const lines = readFileSync(join(ROOT, f), 'utf8').split(/\r?\n/)
      return !/^Status: (accepted|superseded by \d{4})$/.test(lines[2] ?? '')
    })
    expect(bad, `缺 Status 或状态不合规：${bad.join(', ')}`).toEqual([])
  })
})

describe('文档骨架与 ADR 规范', () => {
  it('核心文档在场', () => {
    const required = [
      'AGENTS.md',
      'README.md',
      'CONTEXT.md',
      'CONTRIBUTING.md',
      'CHANGELOG.md',
      'docs/AGENTS.md',
      'docs/architecture.md',
      'docs/development.md',
      'docs/adr/README.md',
      'docs/adr/ADR-FORMAT.md',
    ]
    const missing = required.filter((f) => !existsSync(join(ROOT, f)))
    expect(missing, `缺少核心文档：${missing.join(', ')}`).toEqual([])
  })

  it('根 AGENTS 在 8,000 字符预算内', () => {
    const text = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8')
    const chars = [...text].length
    expect(chars, `AGENTS.md ${chars} 字符；超过 8,000 先搬迁或压缩，提额要写理由`).toBeLessThanOrEqual(8000)
  })

  it('根 AGENTS 指向文档规范与开发手册', () => {
    const text = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8')
    expect(text).toContain('docs/AGENTS.md')
    expect(text).toContain('docs/development.md')
  })
})

describe('ADR 索引与文件一一对应', () => {
  it('合成样品：缺行、悬空行都会被点名', () => {
    const index = '| `0001` | a |\n| `0003` | c |\n| `0005` | e |\n'
    const files = ['0001-a.md', '0002-b.md', '0003-c.md', '0004-d.md']
    expect(adrIndexProblems(index, files)).toEqual([
      '索引缺少 ADR 0002',
      '索引缺少 ADR 0004',
      '索引指向不存在的 ADR 0005',
    ])
  })

  it('真实索引覆盖全部 ADR（新增不补索引即红）', () => {
    const index = readFileSync(join(ROOT, 'docs/adr/README.md'), 'utf8')
    const problems = adrIndexProblems(index, ADRS.map((f) => f.slice(f.lastIndexOf('/') + 1)))
    expect(problems, problems.join('\n')).toEqual([])
  })
})

describe('Markdown 链接与标题锚点', () => {
  const docs: DocFile[] = [
    {
      path: 'README.md',
      text: '# 标题\n[ok](docs/guide.md#小标题)\n[bad](docs/missing.md)\n[bad-anchor](docs/guide.md#不存在)\n```md\n[ignored](docs/missing.md)\n```\n`[inline](docs/missing.md)`\n[ext](https://example.com/x)',
    },
    { path: 'docs/guide.md', text: '# 小标题\n' },
  ]

  it('合成样品：坏路径与坏锚点会被点名，代码围栏与外链不算', () => {
    const problems = linkProblems(docs, (p) => docs.some((d) => d.path === p))
    expect(problems).toEqual([
      'README.md:3 → docs/missing.md（文件不在场）',
      'README.md:4 → docs/guide.md#不存在（标题锚点不在场）',
    ])
  })

  it('标题 slug 与 GitHub 口径一致', () => {
    const slugs = headingSlugs('# 本地书格式（TXT / EPUB）\n## AI 助手工具\n')
    expect([...slugs].sort()).toEqual(['ai-助手工具', '本地书格式txt--epub'])
  })

  it('真实文档的 Markdown 链接与锚点在册', () => {
    const all = FILES.map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') }))
    const problems = linkProblems(all, (p) => existsSync(join(ROOT, p)))
    expect(problems, problems.join('\n')).toEqual([])
  })
})
