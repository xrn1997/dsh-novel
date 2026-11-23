// @vitest-environment jsdom
// 视口统一显式传参（VP = { width: 1024, height: 768 }），不依赖 jsdom 尺寸
import { beforeEach, describe, expect, it } from 'vitest'
import {
  CAPSULE_SIZE, DEFAULT_MINI_BAR, DEFAULT_MINI_BAR_SIZE, clampMiniBarIntoReachableArea,
  deriveMiniBarFlush, deriveMiniBarSide, followFlushEdgesOnResize, frameFromDrag, frameTopInsetOf,
  miniBarCenterOf, miniBarLayout, miniBarPopoverFlip, miniBarPopoverRoom, miniBarStore, parseMiniBarState,
  persistMiniBarState, resetMiniBarPosition, resetMiniBarSize, resolveFormSize, resolvedMiniBarSize,
  setMiniBarCenter, setMiniBarCollapsed, setMiniBarFrame, setMiniBarSize, snapMiniBarToEdge,
} from '../../src/client/tts/mini-bar-state.js'
import type { MiniBarFrame, Size } from '../../src/client/tts/mini-bar-state.js'
import { ls } from '../../src/client/util.js'

const VP = { width: 1024, height: 768, chromeTopInset: 0 }

/** 窗控带一档的视口读数（桌面版 DSH：栏高 48，安全顶就是带的下沿）：浮窗进了这条带连拖面都
 *  摸不到，这是「不可达」不是「被挡住」——可达区的顶界就是带的下沿，不带视觉余量。 */
const VP_CHROME = { width: 1024, height: 768, chromeTopInset: 48 }

/** 落盘位与 `mini-bar-state` 同一枚键：读写都走 `ls` 那道 guard，不碰裸 `localStorage` 全局——
 *  本仓的 JS 宿主与测试环境里它都可能缺席。 */
const MINI_BAR_KEY = 'dsh-novel.tts-mini'

beforeEach(() => {
  // 清现场：落盘读数以「读不出」起步，模块级 store 回到缺省，不给下一用例留上一例的落位
  ls.setItem(MINI_BAR_KEY, '')
  resetMiniBarPosition()
  setMiniBarCollapsed(false)
})

