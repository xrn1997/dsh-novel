import { describe, expect, it } from 'vitest'
import { BytesOutput } from '../../src/client/tts/bytes-output.js'
import type { AudioSlot } from '../../src/client/tts/bytes-output.js'
import type { OutputHandlers } from '../../src/client/tts/output-contract.js'

/**
 * 出声面（字节型）写进 Audio 元素的那一件新事实：**补速随段走**。
 * 语速是用户的请求，字节里掺了多少由引擎决定（回执报的那一格）——播放端漏写一次，
 * 那一段就悄悄回到 1.0x，而屏上的语速读数没变。这里只钉「写没写、换段重不重设」，
 * 其余窄镜像成员按需占位（被越界调用不会静默通过：FakeSlot 的成员就是镜像的键集）。
 */

class FakeSlot implements AudioSlot {
  src = ''
  volume = 1
  playbackRate = 1
  preload = ''
  currentTime = 0
  readonly duration = 12
  paused = true
  onended: ((...args: never[]) => void) | null = null
  onerror: ((...args: never[]) => void) | null = null
  onplaying: ((...args: never[]) => void) | null = null
  ontimeupdate: ((...args: never[]) => void) | null = null
  onloadedmetadata: ((...args: never[]) => void) | null = null

  play(): unknown { this.paused = false; return undefined }
  pause(): void { this.paused = true }
  removeAttribute(name: string): void { if (name === 'src') this.src = '' }
  load(): void { /* 假元素不重新解码 */ }
}

function fakeFace(): { create(): AudioSlot; created: FakeSlot[] } {
  const created: FakeSlot[] = []
  return {
    created,
    create(): AudioSlot {
      const slot = new FakeSlot()
      created.push(slot)
      return slot
    },
  }
}

const quiet: OutputHandlers = { done: () => undefined, fail: () => undefined }

describe('BytesOutput 的播放倍率', () => {
  it('起一段：回执报的补速原样写进元素（含音量一并落）', () => {
    const face = fakeFace()
    new BytesOutput(face).start({ key: 'a', volume: 0.8, playbackRate: 1.5, resume: false }, quiet)
    expect(face.created).toHaveLength(1)
    expect(mustSlot(face, 0).playbackRate).toBe(1.5)
    expect(mustSlot(face, 0).volume).toBe(0.8)
  })

  it('换段重设补速：同一只槽接着放下一段，倍率跟着换档', () => {
    const face = fakeFace()
    const out = new BytesOutput(face)
    out.start({ key: 'a', volume: 1, playbackRate: 1.5, resume: false }, quiet)
    out.start({ key: 'b', volume: 1, playbackRate: 2, resume: false }, quiet)
    expect(mustSlot(face, 0).playbackRate, '不换槽时也要重设').toBe(2)
  })

  it('回到原速也照写：从 1.5x 的段换到 1x 的段，不许把上一段的倍率留在元素上', () => {
    const face = fakeFace()
    const out = new BytesOutput(face)
    out.start({ key: 'a', volume: 1, playbackRate: 1.5, resume: false }, quiet)
    out.start({ key: 'b', volume: 1, playbackRate: 1, resume: false }, quiet)
    expect(mustSlot(face, 0).playbackRate).toBe(1)
  })

  it('原地续播同样带上补速：暂停续上的那一段不该忽然变慢', () => {
    const face = fakeFace()
    const out = new BytesOutput(face)
    out.start({ key: 'a', volume: 1, playbackRate: 1.5, resume: false }, quiet)
    out.pause()
    const slot = mustSlot(face, 0)
    slot.playbackRate = 1                      // 演「元素上的值被动过」
    out.start({ key: 'a', volume: 0.5, playbackRate: 1.5, resume: true }, quiet)
    expect(slot.playbackRate, '续播路径也要重设').toBe(1.5)
  })

  it('预载只接 src，不抢当前段的倍率', () => {
    const face = fakeFace()
    const out = new BytesOutput(face)
    out.start({ key: 'a', volume: 1, playbackRate: 1.5, resume: false }, quiet)
    out.preload('b')
    expect(mustSlot(face, 0).playbackRate, '活槽仍是这一段').toBe(1.5)
    expect(mustSlot(face, 1).src).not.toBe('')
    out.start({ key: 'b', volume: 1, playbackRate: 2, resume: false }, quiet)
    expect(mustSlot(face, 1).playbackRate, '换到预载槽后按新段设').toBe(2)
  })
})

/** 第 n 只造出来的槽（`created` 按 `ensure` 的顺序收）。 */
function mustSlot(face: { created: FakeSlot[] }, index: number): FakeSlot {
  const slot = face.created[index]
  if (slot === undefined) throw new Error(`夹具缺第 ${index} 只槽`)
  return slot
}
