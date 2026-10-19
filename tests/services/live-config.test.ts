import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../../src/config.js'
import { ReadingService } from '../../src/services/reading.js'
import { makeTempDir, trackService } from '../temp-dir.js'

function ref<T>(value: T) {
  let current = value
  return {
    get: () => current,
    [Symbol.for('cosmokit.volatile.write')]: (next: T) => { current = next },
  }
}

describe('ReadingService 活配置', () => {
  it('localImportMaxBytes 读 getter 当前快照', async () => {
    const dir = await makeTempDir('novel-live-')
    const max = ref(1024)
    const svc = trackService(await ReadingService.create({
      dir,
      config: resolveConfig({ localImportMaxBytes: max } as any),
    }))
    expect(svc.localImportMaxBytes).toBe(1024)
    ;(max as any)[Symbol.for('cosmokit.volatile.write')](2048)
    expect(svc.localImportMaxBytes).toBe(2048)
    svc.dispose()
    await svc.flush()
  })
})

/** 活 ref 的写口（Loader 侧就是按这个 symbol 写回当前值） */
function flip<T>(target: object, value: T): void {
  const write = (target as Record<symbol, (next: T) => void>)[Symbol.for('cosmokit.volatile.write')]
  write(value)
}

/** 一条最小可参搜的书源（超时与 js 预算两条路都只走到搜索面） */
const liveSource = (name: string, base: string, searchUrl = `${base}/s?q={{key}}`): never => ({
  bookSourceName: name, bookSourceUrl: base, searchUrl,
  ruleBookList: '@css:.b', ruleBookName: 'tag.a@text', ruleAuthor: 'tag.span@text', ruleBookUrl: 'tag.a@href',
  ruleContent: '@css:#content@textNodes',
} as never)

/** 同步空转到 ms 的 @js（预算到点即被 vm 杀，错误文案点名预算数值） */
const busyJs = (ms: number, base: string): string =>
  `@js: var t = Date.now(); while (Date.now() - t < ${ms}) {}; '${base}/s?q=' + key`

describe('ReadingService 活配置：服务侧每轮现读', () => {
  it('searchTimeoutMs：第二次搜索用翻过的新超时（超时文案点名数值）', async () => {
    const dir = await makeTempDir('novel-live-')
    const timeoutMs = ref(20)
    const svc = trackService(await ReadingService.create({
      dir,
      config: resolveConfig({ searchTimeoutMs: timeoutMs } as never),
      fetchImpl: (() => new Promise(() => {})) as never,
    }))
    await svc.importOne(liveSource('超时源', 'https://live.example.com'))
    expect((await svc.search('斗罗'))[0].error?.message).toMatch(/请求超时 20ms/)
    flip(timeoutMs, 60)
    expect((await svc.search('斗罗'))[0].error?.message).toMatch(/请求超时 60ms/)
  })

  it('jsTimeoutMs：第二次搜索用翻过的新沙箱预算', async () => {
    const dir = await makeTempDir('novel-live-')
    const jsTimeoutMs = ref(60)
    const svc = trackService(await ReadingService.create({
      dir,
      config: resolveConfig({ jsTimeoutMs } as never),
      fetchImpl: (async () => new Response('<html><body><div class="b"><a href="/book/1/">斗罗</a><span>唐家</span></div></body></html>',
        { headers: { 'content-type': 'text/html; charset=utf-8' } })) as never,
    }))
    await svc.importOne(liveSource('JS源', 'https://live.example.com', busyJs(400, 'https://live.example.com')))
    expect((await svc.search('斗罗'))[0].error?.message).toMatch(/脚本超时（>60ms）/)
    flip(jsTimeoutMs, 120)
    expect((await svc.search('斗罗'))[0].error?.message).toMatch(/脚本超时（>120ms）/)
  })

  it('searchParallel：新一轮的批步长按当前值走（上一轮的步长不带过来）', async () => {
    const dir = await makeTempDir('novel-live-')
    const searchParallel = ref(1)
    let inFlight = 0
    let peak = 0
    const svc = trackService(await ReadingService.create({
      dir,
      config: resolveConfig({ searchParallel } as never),
      fetchImpl: (async () => {
        peak = Math.max(peak, ++inFlight)            // 进入即计数：同一批的两条都在此叠起来
        await new Promise((r) => setTimeout(r, 0))
        inFlight -= 1
        return new Response('<html><body><div class="b"><a href="/book/1/">斗罗</a><span>唐家</span></div></body></html>',
          { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }) as never,
    }))
    await svc.importOne(liveSource('甲源', 'https://a.example.com'))
    await svc.importOne(liveSource('乙源', 'https://b.example.com'))
    await svc.search('斗罗')
    expect(peak).toBe(1)                                   // 步长 1：一条在途，等它回来才发下一条
    peak = 0
    flip(searchParallel, 2)
    await svc.search('斗罗')
    expect(peak).toBe(2)                                   // 步长翻成 2：同一批两条同时在途
  })

  it('searchParallel 被改成非正整数 → 点名炸掉而不是 i += 0 挂起', async () => {
    const dir = await makeTempDir('novel-live-')
    const searchParallel = ref(2)
    const svc = trackService(await ReadingService.create({
      dir,
      config: resolveConfig({ searchParallel } as never),
      fetchImpl: (async () => new Response('<html></html>',
        { headers: { 'content-type': 'text/html; charset=utf-8' } })) as never,
    }))
    await svc.importOne(liveSource('甲源', 'https://a.example.com'))
    flip(searchParallel, 0)
    await expect(svc.search('斗罗')).rejects.toThrow(/searchParallel 必须为正整数，收到 0/)
  })
})
