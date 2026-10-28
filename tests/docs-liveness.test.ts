/**
 * **文档门（三件套之一）**：文档与代码注释里点名的仓内路径必须真实存在，已废的文档称呼不再出现，
 * 指路的 `§N` 必须点名一个还活着的家，ADR 的编号、索引、状态与锚点各只有一份形态。
 *
 * 为什么用它：本仓的不变量是「一条事实只住一个家」，而文档里到处是指向那个家的路径与小节号。
 * 模块改名、符号搬家、路由判据换文件时，代码与测试会跟着红，**文档不会**——它只会留下一个
 * 指不到东西的名字，而下一个 agent 恰好只读文档。所以这条门是确定性的、可重跑的。
 *
 * 三条配套判据各管一段，别合并：
 * - `tests/context-terms.test.ts`：`CONTEXT.md` 点名的符号能不能现查得到；
 * - `tests/comment-altitude.test.ts`：代码注释是不是在抄代码；
 * - 本文件：**全部手写文档**的路径、引用形态、职责边界与 ADR 形状。
 *
 * 两类例外要写明理由再进白名单：留在 ADR 里的「当时」坐标，与看着像路径其实不是路径的串。
 * 白名单不是「改不动就跳过」——那种条目应当改文档。死名没有豁免。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')

/** 报错信息里用相对路径，别把这台机器的绝对路径打进测试输出。 */
function rel(file: string): string {
  return file.slice(ROOT.length + 1).replace(/\\/g, '/')
}

/** 生成快照与构建产物不是判据的家；`lib` 与 `.qoder` 一律不进语料。 */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'lib' || entry === '.git' || entry === '.qoder') continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(md|ts|tsx|css)$/.test(entry)) out.push(p)
  }
  return out
}

/**
 * 被测的是手写的那几份 + 代码注释；生成的 `.qoder/repowiki` 不在内。
 * 自排除：本文件正文引用着被禁的称呼与历史文件名，扫自己必然自红。这是唯一的自排除。
 */
const targets = [
  join(ROOT, 'AGENTS.md'),
  join(ROOT, 'CONTEXT.md'),
  join(ROOT, 'README.md'),
  join(ROOT, 'CONTRIBUTING.md'),
  join(ROOT, 'CHANGELOG.md'),
  ...walk(join(ROOT, 'docs')),
  ...walk(join(ROOT, 'src')),
  ...walk(join(ROOT, 'tests')),
].filter((f) => f !== join(ROOT, 'tests', 'docs-liveness.test.ts'))

/** 一次读进来，下面几道门共用这份语料。 */
const corpus = targets.map((file) => ({
  file,
  lines: readFileSync(file, 'utf8').split(/\r?\n/),
}))

/** 手写文档（根文档 + docs/**）；结构门只看这些，src/tests 的注释不参与。 */
const rootDocs = new Set([
  join(ROOT, 'AGENTS.md'),
  join(ROOT, 'CONTEXT.md'),
  join(ROOT, 'README.md'),
  join(ROOT, 'CONTRIBUTING.md'),
  join(ROOT, 'CHANGELOG.md'),
])
const docsRoot = join(ROOT, 'docs') + sep
const docCorpus = corpus.filter(({ file }) => rootDocs.has(file) || file.startsWith(docsRoot))

function eachLine(visit: (file: string, line: string, index: number) => void): void {
  for (const { file, lines } of corpus) lines.forEach((line, index) => visit(file, line, index))
}

/** 指向仓内文件的相对路径：`src/…`、`tests/…`、`docs/…`、`locale/…`。 */
const PATH_REF = /(?:^|[^A-Za-z0-9_./~-])(src|tests|docs|locale)\/([A-Za-z0-9_\-./]*)/g
/** 反引号里带目录的裸相对路径：`tools/shelf-item.ts` 省掉 `src/` 的写法，先按仓根、再按 `src/` 解析。 */
const BACKTICK_REL = /`([A-Za-z0-9_-]+\/[A-Za-z0-9_./-]*\.(?:ts|tsx|js|mjs|cjs|json|md|yml|yaml))`/g

