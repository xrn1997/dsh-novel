import { promises as fs } from 'node:fs'
import { vi } from 'vitest'

/**
 * 让下一发 `fs.readdir` 挂住（其后的照常放行）：返回扫描次数读数与放行闸。
 *
 * `phase` 是两份抄本唯一的差别：读目录**之前**挂住，用例好赶在本轮候选成形前落新文件；
 * 读**之后**挂住，用来验证扫描窗口里的并发写。扫描纪律只该有这一个闸口。
 */
export function gateNextReaddir(phase: 'before' | 'after' = 'before'): { scans: () => number, release: () => void } {
  let release = (): void => { throw new Error('扫描没停在 readdir 上') }
  const gate = new Promise<void>((resolve) => { release = resolve })
  const realReaddir = fs.readdir
  const spy = vi.spyOn(fs, 'readdir')
  let gated = false
  spy.mockImplementation((async (d: string, o?: unknown) => {
    if (phase === 'before' && !gated) { gated = true; await gate }
    const names = await (realReaddir as (p: string, opts?: unknown) => Promise<string[]>)(d, o)
    if (phase === 'after' && !gated) { gated = true; await gate }
    return names
  }) as typeof fs.readdir)
  return { scans: () => spy.mock.calls.length, release: () => { release() } }
}
