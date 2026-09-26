// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NOVEL_CSS } from '../../src/client/styles.js'
import { CTRL_Z, ReaderView } from '../../src/client/views/ReaderView.js'
import { ShelfView } from '../../src/client/views/ShelfView.js'
import { SearchView } from '../../src/client/views/SearchView.js'
import { routeStore } from '../../src/client/store.js'
import { planarNavigation } from '../../src/shared/wire.js'
import { makeCoreDeps, makeReaderDeps } from './fake-deps.js'
import { rect, stubLayout } from './scroll-stub.js'

/**
 * UI 系统守卫：呈现层的不变量（token 自足 / 标度 / 焦点与键盘可达 / 布局单位）。
 *
 * 病根（本轮实测）：`.novel-searchbox` 引用了 `var(--novel-layer)`，而 token 层只定义
 * `--novel-layer-1/2/3`。CSS 自定义属性「引用未定义」不是忽略这一行，而是让整个
 * `background` 简写落到 unset → 实测计算值 `rgba(0, 0, 0, 0)`（同页引用 `--novel-layer-2`
 * 的对照元素是 `rgb(36, 36, 38)`）。这与 `--dsw-alias-border-l` 那次同罪，但既有
 * `theme-tokens.test.ts` 的词表守卫只扫 `--dsw-*`（宿主名），**不扫本插件自己的 `--novel-*` 层**
 * ——所以测试全绿、界面静默裸奔。本文件的第一条就是补这个洞。
 */

/** jsdom 环境下 import.meta.url 不是 file 协议（theme-tokens 跑在 node 环境才用得动 URL）——
 *  本文件的源码扫描按 cwd 定位（vitest 的工作目录恒为仓库根）。 */
const clientDir = path.join(process.cwd(), 'src', 'client')
const viewSource = (name: string): string => readFileSync(path.join(clientDir, 'views', name), 'utf8')

function clientSources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(entry.name)) out.push({ file: path.relative(clientDir, p), text: readFileSync(p, 'utf8') })
    }
  }
  walk(clientDir)
  return out
}

/** 取出某条规则声明块内的文本：`/\.-?类名\s*\{([^}]*)\}/` */
function ruleBody(selector: string): string {
  // 逐条规则取体，**逗号选择器组里的每一条都算命中**——同一份几何给两块浮层共用是惯用写法，
  // 守卫不该逼着把它抄成两条（抄两份才会漂移，且本仓的纪律是「唯一实现」）。
  // 先剥注释再切：样式注释里写着 `style={{background}}` 这类带花括号的字面量，不剥就把规则切断。
  const wanted = selector.trim()
  const re = /([^{}]+)\{([^{}]*)\}/g
  const css = strip(NOVEL_CSS)
  for (let m = re.exec(css); m !== null; m = re.exec(css)) {
    if (m[1].split(',').some((s) => s.trim() === wanted)) return m[2]
  }
  return ''
}

/** 剥掉注释再扫：守卫管的是**声明**，不是文档。本文件与 styles.tsx 的注释里
 *  大量出现「曾经的假 token 名」（那正是文档的价值所在），照扫即误报。 */
