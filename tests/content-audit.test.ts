import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ReadingService } from '../src/services/reading.js'
import { readSystemProxy, resolveProxyUrl } from '../src/services/proxy.js'
import { makeTempDir, trackService } from './temp-dir.js'
import { classifyAudits, messageSkeleton, searchFaceStageOf } from './content-audit-classify.js'

// 正文链路全量审计（DSH_CONTENT_AUDIT=1 才跑——全量真打网络，十几分钟量级；不进常规集）。
// 探针（DSH_REPROBE）只验搜索面：「verified」≠ 正文可读。本审计补后半条链：每源「搜索 → 目录 →
// 正文（多章采样）」逐段实测，失败按 stage + 错误类分桶落盘 .superpowers/content-audit/（不入库）。
//
// **它是审计报告，不是通过率门**：分桶读数靠人判，代码只断言审计完整性（每个选中源都得出 stage），
// 红即工具坏——通过率读报告的 stageCount / buckets。
//
// 出站姿态与生产同口径（resolveProxyUrl），否则代理源会被误报成规则失败。
// 旋钮：DSH_AUDIT_KEYWORDS / WORKERS / CHAPTERS / ONLY（`DSH_AUDIT_ONLY='名字1,名字2'` 桶级复跑）。

interface ErrInfo {
  name: string
  message: string
  facet?: string
  segmentIndex?: number
  segmentRaw?: string
  url?: string
  status?: number
}

interface ChapterSample { index: number; ok: boolean; length?: number; preview?: string; error?: ErrInfo }

interface SourceAudit {
  id: string | null
  name: string
  baseUrl: string
  stage: 'import' | 'search' | 'search-no-hit' | 'no-book-url' | 'toc' | 'content-error' | 'content-partial' | 'ok'
  searchKeyword?: string
  bookTitle?: string
  bookKey?: string
  tocCount?: number
  chapters?: ChapterSample[]
  error?: ErrInfo
  /** 搜索面收到的条目数（书名为空被丢的不算）——没取到带地址的条目时，这一位就是
   *  `search-no-hit`(0) 与 `no-book-url`(>0) 的分家依据 */
  hits?: number
  /** 搜索面书目字段的到货读数（`fieldsOf` 在选中那一轮上数出来的）：
   *  `declaresKind` = 该源 raw 里 `ruleSearch.kind` 非空（分母按真正落到链路里的这一位算） */
  fields?: { hits: number; withKind: number; withWordCount: number; declaresKind: boolean; declaresWordCount: boolean }
}

function errInfo(e: unknown): ErrInfo {
  const any = e as { name?: string; message?: string; facet?: string; segmentIndex?: number; segmentRaw?: string; url?: string; status?: number }
  return {
    name: any?.name ?? 'Unknown',
    message: String(any?.message ?? e).slice(0, 400),
    ...(any?.facet === undefined ? {} : { facet: any.facet }),
    ...(any?.segmentIndex === undefined ? {} : { segmentIndex: any.segmentIndex }),
    ...(any?.segmentRaw === undefined ? {} : { segmentRaw: String(any.segmentRaw).slice(0, 200) }),
    ...(any?.url === undefined ? {} : { url: any.url }),
    ...(any?.status === undefined ? {} : { status: any.status }),
  }
}

/** 错误归一化成桶键：URL/数字/引号内容压掉，保留语义骨架（骨架单点在 content-audit-classify） */
function bucketKey(stage: string, err?: ErrInfo): string {
  if (err === undefined) return stage
  return `${stage} | ${err.name} | ${messageSkeleton(err.message ?? '')}`
}