/** 看着像路径、其实不是路径，或故意保留的历史名。每条都要有理由。 */
const ALLOWED: Record<string, string> = {}
/** 判据自身的负控夹具：这些文件在内存里搭合成依赖图，写的不是仓内路径。 */
const SYNTHETIC = new Set([join(ROOT, 'tests', 'layering.test.ts')])

/** 已废的称呼：批次号、已改名的开发手册、以及它们的「复核候选」编号——都没有可查的坐标了。 */
const DEAD_NAMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/docs\/developing\.md/, '开发手册统一为 docs/development.md'],
  [/现状稿/, '现状住 `docs/architecture.md`；「现状稿」这个名字已废'],
  [/第\s*[0-9一二三四五六七八九十百零Nn]+\s*批/, '批次号没有可查的坐标；引用历史写日期，有 commit 就带上，要指裁决就指 ADR 篇号'],
  [/设计稿\s*§|稿\s*§/, '「设计稿 §N」指向已删的批次日志；改指还活着的家'],
  [/复核候选/, '候选编号随批次日志一起删了；要指裁决就指 ADR 篇号，要指判据就指文件或测试'],
  [/`docs\/adr\/\d{4}/, 'ADR 互引统一写 `ADR-NNNN`；文件路径只写 `docs/adr/` 或 `docs/adr/README.md`'],
  [/\.superpowers\/[A-Za-z0-9_-]+\/?[A-Za-z0-9_.-]*\.(?:md|json|ts|js|cjs|mjs)/, '本机过程产物不是可回查的出处'],
]

/** 每个 `§N` 指路必须点名一个还活着的家（本节内部则写「本文 §N」）。 */
const SECTION_REF = /§\s*\d/
const SECTION_ANCHORS = ['docs/architecture.md', 'architecture.md', 'docs/ui-spec.md', 'ui-spec.md', 'ui-spec', '本文']
/** 行号引用：`file.ext:123` 会随任何一次编辑漂移，要指实现就指符号锚。 */
const LINE_REF = /\b[A-Za-z0-9_./-]+\.(?:ts|tsx|js|mjs|json|md|yml):[0-9]+\b/g

/** 行号形态的引用。 */
function lineRefs(line: string): string[] {
  return [...line.matchAll(LINE_REF)].map((match) => match[0])
}

/**
 * 裸篇号的 ADR 互引：一行里已经出现全形 `ADR-NNNN`，同行的四位数 `00NN` 就是漏写前缀的第二枚——
 * 读者得自己猜那串数字是什么。`Status:` 行、索引首列与「已被 NNNN 取代」都不含全形，落不进这条判据。
 */
function bareAdrIds(line: string): string[] {
  if (!/\bADR-\d{4}\b/.test(line)) return []
  return [...line.matchAll(/(?<![\dA-Za-z.-])00\d{2}(?![-\d.])/g)].map((match) => match[0])
}

/** `§N` 在给定小节集合里找不到即 offender。 */
function missingSections(sections: Set<string>, line: string): string[] {
  return [...line.matchAll(/§\s*(\d+(?:\.\d+)*)/g)]
    .filter((match) => !sections.has(match[1]!))
    .map((match) => `§${match[1]}`)
}

/** 按文档解析编号小节；判据与正控共用这一份。 */
const sectionCache = new Map<string, Set<string>>()
function sectionsOf(doc: string): Set<string> {
  let found = sectionCache.get(doc)
  if (found === undefined) {
    found = numberedSections(doc)
    sectionCache.set(doc, found)
  }
  return found
}

interface CompatibilityManifest {
  engines?: { dsh?: string }
  dsh?: { compatibility?: { dshReleases?: Record<string, string> } }
}

function normalize(raw: string): string {
  // 中文句读与括号会紧跟在路径后面：剥掉尾部噪声
  return raw.replace(/[.,;:!?)\]}、。，；：）】」]+$/u, '')
}

function read(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8')
}

function pathExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

function stripFencedCode(markdown: string): string {
  return markdown.replace(/^```[\s\S]*?^```/gm, '')
}

function slugify(text: string): string {
  return text
    .trim()
    .replace(/<[^>]+>/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    // GitHub 口径：一个空格换一个连字符，不折叠。「TXT / EPUB」去掉斜杠后是两个空格 → 两个连字符。
    .replace(/\s/g, '-')
    .replace(/^-+|-+$/g, '')
}

function headingSlugs(markdown: string): Set<string> {
  const seen = new Map<string, number>()
  const slugs = new Set<string>()
  for (const line of stripFencedCode(markdown).split(/\r?\n/)) {
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (match === null) continue
    const base = slugify(match[1]!)
    const count = seen.get(base) ?? 0
    slugs.add(count === 0 ? base : `${base}-${count}`)
    seen.set(base, count + 1)
  }
  return slugs
}

/** 标题原文：中文小节名指路（`docs/development.md` 的「门（自动）」）也要指得到标题。 */
function headingTexts(markdown: string): string[] {
  return stripFencedCode(markdown)
    .split(/\r?\n/)
    .map((line) => /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1])
    .filter((text): text is string => text !== undefined)
}

function linkTargets(markdown: string): string[] {
  return [...stripFencedCode(markdown).matchAll(/\]\(([^)]+)\)/g)]
    .map((match) => match[1]!.split(/\s+/)[0]!)
    // `java["ajax"]("…")` 这类代码片段长得像链接；目标以引号开头的一律不算。
    .filter((target) => !/^["'“”‘’]/.test(target))
}

function decodeAnchor(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function brokenLinks(file: string, markdown: string): string[] {
  const broken: string[] = []
  const ownSlugs = headingSlugs(markdown)
  for (const target of linkTargets(markdown)) {
    if (/^(?:https?:|mailto:|tel:)/i.test(target)) continue
    if (target.startsWith('<')) continue
    const [rawPath = '', ...rawAnchor] = target.split('#')
    const anchor = rawAnchor.join('#')
    const path = rawPath.split('?')[0]!
    if (path === '') {
      if (anchor !== '' && !ownSlugs.has(decodeAnchor(anchor))) broken.push(`${rel(file)} → #${anchor}`)
      continue
    }
    const resolved = resolve(dirname(file), decodeAnchor(path))
    if (!pathExists(resolved)) {
      broken.push(`${rel(file)} → ${target}`)
      continue
    }
    if (anchor !== '' && resolved.endsWith('.md')) {
      const targetSlugs = headingSlugs(readFileSync(resolved, 'utf8'))
      if (!targetSlugs.has(decodeAnchor(anchor))) broken.push(`${rel(file)} → ${target}`)
    }
  }
  return broken
}