describe('浮窗现场：中心坐标 + 派生边', () => {
  it('缺省两轴为 null；side 由 cx 派生', () => {
    expect(miniBarStore.get()).toEqual({ cx: null, cy: null, w: null, h: null, collapsed: false })
    expect(deriveMiniBarSide(miniBarStore.get(), 1024)).toBe('right')
    setMiniBarCenter(200, 384, DEFAULT_MINI_BAR_SIZE, VP)
    expect(deriveMiniBarSide(miniBarStore.get(), 1024)).toBe('left')
    resetMiniBarPosition()
    expect(JSON.parse(ls.getItem(MINI_BAR_KEY) ?? '{}'))
      .toMatchObject({ cx: null, cy: null })
  })

  /** 贴边读数（data-flush）与呈现方向（data-side）分家：ADR-0073（现归 ADR-0100）放开自由落位之后，
   *  块停在右半屏的中间时 side 仍是 'right'，但它两侧都没碰上屏幕——样式层必须收到 'none'，
   *  否则展开态会在一条悬空的边上少一条边框、带两个直角（用户读作「样式坏了」）。 */
  it('flush 只认真贴上的那条竖边；缺省落位算贴右', () => {
    // 缺省（cx=null）解析成贴右缘（miniBarCenterOf），flush 算 right
    expect(deriveMiniBarFlush(miniBarStore.get(), DEFAULT_MINI_BAR_SIZE, VP)).toBe('right')
    // 吸附后的左右贴边
    setMiniBarCenter(160, 384, DEFAULT_MINI_BAR_SIZE, VP)
    expect(deriveMiniBarFlush(miniBarStore.get(), DEFAULT_MINI_BAR_SIZE, VP)).toBe('left')
    setMiniBarCenter(864, 384, DEFAULT_MINI_BAR_SIZE, VP)
    expect(deriveMiniBarFlush(miniBarStore.get(), DEFAULT_MINI_BAR_SIZE, VP)).toBe('right')
    // 自由落位：中心在右半屏（side 仍是 right），但两侧 gap 都远大于容差
    setMiniBarCenter(600, 384, DEFAULT_MINI_BAR_SIZE, VP)
    expect(deriveMiniBarSide(miniBarStore.get(), VP.width)).toBe('right')
    expect(deriveMiniBarFlush(miniBarStore.get(), DEFAULT_MINI_BAR_SIZE, VP)).toBe('none')
    // 中心在左半屏的自由落位：side 翻左，flush 仍是 none —— 两个读数不能互推
    setMiniBarCenter(400, 384, DEFAULT_MINI_BAR_SIZE, VP)
    expect(deriveMiniBarSide(miniBarStore.get(), VP.width)).toBe('left')
    expect(deriveMiniBarFlush(miniBarStore.get(), DEFAULT_MINI_BAR_SIZE, VP)).toBe('none')
    // 亚像素缝（≤ 0.5px）算贴上：夹取留下的浮点尾数不该把边框切掉
    setMiniBarCenter(864.4, 384, DEFAULT_MINI_BAR_SIZE, VP)
    expect(deriveMiniBarFlush(miniBarStore.get(), DEFAULT_MINI_BAR_SIZE, VP)).toBe('right')
  })

  it('双轴夹取：整块留屏内，不留半块（展开态 320×200）', () => {
    setMiniBarCenter(99_999, 99_999, DEFAULT_MINI_BAR_SIZE, VP)
    expect(miniBarStore.get()).toMatchObject({ cx: 864, cy: 668 })
    setMiniBarCenter(-99_999, -99_999, DEFAULT_MINI_BAR_SIZE, VP)
    expect(miniBarStore.get()).toMatchObject({ cx: 160, cy: 100 })
  })

  it('换形态重夹保住贴边：胶囊贴右缘 → 展开仍是贴右缘', () => {
    setMiniBarCenter(940, 384, CAPSULE_SIZE, VP)   // 胶囊贴右缘：1024-84
    clampMiniBarIntoReachableArea(DEFAULT_MINI_BAR_SIZE, VP)
    expect(miniBarStore.get()).toMatchObject({ cx: 864, cy: 384 })
  })

  it('缺省值不被夹取写成坐标', () => {
    resetMiniBarPosition()
    clampMiniBarIntoReachableArea(DEFAULT_MINI_BAR_SIZE, VP)
    expect(miniBarStore.get()).toEqual({ cx: null, cy: null, w: null, h: null, collapsed: false })
  })

  it('松手吸附：gap ≤ 24 贴齐、25 不吸，两轴独立能落角', () => {
    setMiniBarCenter(840, 660, DEFAULT_MINI_BAR_SIZE, VP)     // 右 gap 24、底 gap 8
    snapMiniBarToEdge(DEFAULT_MINI_BAR_SIZE, VP)
    expect(miniBarStore.get()).toMatchObject({ cx: 864, cy: 668 })   // 右贴齐 + 底贴齐
    setMiniBarCenter(839, 384, DEFAULT_MINI_BAR_SIZE, VP)     // 右 gap 25
    snapMiniBarToEdge(DEFAULT_MINI_BAR_SIZE, VP)
    expect(miniBarStore.get()).toMatchObject({ cx: 839, cy: 384 })   // 原地不动
  })

  it('缺省轴参与吸附判定：没拖过时贴的就是右缘，吸完仍不写坐标', () => {
    resetMiniBarPosition()
    snapMiniBarToEdge(DEFAULT_MINI_BAR_SIZE, VP)
    expect(miniBarStore.get(), '缺省状态吸完仍是缺省（不写死坐标）').toEqual({ cx: null, cy: null, w: null, h: null, collapsed: false })
  })

  it('resize 跟住贴着的边：贴右缘 / 贴底缘继续贴，自由位置只夹不漂', () => {
    setMiniBarCenter(864, 668, DEFAULT_MINI_BAR_SIZE, VP)     // 贴右 + 贴底
    followFlushEdgesOnResize(DEFAULT_MINI_BAR_SIZE, VP, { width: 1280, height: 800, chromeTopInset: 0 })
    expect(miniBarStore.get()).toMatchObject({ cx: 1120, cy: 700 })
    setMiniBarCenter(484, 354, DEFAULT_MINI_BAR_SIZE, VP)     // 自由位置
    followFlushEdgesOnResize(DEFAULT_MINI_BAR_SIZE, VP, { width: 1280, height: 800, chromeTopInset: 0 })
    expect(miniBarStore.get()).toMatchObject({ cx: 484, cy: 354 })
  })

  it('拖动帧不逐帧写 localStorage；松手后的 persistMiniBarState 一次落盘', () => {
    ls.setItem(MINI_BAR_KEY, '')
    setMiniBarCenter(200, 300, DEFAULT_MINI_BAR_SIZE, VP, false)
    expect(ls.getItem(MINI_BAR_KEY), '拖动中的帧不落盘（同步 I/O × 60fps）').toBe('')
    expect(miniBarStore.get()).toMatchObject({ cx: 200, cy: 300 })
    persistMiniBarState()
    expect(JSON.parse(ls.getItem(MINI_BAR_KEY) ?? '{}')).toMatchObject({ cx: 200, cy: 300 })
  })

  it('resize 不把缺省轴钉成数字：只有横向落过位时，高度变化后纵向仍居中', () => {
    miniBarStore.set({ cx: 200, cy: null, w: null, h: null, collapsed: false })   // 旧现场 left + anchorY null 的形状
    followFlushEdgesOnResize(DEFAULT_MINI_BAR_SIZE, VP, { width: 1024, height: 1080, chromeTopInset: 0 })
    expect(miniBarStore.get(), '纵向缺省不该被写成旧视口中心 384').toMatchObject({ cx: 200, cy: null })
  })

  it('尺寸可量则量、量不到用呈现尺寸（直出型边栏变矮不留缝）', () => {
    const state = { cx: null, cy: null, w: null, h: null, collapsed: false }
    expect(resolveFormSize(false, { width: 280, height: 108 }, state, VP)).toEqual({ width: 280, height: 108 })
    expect(resolveFormSize(false, null, state, VP)).toEqual(DEFAULT_MINI_BAR_SIZE)
    expect(resolveFormSize(false, { width: 0, height: 0 }, state, VP)).toEqual(DEFAULT_MINI_BAR_SIZE)
    expect(resolveFormSize(true, { width: 0, height: 0 }, state, VP)).toEqual(CAPSULE_SIZE)
  })

  it('只认当前形状：未发布过的旧现场（side/anchorY、x/y）回缺省，不猜', () => {
    // 键由听书面引入，没有已发布版本写过这两种形状；保留迁移分支等于为不存在的用户维护第二条读法。
    expect(parseMiniBarState(JSON.stringify({ side: 'left', anchorY: 300, collapsed: false })))
      .toEqual({ cx: null, cy: null, w: null, h: null, collapsed: false })
    expect(parseMiniBarState(JSON.stringify({ x: 100, y: 200, collapsed: true })))
      .toEqual({ cx: null, cy: null, w: null, h: null, collapsed: true })
  })

  it('新形状读写一致；垃圾与未知形状回缺省', () => {
    expect(parseMiniBarState(JSON.stringify({ cx: 200, cy: 300, collapsed: true })))
      .toEqual({ cx: 200, cy: 300, w: null, h: null, collapsed: true })
    expect(parseMiniBarState('not json')).toEqual(DEFAULT_MINI_BAR)
    expect(parseMiniBarState(JSON.stringify({ side: 'top', anchorY: 'x' })))
      .toEqual({ cx: null, cy: null, w: null, h: null, collapsed: true })
  })
})