describe.skipIf(process.env.DSH_CONTENT_AUDIT !== '1')('正文链路全量审计（search → toc → content）', () => {
  it('sources.json 全量正文审计 → 逐段失败分桶 + 报告落盘', { timeout: 7_200_000 }, async () => {
    const sj = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'novel', 'sources.json')
    const dir = await makeTempDir('novel-audit-')
    // 审计口径：拷真实 sources.json 进临时数据根直接加载（生产同口径，不重导 normalize），
    // enabled 全置 true——审计问「链路通不通」，启停状态不参与判定
    const raws = JSON.parse(await fs.readFile(sj, 'utf8')) as Array<Record<string, unknown>>
    for (const s of raws) s.enabled = true
    await fs.writeFile(path.join(dir, 'sources.json'), JSON.stringify(raws), 'utf8')
    const systemProxy = await readSystemProxy()
    const proxyUrl = resolveProxyUrl({ env: process.env, systemProxy })
    const svc = trackService(await ReadingService.create({ dir, proxyUrl }))
    console.log(`[audit] 源总数 ${raws.length}；出站代理 ${proxyUrl ?? '(直连)'}`)

    // 注册表直读（生产同口径）。声明位按**两处**算：对象方言 `ruleSearch.kind` 与平铺顶层 `ruleKind`
    // ——分母漏一处会让到货率虚高，instrument 不能跟着本库形状走
    const nonEmpty = (v: unknown) => typeof v === 'string' && v.trim() !== ''
    const declares = (raw: unknown, nested: string, flat: string) => {
      const o = raw as Record<string, unknown> | undefined
      const box = o?.ruleSearch as Record<string, unknown> | undefined
      return nonEmpty(box?.[nested]) || nonEmpty(o?.[flat])
    }
    const ids: Array<{ id: string | null; name: string; baseUrl: string; raw: unknown; declaresKind: boolean; declaresWordCount: boolean }> =
      raws.map((s) => ({
        id: typeof s.id === 'string' ? s.id : null,
        name: typeof s.name === 'string' ? s.name : '(未命名)',
        baseUrl: typeof s.baseUrl === 'string' ? s.baseUrl : '',
        raw: s.raw,
        declaresKind: declares(s.raw, 'kind', 'ruleKind'),
        declaresWordCount: declares(s.raw, 'wordCount', 'ruleWordCount'),
      }))
    await svc.flush()

    const audits: SourceAudit[] = []
    const keywords = process.env.DSH_AUDIT_KEYWORDS?.split(',').filter((s) => s !== '') ?? ['小说', '完本', '的']
    const workers = Number(process.env.DSH_AUDIT_WORKERS ?? '5')
    const chapterIdxs = (process.env.DSH_AUDIT_CHAPTERS ?? '0,2,5,mid')
      .split(',').map((s) => s.trim()).filter((s) => s !== '')

    // 桶级复跑：DSH_AUDIT_ONLY 只审名字含任一子串的源——没有过滤口就只能整轮重打，
    // 网络噪声还会把复跑读数冲掉。
    const only = (process.env.DSH_AUDIT_ONLY ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '')
    const selected = only.length === 0 ? ids : ids.filter((s) => only.some((o) => s.name.includes(o)))
    console.log(`[audit] 待审源 ${selected.length}/${ids.length}${only.length === 0 ? '' : `（DSH_AUDIT_ONLY=${only.join('|')}）`}`)

    const queue = [...selected.entries()]
    let done = 0
    await Promise.all(Array.from({ length: workers }, async () => {
      for (;;) {
        const entry = queue.shift()
        if (entry === undefined) return
        const [, src] = entry
        const audit = await auditOne(svc, src, keywords, chapterIdxs)
        audits.push(audit)
        done++
        if (done % 20 === 0 || done === ids.length) console.log(`[audit] 进度 ${done}/${ids.length}`)
      }
    }))

    // ── 分桶汇总 + 报告落盘 ────────────────────────────────────────────────
    const buckets = new Map<string, number>()
    const stageCount = new Map<string, number>()
    for (const a of audits) {
      stageCount.set(a.stage, (stageCount.get(a.stage) ?? 0) + 1)
      if (a.stage === 'ok') continue
      const key = bucketKey(a.stage, a.error)
      buckets.set(key, (buckets.get(key) ?? 0) + 1)
    }
    const outDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)), '.superpowers', 'content-audit')
    await fs.mkdir(outDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    // 归因单点在 content-audit-classify：residual = host-gap + unattributed，兼容目标判据读这个数
    // 而不是三种 error name 混着的大数（混读会把「页面没这结构」算成本仓欠账）
    const classified = classifyAudits(audits)
    // 书目字段到货读数（只算搜索面）：字段级异常被吞成 null，失败分桶看不见——量的是「值真的到了」
    // 而非「接进了链路」；分母用 `ruleSearch.kind` 非空（详情面的 kind 不在这条链路）。
    const arrival = (field: 'withKind' | 'withWordCount', declares: 'declaresKind' | 'declaresWordCount') => {
      const withHits = audits.filter(a => a.fields?.[declares] === true && (a.fields?.hits ?? 0) > 0)
      const arrived = withHits.filter(a => (a.fields?.[field] ?? 0) > 0)
      const declaredTotal = audits.filter(a => a.fields?.[declares] === true).length
      return {
        declares: declaredTotal,
        searchedWithHits: withHits.length,
        arrivedSources: arrived.length,
        hitRatio: withHits.reduce((n, a) => n + (a.fields?.[field] ?? 0), 0)
          + '/' + withHits.reduce((n, a) => n + (a.fields?.hits ?? 0), 0),
      }
    }
    const report = {
      generatedAt: new Date().toISOString(),
      proxy: proxyUrl,
      keywords,
      total: audits.length,
      stageCount: Object.fromEntries(stageCount),
      attribution: { byKind: classified.byAttribution, residual: classified.residual },
      fieldArrival: { kind: arrival('withKind', 'declaresKind'), wordCount: arrival('withWordCount', 'declaresWordCount') },
      residualItems: classified.items.filter((i) => i.attribution === 'host-gap' || i.attribution === 'unattributed'),
      buckets: Object.fromEntries([...buckets].sort((a, b) => b[1] - a[1])),
      audits: audits.sort((a, b) => a.stage.localeCompare(b.stage) || a.name.localeCompare(b.name)),
    }
    const reportPath = path.join(outDir, `report-${stamp}.json`)
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
    await fs.writeFile(path.join(outDir, 'latest.json'), JSON.stringify(report, null, 2), 'utf8')

    console.log('\n=== 正文链路审计 ===')
    console.log(`总计 ${audits.length}`)
    console.log(`阶段分布：${[...stageCount].map(([k, v]) => `${k}=${v}`).join('  ')}`)
    console.log('失败分桶（前 40）：')
    for (const [k, v] of [...buckets].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`  [${v}] ${k}`)
    console.log(`引擎类归因：${Object.entries(classified.byAttribution).map(([k, v]) => `${k}=${v}`).join('  ')}`)
    console.log(`residual（host-gap + unattributed，兼容目标判据读这一条）：${classified.residual}`)
    for (const [k, v] of Object.entries(report.fieldArrival)) {
      console.log(`字段到货率[${k}]：声明 ${v.declares} 源 → 本轮出条目 ${v.searchedWithHits} 源，其中取到值的 ${v.arrivedSources} 源；逐条 ${v.hitRatio}`)
    }
    for (const i of classified.items.filter((x) => x.attribution === 'host-gap' || x.attribution === 'unattributed')) {
      console.log(`  ! ${i.name} [${i.attribution}] ${messageSkeleton(i.message)}`)
    }
    console.log(`报告：${reportPath}`)
    // 审计完整性：每个**被选中的**源都必须落进某个 stage——漏审会让通过率读数失真，
    // 这是本文件唯一能机器判的事。
    expect(audits.length).toBe(selected.length)
  })
})

