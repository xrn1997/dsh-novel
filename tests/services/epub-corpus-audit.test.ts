import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { EpubImportError } from '../../src/services/epub/errors.js'
import { importEpub } from '../../src/services/epub/import.js'
import { makeTempDir } from '../temp-dir.js'

// 真语料审计（DSH_EPUB_CORPUS=1 才跑——读本机目录里的真实 EPUB，逐本导入并按后果分桶；不进常规集）。
//
// **它是审计报告，不是通过率门**：唯一断言是审计自洽——每一本都得得出一个结局，被拒的每本都带着
// 一条说得出口的原因。红即工具坏。通过率、痕码分布、被拒原因清单都在报告里，靠人判。
//
// 语料目录：`DSH_EPUB_CORPUS_DIR`，缺省 `$DSH_HOME/novel/corpus/`（递归找 `.epub`）。
// **语料不入库**（体积与版权都不允许），默认门也不依赖任何外部下载——真实形状进默认门的合法路径
// 是把形状提炼进 `tests/fixtures/epub.ts` 的合成表（`epub3-body-anchor`、`epub3-blank-copyright-page`
// 就是这么来的）。用 Calibre 把公版书自转成 EPUB 再落这个目录，可以复现「封面 id 挂在 body 上」那一族
// 真实写法而不带来版权问题。
//
// 报告落 `.superpowers/epub-corpus/`（本机，不入库）。

interface BookAudit {
  file: string
  bytes: number
  outcome: 'ok' | 'rejected' | 'crash'
  chapters?: number
  /** 这本触发的痕码 → 条数（半径规则在真书上的实际形状） */
  warningCodes?: Record<string, number>
  /** 被拒的原因骨架（消息去动态部分）：分桶用，人判靠它 */
  reason?: string
  /** 非 EpubImportError 的异常：那是我们的缺陷，不是书的毛病——单列一桶，不混进 rejected */
  errorName?: string
}

/** 消息骨架：压掉路径/数字/引号内容，让同一类原因落进同一桶（判据本身在下面的工具自测组里钉住） */
function reasonSkeleton(message: string): string {
  return message
    .replace(/[\w./\\-]*\.(?:xhtml|html|opf|ncx|png|jpg|jpeg|gif|webp|svg|xml)/gi, '<资源>')
    .replace(/#([\w-]+)/g, '#<锚点>')
    .replace(/\d+/g, '<n>')
    .slice(0, 120)
}

async function corpusDir(): Promise<string> {
  return process.env.DSH_EPUB_CORPUS_DIR
    ?? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'novel', 'corpus')
}

async function findEpubs(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string): Promise<void> => {
    for (const entry of await fs.readdir(d, { withFileTypes: true }).catch((): [] => [])) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) await walk(p)
      else if (entry.name.toLowerCase().endsWith('.epub')) out.push(p)
    }
  }
  await walk(dir)
  return out.sort()
}

describe.skipIf(process.env.DSH_EPUB_CORPUS !== '1')('EPUB 真语料导入审计', () => {
  it('逐本导入 → 分桶 + 痕码分布 + 被拒原因清单，报告落盘', { timeout: 3_600_000 }, async () => {
    const dir = await corpusDir()
    const files = await findEpubs(dir)
    const audits: BookAudit[] = []
    for (const file of files) {
      const bytes = (await fs.stat(file)).size
      const outDir = await makeTempDir('novel-corpus-')
      const base: BookAudit = { file: path.relative(dir, file), bytes, outcome: 'crash' }
      try {
        const data = await importEpub(await fs.readFile(file), outDir)
        const warningCodes: Record<string, number> = {}
        for (const f of data.findings) warningCodes[f.code] = (warningCodes[f.code] ?? 0) + f.count
        audits.push({ ...base, outcome: 'ok', chapters: data.chapters.length, warningCodes })
      } catch (e) {
        if (e instanceof EpubImportError) {
          audits.push({ ...base, outcome: 'rejected', reason: reasonSkeleton(e.message) })
        } else {
          audits.push({ ...base, outcome: 'crash', errorName: e instanceof Error ? e.name : String(e) })
        }
      } finally {
        await fs.rm(outDir, { recursive: true, force: true }).catch(() => undefined)
      }
    }

    const byOutcome = { ok: 0, rejected: 0, crash: 0 }
    const codeTotals: Record<string, number> = {}
    const rejectBuckets: Record<string, number> = {}
    for (const a of audits) {
      byOutcome[a.outcome] += 1
      for (const [code, n] of Object.entries(a.warningCodes ?? {})) codeTotals[code] = (codeTotals[code] ?? 0) + n
      if (a.reason !== undefined) rejectBuckets[a.reason] = (rejectBuckets[a.reason] ?? 0) + 1
    }
    const report = { dir, denominator: `${files.length} 本（语料目录，不是现网可用率）`, audits, byOutcome, codeTotals, rejectBuckets }
    const reportDir = path.join(process.cwd(), '.superpowers', 'epub-corpus')
    await fs.mkdir(reportDir, { recursive: true })
    const reportPath = path.join(reportDir, 'latest.json')
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')

    // 唯一断言：审计自洽。每本都得出结局；被拒的必须带原因（「导入失败」四个字不算原因）。
    const incomplete = audits.filter((a) => a.outcome === 'rejected' ? (a.reason ?? '') === '' : a.outcome === 'ok' ? a.chapters === undefined : false)
    expect(incomplete, `这些本没得出可用读数：${incomplete.map((a) => a.file).join(', ')}`).toEqual([])
    console.log(`语料：${dir}｜${files.length} 本｜ok ${byOutcome.ok} / rejected ${byOutcome.rejected} / crash ${byOutcome.crash}`)
    console.log(`痕码：${JSON.stringify(codeTotals)}`)
    console.log(`被拒原因：${JSON.stringify(rejectBuckets, null, 2)}`)
    console.log(`报告：${reportPath}`)
  })
})

describe('审计报告工具自身（不等真语料也该判得对）', () => {
  it('骨架把资源名与数字压成同一类原因，不把同族失败拆成一堆桶', () => {
    const a = reasonSkeleton('OEBPS/Text/part0009.xhtml：目标锚点在文档里不存在：#8IL20-d699（OEBPS/text/part0009.html）')
    const b = reasonSkeleton('OEBPS/Text/part0123.xhtml：目标锚点在文档里不存在：#ZZ9-1234567890（OEBPS/text/part0123.html）')
    expect(a).toBe(b)
    expect(a).toContain('目标锚点在文档里不存在')
  })

  it('递归找语料：子目录里的 .epub 也算，非 EPUB 不收', async () => {
    const dir = await makeTempDir('novel-corpus-probe-')
    await fs.mkdir(path.join(dir, 'sub'), { recursive: true })
    await fs.writeFile(path.join(dir, 'a.epub'), 'x')
    await fs.writeFile(path.join(dir, 'sub', 'b.EPUB'), 'x')
    await fs.writeFile(path.join(dir, 'notes.txt'), 'x')
    const found = (await findEpubs(dir)).map((f) => path.relative(dir, f)).sort()
    expect(found).toEqual(['a.epub', path.join('sub', 'b.EPUB')])
  })

  it('目录不存在时得出空读数，不炸（报告说清分母为 0）', async () => {
    expect(await findEpubs(path.join(await makeTempDir('novel-corpus-none-'), 'missing'))).toEqual([])
  })
})
