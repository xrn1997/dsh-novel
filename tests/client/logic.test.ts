import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { anchorTop, locateChapter } from '../../src/client/progress.js'
import { debounce } from '../../src/client/util.js'
import { createStore } from '../../src/client/store.js'
import { ApiClientError, apiGet, apiUpload } from '../../src/client/api.js'
import { streamExport } from '../../src/client/download.js'
import { coverFallbackChar } from '../../src/client/views/bits.js'
import { LOCAL_SOURCE_ID } from '../../src/shared/wire.js'

describe('首页封面降级', () => {
  it('取首字；空/全空白标题回退「书」', () => {
    expect(coverFallbackChar('斗破苍穹')).toBe('斗')
    expect(coverFallbackChar('')).toBe('书')
    expect(coverFallbackChar('  ')).toBe('书')
  })
})

describe('progress 数学', () => {
  const anchors = [{ index: 0, start: 0 }, { index: 1, start: 1000 }, { index: 2, start: 2500 }]
  it('locateChapter：锚点边界与章内比例', () => {
    expect(locateChapter(anchors, 0)).toEqual({ chapterIndex: 0, offsetRatio: 0 })
    expect(locateChapter(anchors, 999)).toEqual({ chapterIndex: 0, offsetRatio: 0.999 })
    expect(locateChapter(anchors, 1000)).toEqual({ chapterIndex: 1, offsetRatio: 0 })
    expect(locateChapter(anchors, 1750)).toEqual({ chapterIndex: 1, offsetRatio: 0.5 })
    expect(locateChapter(anchors, 99999)).toMatchObject({ chapterIndex: 2 })
  })
  it('anchorTop 反函数往返（尾章除外）', () => {
    for (const i of [0, 1]) {
      const { offsetRatio } = locateChapter(anchors, anchors[i].start + (i === 0 ? 300 : 500))
      expect(anchorTop(anchors, i, offsetRatio, 4000, 500)).toBeCloseTo(anchors[i].start + (i === 0 ? 300 : 500), 5)
    }
    expect(anchorTop(anchors, 99, 0.5, 4000, 500)).toBe(0)   // 越界回 0
  })
  it('debounce：合并调用 + flush/cancel', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const d = debounce(fn, 2000)
    d(1); d(2); d(3)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2000)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(3)                 // 只留最后一次
    d(4); d.flush()
    expect(fn).toHaveBeenLastCalledWith(4)             // flush 立即触发挂起调用
    d(5); d.cancel()
    vi.advanceTimersByTime(2000)
    expect(fn).toHaveBeenCalledTimes(2)                // cancel 丢弃
    vi.useRealTimers()
  })
})

describe('store', () => {
  it('get/set/subscribe 语义 + patch 合并', () => {
    const s = createStore({ a: 1, b: 'x' })
    const seen: Array<{ a: number; b: string }> = []
    const un = s.subscribe(() => seen.push(s.get()))
    s.set({ a: 2 })
    s.set({ b: 'y' })
    expect(s.get()).toEqual({ a: 2, b: 'y' })
    expect(seen).toHaveLength(2)
    un()
    s.set({ a: 3 })
    expect(seen).toHaveLength(2)                       // 退订后不再通知
  })
})

describe('api', () => {
  it('信封解析：ok→value；error→ApiClientError 带 segment', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ ok: false, error: { code: 'RuleEvalError', message: 'boom', segment: { facet: 'toc', segmentIndex: 1, segmentRaw: 'class.x' } } }),
      { status: 422, headers: { 'content-type': 'application/json' } })))
    await expect(apiGet('toc?a=1')).rejects.toMatchObject({
      name: 'ApiClientError', code: 'RuleEvalError', status: 422,
      segment: { facet: 'toc', segmentIndex: 1 },
    })
    vi.unstubAllGlobals()
  })
  it('网络层失败 → ApiClientError NetworkError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    await expect(apiGet('shelf')).rejects.toBeInstanceOf(ApiClientError)
    vi.unstubAllGlobals()
  })
})

describe('streamExport', () => {
  it('流式累积 → Blob；进度回调字节数单调；信封错误 → ApiClientError', async () => {
    const BOM = '\uFEFF'   // BOM 字面量不可见、易被传输破坏——必须写成显式转义，绝不写裸字符
    const chunk = (s: string) => new TextEncoder().encode(s)
    const fetchMock = vi.fn(async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(chunk(`${BOM}《书》· 第一章\n\n正文`))
          controller.enqueue(chunk('二'))
          controller.close()
        },
      }),
      { status: 200, headers: { 'content-type': 'text/plain', 'x-novel-total-chapters': '2' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    const seen: number[] = []
    const ctrl = new AbortController()
    const blob = await streamExport({ sourceId: 's', bookKey: 'b', title: '书', onProgress: (bytes) => seen.push(bytes), signal: ctrl.signal })
    expect(seen).toEqual([new TextEncoder().encode(`${BOM}《书》· 第一章\n\n正文`).length, blob.size])
    expect(blob.size).toBeGreaterThan(0)
    expect(fetchMock).toHaveBeenCalledWith('/novel-api/export?sourceId=s&url=b&title=%E4%B9%A6', { signal: ctrl.signal })
    vi.unstubAllGlobals()

    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ ok: false, error: { code: 'FetchError', message: '网络炸了' } }),
      { status: 502, headers: { 'content-type': 'application/json' } })))
    await expect(streamExport({ sourceId: 's', bookKey: 'b', title: '书', onProgress: () => {}, signal: new AbortController().signal }))
      .rejects.toMatchObject({ name: 'ApiClientError', code: 'FetchError' })
    vi.unstubAllGlobals()
  })
})

