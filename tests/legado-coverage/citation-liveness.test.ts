/**
 * **引用活性守卫**：仓里每个指向「别处的文件」的引用，都必须能被读者在**他自己有的东西**里查到。
 * 教训（2026-09-22）：兼容判据的分母曾写在不入库的手抄笔记里，笔记一消失检查静默转 skip、
 * 没有任何东西变红——**证据必须落在读者拿得到的地方**。
 *
 * 四条断言：
 * ① 对面 Kotlin 引用写**带目录的相对路径**（相对 `app/src/{main,test}/java/io/legado/app/`）且在
 *    仓内快照的路径集里——光文件名不算，对面有同名文件。
 * ② 引用**不许带行号**（`.kt:164-186` 同理）：行号必漂且没有自动化守得住——精确定位写可 grep 的原文。
 * ③ `.superpowers/...` 只许是 OUTPUT_DIRS 登记过的工具输出目录——拿不入库的笔记当证据即红。
 * ④ 快照不在场即**红**不静默 skip：快照是入库内容，缺了是仓库坏了、不是环境缺东西。
 *
 * 快照是判据的分母：开发阶段从对面 checkout 抽一次，之后判据不依赖任何外部 checkout。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseOpenItems } from './known-open.js'
import { readSnapshot } from './upstream-facts.js'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * 允许在文档 / 代码里出现的 `.superpowers/` 路径——**只限工具自己写出的输出目录**。
 * 新增一条要连带写清是谁写的；这不是证据面，证据面必须落在仓内或对面仓。
 */
const OUTPUT_DIRS: Record<string, string> = {
  '.superpowers/content-audit/': '正文链路审计报告落盘处（tests/content-audit.test.ts 的 outDir）',
  '.superpowers/corpus/': '解析面普查的**第二分母**目录：README「解析面普查」节里现取的外部公开书源合集落盘处（第三方数据不入库，取法写在 README）',
  '.superpowers': 'AGENTS.md 讲「过程文档不入库」这条纪律时对本机目录的泛指',
}

const TEXT_EXT = /\.(?:md|ts|tsx|mjs)$/
/** 指向别处的文件引用：对面 .kt、本仓 .ts/.tsx/.mjs 与**文档 .md**，含可选行号后缀（行号即违规）。
 *  `.md` 必须在内——`AGENTS.md` 承诺「跟踪文本里的 `.md/.ts/.tsx/.mjs`，`file.ext:123` 形态即红」，
 *  漏掉 `.md` 就是门比承诺窄：跨文档的行号引用恰好最常出现在散文里。 */
const FILE_REF = /(?:^|[^A-Za-z0-9_./-])((?:[A-Za-z0-9_.\-]+\/)*[A-Za-z0-9_.\-]+\.(?:kt|ts|tsx|mjs|md))(:\d+(?:-\d+)?)?/g
const SUPERPOWERS_REF = /\.superpowers\/[A-Za-z0-9_.\-]*|\.superpowers/g
/** 本门自身：它得能照着规则**逐字写出**被判违规的形态（行号后缀、未登记路径、裸文件名），
 *  否则规则讲不清——所以整文件排除在扫描之外（两条涉及它的断言都按这一条跳过）。
 *  路径必须是正斜杠常量，**不能**用 `path.join`：Windows 上 path.join 给的是反斜杠，
 *  与 rel() 的规范化形式永不相等 ⇒ 排除静默失效、门开始自证其罪（2026-09-22 实测踩过）。 */
const SELF = 'tests/legado-coverage/citation-liveness.test.ts'

/** 参与扫描的文本文件：**跟踪的 + 未跟踪但未忽略的** md/ts/tsx/mjs。带上未跟踪是因为只扫
 *  `git ls-files` 时新写的文件提交前扫不到——守卫要拦的正是「刚敲进去的那句出处」（本门踩过）。 */
function trackedTextFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(p => p && TEXT_EXT.test(p))
  return out
}

function rel(p: string): string {
  return p.split(path.sep).join('/')
}

/**
 * 命中判定按**路径段**比较，且区分两种登记：
 * - 以 `/` 结尾 = 目录级，放行其下任意文件名（工具自己写的输出目录）；
 * - 不以 `/` 结尾 = 只放行这一个词本身（纪律条文的泛指），**不许**借它放行任意子路径。
 */