describe('布局读数：缺省轴解析、一次给全的落位样式、弹层翻转判据', () => {
  it('miniBarCenterOf：缺省轴解析成贴右缘 / 视口中心，落过位的轴原样给', () => {
    expect(miniBarCenterOf(DEFAULT_MINI_BAR, DEFAULT_MINI_BAR_SIZE, VP)).toEqual({ x: 864, y: 384 })
    expect(miniBarCenterOf({ cx: 200, cy: 500, w: null, h: null, collapsed: false }, DEFAULT_MINI_BAR_SIZE, VP))
      .toEqual({ x: 200, y: 500 })
    // 只落过纵向：横向仍是缺省，解析成贴右缘（胶囊半宽 104）
    expect(miniBarCenterOf({ cx: null, cy: 500, w: null, h: null, collapsed: true }, CAPSULE_SIZE, VP))
      .toEqual({ x: 920, y: 500 })
  })

  it('miniBarLayout：缺省 = 右缘居中的行内 style；落位后 = cx/cy 的像素 style', () => {
    const styleOf = (state: typeof DEFAULT_MINI_BAR): unknown => miniBarLayout(state, VP, DEFAULT_MINI_BAR_SIZE).style
    /** 两个形态的尺寸值槽都由布局读数给（胶囊尺寸从 CAPSULE_SIZE 派生，与边栏对称）。 */
    const sizeVars = {
      '--novel-tts-panel-w': '320px', '--novel-tts-panel-h': '200px',
      '--novel-tts-capsule-w': '208px', '--novel-tts-capsule-h': '44px',
    }
    expect(styleOf(DEFAULT_MINI_BAR))
      .toEqual({
        transform: 'translate(-50%,-50%)', left: '864px', top: '384px', ...sizeVars,
      })
    expect(styleOf({ cx: 484, cy: 354, w: null, h: null, collapsed: false }))
      .toEqual({
        transform: 'translate(-50%,-50%)', left: '484px', top: '354px', ...sizeVars,
      })
    // 只落过纵向：X 也是解析后的右缘像素——缺省轴不再分「交给样式层」这一路
    expect(styleOf({ cx: null, cy: 500, w: null, h: null, collapsed: false }))
      .toEqual({
        transform: 'translate(-50%,-50%)', left: '864px', top: '500px', ...sizeVars,
      })
  })

  it('miniBarLayout 的 side / flush 就是两个 derive 的答案（派生口径不变）', () => {
    const states = [
      DEFAULT_MINI_BAR,
      { cx: 140, cy: 384, w: null, h: null, collapsed: false },   // 贴左缘
      { cx: 600, cy: 384, w: null, h: null, collapsed: false },   // 右半屏自由落位
      { cx: 400, cy: 384, w: null, h: null, collapsed: false },   // 左半屏自由落位
    ]
    for (const state of states) {
      const layout = miniBarLayout(state, VP, DEFAULT_MINI_BAR_SIZE)
      expect(layout.side, 'side 仍是 deriveMiniBarSide 的答案').toBe(deriveMiniBarSide(state, VP.width))
      expect(layout.flush, 'flush 仍是 deriveMiniBarFlush 的答案')
        .toBe(deriveMiniBarFlush(state, DEFAULT_MINI_BAR_SIZE, VP))
    }
    expect(miniBarLayout(DEFAULT_MINI_BAR, VP, DEFAULT_MINI_BAR_SIZE)).toMatchObject({ side: 'right', flush: 'right' })
    expect(miniBarLayout({ cx: 600, cy: 384, w: null, h: null, collapsed: false }, VP, DEFAULT_MINI_BAR_SIZE))
      .toMatchObject({ side: 'right', flush: 'none' })
  })

  it('miniBarPopoverFlip：上方放不下才翻下方，且下方得真的更有地方（POPOVER_GAP 计入边界）', () => {
    // 边界：展开态半高 100 → 中心 426 时弹层顶 320，扣 6px 正好压在 320 档上 → 不翻
    expect(miniBarPopoverFlip({ cx: 864, cy: 426, w: null, h: null, collapsed: false }, VP, DEFAULT_MINI_BAR_SIZE)).toBe(false)
    // 再高一格：上方只差 1px，而下方只剩 237——翻下去等于把卡片塞进更窄的一侧，留在上方
    expect(miniBarPopoverFlip({ cx: 864, cy: 425, w: null, h: null, collapsed: false }, VP, DEFAULT_MINI_BAR_SIZE)).toBe(false)
    // 缺省纵向（视口中心）两侧余量相等（各 278）：下方不更大就不翻——设置卡在条上方展开，
// 卡片高度由上方余量收住（max-height 走 miniBarPopoverRoom），不再整块探出视口底部。
    expect(miniBarPopoverFlip(DEFAULT_MINI_BAR, VP, DEFAULT_MINI_BAR_SIZE)).toBe(false)
    // 矮视口走 60vh 收紧档（500 高 → 300）：同一中心上方够 300 → 不翻
    const low = { width: 1024, height: 500, chromeTopInset: 0 }
    expect(miniBarPopoverFlip({ cx: 864, cy: 406, w: null, h: null, collapsed: false }, low, DEFAULT_MINI_BAR_SIZE)).toBe(false)
    // 再高一格：下方余量已经是 0（块底压着视口），翻下去只会得到一条空缝 → 留在上方
    expect(miniBarPopoverFlip({ cx: 864, cy: 405, w: null, h: null, collapsed: false }, low, DEFAULT_MINI_BAR_SIZE)).toBe(false)
  })

  it('miniBarPopoverFlip 吃内容实测高：矮卡不翻、固定回退档会误翻', () => {
    // 中心 300 → 块顶 200，扣间距后上方余量 194。
    const state = { cx: 864, cy: 300, w: null, h: null, collapsed: false }
    // 实测 120：上方装得下 → 不翻（固定 320 档会翻，这正是「内容实测高与 60vh 取小」要修的）
    expect(miniBarPopoverFlip(state, VP, DEFAULT_MINI_BAR_SIZE, 120)).toBe(false)
    expect(miniBarPopoverFlip(state, VP, DEFAULT_MINI_BAR_SIZE), '量不到回退固定档，方向相反').toBe(true)
    // 实测高于 60vh 时按 60vh 收紧（VP 768 → 460.8）；上方只有 194，翻下方（余量 362 更大）
    expect(miniBarPopoverFlip(state, VP, DEFAULT_MINI_BAR_SIZE, 900)).toBe(true)
  })

  it('miniBarPopoverRoom：余量跟着方向走，是弹层 max-height 的上界（已扣视口留白 8px）', () => {
    // 上方展开：余量 = 块顶 − 间距（700 − 100 − 6）
    expect(miniBarPopoverRoom({ cx: 864, cy: 700, w: null, h: null, collapsed: false }, VP, DEFAULT_MINI_BAR_SIZE)).toBe(586)
    // 翻到下方：余量 = 视口高 − 块底 − 间距（768 − 200 − 6）
    expect(miniBarPopoverRoom({ cx: 864, cy: 100, w: null, h: null, collapsed: false }, VP, DEFAULT_MINI_BAR_SIZE)).toBe(554)
    // 缺省居中：两侧相等，翻下方 → 取下方那一侧
    expect(miniBarPopoverRoom(DEFAULT_MINI_BAR, VP, DEFAULT_MINI_BAR_SIZE)).toBe(270)
    // 吃实测内容高：矮卡留在上方，余量仍是上方那一份（不是卡片高）
    expect(miniBarPopoverRoom({ cx: 864, cy: 300, w: null, h: null, collapsed: false }, VP, DEFAULT_MINI_BAR_SIZE, 120)).toBe(186)
  })
})
describe('浮窗尺寸现场：意图与呈现分离', () => {
  it('缺省 w/h 为 null；呈现尺寸 320×200', () => {
    expect(DEFAULT_MINI_BAR.w).toBeNull()
    expect(DEFAULT_MINI_BAR.h).toBeNull()
    expect(resolvedMiniBarSize(DEFAULT_MINI_BAR, VP)).toEqual({ width: 320, height: 200 })
    expect(DEFAULT_MINI_BAR_SIZE).toEqual({ width: 320, height: 200 })
  })

  it('呈现尺寸夹到范围：900 宽 → 520，100 高 → 162，夹取不回写现场', () => {
    miniBarStore.set({ cx: null, cy: null, w: 900, h: 100, collapsed: false })
    expect(resolvedMiniBarSize(miniBarStore.get(), VP)).toEqual({ width: 520, height: 162 })
    expect(miniBarStore.get().w).toBe(900)
    expect(miniBarStore.get().h).toBe(100)
  })

  it('视口小于下限：呈现尺寸取下限（块可溢出视口，不崩）', () => {
    const small = { width: 200, height: 120, chromeTopInset: 0 }
    expect(resolvedMiniBarSize(DEFAULT_MINI_BAR, small)).toEqual({ width: 260, height: 162 })
    expect(resolvedMiniBarSize({ cx: null, cy: null, w: 480, h: 300, collapsed: false }, small))
      .toEqual({ width: 260, height: 162 })
  })

  it('视口夹取：视口 600×500 时 520×420 原样，视口 500×450 时宽夹到 484', () => {
    expect(resolvedMiniBarSize({ cx: null, cy: null, w: 520, h: 420, collapsed: false }, { width: 600, height: 500, chromeTopInset: 0 }))
      .toEqual({ width: 520, height: 420 })
    expect(resolvedMiniBarSize({ cx: null, cy: null, w: 520, h: 420, collapsed: false }, { width: 500, height: 450, chromeTopInset: 0 }))
      .toEqual({ width: 484, height: 420 })
  })

  it('设置与复位：写数值 / 写 null；同值不触发订阅（commit 早退含两轴）', () => {
    setMiniBarSize(380, 280)
    expect(miniBarStore.get().w).toBe(380)
    expect(miniBarStore.get().h).toBe(280)
    resetMiniBarSize()
    expect(miniBarStore.get().w).toBeNull()
    expect(miniBarStore.get().h).toBeNull()
    const before = miniBarStore.get()
    setMiniBarSize(null, null)
    expect(miniBarStore.get()).toBe(before)
  })

  it('旧形状与垃圾：w/h 缺失或非法 → 该轴回 null，不猜', () => {
    expect(parseMiniBarState(JSON.stringify({ cx: null, cy: null, collapsed: false })))
      .toMatchObject({ w: null, h: null })
    expect(parseMiniBarState(JSON.stringify({ cx: null, cy: null, w: '900', h: Number.NaN, collapsed: false })))
      .toMatchObject({ w: null, h: null })
    expect(parseMiniBarState(JSON.stringify({ cx: null, cy: null, w: 380, collapsed: false })))
      .toMatchObject({ w: 380, h: null })
  })
})

