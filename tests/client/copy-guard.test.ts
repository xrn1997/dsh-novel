import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

/**
 * 客户端可见文案的单点守卫：`src/client` 下的字符串 / 模板串 / JSX 文本不许有中文，
 * 字典 `src/client/copy` 是唯一例外。
 *
 * 为什么用 AST 而不是逐行 grep：注释里全是中文（口径与裁决就住那儿），正则会把注释判成
 * 文案、逼作者删掉「为什么」。AST 只看真正会上屏的那几种节点。
 *
 * 正则字面量不是文案节点：`api.ts` 的 `describeError` 用一条剥离中文前缀的正则把存量错误
 * 消息还原成 detail——它匹配内部消息而非可见文案，故不设白名单项、只在此留痕。
 *
 * 白名单两条规则：
 * - 文件级只给**整份不上屏**的模块（样式模板）；视图文件一律逐字面量放行，免得整文件豁免
 *   把后来新增的界面文案一起藏掉。客户端自造的网络错误模板只在「生成时」存原文、经
 *   `describeError` 翻译后才上屏，因此也走逐字面量而不是整文件豁免。
 * - 每条都要写理由，且必须**真的命中**一个节点——陈旧的白名单与没写的白名单一样可疑。
 *
 * `findCjkHits` 是探测器的纯函数面：守卫本身也要有合成负例，否则一次坏掉的 walker
 * 会让「全仓零命中」永远绿着。
 */

const CLIENT = fileURLToPath(new URL('../../src/client', import.meta.url))

/** 文件级白名单：整份文件都不上屏。键是相对 `src/client` 的路径。 */
const FILE_ALLOW = new Map<string, string>([
  ['styles.tsx', 'CSS 模板串里的中文全是注释，模板本身不上屏'],
])

/** 逐字面量白名单：只放行具体某个非文案字形或内部错误模板。 */
const LITERAL_ALLOW = new Map<string, Map<string, string>>([
  ['api.ts', new Map([
    ['响应不是 JSON（HTTP ', '客户端自造网络错误模板：原文先存进 ApiClientError，经 describeError 按 reason 翻译后才上屏'],
    ['网络请求失败: ', '客户端自造网络错误模板：三处 fetch catch 收在 networkErrorOf，经 describeError 翻译后才上屏'],
    ['事件流不可用（HTTP ', '客户端自造网络错误模板：与 not-json 同一条 reason 通道，经 describeError 翻译后才上屏'],
  ])],
  ['views/bits.tsx', new Map([
    ['书', 'rendered decorative cover fallback glyph, deliberately not localized'],
  ])],
])

type LiteralKind = 'string' | 'template' | 'jsx'

interface LiteralHit {
  line: number
  kind: LiteralKind
  text: string
}

interface Hit extends LiteralHit {
  rel: string
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

/** CJK 统一表意文字：足够抓住界面文案；西里尔 / 假名不在本仓的文案面里。 */
function hasCjk(text: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(text)
}

function literalOf(node: ts.Node, sf: ts.SourceFile): { kind: LiteralKind; text: string } | undefined {
  if (ts.isStringLiteral(node)) return { kind: 'string', text: node.text }
  if (ts.isNoSubstitutionTemplateLiteral(node)) return { kind: 'template', text: node.text }
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
    return { kind: 'template', text: node.text }
  }
  if (ts.isJsxText(node)) return { kind: 'jsx', text: node.getText(sf).trim() }
  return undefined
}

/** 纯函数探测器：一份源码里所有带中文的文案节点（注释天然不在节点集里）。
 *  导出是为守卫自身留合成负例，生产扫描与自测走同一条 walker。 */
export function findCjkHits(sourceText: string, fileName: string): LiteralHit[] {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const found: LiteralHit[] = []
  const walk = (node: ts.Node): void => {
    const literal = literalOf(node, sf)
    if (literal !== undefined && hasCjk(literal.text)) {
      found.push({
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        kind: literal.kind,
        text: literal.text,
      })
    }
    ts.forEachChild(node, walk)
  }
  walk(sf)
  return found
}