function strip(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** vitest 未开 globals ⇒ RTL 的自动 cleanup 不注册（同目录别的文件都显式挂了这一行）。
 *  本文件此前漏了，于是上一个用例的 DOM 一直留在 body 里，`screen.*` 能命中别人的元素：
 *  「命中行是可聚焦按钮」那条实际读到的是**书架卡片**（搜索命中的断言从未成立，假绿）。 */
afterEach(cleanup)

describe('token 层自足守卫（引用未定义的本层 token 即红）', () => {
  it('NOVEL_CSS 与视图里每个 var(--novel-*) 都在 token 层有定义', () => {
    const defined = new Set<string>()
    for (const m of NOVEL_CSS.matchAll(/(--novel-[\w-]+)\s*:/g)) defined.add(m[1])
    const bad: string[] = []
    for (const m of strip(NOVEL_CSS).matchAll(/var\(\s*(--novel-[\w-]+)/g)) {
      if (!defined.has(m[1])) bad.push(`styles.tsx: ${m[1]}`)
    }
    for (const { file, text } of clientSources()) {
      if (file === 'styles.tsx') continue
      for (const m of strip(text).matchAll(/var\(\s*(--novel-[\w-]+)/g)) {
        if (!defined.has(m[1])) bad.push(`${file}: ${m[1]}`)
      }
    }
    expect(bad, `引用了本层不存在的 token（background 等简写会整条落 unset，实测＝静默无底）：\n${bad.join('\n')}`).toEqual([])
  })

  it('负断言：守卫自身别空转——假 token 引用必须被抓出来', () => {
    const defined = new Set<string>()
    for (const m of NOVEL_CSS.matchAll(/(--novel-[\w-]+)\s*:/g)) defined.add(m[1])
    expect(defined.has('--novel-layer')).toBe(false)               // 本轮病根：无裸 --novel-layer
    expect(defined.has('--novel-layer-2')).toBe(true)
    expect(NOVEL_CSS).toMatch(/\.novel-searchbox\s*\{[^}]*background:\s*var\(--novel-layer-[12]\)/)
  })
})

describe('z 序单表（控制器层 CTRL_Z 与样式层浮层不再各写各的数）', () => {
  const z = (name: string): number => {
    const m = NOVEL_CSS.match(new RegExp(`--novel-z-${name}\\s*:\\s*(\\d+)`))
    return m === null ? NaN : Number(m[1])
  }

  it('样式层定义 status/modal 两级且是整数', () => {
    expect(Number.isInteger(z('status'))).toBe(true)
    expect(Number.isInteger(z('modal'))).toBe(true)
  })

  it('全序：状态条 < 控制器遮罩 < 面板 < 工具栏 < 模态', () => {
    expect(z('status')).toBeLessThan(CTRL_Z.mask)
    expect(CTRL_Z.mask).toBeLessThan(CTRL_Z.panel)
    expect(CTRL_Z.panel).toBeLessThan(CTRL_Z.toolbar)
    expect(z('toolbar')).toBe(CTRL_Z.toolbar)
    expect(z('panel')).toBe(CTRL_Z.panel)
    expect(z('mask')).toBe(CTRL_Z.mask)
    expect(z('modal')).toBeGreaterThan(CTRL_Z.toolbar)
  })

  it('视图不得写裸 z-index 数字（z 只从 CTRL_Z 或 --novel-z-* 出）', () => {
    const bad: string[] = []
    for (const { file, text } of clientSources()) {
      if (file === 'styles.tsx') continue                        // z 值的唯一住址就是样式层的 --novel-z-* 表
      const code = strip(text)
      for (const m of code.matchAll(/zIndex:\s*(\d+)/g)) bad.push(`${file}: zIndex:${m[1]}`)
      for (const m of code.matchAll(/z-index:\s*(\d+)/g)) bad.push(`${file}: z-index:${m[1]}`)
    }
    expect(bad, `视图里出现裸 z 值（绕过标度表）：\n${bad.join('\n')}`).toEqual([])
  })
})

describe('布局单位与视口约束（阅读器不能被正文高度绑架）', () => {
  it('正文栏宽随字号走：值槽 --novel-measure 以 em 计，不再钉死像素列', () => {
    const body = ruleBody('.novel-rdr-body')
    expect(body, '.novel-rdr-body 的 max-width 必须走 --novel-measure').toMatch(/max-width:\s*var\(--novel-measure\)/)
    expect(NOVEL_CSS, '值槽要有 em 缺省（随字号缩放），且必须在词表里在册').toMatch(/--novel-measure:\s*\d+(\.\d+)?em/)
    expect(strip(NOVEL_CSS), '旧的固定 640px 列').not.toContain('calc(50%')
  })

  it('纸张色涂在阅读区，不涂在正文列上（full-bleed：窄带飘在宿主底色里 = 纸没铺开）', () => {
    expect(ruleBody('.novel-rdr-body')).not.toMatch(/(^|;)\s*background:/)
    expect(ruleBody('.novel-rdr')).toMatch(/min-height:\s*100vh/)   // 正文短于一屏时也不许下面漏底
  })

  it('内容列上限按场景分：画廊 fill、文字列表留可读行长', () => {
    const shelf = ruleBody('[data-novel-view="shelf"] .novel-wrap')
    const search = ruleBody('[data-novel-view="search"] .novel-wrap')
    const px = (s: string): number => Number(/--novel-wrap-max:\s*(\d+)px/.exec(s)?.[1] ?? 0)
    expect(px(shelf), '书架是缩略图画廊，900px 会把宽屏两侧各留两百多 px 空').toBeGreaterThanOrEqual(1600)
    expect(px(search), '搜索命中行是文字列表，铺满会成 100+ 字的扫读带').toBeGreaterThanOrEqual(1100)
    expect(px(search)).toBeLessThan(px(shelf))
  })

  it('目录抽屉锚视口不锚正文，且不切走正文宽度', () => {
    const slot = ruleBody('.novel-drawer-slot')
    const drawer = ruleBody('.novel-drawer')
    expect(slot, '跟随视口靠槽的 sticky（工具栏已证明本环境 sticky 可用）').toMatch(/position:\s*sticky/)
    expect(slot, '槽宽 0：有宽度的兄弟会从正文列里切走一整栏').toMatch(/width:\s*0/)
    expect(slot).toMatch(/align-self:\s*flex-start/)
    expect(drawer).toMatch(/position:\s*absolute/)
    expect(drawer, '无 100vh 上限时抽屉高度由正文高决定，锚到正文开头').toMatch(/max-height:\s*calc\(\s*100vh/)
  })

  it('注释面板与目录抽屉共用同一份槽几何（各抄一份 sticky 规则必漂移）', () => {
    // 缺陷的根子是两块同族浮层走了两套不同的锚定（抽屉锚视口、面板锚内容盒）。
    // 修好之后本体各自的规则仍管自己的尺寸，但**槽**必须共用同一条。
    expect(ruleBody('.novel-notes-slot')).not.toBe('')
    expect(ruleBody('.novel-notes-slot')).toBe(ruleBody('.novel-drawer-slot'))
  })

  it('抽屉条目拒绝 flex 收缩（可滚动 flex 列里，滚动发生前条目会先被压扁）', () => {
    // 真实回归：给抽屉加视口上限后，60 条目录各被压到 12px 高、文字互相咬住
    expect(ruleBody('.novel-drawer-item')).toMatch(/flex:\s*none/)
  })

  it('窄列不溢出：书架头可折行，搜索框独行且弹性宽', () => {
    expect(ruleBody('.novel-shelf-head')).toMatch(/flex-wrap:\s*wrap/)
    expect(ruleBody('.novel-shelf-title')).toMatch(/white-space:\s*nowrap/)   // 实测 380px 下标题被压成一个字一行
    expect(ruleBody('.novel-search-bar')).toMatch(/flex-wrap:\s*wrap/)
    // 搜索框单独一行（IA：聚合搜索是找新书入口，不与书架筛选同簇）——独占行靠 flex-basis 100%，
    // 旧「与标题同行」结构被 Chrome 算成 min-content 假设主尺寸，簇内折行（探针实测 706→651、215）
    expect(ruleBody('.novel-shelf-search')).toMatch(/flex:\s*1 1 100%/)
    expect(ruleBody('.novel-shelf-filter'), '筛选簇独立成行').toMatch(/flex:\s*1 1 100%/)
    const box = ruleBody('.novel-shelf-search form')
    expect(box, '搜索框要有基准宽且可收缩（宿主会话列可拖窄）').toMatch(/flex:\s*0 1 \d+px/)
    expect(box).not.toMatch(/(^|;)\s*width:\s*\d+px/)
  })

  it('横向溢出守卫：box-sizing reset 圈住插件两棵树（content-box 下 .novel-wrap 外廓恒超容器 → 窄列底部横滚条；探针实测 vp=970 main sw=1002）', () => {
    expect(NOVEL_CSS, '缺 .novel-root 侧 border-box reset——窄列横向滚动条会复发（用户真机反馈的「书架宽度」问题根因）')
      .toMatch(/\.novel-root[^{]*\{[^}]*box-sizing:\s*border-box/)
    expect(strip(NOVEL_CSS), '缺 [data-novel-scope] 侧 reset（书源管理区块同树，设壳自足性口径）')
      .toMatch(/\[data-novel-scope\][^{]*\{[^}]*box-sizing:\s*border-box/)
  })

  it('源列表操作列定宽右锚：.novel-tr.src 第5轨 148px（auto 轨让右缘按钮组随状态漂移——用户实机反馈「没对齐」）', () => {
    expect(ruleBody('.novel-tr.src'), '操作列轨道必须定宽（148px）').toMatch(/148px/)
  })

  it('状态带：容器查询退化在位（窄列掉 .slim 留「共 N · 已启用 M」），但整条带子不许被隐藏', () => {
    // 状态带是读数的唯一住址（2026-09：待办卡可忽略之后读数不能跟着提示一起消失）——
    // 窄列只能牺牲 .slim 那几项，把它们全隐了等于把整块台账抹掉。
    expect(ruleBody('.novel-list-head'), '列表头必须是容器查询锚（量自身宽度，会话列可拖——与 .novel-table 收地址列同一理由）')
      .toMatch(/container-type:\s*inline-size/)
    const degrade = strip(NOVEL_CSS).match(/@container[^{]*\{\s*\.novel-src-stats \.slim\s*\{([^}]*)\}/)
    expect(degrade, '缺窄列退化规则（.novel-src-stats .slim）').not.toBeNull()
    expect(degrade![1], '退化=隐藏 .slim 那几项').toMatch(/display:\s*none/)
    expect(ruleBody('.novel-src-stats'), '状态带本体不能被整体隐藏/绝对定位（读数必须常驻列表头）')
      .not.toMatch(/display:\s*none|position:\s*absolute/)
  })

  it('书源管理：待办箱 = auto-fit 任务卡网格（长条在宽列下是悬浮碎片）；⋯菜单是浮层；导入弹层宽档', () => {
    const grid = ruleBody('.novel-inbox-grid')
    expect(grid, '待办必须是 auto-fit 卡片网格——横跨整列的长条在 1600px 内容列下中间空、动作钮孤悬列尾（用户实机反馈）')
      .toMatch(/grid-template-columns:\s*repeat\(auto-fit/)
    expect(ruleBody('.novel-todo-card'), '任务卡自包含（读数 + 名单 + 处置动作）').toMatch(/display:\s*flex/)
    expect(ruleBody('.novel-menu'), '行内「⋯」菜单是浮层（锚点 .novel-actions position:relative）').toMatch(/position:\s*absolute/)
    expect(ruleBody('.novel-modal.wide'), '导入弹层用宽档（删除确认保持 400px 紧凑档）').toMatch(/width:\s*min\(680px/)
  })

  it('书架筛选簇不贴右；顶部 tab 导航在场且有激活态（IA：书架|书城|书源管理 并列）', () => {
    // 病史：排序灰字 margin-left:auto 在 1600px 内容列里被钉到最右端（实测 x1472 vs pills x75）＝悬浮碎片；
    // 书城预留位 chip 已随 tab 化退役——占位不如真导航（书城未上线点开是 CityView 占位空态）
    expect(ruleBody('.novel-shelf-sort'), '排序灰字跟簇尾，不许贴列右端').not.toMatch(/margin-left:\s*auto/)
    expect(ruleBody('.novel-shelf-filter'), '筛选簇整簇左聚簇').not.toMatch(/margin-left:\s*auto/)
    const tabs = ruleBody('.novel-tabs')
    expect(tabs, 'tab 导航是 IA 骨架（书架/书城/书源管理 并列，选择即切换下方内容）').toMatch(/display:\s*flex/)
    expect(ruleBody('.novel-tabs button.on'), '激活 tab 要有可见态（brand 弱底 + 强调字）').not.toBe('')
  })
})

describe('焦点与指针无关可达（键盘/触屏不再是二等公民）', () => {
  it('交互件各有 :focus-visible 规则', () => {
    const focusRules = [...NOVEL_CSS.matchAll(/[^{}]*:focus-visible[^{]*\{[^}]*\}/g)].map((m) => m[0]).join('\n')
    for (const sel of ['.novel-card', '.novel-chip', '.novel-drawer-item', '.novel-input', '.novel-seg button', '.novel-tabs button', '.novel-menu button', '.novel-switch']) {
      expect(focusRules, `缺 ${sel} 的焦点环`).toContain(sel)
    }
  })

  it('触屏兜底：无 hover 能力时删除 ✕ 常驻可见', () => {
    const m = NOVEL_CSS.match(/@media\s*\(hover:\s*none\)\s*\{([\s\S]*?)\}\s*\n/)
    expect(m, '缺 @media (hover: none) 分支').not.toBeNull()
    expect(m![1]).toMatch(/\.novel-card-x[^{]*\{[^}]*opacity:\s*1/)
  })

  it('动效可关：prefers-reduced-motion 下取消位移与 shimmer', () => {
    expect(NOVEL_CSS).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
  })
})

describe('进度动画不吃布局', () => {
  it('进度段用 transform: scaleX 而非 width（书架几十张卡同时在途时不触发布局）', () => {
    const bar = ruleBody('.novel-progress > i')
    expect(bar).toMatch(/transform:\s*scaleX/)
    expect(bar).toMatch(/transform-origin:\s*left/)
    expect(bar).not.toMatch(/(^|;)\s*width:\s*0/)
    const bits = viewSource('bits.tsx')
    expect(bits, 'bits 里不该再写行内 width').not.toMatch(/width:\s*`\$\{/)
  })
})

describe('呈现层的单点（两处抄同一串东西必漂移）', () => {
  it('源列表列宽住在样式层，视图不再携带列字面量', () => {
    expect(ruleBody('.novel-tr.src')).toMatch(/grid-template-columns:/)
    const src = viewSource('SettingsSourceList.tsx')
    expect(src, 'gridTemplateColumns 字面量该收进样式类').not.toContain('minmax(130px')
  })

  it('告警清单的标记只住 bits.tsx（两处各抄一份 JSX 必漂移）', () => {
    // CSS（.novel-warn-list / -code）原先就是共享的，**标记**却是两份：
    // 阅读器的导入说明面板与书架的导入回执各写一遍一条告警长什么样。
    for (const view of ['ReaderView.tsx', 'ShelfView.tsx']) {
      expect(viewSource(view), `${view} 里又出现一份告警清单的 JSX——改一条口径必漏另一处`).not.toContain('novel-warn-list')
    }
    expect(viewSource('bits.tsx')).toContain('novel-warn-list')
  })
})

describe('目录抽屉：当前章可见 + 打开即定位到当前章', () => {
  const toc = Array.from({ length: 5 }, (_, i) => ({ name: `第 ${i + 1} 章`, url: `u${i}` }))

  it('抽屉里恰有一条 aria-current（样式与语义同一个源）', async () => {
    routeStore.set({ route: { name: 'reader', sourceId: 's1', bookKey: 'k1', title: 'T' } as never })
    const deps = makeReaderDeps({
      apiGet: vi.fn(async (p: string) => {
        if (String(p).includes('navigation')) return { chapters: toc, items: planarNavigation(toc) }
        if (String(p).includes('chapter')) return { kind: 'text', text: '正文段落' }
        return []
      }),
    })
    const { container } = render(createElement(ReaderView, { sourceId: 's1', bookKey: 'k1', title: 'T', deps }))
    fireEvent.click(screen.getByRole('button', { name: '目录' }))
    const cur = await waitFor(() => {
      const el = container.querySelector('.novel-drawer-item[aria-current="true"]')
      expect(el).not.toBeNull()
      return el as Element
    })
    expect(container.querySelectorAll('.novel-drawer-item[aria-current="true"]')).toHaveLength(1)
    expect(cur.closest('.novel-drawer')).not.toBeNull()
  })

  it('开抽屉只滚抽屉自己：按当前项几何定位，绝不借 scrollIntoView 滚到祖先', async () => {
    // 几何由本用例给出（jsdom 无排版）：抽屉容器视口 0..400、当前项中心 910 → 该滚 710。
    // 「开抽屉不得改写主阅读位置并落盘」的端到端判据在 tests/browser/epub-reader.test.ts；
    // 这里钉的是组件用的是哪一个 API——scrollIntoView 一旦被叫，可滚祖先就跑不掉。
    const stub = stubLayout((el) => el.classList.contains('novel-drawer') ? rect(0, 400)
      : el.matches('.novel-drawer-item[aria-current="true"]') ? rect(900, 20) : null)
    try {
      routeStore.set({ route: { name: 'reader', sourceId: 's1', bookKey: 'k1', title: 'T' } as never })
      const deps = makeReaderDeps({
        apiGet: vi.fn(async (p: string) => {
          if (String(p).includes('navigation')) return { chapters: toc, items: planarNavigation(toc) }
          if (String(p).includes('chapter')) return { kind: 'text', text: '正文段落' }
          return []
        }),
      })
      const { container } = render(createElement(ReaderView, { sourceId: 's1', bookKey: 'k1', title: 'T', deps }))
      fireEvent.click(screen.getByRole('button', { name: '目录' }))
      await waitFor(() => expect(container.querySelector('.novel-drawer-item[aria-current="true"]')).not.toBeNull())
      await waitFor(() => expect(stub.scrolls.map((w) => [w.el.className, w.to])).toEqual([['novel-drawer', 710]]))
      expect(stub.into).toEqual([])
    } finally {
      stub.restore()
    }
  })
})

describe('键盘可达的承载元素（主操作不许只绑鼠标）', () => {
  afterEach(() => { routeStore.set({ route: { name: 'shelf' } as never }) })

  const book = {
    bookKey: 'k1', sourceId: 's1', title: '斗罗', addedAt: 1, totalChapters: 100,
    progress: { chapterIndex: 3, offsetRatio: 0.5, updatedAt: 1 },
  }

  it('书架卡片是可聚焦按钮，删除钮不再是按钮里的按钮', async () => {
    routeStore.set({ route: { name: 'shelf' } as never })
    const deps = makeCoreDeps({ apiGet: vi.fn(async () => [book]) })
    const { container } = render(createElement(ShelfView, { deps }))
    await waitFor(() => expect(screen.getByText('斗罗')).toBeTruthy())
    // 卡片钮的无障碍名是显式 aria-label「阅读 X」：不写的话名字 = 格内文字拼接
    // （「斗斗罗721/1162 章 · 62%」——首字色块那个字也在内），读屏念一遍等于自找噪声
    expect(screen.getByRole('button', { name: '阅读 斗罗' })).toBeTruthy()
    expect(container.querySelectorAll('button [role="button"], button button'),
      '嵌套可交互元素：读屏念成「按钮 内含 按钮」').toHaveLength(0)
    expect(container.querySelectorAll('[role="button"]'),
      'div[role=button] 只绑 onClick = 键盘不可达').toHaveLength(0)
  })

  it('命中行是可聚焦按钮，「＋ 加书架」是兄弟而非后代', async () => {
    const group = {
      sourceId: 's1', sourceName: 'S', status: 'verified',
      hits: [{ title: '斗罗', author: null, url: 'https://s.com/b/1', coverUrl: null, intro: null, lastChapterName: null, kind: null, wordCount: null }],
    }
    let reads = 0
    const deps = makeCoreDeps({
      apiGet: vi.fn(async () => ({
        job: ++reads === 1 ? null : {
          id: 'j1', keyword: '斗罗', phase: 'done', total: 1, done: 1, added: [group], next: 1, startedAt: 0,
        },
      })),
      apiSend: vi.fn(async () => ({ jobId: 'j1' })),
    })
    routeStore.set({ route: { name: 'search', keyword: '斗罗' } as never })   // 带关键词挂载即提交一轮后台任务
    const { container } = render(createElement(SearchView, { deps }))
    await waitFor(() => expect(screen.getByText('斗罗')).toBeTruthy())
    expect(deps.apiSend).toHaveBeenCalledWith('POST', 'search/job', { keyword: '斗罗' })
    const hit = screen.getByText('斗罗').closest('button')
    expect(hit, '命中行标题该落在真 <button> 里').not.toBeNull()
    expect(hit!.querySelectorAll('button'), '按钮里不套按钮').toHaveLength(0)
    expect(container.querySelectorAll('[role="button"]')).toHaveLength(0)
  })
})
