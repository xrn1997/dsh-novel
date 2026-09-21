import { describe, expect, it } from 'vitest'
import { exportBook } from '../../src/services/export.js'
import type { ChapterEntry } from '../../src/services/reading.js'

const BOM = '\uFEFF' // U+FEFF（显式转义写法，防不可见字符丢失）

const TOC: ChapterEntry[] = [
  { name: '第一章 起', url: 'u1' },
  { name: '第二章 承', url: 'u2' },
  { name: '第三章 转', url: 'u3' },
]

// 范围由调用方裁好（判据单点在路由层）——本文件的直调用 FULL 代表全本
const FULL = { from: 1, to: TOC.length }

function makeDeps(overrides?: { failAt?: number; failMsg?: string }): {
  deps: Parameters<typeof exportBook>[0]
  calls: string[]
  sleeps: number[]
} {
  const calls: string[] = []
  const sleeps: number[] = []
  const deps = {
    getToc: async (): Promise<ChapterEntry[]> => TOC,
    getChapter: async (_s: string, _b: string, i: number): Promise<string> => {
      calls.push(`ch${i}`)
      if (overrides?.failAt === i) throw new Error(overrides.failMsg ?? '网络炸了')
      return `正文${i}`
    },
    sleep: async (ms: number): Promise<void> => { sleeps.push(ms) },
  }
  return { deps, calls, sleeps }
}

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = ''
  for await (const chunk of gen) out += chunk
  return out
}

describe('exportBook', () => {
  it('串行节流：N 章顺序输出、N-1 次 sleep(delayMs)、BOM 开头、章格式钉死', async () => {
    const { deps, calls, sleeps } = makeDeps()
    const out = await collect(exportBook(deps, 's', 'b', { title: '书', delayMs: 300, ...FULL }))
    expect(out.startsWith(BOM)).toBe(true)
    expect(calls).toEqual(['ch0', 'ch1', 'ch2'])
    expect(sleeps).toEqual([300, 300])                     // N-1 次，间隔值 = delayMs
    expect(out).toContain('《书》· 第一章 起\n\n正文0')
    expect(out).toContain('《书》· 第三章 转\n\n正文2')
  })

  it('失败即停：第 k 章抛错 → 无第 k+1 次请求、流尾标记含章名与原因、不再 sleep', async () => {
    const { deps, calls, sleeps } = makeDeps({ failAt: 1, failMsg: '403 疑似限流' })
    const out = await collect(exportBook(deps, 's', 'b', { title: '书', delayMs: 100, ...FULL }))
    expect(calls).toEqual(['ch0', 'ch1'])                  // ch2 从未发起
    expect(sleeps).toEqual([100])                          // 只有失败前那一次
    expect(out).toContain('[导出中断于第 2 章《第二章 承》：403 疑似限流]')
    expect(out).not.toContain('正文2')
  })

  it('取消：signal 已 abort → 首章前退出，零章节请求', async () => {
    const { deps, calls } = makeDeps()
    const ctrl = new AbortController()
    ctrl.abort()
    const out = await collect(exportBook(deps, 's', 'b', { title: '书', delayMs: 1, signal: ctrl.signal, ...FULL }))
    expect(out).toBe(BOM)                                  // 只剩 BOM
    expect(calls).toEqual([])
  })

  it('toc 抛错 → 透传（路由层借此在首包前走错误信封）', async () => {
    const deps = { getToc: async () => { throw new Error('目录挂了') }, getChapter: async () => '' }
    await expect(collect(exportBook(deps, 's', 'b', { title: 'x', delayMs: 1, ...FULL })))
      .rejects.toThrow('目录挂了')
  })

  it('空目录 / 越界 / 倒置 → 一律抛，不再有各自的静默出口', async () => {
    const empty = { getToc: async (): Promise<ChapterEntry[]> => [], getChapter: async () => '' }
    // 旧形态：空目录只发一个 BOM（首包已 200，状态码改不了）——「只有 BOM 的文件」和
    // 「导完的空书」在用户手里没区别，正是本仓定的最高罪。现在合起来判：范围不是 toc 的一段即抛。
    await expect(collect(exportBook(empty, 's', 'b', { title: 'x', delayMs: 1, from: 1, to: 1 })))
      .rejects.toThrow(/导出范围越界.*不在 \[1, 0\]/)
    const { deps, calls } = makeDeps()
    await expect(collect(exportBook(deps, 's', 'b', { title: 'x', delayMs: 1, from: 0, to: 99 })))
      .rejects.toThrow(/导出范围越界/)
    expect(calls).toEqual([])                              // 校验在任何抓取之前
    await expect(collect(exportBook(deps, 's', 'b', { title: 'x', delayMs: 1, from: 3, to: 1 })))
      .rejects.toThrow(/导出范围越界/)
    expect(calls).toEqual([])                              // 倒置同样：不静默出空文件
  })

  it('范围导出：from/to（1 基含端）只抓该段、段内 k-1 次 sleep、章头是绝对章名', async () => {
    const { deps, calls, sleeps } = makeDeps()
    const out = await collect(exportBook(deps, 's', 'b', { title: '书', delayMs: 300, from: 2, to: 3 }))
    expect(calls).toEqual(['ch1', 'ch2'])
    expect(sleeps).toEqual([300])                          // 段内 2 章 → 1 次
    expect(out).toContain('《书》· 第二章 承')
    expect(out).toContain('《书》· 第三章 转')
    expect(out).not.toContain('第一章 起')
  })

  it('范围中失败即停：中断标记用全书绝对章号（不是段内序号）', async () => {
    const { deps, calls } = makeDeps({ failAt: 2, failMsg: '403 疑似限流' })
    const out = await collect(exportBook(deps, 's', 'b', { title: '书', delayMs: 1, from: 3, to: 3 }))
    expect(calls).toEqual(['ch2'])
    expect(out).toContain('[导出中断于第 3 章《第三章 转》：403 疑似限流]')
  })
})
