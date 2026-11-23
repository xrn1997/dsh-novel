/** client 中立小工具（debounce、localStorage guard 等）：不归阅读进度，也不归轻量 store。 */
import { chapterTitleOrFallback, playUnitStarts, splitParagraphs } from '../shared/chapter-text.js'
import type { ChapterContent } from '../shared/wire.js'
import type { Translate } from './copy/index.js'

/** 盯服务端在跑作业时的回落轮询节奏（搜索面与发现面共用）：600ms 是「边抓边出」观感与
 *  不刷屏 `/novel-api` 的同一档取舍；测试可经 `JobWatchDeps.jobPollMs` 换档。 */
export const JOB_POLL_MS = 600

/** 常驻状态层盯写任务的节拍：量的是整批写任务进度，界面只读「在跑 / 跑完」。 */
export const STATUS_POLL_MS = 1000

/** 正文节点的 DOM 钩子（`ChapterBody` 写在每个可定位节点上）。查找一律**遍历属性比较**，
 *  绝不把节点 ID 拼进选择器：wire 的 ID 是不透明串，拼一次就是一条进 DOM 查询的路。 */
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
 * 在**给定这一个**滚动容器里把目标摆进视野（抽屉、注释面板共用）：装得下居中，装不下顶对齐。
 * 为什么不用 `scrollIntoView`：它会一路滚每个可滚祖先，「打开只读浮层」于是改写主阅读位置；
 * 顶对齐不是边角：脚注锚点常是装着好几段的容器，内容比视口长时只有顶对齐答得对。
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
 * 源行**就地展开自己**的落位：展开的那串装得下就一动不动，装不下才把这一行抬到框顶。
 * 不复用 `centerInScroller`：用户点的是本来就在视野里的行，居中会把那一行往下推（看见整列跳一格），
 * 而他真正要看的是行下面刚长出来的那串。只滚给定容器，绝不借 `scrollIntoView`。
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
/** lib.dom 把 localStorage 声明成必然存在，无 DOM 宿主里它缺席——这是防线，不是冗余判空。 */
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
   正文纸与墨都是用户可选，颜色必须从纸色现算：`paperInk` 定墨色，`paperLiveInk` 定跟读高亮色。 */

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

/** 正文层字色：纸张色由 prefs 固定（正文层永不接宿主 token），字色必须**由纸张色算**——写死深色字
 *  在自选深色纸上等于隐形。按感知亮度（WCAG + Rec.709，阈值 0.35）择一，纯函数可直测。 */
export function paperInk(paper: string): string {
  const rgb = rgbOf(paper)
  if (rgb === null) return '#222'                       // 非 hex（color input 也可能给 rgb()）：退回原行为
  return luminanceOf(rgb) > 0.35 ? '#222' : '#e8e8ea'
}

/** 跟读高亮的暖赭带（色相 / 饱和度）与可读下限：色相与正文墨色同属一页纸，不借宿主 brand */
const LIVE_HUE = 25
const LIVE_SAT = 0.45
const LIVE_MIN_CONTRAST = 5.5

/** 跟读高亮的字色：暖赭带里离正文墨色最远、又与纸面仍够读的一档。
 *
 *  为什么不能钉死 hex：纸色自选，同一个暖赭在米黄纸上清楚，换深红或灰纸就可能糊成一片。
 *  下限写成可量：对比度至少 `LIVE_MIN_CONTRAST`，且不低于正文自己的对比度；在此之上挑与墨色
 *  色差最大的一档，候选只在正文墨色的同一侧（不反色）。纯函数，单测直接喂纸色量。 */
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

/** 客户端章节展示名：空串 / 纯空白统一回退到当前语言的「第 N 章」（共享判据住 `shared/chapter-text`）。 */
export function displayChapterTitle(
  name: string | null | undefined,
  chapterIndex: number,
  t: Translate,
): string {
  return chapterTitleOrFallback(name, chapterIndex, (n) => t('reader.chapterFallback', { n }))
}

/**
 * 剥掉正文开头那行重复的章名：h2 已渲染章名，而书源里存在正文首行就是同一句章名的形状
 * （钉子见 `tests/client/chapter-title.test.ts`）——屏幕上两行同样的字像渲染坏了。
 *
 * 三条口径：① **相等才丢**（归一化只去空白，不做包含/前缀/大小写折叠，宁可不修不可误删）；
 * ② **只作用在呈现层**（导出与 AI 读 `chapterContentToText`，内容归规则引擎）；
 * ③ **章名之前的空白行一起走**。**图文章一律不动**：首节点是带 id 的可寻址元素，
 * 剥掉等于让导航锚点消失，落位差一整段——静默是本仓最高罪。
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

/** 正文投影（正文只经这一处剥与折算）：剥掉与章名重复的首行，并给出被剥掉的行占掉的播放单元数。
 *
 *  为什么不能只看「剥掉几行」：播放单元逐行切、空行与纯标点行占 0 格，基数是「剥后第一行」的
 *  起段号；不补偏移，「从本段听」与探针起播会系统性早一段。图文章不剥，基数为 0。
 *  导出只给测试直接驱动：整页挂载成本会掩盖这条纯算式，而它错了表现为整体偏移一段。 */
export function chapterBodyProjection(content: ChapterContent, chapterName: string): {
  content: ChapterContent
  paragraphBase: number
} {
  const stripped = stripLeadingTitle(content, chapterName)
  if (stripped === content || content.kind !== 'text' || stripped.kind !== 'text') {
    return { content: stripped, paragraphBase: 0 }
  }
  const lines = content.text.split('\n').map((text) => ({ text }))
  const removed = lines.length - stripped.text.split('\n').length
  const starts = playUnitStarts(lines)
  // 越界（整段剥完）落全量单元数：累加到头就是整篇占掉的单元数
  return { content: stripped, paragraphBase: starts[removed] ?? splitParagraphs(content.text).length }
}

/** 字符串 → 四档档位（1..4）：按 codePoint 求和取模——同输入恒同档、可复现。 */
function tintTier(text: string): 1 | 2 | 3 | 4 {
  let sum = 0
  for (const ch of text.trim()) sum = (sum + (ch.codePointAt(0) ?? 0)) % 4
  return (sum + 1) as 1 | 2 | 3 | 4
}

/** 无封面降级的首字色块档位（token 层 --novel-cover-1..4 的类名映射；hex 不出 token 层）。
 *  同书恒同色、可复现；空标题回 t1。 */
export function coverTintClass(title: string): 'novel-cover-t1' | 'novel-cover-t2' | 'novel-cover-t3' | 'novel-cover-t4' {
  return `novel-cover-t${tintTier(title)}`
}

/** 来源色点的档位：按 **sourceId** 派生——同一书源在整架书上同色。类名不复用 cover 的
 *  （色点是点、封面是块），档位色仍是同四档 token；空 id 回 t1。 */
export function sourceTintClass(sourceId: string): 'novel-src-t1' | 'novel-src-t2' | 'novel-src-t3' | 'novel-src-t4' {
  return `novel-src-t${tintTier(sourceId)}`
}
