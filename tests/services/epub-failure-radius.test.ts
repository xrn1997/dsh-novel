import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FINDING_RADII } from '../../src/services/epub/findings.js'
import { withoutComments } from '../without-comments.js'

/**
 * 半径门：「整本书读不了」是导入面代价最高的动作，它发生在**哪几处**必须数得出来。
 *
 * 为什么要这张名册：判据的半径若由各层自判，新增一条判据的人会顺手按整本拒说话——同一个判据
 * 就抄进了多层，而真实书会因为一份文档、一条引用、一张图读不出而整本被拒。名册是**单向棘轮**：
 * 基线收建门当日的全部拒收点，后续每把一处半径降回它自己的主语，就从这里删一条；
 * **净加一条要写 ADR**。
 *
 * 名册登记的是**出口符号的调用点处数**（按文件），不是报错文本：`rejectBook` 是整本拒的唯一出口
 * （`errors.ts`），所以「哪里拒书」由调用点决定。措辞怎么改都不该让门红——反过来，门也不该
 * 因为有人重排了一句话就漏掉一处新加的拒书。扫描面是**整个 `src/`**：两个出口是导出的符号，
 * 只在子树里数会漏掉子树之外新造的那一处。
 *
 * 判据按剥注释后的源码查（`withoutComments`）：注释里提一嘴不算这里有拒收点——与兼容门
 * 「实现符号必须在剥注释后的代码里」同一口径，否则注释会成为第二份实现证据。
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const EPUB_DIR = 'src/services/epub'
/** 整本拒的名册看**整个源码树**：出口是导出的，子树之外再构造一处同样是「这条路多了一个入口」 */
const SRC_DIR = 'src'

/** 名册：每个文件里**有几处**整本拒（棘轮：只许减；净增一处要写 ADR） */
const BOOK_REJECTIONS: readonly { file: string; sites: number }[] = [
  { file: 'src/services/epub/archive.ts', sites: 18 },
  { file: 'src/services/epub/import.ts', sites: 3 },
  { file: 'src/services/epub/package.ts', sites: 35 },
  { file: 'src/services/epub/xml.ts', sites: 1 },
]

/** 出口所在的文件不数名册：它内部那一句就是这条唯一的路，由「书级异常只能在出口里构造」那条盯 */
const EXIT_HOME = 'src/services/epub/errors.ts'

/**
 * 整本拒的出口符号：`rejectBook`（抛出）与 `bookError`（构造，供 Promise 拒绝与异常包装那两处用）。
 * 名册数的就是这两个符号的调用点。
 */
const BOOK_EXITS = ['rejectBook', 'bookError'] as const

/**
 * 按主语预算走的整本拒通道：`xmlBudget(..., 'package')` 的失败都经 `xml.ts` 的 `fail` → `rejectBook`。
 * 它们不是直接调用点，上面的名册数不到；单独登记处数，免得「书级事实一共几种」被这层转手藏起来。
 */
const PACKAGE_SUBJECT_BUDGETS: readonly { file: string; sites: number }[] = [
  { file: 'src/services/epub/package.ts', sites: 5 },
]

/** 定义行（`function rejectBook(` 里那个名字本身）不算调用点 */
function isDefinition(code: string, at: number): boolean {
  return /function\s*$/.test(code.slice(Math.max(0, at - 20), at).trimEnd())
}

/**
 * 一个源文件里全部整本拒调用点的行号（1 起）。
 *
 * 行号只用于**失败时的定位**，不进名册：名册钉的是「这个文件里有几处整本拒」这个数量，
 * 那是 `ADR-0063` 管着的东西（每把一处半径降回主语就少一处）。行号会随任何一次编辑漂移，
 * 拿它当键等于造一条比报错文本还容易漂的锚点——那正是这版门要换掉的东西。
 */
