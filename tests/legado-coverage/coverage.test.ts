import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { withoutComments } from '../without-comments.js'
import { parseOpenItems } from './known-open.js'
import { COVERAGE, ROW_DEMAND, type CoverageGroup, type CoverageRow } from './matrix.js'

/**
 * legado 语义覆盖矩阵守卫（目标判据①）：不测运行时行为，测**证据的可信度**——
 * 「已实现」指到真实代码位置里的符号 + 用例标题里的钉子；「环境不适用」指到 legado-compat.md
 * 表内的锚点且被行认领。矩阵绿 = 每条能力都有可回查的归属，不是「本插件什么都能干」。
 * 成色四处（代码位置 / 用例标题 / 表内锚点 / 文档→行）都是收紧过一轮的：放宽任何一处都实测放行过假账。
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

/** 去掉注释（`tests/without-comments.ts` 单点）：`impl` 证据只认**代码位置**里的符号——
 *  注释里提一句旧符号名不算实现（`detectTailJs` 删了、注释留着，`includes` 曾照绿放行假账）。 */

/** 用例标题（`describe`/`it`/`test` 的首个字符串实参）：矩阵的 `test` 证据契约是标题片段，
 *  所以按**标题**匹配——整文件 `includes` 会让注释横幅或 `toThrow(/…/)` 的消息也算钉子。 */