describe('拖边几何：对边锚定 + 范围夹取', () => {
  const start: MiniBarFrame = { width: 320, height: 200, cx: 500, cy: 400 }

  it('拖右边：左缘不动，宽 +dx', () => {
    const f = frameFromDrag('right', start, 40, 0, VP)
    expect(f.width).toBe(360)
    expect(f.cx - f.width / 2).toBeCloseTo(start.cx - start.width / 2, 5)
    expect(f.height).toBe(200)
  })

  it('拖左边：右缘不动，宽 −dx', () => {
    const f = frameFromDrag('left', start, -30, 0, VP)
    expect(f.width).toBe(350)
    expect(f.cx + f.width / 2).toBeCloseTo(start.cx + start.width / 2, 5)
  })

  it('拖下边：顶缘不动，高 +dy', () => {
    const f = frameFromDrag('bottom', start, 0, 50, VP)
    expect(f.height).toBe(250)
    expect(f.cy - f.height / 2).toBeCloseTo(start.cy - start.height / 2, 5)
    expect(f.width).toBe(320)
  })

  it('右下角：两轴同时，左缘与顶缘都不动', () => {
    const f = frameFromDrag('corner', start, 60, 60, VP)
    expect(f.width).toBe(380)
    expect(f.height).toBe(260)
    expect(f.cx - f.width / 2).toBeCloseTo(start.cx - start.width / 2, 5)
    expect(f.cy - f.height / 2).toBeCloseTo(start.cy - start.height / 2, 5)
  })

  it('范围夹取：拖过最小/最大都夹住', () => {
    expect(frameFromDrag('right', start, -500, 0, VP).width).toBe(260)
    expect(frameFromDrag('right', start, 500, 0, VP).width).toBe(520)
    expect(frameFromDrag('bottom', start, 0, -500, VP).height).toBe(162)
    expect(frameFromDrag('bottom', start, 0, 500, VP).height).toBe(420)
  })

  it('夹完尺寸后中心夹回视口：贴边拖大会被夹但不把块推出去', () => {
    const f = frameFromDrag('left', { ...start, cx: 200 }, -400, 0, VP)
    expect(f.width).toBe(520)
    expect(f.cx - f.width / 2).toBeGreaterThanOrEqual(-0.5)
  })

  it('setMiniBarFrame 只在 persist=true 时落盘', () => {
    miniBarStore.set({ cx: null, cy: null, w: null, h: null, collapsed: false })
    ls.setItem(MINI_BAR_KEY, '')
    setMiniBarFrame({ width: 360, height: 200, cx: 500, cy: 400 }, VP, false)
    expect(ls.getItem(MINI_BAR_KEY)).toBe('')
    persistMiniBarState()
    const saved = JSON.parse(ls.getItem(MINI_BAR_KEY) ?? '{}') as { w?: number }
    expect(saved.w).toBe(360)
  })
})

