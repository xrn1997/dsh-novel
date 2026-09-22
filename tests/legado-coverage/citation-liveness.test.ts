/**
 * **引用活性守卫**：仓里每一个指向「别处的文件」的引用，都必须能被读者在**他自己有的东西**里查到。
 *
 * 为什么要单独一道门（2026-09-22 实证）：兼容判据的分母原先写成
 * `.superpowers/legado-ref-inventory.md`——一份不入库的手抄笔记。笔记一消失，那道「清单加节即报红」
 * 的检查就静默转 skip，读数从 `1338 passed | 3 skipped` 变成 `1337 | 4`，而**没有任何东西变红**。
 * 同一族病还有对面侧：`matrix.ts` 一行指着 `BookContent.kt:164-186`，而对面上名叫
 * `BookContent.kt` 的文件有两份，其中 `help/book/BookContent.kt` 只有 18 行——那条引用从来没指向过
 * 它声称的那段代码（真身在 `model/webBook/BookContent.kt`）。
 *
 * 四条断言：
 * ① 对面 Kotlin 引用必须写成**带目录的相对路径**（相对 `app/src/{main,test}/java/io/legado/app/`），
 *    且在参考仓里真实存在——光凭文件名不算，因为对面有同名文件。
 * ② 任何引用都**不许带行号**（`.kt:164-186` / `.ts:787-792` 同理）：行号随对面合并上游、
 *    随本仓加注释即漂移，且没有任何自动化守得住（AGENTS.md 同一条纪律，这里补机器那一半）。
 *    要精确定位就写**可 grep 的代码原文**（`val titleRule = contentRule.title`）。
 * ③ 仓内出现的 `.superpowers/...` 只允许是 OUTPUT_DIRS 里登记过的**工具输出目录**；
 *    把不入库笔记当证据即红——正确做法是把读数写进文档本身，或引对面仓 / 仓内存活文件。
 * ④ 参考仓不在场即**红**（不静默 skip）：这台机器上它一直在，换机器的人被点名一次即可解决。
 *
 * 参考仓路径：`DSH_LEGADO_REF`，默认 `C:/develop/GitHub/legado-with-MD3`。
 * 显式 `DSH_LEGADO_REF=off` 才允许跳过断言①，且跳过会被写进用例名里。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
/** 对面参考实现默认位置（本地 checkout，非入库内容） */
const DEFAULT_REF = 'C:/develop/GitHub/legado-with-MD3'
const REF = process.env.DSH_LEGADO_REF ?? DEFAULT_REF
const REF_OFF = REF === 'off'

/** 对面源码根：主源与测试源都要认（`AnalyzeRuleFastPathReproTest.kt` 只在测试源根） */
const UPSTREAM_ROOTS = [
  'app/src/main/java/io/legado/app',
  'app/src/test/java/io/legado/app',
]

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

/** 参与扫描的文本文件：仓内跟踪的 md/ts/tsx/mjs（lib 与 node_modules 除外） */
function trackedTextFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(p => p && TEXT_EXT.test(p))
  return out
}

function rel(p: string): string {
  return p.split(path.sep).join('/')
}

/** 对面文件解析：先按「带目录的相对路径」精确查，再退到按源根拼接；命中即返回该根下的相对路径 */
function resolveUpstream(cited: string): string | null {
  for (const root of UPSTREAM_ROOTS) {
    const abs = path.resolve(REF, root, cited)
    if (fs.existsSync(abs)) return `${root}/${cited}`
  }
  return null
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

  const upstream = REF_OFF ? it.skip : it
  upstream(`对面 Kotlin 引用带目录且在 ${REF} 里真实存在`, () => {
    if (!fs.existsSync(REF)) {
      throw new Error(
        `对面参考仓不在场：${REF}\n` +
        '  兼容判据要以它为分母，不能静默降级——请 checkout legado-with-MD3 并设 DSH_LEGADO_REF，' +
        '或显式 DSH_LEGADO_REF=off（跳过会记在用例名里）。',
      )
    }
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
        bad.push(`${c}：只有文件名，对面有同名文件（如 BookContent.kt 有两份），必须带相对源根的目录`)
        continue
      }
      if (!resolveUpstream(c)) bad.push(`${c}：${REF} 的两个源根下都没有这个文件`)
    }
    expect(bad, bad.join('\n  ')).toEqual([])
  })
})