const allowKey = (rel: string, text: string): string => `${rel}:${text}`

function scan(): { hits: Hit[]; consumedFiles: Set<string>; consumedLiterals: Set<string> } {
  const hits: Hit[] = []
  const consumedFiles = new Set<string>()
  const consumedLiterals = new Set<string>()
  for (const file of sourceFiles(CLIENT)) {
    const rel = relative(CLIENT, file).split('\\').join('/')
    if (rel.startsWith('copy/')) continue
    const fileHits = findCjkHits(readFileSync(file, 'utf8'), file)
    if (FILE_ALLOW.has(rel)) {
      // 整份豁免也要证明确实挡住了东西：文件里的中文注释不算命中，所以只有文案节点才计数。
      if (fileHits.length > 0) consumedFiles.add(rel)
      continue
    }
    for (const hit of fileHits) {
      if (LITERAL_ALLOW.get(rel)?.has(hit.text) === true) {
        consumedLiterals.add(allowKey(rel, hit.text))
      } else {
        hits.push({ rel, ...hit })
      }
    }
  }
  return { hits, consumedFiles, consumedLiterals }
}

const formatHit = (hit: Hit): string =>
  `${hit.rel}:${hit.line} [${hit.kind}] ${JSON.stringify(hit.text.slice(0, 40))}`

describe('客户端源码不许留裸中文文案', () => {
  const { hits, consumedFiles, consumedLiterals } = scan()

  it('字符串 / 模板串 / JSX 文本为零（注释与白名单除外）', () => {
    expect(hits.map(formatHit), `以下位置还有裸中文，请收进 src/client/copy 或说明为何不上屏：\n${hits.map(formatHit).join('\n')}`)
      .toEqual([])
  })

  it('白名单条目都带理由、不整份豁免视图，且文件级与逐字级都必须命中', () => {
    for (const [file, reason] of FILE_ALLOW) {
      expect(reason.trim(), `文件级白名单缺理由：${file}`).not.toBe('')
      expect(existsSync(join(CLIENT, file)), `文件级白名单指向不存在的文件：${file}`).toBe(true)
      expect(file.startsWith('views/'), `视图文件不许整份豁免，只能逐字面量放行：${file}`).toBe(false)
      expect(consumedFiles.has(file), `文件级白名单没有挡住任何中文，条目已陈旧：${file}`).toBe(true)
    }
    for (const [file, entries] of LITERAL_ALLOW) {
      expect(FILE_ALLOW.has(file), `同一文件不许既整份豁免又逐字放行：${file}`).toBe(false)
      expect(existsSync(join(CLIENT, file)), `逐字白名单指向不存在的文件：${file}`).toBe(true)
      for (const [literal, reason] of entries) {
        expect(reason.trim(), `逐字白名单缺理由：${file} → ${literal}`).not.toBe('')
        expect(consumedLiterals.has(allowKey(file, literal)),
          `逐字白名单不再命中任何字面量，条目已陈旧：${file} → ${literal}`).toBe(true)
      }
    }
  })
})

describe('探测器自测（守卫本身也会坏）', () => {
  it('字符串 / 模板串 / JSX 文本里的中文都会被抓住', () => {
    const source = [
      "const plain = '上屏文案'",
      'const tpl = `模板${value}`',
      'const element = <div>裸中文</div>',
    ].join('\n')
    expect(findCjkHits(source, 'fixture.tsx').map((hit) => hit.kind).sort())
      .toEqual(['jsx', 'string', 'template'])
  })

  it('注释里的中文不算文案', () => {
    const source = [
      '/** 为什么：这条口径只住注释 */',
      '// 行注释里的中文',
      'export const value = 1',
    ].join('\n')
    expect(findCjkHits(source, 'fixture.ts')).toEqual([])
  })
})