function bookRejectLines(code: string): number[] {
  const out: number[] = []
  for (const name of BOOK_EXITS) {
    const re = new RegExp(`\\b${name}\\b`, 'g')
    for (;;) {
      const m = re.exec(code)
      if (m === null) break
      // 只数调用；裸引用与别名由下面的 `bookExitAliases` 抓（否则名册可以靠别名绕过去）
      if (!/^\s*\(/.test(code.slice(m.index + name.length))) continue
      if (isDefinition(code, m.index)) continue
      out.push(code.slice(0, m.index).split('\n').length)
    }
  }
  return out.sort((a, b) => a - b)
}

/**
 * 出口符号的**别名与裸引用**：名册数的是调用点，若符号被赋给另一个名字再调用，
 * 计数不会增加；所以这里要求它只以「原样导入 + 直接调用」的形态出现。
 */
function bookExitAliases(code: string, file: string): string[] {
  const out: string[] = []
  for (const name of BOOK_EXITS) {
    const re = new RegExp(`\\b${name}\\b`, 'g')
    for (;;) {
      const m = re.exec(code)
      if (m === null) break
      if (/^\s*\(/.test(code.slice(m.index + name.length))) continue          // 直接调用
      if (file === EXIT_HOME && isDefinition(code, m.index)) continue          // 出口自己的定义
      const lineStart = code.lastIndexOf('\n', m.index) + 1
      const lineEnd = code.indexOf('\n', m.index)
      const line = code.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim()
      if (line.startsWith('import ') && !/\bas\b/.test(line)) continue         // 原样导入
      out.push(`${file}：${name} 被当作值引用（只许原样导入并直接调用）：${line}`)
    }
  }
  return out
}

/** 数一段字面出现的次数（「按那个类接住」的每一处都算一次） */
function countMatches(code: string, needle: string): number {
  let n = 0
  let cursor = 0
  for (;;) {
    const at = code.indexOf(needle, cursor)
    if (at < 0) return n
    n += 1
    cursor = at + needle.length
  }
}

function sourcesUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      const child = rel + '/' + entry.name
      if (entry.isDirectory()) walk(child)
      else if (entry.name.endsWith('.ts')) out.push(child)
    }
  }
  walk(dir)
  return out.sort((a, b) => a.localeCompare(b))
}

function stripped(file: string): string {
  return withoutComments(readFileSync(join(ROOT, file), 'utf8'))
}

/** 给出某一类失败的那几个源文件 */
function throwersOf(needle: string): string[] {
  return sourcesUnder(EPUB_DIR).filter((file) => countMatches(stripped(file), needle) > 0)
}

