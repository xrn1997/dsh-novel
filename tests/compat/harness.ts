import { existsSync, promises as fs, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { ReadingService } from '../../src/services/reading.js'
import { makeTempDir, trackService } from '../temp-dir.js'

/**
 * compat 回放 harness：真实源 + 脱敏页面 fixture 的离线回放（全程零网络）。
  * 「全链路跑通」口径：import 探针 verified → 聚合搜索命中 ≥1 → **详情书名为空即失败** →
  * 首本 getToc 非空 → 首章 getChapter 非空文本；另按**声明即须到货**断言详情面的 kind/wordCount
  * （与正文链路审计的字段到货读数同口径——fixture 的意义是冻结一次真实读数，
  * 所以「源声明了、站点给过」的字段必须一直给）。
 */

export interface CompatCase {
  caseName: string
  dir: string
  source: unknown
  manifest: { keyword: string; capturedAt?: number; pages: Record<string, string> }
}

export type CompatFace = 'import' | 'search' | 'detail' | 'toc' | 'chapter'
export interface CaseStep {
  face: CompatFace
  ok: boolean
  error?: { code: string; message: string }
}
export interface CaseResult {
  caseName: string
  ok: boolean
  steps: CaseStep[]
  /** 页面来自真站采集（不是手写合成基线）——报告头按它自述分母构成，见 `renderReport` */
  fromCapture: boolean
  /** 详情面读数（`null` = 该源没声明这条规则）：与审计的字段到货口径一致，断言了什么就报什么 */
  stats: {
    searchHits: number; tocChapters: number; chapterChars: number
    detailKind: boolean | null; detailWordCount: boolean | null
  }
}

/** 手写合成基线没有「采集那一刻」，manifest 用 1 占位；采集工具写 `Date.now()`（`capture.test.ts`）。
 *  分母构成必须由数据说话：写死在模板里的口径句会在真站 fixture 缺席时继续宣称它们在场。 */
const SYNTHETIC_CAPTURED_AT = 1

/** root 本身含 source.json → 单 case 目录；否则扫 root 的每个含 source.json 的子目录。坏 manifest → 跳过 + warn（不 throw——坏 case 不打挂整个 compat 面） */
export function loadCases(root: string): CompatCase[] {
  const out: CompatCase[] = []
  const consider = (dir: string, caseName: string): void => {
    const sourcePath = path.join(dir, 'source.json')
    const manifestPath = path.join(dir, 'manifest.json')
    if (!existsSync(sourcePath) || !existsSync(manifestPath)) return
    try {
      const source = JSON.parse(readFileSync(sourcePath, 'utf8'))
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CompatCase['manifest']
      if (typeof manifest.keyword !== 'string' || typeof manifest.pages !== 'object' || manifest.pages === null) {
        throw new Error('manifest 缺 keyword/pages')
      }
      out.push({ caseName, dir, source, manifest })
    } catch (e) {
      console.warn(`[compat] 跳过坏 case ${caseName}: ${String(e)}`)
    }
  }
  if (existsSync(path.join(root, 'source.json'))) {
    consider(root, path.basename(root))
  } else {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) consider(path.join(root, entry.name), entry.name)
    }
  }
  return out
}

/** manifest 精确 URL 匹配的回放 fetch（响应 content-type 按扩展名）；未命中 → 确定性报错指引重跑 capture */
export function makeReplayFetch(c: CompatCase): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    const rel = c.manifest.pages[url]
    if (rel === undefined) throw new Error(`fixture 缺失: ${url}（重跑 capture 补齐）`)
    const body = await fs.readFile(path.join(c.dir, rel))
    return new Response(body as unknown as BodyInit, {
      headers: { 'content-type': rel.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8' },
    })
  }) as typeof globalThis.fetch
}

const faceOrder: CompatFace[] = ['import', 'search', 'detail', 'toc', 'chapter']

/** 详情面字段是否被**该源自己声明**（`ruleBookInfo` 对象或字符串化 JSON；也认平铺的 ruleKind/ruleWordCount）。
 *  `name` 只认**详情面专属**的声明（`ruleBookInfo.name` / 平铺 `ruleDetailName`）：不算 `ruleBookName`
 *  那条平铺回退——纯 API 源（米读看书）没有 `ruleBookInfo`，书名只在**搜索条目**上给，详情页（章节表 JSON）
 *  里根本没有它，拿搜索面的规则去要求详情面等于**给源加它没声明的义务**（2026-09-28 实证：米读 的 fixture
 *  采集通过、回放却在「详情书名为空」处红）。 */
