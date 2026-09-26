/**
 * 浏览器验收台：真服务 + 真 bundle + 真浏览器（`tests/browser/epub-reader.test.ts` 的底座）。
 *
 * 这台子只提供**事实与开关**，不含断言：
 * ① 真 `ReadingService`（临时数据根 `makeTempDir`）+ 真 `createApiHandler` 挂在 127.0.0.1 随机端口上——
 *    `/novel-api` 一律过真路由，没有假响应；「导入链被绕开」这种假绿在结构上不可能发生；
 * ② 页面侧的 `lib/client.js` 是**构建产物**（`pnpm build` 之后才有；缺即报错，不静默降级到源码；
 *    比 `src/**` 旧也报错——陈旧产物跑出的绿是最难发现的一类假绿）；
 *    React 从本仓依赖的 UMD 构建现取；壳是仓内跟踪的 `shell.html`（最小宿主替身，不是真宿主）；
 * ③ 可控故障注入（**挂起**——缺省释放后走真路由、可指定释放后以某个状态码收尾；**有界延迟**）
 *    ——按「下 n 次命中某路径的请求」计数，用于量「图片未到时的位置」「章节在途时切走」
 *    与「同一张图在途 → 失败」这几类只有真时序才存在的现场；
 * ④ 请求记录（含 PUT 进度体的原文）：断言「导航事件即落盘」「删书后资源 404」用的都是真流量。
 *
 * 三条纪律（本台刻意不做的事）：
 * - **不触网**：注入的 `fetchImpl` 只答假书源那几张页面，别的 URL 一律 599 并带上原因——
 *   测试里任何一次真实出站都会当场变成可见失败，而不是靠「反正没人看」蒙过去；
 * - **不 import `.superpowers/` 与全局 npm 模块**：浏览器从仓内 devDependency `playwright` 来，
 *   可执行文件只用**已安装的**浏览器（`DSH_BROWSER_EXECUTABLE` 或 Edge/Chrome 通道），从不下载；
 * - **不替宿主说话**：壳证明了「挂载 / 卸载 / 槽位注册」在这一页成立，不证明真 DSH 宿主的
 *   侧栏选中与槽位路由；后者归真宿主冒烟（本轮未获授权，见任务报告）。
 */
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import http from 'node:http'
import { PassThrough } from 'node:stream'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page } from 'playwright'
import { createApiHandler } from '../../src/api/dispatch.js'
import { ReadingService } from '../../src/services/reading.js'
import { makeEpubFixture } from '../fixtures/epub.js'
import { makeTempDir, trackService } from '../temp-dir.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 仓根（本文件在 tests/browser/ 下） */
export const REPO = path.resolve(HERE, '../..')

// ── 假在线书源（注入 fetchImpl 的确定性站点：一处定义，别处只许引）────────────────

/** 假书源地址：`.invalid` 是 RFC 2606 保留域，永不解析——真出站也不可能成功，失败会明摆着 */
export const ONLINE_BASE = 'https://novel-browser.invalid'

/** 假书源的四章目录（正文里带章节号，断言「读的是第几章」不看样式） */
export const ONLINE_CHAPTERS = ['第1章 夜航', '第2章 挑灯', '第3章 看剑', '第4章 归鞘']

/** 假书源的书目身份（上架用；bookKey 就是它的目录页 URL） */
export const ONLINE_BOOK = { bookKey: `${ONLINE_BASE}/book/1/`, title: '在线样本' }

/**
 * 假书源原始书源对象：规则面刻意用最朴素的一档（@css + tag.a@text）——本台验的是
 * 「在线书在浏览器里照读」，不是规则引擎的形态面（那有专门的普查门）。
 */
export const ONLINE_SOURCE_RAW = {
  bookSourceName: '假书源',
  bookSourceUrl: ONLINE_BASE,
  searchUrl: `${ONLINE_BASE}/search?q={{key}}`,
  ruleBookList: '@css:.b',
  ruleBookName: 'tag.a@text',
  ruleBookAuthor: 'tag.span@text',
  ruleBookUrl: 'tag.a@href',
  ruleTocUrl: ONLINE_BOOK.bookKey,
  ruleChapterName: 'tag.a@text',
  ruleChapterUrl: 'tag.a@href',
  ruleContent: '@css:#content@textNodes',
}