describe('浮窗可达区：宿主窗控带是不可达区', () => {
  // 判据一律拿读数说话，不写魔数：断言里出现 48 的像素值必须能从 VP_CHROME 回查
  const chromeTop = VP_CHROME.chromeTopInset
  /** 块的顶边（中心 − 半高）：§1「整块不得越进带里」在纵轴上的可读形式。 */
  const topEdgeOf = (cy: number | null, size: Size): number => (cy ?? 0) - size.height / 2

  it('缺省纵向落位在可达区中心，不在视口中心（§1 缺省轴）', () => {
    expect(miniBarCenterOf(DEFAULT_MINI_BAR, CAPSULE_SIZE, VP_CHROME).y)
      .toBe(chromeTop + (VP_CHROME.height - chromeTop) / 2)
    expect(miniBarCenterOf(DEFAULT_MINI_BAR, CAPSULE_SIZE, VP_CHROME).x)
      .toBe(VP_CHROME.width - CAPSULE_SIZE.width / 2)   // 横轴没有带：照旧贴右缘
  })

  it('拖到右上角松手吸附：落角，顶边正好压在安全顶上', () => {
    setMiniBarCenter(980, 24, CAPSULE_SIZE, VP_CHROME)
    snapMiniBarToEdge(CAPSULE_SIZE, VP_CHROME)
    expect(miniBarStore.get()).toMatchObject({
      cx: VP_CHROME.width - CAPSULE_SIZE.width / 2,
      cy: chromeTop + CAPSULE_SIZE.height / 2,
    })
  })

  it('可达区比块还矮时吸附仍不越进带里（吸到贴不下的那条边也要让带）', () => {
    // 1024×200 的窗口 + 48 的带：可达高 152 < 展开态 200，块必然溢出下缘，但顶边绝不能进带
    const tight = { width: 1024, height: 200, chromeTopInset: chromeTop }
    setMiniBarCenter(500, 148, DEFAULT_MINI_BAR_SIZE, tight)
    snapMiniBarToEdge(DEFAULT_MINI_BAR_SIZE, tight)
    expect(topEdgeOf(miniBarStore.get().cy, DEFAULT_MINI_BAR_SIZE), '吸附主动把块送进带里 = §1 违例')
      .toBeGreaterThanOrEqual(chromeTop)
  })

  it('落在窗控带下的旧现场，重夹时捞回可达区（§6 卡死自愈）', () => {
    setMiniBarCenter(980, 22, CAPSULE_SIZE, { width: 1024, height: 768, chromeTopInset: 0 })
    clampMiniBarIntoReachableArea(CAPSULE_SIZE, VP_CHROME)
    expect(topEdgeOf(miniBarStore.get().cy, CAPSULE_SIZE)).toBe(chromeTop)
  })

  it('自愈重夹不把缺省轴钉成坐标（带在场时同样成立）', () => {
    resetMiniBarPosition()
    resetMiniBarSize()
    clampMiniBarIntoReachableArea(DEFAULT_MINI_BAR_SIZE, VP_CHROME)
    expect(miniBarStore.get()).toEqual({ cx: null, cy: null, w: null, h: null, collapsed: false })
  })

  it('呈现高度吃安全顶：上限是可达高 − 视口边距', () => {
    const state = { cx: null, cy: null, w: 9999, h: 9999, collapsed: false }
    const view = { width: 1024, height: 300, chromeTopInset: chromeTop }
    expect(resolvedMiniBarSize(state, view).height).toBe(view.height - chromeTop - 16)
  })

  it('设置弹层不开进窗控带：上方余量从安全顶起算', () => {
    const state = { cx: 512, cy: chromeTop + 100, w: null, h: null, collapsed: false }   // 贴安全顶
    expect(miniBarPopoverFlip(state, VP_CHROME, DEFAULT_MINI_BAR_SIZE, 50), '带里那条不算上方余量').toBe(true)
    expect(miniBarPopoverRoom(state, VP_CHROME, DEFAULT_MINI_BAR_SIZE, 50))
      .toBe(VP_CHROME.height - state.cy - DEFAULT_MINI_BAR_SIZE.height / 2 - 6 - 8)
  })

  it('贴安全顶的块在窗控带读数变化后跟到新安全顶（全屏切换）', () => {
    setMiniBarCenter(500, 70, CAPSULE_SIZE, VP_CHROME)
    snapMiniBarToEdge(CAPSULE_SIZE, VP_CHROME)
    followFlushEdgesOnResize(CAPSULE_SIZE, VP_CHROME, { width: 1024, height: 768, chromeTopInset: 0 })
    expect(miniBarStore.get().cy).toBe(CAPSULE_SIZE.height / 2)
  })
})

describe('窗控带读数：可达性口径', () => {
  it('无栏 = 0；有栏 = 栏高；全屏 = 0；栏高认不出 = 0', () => {
    const root = document.createElement('div')
    expect(frameTopInsetOf(null), '无 DOM 宿主回 0').toBe(0)
    expect(frameTopInsetOf(root), '没有窗控栏（纯浏览器）= 0').toBe(0)
    root.setAttribute('data-windows-titlebar', '')
    root.style.setProperty('--dsh-windows-titlebar-height', '48px')
    expect(frameTopInsetOf(root), '栏高 48：安全顶就是带的下沿').toBe(48)
    root.setAttribute('data-fullscreen', '')
    expect(frameTopInsetOf(root), '全屏：栏不占位 = 0').toBe(0)
    root.removeAttribute('data-fullscreen')
    root.style.removeProperty('--dsh-windows-titlebar-height')
    expect(frameTopInsetOf(root), '栏高认不出：读数失败只到这一格 = 0').toBe(0)
  })
})
