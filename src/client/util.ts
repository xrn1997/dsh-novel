/**
 * client 中立小工具：debounce 与 localStorage guard 不属于「阅读进度」也不属于「轻量 store」，
 * 单独住这里，避免找它们要靠 grep。
 */
import type { ChapterContent } from '../shared/wire.js'

/** 盯服务端在跑的作业时，回落轮询的节奏（搜索面与发现面两条观察通道共用这一个数）。
 *  为什么只此一份：600ms 是「边抓边出」的观感与「不把 `/novel-api` 打成刷屏」之间的同一档取舍，
 *  两条通道各自写一遍，改档时必然只改到其中一条——那时两面的新鲜度读数开始互相矛盾，
 *  而从界面上看不出是谁的节奏漂了。
 *  可注入：观察通道缺省用它，测试要给 `JobWatchDeps.jobPollMs` 换一档，免得干等墙钟。 */
export const JOB_POLL_MS = 600

/** 常驻状态层盯**写任务**（导入 / 批量验证）的节拍。与上面那个数**不是一种参数的两个值**：
 *  观察通道量的是「书一条条出来」的即时感，状态层量的是一条整批写任务的进度，界面只读「在跑 /
 *  跑完」两态。这个节拍必须落进常量，不要在字面量里写裸数字：改名与调档需要一个家。 */
export const STATUS_POLL_MS = 1000

/** 正文节点的 DOM 钩子（`ChapterBody` 渲染时写在每个可定位节点上）。
 *  查找一律**遍历属性比较**，绝不把节点 ID 拼进选择器：wire 的 ID 是不透明串，
 *  拼一次就等于给未净化的书内字符串开了一条进 DOM 查询的路。三处消费（章内定位 / 注释面板落位 /
 *  视口顶采点）共用下面两个函数，免得同一个钩子名与同一条纪律各写一份。 */
export const NOVEL_NODE_ATTR = 'data-novel-node'

/** root 内所有已登记节点（文档顺序）；root 缺席（未挂载）→ 空表 */
export function novelNodes(root: Element | null | undefined): Element[] {
  if (root === null || root === undefined) return []
  return [...root.querySelectorAll(`[${NOVEL_NODE_ATTR}]`)]
}

/** root 内按节点 ID 找元素：nodeId 为 null（新文档无锚点）或找不到 → null */
export function findNovelNode(root: Element | null | undefined, nodeId: string | null): Element | null {
  if (nodeId === null) return null
  for (const el of novelNodes(root)) {
    if (el.getAttribute(NOVEL_NODE_ATTR) === nodeId) return el
  }
  return null
}

/**
 * 在**给定这一个**滚动容器里把目标摆进视野——居中落位只此一个实现（抽屉、注释面板共用）：
 * 装得下就居中，装不下（目标比容器还高）就**顶对齐**。
 *
 * 为什么不用 `scrollIntoView`：那个 API 会一路向上把**每个可滚祖先**都滚到位，「打开一个只读
 * 浮层」于是改写了主阅读位置、还顺带落一笔进度。位移按两份视口盒现算，容器没有滚动范围时浏览器自己夹住；
 * 增量恰为 0 时一次写入都不发（不为「已经在中间」制造一轮 scroll 事件）。
 *
 * 顶对齐不是边角：脚注的锚点常常是一个**装着好几段的容器**，居中它等于把开头推到视口上方——
 * 内容比视口长时，「从哪儿开始读」只有顶对齐答得对。
 */
export function centerInScroller(scroller: Element, target: Element | null): void {
  if (target === null) return
  const box = scroller.getBoundingClientRect()
  const at = target.getBoundingClientRect()
  const delta = at.height > box.height
    ? at.top - box.top                                   // 目标装不下：露头，不露腹
    : (at.top + at.height / 2) - (box.top + box.height / 2)
  if (delta !== 0) scroller.scrollTop += delta
}

/**
 * 跟读自动跟随：目标已经在看得见的正文带里就**一次都不滚**；出了带才把它居中。
 *
 * 带 = 滚动容器减 `topInset`（顶条遮挡）与 `bottomInset`（听书条遮挡）。不沿用
 * `centerInScroller` 的「每段都居中」——播放推进是段粒度，逐段重定心会让读者的视野
 * 每隔几秒跳一次；只在当前段将要看不见时补一次，才读得下去。目标比带还高时仍露头
 * （与 `centerInScroller` 同一取舍）。只滚给定容器，不借 `scrollIntoView`。
 */