/** 假站点的页面路由（返回 null = 这份 URL 不归它管，出站守门会当场失败） */
function onlinePage(url: string): string | null {
  const u = new URL(url)
  if (u.host !== new URL(ONLINE_BASE).host) return null
  if (u.pathname === '/search') {
    const key = u.searchParams.get('q') ?? ''
    return `<html><body><div class="b"><a href="/book/1/">${key}·在线样本</a><span>假作者</span></div></body></html>`
  }
  if (u.pathname === '/book/1/') {
    // 目录页的条目 class 用 `.b`（目录列表与搜索结果共用 ruleBookList），
    // 不是一个自造的 `.c`——写错了列表就是空的，而「空目录」长得很像「这本书没有章节」。
    return '<html><body>' + ONLINE_CHAPTERS.map((name, i) => `<div class="b c"><a href="/c/${i + 1}.html">${name}</a></div>`).join('') + '</body></html>'
  }
  const chapter = /^\/c\/(\d+)\.html$/.exec(u.pathname)
  if (chapter !== null) {
    const i = Number(chapter[1]) - 1
    if (i < 0 || i >= ONLINE_CHAPTERS.length) return null
    return `<html><body><div id="content">${ONLINE_CHAPTERS[i]}\n假站点的第 ${i + 1} 章正文第一段。\n${ONLINE_CHAPTERS[i]} 第二段。</div></body></html>`
  }
  return null
}

/** 注入服务层的 fetchImpl：只答假站点，其余 599（未触网的事实要能被读出来） */
function makeOfflineFetch(record: { refused: string[]; served: string[] }): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    const body = onlinePage(url)
    if (body === null) {
      record.refused.push(url)
      return new Response(`本台不触网：${url}`, { status: 599, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    }
    record.served.push(url)
    return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  }) as unknown as typeof globalThis.fetch
}

// ── 浏览器：只能用**已安装**的，绝不下载 ───────────────────────────────────────

/** 本机 Edge 的安装位置（Windows 上的常见两处；不存在就往后找通道） */
const EDGE_PATHS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

/** puppeteer 缓存的 Chrome（本机已有；只当兜底，不做任何下载） */
async function puppeteerChrome(): Promise<string | null> {
  const root = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.cache', 'puppeteer', 'chrome')
  try {
    const dirs = await fs.readdir(root)
    for (const d of dirs) {
      for (const rel of ['chrome-win64/chrome.exe', 'chrome-win32/chrome.exe', 'chrome-linux64/chrome', 'chrome-headless-shell-win64/chrome-headless-shell.exe']) {
        const p = path.join(root, d, rel)
        try { await fs.access(p); return p } catch { /* 试下一个 */ }
      }
    }
  } catch { /* 没有缓存 */ }
  return null
}

