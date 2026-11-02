import { describe, expect, it, vi } from 'vitest'
import { zhTranslate } from '../../src/client/copy/index.js'
import { ReaderScene } from '../../src/client/reader-scene.js'
import type { ReaderSession, VisibleNode } from '../../src/client/reader-session.js'
import type { ShelfAddOutcome, ShelfSeatInput } from '../../src/client/shelf-action.js'
import type { ReadingTarget, SupplementTarget } from '../../src/client/views/types.js'

/**
 * 阅读场景的交互律：互斥、返回句柄、Esc 归属、离开一问、入架写入。
 * 这些断言住无 DOM 的单测里，不靠整页渲染 + 伪造几何——改场景交互先跑这里。
 */

const target: SupplementTarget = { kind: 'supplement', documentId: 'note-1', anchorId: null }
const entry: VisibleNode = { index: 0, nodeId: 'n1', offsetWithinNode: 12 }

interface Harness {
  scene: ReaderScene
  session: {
    onShelf: 'on' | 'off' | 'unknown'
    followLink: ReturnType<typeof vi.fn>
    closeSupplement: ReturnType<typeof vi.fn>
    requestJump: ReturnType<typeof vi.fn>
  }
  navigate: ReturnType<typeof vi.fn>
  addSeat: ReturnType<typeof vi.fn>
  pushOk: ReturnType<typeof vi.fn>
}

function makeScene(over: {
  onShelf?: 'on' | 'off' | 'unknown'
  addSeat?: (input: ShelfSeatInput) => Promise<ShelfAddOutcome>
  tocLength?: () => number | null
} = {}): Harness {
  const session = {
    onShelf: over.onShelf ?? 'off',
    followLink: vi.fn(() => entry),
    closeSupplement: vi.fn(),
    requestJump: vi.fn(),
  }
  const navigate = vi.fn()
  const addSeat = vi.fn(over.addSeat ?? (async (input: ShelfSeatInput): Promise<ShelfAddOutcome> =>
    ({ ok: true as const, bookKey: input.url })))
  const pushOk = vi.fn()
  const scene = new ReaderScene({
    session: session as unknown as ReaderSession,
    sourceId: 's1', bookKey: 'b1', title: '书',
    tocLength: over.tocLength ?? (() => 3),
    navigate, addSeat, pushOk, t: zhTranslate,
  })
  return { scene, session, navigate, addSeat, pushOk }
}