export function revealInScroller(
  scroller: Element, target: Element | null, topInset = 0, bottomInset = 0,
): void {
  if (target === null) return
  const box = scroller.getBoundingClientRect()
  const at = target.getBoundingClientRect()
  const top = box.top + topInset
  const bottom = box.bottom - bottomInset
  if (at.top >= top && at.bottom <= bottom) return
  const delta = at.height > bottom - top
    ? at.top - top
    : (at.top + at.height / 2) - (top + bottom) / 2
  if (delta === 0) return
  scroller.scrollTop += delta
}

/**
 * 源行**就地展开自己**时的落位：展开出来的那一串**装得下就一动不动**，装不下才把这一行抬到框顶。
 *
 * 为什么不复用 `centerInScroller`：居中那条策略在这里是错的——用户点的是列表里本来就在视野里的行，
 * 居中会把那一行往下推（点完看见整列跳一格），而他真正要看的是**行下面刚长出来的那一串**。本条只补
 * 一个位移：让行首对齐框首，孩子在框内从头排；已经在顶部就一次写入都不发。
 *
 * 同 `centerInScroller` 的口径：只滚**给定这一个**容器，绝不借 `scrollIntoView`（它连可滚祖先一起滚）。
 */
export function topAlignIfClipped(scroller: Element, head: Element, tail: Element | null): void {
  const box = scroller.getBoundingClientRect()
  const at = head.getBoundingClientRect()
  const block = (tail ?? head).getBoundingClientRect().bottom - at.top
  if (at.top - box.top + block <= box.height + 1) return   // 展开的这一串本来就放得下
  scroller.scrollTop += at.top - box.top
}

/** 秒 → `m:ss` 读数（听书定时的剩余读数）：分不补零、秒两位；非有限 / 负值按 0 读，不上屏 NaN。 */
export function formatClock(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** 防抖：ms 窗口内合并调用只留最后一次；flush 立即触发挂起调用；cancel 丢弃 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void, ms: number,
): ((...args: A) => void) & { flush(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: A | null = null
  const wrapped = (...args: A): void => {
    pending = args
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; const p = pending; pending = null; if (p !== null) fn(...p) }, ms)
  }
  wrapped.flush = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null }
    const p = pending
    pending = null
    if (p !== null) fn(...p)
  }
  wrapped.cancel = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null }
    pending = null
  }
  return wrapped
}

/** localStorage guard：renderToString/无 DOM 环境退内存 Map（不许炸）——prefs 等持久位共用 */
const memory = new Map<string, string>()
/** lib.dom 把 localStorage 声明成必然存在，可无 DOM 的宿主里它就是缺席的——按本地窄镜像取一格，
 *  别让 lib 的声明替运行时作保（这是防线，不是冗余判空）。 */
const hostWindow: { localStorage?: Storage } = globalThis
export const ls: Pick<Storage, 'getItem' | 'setItem'> = {
  getItem: (k) => {
    try { return hostWindow.localStorage?.getItem(k) ?? memory.get(k) ?? null } catch { return memory.get(k) ?? null }
  },
  setItem: (k, v) => {
    memory.set(k, v)
    try { hostWindow.localStorage?.setItem(k, v) } catch { /* 无 DOM：内存兜底 */ }
  },
}

/* ── 由纸算色（正文层）────────────────────────────────────────────────────
   正文层的纸与墨都是用户可选的，颜色必须从纸色现算，不能钉死一个 hex：
   `paperInk` 定正文墨色，`paperLiveInk` 定跟读高亮色。两者共用下面这套最小颜色度量
   （WCAG 相对亮度 / 对比度，sRGB→Lab 色差），不引依赖——这一层要能零成本跑在浏览器里。 */

type Triple = readonly [number, number, number]

/** 正文墨色的两个端点（与 `paperInk` 的两端字色是同一份值） */
const DARK_INK: Triple = [0x22, 0x22, 0x22]
const LIGHT_INK: Triple = [0xe8, 0xe8, 0xea]
/** 缺省米黄纸：非 hex 输入按它算跟读色 */
const DEFAULT_PAPER: Triple = [0xf7, 0xf3, 0xe8]

/** hex（3 / 6 位，大小写与首尾空白容错）→ RGB；非 hex / 非法长度 → null */
function rgbOf(paper: string): Triple | null {
  const hex = paper.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex === null) return null
  const digits = hex[1]
  // 交替分支里有一支必然参与：捕获组缺席只可能是正则与这里对不上了，走同一条「非 hex」退路
  if (digits === undefined) return null
  const full = digits.length === 3 ? digits.split('').map((c) => c + c).join('') : digits
  const channel = (offset: number): number => parseInt(full.slice(offset, offset + 2), 16)
  return [channel(0), channel(2), channel(4)]
}