/** 启动计划：**先给可执行文件路径，再退到通道名**——两条路都只碰已安装的浏览器。 */
export async function launchBrowser(): Promise<Browser> {
  const attempts: string[] = []
  const explicit = process.env.DSH_BROWSER_EXECUTABLE
  if (explicit !== undefined && explicit !== '') {
    attempts.push(`DSH_BROWSER_EXECUTABLE=${explicit}`)
    try {
      return await chromium.launch({ executablePath: explicit, headless: true, args: ['--no-proxy-server', '--disable-dev-shm-usage'] })
    } catch (e) {
      attempts.push(`  ↳ 失败：${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
    }
  }
  for (const p of EDGE_PATHS) {
    try { await fs.access(p) } catch { continue }
    attempts.push(p)
    try {
      return await chromium.launch({ executablePath: p, headless: true, args: ['--no-proxy-server', '--disable-dev-shm-usage'] })
    } catch (e) {
      attempts.push(`  ↳ 失败：${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
    }
  }
  const cached = await puppeteerChrome()
  if (cached !== null) {
    attempts.push(cached)
    try {
      return await chromium.launch({ executablePath: cached, headless: true, args: ['--no-proxy-server', '--disable-dev-shm-usage'] })
    } catch (e) {
      attempts.push(`  ↳ 失败：${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
    }
  }
  // 通道名（playwright 自己去认已安装的 Edge/Chrome）：到这一步还是失败就**红**
  for (const channel of ['msedge', 'chrome'] as const) {
    attempts.push(`channel:${channel}`)
    try {
      return await chromium.launch({ channel, headless: true, args: ['--no-proxy-server', '--disable-dev-shm-usage'] })
    } catch (e) {
      attempts.push(`  ↳ 失败：${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
    }
  }
  throw new Error(
    '找不到可用浏览器——本门**不下载浏览器**，请装 Edge/Chrome 或设 DSH_BROWSER_EXECUTABLE=<可执行文件路径>。\n'
    + `已尝试：\n${attempts.join('\n')}`,
  )
}

// ── 故障注入 ────────────────────────────────────────────────────────────────

/** 命中条件：路径**包含**给定串（`/novel-api/local/resource` 这类片段足够定位；全路径更精确） */
export interface FaultMatch { pathIncludes: string; method?: string }

/**
 * 挂起注入的结局口径：缺省 = 释放后交回真路由（真响应）；给了 `status` = 释放后以它收尾。
 * 「同一张图在途 → 以失败告终」这条时序必须有同一个挂起窗口的两种结局才拼得出来：
 * 分成两个注入器（挂起 + 立即失败）就变成「挂到一半换了个请求」，量不到同一张图在途时的位置。
 */
export interface HoldOptions { status?: number; body?: string }

interface HoldFault {
  kind: 'hold'; match: FaultMatch; gate: Promise<void>; release: () => void; arrived: () => void; arrivedAt: Promise<void>
  outcome?: HoldOptions
}
interface DelayFault { kind: 'delay'; match: FaultMatch; remaining: number; ms: number }
type Fault = HoldFault | DelayFault

/** 一次请求的读数（body 对二进制上传只留长度——把一整本 EPUB 灌进日志没有意义） */
export interface RequestRecord {
  method: string
  path: string
  status: number
  body: string | null
  bodyBytes: number
  /** 命中故障注入的动作（无 = 直通），断言「注入真的生效」用 */
  fault: string | null
}

export interface EpubHost {
  base: string
  dataDir: string
  service: ReadingService
  requests: RequestRecord[]
  /** 注入 fetchImpl 拒掉的出站 URL（**空数组** = 本页全链路一次都没想去触网） */
  refusedOutbound: string[]
  /** 注入 fetchImpl 答过的假站点 URL（确定性分母：读到第几章、抓了几次目录） */
  servedOutbound: string[]
  /** 下 n 次命中该路径的请求挂起，直到 release()；返回释放句柄与「真的到了」的信号。
   *  带了 `outcome.status` 时，release() 之后以它收尾（量「图在途 → 失败」的现场）。 */
  hold(match: FaultMatch, outcome?: HoldOptions): { arrived: Promise<void>; release: () => void }
  /** 下 n 次命中该路径的响应先等 ms 毫秒（有界的「慢」：图/章在途的位置读数用） */
  delayNext(match: FaultMatch, ms: number, times?: number): void
  /** 还剩几个未消费的注入器（断言注入已被吃掉，防「注入没生效所以断言恒真」） */
  pendingFaults(): number
  /** PUT /shelf/:key 的进度体（解析后的原文） */
  progressPuts(): Array<{ key: string; chapterIndex: number; offsetRatio: number }>
  /** 清空请求记录（用例之间互不污染；不清故障队列） */
  clearRequests(): void
  stop(): Promise<void>
}

/** 起一台真服务 + 真路由的浏览器验收台 */
export async function startEpubHost(opts: { fetchImpl?: typeof globalThis.fetch } = {}): Promise<EpubHost> {
  await assertBundleFresh()
  const shell = await fs.readFile(path.join(HERE, 'shell.html'), 'utf8')
  const missing: string[] = []
  const assets = resolveAssets(missing)
  if (missing.length > 0) {
    throw new Error(
      `浏览器验收台缺件：${missing.join('、')}\n`
      + `  · lib/ 是构建产物且不入库——先跑 pnpm build（test:pack 亦会构建）；\n`
      + '  · React 的 UMD 构建随 peerDependencies 的 react / react-dom 一起来，装齐依赖即可。',
    )
  }

  const dataDir = await makeTempDir('novel-browser-')
  const outbound = { refused: [] as string[], served: [] as string[] }
  const service = trackService(await ReadingService.create({
    dir: dataDir, fetchImpl: opts.fetchImpl ?? makeOfflineFetch(outbound),
  }))
  const requests: RequestRecord[] = []
  const faults: Fault[] = []

  const takeFault = (method: string, pathname: string): Fault | null => {
    const hit = faults.find((f) => pathname.includes(f.match.pathIncludes) && (f.match.method === undefined || f.match.method === method))
    if (hit === undefined) return null
    if (hit.kind === 'hold') {
      faults.splice(faults.indexOf(hit), 1)
      return hit
    }
    hit.remaining -= 1
    if (hit.remaining <= 0) faults.splice(faults.indexOf(hit), 1)
    return hit
  }

  const handler = createApiHandler(service)
  const server = http.createServer((req, res) => { void serve(req, res).catch((e: unknown) => {
    if (!res.writableEnded) { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end(`验收台内部错误：${String(e)}`) }
  }) })

  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(shell)
      return
    }
    if (assets[url.pathname] !== undefined) {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
      res.end(await fs.readFile(assets[url.pathname]))
      return
    }
    if (!url.pathname.startsWith('/novel-api')) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`验收台只有壳、vendor 与 /novel-api：${url.pathname}`)
      return
    }

    const method = req.method ?? 'GET'
    const raw = await bufferBody(req)
    const rec: RequestRecord = {
      method, path: url.pathname + url.search, status: 0, body: null, bodyBytes: raw.length, fault: null,
    }
    requests.push(rec)
    const wantsText = (req.headers['content-type'] ?? '').includes('json') || raw.length === 0
    // 二进制上传（本地书导入）只记长度：整本 EPUB 进日志既无用又危险，形状与大小已足够断言
    rec.body = wantsText && raw.length > 0 ? raw.toString('utf8') : null

    const fault = takeFault(method, url.pathname)
    if (fault !== null) {
      rec.fault = fault.kind
      if (fault.kind === 'hold') {
        fault.arrived()
        await fault.gate
        if (fault.outcome?.status !== undefined) {
          rec.status = fault.outcome.status
          res.writeHead(fault.outcome.status, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(fault.outcome.body ?? '')
          return
        }
      } else {
        await new Promise((r) => setTimeout(r, fault.ms))
      }
    }

    const writeHead = res.writeHead.bind(res)
    res.writeHead = ((status: number, ...rest: unknown[]): ServerResponse => {
      rec.status = status
      return (writeHead as (...a: unknown[]) => ServerResponse)(status, ...rest)
    }) as typeof res.writeHead
    res.on('close', () => { if (rec.status === 0) rec.status = -1 })          // 客户端中途断开（导出取消）
    await handler(replay(req, raw), res)
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const base = `http://127.0.0.1:${port}`

  return {
    base,
    dataDir,
    service,
    requests,
    refusedOutbound: outbound.refused,
    servedOutbound: outbound.served,
    hold(match, outcome) {
      let releaseFn: () => void = () => undefined
      let arrivedFn: () => void = () => undefined
      const gate = new Promise<void>((resolve) => { releaseFn = resolve })
      const arrivedAt = new Promise<void>((resolve) => { arrivedFn = resolve })
      faults.push({ kind: 'hold', match, gate, release: releaseFn, arrived: arrivedFn, arrivedAt, outcome })
      return { arrived: arrivedAt, release: releaseFn }
    },
    delayNext(match, ms, times = 1) {
      faults.push({ kind: 'delay', match, remaining: times, ms })
    },
    pendingFaults: () => faults.length,
    progressPuts: () => requests.flatMap((r) => {
      if (r.method !== 'PUT' || !r.path.startsWith('/novel-api/shelf/') || r.body === null) return []
      try {
        const parsed = JSON.parse(r.body) as { progress?: { chapterIndex?: number; offsetRatio?: number } }
        if (parsed.progress === undefined) return []
        return [{
          key: decodeURIComponent(r.path.slice('/novel-api/shelf/'.length)),
          chapterIndex: parsed.progress.chapterIndex ?? -1,
          offsetRatio: parsed.progress.offsetRatio ?? -1,
        }]
      } catch { return [] }
    }),
    clearRequests: () => { requests.length = 0 },
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** 壳要用到的三份本仓资产（缺一份就**红**：lib/client.js 是构建产物、React 是依赖） */
function resolveAssets(missing: string[]): Record<string, string> {
  const req = createRequire(path.join(REPO, 'package.json'))
  const umdOf = (pkg: string, file: string): string => path.join(path.dirname(req.resolve(pkg)), 'umd', file)
  const out: Record<string, string> = {
    '/client.js': path.join(REPO, 'lib', 'client.js'),
    '/vendor/react.js': umdOf('react', 'react.development.js'),
    '/vendor/react-dom.js': umdOf('react-dom', 'react-dom.development.js'),
  }
  for (const [url, file] of Object.entries(out)) {
    // 存在性检查放在起台时（beforeAll），缺件立刻炸——等页面 404 后白屏，读数会指错方向
    if (!existsSync(file)) missing.push(`${file}（${url}）`)
  }
  return out
}

/**
 * 构建产物的新鲜度：`lib/client.js` 比 `src/**` 里任何一份文件**旧** = 陈旧产物。
 * 只查「在不在」会留一条最难发现的假绿：改了源码没重新构建，门照样拿旧 bundle 全绿通过。
 * 判据取 mtime 而不是内容哈希——`pnpm build` 每次都会重写产物，mtime 单调可靠；
 * 源码被检出/改写的时刻晚于产物，就说明产物没有覆盖当前源码。
 */
async function assertBundleFresh(): Promise<void> {
  const entry = path.join(REPO, 'lib', 'client.js')
  if (!existsSync(entry)) return                    // 缺件归 resolveAssets 的 missing 通道（消息指向 pnpm build）
  const newest = await newestFile(path.join(REPO, 'src'))
  const bundle = (await fs.stat(entry)).mtimeMs
  if (newest !== null && newest.mtimeMs > bundle) {
    throw new Error(
      '浏览器验收台的 lib/client.js 是**陈旧产物**：它比 src/ 里最新的文件还旧，'
      + '这条门会拿旧 bundle 跑出假绿。\n'
      + `  · lib/client.js ${new Date(bundle).toISOString()}\n`
      + `  · ${path.relative(REPO, newest.file)} ${new Date(newest.mtimeMs).toISOString()}\n`
      + '  · 先跑 pnpm build（或 pnpm test:pack，它会构建）再来开这道门。',
    )
  }
}

/** `dir` 树下 mtime 最新的那份文件（`lib/` 与 `src/` 比对用；目录不存在 = null） */
async function newestFile(dir: string): Promise<{ file: string; mtimeMs: number } | null> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null)
  if (entries === null) return null
  let newest: { file: string; mtimeMs: number } | null = null
  for (const e of entries) {
    const p = path.join(dir, e.name)
    const cand = e.isDirectory() ? await newestFile(p) : { file: p, mtimeMs: (await fs.stat(p)).mtimeMs }
    if (cand !== null && (newest === null || cand.mtimeMs > newest.mtimeMs)) newest = cand
  }
  return newest
}

async function bufferBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks)
}