describe('ReaderScene', () => {
  it('keeps at most one surface and closes a supplement through the session', () => {
    const { scene, session } = makeScene()
    scene.toggle('toc')
    scene.openNote(target, entry)
    expect(scene.state.surface).toBe('supplement')
    expect(scene.state.note?.target).toBe(target)
    scene.close()
    expect(session.closeSupplement).toHaveBeenCalledWith('s1', entry)
    expect(scene.state.surface).toBeNull()
    expect(scene.state.note).toBeNull()
  })

  it('开面板是一笔写入：订阅者读不到「面已开场、载荷还是上一条」的中间态', () => {
    const { scene } = makeScene()
    let supplementNotices = 0
    let torn = 0
    const stop = scene.subscribe(() => {
      if (scene.state.surface !== 'supplement') return
      supplementNotices += 1
      if (scene.state.note === null) torn += 1
    })
    scene.toggle('toc')
    scene.openNote(target, entry)
    stop()
    // 目录 → 注释面板把换面与载荷并成一笔：订阅者一次也不该看见「面板开场却没有载荷」
    expect(torn, '订阅者读到 supplement 已开场、载荷仍为空的中间态').toBe(0)
    expect(supplementNotices, '换面与载荷该是一次通知，不是两笔').toBe(1)
    expect(scene.state.note?.target).toBe(target)
  })

  it('re-points the panel on every open, and another corner hides it without consuming the return handle', () => {
    const { scene, session } = makeScene()
    scene.openNote(target, entry)
    const first = scene.state.note?.seq ?? 0
    scene.openNote(target, entry)
    expect(scene.state.note?.seq).toBe(first + 1)       // 同一脚注再点一次也算「外层重新指向」

    scene.toggle('toc')                                  // 开目录 = 只收面板那一档
    expect(scene.state.surface).toBe('toc')
    expect(scene.state.note).toBeNull()
    expect(session.closeSupplement).not.toHaveBeenCalled()
  })

  it('toggling the same corner twice leaves no surface', () => {
    const { scene } = makeScene()
    scene.toggle('prefs')
    expect(scene.state.surface).toBe('prefs')
    scene.toggle('prefs')
    expect(scene.state.surface).toBeNull()
  })

  it('owns the leave prompt only when the book is off shelf', () => {
    const off = makeScene({ onShelf: 'off' })
    off.scene.exitToShelf()
    expect(off.scene.state.askShelf).toBe(true)
    expect(off.navigate).not.toHaveBeenCalled()

    const on = makeScene({ onShelf: 'on' })
    on.scene.exitToShelf()
    expect(on.scene.state.askShelf).toBe(false)
    expect(on.navigate).toHaveBeenCalledWith({ name: 'shelf' })

    // 书架拉不到是「不知道」，不是「没有」——不许拿不知道拦用户
    const unknown = makeScene({ onShelf: 'unknown' })
    unknown.scene.exitToShelf()
    expect(unknown.scene.state.askShelf).toBe(false)
    expect(unknown.navigate).toHaveBeenCalledWith({ name: 'shelf' })
  })

  it('does not let Esc close the surface while the join modal is open', () => {
    const { scene } = makeScene()
    scene.toggle('toc')
    scene.exitToShelf()
    scene.handleEsc()
    expect(scene.state.askShelf).toBe(true)
    expect(scene.state.surface).toBe('toc')
  })

  it('遮罩投影跟着面走：Aa 与导出面板有，目录与注释面板没有，收场即清', () => {
    const { scene } = makeScene()
    expect(scene.state.mask, '无面不挂遮罩').toBe(false)

    scene.toggle('prefs')
    expect(scene.state.mask, 'Aa 面板要「点外面关掉」').toBe(true)
    scene.toggle('prefs')
    expect(scene.state.mask).toBe(false)

    scene.toggle('toc')
    expect(scene.state.mask, '目录抽屉自带收场钮，不借遮罩').toBe(false)
    scene.openNote(target, entry)
    expect(scene.state.mask, '注释面板同目录').toBe(false)

    scene.toggle('export')
    expect(scene.state.mask, '导出面板是第二个借遮罩收场的面').toBe(true)
    scene.close()
    expect(scene.state.mask).toBe(false)
  })

  it('两枚投影与面同笔落定：每次通知里 mask/escOwner 都与面自洽', () => {
    const { scene } = makeScene()
    const check = (): void => {
      const s = scene.state
      expect(s.mask, `面=${String(s.surface)} 的遮罩投影`).toBe(s.surface === 'prefs' || s.surface === 'export')
      expect(s.escOwner, `面=${String(s.surface)}、入架一问=${String(s.askShelf)} 的 Esc 归属`)
        .toBe(s.askShelf ? 'modal' : s.surface === null ? 'none' : 'surface')
    }
    const stop = scene.subscribe(check)
    scene.toggle('prefs')
    scene.toggle('toc')
    scene.openNote(target, entry)
    scene.close()
    scene.exitToShelf()
    scene.dismissAsk()
    stop()
    check()
  })

  it('Esc 归属投影：无面无模态 none、有面 surface、入架一问 modal、收回后回 surface', () => {
    const { scene } = makeScene()
    expect(scene.state.escOwner).toBe('none')
    scene.toggle('toc')
    expect(scene.state.escOwner).toBe('surface')
    scene.exitToShelf()                                  // 缺省 onShelf='off'：问到入架一问
    expect(scene.state.escOwner).toBe('modal')
    scene.dismissAsk()
    expect(scene.state.escOwner, '模态退场后浮层重新持有 Esc').toBe('surface')
  })

  it('Esc while no modal is open closes the surface on the close path', () => {
    const { scene, session } = makeScene()
    scene.openNote(target, entry)
    scene.handleEsc()
    expect(session.closeSupplement).toHaveBeenCalledWith('s1', entry)
    expect(scene.state.surface).toBeNull()
  })

  it('dismissing the leave prompt is refused while the write is in flight', async () => {
    let release!: (outcome: ShelfAddOutcome) => void
    const { scene } = makeScene({
      addSeat: () => new Promise<ShelfAddOutcome>((resolve) => { release = resolve }),
    })
    scene.exitToShelf()
    const pending = scene.joinAndBack()
    expect(scene.state.joinBusy).toBe(true)
    scene.dismissAsk()
    expect(scene.state.askShelf, '在途期间 Esc/遮罩不许收回这一问').toBe(true)
    release({ ok: true, bookKey: 'b1' })
    await pending
    expect(scene.state.joinBusy).toBe(false)
    expect(scene.state.askShelf).toBe(false)
  })

  it('joins and navigates only after a successful write', async () => {
    const fail = makeScene({ addSeat: async () => ({ ok: false, error: new Error('no') }) })
    fail.scene.exitToShelf()
    await fail.scene.joinAndBack()
    expect(fail.navigate).not.toHaveBeenCalled()
    expect(fail.scene.state.joinError).toBe('no')
    expect(fail.scene.state.askShelf, '失败留在问它的那一层，可重试').toBe(true)
    expect(fail.pushOk).not.toHaveBeenCalled()

    const ok = makeScene()
    ok.scene.exitToShelf()
    await ok.scene.joinAndBack()
    expect(ok.navigate).toHaveBeenCalledWith({ name: 'shelf' })
    expect(ok.pushOk).toHaveBeenCalledWith('已加入书架：书')
    expect(ok.addSeat).toHaveBeenCalledWith({ sourceId: 's1', url: 'b1', title: '书', totalChapters: 3 })
  })

  it('passes an unknown toc length through as absence, not zero', async () => {
    const { scene, addSeat } = makeScene({ tocLength: () => null })
    scene.exitToShelf()
    await scene.joinAndBack()
    expect(addSeat).toHaveBeenCalledWith({ sourceId: 's1', url: 'b1', title: '书', totalChapters: null })
  })

  it('routes targets: chapter jumps through the session, supplement opens the panel without a return handle', () => {
    const { scene, session } = makeScene()
    const chapter: ReadingTarget = { kind: 'chapter', index: 2, anchorId: 'a1' }
    scene.openTarget(chapter)
    expect(session.requestJump).toHaveBeenCalledWith('s1', 2, 'a1')
    expect(scene.state.surface).toBeNull()

    scene.openTarget(target)
    expect(scene.state.surface).toBe('supplement')
    expect(scene.state.note?.target).toBe(target)
    expect(scene.state.note?.entry).toBeNull()
  })

  it('body links capture the return handle; panel links drop the surface without consuming it', () => {
    const { scene, session } = makeScene()
    scene.bodyLink(target, 'noteref')
    expect(session.followLink).toHaveBeenCalledWith('s1', target, 'noteref')
    expect(scene.state.note?.entry).toBe(entry)

    const chapter: ReadingTarget = { kind: 'chapter', index: 1, anchorId: null }
    scene.panelLink(chapter, 'backlink')
    expect(scene.state.surface).toBeNull()
    expect(scene.state.note).toBeNull()
    expect(session.closeSupplement, '返回项归这次跟随，面板不许再消费一次').not.toHaveBeenCalled()
    expect(session.followLink).toHaveBeenLastCalledWith('s1', chapter, 'backlink')
  })

  it('notifies subscribers until they unsubscribe', () => {
    const { scene } = makeScene()
    const seen = vi.fn()
    const off = scene.subscribe(seen)
    scene.toggle('export')
    expect(seen).toHaveBeenCalledTimes(1)
    off()
    scene.toggle('export')
    expect(seen).toHaveBeenCalledTimes(1)
  })
})