async function auditOne(
  svc: ReadingService,
  src: { id: string | null; name: string; baseUrl: string; declaresKind: boolean; declaresWordCount: boolean },
  keywords: string[],
  chapterIdxs: string[],
): Promise<SourceAudit> {
  const base: SourceAudit = { id: src.id, name: src.name, baseUrl: src.baseUrl, stage: 'ok' }
  if (src.id === null) return { ...base, stage: 'import', error: { name: 'ImportFailed', message: '导入失败（normalize 不 ok）' } }

  // ── 搜索面（逐词重试，口径同 probe）────────────────────────────────────
  let hit: { title: string; url: string | null } | null = null
  let usedKeyword = ''
  let fields: SourceAudit['fields']
  // 逐词重试期间见过的**最大条目数**：没取到带地址的条目时，靠它把「一条都没出」
  // （列表规则零命中）与「出了条目但地址全 null」（bookUrl 规则）分开——两者下一步动作不同
  let maxHits = 0
  for (const kw of keywords) {
    try {
      const groups = await svc.search(kw, { sourceIds: [src.id] })
      const g = groups[0]
      if (g === undefined) continue
      if (g.error !== undefined && g.error !== null) {
        return { ...base, stage: 'search', searchKeyword: kw, error: { name: g.error.code, message: g.error.message.slice(0, 400) } }
      }
      maxHits = Math.max(maxHits, g.hits.length)
      const h = g.hits.find((x) => x.url !== null) ?? null
      if (h !== null) {
        hit = { title: h.title, url: h.url }
        usedKeyword = kw
        // 字段到货现量：字段级异常被吞成 null，失败分桶看不见——「实现了」与「值到了」的差别靠这行
        fields = {
          hits: g.hits.length,
          withKind: g.hits.filter((x) => x.kind !== null && x.kind !== '').length,
          withWordCount: g.hits.filter((x) => x.wordCount !== null && x.wordCount !== '').length,
          declaresKind: src.declaresKind,
          declaresWordCount: src.declaresWordCount,
        }
        break
      }
    } catch (e) {
      return { ...base, stage: 'search', searchKeyword: kw, error: errInfo(e) }
    }
  }
  if (hit === null || hit.url === null) {
    return { ...base, stage: searchFaceStageOf(maxHits), searchKeyword: keywords.join('/'), hits: maxHits }
  }
  const withBook = { ...base, searchKeyword: usedKeyword, bookTitle: hit.title, bookKey: hit.url, ...(fields === undefined ? {} : { fields }) }

  let toc: Array<{ name: string; url: string }>
  try {
    toc = await svc.getToc(src.id, hit.url)
  } catch (e) {
    return { ...withBook, stage: 'toc', error: errInfo(e) }
  }
  if (toc.length === 0) {
    return { ...withBook, stage: 'toc', tocCount: 0, error: { name: 'EmptyToc', message: '目录 0 章' } }
  }

  // ── 正文面：多章采样 ────────────────────────────────────────────────────
  const samples: number[] = []
  for (const spec of chapterIdxs) {
    const idx = spec === 'mid' ? Math.floor(toc.length / 2) : Number(spec)
    if (Number.isInteger(idx) && idx >= 0 && idx < toc.length && !samples.includes(idx)) samples.push(idx)
  }
  const chapters: ChapterSample[] = []
  for (const idx of samples) {
    try {
      const text = await svc.getChapter(src.id, hit.url, idx)
      chapters.push({ index: idx, ok: true, length: text.length, preview: text.slice(0, 120).replace(/\n/g, '⏎') })
    } catch (e) {
      chapters.push({ index: idx, ok: false, error: errInfo(e) })
    }
  }
  const okCount = chapters.filter((c) => c.ok).length
  if (okCount === chapters.length && chapters.length > 0) {
    return { ...withBook, stage: 'ok', tocCount: toc.length, chapters }
  }
  const firstErr = chapters.find((c) => !c.ok)?.error
  return {
    ...withBook,
    stage: okCount > 0 ? 'content-partial' : 'content-error',
    tocCount: toc.length,
    chapters,
    ...(firstErr === undefined ? {} : { error: firstErr }),
  }
}