/**
 * 把已读进内存的请求体回放给真 handler：dispatch 只依赖 `method/url/headers/socket` 与
 * 「req 可异步迭代」这几件事，所以一条已结束的 PassThrough + 原请求的四个字段就是忠实替身。
 * 为什么要先读干（而不是边转发边记）：PUT 进度体与上传字节都要作为**事实**记进 `requests`。
 */
function replay(orig: IncomingMessage, body: Buffer): IncomingMessage {
  const stream = new PassThrough()
  stream.end(body)
  return Object.assign(stream, {
    method: orig.method, url: orig.url, headers: orig.headers, socket: orig.socket,
  }) as unknown as IncomingMessage
}

// ── 一页 = 一个「宿主会话」：独立 context（localStorage 干净）+ 页面错误收集 ────────────

export interface PageSession {
  page: Page
  /** pageerror + console.error 原文（断言控制台干净用） */
  errors: string[]
  console: string[]
  /** 页内路由的绝对地址（`/novel-api/...` → http://127.0.0.1:port/...）；页内 request 用 */
  url(pathname: string): string
  close(): Promise<void>
  /** 重新加载壳（模块级现场归零；routeStore 与 prefs 随之复位） */
  reload(): Promise<void>
  /** 模拟宿主切走小说面板（卸载整棵视图树） */
  unmount(): Promise<void>
  /** 模拟切回（重挂；routeStore 现场还在，与真宿主一致） */
  mount(): Promise<void>
  /** 壳注册了哪些槽位（证明「全局面板双注册」在这一页成立） */
  slots(): Promise<string[]>
}

