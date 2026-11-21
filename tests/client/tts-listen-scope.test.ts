// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { listenScopeOf } from '../../src/client/tts/listen-scope.js'
import type { ListenScopeLive } from '../../src/client/tts/listen-scope.js'
import { resetTtsPlayerForTests, ttsPlayer } from '../../src/client/tts/player.js'
import { useListenScope } from '../../src/client/tts/use-listen-scope.js'

/**
 * 听书范围的钉子：「这次听的是不是这本书」只此一处判，视图与跟读策略都读同一只 scope。
 * 可暂停读数（`isPlayBusy` 的成品）由视图交进来，纯函数只做本次会话的合取；取数口那一条
 * 另钉「从播放层 store 拼出来的就是同一只投影」。
 */
const live = (over: Partial<ListenScopeLive> = {}): ListenScopeLive => ({
  active: true, bookKey: 'k1', chapterIndex: 2, paragraphIndex: 5, playBusy: false, ...over,
})

describe('听书范围投影', () => {
  it('会话在且书键匹配 → showing，章段号原样给出', () => {
    expect(listenScopeOf(live(), 'k1')).toEqual({
      showing: true, active: true, busy: false, chapterIndex: 2, paragraphIndex: 5,
    })
  })

  it('会话不在 / 听的是别人的书 → showing 假，章段号归 -1（调用点不必再判一次）', () => {
    expect(listenScopeOf(live({ active: false }), 'k1')).toEqual({
      showing: false, active: false, busy: false, chapterIndex: -1, paragraphIndex: -1,
    })
    // 别人的会话照旧是「活的」，但范围不是本书的：active 保留，章段号不借给本书
    expect(listenScopeOf(live({ bookKey: 'other', playBusy: true }), 'k1')).toEqual({
      showing: false, active: true, busy: false, chapterIndex: -1, paragraphIndex: -1,
    })
  })

  it('可暂停只在本次会话内透传（别人在播不把本书 pill 变成暂停）', () => {
    expect(listenScopeOf(live({ playBusy: true }), 'k1').busy).toBe(true)
    expect(listenScopeOf(live({ playBusy: true, bookKey: 'other' }), 'k1').busy).toBe(false)
    // 策略面不交可暂停读数：缺席按不在忙算，showing 不受影响
    expect(listenScopeOf({ active: true, bookKey: 'k1' }, 'k1')).toEqual({
      showing: true, active: true, busy: false, chapterIndex: -1, paragraphIndex: -1,
    })
  })
})

describe('useListenScope：播放层 store 的取数口', () => {
  it('本次会话原样上屏；换成别的书即 showing 假、章段号 -1、忙态不借', () => {
    const h = renderHook(() => useListenScope('k1'))
    try {
      expect(h.result.current.showing).toBe(false)
      act(() => {
        ttsPlayer.set({
          active: true, bookKey: 'k1', chapterIndex: 3, paragraphIndex: 7,
          playing: true, loading: false,
        })
      })
      expect(h.result.current).toMatchObject({
        showing: true, active: true, busy: true, chapterIndex: 3, paragraphIndex: 7,
      })
      act(() => { ttsPlayer.set({ bookKey: 'other' }) })
      expect(h.result.current).toMatchObject({
        showing: false, active: true, busy: false, chapterIndex: -1, paragraphIndex: -1,
      })
    } finally {
      act(() => { resetTtsPlayerForTests() })
      h.unmount()
    }
  })
})