function allowedBy(hit: string, entry: string): boolean {
  const bare = entry.replace(/\/$/, '')
  return entry.endsWith('/')
    ? hit === bare || hit.startsWith(entry)
    : hit === bare || hit === `${bare}/`
}

describe('引用活性（仓内每个外部引用都能现查）', () => {
  const files = trackedTextFiles()

  /** 全仓出现的 .superpowers 命中（按文件缓存一次） */
  const superpowersHits = files.filter(f => rel(f) !== SELF).flatMap(f => {
    const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/)
    return lines.flatMap((line, i) => [...line.matchAll(SUPERPOWERS_REF)].map(m => ({ at: `${f}:${i + 1}`, hit: m[0] })))
  })

  it('扫描面非空（至少扫到文档与测试）', () => {
    // 扫描面曾经算错一层（ROOT 指到 tests/），门只在子树上跑、全绿的假象——两侧都钉住
    expect(files.length).toBeGreaterThan(150)
    expect(files.filter(f => f.startsWith('docs/')).length).toBeGreaterThan(3)
    expect(files.filter(f => f.startsWith('src/')).length).toBeGreaterThan(20)
  })

  it('没有任何引用带行号后缀——行号必漂，要精确定位就写可 grep 的原文', () => {
    const bad: string[] = []
    for (const f of files) {
      if (rel(f) === SELF) continue
      // docs/reference/ 是宿主 API 的转写件：那里的行号指宿主发布物，属外部事实记录，另议
      if (f.startsWith('docs/reference/')) continue
      const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/)
      lines.forEach((line, i) => {
        for (const m of line.matchAll(FILE_REF)) {
          if (m[2]) bad.push(`${f}:${i + 1} → ${m[1]}${m[2]}`)
        }
      })
    }
    expect(bad, bad.join('\n  ')).toEqual([])
  })

  it('仓内 .superpowers/ 引用只能是登记过的工具输出目录', () => {
    const registered = Object.keys(OUTPUT_DIRS)
    const bad = superpowersHits
      .filter(({ hit }) => !registered.some(e => allowedBy(hit, e)))
      .map(({ at, hit }) => `${at} → ${hit}（未登记；若这是工具输出目录，请把目录加进 OUTPUT_DIRS 并写明谁写它；若这是证据引用，请改成仓内锚点或对面仓的带目录路径）`)
    expect(bad, bad.join('\n  ')).toEqual([])
  })

  it('输出目录登记表里没有僵尸条目（每条都还在被引用）', () => {
    const zombie = Object.keys(OUTPUT_DIRS).filter(e => !superpowersHits.some(({ hit }) => allowedBy(hit, e)))
    expect(zombie, `已无人引用：${zombie.join(' / ')}（请连同理由一并删掉，别留着当地图）`).toEqual([])
  })

  /** 「对面 `.kt` 引用」的白名单——正文纪律的机器那一半，白名单外出现 `.kt` 即红。
   *  四处各司其职（README 致谢 / 矩阵对照面 / 裁决表 / 快照刷新工具），本门自身也在名单里：
   *  它得能逐字写出被判违规的形态。 */
  const UPSTREAM_CITATION_ALLOWED = [
    'README.md',
    'tests/legado-coverage/matrix.ts',
    'docs/design/legado-compat.md',
    'tests/legado-coverage/upstream-facts.ts',
    'tests/legado-coverage/capture-upstream-snapshot.test.ts',
    SELF,
  ]

  it('对面 .kt 引用只许出现在四处（外部出处白名单）', () => {
    const bad: string[] = []
    for (const f of files) {
      if (UPSTREAM_CITATION_ALLOWED.includes(rel(f))) continue
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8')
      for (const m of text.matchAll(FILE_REF)) {
        if (m[1].endsWith('.kt')) bad.push(`${rel(f)} → ${m[1]}`)
      }
    }
    expect(
      bad,
      `外部出处只许出现在：${UPSTREAM_CITATION_ALLOWED.join(' / ')}\n` +
      '  其余地方讲本仓口径与理由，要给出处就指矩阵行 id。违规：\n  ' + bad.join('\n  '),
    ).toEqual([])
  })

  /** 对面**符号名**（R2 的另一半）：白名单外同样不许出现。规则实体类名从**快照**取（机械、
   *  不会漂），其余是判据文档里出现过的上游类型名；加这条前白名单外 0 处，误报面为零。 */
  const UPSTREAM_SYMBOLS = [
    ...Object.keys(readSnapshot().ruleFields),
    'AnalyzeUrl', 'AnalyzeRule', 'AnalyzeByJSoup', 'AnalyzeByJSonPath', 'AnalyzeByRegex', 'AnalyzeByXPath',
    'JsExtensions', 'StrResponse', 'AppPattern', 'BaseSource', 'BookChapterList', 'BookContent',
  ]

  it('对面符号名同样只许出现在四处（外部出处白名单）', () => {
    const bad: string[] = []
    for (const f of files) {
      if (UPSTREAM_CITATION_ALLOWED.includes(rel(f))) continue
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8')
      for (const s of UPSTREAM_SYMBOLS) {
        if (new RegExp(`\\b${s}\\b`).test(text)) bad.push(`${rel(f)} → ${s}`)
      }
    }
    expect(
      bad,
      `外部出处只许出现在：${UPSTREAM_CITATION_ALLOWED.join(' / ')}\n` +
      '  其余地方讲本仓口径与理由（要给出处就指矩阵行 id）。违规：\n  ' + bad.join('\n  '),
    ).toEqual([])
  })

  it('对面 Kotlin 引用带目录，且能在仓内快照里现查', () => {
    const paths = new Set(readSnapshot().paths)
    const cited = new Set<string>()
    for (const f of files) {
      if (rel(f) === SELF) continue
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8')
      for (const m of text.matchAll(FILE_REF)) {
        if (m[1].endsWith('.kt')) cited.add(m[1])
      }
    }
    expect(cited.size).toBeGreaterThan(5) // 防正则退化把断言扫成空
    const bad: string[] = []
    for (const c of [...cited].sort()) {
      if (!c.includes('/')) {
        bad.push(`${c}：只有文件名，同名文件在对面不止一份，必须带相对源根的目录`)
        continue
      }
      if (!paths.has(c)) bad.push(`${c}：快照的路径集里没有这个文件（刷新快照，或改指仓内存活文件）`)
    }
    expect(bad, bad.join('\n  ')).toEqual([])
  })

  it('按编号引用「已知开口第 N 条」的，那个号必须还存在（编号漂移＝静默指错东西）', () => {
    // 行号必漂，**列表编号**是同一种脆弱：重排某一节后「第 N 条」的引用不会报找不到，而是**指向
    // 另一条**——删已收口条目时「留空洞不重排」的判断不该靠下一个人记得，所以钉成门。
    const RE = /(engine|services|client|legado-compat)\.md[^\n]{0,40}?已知开口第\s*(\d+)\s*条/g
    const cache = new Map<string, Set<string> | null>()
    // 编号表从 known-open.parseOpenItems 派生（与 coverage 同一份解析器）——自己再扫一遍「## 已知
    // 开口」会与它口径漂（首/末标题、何时停都漂过）。
    const numberingOf = (doc: string): Set<string> | null => {
      if (cache.has(doc)) return cache.get(doc) ?? null
      const p = path.join(ROOT, 'docs', 'design', `${doc}.md`)
      if (!fs.existsSync(p)) { cache.set(doc, null); return null }
      const items = parseOpenItems(fs.readFileSync(p, 'utf8'))
      const nums = items === null ? null : new Set(items.map((it) => it.num))
      cache.set(doc, nums)
      return nums
    }

    const bad: string[] = []
    let citations = 0
    for (const f of trackedTextFiles()) {
      if (rel(f) === SELF) continue
      const text = fs.readFileSync(f, 'utf8')
      for (const m of [...text.matchAll(RE)]) {
        citations++
        const nums = numberingOf(m[1])
        if (nums === null) { bad.push(`${rel(f)}：引了 ${m[1]}.md 的编号，但那一份文档没有「已知开口」节`); continue }
        if (!nums.has(m[2])) bad.push(`${rel(f)}：${m[1]}.md 已知开口没有第 ${m[2]} 条（现有编号：${[...nums].join(', ')}）`)
      }
    }
    expect(citations, '一条按编号的引用都没扫到，判据在空转').toBeGreaterThan(5)
    expect(bad, bad.join('\n  ')).toEqual([])
  })
})