/** 开一页：独立 context（localStorage 干净）、收集 pageerror / console.error、加载并等待书架 */
export async function openPage(host: EpubHost, browser: Browser, viewport = { width: 1100, height: 900 }): Promise<PageSession> {
  const context: BrowserContext = await browser.newContext({ viewport, acceptDownloads: true })
  const page = await context.newPage()
  const errors: string[] = []
  const logs: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    const line = `${m.type()}: ${m.text()}`
    logs.push(line)
    if (m.type() === 'error') errors.push(line)
  })
  const session: PageSession = {
    page, errors, console: logs,
    url: (pathname) => host.base + pathname,
    close: async () => { await context.close() },
    reload: async () => {
      await page.goto(host.base, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('[data-novel-view="shelf"], [data-novel-view="reader"]', { timeout: 15_000 })
    },
    unmount: async () => { await page.evaluate(() => { (window as unknown as { __novelUnmount(): void }).__novelUnmount() }) },
    mount: async () => { await page.evaluate(() => { (window as unknown as { __novelMount(): void }).__novelMount() }) },
    slots: async () => page.evaluate(() => (window as unknown as { __novelSlots: string[] }).__novelSlots),
  }
  await session.reload()
  return session
}

/** 上传一份 EPUB fixture（真导入链：文件 input → POST local/import → 服务端发布） */
export async function uploadFixture(s: PageSession, fixture: string, fileName: string): Promise<'reader' | 'receipt'> {
  await s.page.setInputFiles('input[type=file]', { name: fileName, mimeType: 'application/epub+zip', buffer: makeEpubFixture(fixture) })
  return await settleImport(s)
}