describe('streamExport 范围参数', () => {
  it('from/to 传入时进 query（缺省不出现——全本旧链接零参数）', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => new Response(
      new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('x')); c.close() } }),
      { status: 200, headers: { 'content-type': 'text/plain' } }))
    vi.stubGlobal('fetch', fetchMock)
    await streamExport({
      sourceId: 's', bookKey: 'b', title: '书', from: 5, to: 80,
      onProgress: () => {}, signal: new AbortController().signal,
    })
    expect(String(fetchMock.mock.calls[0][0])).toContain('from=5&to=80')
    vi.unstubAllGlobals()
  })
})

describe('apiUpload 信封', () => {
  it('POST 原始 Blob（无 content-type）；ok → value；error → ApiClientError；非 JSON → NetworkError', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, value: { bookKey: 'b', title: '书', sourceId: LOCAL_SOURCE_ID, chapterCount: 12, encoding: 'utf-8' } }),
      { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const body = new Blob(['正文'])
    await expect(apiUpload('local/import?name=a.txt', body))
      .resolves.toMatchObject({ bookKey: 'b', title: '书', sourceId: LOCAL_SOURCE_ID })
    expect(fetchMock).toHaveBeenCalledWith('/novel-api/local/import?name=a.txt', { method: 'POST', body })
    vi.unstubAllGlobals()

    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ ok: false, error: { code: 'DecodeError', message: '无法识别的编码' } }),
      { status: 422, headers: { 'content-type': 'application/json' } })))
    await expect(apiUpload('local/import?name=a.txt', body))
      .rejects.toMatchObject({ name: 'ApiClientError', code: 'DecodeError', status: 422 })
    vi.unstubAllGlobals()

    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>炸了</html>', { status: 200 })))
    await expect(apiUpload('local/import?name=a.txt', body))
      .rejects.toMatchObject({ name: 'ApiClientError', code: 'NetworkError' })
    vi.unstubAllGlobals()
  })
})

import { NOVEL_CSS } from '../../src/client/styles.js'

describe('styles token 迁移', () => {
  it('旧 --ds- 假 token 清零；语义 token 全在位；fallback 保留兜底', () => {
    // --dsw-alias-* 含子串 "--dsw-"，不会误命中 "--ds-"——逐名断言最稳
    for (const stale of ['--ds-border', '--ds-btn-bg', '--ds-btn-hover', '--ds-input-bg', '--ds-panel']) {
      expect(NOVEL_CSS).not.toContain(stale)
    }
    for (const real of [
      '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3',
      '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-border-l4',
      '--dsw-alias-interactive-bg-hover', '--dsw-alias-interactive-bg-active',
      '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary',
      '--dsw-alias-label-primary-foreground',
      '--dsw-alias-brand-primary', '--dsw-alias-button-primary-fill', '--dsw-alias-button-primary-hover',
      '--dsw-alias-bg-skeleton', '--dsw-alias-interactive-bg-hover-danger',
      '--dsw-alias-state-success-primary', '--dsw-alias-state-error-primary', '--dsw-alias-state-warn-primary',
    ]) {
      expect(NOVEL_CSS, `缺 ${real}`).toContain(real)
    }
    expect(NOVEL_CSS).toContain('var(--dsw-alias-border-l2, #ffffff1f)')   // fallback 保留（暗底兜底）
  })
  it('不再引用宿主不存在的 token（--dsw-alias-border-l 是假名，宿主只有 l1..l4）', () => {
    expect(NOVEL_CSS).not.toMatch(/var\(\s*--dsw-alias-border-l\s*[,)]/)
    expect(NOVEL_CSS).not.toMatch(/var\(\s*--dsw-alias-bg-layer-4\s*[,)]/)
  })
  it('视觉规则只读本地 --novel-* 局部 token（配色不在规则里散写宿主 token）', () => {
    // 只放行两个「token 层」声明块（根与 .novel-dark），其余规则体里不允许出现裸 --dsw-*
    const stripped = NOVEL_CSS
      .replace(/\.novel-root, \[data-novel-scope\] \{[\s\S]*?\n\}/, '')
      .replace(/\.novel-dark \{[\s\S]*?\n\}/, '')
    expect(stripped).not.toContain('--dsw-')
  })
  it('命中行是 flex 行（回归钉：.novel-row 丢 display:flex 会让「＋ 加书架」掉到标题下方堆叠）', () => {
    // 真机踩过：样式块重写时把 display/align-items 弄丢，行退化成块级堆叠，marginLeft:auto 失效
    const m = NOVEL_CSS.match(/\.novel-row\s*\{[^}]*\}/)
    expect(m, 'NOVEL_CSS 里找不到 .novel-row 规则').toBeTruthy()
    expect(m![0], '.novel-row 必须是 flex 行').toContain('display: flex')
    expect(m![0]).toContain('align-items: center')
  })
   it('视图层源码（src/client/views/*.tsx）无旧 --ds- 假 token', async () => {
    const dir = fileURLToPath(new URL('../../src/client/views/', import.meta.url))
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.tsx'))
    expect(files.length).toBeGreaterThan(0)
    // 逐全名断言：'--ds-border' 等全名不会误命中 '--dsw-alias-border-l'（含 '--dsw-' 前缀子串）
    for (const f of files) {
      const text = await fs.readFile(path.join(dir, f), 'utf8')
      for (const stale of ['--ds-border', '--ds-btn-bg', '--ds-btn-hover', '--ds-input-bg', '--ds-panel']) {
        expect(text, `${f} 含旧假 token ${stale}`).not.toContain(stale)
      }
    }
  })
})