describe('半径门：整本拒收的位置由名册钉住（只许收紧）', () => {
  it('每一处整本拒都在名册里，且名册每条都还在代码里（陈旧条目与已删文件即红）', () => {
    // 实际文件 ∪ 名册点名的文件：名册里留着一个已不存在的文件也要红（静默不检等于名册在漂）
    const files = [...new Set([...sourcesUnder(SRC_DIR).filter((f) => f !== EXIT_HOME), ...BOOK_REJECTIONS.map((e) => e.file)])]
      .sort((a, b) => a.localeCompare(b))
    const problems: string[] = []
    for (const file of files) {
      if (!existsSync(join(ROOT, file))) {
        problems.push(`${file}：名册点名的文件已经不在这个目录里，名册要跟着删条目`)
        continue
      }
      const listed = BOOK_REJECTIONS.find((e) => e.file === file)?.sites ?? 0
      const found = bookRejectLines(stripped(file))
      if (found.length > listed) {
        problems.push(`${file}：出现名册外的整本拒（半径要降到主语，净增名册要写 ADR）——第 ${found.slice(listed).join('、')} 行`)
      }
      if (found.length < listed) {
        problems.push(`${file}：名册记 ${listed} 处整本拒，代码里只剩 ${found.length} 处（被删除、改写或半径已降回主语？）——现有第 ${found.join('、')} 行`)
      }
    }
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('出口符号只许原样导入并直接调用：别名与裸引用当场红（不然名册可以绕）', () => {
    // 正控：两种绕过各红一条
    expect(bookExitAliases('const die = rejectBook\n', 'x.ts')).toHaveLength(1)
    expect(bookExitAliases('import { rejectBook as die } from "./errors.js"\n', 'x.ts')).toHaveLength(1)
    expect(bookExitAliases('import { rejectBook } from "./errors.js"\nrejectBook(`坏`)\n', 'x.ts')).toEqual([])
    const offenders = sourcesUnder(SRC_DIR).flatMap((file) => bookExitAliases(stripped(file), file))
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('按主语预算走的整本拒通道也数得着（xmlBudget(..., \'package\') 的处数）', () => {
    const found = sourcesUnder(SRC_DIR).flatMap((file) =>
      [...stripped(file).matchAll(/xmlBudget\([^\n]*'package'\)/g)].map(() => file))
    expect(found.sort()).toEqual(PACKAGE_SUBJECT_BUDGETS.flatMap((e) => Array.from({ length: e.sites }, () => e.file)).sort())
  })

  it('整本拒只有一条路：书级异常只能在出口里构造', () => {
    const offenders: string[] = []
    for (const file of sourcesUnder(SRC_DIR)) {
      const allowed = file === EXIT_HOME ? 1 : 0     // `bookError` 里那一句
      if (countMatches(stripped(file), 'new EpubImportError(') > allowed) offenders.push(file)
    }
    expect(offenders, `这些文件在出口之外构造了书级异常：${offenders.join(', ')}`).toEqual([])
  })

  it('事实通道发不出整本拒：半径表里没有 book + fatal 那一格', () => {
    // 旧版这条靠正则抓 `add('book', 'fatal'`；现在半径由 `FINDING_RADII` 的名字决定，
    // 所以直接查表：想发「整本书读不出」这条痕，得先在表里加一格——那是要过 ADR 的动作。
    const pairs = Object.entries(FINDING_RADII) as Array<[string, { scope: string; severity: string }]>
    expect(pairs.filter(([, r]) => r.scope === 'book' && r.severity === 'fatal')).toEqual([])
  })

  it('窄类各只有一处收口：抛点归位，接住点不许多', () => {
    // 抛点归位：文档级与资源级都由那份预算的主语给出（`xml.ts` 的 `fail` 是唯一给得出主语的地方），
    // 资源层与编排层各自还能直接点出「这一张图读不出」；引用级只有包层那一个解析口。
    expect(throwersOf('new EpubResourceError(')).toEqual(['src/services/epub/import.ts', 'src/services/epub/resources.ts', 'src/services/epub/xml.ts'])
    expect(throwersOf('new EpubDocumentError(')).toEqual(['src/services/epub/xml.ts'])
    expect(throwersOf('new EpubHrefError(')).toEqual(['src/services/epub/package.ts'])

    // 接住点：多一处就多一条把窄半径放大成整本拒、或把书级事实读成一处失败的路
    let resource = 0
    let document = 0
    let href = 0
    const baseCatchers: string[] = []
    for (const file of sourcesUnder(EPUB_DIR)) {
      const code = stripped(file)
      resource += countMatches(code, 'instanceof EpubResourceError')
      document += countMatches(code, 'instanceof EpubDocumentError')
      href += countMatches(code, 'instanceof EpubHrefError')
      if (countMatches(code, 'instanceof EpubImportError') > 0) baseCatchers.push(file)
    }
    expect(resource, '资源级异常的接住点数').toBe(1)
    expect(document, '文档级异常的接住点数').toBe(2)
    expect(href, '引用级异常的接住点数').toBe(4)
    // 基类的 instanceof 会把已收窄的子类一起吃掉：只许归档层那一次（判「披过本层的名没有」，不判主语）
    expect(baseCatchers, `这些文件对书级基类做 instanceof：${baseCatchers.join(', ')}`).toEqual(['src/services/epub/archive.ts'])
  })

  it('正控：判据认得出名册外的拒收点与失效的名册条目（不是空转）', () => {
    expect(bookRejectLines('function checkIt(x: boolean): void {\n  if (x) rejectBook(`某份文档读不懂`)\n}\n')).toEqual([2])
    // 调用点与函数声明写在同一行也要数得到；只有「function rejectBook(」这种定义行本身不算
    expect(bookRejectLines('function a(): void { rejectBook(`一`) }\nfunction b(): void { rejectBook(`二`) }\n')).toEqual([1, 2])
    // 措辞改了、调用点没变：门不该红（旧版靠消息文本当锚点，改字即红）
    expect(bookRejectLines('function checkIt(): void { rejectBook(`完全不同的句子`) }\n')).toEqual([1])
    // 出口自己的定义行不算调用点，但体内的 `bookError` 算（它就是一个出口）
    expect(bookRejectLines('export function rejectBook(m: string): never {\n  throw bookError(m)\n}\n')).toEqual([2])
    // 类成员里的调用点照样数得到
    expect(bookRejectLines('class K {\n  private go(): void {\n    rejectBook(`坏`)\n  }\n}\n')).toEqual([3])
  })

  it('内部一致性被破坏是服务端自损：不许以书级出口的名义报成「这本书坏」', () => {
    const bad: string[] = []
    for (const file of sourcesUnder(EPUB_DIR)) {
      if (/(?:rejectBook|bookError)\([^)]*内部一致性/.test(stripped(file))) bad.push(file)
    }
    expect(bad, `这些位置用整本拒的口径报服务端自己的问题（该抛裸 Error 走 500）：${bad.join(', ')}`).toEqual([])
  })
})