export function declaresDetail(source: unknown, field: 'name' | 'kind' | 'wordCount'): boolean {
  const raw = source as Record<string, unknown>
  const nonEmpty = (v: unknown) => typeof v === 'string' && v.trim() !== ''
  let box = raw.ruleBookInfo
  if (typeof box === 'string') { try { box = JSON.parse(box) } catch { box = null } }
  const nested = box !== null && typeof box === 'object' ? (box as Record<string, unknown>)[field] : undefined
  if (nonEmpty(nested)) return true
  const flat = field === 'name' ? ['ruleDetailName'] : [field === 'kind' ? 'ruleKind' : 'ruleWordCount']
  return flat.some((k) => nonEmpty(raw[k]))
}

/** 单 case 全链路回放：四步串行，失败步后 break；每步独立临时数据目录（归 setup.ts 登记簿回收） */
export async function runCase(c: CompatCase): Promise<CaseResult> {
  const tmp = await makeTempDir('compat-run-')
  const steps: CaseStep[] = []
  const stats: CaseResult['stats'] = {
    searchHits: 0, tocChapters: 0, chapterChars: 0, detailKind: null, detailWordCount: null,
  }
  let ok = true
  const fail = (face: CompatFace, e: unknown): void => {
    ok = false
    steps.push({ face, ok: false, error: { code: e instanceof Error ? e.constructor.name : 'Error', message: e instanceof Error ? e.message.split('\n')[0] : String(e) } })
  }
  try {
    const svc = trackService(await ReadingService.create({ dir: tmp, fetchImpl: makeReplayFetch(c) }))
    try {
      // ① import（规范化入库后显式探针——导入不探针，验证归 probe 单点）
      const outcome = (await svc.importSource(c.source))[0]
      if (!outcome.ok) throw new Error(`规范化失败：${outcome.missing.map((m) => m.field).join(',')}`)
      const sourceId = outcome.sourceId!
      const probe = await svc.probe(sourceId)
      if (!probe.ok) {
        throw new Error(`探针失败：${probe.error?.code ?? '?'} ${probe.error?.message ?? ''}`)
      }
      steps.push({ face: 'import', ok: true })

      // ② search（首个非空组首条）
      const groups = await svc.search(String(c.manifest.keyword))
      const hit = groups.flatMap((g) => g.hits).find((h) => h.url !== null)
      if (hit === undefined || hit.url === null) {
        const gerr = groups.find((g) => g.error !== undefined)?.error
        throw new Error(gerr === undefined ? '搜索零命中' : `搜索失败：${gerr.code} ${gerr.message}`)
      }
      stats.searchHits = groups.reduce((n, g) => n + g.hits.length, 0)
      steps.push({ face: 'search', ok: true })

      // ③ detail（详情面：`ruleBookInfo.*` 的取值 —— 回放四步此前整个漏了这一面，
      // 而库里大量源的 kind/lastChapter/intro 只在详情面；缺它时 fixture 保护不到那些规则。
      // 断言全是**声明即须到货**：详情书名只在源自己声明了详情面书名时才要求（纯 API 源没有详情面），
      // kind/wordCount 同理。这条闸与 capture 侧**同一份判据**（见那里），否则会采出回放不了的 fixture）
      const detail = await svc.getDetail(sourceId, hit.url)
      if (declaresDetail(c.source, 'name') && (detail.title === null || detail.title.trim() === '')) {
        throw new Error('详情书名为空（源声明了详情面书名规则）')
      }
      for (const f of ['kind', 'wordCount'] as const) {
        const declared = declaresDetail(c.source, f)
        const arrived = detail[f] !== null && String(detail[f]).trim() !== ''
        if (declared) stats[f === 'kind' ? 'detailKind' : 'detailWordCount'] = arrived
        if (declared && !arrived) {
          throw new Error(`详情字段未到货：${f}（源声明了该规则，采集时也取到了值）`)
        }
      }
      steps.push({ face: 'detail', ok: true })

      // ④ toc（非空）
      const toc = await svc.getToc(sourceId, hit.url)
      if (toc.length === 0) throw new Error('目录为空')
      stats.tocChapters = toc.length
      steps.push({ face: 'toc', ok: true })

      // ⑤ chapter（首章非空文本）
      const text = await svc.getChapter(sourceId, hit.url, 0)
      if (text.length === 0) throw new Error('首章正文为空')
      stats.chapterChars = text.length
      steps.push({ face: 'chapter', ok: true })
    } finally {
      await svc.flush()
    }
  } catch (e) {
    const doneFaces = new Set(steps.map((s) => s.face))
    const nextFace = faceOrder.find((f) => !doneFaces.has(f)) ?? 'chapter'
    fail(nextFace, e)
  }
  return { caseName: c.caseName, ok, steps, fromCapture: (c.manifest.capturedAt ?? 0) > SYNTHETIC_CAPTURED_AT, stats }
}

