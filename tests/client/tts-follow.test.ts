import { describe, expect, it, vi } from 'vitest'
import { createFollowController } from '../../src/client/tts/follow-controller.js'
import type { FollowLive } from '../../src/client/tts/follow-controller.js'

/**
 * 跟读策略的行为网（零 React / 零 DOM）：只钉「什么时候 reveal、用哪个 target、
 * 要不要写位置」；阅读器视图与会话的接线另有整页用例。
 */
const live = (over: Partial<FollowLive> = {}): FollowLive => ({
  active: true, bookKey: 'k1', chapterIndex: 0, paragraphIndex: 1, ...over,
})

function make() {
  const reveal = vi.fn()
  const cancel = vi.fn()
  const controller = createFollowController({ bookKey: 'k1', reveal, cancel })
  return { controller, reveal, cancel }
}

describe('跟读 controller：跟随 / 让位 / 重接', () => {
  it('起播第一次落位是显式顶对齐；同一段不重复落，推进后才转跟读', () => {
    const { controller, reveal } = make()
    controller.onPlayback(live(), 40)
    expect(reveal).toHaveBeenCalledWith(
      { index: 0, paragraphIndex: 1 },
      { mode: 'locate', write: true, bottomInset: 40 },
    )
    reveal.mockClear()
    controller.onPlayback(live(), 40)
    expect(reveal, '同一段再拍不再制造一次落位').not.toHaveBeenCalled()
    controller.onPlayback(live({ paragraphIndex: 2 }), 40)
    expect(reveal).toHaveBeenCalledWith(
      { index: 0, paragraphIndex: 2 },
      { mode: 'follow', write: true, bottomInset: 40 },
    )
    reveal.mockClear()
    controller.onPlayback(live({ paragraphIndex: 5 }), 40)
    expect(reveal, '滑杆/回退这类非下一段跳转：显式顶对齐').toHaveBeenCalledWith(
      { index: 0, paragraphIndex: 5 },
      { mode: 'locate', write: true, bottomInset: 40 },
    )
    reveal.mockClear()
    controller.onPlayback(live({ active: false }), 0)
    controller.onPlayback(live({ bookKey: 'other' }), 0)
    expect(reveal).not.toHaveBeenCalled()
  })

  it('回阅读器的段快照只消费一次：先按它顶对齐且不写位置，下一拍才跟 live', () => {
    const { controller, reveal } = make()
    controller.onRelocation({ index: 1, paragraphIndex: 2 })
    controller.onPlayback(live({ chapterIndex: 1, paragraphIndex: 3 }), 0)
    expect(reveal).toHaveBeenLastCalledWith(
      { index: 1, paragraphIndex: 2 },
      { mode: 'locate', write: false, bottomInset: 0 },
    )
    controller.onPlayback(live({ chapterIndex: 1, paragraphIndex: 3 }), 0)
    expect(reveal).toHaveBeenLastCalledWith(
      { index: 1, paragraphIndex: 3 },
      { mode: 'follow', write: true, bottomInset: 0 },
    )
  })

  it('读者接管即让位并撤销在途落位；定位按钮重新接上并顶对齐', () => {
    const { controller, reveal, cancel } = make()
    controller.onUserIntent()
    expect(cancel).toHaveBeenCalledTimes(1)
    controller.onPlayback(live({ paragraphIndex: 4 }), 0)
    expect(reveal).not.toHaveBeenCalled()

    controller.onLocate(live({ paragraphIndex: 5 }), 12)
    expect(reveal).toHaveBeenCalledWith(
      { index: 0, paragraphIndex: 5 },
      { mode: 'locate', write: true, bottomInset: 12 },
    )
    reveal.mockClear()
    controller.onPlayback(live({ paragraphIndex: 6 }), 0)
    expect(reveal).toHaveBeenCalledWith(
      { index: 0, paragraphIndex: 6 },
      { mode: 'follow', write: true, bottomInset: 0 },
    )
  })

  it('会话撤场丢掉过期 relocation；再起播不拿旧书目标落位', () => {
    const { controller, reveal } = make()
    controller.onRelocation({ index: 1, paragraphIndex: 2 })
    controller.onSessionChange(false)
    controller.onPlayback(live({ active: false }), 0)
    expect(reveal).not.toHaveBeenCalled()

    controller.onPlayback(live({ chapterIndex: 0, paragraphIndex: 0 }), 0)
    expect(reveal).toHaveBeenCalledWith(
      { index: 0, paragraphIndex: 0 },
      { mode: 'locate', write: true, bottomInset: 0 },
    )
  })

  it('换书后旧 relocation 也丢掉：现场不是本书时不消费', () => {
    const { controller, reveal } = make()
    controller.onRelocation({ index: 1, paragraphIndex: 2 })
    controller.onPlayback(live({ bookKey: 'other' }), 0)
    controller.onPlayback(live(), 0)
    expect(reveal).toHaveBeenLastCalledWith(
      { index: 0, paragraphIndex: 1 },
      { mode: 'locate', write: true, bottomInset: 0 },
    )
  })
})