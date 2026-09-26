/**
 * 浏览器验收门（`DSH_EPUB_BROWSER=1` 打开；默认整门跳过——`pnpm test` 不跑它，跑通它也不代表别的门）。
 *
 * 这里量的是 jsdom 量不出的那几件事：真图片解码、真排版下的位置稳定、真滚动容器、真下载文件。
 * 底座是 `tests/browser/epub-host.ts`（真服务 + 真路由 + 真 `lib/client.js` + 已安装的浏览器）——
 * 门开着时**缺浏览器 / 缺 lib / 缺 fixture 一律红**（缺件即报错，不静默转绿）。
 *
 * 三条断言纪律：
 * ① 导入一律走 UI 的文件 input（真 `POST local/import`）——不塞一个「富响应」跳过导入链，
 *    否则被测的是本文件的想象力而不是发布链路；
 * ② 读数取自**真 DOM / 真响应 / 真下载字节**：图片看 naturalWidth（不是「img 在场」），
 *    导出比 golden 全文（不是「有几行」），进度看真 PUT 体；
 * ③ **每个用例一台自己的服务与数据根**：书架上只有这一例导入的书。共用服务时标题会撞车
 *    （同一本书导两次 = 两张同名卡片），「删掉某一本」这类断言会指到别人身上。
 *
 * 末两个用例是**缺陷读数**（诚实红）：真浏览器里量出的两个位置被改写的行为。
 * 断言按应有口径写、不改成绿；修好了自然转绿。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Browser } from 'playwright'
import iconv from 'iconv-lite'
import type { BookNavigation, ChapterContent, ContentNode, ShelfEntry } from '../../src/shared/wire.js'
import { LOCAL_SOURCE_ID, queries } from '../../src/shared/wire.js'
import {
  apiJson, installOnlineSource, launchBrowser, openPage, seedShelf, settle, startEpubHost, uploadBytes, uploadFixture,
  withTimeout, ONLINE_BOOK, ONLINE_CHAPTERS, type EpubHost, type PageSession,
} from './epub-host.js'

const ENABLED = process.env.DSH_EPUB_BROWSER === '1'

/**
 * React **开发版**告警（`Warning: …`）不算应用错误——它由本壳选的 development UMD 构建引入。
 * 但**不许当背景噪音吞掉**：本门把它当「现读清单」——清单外的每一条（含将来新增的 React 告警）即红。
 * 清单里这一条对应白名单把 `tr` 直挂 `table` 下（无 `tbody`）的现实：真 DOM 就是 `table > tr`
 * （React 用 createElement 建节点，浏览器不会像解析 HTML 那样补 tbody），第一个用例把这条断言成事实。
 */
const KNOWN_REACT_WARNINGS: RegExp[] = [/validateDOMNesting[\s\S]*<tr>[\s\S]*table/]

/** 浏览器自己的网络报告（注入故障/删后 404 时会有一条）——不是应用错误，另算 */
const NETWORK_REPORT = 'Failed to load resource'

/** 应用自己的错误：console.error 里既不是 React 告警通道、也不是浏览器网络报告的那些 */
function appErrors(s: PageSession): string[] {
  return s.errors.filter((e) => !e.startsWith('error: Warning: ') && !e.includes(NETWORK_REPORT))
}
/** 清单外的 React 告警 */
function unknownWarnings(s: PageSession): string[] {
  return s.errors
    .filter((e) => e.startsWith('error: Warning: '))
    .filter((w) => !KNOWN_REACT_WARNINGS.some((re) => re.test(w)))
}
/** 浏览器网络报告（注入的失败会有；默认场景应为 0） */
function networkReports(s: PageSession): string[] {
  return s.errors.filter((e) => e.includes(NETWORK_REPORT))
}

/** 图文树里的一级子节点展平（正文层只把块级节点放在顶层，够本门取用） */
const topLevel = (content: ChapterContent): ContentNode[] => {
  if (content.kind !== 'rich') throw new Error('期望图文树')
  return content.nodes
}
/** 一份图文树里所有 image 节点（同一份资源两处引用 = 两个节点） */
const imagesOf = (content: ChapterContent): Array<Extract<ContentNode, { kind: 'image' }>> => {
  if (content.kind !== 'rich') throw new Error('期望图文树')
  return content.nodes
    .flatMap((n) => (n.kind === 'element' ? n.children : [n]))
    .filter((n): n is Extract<ContentNode, { kind: 'image' }> => n.kind === 'image')
}

