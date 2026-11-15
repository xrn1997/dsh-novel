// @vitest-environment jsdom
// 视口统一显式传参（VP = { width: 1024, height: 768 }），不依赖 jsdom 尺寸
import { beforeEach, describe, expect, it } from 'vitest'
import {
  CAPSULE_SIZE, DEFAULT_MINI_BAR, DEFAULT_MINI_BAR_SIZE, clampMiniBarIntoViewport,
  deriveMiniBarFlush, deriveMiniBarSide, followFlushEdgesOnResize, frameFromDrag, miniBarCenterOf,
  miniBarLayout, miniBarPopoverFlip, miniBarStore, parseMiniBarState, persistMiniBarState,
  resetMiniBarPosition, resetMiniBarSize, resolveFormSize, resolvedMiniBarSize, setMiniBarCenter,
  setMiniBarCollapsed, setMiniBarFrame, setMiniBarSize, snapMiniBarToEdge,
} from '../../src/client/tts/mini-bar-state.js'
import type { MiniBarFrame } from '../../src/client/tts/mini-bar-state.js'
import { ls } from '../../src/client/util.js'

const VP = { width: 1024, height: 768 }

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

  /** 贴边读数（data-flush）与呈现方向（data-side）分家：ADR-0073 放开自由落位之后，
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
    clampMiniBarIntoViewport(DEFAULT_MINI_BAR_SIZE, VP)
    expect(miniBarStore.get()).toMatchObject({ cx: 864, cy: 384 })
  })

  it('缺省值不被夹取写成坐标', () => {
    resetMiniBarPosition()
    clampMiniBarIntoViewport(DEFAULT_MINI_BAR_SIZE, VP)
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
    followFlushEdgesOnResize(DEFAULT_MINI_BAR_SIZE, VP, { width: 1280, height: 800 })
    expect(miniBarStore.get()).toMatchObject({ cx: 1120, cy: 700 })
    setMiniBarCenter(484, 354, DEFAULT_MINI_BAR_SIZE, VP)     // 自由位置
    followFlushEdgesOnResize(DEFAULT_MINI_BAR_SIZE, VP, { width: 1280, height: 800 })
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
    followFlushEdgesOnResize(DEFAULT_MINI_BAR_SIZE, VP, { width: 1024, height: 1080 })
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

  it('miniBarPopoverFlip：上方留不下弹层实测档加间距就翻到下方（POPOVER_GAP 计入边界）', () => {
    // 边界：展开态半高 100 → 中心 426 时弹层顶 320，扣 6px 正好压在 320 档上 → 不翻；再高一格才翻
    expect(miniBarPopoverFlip({ cx: 864, cy: 426, w: null, h: null, collapsed: false }, VP, DEFAULT_MINI_BAR_SIZE)).toBe(false)
    expect(miniBarPopoverFlip({ cx: 864, cy: 425, w: null, h: null, collapsed: false }, VP, DEFAULT_MINI_BAR_SIZE)).toBe(true)
    // 缺省纵向（视口中心）在 VP 下上方放不下整张卡片 → 翻下方
    expect(miniBarPopoverFlip(DEFAULT_MINI_BAR, VP, DEFAULT_MINI_BAR_SIZE)).toBe(true)
    // 矮视口走 60vh 收紧档（500 高 → 300）：同一中心从「不翻」翻成「翻」
    const low = { width: 1024, height: 500 }
    expect(miniBarPopoverFlip({ cx: 864, cy: 406, w: null, h: null, collapsed: false }, low, DEFAULT_MINI_BAR_SIZE)).toBe(false)
    expect(miniBarPopoverFlip({ cx: 864, cy: 405, w: null, h: null, collapsed: false }, low, DEFAULT_MINI_BAR_SIZE)).toBe(true)
  })

  it('miniBarPopoverFlip 吃内容实测高：矮卡不翻、固定回退档会误翻', () => {
    // 中心 300 → 块顶 200，扣间距后上方余量 194。
    const state = { cx: 864, cy: 300, w: null, h: null, collapsed: false }
    // 实测 120：上方装得下 → 不翻（固定 320 档会翻，这正是「内容实测高与 60vh 取小」要修的）
    expect(miniBarPopoverFlip(state, VP, DEFAULT_MINI_BAR_SIZE, 120)).toBe(false)
    expect(miniBarPopoverFlip(state, VP, DEFAULT_MINI_BAR_SIZE), '量不到回退固定档，方向相反').toBe(true)
    // 实测高于 60vh 时按 60vh 收紧（VP 768 → 460.8）；上方只有 194，两档都翻
    expect(miniBarPopoverFlip(state, VP, DEFAULT_MINI_BAR_SIZE, 900)).toBe(true)
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
    const small = { width: 200, height: 120 }
    expect(resolvedMiniBarSize(DEFAULT_MINI_BAR, small)).toEqual({ width: 260, height: 162 })
    expect(resolvedMiniBarSize({ cx: null, cy: null, w: 480, h: 300, collapsed: false }, small))
      .toEqual({ width: 260, height: 162 })
  })

  it('视口夹取：视口 600×500 时 520×420 原样，视口 500×450 时宽夹到 484', () => {
    expect(resolvedMiniBarSize({ cx: null, cy: null, w: 520, h: 420, collapsed: false }, { width: 600, height: 500 }))
      .toEqual({ width: 520, height: 420 })
    expect(resolvedMiniBarSize({ cx: null, cy: null, w: 520, h: 420, collapsed: false }, { width: 500, height: 450 }))
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
