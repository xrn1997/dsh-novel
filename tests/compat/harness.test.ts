import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { loadCases, makeReplayFetch, renderReport, runCase } from './harness.js'
import { makeTempDir } from '../temp-dir.js'
const rawSource = {
  bookSourceName: 'S', bookSourceUrl: 'https://s.com', searchUrl: 'https://s.com/search?q={{key}}',
  ruleBookList: '@css:.b', ruleBookName: 'tag.a@text', ruleBookUrl: 'tag.a@href',
  ruleChapterName: 'tag.a@text', ruleChapterUrl: 'tag.a@href', ruleContent: '@css:#content@textNodes',
}
const PAGES: Record<string, string> = {
  'https://s.com/search?q=%E4%B9%A6': '<html><body><div class="b"><a href="/book/1/">书名</a></div></body></html>',
  'https://s.com/book/1/': '<html><body><div class="b ch"><a href="/c/1.html">第一章</a></div></body></html>',
  'https://s.com/c/1.html': '<html><body><div id="content">正文</div></body></html>',
}
async function makeCaseDir(capturedAt = 1): Promise<string> {
  const dir = await makeTempDir('compat-h-')
  await fs.mkdir(path.join(dir, 'pages'), { recursive: true })
  let i = 0
  const pages: Record<string, string> = {}
  for (const [url, html] of Object.entries(PAGES)) {
    const f = `pages/${i++}.html`
    await fs.writeFile(path.join(dir, f), html, 'utf8')
    pages[url] = f
  }
  await fs.writeFile(path.join(dir, 'source.json'), JSON.stringify(rawSource), 'utf8')
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ keyword: '书', capturedAt, pages }), 'utf8')
  return dir
}

describe('compat harness（离线自测）', () => {
  it('runCase 全链路四步跑通', async () => {
    const [c] = loadCases(await makeCaseDir())
    const r = await runCase(c)
    expect(r.ok).toBe(true)
    expect(r.steps.every((s) => s.ok)).toBe(true)
    expect(r.stats).toMatchObject({ searchHits: 1, tocChapters: 1, chapterChars: 2 })
  })
  it('fixture 缺 URL → 明确报「fixture 缺失」', async () => {
    const dir = await makeCaseDir()
    const mf = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'))
    delete mf.pages['https://s.com/c/1.html']
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(mf), 'utf8')
    const [c] = loadCases(dir)
    const r = await runCase(c)
    expect(r.ok).toBe(false)
    const failed = r.steps.find((s) => !s.ok)!
    expect(failed.error!.message).toContain('fixture 缺失')
  })
  it('renderReport：总计行 + 明细表（行键 = caseName = 目录名）', async () => {
    const [c] = loadCases(await makeCaseDir())
    const ok = await runCase(c)
    const md = renderReport([ok])
    expect(md).toContain('全链路跑通 1 条')
    expect(md).toContain(`| ${ok.caseName} | ✅ |`)
    // 分母构成按数据自述：树里只有手写基线时，报告头**不许**宣称有真站采集（红检：把
    // `renderReport` 的头注改回写死「两类」措辞即红）。详情面读数列同口径——断言了就要看得见。
    expect(md).toContain('本批 0 条真站采集 + 1 条合成基线')
    expect(md).toContain('| 详情 kind/wordCount |')
  })
  it('renderReport：采集来的 case（manifest 带真采集时刻）计入真站侧', async () => {
    const [c] = loadCases(await makeCaseDir(Date.now()))
    const ok = await runCase(c)
    expect(ok.fromCapture, '采集时刻在 manifest 里，判据却读不到——分母构成会报错').toBe(true)
    expect(renderReport([ok])).toContain('本批 1 条真站采集 + 0 条合成基线')
  })
  it('makeReplayFetch 未命中 URL 的确定性报错（补 capture 的指引）', async () => {
    const [c] = loadCases(await makeCaseDir())
    const f = makeReplayFetch(c)
    await expect(f('https://unknown.example/x')).rejects.toThrowError(/fixture 缺失/)
  })
})