describe.skipIf(!ENABLED)('浏览器验收：EPUB 图文阅读（真服务 / 真 bundle / 真浏览器）', () => {
  let browser: Browser

  beforeAll(async () => { browser = await launchBrowser() }, 90_000)
  afterAll(async () => { await browser?.close() })

  /**
   * 一例 = 一台真服务 + 一个临时数据根 + 一页（独立 context ⇒ localStorage 干净）。
   * 用例体拿到 `s`（页面）与 `host`（服务/请求记录/故障注入）；收尾时断言错误面干净。
   */
  async function withHost(
    fn: (s: PageSession, host: EpubHost) => Promise<void>,
    opts: { viewport?: { width: number; height: number }; networkReports?: number } = {},
  ): Promise<void> {
    const host = await startEpubHost()
    const s = await openPage(host, browser, opts.viewport)
    try {
      expect(await s.slots(), '壳应注册出侧栏行 / main 面板 / 常驻状态层三个槽位').toEqual([
        'sidebar.panellist:novel', 'main:novel', 'shell.overlay:novel-status',
      ])
      await fn(s, host)
      expect(appErrors(s), '控制台与 pageerror 不应有应用自己的错误').toEqual([])
      expect(unknownWarnings(s), '出现了清单外的 React 告警（新形态？回现场看一眼再决定是修还是登记）').toEqual([])
      expect(networkReports(s).length, '网络报告条数与用例声明的注入数不符').toBe(opts.networkReports ?? 0)
    } finally {
      await s.close()
      await host.stop()
    }
  }

  // ── 读数小工具（本文件唯一的测量口径，各例共用）────────────────────────────

  const shelf = (host: EpubHost): Promise<ShelfEntry[]> => apiJson<ShelfEntry[]>(host, '/novel-api/shelf')
  async function keyOf(host: EpubHost, title: string): Promise<string> {
    const list = await shelf(host)
    const hit = list.find((b) => b.title === title)
    if (hit === undefined) throw new Error(`书架上没有《${title}》（现有：${list.map((b) => b.title).join('、')}）`)
    return hit.bookKey
  }
  const navOf = (host: EpubHost, key: string): Promise<BookNavigation> =>
    apiJson<BookNavigation>(host, `/novel-api/${queries.navigation({ sourceId: LOCAL_SOURCE_ID, url: key })}`)
  const chapterOf = (host: EpubHost, key: string, index: number): Promise<ChapterContent> =>
    apiJson<ChapterContent>(host, `/novel-api/${queries.chapter({ sourceId: LOCAL_SOURCE_ID, url: key, index })}`)

  /**
   * 视口顶所在的章与节点（视口顶 = .novel-main 的 rect.top）。
   * 两条口径都**照产品自己的判据**（`ReaderView.currentNodeOf`）：视口顶已越过的最靠下那个；
   * 一个都没越过（正文列有上内边距、或刚挂载还没滚）→ 取文档顺序里的第一个。
   * 亚像素落位按 0.5px 容差算「已在顶」。
   */
  const probe = (s: PageSession) => s.page.evaluate(() => {
    const main = document.querySelector('[data-novel-main]') as HTMLElement
    const viewTop = main.getBoundingClientRect().top
    const blocks = [...document.querySelectorAll('[data-chapter]')]
    const visible = blocks.filter((b) => b.getBoundingClientRect().top - viewTop <= 0.5)
    const chapterEl = visible[visible.length - 1] ?? blocks[0] ?? null
    let best: { id: string; top: number } | null = null
    let first: { id: string; top: number } | null = null
    for (const el of document.querySelectorAll('[data-chapter] [data-novel-node]')) {
      const top = el.getBoundingClientRect().top - viewTop
      const cand = { id: el.getAttribute('data-novel-node') as string, top }
      if (first === null) first = cand
      if (top <= 0.5 && (best === null || top > best.top)) best = cand
    }
    const hit = best ?? first
    return {
      chapter: chapterEl?.getAttribute('data-chapter') ?? null,
      node: hit?.id ?? null,
      offset: hit?.top ?? null,
      scrollTop: Math.round(main.scrollTop),
    }
  })

  /** 某个节点相对视口顶的偏移（锚点落位、重排前后比它） */
  const offsetOf = (s: PageSession, nodeId: string): Promise<number | null> => s.page.evaluate((id) => {
    const main = document.querySelector('[data-novel-main]') as HTMLElement
    const el = document.querySelector(`[data-chapter] [data-novel-node="${id}"]`)
    return el === null ? null : el.getBoundingClientRect().top - main.getBoundingClientRect().top
  }, nodeId)

  /** 某章块的几何：顶相对视口顶的偏移 + 渲染高度。
   *  **恢复位用章块量，不用节点身份量**——重挂后只载入存档那一章（预取只向前，上一章不会回来），
   *  重挂前「视口顶已越过的最后一个节点」可能正是上一章尾部的那个，它整块消失，节点身份跨剪枝不可比。 */
  const blockBox = (s: PageSession, index: number): Promise<{ top: number; height: number } | null> =>
    s.page.evaluate((i) => {
      const main = document.querySelector('[data-novel-main]') as HTMLElement
      const el = document.querySelector(`[data-chapter="${i}"]`)
      if (el === null) return null
      const r = el.getBoundingClientRect()
      return { top: r.top - main.getBoundingClientRect().top, height: r.height }
    }, index)

  /** 已载章的章号（升序；正文渲染顺序 = 书的顺序，pruneToViewport 保证连续无洞） */
  const loadedChapters = (s: PageSession): Promise<number[]> =>
    s.page.$$eval('[data-chapter]', (els) => els.map((e) => Number(e.getAttribute('data-chapter'))))

  const openDrawer = async (s: PageSession): Promise<void> => {
    await s.page.click('button[aria-label="目录"]')
    await s.page.waitForSelector('.novel-drawer-item', { timeout: 8_000 })
    await settle(300)
  }
  const clickLeaf = async (s: PageSession, label: string): Promise<void> => {
    await s.page.evaluate((text) => {
      const hit = [...document.querySelectorAll('.novel-drawer-item')].find((b) => b.textContent === text)
      if (hit === undefined) throw new Error(`目录里没有条目「${text}」`)
      ;(hit as HTMLButtonElement).click()
    }, label)
  }
  const drawerLeaves = (s: PageSession): Promise<string[]> =>
    s.page.$$eval('.novel-drawer-item', (els) => els.map((e) => e.textContent as string))

  /**
   * 工具栏章进度细线的 `--novel-pct` = (currentChapter + 1) / 章数——**会话「读到第几章」的 DOM 投影**
   * （跨章才写，低频呈现）。章很短的在线书里滚动会被 clamp，「哪一块在视口顶」量不出阅读位置，
   * 而这个值来自会话自己的 truth，正好补上那一格。
   */
  const currentPct = (s: PageSession): Promise<string> =>
    s.page.evaluate(() => (document.querySelector('.novel-rdr-trail') as HTMLElement).style.getPropertyValue('--novel-pct'))

  /** 某章块是否在视口内可见（短书里落位被 clamp 时的可测口径） */
  const chapterVisible = (s: PageSession, index: number): Promise<boolean> => s.page.evaluate((i) => {
    const main = document.querySelector('[data-novel-main]') as HTMLElement
    const box = main.getBoundingClientRect()
    const el = document.querySelector(`[data-chapter="${i}"]`)
    if (el === null) return false
    const r = el.getBoundingClientRect()
    return r.top < box.bottom && r.bottom > box.top
  }, index)

  // ══ 1. 导入链与书目面 ══════════════════════════════════════════════════════

  it('EPUB3：文件 input 走真导入链 → 阅读器；封面真解码；正文按白名单成 DOM', async () => {
    await withHost(async (s, host) => {
      expect(await s.page.$('[data-novel-view="shelf"]')).not.toBeNull()
      expect(await uploadFixture(s, 'epub3-rich', '图文样本.epub'), '无告警的导入应直接进阅读器').toBe('reader')
      await s.page.waitForSelector('[data-chapter] [data-novel-node]', { timeout: 20_000 })
      await settle(900)

      expect(await s.page.textContent('.novel-rdr-book')).toBe('图文样本')
      expect(await s.page.textContent('.novel-rdr-title')).toContain('共 2 章')

      const dom = await s.page.evaluate(() => {
        const q = (sel: string) => document.querySelector(`[data-chapter="0"] ${sel}`)
        return {
          strong: q('strong')?.textContent, em: q('em')?.textContent,
          rows: [...document.querySelectorAll('[data-chapter="0"] table tr')].map((tr) => ({
            parent: (tr.parentElement as HTMLElement).tagName,
            cells: [...tr.children].map((c) => ({ tag: c.tagName, text: c.textContent, rowSpan: (c as HTMLTableCellElement).rowSpan, colSpan: (c as HTMLTableCellElement).colSpan })),
          })),
          olStart: q('ol')?.getAttribute('start'),
          liValue: q('ol li')?.getAttribute('value'),
          pre: q('pre')?.textContent,
          sup: q('sup')?.textContent, sub: q('sub')?.textContent,
          rule: q('hr') !== null,
          unknownText: q('[data-novel-node="n28"]')?.textContent,
          sectionTag: q('[data-novel-node="n29"]')?.tagName,
          uTags: document.querySelectorAll('[data-chapter="0"] u').length,
          bodyWidth: Math.round((document.querySelector('.novel-rdr-body') as HTMLElement).getBoundingClientRect().width),
          mainWidth: Math.round((document.querySelector('[data-novel-main]') as HTMLElement).getBoundingClientRect().width),
        }
      })
      expect(dom.mainWidth, '宿主面板宽度要真的给到阅读区（挂载点是 flex 容器时会退化成 327px 的假窄屏）')
        .toBeGreaterThan(900)
      expect(dom.bodyWidth, '正文列按 --novel-measure 收窄（36em ≈ 648px）').toBeGreaterThan(600)
      expect(dom.strong).toBe('粗')
      expect(dom.em).toBe('斜')
      // 白名单把 tr 直接建在 table 下（React 的 createElement 不走 HTML 解析，浏览器不会补 tbody）：
      // DOM 就此非法一步（渲染仍对），React 开发版提示一次——这就是清单里那条告警的来源，如实记下来
      expect(dom.rows.map((r) => r.parent), 'table > tr（无 tbody）是本仓现状').toEqual(['TABLE', 'TABLE'])
      expect(dom.rows[0].cells.map((c) => `${c.tag}:${c.text}`)).toEqual(['TH:竖跨', 'TD:横跨'])
      expect(dom.rows[0].cells[0].rowSpan).toBe(2)
      expect(dom.rows[0].cells[1].colSpan).toBe(2)
      expect(dom.rows[1].cells.map((c) => c.text)).toEqual(['右', '下'])
      expect(dom.olStart).toBe('3')
      expect(dom.liValue).toBe('7')
      expect(dom.pre, 'pre 的空白是内容：换行与两空格原样保留').toBe('pre 里  的空白\n  原样保留')
      expect(dom.sup).toBe('2')
      expect(dom.sub).toBe('2')
      expect(dom.rule).toBe(true)
      expect(dom.unknownText).toBe('未知容器 下划线 保留子内容')
      expect(dom.uTags, '白名单外的 <u> 不发明元素（保留子内容）').toBe(0)
      expect(dom.sectionTag).toBe('DIV')

      // 封面：回书架看卡片上的真解码（不是「img 标签在场」）
      await s.page.click('button:has-text("‹ 书架")')
      await s.page.waitForSelector('[data-novel-view="shelf"] .novel-card img', { timeout: 10_000 })
      const cover = await s.page.evaluate(() => {
        const img = document.querySelector('[data-novel-view="shelf"] .novel-card img') as HTMLImageElement
        return { w: img.naturalWidth, h: img.naturalHeight, complete: img.complete }
      })
      expect(cover).toEqual({ w: 2, h: 3, complete: true })
      // 书目元数据来自真服务（导入回执与书架列表同源）
      expect((await shelf(host))[0]).toMatchObject({
        sourceId: LOCAL_SOURCE_ID, title: '图文样本', author: '样本作者', totalChapters: 2,
      })
    })
  }, 180_000)

  // ══ 2. 目录树与锚点 ═══════════════════════════════════════════════════════

  it('EPUB3：目录三叶（组头不可点）→ 同章两锚点各自落位 → 跨章锚点落位', async () => {
    await withHost(async (s, host) => {
      await uploadFixture(s, 'epub3-rich', '图文样本.epub')
      await s.page.waitForSelector('[data-chapter] [data-novel-node]', { timeout: 20_000 })
      await settle(900)
      const key = await keyOf(host, '图文样本')
      const nav = await navOf(host, key)
      expect(nav.items.map((i) => i.label)).toEqual(['第一卷'])
      expect(nav.items[0].target, '卷组头不带目标（不可点，也不伪造导航）').toBeNull()
      expect(nav.items[0].children.map((c) => c.label)).toEqual(['甲', '乙', '丙'])
      const anchorOf = (label: string): string => {
        const leaf = nav.items[0].children.find((c) => c.label === label)!
        return leaf.target!.kind === 'chapter' ? leaf.target!.anchorId! : ''
      }
      expect([anchorOf('甲'), anchorOf('乙'), anchorOf('丙')]).toEqual(['a1', 'a2', 'a4'])

      await openDrawer(s)
      expect(await drawerLeaves(s)).toEqual(['甲', '乙', '丙'])
      expect(await s.page.$$eval('.novel-nav-group', (els) => els.map((e) => e.textContent))).toEqual(['第一卷'])
      expect(await s.page.$$eval('.novel-drawer-item[aria-current="true"]', (els) => els.map((e) => e.textContent)),
        '抽屉里至多一条 aria-current（同一章多条锚点时也该只有一条）').toEqual(['甲'])

      // 同章第一个锚点：甲 → a1 落在视口顶
      await clickLeaf(s, '甲')
      await settle(1_000)
      expect(Math.abs((await offsetOf(s, anchorOf('甲'))) ?? 99), '甲（ch1#a）应停在视口顶 ±4px').toBeLessThanOrEqual(4)
      // 同章第二个锚点：乙 → a2（不是复制出的另一章）
      await openDrawer(s)
      await clickLeaf(s, '乙')
      await settle(1_000)
      const at = await probe(s)
      expect(at.chapter).toBe('0')
      expect(at.node, '视口顶应停在乙自己的节点上').toBe(anchorOf('乙'))
      expect(Math.abs(at.offset ?? 99)).toBeLessThanOrEqual(4)
      expect(await s.page.$$eval('[data-chapter]', (els) => els.length), '同章两个锚点不复制成两章').toBeLessThanOrEqual(2)
      // 跨章：丙 → ch2 的 a4
      await openDrawer(s)
      await clickLeaf(s, '丙')
      await settle(1_100)
      const cross = await probe(s)
      expect(cross.chapter).toBe('1')
      expect(cross.node).toBe(anchorOf('丙'))
      expect(Math.abs(cross.offset ?? 99)).toBeLessThanOrEqual(4)
      // 目录叶数（3）与阅读单元数（2）本就不必相等：两条锚点落在同一章
      expect((await navOf(host, key)).chapters).toHaveLength(2)
    })
  }, 180_000)

  // ══ 3. 脚注与返回栈 ═══════════════════════════════════════════════════════

  it('EPUB3：脚注面板 → 关闭即回引用处；面板内反向链接回正文', async () => {
    await withHost(async (s, host) => {
      await uploadFixture(s, 'epub3-rich', '图文样本.epub')
      await s.page.waitForSelector('[data-chapter] [data-novel-node]', { timeout: 20_000 })
      await settle(900)
      const key = await keyOf(host, '图文样本')
      const ch0 = await chapterOf(host, key, 0)
      const noteref = topLevel(ch0)
        .flatMap((n) => (n.kind === 'element' ? n.children : [n]))
        .find((n) => n.kind === 'link' && n.role === 'noteref')
      if (noteref === undefined || noteref.kind !== 'link') throw new Error('第一章的图文树里应有脚注引用')

      // 引用处滚到视野中间（这一段在章末，正是「读得靠下」的现场）
      await s.page.evaluate((id) => document.querySelector(`[data-novel-node="${id}"]`)?.scrollIntoView({ block: 'center' }), noteref.id)
      await settle(800)
      const before = await probe(s)
      expect(before.chapter).toBe('0')

      await s.page.click(`[data-novel-node="${noteref.id}"]`)
      await s.page.waitForSelector('[role="dialog"][aria-label="注释"]', { timeout: 10_000 })
      await settle(800)
      const panel = await s.page.evaluate(() => {
        const el = document.querySelector('[role="dialog"][aria-label="注释"]') as HTMLElement
        return { text: el.textContent, backlink: [...el.querySelectorAll('[data-novel-role="backlink"]')].map((b) => b.textContent) }
      })
      expect(panel.text).toContain('脚注一')
      expect(panel.backlink, '补充文档里的反向链接在面板里可点').toEqual(['返回正文'])
      expect(await s.page.$('button[title="回到跟随链接前的位置"]'), '跟随内链后工具栏应出现「返回原处」入口').not.toBeNull()

      // 关面板 = 回引用处（消费开面板时压下的那条返回项）
      await s.page.click('[role="dialog"][aria-label="注释"] button:has-text("关闭")')
      await s.page.waitForSelector('[role="dialog"][aria-label="注释"]', { state: 'detached', timeout: 8_000 })
      await settle(1_000)
      const after = await probe(s)
      expect(after.chapter).toBe(before.chapter)
      expect(Math.abs(after.scrollTop - before.scrollTop), '关闭面板即回引用处的同一位置（±4px）').toBeLessThanOrEqual(4)
      expect(await s.page.$('button[title="回到跟随链接前的位置"]'), '返回项被消费后入口应消失').toBeNull()
      expect(new Set(host.progressPuts().map((p) => p.chapterIndex)),
        '开合面板期间不得把读到哪章改到别处（跟随脚注引用进补充文档也算「本章内」，落盘仍是第 0 章）').toEqual(new Set([0]))

      // 面板内的反向链接：backlink **就是**返回动作（会话弹掉那条采点，然后跳到链接自己的目标
      // = 正文里的引用锚点），所以这里量的是「回到引用锚点」而不是「回到某个被夹住的滚动值」
      await s.page.click(`[data-novel-node="${noteref.id}"]`)
      await s.page.waitForSelector('[role="dialog"][aria-label="注释"]', { timeout: 10_000 })
      await settle(600)
      await s.page.click('[role="dialog"][aria-label="注释"] [data-novel-role="backlink"]')
      await s.page.waitForSelector('[role="dialog"][aria-label="注释"]', { state: 'detached', timeout: 8_000 })
      await settle(1_000)
      expect((await probe(s)).chapter).toBe('0')
      expect(Math.abs((await offsetOf(s, noteref.id)) ?? 99), 'backlink 落到正文引用锚点（视口顶 ±4px）').toBeLessThanOrEqual(4)
      expect(await s.page.$('button[title="回到跟随链接前的位置"]'), 'backlink 消费掉那条采点后不应再有返回入口').toBeNull()
    })
  }, 180_000)

  // ══ 4. 导出与资源生命周期 ═════════════════════════════════════════════════

  it('EPUB3：⤓ 下载的字节与 golden 全文一致；删书后封面与插图资源 404', async () => {
    await withHost(async (s, host) => {
      await uploadFixture(s, 'epub3-rich', '图文样本.epub')
      await s.page.waitForSelector('[data-chapter] [data-novel-node]', { timeout: 20_000 })
      await settle(900)

      const download = s.page.waitForEvent('download', { timeout: 25_000 })
      await s.page.click('button:has-text("⤓ 下载")')
      await s.page.waitForSelector('[role="dialog"][aria-label="导出范围"]', { timeout: 8_000 })
      expect(await s.page.textContent('[role="dialog"][aria-label="导出范围"]'), '图文书的导出只有文字，这句话必须在下手之前说').toContain('TXT 文字导出，不包含图片')
      await s.page.click('[role="dialog"][aria-label="导出范围"] button:has-text("⤓ 下载")')
      const file = await download
      const stream = await file.createReadStream()
      const chunks: Buffer[] = []
      for await (const c of stream) chunks.push(Buffer.from(c as Buffer))
      const bytes = Buffer.concat(chunks)

      // golden 全文：真服务文字投影 + 导出模板逐字（章头《书名》· 章名、段间空行、BOM）
      const GOLDEN = '\uFEFF《图文样本》· 第一章\n\n'
        + '第一章\n甲 粗 与 斜\n下一行\n实体 & 与 &amp; 与 A\n第七项\n第八项\n竖跨\t横跨\n右\t下\n'
        + 'pre 里  的空白\n  原样保留\n上标 x2 与下标 H2O\n引用一段\n[图片：插图][图片]\n脚注1与跨章丙\n'
        + '未知容器 下划线 保留子内容\n结构容器 变粗\n\n'
        + '《图文样本》· 第二章\n\n第二章\n丙\n[图片：共用插图]\n回到乙\n\n'
      expect(file.suggestedFilename()).toBe('图文样本.txt')
      expect(bytes.toString('utf8')).toBe(GOLDEN)
      expect(bytes.subarray(0, 3), '导出首字节是 UTF-8 BOM（记事本兼容）').toEqual(Buffer.from([0xef, 0xbb, 0xbf]))

      // 回书架删书（本地书连带删副本）：删前资源可读，删后必须 404
      await s.page.click('button:has-text("‹ 书架")')
      await s.page.waitForSelector('button[aria-label="删除 图文样本"]', { timeout: 10_000 })
      const coverUrl = (await shelf(host))[0].coverUrl!
      expect(coverUrl).toContain('/novel-api/local/resource')
      expect((await s.page.request.get(s.url(coverUrl))).status(), '删前资源可读').toBe(200)
      await s.page.click('button[aria-label="删除 图文样本"]')
      await s.page.waitForSelector('[role="dialog"][aria-modal="true"]', { timeout: 8_000 })
      expect(await s.page.textContent('[role="dialog"][aria-modal="true"]'), '删除确认要交代「本地副本连删」').toContain('本地书')
      await s.page.click('[role="dialog"][aria-modal="true"] button:has-text("确认删除")')
      await s.page.waitForSelector('[role="dialog"][aria-modal="true"]', { state: 'detached', timeout: 10_000 })
      await settle(800)
      expect(await shelf(host), '删书后书架不再列出').toEqual([])
      expect(await s.page.$$eval('.novel-card-title', (els) => els.map((e) => e.textContent)), '界面也要跟着更新').not.toContain('图文样本')
      expect((await s.page.request.get(s.url(coverUrl))).status(), '删书后本地资源必须 404（不留可读副本）').toBe(404)
      const unknown = coverUrl.replace(/resourceId=[^&]+/, 'resourceId=r999')
      expect((await s.page.request.get(s.url(unknown))).status(), '未知资源 id 同样 404').toBe(404)
    })
  }, 180_000)

  // ══ 5. 图片：真解码、预留框、位置稳定 ═════════════════════════════════════

  it('EPUB3：插图真解码出 2×3、预留框按可信比例；图到手前后同一节点的视口偏移 ≤2px', async () => {
    await withHost(async (s, host) => {
      // 「慢图片」走**有界延迟**：在途窗口里量一次图之后那段正文的位置，等图真到手再量一次。
      // 延迟给得比「量框 + 取读数」这几步宽得多（2.5s）；「图确实还没到」这条前提不靠时长赌，
      // 由下面那条 naturalWidth === 0 自己守（提前解码了会当场红，而不是量到两个「都已到手」的读数）。
      host.delayNext({ pathIncludes: '/novel-api/local/resource' }, 2_500)
      await uploadFixture(s, 'epub3-rich', '图文样本.epub')
      await s.page.waitForSelector('[data-chapter] [data-novel-node]', { timeout: 20_000 })
      await settle(700)
      const key = await keyOf(host, '图文样本')
      const figs = imagesOf(await chapterOf(host, key, 0))
      expect(figs).toHaveLength(2)
      expect({ w: figs[0].width, h: figs[0].height }).toEqual({ w: 2, h: 3 })

      // 图还没到：框已按可信宽高比占在那里（量的是框，不是图）
      const boxBefore = await s.page.evaluate((id) => {
        const el = document.querySelector(`[data-novel-node="${id}"]`) as HTMLElement
        const img = el.querySelector('img') as HTMLImageElement | null
        const r = el.getBoundingClientRect()
        return { h: r.height, ratio: r.width / r.height, hasImg: img !== null, natural: img?.naturalWidth ?? null }
      }, figs[0].id)
      const offBefore = await offsetOf(s, 'a2')
      expect(boxBefore.hasImg).toBe(true)
      // 本样本的封面与两张插图共用同一份 png：**必须量到目标图自己是 0**，否则「一次延迟就全都未解码」
      // 会让这条读数与目标资源无关（换一张只有插图、封面另用的书，这里就会静默变成恒真）
      expect(boxBefore.natural, '图到手前目标插图必须尚未解码（naturalWidth === 0）').toBe(0)
      expect(offBefore, '图未到时也该量得到图之后那段正文的位置').not.toBeNull()

      await s.page.waitForFunction((id) => {
        const img = document.querySelector(`[data-novel-node="${id}"] img`) as HTMLImageElement | null
        return img !== null && img.complete && img.naturalWidth > 0
      }, figs[0].id, { timeout: 25_000 })
      await settle(500)
      const decoded = await s.page.evaluate((id) => {
        const el = document.querySelector(`[data-novel-node="${id}"]`) as HTMLElement
        const img = el.querySelector('img') as HTMLImageElement
        const r = el.getBoundingClientRect()
        const body = document.querySelector('.novel-rdr-body') as HTMLElement
        const cs = getComputedStyle(body)
        return {
          w: img.naturalWidth, h: img.naturalHeight, boxH: r.height, boxW: r.width,
          ratio: r.width / r.height, src: img.getAttribute('src'),
          column: body.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        }
      }, figs[0].id)
      expect({ w: decoded.w, h: decoded.h }, '图片必须**真被浏览器解码**（naturalWidth 来自解码结果）').toEqual({ w: 2, h: 3 })
      expect(decoded.src, '图片走本地资源口（同源，不落书内路径）').toContain('/novel-api/local/resource')
      expect(decoded.ratio, '框按可信比例 2/3 预留（不是加载后才跳出来）').toBeCloseTo(2 / 3, 2)
      // 框宽的现状读数：**恒铺满正文栏**（高度由可信比例折算，框不随图缩窄、也不用居中小盒包住窄图）。
      // 这条钉的是「换实现时别悄悄改口径」——竖长图铺满整栏会很高，是当前刻意的取舍，不是渲染漏算。
      expect(Math.abs(decoded.boxW - decoded.column), '插图框宽度 = 正文栏宽（现状：铺满整栏）').toBeLessThanOrEqual(2)
      expect(Math.abs(decoded.boxH - boxBefore.h), '图到手后预留框高度不变（不跳版）').toBeLessThanOrEqual(1)
      const offAfter = await offsetOf(s, 'a2')
      expect(Math.abs(offAfter! - offBefore!), '同一文本节点的视口相对偏移在图片到手前后 ≤2 CSS px').toBeLessThanOrEqual(2)
      expect(host.pendingFaults(), '注入的挂起必须真的被吃掉（否则上面的读数只是「图本来就没在请求」）').toBe(0)
    })
  }, 180_000)

  it('EPUB3：链接里的插图也先占位（链接是块级容器，收缩包裹会让框塌成 0）', async () => {
    // 链接（`<button>`）缺省按内容收缩包裹，里面 `width: 100%` 的插图框会解析成 auto——图还没解码
    // 就没有内在尺寸，框塌成 0，图一到手后文整段位移（实测 0×0 → 600×900）。修法是把含块内容的
    // 链接变成块级容器（XHTML5 的透明内容模型本来就允许），于是百分比宽度有确定基准。
    // 这条只有真排版量得出来：jsdom 里 rect 恒 0，塌不塌都一样。
    await withHost(async (s, host) => {
      host.delayNext({ pathIncludes: '/novel-api/local/resource' }, 2_500)
      // 本样本没有原生目录 → 导入留一条「合成目录」告警，先停在回执页
      expect(await uploadFixture(s, 'epub3-link-image', '链接图样本.epub')).toBe('receipt')
      await s.page.click('button:has-text("开始阅读")')
      await s.page.waitForSelector('[data-chapter] [data-novel-node]', { timeout: 20_000 })
      await settle(700)

      /** 链接里那张图的框、链接自身的 display、以及图之后那个文本节点的视口偏移 */
      const read = (): Promise<{ h: number; w: number; natural: number; linkDisplay: string; cTop: number }> =>
        s.page.evaluate(() => {
          const fig = document.querySelector('.novel-ref .novel-fig') as HTMLElement
          const img = fig.querySelector('img') as HTMLImageElement | null
          const box = fig.getBoundingClientRect()
          const main = document.querySelector('[data-novel-main]') as HTMLElement
          // 图之后那段正文：按正文层里的最后一个段落取（不按原书 id——节点 ID 是导入期铸的 opaque 串）
          const paras = [...document.querySelectorAll('.novel-body p')]
          const tail = paras[paras.length - 1] as HTMLElement
          return {
            h: box.height, w: box.width,
            natural: img === null ? -1 : img.naturalWidth,
            linkDisplay: getComputedStyle(fig.closest('button') as HTMLElement).display,
            cTop: tail.getBoundingClientRect().top - main.getBoundingClientRect().top,
          }
        })

      const before = await read()
      expect(before.natural, '图到手前目标插图必须尚未解码').toBe(0)
      expect(before.linkDisplay, '含块内容的链接必须是块级容器（inline-block 收缩包裹会让框塌）').toBe('block')
      expect(before.w, '图未到时框宽就应是正文栏宽（不是 0）').toBeGreaterThan(100)
      expect(before.h, '图未到时框高就应按可信比例占好').toBeGreaterThan(100)

      await s.page.waitForFunction(() => {
        const img = document.querySelector('.novel-ref .novel-fig img') as HTMLImageElement | null
        return img !== null && img.complete && img.naturalWidth > 0
      }, undefined, { timeout: 25_000 })
      await settle(500)
      const after = await read()
      expect(after.natural, '示例图必须真被浏览器解码').toBe(2)
      expect(Math.abs(after.h - before.h), '图到手前后框高不变（不跳版）').toBeLessThanOrEqual(1)
      expect(Math.abs(after.cTop - before.cTop), '图之后那段正文的视口相对偏移在图片到手前后 ≤2 CSS px')
        .toBeLessThanOrEqual(2)
      expect(host.pendingFaults(), '注入的延迟必须真的被吃掉').toBe(0)
    })
  }, 180_000)

  it('EPUB3：图片请求失败 → 预留框不塌、正文位置不动（±2px），且如实显示「图片加载失败」', async () => {
    await withHost(async (s, host) => {
      // 失败侧也要有**偏移读数**：先把这张图挂住，趁在途量一次图之后那段正文的位置；
      // 再以 500 释放（同一个挂起窗口的另一种结局），量同一节点的位置差。
      // 只断言「节点还在」证明不了「正文没被拽走」——位置断言必须真的量位置。
      const hold = host.hold({ pathIncludes: '/novel-api/local/resource' }, { status: 500 })
      await uploadFixture(s, 'epub3-rich', '图文样本.epub')
      await s.page.waitForSelector('[data-chapter] [data-novel-node]', { timeout: 20_000 })
      await withTimeout(hold.arrived, 15_000, '插图的资源请求没到（挂起注入没生效？）')
      await settle(500)
      const fig = imagesOf(await chapterOf(host, await keyOf(host, '图文样本'), 0))[0]
      const offBefore = await offsetOf(s, 'a2')
      expect(offBefore, '失败响应还没发时就该量得到图之后那段正文的位置').not.toBeNull()
      expect(await s.page.$(`[data-novel-node="${fig.id}"] img`), '前置：失败响应还没发，img 还在请求中').not.toBeNull()

      hold.release()
      await s.page.waitForSelector(`[data-novel-node="${fig.id}"] .novel-fig-fail`, { timeout: 15_000 })
      await settle(500)
      const failed = await s.page.evaluate((id) => {
        const el = document.querySelector(`[data-novel-node="${id}"]`) as HTMLElement
        const box = el.getBoundingClientRect()
        const label = el.querySelector('.novel-fig-fail') as HTMLElement
        return { ratio: box.width / box.height, text: label.textContent, aria: label.getAttribute('aria-label'), imgs: el.querySelectorAll('img').length }
      }, fig.id)
      expect(failed.text).toBe('图片加载失败')
      expect(failed.aria).toBe('图片加载失败：插图')
      expect(failed.imgs).toBe(0)
      expect(failed.ratio, '失败时仍是同一块按比例预留的框').toBeCloseTo(2 / 3, 2)
      const offAfter = await offsetOf(s, 'a2')
      expect(offAfter, '失败后同一文本节点仍量得到（没有整块消失）').not.toBeNull()
      expect(Math.abs(offAfter! - offBefore!), '图片请求失败不得移动正文：同一文本节点的视口相对偏移差 ≤2 CSS px')
        .toBeLessThanOrEqual(2)
      expect(host.pendingFaults(), '失败注入必须真的被吃掉').toBe(0)
    }, { networkReports: 1 })
  }, 180_000)

  it('EPUB3：结构完整却解不开的两张图（真 PNG / 真 GIF）→ 浏览器如实报失败，框不塌', async () => {
    await withHost(async (s, host) => {
      expect(await uploadFixture(s, 'epub3-undecodable-image', '解不开的图样本.epub'), '本章有「合成目录」告警，导入停在回执页').toBe('receipt')
      await s.page.click('button:has-text("开始阅读")')
      await s.page.waitForSelector('[data-chapter] [data-novel-node]', { timeout: 20_000 })
      await settle(900)
      const figs = imagesOf(await chapterOf(host, await keyOf(host, '解不开的图样本'), 0))
      expect(figs.map((f) => f.alt)).toEqual(['结构完整却解不开的 PNG', '只剩 trailer 的 GIF'])

      // 两份样本在导入期都过了本仓的**容器结构**核对（Node 侧另有钉子）：这里看真解码的结果
      await s.page.waitForSelector('.novel-fig-fail', { timeout: 15_000 })
      await settle(700)
      const reading = await s.page.evaluate((ids) => ids.map((id) => {
        const el = document.querySelector(`[data-novel-node="${id}"]`) as HTMLElement
        const box = el.getBoundingClientRect()
        const fail = el.querySelector('.novel-fig-fail') as HTMLElement | null
        return {
          text: fail?.textContent ?? null, aria: fail?.getAttribute('aria-label') ?? null,
          ratio: box.height === 0 ? null : Number((box.width / box.height).toFixed(3)),
          natural: (el.querySelector('img') as HTMLImageElement | null)?.naturalWidth ?? null,
        }
      }), figs.map((f) => f.id))
      expect(reading.map((r) => r.text)).toEqual(['图片加载失败', '图片加载失败'])
      expect(reading.map((r) => r.aria)).toEqual(['图片加载失败：结构完整却解不开的 PNG', '图片加载失败：只剩 trailer 的 GIF'])
      expect(reading.map((r) => r.natural), '没有可用解码结果').toEqual([null, null])
      expect(reading[0].ratio, '2×3 → 2/3 的框仍在').toBeCloseTo(2 / 3, 2)
      expect(reading[1].ratio, '1×1 → 1 的框仍在').toBeCloseTo(1, 2)
    })
  }, 180_000)

  it('EPUB3：字号与栏宽变化后，同一节点的视口相对偏移保持（±4px）', async () => {
    await withHost(async (s) => {
      await uploadFixture(s, 'epub3-rich', '图文样本.epub')
      await s.page.waitForSelector('[data-chapter] [data-novel-node]', { timeout: 20_000 })
      await settle(1_200)
      await s.page.evaluate(() => { (document.querySelector('[data-novel-main]') as HTMLElement).scrollTop = 700 })
      await settle(800)
      const before = await probe(s)
      expect(before.node, '视口顶应落在一个正文节点上').not.toBeNull()
      const boxBefore = await s.page.evaluate(() => {
        const el = document.querySelector('.novel-rdr-body') as HTMLElement
        return { w: el.getBoundingClientRect().width, font: getComputedStyle(el).fontSize }
      })

      await s.page.click('button[aria-label="阅读设置"]')
      await s.page.waitForSelector('[data-novel-ctrl]', { timeout: 8_000 })
      await s.page.click('button[aria-label="增大字号"]')
      await settle(900)
      const afterFont = await probe(s)
      const boxAfter = await s.page.evaluate(() => {
        const el = document.querySelector('.novel-rdr-body') as HTMLElement
        return { w: el.getBoundingClientRect().width, font: getComputedStyle(el).fontSize }
      })
      expect(boxAfter.font, '字号真的变了（否则这条断言什么都没证明）').not.toBe(boxBefore.font)
      expect(afterFont.node, '重排后视口顶仍停在同一个节点').toBe(before.node)
      expect(Math.abs((afterFont.offset ?? 99) - (before.offset ?? 0)), '同一节点的视口相对偏移保持 ±4px').toBeLessThanOrEqual(4)

      // 栏宽：改到最窄一档（em 随字号缩放，正文列因此真的变窄）
      await s.page.evaluate(() => {
        const buttons = [...document.querySelectorAll('[data-novel-ctrl] button')]
        const target = buttons.find((b) => b.textContent === '窄')
        if (target === undefined) throw new Error(`阅读设置里没有「窄」档：${buttons.map((b) => b.textContent).join('/')}`)
        ;(target as HTMLButtonElement).click()
      })
      await settle(900)
      const afterMeasure = await probe(s)
      const boxNarrow = await s.page.evaluate(() => (document.querySelector('.novel-rdr-body') as HTMLElement).getBoundingClientRect().width)
      expect(boxNarrow, '栏宽真的变窄了').toBeLessThan(boxAfter.w)
      expect(afterMeasure.node, '换栏宽后仍在同一节点').toBe(before.node)
      expect(Math.abs((afterMeasure.offset ?? 99) - (before.offset ?? 0)), '换栏宽后同一节点的偏移保持 ±4px').toBeLessThanOrEqual(4)
    })
  }, 180_000)

  // ══ 6. 会话时序：滚动恢复、在途卸载、面板只读 ═════════════════════════════

  it('EPUB3：含图章节滚动后退出/重挂 → 恢复同一章与同一节点位置', async () => {
    await withHost(async (s, host) => {
      await uploadFixture(s, 'epub3-rich', '图文样本.epub')
      await s.page.waitForSelector('[data-chapter] [data-novel-node]', { timeout: 20_000 })
      await settle(1_200)
      // 滚到第二章中间（跨章 → 位置落进第 1 章）。第一跳只会撞到「第 0 章的底」——第 1 章还没预取，
      // 滚动上限由已载内容决定；等它到货再跳第二下才真的进第 1 章。
      await s.page.evaluate(() => { (document.querySelector('[data-novel-main]') as HTMLElement).scrollTop = 99999 })
      await s.page.waitForSelector('[data-chapter="1"] [data-novel-node]', { timeout: 20_000 })
      await s.page.evaluate(() => {
        const main = document.querySelector('[data-novel-main]') as HTMLElement
        const ch1 = document.querySelector('[data-chapter="1"]') as HTMLElement
        main.scrollTop += ch1.getBoundingClientRect().top - main.getBoundingClientRect().top + 30
      })
      await settle(2_600)                                  // 等防抖窗口（2s）过，进度真的落盘
      const before = await probe(s)
      const box1 = await blockBox(s, 1)
      const puts = host.progressPuts()
      expect(before.chapter, '滚过了两章，视口应在第 1 章').toBe('1')
      expect(puts.length, '滚动应已把位置落盘').toBeGreaterThan(0)
      expect(puts[puts.length - 1].chapterIndex).toBe(1)
      const savedRatio = puts[puts.length - 1].offsetRatio
      expect(savedRatio, '落到章内的位置（恒 0 就分不出「存了比例」与「只存了章号」）').toBeGreaterThan(0)
      expect(box1, '前置读数：存档章块量得到').not.toBeNull()

      await s.unmount()
      await settle(400)
      await s.mount()
      await s.page.waitForSelector('[data-chapter] [data-novel-node]', { timeout: 20_000 })
      await settle(1_200)
      const after = await probe(s)
      const box1After = await blockBox(s, 1)
      expect(after.chapter, '重挂后恢复同一章（存档章号）').toBe(before.chapter)
      expect(await loadedChapters(s), '重挂后只载入存档那一章（预取只向前，上一章不回来）。'
        + '所以恢复位量的是「章块 + 章内比例」，不是「同一个节点 id」——重挂前视口顶越过的最后一个节点'
        + '常常属于上一章尾部，它的消失不是位置漂移').toEqual([1])
      // 恢复位 = 存档比例 × 该章渲染高度（会话的 anchorTop 反函数）：这一条同时证明「章对了」与
      // 「章内比例也落回去了」——只恢复章首会差出整整一个比例（本样本约 30px），远大于容差。
      expect(box1After, '重挂后存档章块量得到').not.toBeNull()
      expect(Math.abs(box1After!.top - (-savedRatio * box1!.height)),
        '恢复位落在存档比例处（±8px：允许排版舍入）').toBeLessThanOrEqual(8)
    })
  }, 180_000)

  it('EPUB3：目录选章 + 章节响应在途卸载 → 回来仍读目标章（导航事件即时落盘）', async () => {
    await withHost(async (s, host) => {
      await uploadFixture(s, 'epub3-rich', '图文样本.epub')
      await s.page.waitForSelector('[data-chapter] [data-novel-node]', { timeout: 20_000 })
      await settle(1_000)
      const hold = host.hold({ pathIncludes: '/novel-api/chapter' })
      await openDrawer(s)
      await clickLeaf(s, '丙')
      await withTimeout(hold.arrived, 15_000, '选章后第 2 章的请求没到（该章可能已被预取，挂起注入就不会被吃）')
      // 导航事件即落盘：章还没到，存档已写第 1 章
      expect(host.progressPuts().map((p) => p.chapterIndex), '选中即落盘（不押在视口真的动过）').toContain(1)
      await s.unmount()                                     // 在途卸载（面板切走）
      await settle(300)
      hold.release()
      await settle(600)
      await s.mount()                                       // 切回来
      await s.page.waitForSelector('[data-chapter] [data-novel-node]', { timeout: 20_000 })
      await settle(1_200)
      expect((await probe(s)).chapter, '回来仍读目标章（不因在途被丢弃而退回第 0 章）').toBe('1')
      expect(await loadedChapters(s),
        '跳章窗口只留目标章（长书：它之外没有已载章；未载章不进 DOM）').toEqual([1])
    })
  }, 180_000)

  it('EPUB3：导入说明面板开合不改主进度（只读入口）', async () => {
    await withHost(async (s, host) => {
      expect(await uploadFixture(s, 'epub3-inline-svg-anchor', '内联矢量锚点样本.epub')).toBe('receipt')
      await s.page.click('button:has-text("开始阅读")')
      await s.page.waitForSelector('[data-chapter] [data-novel-node]', { timeout: 20_000 })
      await settle(900)
      await s.page.evaluate(() => { (document.querySelector('[data-novel-main]') as HTMLElement).scrollTop = 60 })
      await settle(2_600)                                   // 让位置先落一次盘
      const before = await probe(s)
      await s.page.click('button[aria-label="导入说明"]')
      await s.page.waitForSelector('[role="dialog"][aria-label="导入说明"]', { timeout: 8_000 })
      await settle(600)
      expect(await s.page.textContent('[role="dialog"][aria-label="导入说明"]'), '面板里是导入期持久化的告警（可重看）').toContain('epub-degraded-anchor')
      expect((await probe(s)).scrollTop, '开面板不动主阅读位置').toBe(before.scrollTop)
      expect(host.progressPuts(), '开面板期间一次进度写都没有（它是只读入口）').toEqual([])
      await s.page.click('[role="dialog"][aria-label="导入说明"] button:has-text("关闭")')
      await s.page.waitForSelector('[role="dialog"][aria-label="导入说明"]', { state: 'detached', timeout: 8_000 })
      await settle(600)
      expect((await probe(s)).scrollTop).toBe(before.scrollTop)
      expect(host.progressPuts(), '关面板同样不写进度').toEqual([])
    })
  }, 180_000)

  // ══ 7. EPUB2 与降级 ═══════════════════════════════════════════════════════

  it('EPUB2：NCX 三叶（嵌套父节点自带目标）→ 真锚点落位；封面真解码', async () => {
    // 这一本整篇只占长屏的不到一屏（两个短章）——视口压到 420px 高，滚动才真的会发生，
    // 「锚点落在视口顶」这条才有可测量的依据（否则滚动被 clamp，落位无从谈起）。
    await withHost(async (s, host) => {
      expect(await uploadFixture(s, 'epub2-basic', 'NCX 样本.epub')).toBe('reader')
      await s.page.waitForSelector('[data-chapter] [data-novel-node]', { timeout: 20_000 })
      await settle(900)
      expect(await s.page.evaluate(() => {
        const main = document.querySelector('[data-novel-main]') as HTMLElement
        return main.scrollHeight > main.clientHeight + 1
      }), '前置条件：这一页的正文确实超出视口（否则下面的落位断言测不出东西）').toBe(true)
      const key = await keyOf(host, 'NCX 样本')
      const nav = await navOf(host, key)
      expect(nav.chapters.map((c) => c.name)).toEqual(['第一章', '第二章'])
      expect(nav.items.map((i) => i.label)).toEqual(['上卷', '第二章'])
      expect(nav.items[0].children.map((c) => c.label)).toEqual(['第一章'])

      await openDrawer(s)
      expect(await drawerLeaves(s)).toEqual(['上卷', '第一章', '第二章'])
      await clickLeaf(s, '上卷')
      await settle(1_000)
      expect(Math.abs((await offsetOf(s, 'a0')) ?? 99), '上卷 → ch1#a 的命名锚点（EPUB2 的 `<p id="a">`）').toBeLessThanOrEqual(4)
      await openDrawer(s)
      await clickLeaf(s, '第一章')
      await settle(1_000)
      expect(Math.abs((await offsetOf(s, 'a1')) ?? 99), '嵌套 navPoint 的父目标与子目标各自落位').toBeLessThanOrEqual(4)
      await openDrawer(s)
      await clickLeaf(s, '第二章')
      await settle(1_100)
      // 末章在这个高度下够不到视口顶：整本渲高 680px、视口 420px ⇒ 可滚范围只有 260px，而第 2 章块顶
      // 在 311px 处——落位被钳住，「视口顶所在的章」按产品口径仍是第 1 章（readings 2026-09 无头 Edge）。
      // 短书里可测的口径是「目标章真的进了视野」+「导航事件立刻落盘」（这两条钳位改不掉）。
      expect(await chapterVisible(s, 1), '点第 2 章后它必须真的进入视野（落位被钳 ≠ 没跳）').toBe(true)
      expect(await s.page.$$eval('[data-chapter]', (els) => els.map((e) => e.getAttribute('data-chapter'))),
        '目标章进了 DOM').toContain('1')
      expect(host.progressPuts().map((p) => p.chapterIndex),
        '目录点击 = 导航事件，章在途 / 落位被钳都要立刻落盘').toContain(1)

      await s.page.click('button:has-text("‹ 书架")')
      await s.page.waitForSelector('[data-novel-view="shelf"] .novel-card img', { timeout: 10_000 })
      const cover = await s.page.evaluate(() => {
        const img = document.querySelector('[data-novel-view="shelf"] .novel-card img') as HTMLImageElement
        return { w: img.naturalWidth, h: img.naturalHeight }
      })
      expect(cover, 'EPUB2 的 meta name=cover 封面同样真解码').toEqual({ w: 2, h: 3 })
    }, { viewport: { width: 900, height: 420 } })
  }, 180_000)

  it('两本不同的书用同样的原始锚点名（a/b/c）互不干扰', async () => {
    // 两本的原书锚点都叫 a/b/c，且内部 ID 空间都从 a0 起——干扰与否只能看**各自跳到各自的落点**，
    // 以及正文节点的 DOM id 是否带书身份（`novel--<bookKey>--<doc>--<node>`）。
    await withHost(async (s, host) => {
      await uploadFixture(s, 'epub2-basic', 'NCX 样本.epub')
      await s.page.waitForSelector('[data-chapter] [data-novel-node]', { timeout: 20_000 })
      await settle(800)
      await s.page.click('button:has-text("‹ 书架")')
      await s.page.waitForSelector('[data-novel-view="shelf"] .novel-card', { timeout: 10_000 })
      await uploadFixture(s, 'epub3-rich', '图文样本.epub')
      await s.page.waitForSelector('[data-chapter] [data-novel-node]', { timeout: 20_000 })
      await settle(800)

      const keyA = await keyOf(host, 'NCX 样本')
      const keyB = await keyOf(host, '图文样本')
      const navB = await navOf(host, keyB)
      const anchorA = 'a0'                                                              // A 的原书 #a
      const anchorB = navB.items[0].children.find((c) => c.label === '乙')!.target!.anchorId!   // B 的原书 #b
      expect(anchorB).toBe('a2')
      expect((await navOf(host, keyA)).items[0].target!.anchorId).toBe(anchorA)

      const domIdOf = (id: string) => s.page.evaluate((nodeId) =>
        (document.querySelector(`[data-chapter] [data-novel-node="${nodeId}"]`) as HTMLElement | null)?.id ?? null, id)
      const domPrefix = (key: string): string => `novel--${key.replace(/[^\w-]+/g, '-')}--`

      // B 书：跳它自己的 #b，落点是 B 的 #b 内容（「实体 & 与 &amp; 与 A」），不是 A 的 #b
      await openDrawer(s)
      await clickLeaf(s, '乙')
      await settle(1_000)
      const atB = await probe(s)
      expect(atB.node).toBe(anchorB)
      const domB = await domIdOf(anchorB)
      expect(domB, 'DOM id 带书身份').toContain(domPrefix(keyB))
      expect(await s.page.textContent(`[data-novel-node="${anchorB}"]`)).toBe('实体 & 与 &amp; 与 A')

      // A 书：跳它自己的 #a，落点是 A 的 #a 内容（「甲」）
      await s.page.click('button:has-text("‹ 书架")')
      await s.page.waitForSelector('button[aria-label="阅读 NCX 样本"]', { timeout: 10_000 })
      await s.page.click('button[aria-label="阅读 NCX 样本"]')
      await s.page.waitForSelector('[data-chapter] [data-novel-node]', { timeout: 20_000 })
      await settle(900)
      await openDrawer(s)
      await clickLeaf(s, '上卷')
      await settle(1_000)
      const atA = await probe(s)
      expect(atA.node, 'A 书自己的 #a 锚点').toBe(anchorA)
      expect(Math.abs((await offsetOf(s, anchorA)) ?? 99)).toBeLessThanOrEqual(4)
      expect(await s.page.textContent(`[data-novel-node="${anchorA}"]`)).toBe('甲')
      const domA = await domIdOf(anchorA)
      expect(domA).toContain(domPrefix(keyA))
      expect(domA, '同一原始锚点名在两本书里得到不同的 DOM id').not.toBe(domB)
    }, { viewport: { width: 1100, height: 420 } })
  }, 240_000)

  it('EPUB3：被剥离子树里的锚点降级（导航仍可用、书不被拒），告警可重看', async () => {
    await withHost(async (s, host) => {
      expect(await uploadFixture(s, 'epub3-inline-svg-anchor', '内联矢量锚点样本.epub')).toBe('receipt')
      expect(await s.page.textContent('.novel-import-note'), '导入回执要在下手之前就说清「有东西被降级」').toContain('epub-degraded-anchor')
      await s.page.click('button:has-text("开始阅读")')
      await s.page.waitForSelector('[data-chapter] [data-novel-node]', { timeout: 20_000 })
      await settle(800)
      const nav = await navOf(host, await keyOf(host, '内联矢量锚点样本'))
      expect(nav.items.map((i) => i.label)).toEqual(['花饰', '开头'])
      expect(nav.items[0].target!.kind === 'chapter' ? nav.items[0].target!.anchorId : 'x',
        '消失的锚点降级为该文档开头（不是拒整本，也不是假装有锚点）').toBeNull()
      await openDrawer(s)
      await clickLeaf(s, '花饰')
      await settle(1_000)
      // 降级目标 = 该文档开头：本仓的「文档开头」就是滚动到该章块顶（这一本整篇只占不到一屏，
      // 滚动本来就是 0——所以这两条断言合起来说的是「点了有反应，且不是点了个寂寞」）
      const at = await probe(s)
      expect(at.chapter, '降级目标仍能跳（跳到该文档开头），而不是点了没反应').toBe('0')
      expect(at.scrollTop).toBe(0)
      expect(Math.abs((await offsetOf(s, 'a0')) ?? 99), '降级落点是该文档第一个锚点（可见在视口内）').toBeLessThanOrEqual(400)
      expect(await s.page.textContent('[data-chapter="0"]')).toContain('这张图')
      expect(await s.page.$$eval('[data-chapter] svg', (els) => els.length), '装饰性内联 SVG 被剥掉（不渲染）').toBe(0)
    })
  }, 180_000)

  it('EPUB3：外链与活动内容降级——只剩文字、没有可点链接，告警逐条可读', async () => {
    await withHost(async (s) => {
      expect(await uploadFixture(s, 'epub3-active-content', '目录样本.epub')).toBe('receipt')
      await s.page.click('button:has-text("开始阅读")')
      await s.page.waitForSelector('[data-chapter] [data-novel-node]', { timeout: 20_000 })
      await settle(800)
      const body = await s.page.evaluate(() => {
        const el = document.querySelector('[data-chapter="0"]') as HTMLElement
        return {
          text: el.textContent,
          links: el.querySelectorAll('button.novel-ref').length,
          tags: [...new Set([...el.querySelectorAll('*')].map((n) => n.tagName))].sort(),
        }
      })
      expect(body.text, '外站链只保留文字').toContain('外站链')
      expect(body.text).toContain('JS 链')
      expect(body.text).toContain('正文保留')
      expect(body.links, '四种不可跟随/书外链接都不留可点入口').toBe(0)
      for (const tag of ['SCRIPT', 'IFRAME', 'OBJECT', 'FORM', 'INPUT', 'STYLE', 'BUTTON']) {
        expect(body.tags, `${tag} 不该进正文 DOM`).not.toContain(tag)
      }
      await s.page.click('button[aria-label="导入说明"]')
      await s.page.waitForSelector('[role="dialog"][aria-label="导入说明"]', { timeout: 8_000 })
      const notes = await s.page.textContent('[role="dialog"][aria-label="导入说明"]')
      expect(notes).toContain('epub-external-link')
      expect(notes).toContain('epub-link-not-followable')
      expect(notes).toContain('epub-removed-active-content')
      expect(notes).toContain('https://example.invalid/page')
    })
  }, 180_000)

  // ══ 8. TXT 与在线书不回归 ════════════════════════════════════════════════

  it('TXT：GBK 字节经真导入链进浏览器，章名与正文按解码结果渲染', async () => {
    await withHost(async (s, host) => {
      const gbk = iconv.encode('第1章 夜航\n夜里挑灯看剑\n第二段正文', 'gbk')
      expect(await uploadBytes(s, gbk, 'gbk书.TXT', 'text/plain')).toBe('reader')
      await s.page.waitForSelector('[data-chapter="0"] p', { timeout: 20_000 })
      await settle(700)
      // TXT 的「第1章」那行是章名（进目录与 h2），正文是它之后的行
      expect(await s.page.textContent('[data-chapter="0"] h2')).toBe('第1章 夜航')
      expect(await s.page.$$eval('[data-chapter="0"] p', (els) => els.map((e) => e.textContent)))
        .toEqual(['夜里挑灯看剑', '第二段正文'])
      expect(await s.page.$$eval('[data-novel-view="reader"] button', (els) => els.map((e) => e.textContent)),
        'TXT 无插图，不该出现导入说明入口').not.toContain('导入说明')
      const entry = (await shelf(host))[0]
      expect(entry.title).toBe('gbk书')
      expect(entry.totalChapters).toBe(1)
    })
  }, 180_000)

  it('在线书：缺 totalChapters 的旧存档能恢复阅读位置，并幂等回写总章数', async () => {
    await withHost(async (s, host) => {
      // 旧存档：只有 progress，没有 totalChapters（早期落盘的条目就是这个形态）
      const sourceId = await installOnlineSource(host)
      await seedShelf(host, { sourceId, bookKey: ONLINE_BOOK.bookKey, title: ONLINE_BOOK.title, progress: { chapterIndex: 2, offsetRatio: 0 } })
      await s.reload()
      await s.page.waitForSelector('button[aria-label="阅读 在线样本"]', { timeout: 15_000 })
      await s.page.click('button[aria-label="阅读 在线样本"]')
      await s.page.waitForSelector('[data-chapter="2"] p', { timeout: 20_000 })
      await settle(1_200)
      // 阅读位置 = 存档章（只有被读的那一章进 DOM：未载章不渲染）
      expect(await s.page.textContent('[data-chapter="2"]'), '恢复到存档章（第 3 章）而不是从头').toContain(ONLINE_CHAPTERS[2])
      expect(await s.page.textContent('[data-chapter="2"]')).toContain('假站点的第 3 章正文第一段')
      // 「不从头」的硬证据 = 载入集**从存档章起**（第 0 章不在 DOM 里）。
      // 但不能要求「只有一章在 DOM」：在线章很短，未载边界哨兵始终落在预取区，预取会把后面几章
      // 一并联进来（自限到书末）；可测的不变量是「已载章按书序连续、无空洞」。
      const loaded = await loadedChapters(s)
      expect(loaded[0], '恢复后从存档章（第 3 章）开始载入，第 0 章不回来').toBe(2)
      expect(loaded, '已载章按书序连续（正文渲染顺序 = 书的顺序）').toEqual(loaded.map((_, k) => loaded[0] + k))
      expect(await currentPct(s), '会话的阅读位置就在存档章（--novel-pct = (章号+1)/章数）')
        .toBe(String((2 + 1) / ONLINE_CHAPTERS.length))
      const patch = host.requests.find((r) => r.method === 'PUT' && r.path.includes('/novel-api/shelf/') && (r.body ?? '').includes('totalChapters'))
      expect(patch, '缺 totalChapters 时应回写总章数（幂等补数据）').toBeDefined()
      expect(JSON.parse(patch!.body!) as unknown).toEqual({ patch: { totalChapters: 4 } })
      expect(host.refusedOutbound, '全程不许有出站尝试（假源之外的 URL 一律被拒才看得见）').toEqual([])
      expect(host.servedOutbound.length, '假站点确实被抓过（否则上面读的正文不知从哪来）').toBeGreaterThan(0)
      expect([...new Set(host.servedOutbound.map((u) => new URL(u).host))]).toEqual(['novel-browser.invalid'])
    })
  }, 180_000)

  it('在线书：假源确定性内容在浏览器里照读（目录 → 正文 → 进度写入），不碰第三方站点', async () => {
    await withHost(async (s, host) => {
      const sourceId = await installOnlineSource(host)
      await seedShelf(host, { sourceId, bookKey: ONLINE_BOOK.bookKey, title: ONLINE_BOOK.title, totalChapters: ONLINE_CHAPTERS.length })
      await s.reload()
      await s.page.waitForSelector('button[aria-label="阅读 在线样本"]', { timeout: 15_000 })
      await s.page.click('button[aria-label="阅读 在线样本"]')
      await s.page.waitForSelector('[data-chapter] p', { timeout: 20_000 })
      await settle(1_000)
      expect(await s.page.textContent('.novel-rdr-title')).toContain(`共 ${ONLINE_CHAPTERS.length} 章`)
      await openDrawer(s)
      expect(await drawerLeaves(s)).toEqual([...ONLINE_CHAPTERS])
      await clickLeaf(s, ONLINE_CHAPTERS[1])
      await settle(1_300)
      // 在线章很短：滚动会被 clamp，所以这里量「目标章进了 DOM 且在视口内可见」，
      // 「锚点落在视口顶 ±4px」那条归有长内容的 epub3 用例（那里滚动有余量）
      expect(await s.page.textContent('[data-chapter="1"]')).toContain(ONLINE_CHAPTERS[1])
      expect(await s.page.textContent('[data-chapter="1"]')).toContain('假站点的第 2 章正文第一段')
      const loadedOnline = await loadedChapters(s)
      expect(loadedOnline, '目标章进了 DOM').toContain(1)
      expect(loadedOnline, '已载章按书序连续（无空洞）').toEqual(loadedOnline.map((_, k) => loadedOnline[0] + k))
      expect(await currentPct(s), '会话的阅读位置就是第 2 章').toBe(String((1 + 1) / ONLINE_CHAPTERS.length))
      expect(await s.page.evaluate(() => {
        const main = document.querySelector('[data-novel-main]') as HTMLElement
        const r = (document.querySelector('[data-chapter="1"]') as HTMLElement).getBoundingClientRect()
        return r.top < main.getBoundingClientRect().bottom && r.bottom > main.getBoundingClientRect().top
      }), '目标章在视口内可见').toBe(true)
      expect(host.progressPuts().at(-1)!.chapterIndex).toBe(1)
      expect(host.refusedOutbound).toEqual([])
      expect([...new Set(host.servedOutbound.map((u) => new URL(u).host))]).toEqual(['novel-browser.invalid'])
    })
  }, 180_000)

  // ══ 9. 只读浮层不改写主阅读位置（开面板 / 开抽屉不是导航事件）════════════

  /**
   * 打开目录抽屉**不得**移动主阅读位置，也不得因此多落一笔进度。
   *
   * 这条钉子原先是「诚实红」——它对着一处实测缺陷写：开抽屉的 effect 对当前项调
   * `scrollIntoView({ block: 'center' })`，抽屉本体装得下内容 ⇒ 浏览器接着去居中**下一个能滚的祖先**
   * `.novel-main`，实测 scrollTop 216 → 0 并把章号改写成第 0 章。修法是落位只滚抽屉自己
   * （口径与理由见 `src/client/util.ts` 的 `centerInScroller`）。jsdom 侧只能钉 API 选择
   * （tests/client/ui-system.test.tsx 那条），几何与「有没有多落盘」只有真浏览器量得到。
   */
  it('打开目录抽屉不改写主阅读位置，也不产生进度落盘', async () => {
    await withHost(async (s, host) => {
      await uploadFixture(s, 'epub3-rich', '图文样本.epub')
      await s.page.waitForSelector('[data-chapter] [data-novel-node]', { timeout: 20_000 })
      await settle(1_200)
      await s.page.evaluate(() => { (document.querySelector('[data-novel-main]') as HTMLElement).scrollTop = 216 })
      await settle(2_600)                                   // 让这个位置先落一次盘
      const before = await probe(s)
      expect(before.scrollTop, '前置条件：滚动位置非零（否则这条断言什么都没证明）').toBeGreaterThan(100)
      host.clearRequests()                                  // 下面两条只量「开抽屉这一段时间」的流量

      await openDrawer(s)
      await settle(2_600)                                   // 等视口读数与防抖落盘都跑过
      const after = await probe(s)
      const detail = `开抽屉前 scrollTop=${before.scrollTop} → 开抽屉后 scrollTop=${after.scrollTop}；`
        + `新落盘的章号 ${JSON.stringify(host.progressPuts().map((p) => p.chapterIndex))}`

      expect(after.scrollTop, `打开目录本身不该移动阅读位置。${detail}`).toBe(before.scrollTop)
      expect(host.progressPuts().map((p) => p.chapterIndex), `开抽屉不该产生新的位置落盘。${detail}`).toEqual([])
    })
  }, 180_000)

  /**
   * 注释面板是**视口浮层**：打开它不动主阅读位置，主序列往下滚时它留在视口里。
   *
   * 这条原先也对着实测缺陷写（诚实红）：`.novel-notes` 曾 absolute 挂在 `.novel-rdr-main`（正文
   * **内容盒**）上，内容盒一滚面板就跟着走 —— 读到章末开面板，实测 scrollTop 2016 → 0，
   * 面板还飘到视口上方。两处修法：与目录抽屉**共用同一条槽几何**（styles 的
   * `.novel-drawer-slot, .novel-notes-slot`，锚视口的 sticky 槽），落位走 `centerInScroller`
   * （只滚面板自己的身体）。同族浮层并存两套锚定就是这条缺陷的根子，防漂移的钉子在
   * tests/client/ui-system.test.tsx。
   */
  it('注释面板按视口定位：开面板不动主阅读位置，主序列滚动后它仍留在视口里', async () => {
    await withHost(async (s, host) => {
      await uploadFixture(s, 'epub3-rich', '图文样本.epub')
      await s.page.waitForSelector('[data-chapter] [data-novel-node]', { timeout: 20_000 })
      await settle(1_200)
      const ch0 = await chapterOf(host, await keyOf(host, '图文样本'), 0)
      const noteref = topLevel(ch0)
        .flatMap((n) => (n.kind === 'element' ? n.children : [n]))
        .find((n) => n.kind === 'link' && n.role === 'noteref')
      if (noteref === undefined || noteref.kind !== 'link') throw new Error('第一章应有脚注引用')

      await s.page.evaluate((id) => document.querySelector(`[data-novel-node="${id}"]`)?.scrollIntoView({ block: 'center' }), noteref.id)
      await settle(2_600)
      const before = await probe(s)
      expect(before.scrollTop, '前置条件：读到章末（面板该出现在视口里，而不是内容顶部）').toBeGreaterThan(400)

      await s.page.click(`[data-novel-node="${noteref.id}"]`)
      await s.page.waitForSelector('[role="dialog"][aria-label="注释"]', { timeout: 10_000 })
      await settle(900)
      const after = await probe(s)
      const panelTop = await s.page.evaluate(() => {
        const main = document.querySelector('[data-novel-main]') as HTMLElement
        const panel = document.querySelector('[role="dialog"][aria-label="注释"]') as HTMLElement
        return Math.round(panel.getBoundingClientRect().top - main.getBoundingClientRect().top)
      })
      const detail = `开面板前 scrollTop=${before.scrollTop} → 开面板后 scrollTop=${after.scrollTop}；面板相对视口顶 top=${panelTop}px`
      expect(after.scrollTop, `打开脚注面板不该移动主阅读位置。${detail}`).toBe(before.scrollTop)

      // 面板开着往下滚：视口锚定的浮层应留在视口里
      await s.page.evaluate((to) => { (document.querySelector('[data-novel-main]') as HTMLElement).scrollTop = to }, before.scrollTop + 200)
      await settle(500)
      const drifted = await s.page.evaluate(() => {
        const main = document.querySelector('[data-novel-main]') as HTMLElement
        const panel = document.querySelector('[role="dialog"][aria-label="注释"]') as HTMLElement
        return Math.round(panel.getBoundingClientRect().top - main.getBoundingClientRect().top)
      })
      expect(drifted, `面板是视口浮层：主序列滚动后它仍该留在视口里（现在相对视口顶 ${drifted}px）。${detail}`)
        .toBeGreaterThan(0)
    })
  }, 180_000)
})