function titlesOf(text: string): string[] {
  const out: string[] = []
  const re = /\b(?:describe|it|test)(?:\.(?:only|skip|each|todo|fails|concurrent|sequential))?\s*\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`)/g
  for (const m of text.matchAll(re)) {
    const title = m[1] ?? m[2] ?? m[3]
    if (title !== undefined) out.push(title)
  }
  return out
}

/** 「环境不适用」的裁决都写在 legado-compat.md 的这张表里，矩阵行只许引用表内锚点——
 *  理由只在文档里写一遍，行拿锚点回指；两处各写一份理由必然长出两份抄本。 */
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

  it('协议表已挂载的宿主方法不得同时被列成「不适用」（裁决表不许留下过期缺席项）', () => {
    // 上面那扇门只验「不适用行必须有锚」，不验锚那格的内容是否还成立——文档曾把已接进协议表的
    // 方法继续列成缺席面而全绿。分母取**机械可数的实现面**（协议表 `method('…')` 主键 + js-utils 导出），
    // 不取能力描述里的词（`header`/`title` 共名会全是误报）；只扫不适用表格第二列，第三列是理由。
    const mounted = new Set<string>([
      ...(fileText('src/engine/js-protocol.ts') ?? '').matchAll(/\bmethod\(\s*'([A-Za-z0-9_]+)'/g),
      ...(fileText('src/engine/js-utils.ts') ?? '').matchAll(/^export function ([A-Za-z0-9_]+)/gm),
    ].map((m) => m[1]).filter((n) => n.length > 4))
    expect(mounted.size).toBeGreaterThan(20) // 提取退化即红，别拿空集合跑绿
    const cells = [...(fileText(COMPAT_DOC) ?? '').matchAll(/^\|\s*`不适用：[^`]+`\s*\|([^|\n]*)\|/gm)]
      .map((m) => m[1])
    expect(cells.length).toBeGreaterThan(10)
    const bad = [...mounted].sort().flatMap((name) => {
      const hit = cells.find((c) => new RegExp(`\\b${name}\\b`).test(c))
      return hit === undefined ? [] : [`${name} 既在协议表挂载、又被列进不适用格 ${JSON.stringify(hit.trim().slice(0, 70))}`]
    })
    expect(bad, bad.join('\n  ')).toEqual([])
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
    // 反向的一半：裁决写在文档里却没有行认领，下一个人会把它当新问题重问——「判不适用而不登记，
    // 等于把裁决写成遗忘」的文档侧。
    const used = new Set(COVERAGE.map((r) => r.doc?.[1]).filter((a): a is string => a !== undefined))
    expect([...compatAnchors()].filter((a) => !used.has(a))).toEqual([])
  })

  it('本门的扫描面自证非空（标题提取与锚点提取都不是空集合上跑绿）', () => {
    expect(compatAnchors().size).toBeGreaterThan(10)
    expect(titlesOf(fileText('tests/tools/tools.test.ts') ?? '').length).toBeGreaterThan(0)
  })

  it('除整族缺席的那一组外，每组都有可读证据的 implemented 行（防止整组只用「环境不适用」糊过去）', () => {
    // I App 级规则族（全局替换库 / 字典 / 高亮 / 订阅）一行实现都没有——是事实不是疏忽：六行全是
    // open 或 not-applicable。写死在这里，将来该族有实现就必须改这张表。
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

/**
 * **矩阵的排版不变量：一行一条记录**。本仓读这张表一半是**按行**的（docs-module-symbols、审计脚本、
 * 人 grep），两行粘连时 TS 解析照常、判据不红，只有按行扫描的工具把后一行的 note 算到前一行头上
 * （实测误判过一次）。判据取最小形状：一个物理行出现两次 `id: '` 即红；缩进与行尾逗号交给 esbuild。
 */
describe('矩阵排版：一行一条记录', () => {
  it('任何一行都不许粘着两条记录', () => {
    const text = readFileSync('tests/legado-coverage/matrix.ts', 'utf8')
    const glued = text
      .split('\n')
      .map((l, i) => ({ n: (l.match(/id: '/g) ?? []).length, line: i + 1 }))
      .filter((x) => x.n > 1)
    expect(glued.map((x) => `第 ${x.line} 行粘了 ${x.n} 条记录`).join('；'), '矩阵要求一行一条记录').toBe('')
    // 反向自校验：抽取器没空转（表里确实有成百条记录）
    expect(text.split('\n').filter((l) => /^  \{ id: '/.test(l)).length).toBeGreaterThan(200)
  })
})

/**
 * **登记册读数必须带复核日期戳**：`open` 行是待办队列，最危险的不是「还没做」，是读数来自上一批库、
 * 读的人却当现状用（本会话为此纠过四处漂）。判据取**形状**不取词表——note 里出现 `2026-MM-DD` 即算
 * 复核过；按措辞扫的词表路线 dry-run 过一次，一半误伤待裁项，弃。覆盖所有状态：日期槽允许两种含义
 * （今日复核 / 某批复算过、出处见行内），唯独不许没有日期——没有日期的计数分不出今天与三年前。
 */
/** 把某份文档「已知开口」那一节解析成编号条目——解析器单点在 `known-open.ts`
 *  （与 citation-liveness 的编号判据共用同一份：各写一份必然漂，且已经漂过）。 */
function openItems(rel: string): Array<{ num: string; body: string }> {
  const text = fileText(rel)
  if (text === null) throw new Error(`${rel} 不在场`)
  const items = parseOpenItems(text)
  if (items === null) throw new Error(`${rel} 找不到「已知开口」小节标题`)
  return items
}

describe('登记册读数的时效戳', () => {
  it('每条 open 行的 note 里都有一个复核日期（读数以戳为准，无戳即红）', () => {
    const open = COVERAGE.filter((r) => r.status === 'open')
    const stale = open.filter((r) => !/2026-\d{2}-\d{2}/.test(r.note ?? '')).map((r) => r.id)
    // 空转防线：绝大多数行本来就有戳，否则这条判据等于没检查
    expect(open.filter((r) => /2026-\d{2}-\d{2}/.test(r.note ?? '')).length,
      '带戳的 open 行太少，判据在空转').toBeGreaterThan(20)
    expect(stale, `这些 open 行的 note 没有任何复核日期戳（读数与理由都可能是旧批的）：${stale.join(', ')}`).toEqual([])
  })

  /**
   * 同一判据铺到**所有状态**：凡 note 里写了 `N 源` 这类现量读数（会随用户增删书源而漂的数），
   * 就必须带一个日期锚。日期槽允许两种诚实的含义——「今日复核」或「某批复算过、其后未复算（出处
   * 日期见行内那句）」——唯独不许没有日期：没有日期的计数让读者分不出今天与三年前。
   *
   * **判据只吃 `N 源` 这一种单位，不扩到 `处` / `条` / `键`**：登记册里那三种多半是**代码常量或测试
   * 标题**（`每源截断 50 条`、`列表 0 条 + 无 pattern`），不随书源增删漂；扩过去就得养一张豁免表，
   * 与本仓对宽判据的一贯立场同族（词表路线在时效戳这一挡已经 dry-run 过一次，见上面那段）。
   */
  it('任何状态：写了「N 源」现量读数的行都必须带日期锚（复核日或出处日，无日期即红）', () => {
    const withCount = COVERAGE.filter((r) => /\d+\s*源/.test(r.note ?? ''))
    const undated = withCount.filter((r) => !/2026-\d{2}-\d{2}/.test(r.note ?? ''))
      .map((r) => `${r.id}(${r.status})`)
    expect(withCount.length, '带「N 源」读数的行太少，判据在空转').toBeGreaterThan(60)
    expect(undated, `这些行的 note 写了现量读数却没有任何日期锚：${undated.join(', ')}`).toEqual([])
  })

  /**
   * **两张抄本不许各说各话**：legado-compat.md 的「需求量读数」表与矩阵行 note 记同一个量，已漂过
   * （2026-09-28 那批：`canReName` 3 源 vs 5 源，靠人工对读才发现）。判据取「**点名即对账**」：表行点了已进
   * `ROW_DEMAND` 的矩阵行，其**主读数**（现量列开头那组加粗数）必须由该 id 绑定的读数单个或求和凑出。
   * 三条边界：① 只吃点名行（点名本身归指针纪律管）；② 口径不同由行内写「不等价」豁免，豁免住在文档
   * 不住在测试（测试内嵌豁免表 = 判据退化成清单）；③ 只比有复数入口的读数，没绑的数无从重算。
   * 负结果留档别重走：把这条扫过三份设计文档的正文（2026-09-28 试过）16 处命中全正当、只有一处真分歧
   * 且已改——窄形状是判据生效的前提，放宽到散文就只剩天天维护的豁免表。
   */
  it('需求量读数表：点名了已绑定矩阵行的主读数，必须与那条行的绑定读数对得上（不等价须在行内声明）', () => {
    const doc = fileText('docs/design/legado-compat.md')
    expect(doc, '裁决表文档不在场').not.toBeNull()
    const from = doc!.indexOf('## 需求量读数')
    expect(from, '裁决表里没有「需求量读数」这一节').toBeGreaterThan(-1)
    const rest = doc!.slice(from)
    const table = rest.slice(0, rest.indexOf('\n## ') > 0 ? rest.indexOf('\n## ') : rest.length)

    // 子集和：让「整块 = 各分量之和」这类合法口径自己凑得出来，而不必为它开列名单
    const sumsOf = (ns: number[]): Set<number> => {
      let acc = new Set<number>([0])
      for (const n of ns) {
        const next = new Set(acc)
        for (const a of acc) next.add(a + n)
        acc = next
      }
      return acc
    }

    const checked: string[] = []
    const waived: string[] = []
    const mismatched: string[] = []
    for (const line of table.split('\n')) {
      if (!line.startsWith('| ') || line.includes(' --- ')) continue
      const cited = [...new Set((line.match(/`[\w-]+`/g) ?? []).map((s) => s.slice(1, -1))
        .filter((id) => id in ROW_DEMAND))]
      if (cited.length === 0) continue
      const demandCell = line.split('|')[2] ?? ''
      const leadBold = demandCell.match(/\*\*([^*]+)\*\*/)?.[1] ?? ''
      const nums = (leadBold.match(/\d+/g) ?? []).map(Number)
      if (nums.length === 0) continue
      checked.push(`${cited.join('+')} ⇐ 主读数 [${nums.join(', ')}]`)
      const reach = new Set(cited.flatMap((id) => [...sumsOf(ROW_DEMAND[id].map((e) => e.n))]))
      for (const n of nums) {
        if (reach.has(n)) continue
        // 豁免只认**行内写了「不等价」**，并如实数出来给读者看（豁免变多就该有人抬头）
        if (/不等价/.test(line)) waived.push(`${cited.join('+')} 的主读数 ${n}（行内声明不等价）`)
        else mismatched.push(`${cited.join('+')}：绑定读数 ${[...reach].sort((a, b) => a - b).join('/')} 凑不出主读数 ${n}`)
      }
    }
    expect(checked.length, '点名了绑定行的表行太少（<6），判据在空转').toBeGreaterThan(5)
    console.log(`[读数表] 对账 ${checked.length} 行：${checked.join(' | ')}`)
    expect(mismatched, `这些表行的主读数与矩阵行的绑定读数对不上：${mismatched.join('；')}`).toEqual([])
    if (waived.length) console.log(`[读数表] 靠行内「不等价」豁免的主读数 ${waived.length} 个：${waived.join(' | ')}`)
  })

  /**
   * **② 的「待拍板」清单必须能一次 grep 数全**：重开条件已用裁定型措辞写了触发物的行，必须挂
   * `待裁` 标记，否则 grep 出来的清单残缺、少报的裁决没人会被问到。判据吃的是登记册**自立的措辞
   * 约定**而非自然语言词表（与时效戳那挡拒走的「按措辞猜状态」不同族）。两侧防空转计数。
   */
  it('重开条件是裁定型的 open 行必须带「待裁」标记（② 的清单要能一次 grep 数全）', () => {
    const RULING_GATED = /重开条件[^。]{0,40}(裁定|拍板|裁决)|用户裁定|再拍板|裁定「|一并裁|卡在[^。]{0,20}裁决/
    const open = COVERAGE.filter((r) => r.status === 'open')
    const gated = open.filter((r) => RULING_GATED.test(r.note ?? ''))
    const unmarked = gated.filter((r) => !/待裁/.test(r.note ?? '')).map((r) => r.id)
    expect(gated.length, '裁定型重开条件的行数太少（<12），判据在空转').toBeGreaterThan(11)
    expect(open.filter((r) => /待裁/.test(r.note ?? '')).length, '带待裁标记的行太少，判据在空转').toBeGreaterThan(11)
    expect(unmarked, `这些行的下一步是一次裁决，却没挂进待裁清单（grep 数不出来就没人会被问到）：${unmarked.join(', ')}`).toEqual([])
    // 每次跑都把「② 在矩阵这一面有几行可 grep」印出来：这个数本身就是登记面的健康度读数，
    // 悄悄变少（删行没同步、或新裁决项没挂标记）时，输出里就能看到，不必等某条门红。
    console.log(`[待裁面] 矩阵：${open.filter((r) => /待裁/.test(r.note ?? '')).length} 行挂了待裁标记（open 共 ${open.length}）`)
    /**
     * 同一挡的第二半：**挂了待裁就必须给可批的默认**（推荐 / 建议 / 明写「不预设」）——没有默认，
     * 等于把调查工作退回给拍板的人，那条裁决就一直悬着；「不预设」同样是有内容的答复。
     */
    const noRec = COVERAGE.filter((r) => r.status === 'open' && /待裁/.test(r.note ?? '')
      && !/推荐|建议|不预设/.test(r.note ?? '')).map((r) => r.id)
    expect(noRec, `这些待裁行没给可批的推荐（要他先自己调查才能回答）：${noRec.join(', ')}`).toEqual([])
  })

  /**
   * **文档那一面也得给可批项**：已知开口写了「待裁 / 要不要 / 需要拍板」的条目，必须给出可批的默认
   * （推荐、建议、不预设、维持现状、点明判法的句子），否则把调查退回给拍板的人——两份抄本给相反默认
   * 的真矛盾翻出来过一次。刻意不判两份抄本措辞是否逐字一致（词表活，只会逼出同义抄本），只判有没有默认。
   */
  it('三份设计文档的已知开口：写了裁决型措辞的条目必须给出可批的默认', () => {
    const ASK = /待裁|待拍板|要不要|未决|二选一|等一句话|未拍板|需要拍板/
    const REC = /推荐|建议|不预设|维持现状|可批默认|要裁就照|默认/
    const offenders: string[] = []
    let total = 0
    for (const rel of ['docs/design/engine.md', 'docs/design/services.md', 'docs/design/client.md']) {
      for (const it of openItems(rel)) {
        if (!ASK.test(it.body)) continue
        total++
        if (!REC.test(it.body)) offenders.push(`${rel.replace('docs/design/', '')} 第 ${it.num} 条`)
      }
    }
    expect(total, '裁决型开口项太少（<8），判据在空转').toBeGreaterThan(7)
    expect(offenders, `这些开口条目只提了要拍板、没给可批的默认：${offenders.join('；')}`).toEqual([])
  })

})
