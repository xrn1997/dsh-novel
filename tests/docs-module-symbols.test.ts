import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { withoutComments } from './without-comments.js'

/**
 * 文档点名的**符号**必须现查得到——两层守卫，同一套抽取器与剥注释手法：
 * ① 三份设计文档模块表第三列的符号（改名/删除后表就指着不存在的东西，而它是接手者最先读的入口）；
 * ② `CONTEXT.md` 每条「唯一实现」句点名的记号（理由见第二个 describe）。
 * 病史：`detectTailJs` 删掉后注释还留着旧名，矩阵 `impl` 证据曾照绿——**模块表那侧当时没人管**，
 * 这里补上：符号必须在代码里现查到（注释不算命中）。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 三份模块表：文档 → 第一列路径的根（`engine/…`/`services/…` 相对 `src/`；client 表两种写法混排） */
const TABLES: Array<{ doc: string; root: string }> = [
  { doc: 'docs/design/engine.md', root: 'src' },
  { doc: 'docs/design/services.md', root: 'src' },
  { doc: 'docs/design/client.md', root: 'src/client' },
]

/** 方块里剥出候选符号：`foo(…)` 取 `foo`；`a.b/c` 拆成 `a.b` 与 `c`；`a、b` 已是两个方块 */
function symbolsOf(cell: string): string[] {
  const out: string[] = []
  for (const m of cell.matchAll(/`([^`]+)`/g)) {
    const body = m[1].replace(/\(.*$/, '').trim()          // `parseRule(rule, …)` → parseRule
    for (const part of body.split('/')) {
      const sym = part.trim().replace(/^\.+/, '')
      if (/^[A-Za-z_$][\w$]*(\.[\w$]+)*$/.test(sym)) out.push(sym)
    }
  }
  return out
}

/** 注释先剥掉（`tests/without-comments.ts` 单点）：口径是「代码里现查得到」，注释里提一句旧名字不算 */

/** src/ 递归收集 .ts/.tsx（两层守卫共用的文件收集口） */
function srcFiles(): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(entry.name)) files.push(p)
    }
  }
  walk(join(ROOT, 'src'))
  return files
}

/** 剥注释后的代码 haystack，**模块级惰性缓存**：两层守卫共享同一份扫描——
 *  此前每个 it 各自重读 100+ 文件、重剥、重拼（一次 pnpm test 白扫三遍全树）。 */
let srcHaystack: string | null = null
function srcCode(): string {
  if (srcHaystack === null) {
    srcHaystack = srcFiles().map((f) => withoutComments(readFileSync(f, 'utf8'))).join('\n')
  }
  return srcHaystack
}

/** 生产代码 = src/ 全部 .ts/.tsx + 仓库根的 .ts 配置（CONTEXT.md 层比模块表层宽一截，理由见下） */
let prodHaystack: string | null = null
function productionCode(): string {
  if (prodHaystack === null) {
    const rootFiles = readdirSync(ROOT).filter((f) => /\.ts$/.test(f)).map((f) => join(ROOT, f))
    expect(srcFiles().length + rootFiles.length, '生产代码文件过少，haystack 出问题了').toBeGreaterThan(60)
    prodHaystack = [srcCode(), ...rootFiles.map((f) => withoutComments(readFileSync(f, 'utf8')))].join('\n')
  }
  return prodHaystack
}

/** 模块表行：`| \`路径\` | 职责 | 符号列 | …`；非模块表行（分隔线、数据表）不匹配 */
function moduleRows(doc: string): Array<{ file: string; symbols: string[]; line: number }> {
  const text = readFileSync(join(ROOT, doc), 'utf8')
  const out: Array<{ file: string; symbols: string[]; line: number }> = []
  text.split('\n').forEach((line, i) => {
    const cells = line.split('|').map((c) => c.trim())
    // ['', 路径, 职责, 符号列, …, '']——路径与符号列都必须存在
    if (cells.length < 4) return
    const pathCell = cells[1]
    const m = /^`([^`]+)`$/.exec(pathCell)
    if (m === null) return
    // 只认**源码文件路径**：文档里另有若干表格第一列是命令/环境变量/概念（`DSH_REPROBE=1`、
    // 「不适用：…」锚点），它们第三列也有方块但语义不是符号列——按扩展名过掉。
    if (!/\.(ts|tsx|mjs)$/.test(m[1])) return
    const syms = symbolsOf(cells[3])
    if (syms.length === 0) return
    out.push({ file: m[1], symbols: syms, line: i + 1 })
  })
  return out
}

describe('模块表符号列必须现查得到（文档↔代码同源）', () => {
  it('三份模块表里都解析出了行与符号（守卫本身别空转）', () => {
    for (const { doc } of TABLES) {
      const rows = moduleRows(doc)
      expect(rows.length, `${doc} 没解析出模块表行`).toBeGreaterThan(3)
    }
  })

  it('每个符号都在 src/ 的代码里（注释不算）', () => {
    // 判据是「**文档不许指着不存在的符号**」，不是「符号必须住在这一行的那个文件里」——符号列
    // **允许点名别处的符号**（parse.ts 那行提到 literal.ts 的 `classifyExpr`，实现本就在那儿）。
    // 所以只看「全 src 里还找不找得到这个名字」，正好覆盖 detectTailJs 那一脚。
    const all = srcCode()

    const bad: string[] = []
    for (const { doc } of TABLES) {
      for (const row of moduleRows(doc)) {
        for (const sym of row.symbols) {
          if (!all.includes(sym.split('.')[0])) bad.push(`${doc}:${row.line}（${row.file} 行）找不到符号 ${sym}`)
        }
      }
    }
    expect(bad, `模块表指着不存在的符号（改名/删除后要同步文档）：\n${bad.join('\n')}`).toEqual([])
  })

  it('负断言：守卫自身有效——假符号在 src/ 里查不到（`detectTailJs` 那一脚同型）', () => {
    const all = srcCode()
    expect(all.includes('detectTailJs')).toBe(false)   // 已删的旧名：文档里再出现就该红
    expect(all.includes('classifyExpr')).toBe(true)    // 真符号：跨文件点名也照过
  })

  it('负断言：守卫自身有效——假行里的假符号会被抓出来', () => {
    const fake = '| `engine/types.ts` | 假 | `ZZNotASymbol`、`EngineValue` |'
    const row = { file: 'engine/types.ts', symbols: symbolsOf(fake.split('|').map((c) => c.trim())[3]), line: 1 }
    expect(row.symbols).toEqual(['ZZNotASymbol', 'EngineValue'])
    const code = withoutComments(readFileSync(join(ROOT, 'src/engine/types.ts'), 'utf8'))
    expect(code.includes('ZZNotASymbol')).toBe(false)
    expect(code.includes('EngineValue')).toBe(true)
  })
})

/**
 * **第二层：`CONTEXT.md` 的「唯一实现」指针也要现查得到**（2026-09-28 补）。词汇表是改口径前必读的
 * 第一份文档，此前只有路径面有门（`docs-references.test.ts`）、**符号名没人管**——同族里这处是空的。
 *
 * 判据只吃一句话的形状：含「唯一实现」的那句里、反引号括起来的记号 = **当下存在的实现指针**。
 * 比模块表侧多三道筛（正文会引用正则组号、文档与路径）：`$0`/`$n` 不是符号、`*.md|json` 是文档、
 * `*.ts(x)|*.mjs` 是路径（归 docs-references 管）。历史名字**不许穿反引号**——「原第四态 sliced 已删」
 * 是正当病史，写成 `` `sliced` `` 会被读成活指针（靠这条把旧名改成白文，而不是给门开豁免名单）。
 *
 * **为什么不往外扩**（2026-09-28 先量后决定，别顺手加）：同一套抽取器扫三份设计文档「已知开口」
 * 正文，164 个候选里 32 个查不到且**全是正当引用**（对面 Kotlin 名、平台与库 API、tests 里的符号、
 * 明写「实现里不存在」的名字）——扩过去就得养四类豁免表，那是本仓拒绝的失效模式。判据的力量来自
 * **只吃窄形状**：「唯一实现」句里的反引号自带契约，散文没有。haystack 比模块表层宽：`src/` 之外
 * 还算仓库根 `*.ts`（构建期守卫住在 `tsdown.config.ts`，词汇表点名它的 `resolveId` 是真实现位置）。
 */
describe('CONTEXT.md 的「唯一实现」指针必须现查得到', () => {
  /** 词条里的反引号记号 → 候选符号（在 symbolsOf 的标识符判据之上加三道筛） */
  function glossarySymbols(line: string): string[] {
    const out: string[] = []
    for (const raw of [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/\(.*$/, '').trim())) {
      if (/^\$/.test(raw)) continue                      // $0 / $n：正则组引用
      if (/\.(md|json|txt)$/i.test(raw)) continue       // 文档与数据
      if (/\.[jt]sx?$/i.test(raw)) continue             // 源码路径（docs-references 管）
      for (const s of symbolsOf('`' + raw + '`')) out.push(s)
    }
    return out
  }

  it('每个「唯一实现」句点名的符号都在生产代码里（注释不算）', () => {
    const all = productionCode()
    const lines = readFileSync(join(ROOT, 'CONTEXT.md'), 'utf8').split('\n')
    const bad: string[] = []
    let checked = 0
    lines.forEach((line, i) => {
      if (!line.includes('唯一实现')) return
      for (const sym of glossarySymbols(line)) {
        checked++
        if (!all.includes(sym.split('.')[0])) bad.push(`CONTEXT.md:${i + 1} 查不到 ${sym}`)
      }
    })
    // 守卫别空转：词汇表按形状应当有几十处活指针（实测 80）
    expect(checked, '「唯一实现」句里一个符号都没抽到，抽取器或词汇表形状变了').toBeGreaterThan(40)
    expect(bad, `词条指着不存在的符号（改名/删除后要同步词汇表）：\n${bad.join('\n')}`).toEqual([])
  })

  it('负断言：抽取器与判据都还咬得住——假符号被抓、三道筛各挡一类噪音', () => {
    const all = productionCode()
    expect(all.includes('detectTailJs'), '旧名已删，若词条还穿着反引号就该红').toBe(false)
    const noisy = '唯一实现在 `tsdown.config.ts` 的 `resolveId`（`$0` 与 `$n` 是组号、' +
      '`docs/reference/x.md` 是文档、`src/shared/wire.ts` 是路径）+ 平台表 `PLATFORM_MODULES`'
    expect(glossarySymbols(noisy)).toEqual(['resolveId', 'PLATFORM_MODULES'])
    expect(glossarySymbols(noisy).includes('wire'), '路径不该被当符号').toBe(false)
  })
})
