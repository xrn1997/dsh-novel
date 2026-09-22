import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { COVERAGE, type CoverageGroup, type CoverageRow } from './matrix.js'

/**
 * legado 语义覆盖矩阵守卫（目标判据①）。
 *
 * 它不测运行时行为，测的是**证据的可信度**：一行说「已实现」就必须指到真实存在的实现符号与
 * 钉住它的测试；一行说「环境不适用」就必须指到 docs/design 里写明这条口径的锚点。符号改名、
 * 文件搬家、文档措辞被就地改掉——这里立刻红。所以「覆盖矩阵绿」的含义是：*登记的每一条能力都有
 * 可回查的归属*，而不是「本插件什么都能干」。
 *
 * 证据的**成色**也是口径的一部分（2026-09-22 收紧）：实现符号必须出现在**代码位置**（注释里留
 * 一句旧符号名不算实现），测试钉子的片段必须落在**用例标题**里（注释横幅、`toThrow` 消息不算），
 * 「不适用」的锚点必须是 `docs/design/legado-compat.md` 那张表里的锚点，且表里每条裁决都要有行
 * 认领（文档→行方向）。四处放宽都实测放行过假账。
 *
 * 与 tests/docs-references.test.ts 同族（那个管文档里的源文件路径，这个管能力清单的证据）。
 */

const GROUPS: CoverageGroup[] = [
  'A 规则语法', 'B URL 与请求', 'C 书源字段', 'D 搜索与发现', 'E 书籍详情', 'F 目录',
  'G 正文', 'H JS 宿主面', 'I App 级规则族', 'J 评论与源类型', 'K 书源管理与调试',
]

const fileCache = new Map<string, string | null>()
function fileText(rel: string): string | null {
  if (fileCache.has(rel)) return fileCache.get(rel) ?? null
  if (!existsSync(rel)) { fileCache.set(rel, null); return null }
  const text = readFileSync(rel, 'utf8')
  fileCache.set(rel, text)
  return text
}

/** 去掉注释：`impl` 证据只认**代码位置**里的符号。
 *  本仓踩过：`detectTailJs` 已从 `parse.ts` 删除，注释里还留着一句「本仓曾有 detectTailJs」，
 *  于是 `includes('detectTailJs')` 照绿——矩阵把一条不存在的实现当成了已实现（假账放行）。
 *  注释里提一句旧符号名不算实现。
 *
 *  刻意**不**去字符串字面量：本仓的证据有一大半正当住在串里——宿主方法名是协议表的主键
 *  （`method('base64DecodeToByteArray', …)`）、沙箱本体整个是一段模板串（`mkHostObj` 在串内）、
 *  规则字段名是白名单数组的元素（`'nextPageUrl'`）。按串再筛一遍会把这些真实现判成假账
 *  （实测一次就误伤 8 行），代价大于收益；残留下的唯一缺口是「告警文案里提到某符号」，
 *  而那种写法不构成实现声明。 */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(?<!:)\/\/[^\n]*/g, '')
}

/** 测试文件里的用例标题（`describe`/`it`/`test` 的首个字符串实参）。
 *  矩阵的 `test` 证据契约是「用例标题片段」（见 matrix.ts 的类型注释），所以要求命中**标题**：
 *  先前按整文件 `includes` 匹配，标题片段在注释横幅或 `toThrow(/…/)` 的消息里也能满足——
 *  钉子的成色退化成了「这个文件里提过这个词」。 */
function titlesOf(text: string): string[] {
  const out: string[] = []
  const re = /\b(?:describe|it|test)(?:\.(?:only|skip|each|todo|fails|concurrent|sequential))?\s*\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`)/g
  for (const m of text.matchAll(re)) {
    const title = m[1] ?? m[2] ?? m[3]
    if (title !== undefined) out.push(title)
  }
  return out
}

/** 「环境不适用」的裁决都写在 legado-compat.md 的这张表里；矩阵行只许引用表里的锚点。
 *  这是**单一真相**而不是形式主义：理由只在文档里写一遍，行拿锚点回指——两处各写一份理由
 *  会立刻长出两份抄本（本仓对「同一概念两份抄本」的既定态度见 AGENTS.md 的真相分层）。 */
const COMPAT_DOC = 'docs/design/legado-compat.md'

function compatAnchors(): Set<string> {
  const doc = fileText(COMPAT_DOC) ?? ''
  return new Set([...doc.matchAll(/`(不适用：[^`]+)`/g)].map((m) => m[1]))
}