/** 文档里实际存在的编号小节（`## 1. ...` / `## 2.3 ...`）。 */
function numberedSections(relPath: string): Set<string> {
  const sections = new Set<string>()
  for (const line of read(relPath).split(/\r?\n/)) {
    const match = /^#{1,4}\s+(\d+(?:\.\d+)*)\.?\s/.exec(line)
    if (match) sections.add(match[1]!)
  }
  return sections
}

function exists(path: string): boolean {
  const candidates = [
    path,
    // 代码注释里的 ESM 请求带 `.js`，源文件是 `.ts` / `.tsx`
    path.replace(/\.js$/, '.ts'),
    path.replace(/\.js$/, '.tsx'),
    path.replace(/\.ts$/, '.tsx'),
  ]
  return candidates.some((c) => {
    try {
      const s = statSync(join(ROOT, c))
      return s.isFile() || s.isDirectory()
    } catch {
      return false
    }
  })
}

describe('文档门 · 指名的仓内路径必须存在', () => {
  it('扫描面非空（守卫不许对着空集合报绿）', () => {
    expect(corpus.length, '一个文件都没扫到？目录或后缀判据漂了').toBeGreaterThan(50)
    expect(docCorpus.length, '手写文档一份都没进语料？').toBeGreaterThan(10)
    expect(corpus.filter(({ file }) => rel(file).startsWith('docs/adr/')).length, 'ADR 一份都不在？').toBeGreaterThan(5)
  })

  it('文档与代码注释里点名的 src/tests/docs/locale 路径都指得到东西', () => {
    const broken: string[] = []
    eachLine((file, line, i) => {
      if (SYNTHETIC.has(file)) return
      for (const m of line.matchAll(PATH_REF)) {
        const raw = normalize(`${m[1]}/${m[2]}`)
        if (raw.includes('*') || raw.includes('<')) continue
        // 目录引用（尾斜杠）也要验：被删掉的家同样该红
        const path = raw.endsWith('/') ? raw.slice(0, -1) : raw
        if (path in ALLOWED) continue
        if (!exists(path)) broken.push(`${rel(file)}:${i + 1} → ${raw}`)
      }
    })
    expect(broken, `断链：\n${broken.join('\n')}`).toEqual([])
  })

  it('手写文档里反引号点名的裸路径也指得到东西', () => {
    const broken: string[] = []
    for (const { file, lines } of docCorpus) {
      for (const [i, line] of lines.entries()) {
        for (const m of line.matchAll(BACKTICK_REL)) {
          const p = m[1]!
          if (/^(?:\.{0,2}\/|https?:)/.test(p) || p.includes('*') || p.includes('<')) continue
          // 带前缀的路径已由上一枚判据管；这里只收裸相对路径。
          if (/^(?:src|tests|docs|locale|node_modules|compat)\//.test(p)) continue
          if (p in ALLOWED || `src/${p}` in ALLOWED) continue
          // 首段既不在仓根也不在 src/ 下 ⇒ 这是外部包的路径，不是本仓的。
          const first = p.split('/')[0]!
          if (!exists(first) && !exists(`src/${first}`) && !exists(`tests/${first}`)) continue
          if (exists(p) || exists(`src/${p}`) || exists(`tests/${p}`)) continue
          broken.push(`${rel(file)}:${i + 1} → ${p}`)
        }
      }
    }
    expect(broken, `悬空路径：\n${broken.join('\n')}`).toEqual([])
  })

  it('白名单里没有已经不再出现的僵尸条目', () => {
    const seen = new Set<string>()
    eachLine((_file, line) => {
      for (const m of line.matchAll(PATH_REF)) {
        const raw = normalize(`${m[1]}/${m[2]}`)
        const path = raw.endsWith('/') ? raw.slice(0, -1) : raw
        if (path in ALLOWED) seen.add(path)
      }
    })
    expect(Object.keys(ALLOWED).filter((key) => !seen.has(key)), '这些白名单条目已无对应引用，删掉它们').toEqual([])
  })
})

describe('文档门 · 引用形态纪律', () => {
  it('不许写行号（会随任何一次编辑漂移）', () => {
    const bad: string[] = []
    eachLine((file, line, i) => {
      for (const ref of lineRefs(line)) bad.push(`${rel(file)}:${i + 1} → ${ref}`)
    })
    expect(bad, `行号形态的引用（改指符号锚）：\n${bad.join('\n')}`).toEqual([])
  })

  it('「现状稿」「第 N 批」「设计稿 §N」「复核候选」都不再出现', () => {
    const offenders: string[] = []
    eachLine((file, line, i) => {
      for (const [pattern, why] of DEAD_NAMES) {
        const hit = pattern.exec(line)
        if (hit) offenders.push(`${rel(file)}:${i + 1} → ${hit[0]}\n    ${why}`)
      }
    })
    expect(offenders, `还在这样称呼的：\n${offenders.join('\n')}`).toEqual([])
  })

  it('每个 `§N` 指路都点名一个还活着的家', () => {
    const offenders: string[] = []
    // 只判手写文档：代码注释里的「XPath 1.0 §2.4」是外部规范编号，不需要本仓的指路纪律。
    for (const { file, lines } of docCorpus) {
      lines.forEach((line, i) => {
        if (!SECTION_REF.test(line)) return
        if (SECTION_ANCHORS.some((anchor) => line.includes(anchor))) return
        offenders.push(`${rel(file)}:${i + 1} → ${line.trim()}`)
      })
    }
    expect(
      offenders,
      '`§N` 单独出现指不到东西（小节号只在那一份文档里有序）。要指现状就写 `docs/architecture.md` §N，'
        + `要指判据就写文件。\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('ADR 互引都写 `ADR-NNNN` 且那篇在册', () => {
    const numbers = new Set(
      readdirSync(join(ROOT, 'docs', 'adr'))
        .filter((name) => /^\d{4}-.+\.md$/.test(name))
        .map((name) => name.slice(0, 4)),
    )
    const bad: string[] = []
    eachLine((file, line, i) => {
      for (const m of line.matchAll(/ADR-(\d{4})/g)) {
        if (!numbers.has(m[1]!)) bad.push(`${rel(file)}:${i + 1} → ${m[0]}（不在册）`)
      }
    })
    expect(bad, `悬空的 ADR 互引：\n${bad.join('\n')}`).toEqual([])
  })

  it('ADR 互引不写不带连字符的 `ADR NNNN`', () => {
    const bad: string[] = []
    eachLine((file, line, i) => {
      const hit = /\bADR[ \t]+\d{4}\b/.exec(line)
      if (hit) bad.push(`${rel(file)}:${i + 1} → ${hit[0]}`)
    })
    expect(bad, `ADR 互引统一写 \`ADR-NNNN\`：\n${bad.join('\n')}`).toEqual([])
  })

  // 一行里已经出现全形，同行的裸 00NN 就是漏了前缀的第二枚互引——读者得自己猜那串数字是什么。
  // 误伤面：`Status:` 行、索引首列与「已被 NNNN 取代」都不含全形，因此不在这一判据的语料里。
  it('ADR 互引不写裸篇号（`ADR-0032` / `0033` 这类）', () => {
    const bad: string[] = []
    eachLine((file, line, i) => {
      for (const bare of bareAdrIds(line)) bad.push(`${rel(file)}:${i + 1} → ${bare}（写全 \`ADR-${bare}\`）`)
    })
    expect(bad, `裸篇号的 ADR 互引：\n${bad.join('\n')}`).toEqual([])
  })

  it('判据认得出行号引用、裸篇号与死小节号（正控）', () => {
    expect(lineRefs('归属见 `client/panel-shelf.ts:9`'), '个位数的行号也要红').not.toEqual([])
    expect(bareAdrIds('见 `ADR-0032` / `0033`')).toEqual(['0033'])
    expect(bareAdrIds('见 `ADR-0032` / `ADR-0033`'), '全形不算裸篇号').toEqual([])
    expect(bareAdrIds('Status: superseded by 0048'), 'ADR-FORMAT 定义的 Status 形态不算互引').toEqual([])
    expect(missingSections(new Set(['1', '2']), '运行参数走配置卡（本文 §5）')).toEqual(['§5'])
    expect(missingSections(sectionsOf('docs/ui-spec.md'), '本文 §5')).toEqual([])
  })
})

describe('文档门 · 职责边界', () => {
  // 只认小节标题（`##` 及更深）；H1 是篇名，篇名里提一句主题不算第二份。
  it('“唯一主人清单”标题只出现在 architecture.md', () => {
    const offenders = docCorpus
      .filter(({ file, lines }) => rel(file) !== 'docs/architecture.md'
        && lines.some((line) => /^#{2,4}\s.*唯一主人清单/.test(line)))
      .map(({ file }) => rel(file))
    expect(offenders, '主人清单只能有一份；CONTEXT 只定义词，不重复归属').toEqual([])
  })

  it('“界面规格”标题只出现在 docs/ui-spec.md', () => {
    const offenders = docCorpus
      .filter(({ file, lines }) => rel(file) !== 'docs/ui-spec.md'
        && lines.some((line) => /^#{2,4}\s.*界面规格/.test(line)))
      .map(({ file }) => rel(file))
    expect(offenders, '界面规格是一个独立文档；architecture 只留指针').toEqual([])
  })

  it('“文档规范”标题只出现在 docs/AGENTS.md', () => {
    const offenders = docCorpus
      .filter(({ file, lines }) => rel(file) !== 'docs/AGENTS.md'
        && lines.some((line) => /^#{2,4}\s.*文档规范/.test(line)))
      .map(({ file }) => rel(file))
    expect(offenders, '文档分层与生命周期只能有一份').toEqual([])
  })

  it('AGENTS.md 是入口，不是仓库手册', () => {
    const chars = [...read('AGENTS.md')].length
    expect(chars, `AGENTS.md ${chars} 字符；超过 8,000 先搬迁或压缩，提额要写理由`).toBeLessThanOrEqual(8000)
  })

  it('点名的小节号在目标文档里真的存在', () => {
    // 用编号小节指路的就这两份；`本文 §N` 按说话那份自己的标题解析。
    const numbered = ['docs/architecture.md', 'docs/ui-spec.md']
    const offenders: string[] = []
    eachLine((file, line, i) => {
      const where = `${rel(file)}:${i + 1}`
      const named = numbered.filter((doc) => line.includes(doc.slice(doc.lastIndexOf('/') + 1)))
      // 一行同时点两份文档时不猜每个 § 归谁；分开写清楚再指。
      if (named.length === 1) {
        for (const dead of missingSections(sectionsOf(named[0]!), line)) offenders.push(`${where} → ${named[0]} ${dead}`)
      }
      const self = numbered.find((doc) => rel(file) === doc)
      if (self !== undefined && line.includes('本文')) {
        for (const dead of missingSections(sectionsOf(self), line)) offenders.push(`${where} → ${self} ${dead}`)
      }
    })
    expect(offenders, '小节号只在那份文档里有序；搬家或重排后要同步指路').toEqual([])
  })

  it('点名 development.md / AGENTS.md 的中文小节名真的存在', () => {
    const named: Array<[string, string[]]> = [
      ['docs/development.md', headingTexts(read('docs/development.md'))],
      ['AGENTS.md', headingTexts(read('AGENTS.md'))],
    ]
    const offenders: string[] = []
    eachLine((file, line, i) => {
      for (const [doc, headings] of named) {
        const escaped = doc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const pattern = new RegExp('(?<![A-Za-z0-9_./-])' + escaped + '`?[ \\t]*(?:的[ \\t]*)?「([^」]+)」', 'g')
        for (const match of line.matchAll(pattern)) {
          const name = match[1]!
          if (!headings.some((heading) => heading.includes(name))) {
            offenders.push(`${rel(file)}:${i + 1} → ${doc} 的「${name}」`)
          }
        }
      }
    })
    expect(offenders, `中文小节名指不到标题：\n${offenders.join('\n')}`).toEqual([])
  })
})

describe('文档门 · 文档分层与 ADR 形状', () => {
  it('文档标准存在，根 AGENTS 指向它', () => {
    expect(existsSync(join(ROOT, 'docs', 'AGENTS.md')), '文档分层与生命周期应住 docs/AGENTS.md').toBe(true)
    expect(read('AGENTS.md')).toContain('docs/AGENTS.md')
  })

  it('核心文档在场', () => {
    const required = [
      'AGENTS.md',
      'README.md',
      'CONTEXT.md',
      'CONTRIBUTING.md',
      'CHANGELOG.md',
      'docs/AGENTS.md',
      'docs/architecture.md',
      'docs/ui-spec.md',
      'docs/development.md',
      'docs/adr/README.md',
      'docs/adr/ADR-FORMAT.md',
      'docs/agents/issue-tracker.md',
      'docs/agents/triage-labels.md',
      'docs/agents/domain.md',
    ]
    const missing = required.filter((f) => !existsSync(join(ROOT, f)))
    expect(missing, `缺少核心文档：${missing.join(', ')}`).toEqual([])
  })

  const adrFiles = () => readdirSync(join(ROOT, 'docs', 'adr')).filter((name) => /^\d{4}-.+\.md$/.test(name))

  it('ADR 编号连续不重号（重排会留下断号，断号即有人抄不到那一页）', () => {
    const files = adrFiles()
    expect(files.length, 'ADR 目录没有扫到任何文件').toBeGreaterThan(0)
    const nums = files.map((name) => Number(name.slice(0, 4))).sort((a, b) => a - b)
    expect(new Set(nums).size, 'ADR 有重号').toBe(nums.length)
    const gaps: string[] = []
    for (let n = nums[0]!; n <= nums[nums.length - 1]!; n++) if (!nums.includes(n)) gaps.push(String(n))
    expect(gaps, `断号：${gaps.join(', ')}（只许追加，不许重排）`).toEqual([])
  })

  it('每个 ADR 都进索引，索引里也没有不存在的篇，且每篇恰好一行', () => {
    const files = adrFiles().map((name) => name.slice(0, 4))
    // 只认索引表第一列（`| `0001` | …`）：正文里互引别的 ADR 不算重复行。
    const listed = [...read('docs/adr/README.md').matchAll(/^\| `(\d{4})`/gm)].map((match) => match[1]!)
    expect(listed.length, 'ADR 索引没有解析出任何编号').toBeGreaterThan(0)
    expect(new Set(listed).size, 'ADR 索引里有重复行').toBe(listed.length)
    expect(files.filter((id) => !listed.includes(id)), '这些 ADR 没进 docs/adr/README.md').toEqual([])
    expect(listed.filter((id) => !files.includes(id)), '索引指向不存在的 ADR').toEqual([])
  })

  it('每个 ADR 第一行是标题、紧跟标题有 Status 行', () => {
    const bad: string[] = []
    for (const name of adrFiles()) {
      const lines = readFileSync(join(ROOT, 'docs', 'adr', name), 'utf8').split(/\r?\n/)
      if (!/^# .+/.test(lines[0] ?? '')) bad.push(`${name}: 缺标题`)
      if (!/^Status: (accepted|superseded by \d{4})$/.test(lines[2] ?? '')) bad.push(`${name}: 缺 Status 或状态不合规`)
    }
    expect(bad, bad.join('\n')).toEqual([])
  })

  it('每个 ADR 都以锚点段收尾（允许折行）', () => {
    const bad = adrFiles().filter((name) => {
      const blocks = readFileSync(join(ROOT, 'docs', 'adr', name), 'utf8')
        .split(/\r?\n\s*\r?\n/)
        .filter((block) => block.trim() !== '')
      return !/^锚点：/.test((blocks.at(-1) ?? '').trimStart())
    })
    expect(bad, `末段不是锚点：${bad.join(', ')}`).toEqual([])
  })
})

describe('文档门 · 兼容性事实单源', () => {
  const manifest = JSON.parse(read('package.json')) as CompatibilityManifest
  const releases = Object.keys(manifest.dsh?.compatibility?.dshReleases ?? {})
  const window = manifest.engines?.dsh

  /** 徽章只投影首末代次：全量枚举会随每次实测变长，完整名单由正文钉住。 */
  const badgeVersions = releases.length > 1 ? [releases[0]!, releases[releases.length - 1]!] : releases
  const badge = `DSH-${badgeVersions.map((version) => version.replaceAll('-', '--')).join('%20%E2%80%A6%20')}`

  const projectionDrift = (readme: string): string[] => {
    const snippets = [
      ...(window === undefined ? [] : [window]),
      ...releases,
      `${badge}-brightgreen`,
    ]
    return snippets.filter((snippet) => !readme.includes(snippet))
  }

  it('README 的窗口、真机名单与徽章都从 package.json 投影', () => {
    expect(releases.length, 'package.json 没有 dsh.compatibility.dshReleases').toBeGreaterThan(0)
    const drift = projectionDrift(read('README.md'))
    expect(drift, `README 与 package.json 不一致：\n${drift.join('\n')}`).toEqual([])
  })

  it('判据认得出漂移（正控）', () => {
    const drifted = read('README.md').replaceAll(releases[0]!, '0.0.0-not-real')
    expect(projectionDrift(drifted)).not.toEqual([])
  })

  it('AGENTS 只把 package.json 说成兼容性事实源', () => {
    const agents = read('AGENTS.md')
    expect(agents).toContain('事实源是 `package.json`')
  })
})

describe('文档门 · 相对链接与锚点', () => {
  it('手写文档里的相对链接与锚点都指得到东西', () => {
    const broken = docCorpus.flatMap(({ file, lines }) => brokenLinks(file, lines.join('\n')))
    expect(broken, `断链或死锚点：\n${broken.join('\n')}`).toEqual([])
  })

  it('判据认得出缺失文件与死锚点（正控）', () => {
    const readme = read('README.md')
    const missingFile = brokenLinks(join(ROOT, 'README.md'), `${readme}\n[x](definitely-missing.md)`)
    const missingAnchor = brokenLinks(join(ROOT, 'README.md'), `${readme}\n[x](#definitely-missing-anchor)`)
    expect(missingFile).not.toEqual([])
    expect(missingAnchor).not.toEqual([])
  })
})

describe('文档门 · 截图清单', () => {
  const manifest = JSON.parse(read('screenshots.json')) as string[]
  const images = [...read('README.md').matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)]
    .map((match) => /(docs\/screenshots\/[^)\s]+)/.exec(match[1]!)?.[1])
    .filter((path): path is string => path !== undefined)

  const drift = (found: string[], listed: string[]): string[] => {
    const a = [...new Set(found)].sort()
    const b = [...new Set(listed)].sort()
    return [
      ...a.filter((path) => !b.includes(path)).map((path) => `README 有、清册没有：${path}`),
      ...b.filter((path) => !a.includes(path)).map((path) => `清册有、README 没有：${path}`),
    ]
  }

  it('README 截图、screenshots.json、本地文件三者一致', () => {
    expect(images.length, 'README 没有引用任何截图').toBeGreaterThan(0)
    expect(images.length, 'README 截图重复').toBe(new Set(images).size)
    expect(manifest.length, 'screenshots.json 重复').toBe(new Set(manifest).size)
    const now = drift(images, manifest)
    expect(now, now.join('\n')).toEqual([])
    for (const path of manifest) expect(pathExists(join(ROOT, path)), path).toBe(true)
    // 反方向：本地多出来的图也必须进清单，否则它既没人引用、也不会被核对。
    const local = readdirSync(join(ROOT, 'docs', 'screenshots'))
      .filter((name) => /\.(png|jpe?g)$/i.test(name))
      .map((name) => `docs/screenshots/${name}`)
    expect(local.filter((path) => !manifest.includes(path)), '本地有、清单没有').toEqual([])
  })

  it('判据认得出漂移（正控）', () => {
    expect(drift([...images, 'docs/screenshots/extra.png'], manifest)).not.toEqual([])
    expect(drift(images, [...manifest, 'docs/screenshots/extra.png'])).not.toEqual([])
  })
})
