/**
 * **引用活性守卫**：仓里每一个指向「别处的文件」的引用，都必须能被读者在**他自己有的东西**里查到。
 *
 * 为什么要单独一道门（2026-09-22 实证）：兼容判据的分母原先写成一份**不入库的手抄笔记**。笔记一消失，
 * 那道「清单加节即报红」的检查就静默转 skip，读数从 `1338 passed | 3 skipped` 变成 `1337 | 4`，
 * 而**没有任何东西变红**。同一族病还有对面侧：矩阵里一条引用指着某个同名两份的文件（其中一份只是
 * 18 行的壳），那条引用从来没指向过它声称的那段代码。教训是同一条：**证据必须落在读者拿得到的地方**。
 *
 * 四条断言：
 * ① 对面 Kotlin 引用必须写成**带目录的相对路径**（相对 `app/src/{main,test}/java/io/legado/app/`），
 *    且那份文件在**仓内快照**（`compat/upstream/snapshot.json`）的路径集里——光凭文件名不算，
 *    因为对面有同名文件。
 * ② 任何引用都**不许带行号**（`.kt:164-186` / `.ts:787-792` 同理）：行号随被引方改版、
 *    随本仓加注释即漂移，且没有任何自动化守得住（AGENTS.md 同一条纪律，这里补机器那一半）。
 *    要精确定位就写**可 grep 的代码原文**。
 * ③ 仓内出现的 `.superpowers/...` 只允许是 OUTPUT_DIRS 里登记过的**工具输出目录**；
 *    把不入库笔记当证据即红——正确做法是把读数写进文档本身，或引仓内存活文件。
 * ④ 快照不在场即**红**（不静默 skip）：快照是入库内容，谁 clone 都拿得到——它缺了是仓库坏了，
 *    不是环境缺东西。
 *
 * 快照是判据的分母：开发阶段从对面 checkout 抽一次（`capture-upstream-snapshot.test.ts`），
 * 之后本仓判据不依赖任何外部 checkout。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readSnapshot } from './upstream-facts.js'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * 被引文件在不在册：查**仓内快照**的路径集（两个源根合并后按相对路径比对）。
 * 快照的路径是相对源根存的，与引用的书写形态（相对 `app/src/{main,test}/java/io/legado/app/`）逐字对应。
 */
function resolveUpstream(cited: string, paths: Set<string>): string | null {
  return paths.has(cited) ? cited : null
}

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
/** 指向别处的文件引用：对面 .kt 与本仓 .ts/.tsx/.mjs，含可选行号后缀（行号即违规） */
const FILE_REF = /(?:^|[^A-Za-z0-9_./-])((?:[A-Za-z0-9_.\-]+\/)*[A-Za-z0-9_.\-]+\.(?:kt|ts|tsx|mjs))(:\d+(?:-\d+)?)?/g
const SUPERPOWERS_REF = /\.superpowers\/[A-Za-z0-9_.\-]*|\.superpowers/g
/** 本门自身：它得能照着规则**逐字写出**被判违规的形态（行号后缀、未登记路径、裸文件名），
 *  否则规则讲不清——所以整文件排除在扫描之外（两条涉及它的断言都按这一条跳过）。
 *  路径必须是正斜杠常量，**不能**用 `path.join`：Windows 上 path.join 给的是反斜杠，
 *  与 rel() 的规范化形式永不相等 ⇒ 排除静默失效、门开始自证其罪（2026-09-22 实测踩过）。 */
const SELF = 'tests/legado-coverage/citation-liveness.test.ts'

/** 参与扫描的文本文件：**跟踪的 + 未跟踪但未被忽略的** md/ts/tsx/mjs（lib 与 node_modules 除外）。
 *  为什么带上未跟踪：只扫 `git ls-files` 时，一个**新写的**文件在提交前扫不到——守卫要拦的正是
 *  「刚敲进去的那句出处」，等到提交才生效等于放行一次（本门自己踩过：重构后新加的注释文件
 *  在 `git ls-files` 里缺席，白名单断言看不见它）。 */
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

  /** 允许出现「对面 `.kt` 引用」的白名单——正文纪律的机器那一半：其余任何跟踪文本里出现 `.kt` 即红。
   *  四处各司其职：`README.md`（致谢与门控说明）、覆盖矩阵（唯一的对照面）、`legado-compat.md`（裁决表）、
   *  快照刷新工具（上游事实抽取的实现与其常量）。本门自身也在名单里：它得能逐字写出被判违规的形态。 */
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

  /** 对面**符号名**（R2 的另一半）：白名单外同样一律不许出现。规则实体类名从**快照**取
   *  （机械、不会漂），其余几个是判据文档里出现过的上游类型名。误报面实测为零：加这条前
   *  全仓（含未跟踪）白名单外 0 处。 */
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
      if (!resolveUpstream(c, paths)) bad.push(`${c}：快照的路径集里没有这个文件（刷新快照，或改指仓内存活文件）`)
    }
    expect(bad, bad.join('\n  ')).toEqual([])
  })
})