/** 上传任意字节（TXT 回归用：GBK 编码的正文不是 EPUB fixture） */
export async function uploadBytes(s: PageSession, bytes: Buffer, fileName: string, mimeType: string): Promise<'reader' | 'receipt'> {
  await s.page.setInputFiles('input[type=file]', { name: fileName, mimeType, buffer: bytes })
  return await settleImport(s)
}

/** 导入落点：无告警 → 阅读器；有告警 → 停在书架的回执卡（等两者之一出现） */
async function settleImport(s: PageSession): Promise<'reader' | 'receipt'> {
  await s.page.waitForSelector('[data-novel-view="reader"], .novel-import-note', { timeout: 20_000 })
  return (await s.page.$('[data-novel-view="reader"]')) === null ? 'receipt' : 'reader'
}

/** 等一帧稳定（会话的 rAF 双帧 + 防抖都在这段时间里落地）；测试里不用 sleep 轮询，只做「等落定」 */
export const settle = (ms = 600): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 给「等一个可能永远不来的信号」加上限：故障注入的 arrival / 页面状态推进这类等待，
 * 没有上限就会变成 180s 的整例超时——失败点被藏进「某个 await 卡住了」，排查时无处下手。
 */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) => { setTimeout(() => reject(new Error(`超时 ${ms}ms：${what}`)), ms) }),
  ])
}

/** 真 HTTP 调一次本地服务的路由（种子数据/直接读数用；不走壳，绕开 UI 的另一半仍过真路由） */
export async function apiJson<T>(host: EpubHost, pathname: string, init?: RequestInit): Promise<T> {
  const res = await fetch(host.base + pathname, init)
  const text = await res.text()
  if (res.status !== 200) throw new Error(`${pathname} → HTTP ${res.status}：${text.slice(0, 400)}`)
  const env = JSON.parse(text) as { ok: boolean; value?: T; error?: { message: string } }
  if (!env.ok) throw new Error(`${pathname} → ${env.error?.message ?? '未知错误'}`)
  return env.value as T
}

/** 把假书源装进注册表（真 importOne：探针会真打一次注入的 fetchImpl） */
export async function installOnlineSource(host: EpubHost): Promise<string> {
  const outcome = await host.service.importOne(ONLINE_SOURCE_RAW)
  if (!outcome.ok || outcome.sourceId === null) throw new Error(`假书源导入失败：${JSON.stringify(outcome)}`)
  return outcome.sourceId
}

/** 上架一本书（真 PUT，与客户端同一条路由）。
 *  `progress` 必须**第二笔**发：带 title 的那一笔是「加书」形态（新书按空进度入架），
 *  dispatch 的进度形态要求书已在架上。一笔塞二者会被加书路径吃掉（进度静默丢失）。 */
export async function seedShelf(host: EpubHost, book: {
  sourceId: string; bookKey: string; title: string
  progress?: { chapterIndex: number; offsetRatio: number }
  totalChapters?: number
}): Promise<void> {
  const { progress, ...meta } = book
  await apiJson(host, `/novel-api/shelf/${encodeURIComponent(book.bookKey)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(meta),
  })
  if (progress !== undefined) {
    await apiJson(host, `/novel-api/shelf/${encodeURIComponent(book.bookKey)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ progress }),
    })
  }
}
