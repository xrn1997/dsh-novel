import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ReadingService } from '../../src/services/reading.js'
import { readSystemProxy, resolveProxyUrl } from '../../src/services/proxy.js'
import { makeTempDir, trackService } from '../temp-dir.js'
import { sanitize } from './sanitize.js'
import { declaresDetail } from './harness.js'
import { recordBodyOf } from './record.js'

const KEYWORD = process.env.COMPAT_KEYWORD ?? '书'

/** 记录型 fetch：passthrough 真请求，同时把每个响应（**请求 URL** → utf8 文本）存进内存供落盘。
 *  **键必须是请求 URL**：回放侧（harness 的 `makeReplayFetch`）就是按请求 URL 查表的。此前用
 *  `res.url`（跟随重定向后的落地地址）当键，于是「POST 出去、302 落到结果页」的搜索请求在
 *  manifest 里根本没有自己的键——采集看起来成功，回放当场报 `fixture 缺失`（九九藏书实证）。
 *  **解码必须走生产那条链**（`decodeBody`：声明 charset → content-type → `<meta>` 嗅探）：
 *  此前是 `buf.toString('utf8')`，GBK 页会被存成乱码——采集能过（断言跑在**真**解码链上）、
 *  回放必红（回放一律以 utf-8 提供文本），又一种「采集与回放断的不是同一批」。 */
function recordFetch() {
  const pages = new Map<string, { body: string; contentType?: string }>()
  const CT_CHARSET_RE = /charset=([^;\s"']+)/i
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const res = await globalThis.fetch(input, init)
    const clone = res.clone()
    const buf = Buffer.from(await clone.arrayBuffer())
    const ct = clone.headers.get('content-type') ?? undefined
    pages.set(url, { body: recordBodyOf(buf, res.url || url, ct, res.status), contentType: ct })
    return res
  }) as typeof globalThis.fetch
  return { fetchImpl, pages }
}

function hash8(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16).padStart(8, '0')
}

describe.skipIf(process.env.COMPAT_CAPTURE !== '1')('compat 采集', () => {
  it('逐源：真请求四步 → fixture 落盘（脱敏两刀）', { timeout: 300_000 }, async () => {
    const sourcesDir = path.resolve('compat/sources')
    const files = (await fs.readdir(sourcesDir).catch(() => [])).filter((f) => f.endsWith('.json'))
    expect(files.length, `compat/sources 下没有源 JSON——先投放再采集`).toBeGreaterThan(0)
    // 出站姿态与生产/审计同口径：resolveProxyUrl（config > 环境变量 > 系统代理 > 直连）。
    // 缺这条时采集走直连——只有代理能到的站点会返回反爬/空页，采集在「正文为空」处假红
    // （实测：若夏的正文接口直连拿到的是壳页，规则照实报零命中）。
    const proxyUrl = resolveProxyUrl({ env: process.env, systemProxy: await readSystemProxy() })
    console.log(`[compat] 源总数 ${files.length}；出站代理 ${proxyUrl ?? '(直连)'}`)
    for (const f of files) {
      const caseName = f.replace(/\.json$/, '')
      const raw = JSON.parse(await fs.readFile(path.join(sourcesDir, f), 'utf8'))
      const { fetchImpl, pages } = recordFetch()
      const dir = await makeTempDir('compat-cap-')
      const svc = trackService(await ReadingService.create({ dir, fetchImpl, proxyUrl }))
      const outcome = (await svc.importSource(raw))[0]
      expect(outcome.ok, `${caseName}: 导入规范化失败——${outcome.missing.map((m) => m.field).join(',')}`).toBe(true)
      // 导入不探针——采集口径与回放一致：导入后显式探一次
      const probe = await svc.probe(outcome.sourceId!)
      expect(probe.ok, `${caseName}: 探针失败——${probe.error?.message}`).toBe(true)
      const groups = await svc.search(KEYWORD)
      const hit = groups.flatMap((g) => g.hits).find((h) => h.url !== null)
      expect(hit, `${caseName}: 搜索零命中（关键词 ${KEYWORD}）`).toBeTruthy()
      const toc = await svc.getToc(outcome.sourceId!, hit!.url!)
      expect(toc.length, `${caseName}: 目录为空`).toBeGreaterThan(0)
      const text = await svc.getChapter(outcome.sourceId!, hit!.url!, 0)
      expect(text.length, `${caseName}: 首章正文为空`).toBeGreaterThan(0)
      // 详情面：与回放**同一份判据**（`declaresDetail`，声明即须到货）。采集侧此前不查这一面，
      // 于是能采出「采集绿、回放红」的 fixture（2026-09-28 米读看书实证：它是纯 API 源、没有
      // ruleBookInfo，回放却在「详情书名为空」处红）——采集必须把回放会断的每一条都先断一遍。
      const detail = await svc.getDetail(outcome.sourceId!, hit!.url!)
      if (declaresDetail(raw, 'name')) {
        expect(detail.title?.trim(), `${caseName}: 详情书名为空（源声明了详情面书名规则）`).toBeTruthy()
      }
      for (const f of ['kind', 'wordCount'] as const) {
        if (declaresDetail(raw, f)) {
          expect(String(detail[f] ?? '').trim(), `${caseName}: 详情字段未到货：${f}`).toBeTruthy()
        }
      }
      await svc.flush()

      // 落盘：source.json 快照 + manifest（keyword 快照——采集与回放必须同关键词）+ 脱敏 pages
      const outDir = path.resolve('compat/fixtures', caseName)
      await fs.mkdir(path.join(outDir, 'pages'), { recursive: true })
      await fs.writeFile(path.join(outDir, 'source.json'), JSON.stringify(raw, null, 2), 'utf8')
      const manifest: { keyword: string; capturedAt: number; pages: Record<string, string> } = {
        keyword: KEYWORD, capturedAt: Date.now(), pages: {},
      }
      let i = 0
      for (const [url, { body }] of pages) {
        const rel = `pages/${i++}-${hash8(url)}.html`
        await fs.writeFile(path.join(outDir, rel), sanitize(body), 'utf8')
        manifest.pages[url] = rel
      }
      await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    }
  })
})