/** 报告渲染（按「报告格式」节）：总计行 + 失败原因分布 + 逐源明细。
 *  刻意**不写生成时间**：时间戳会让每次 `pnpm test:compat` 都改写入库文件、把 diff 噪声
  *  带进提交。分母口径写进报告头，避免把「合成 fixture 跑通率」误读为站点兼容率。 */
export function renderReport(results: CaseResult[], keyword?: string): string {
  const total = results.length
  const passed = results.filter((r) => r.ok).length
  const captured = results.filter((r) => r.fromCapture).length
  const rate = total === 0 ? '—' : `${Math.round((passed / total) * 100)}%`
  const lines: string[] = [
    '# compat 报告',
    '',
    `> 分母 = \`compat/fixtures/\` 下的 fixture（本批 ${captured} 条真站采集 + ${total - captured} 条合成基线；离线回放，零网络）。`,
    '> **回放跑通率不是站点可用率**——真源 fixture 冻结的是**采集那一刻**的页面，站点后来变了它照样绿。',
    '> 站点可用率请看真机重探：`$env:DSH_REPROBE=\'1\'; pnpm vitest run tests/reprobe.test.ts`。',
    '',
  ]
  if (keyword !== undefined) lines.push(`- 关键词：${keyword}`)
  lines.push(`- 总计：${total} 条源；全链路跑通 ${passed} 条（${rate}）`, '')

  // 失败原因分布（面 × 错误类聚合）
  const dist = new Map<string, { count: number; cases: string[] }>()
  for (const r of results) {
    const failStep = r.steps.find((s) => !s.ok)
    if (failStep === undefined) continue
    const key = `${failStep.face} | ${failStep.error?.code ?? '?'}`
    const entry = dist.get(key) ?? { count: 0, cases: [] }
    entry.count++
    entry.cases.push(r.caseName)
    dist.set(key, entry)
  }
  lines.push('## 失败原因分布', '', '| 面 | 错误类 | 次数 | 涉及源 |', '|---|---|---|---|')
  if (dist.size === 0) lines.push('| — | — | 0 | — |')
  for (const [key, e] of [...dist.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const [face, code] = key.split(' | ')
    lines.push(`| ${face} | ${code} | ${e.count} | ${e.cases.join('、')} |`)
  }
  lines.push('', '## 逐源明细', '', '| 源 | 结果 | 首个失败面 | 错误 | 搜索命中 | 目录章数 | 正文字数 | 详情 kind/wordCount |', '|---|---|---|---|---|---|---|---|')
  for (const r of results) {
    const failStep = r.steps.find((s) => !s.ok)
    lines.push(`| ${r.caseName} | ${r.ok ? '✅' : '❌'} | ${failStep?.face ?? '—'} | ${failStep === undefined ? '—' : `${failStep.error?.code}: ${failStep.error?.message}`.slice(0, 120)} | ${r.stats.searchHits} | ${r.stats.tocChapters} | ${r.stats.chapterChars} | ${r.stats.detailKind === null ? '·' : r.stats.detailKind ? '✓' : '✗'}/${r.stats.detailWordCount === null ? '·' : r.stats.detailWordCount ? '✓' : '✗'} |`)
  }
  return lines.join('\n') + '\n'
}