/** sRGB 通道 → 线性光（0..1） */
function linear(v: number): number {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG 相对亮度（Rec.709 权重） */
function luminanceOf(rgb: Triple): number {
  return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2])
}

/** WCAG 对比度（1:1 ~ 21:1） */
function contrastOf(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

/** HSL → RGB（H 0..360、S/L 0..1；S=0 时是灰阶） */
function hslToRgb(hue: number, sat: number, light: number): Triple {
  const c = (1 - Math.abs(2 * light - 1)) * sat
  const sector = (hue % 360) / 60
  const x = c * (1 - Math.abs((sector % 2) - 1))
  const [r, g, b] = sector < 1 ? [c, x, 0]
    : sector < 2 ? [x, c, 0]
      : sector < 3 ? [0, c, x]
        : sector < 4 ? [0, x, c]
          : sector < 5 ? [x, 0, c]
            : [c, 0, x]
  const m = light - c / 2
  const to = (v: number): number => Math.round((v + m) * 255)
  return [to(r), to(g), to(b)]
}

/** sRGB → CIE Lab（D65）：色差要按感知量算，直接比 RGB 会把「换色」判成没换 */
function labOf(rgb: Triple): Triple {
  const r = linear(rgb[0])
  const g = linear(rgb[1])
  const b = linear(rgb[2])
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const fx = f(x)
  const fy = f(y)
  const fz = f(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/** CIE76 色差（够用：这里只比「同一种暖赭带里哪一档离墨色更远」） */
function deltaE76(a: Triple, b: Triple): number {
  const la = labOf(a)
  const lb = labOf(b)
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2])
}

/** RGB → `#rrggbb` */
function rgbHex(rgb: Triple): string {
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/** 正文层字色：纸张色由 prefs 固定（正文层永不接宿主 token，防回归——皮肤 token 是
 *  半透明玻璃值），故字色必须**由纸张色算**：写死深色字在自选深色纸上等于隐形。按感知亮度
 * （WCAG 线性化 + Rec.709 权重，阈值 0.35）择一，深浅两纸两端都够对比。
  *  纯函数：无 React、无 IO——可直接单测。 */
export function paperInk(paper: string): string {
  const rgb = rgbOf(paper)
  if (rgb === null) return '#222'                       // 非 hex（color input 也可能给 rgb()）：退回原行为
  return luminanceOf(rgb) > 0.35 ? '#222' : '#e8e8ea'
}

/** 跟读高亮的暖赭带（色相 / 饱和度）与可读下限：色相与正文墨色同属一页纸，不借宿主 brand */
const LIVE_HUE = 25
const LIVE_SAT = 0.45
const LIVE_MIN_CONTRAST = 5.5

/** 跟读高亮的字色：暖赭带里离正文墨色最远、又与纸面仍然够读的一档。
 *
 *  为什么不能钉死一个 hex：纸色由用户自选，同一个暖赭在米黄纸上是清楚的暖褐，换到深红或
 *  灰纸上就可能跟正文糊成一片。这里把「够读」写成可量的下限——与纸面的对比度至少
 *  `LIVE_MIN_CONTRAST`，且不低于正文自己的对比度（正文本来就弱的纸上，高亮至少不比正文更差）；
 *  在这个下限之上挑与正文墨色色差最大的一档：纸亮时往深墨一侧走、纸暗时往浅墨一侧走，
 *  亮度差始终拉开。候选只在正文墨色的同一侧（亮纸不把这一段的字反成浅色），整页仍是同一套纸墨。
 *
 *  纯函数：无 React、无 IO——单测直接把纸色喂进来量对比度与色差。 */
export function paperLiveInk(paper: string): string {
  const rgb = rgbOf(paper) ?? DEFAULT_PAPER
  const paperY = luminanceOf(rgb)
  const inkDark = paperY > 0.35
  const ink = inkDark ? DARK_INK : LIGHT_INK
  const floor = Math.min(LIVE_MIN_CONTRAST, contrastOf(luminanceOf(ink), paperY))
  let best: Triple | null = null
  let bestDiff = -1
  for (let i = 0; i <= 100; i += 1) {
    const candidate = hslToRgb(LIVE_HUE, LIVE_SAT, i / 100)
    const candidateY = luminanceOf(candidate)
    // 与正文同一侧（亮纸的墨在浅纸下面，暗纸的墨在深纸上面）：这一段的字不反色
    if (inkDark ? candidateY >= paperY : candidateY <= paperY) continue
    if (contrastOf(candidateY, paperY) + 1e-9 < floor) continue
    const diff = deltaE76(candidate, ink)
    if (diff > bestDiff) {
      best = candidate
      bestDiff = diff
    }
  }
  // 亮纸的深端 / 暗纸的浅端必然过下限，这里的兜底只是给类型收口
  return rgbHex(best ?? (inkDark ? [0, 0, 0] : [255, 255, 255]))
}

/**
 * 剥掉正文开头那行重复的章名：h2 已经渲染 `toc[i].name`，而本项目输入的书源里存在
 * 正文首行**就是同一句章名**的形状（钉子见 `tests/client/chapter-title.test.ts`）——
 * 屏幕上连着两行同样的字，一行居中粗体一行左对齐，读起来像渲染坏了。
 *
 * 三条口径，缺一即错：
 *  ① **相等才丢**。归一化只去空白（`\s` 含全角空格），不做包含、不做前缀、不做大小写折叠——
 *     「第1章 雪地遇袭（完整版）」不是章名，认不出就留。宁可不修，不可误删正文；
 *  ② **只作用在呈现层**。导出与 AI 工具读的是 `chapterContentToText` 的投影，那份必须仍是原样
 *     正文——修的是这一屏的观感，不是这本书的内容（改内容归规则引擎与 `applyReplaces`）；
 *  ③ **章名之前的空白行一起走**。空白行不是内容，留着它等于在章顶挂一个空段。
 *
 * **图文章（rich）一律不动**，哪怕首节点正是同一句章名：那是导入期建出来的**带 id 的可寻址元素**，
 * 原生目录完全可能把某条 navPoint 指到它身上。剥掉它 = 让一个导航锚点凭空消失，落位从此静默
 * 差一整段的高度——本仓认定的最高罪是静默，不是多一行重复字。文字章没有这个问题：一行文本
 * 没有身份，也没有任何东西能指向它。
 */
export function stripLeadingTitle(content: ChapterContent, chapterName: string): ChapterContent {
  if (content.kind !== 'text') return content
  const key = chapterName.replace(/\s+/g, '')
  if (key === '') return content
  const lines = content.text.split('\n')
  // 逐行拿「当前行」比对、不按下标取：行用尽时手里就是 undefined，与「首行不是章名」汇到同一条出口
  // （都在下面原样返回正文）
  let i = 0
  let line = lines[0]
  while (line !== undefined && line.trim() === '') {
    i += 1
    line = lines[i]
  }
  if (line === undefined || line.replace(/\s+/g, '') !== key) return content
  return { kind: 'text', text: lines.slice(i + 1).join('\n') }
}

/** 字符串 → 四档档位（1..4）：按 codePoint 求和取模——同一输入恒同档、可复现。
 *  封面色块与来源色点共用同一份四档色板，派生机制也必须同一份（否则两处会各自漂移）。 */
function tintTier(text: string): 1 | 2 | 3 | 4 {
  let sum = 0
  for (const ch of text.trim()) sum = (sum + (ch.codePointAt(0) ?? 0)) % 4
  return (sum + 1) as 1 | 2 | 3 | 4
}

/** 无封面降级的首字色块档位（token 层 --novel-cover-1..4 的类名映射；hex 不出 token 层，
 *  theme-tokens 守卫口径）。按首字符 codePoint 求和派生——同书恒同色、可复现；
 *  空标题回 t1（与 coverFallbackChar 的「书」同防）。 */
export function coverTintClass(title: string): 'novel-cover-t1' | 'novel-cover-t2' | 'novel-cover-t3' | 'novel-cover-t4' {
  return `novel-cover-t${tintTier(title)}`
}

/** 来源色点的档位（书架卡片「来源 chip」的色点）：按 **sourceId** 派生——同一书源在整架书上是同一个颜色，
 *  一屏之内一眼分得出来源不同。类名刻意不复用 cover 的（色点是点、封面是块，同一张卡上两块颜色可以不同），
 *  但档位色仍是同四档 token（hex 不出 token 层）。空 id 回 t1。 */
export function sourceTintClass(sourceId: string): 'novel-src-t1' | 'novel-src-t2' | 'novel-src-t3' | 'novel-src-t4' {
  return `novel-src-t${tintTier(sourceId)}`
}