/** 收集全部失败原因（一次跑完看全部漂移，而不是修一个跑一次） */
function audit(rows: CoverageRow[]): string[] {
  const bad: string[] = []
  for (const row of rows) {
    if (row.status === 'implemented') {
      const [implFile, implToken] = row.impl ?? []
      if (!implFile || !implToken) { bad.push(`${row.id}: implemented 缺 impl [文件, 符号]`); continue }
      const impl = fileText(implFile)
      if (impl === null) bad.push(`${row.id}: 实现文件不存在 ${implFile}`)
      else {
        const code = withoutComments(impl)
        if (!code.includes(implToken)) {
          bad.push(`${row.id}: ${implFile} 的代码位置里找不到实现符号 ${JSON.stringify(implToken)}`)
        }
      }
      if (!row.test) { bad.push(`${row.id}: implemented 缺 test 钉子`); continue }
      const [testFile, testToken] = row.test
      const t = fileText(testFile)
      if (t === null) bad.push(`${row.id}: 测试文件不存在 ${testFile}`)
      else if (!titlesOf(t).some((title) => title.includes(testToken))) {
        bad.push(`${row.id}: ${testFile} 里没有标题含 ${JSON.stringify(testToken)} 的用例`)
      }
      continue
    }
    if (row.status === 'not-applicable') {
      if (!row.doc) { bad.push(`${row.id}: not-applicable 必须给 doc 锚点（口径要写进设计文档）`); continue }
      const [docFile, anchor] = row.doc
      const d = fileText(docFile)
      if (d === null) bad.push(`${row.id}: 文档不存在 ${docFile}`)
      else if (!d.includes(anchor)) bad.push(`${row.id}: ${docFile} 里没有 ${JSON.stringify(anchor)}——判「环境不适用」的口径要写进文档`)
      if (!compatAnchors().has(anchor)) {
        bad.push(`${row.id}: doc 锚点必须是 ${COMPAT_DOC}「环境不适用的面」表里的锚点（拿到 ${JSON.stringify(anchor)}）`)
      }
      if (!row.note) bad.push(`${row.id}: not-applicable 缺理由（note）`)
      continue
    }
    if (row.status === 'open') {
      if (!row.note) bad.push(`${row.id}: open 必须写清缺什么、卡在谁手上`)
      continue
    }
    bad.push(`${row.id}: 未知 status ${JSON.stringify(row.status)}（只有三态，不留「未知」）`)
  }
  return bad
}

describe('legado 语义覆盖矩阵', () => {
  it('每行都指向真实存在的证据（实现符号 / 测试钉子 / 文档口径），漂移即红', () => {
    expect(audit(COVERAGE)).toEqual([])
  })

  it('id 唯一（同一能力不许有两份抄本）', () => {
    const seen = new Set<string>()
    const dup = COVERAGE.filter((r) => (seen.has(r.id) ? true : (seen.add(r.id), false)))
    expect(dup.map((r) => r.id)).toEqual([])
  })

  it('十一个能力组全部在册（漏组 = 参考清单那一节根本没进账）', () => {
    const missing = GROUPS.filter((g) => !COVERAGE.some((r) => r.group === g))
    expect(missing).toEqual([])
  })

  it('legado-compat.md 的每条「不适用」裁决都有矩阵行认领（文档→行方向）', () => {
    // 反向也是同一件事的一半：裁决写在文档里却没有行引用它，下一个人遇到同类源报「不支持」时
    // 会把它当新问题重问一遍——「判不适用而不登记，等于把裁决写成遗忘」的文档侧。
    const used = new Set(COVERAGE.map((r) => r.doc?.[1]).filter((a): a is string => a !== undefined))
    expect([...compatAnchors()].filter((a) => !used.has(a))).toEqual([])
  })

  it('本门的扫描面自证非空（标题提取与锚点提取都不是空集合上跑绿）', () => {
    expect(compatAnchors().size).toBeGreaterThan(10)
    expect(titlesOf(fileText('tests/tools/tools.test.ts') ?? '').length).toBeGreaterThan(0)
  })

  it('除整族缺席的那一组外，每组都有可读证据的 implemented 行（防止整组只用「环境不适用」糊过去）', () => {
    // I App 级规则族（全局替换库 / 字典 / 高亮 / 订阅）本仓一行实现都没有——这是事实，
    // 不是登记疏忽：它那六行要么是 open（欠账在案）要么是 not-applicable（对面自己也没读）。
    // 把它写死在这里，将来该族有了实现就必须改这张表，改不回去。
    const zeroImplemented: CoverageGroup[] = ['I App 级规则族']
    const thin = GROUPS.filter((g) => !zeroImplemented.includes(g)
      && !COVERAGE.some((r) => r.group === g && r.status === 'implemented'))
    expect(thin).toEqual([])
  })

  it('打印三态分布（读数以本表为准，不散落进别处文档）', () => {
    const by = (s: CoverageRow['status']) => COVERAGE.filter((r) => r.status === s).length
    const perGroup = GROUPS.map((g) => {
      const rows = COVERAGE.filter((r) => r.group === g)
      const open = rows.filter((r) => r.status === 'open').map((r) => r.id)
      return `${g}: 共 ${rows.length}，实现 ${rows.filter((r) => r.status === 'implemented').length}，`
        + `不适用 ${rows.filter((r) => r.status === 'not-applicable').length}，开口 ${open.length}`
        + (open.length ? ` [${open.join(' ')}]` : '')
    })
    console.log(`[legado 覆盖矩阵] 总 ${COVERAGE.length} 行｜实现 ${by('implemented')}｜环境不适用 ${by('not-applicable')}｜开口 ${by('open')}｜未知 0`)
    for (const line of perGroup) console.log('  ' + line)
    expect(COVERAGE.length).toBeGreaterThan(0)
  })
})
