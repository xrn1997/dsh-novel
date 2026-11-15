import { ttsAudioUrl } from '../../shared/wire.js'
import type { BytesListenOutput, BytesSegment, OutputHandlers } from './output-contract.js'

/**
 * 字节型出声适配器：两槽预载 + 换槽起播的全部现场（槽、键、预载记录）都住这里。
 * 失败上报共用同一枚会话 token：起一段就重接一次 `onerror`，旧闭包攥着旧 token，
 * 迟到的事件死在会话的代际守卫上，不会把下一段再记一次失败。
 *
 * **真开口**是两条证据：活槽的 `playing` 事件，与 `play()` 承诺落地（规范里它同样表示播放已开始）。
 * 起一段只是把加载交出去——404、解码失败、自动播放被拒都发生在之后；会话的清连败与「在放」
 * 只能从这两条证据来。两条都到也无妨：会话侧的 start 只写读数，幂等。
 *
 * 预载槽的 `error` 也要接：不接就只有「下一段起播时再撞一次」，而且旧键会让 `start` 以为
 * 槽里还是可用字节、跳过重设 `src`。预载失败即清掉该槽键与预载记录，下一段重新赋 `src`。
 *
 * `AudioSlot` / `AudioFace` 是 Audio 的**窄镜像**：只收会话真正消费的那一面，不让 lib.dom 的
 * 宽声明替运行时作保。生产面（懒取全局、把原生元素交回来）住 `player.ts`。
 */

/** 一只出声槽（Audio 的窄镜像）：只收会话真正消费的那一面。五个事件属性刻意收成
 *  「不挑参数」的窄形状：真元素的处理器声明带事件参数、比这宽，不这样收，生产面就没法把
 *  原生元素原样交回来（本地窄镜像，同 `client/util.ts` 的 `ls`）。 */
export interface AudioSlot {
  src: string
  volume: number
  preload: string
  currentTime: number
  readonly duration: number
  readonly paused: boolean
  onended: ((...args: never[]) => void) | null
  onerror: ((...args: never[]) => void) | null
  onplaying: ((...args: never[]) => void) | null
  ontimeupdate: ((...args: never[]) => void) | null
  onloadedmetadata: ((...args: never[]) => void) | null
  play(): unknown
  pause(): void
  removeAttribute(name: string): void
  load(): void
}

/** 音频槽的创建面：`create` 惰性触达全局（调用时取，不在构造时捕获）。 */
export interface AudioFace { create(): AudioSlot }

type Slot = 0 | 1

function otherSlot(slot: Slot): Slot {
  return slot === 0 ? 1 : 0
}

export class BytesOutput implements BytesListenOutput {
  private readonly face: AudioFace
  private readonly slots: [AudioSlot | null, AudioSlot | null] = [null, null]
  /** 每只槽当前装的是哪枚缓存键（`el.src` 是绝对 URL，不能拿来比对契约里的相对 URL）。 */
  private readonly keys: [string | null, string | null] = [null, null]
  private active: Slot = 0
  /** 预载槽里那段的缓存键：推进时若正好是它，直接换槽播放。 */
  private preloaded: string | null = null
  private handlers: OutputHandlers | null = null

  constructor(face: AudioFace) {
    this.face = face
  }

  start(seg: BytesSegment, handlers: OutputHandlers): void {
    this.handlers = handlers
    if (seg.resume && this.keys[this.active] === seg.key) {
      // 原地续播：不重设 src、不把播放头拨回 0，暂停前听到哪儿就从哪儿接上
      const element = this.ensure(this.active)
      element.volume = seg.volume
      this.bind(element, this.active, handlers)
      this.play(element, handlers)
      return
    }
    let slot = this.active
    if (this.preloaded === seg.key && this.keys[otherSlot(this.active)] === seg.key) {
      slot = otherSlot(this.active)
    }
    // 换槽起播前必须先让旧槽闭嘴：预载只给另一只接上 src，旧段仍在自己那只里念着，
    // 用户按「下一段」听到的就是两句叠音。同槽路径靠重设 src 天然停掉旧段，换槽不会。
    if (slot !== this.active) this.slots[this.active]?.pause()
    this.active = slot
    this.preloaded = null
    const element = this.ensure(slot)
    if (this.keys[slot] !== seg.key) {
      element.src = ttsAudioUrl(seg.key)
      this.keys[slot] = seg.key
    }
    element.currentTime = 0
    element.volume = seg.volume
    this.bind(element, slot, handlers)
    this.play(element, handlers)
  }

  pause(): void {
    for (const slot of [0, 1] as const) this.slots[slot]?.pause()
  }

  stop(): void {
    for (const slot of [0, 1] as const) {
      const element = this.slots[slot]
      if (element !== null) {
        element.pause()
        // 松开这一段的缓冲：`src` 还指着那枚音频 URL 时，浏览器会替页面留着已取到的字节。
        // 摘 src 用 removeAttribute + load（把 src 赋成空串会被当成一次空 URL 加载并报错）。
        element.removeAttribute('src')
        element.load()
      }
      this.keys[slot] = null
    }
    this.active = 0
    // 预载记录随会话（run）作废：停过的下一趟没有可换的槽，留着只会被键判据挡下
    this.preloaded = null
  }

  release(): void {
    this.stop()
    this.slots[0] = null
    this.slots[1] = null
  }

  /** 失效重来：清掉两只槽的键与预载记录，并把介质松开（`removeAttribute` + `load`，与 `stop`
   *  同一对——只清键不松开，errored 元素仍是坏状态）。自愈路径在重取回执前调它：键按内容寻址
   *  不会变，不清键 `start` 就会跳过重设 `src`，对着一个已报错的元素再 `play()` 只会再拒。 */
  invalidate(): void {
    for (const slot of [0, 1] as const) {
      const element = this.slots[slot]
      if (element !== null) {
        element.pause()
        element.removeAttribute('src')
        element.load()
      }
      this.keys[slot] = null
    }
    this.preloaded = null
  }

  setVolume(volume: number): void {
    const element = this.slots[this.active]
    if (element !== null) element.volume = volume
  }

  preload(key: string): void {
    const slot = otherSlot(this.active)
    const element = this.ensure(slot)
    if (this.keys[slot] !== key) {
      // 预载失败不静默：清掉该槽的键与预载记录，下一段起播会重新赋 src，而不是对着一个
      // 已经 errored 的元素调 play（那种元素不 load() 只会再拒）。
      element.onerror = () => { this.forgetPreload(slot, key) }
      element.src = ttsAudioUrl(key)
      this.keys[slot] = key
    }
    this.preloaded = key
  }

  dropPreload(): void {
    this.preloaded = null
  }

  holds(key: string): boolean {
    return this.keys[this.active] === key
  }

  /** 槽只在第一次出声 / 预载时才建：Audio 是懒造的，构造面本身不碰全局。 */
  private ensure(slot: Slot): AudioSlot {
    const existing = this.slots[slot]
    if (existing !== null) return existing
    const element = this.face.create()
    element.preload = 'auto'
    element.onended = () => {
      // 段播完只认活槽：预载槽的事件不推进会话
      if (slot !== this.active) return
      this.handlers?.done()
    }
    element.ontimeupdate = () => { this.publish(slot, element) }
    element.onloadedmetadata = () => { this.publish(slot, element) }
    this.slots[slot] = element
    return element
  }

  private bind(element: AudioSlot, slot: Slot, handlers: OutputHandlers): void {
    element.onerror = () => { handlers.fail() }
    // 只认活槽：预载槽的 playing 是另一段的事；迟到的旧槽事件死在会话的代际守卫上
    element.onplaying = () => {
      if (slot !== this.active) return
      handlers.start?.()
    }
  }

  /** 预载槽加载失败：清键与预载记录（不动活槽）。记录清掉后，推进到这一段时 `start` 会重新
   *  赋 `src` 并走正常失败径，不会因为「键看着还在」而静默把一段坏字节播成无声。 */
  private forgetPreload(slot: Slot, key: string): void {
    if (slot === this.active) return
    if (this.keys[slot] === key) this.keys[slot] = null
    if (this.preloaded === key) this.preloaded = null
  }

  /** 起播的两种失败都要落到失败径：`play()` 的同步抛出由调用方接，Promise 拒绝
   *  （自动播放被拦等）走这里；与 `error` 事件（404 / 解码失败）共用同一枚会话 token。
   *  承诺落地同样报「已开口」：规范里它表示播放已开始，是 `onplaying` 之外的第二条证据。 */
  private play(element: AudioSlot, handlers: OutputHandlers): void {
    const played = element.play()
    void Promise.resolve(played).then(
      () => { handlers.start?.() },
      () => { handlers.fail() },
    )
  }

  /** 段进度只认活槽：预载槽的 metadata / timeupdate 不该把下一段的读数投到当前滑杆上。 */
  private publish(slot: Slot, element: AudioSlot): void {
    if (slot !== this.active) return
    const duration = Number.isFinite(element.duration) ? element.duration : 0
    // currentTime 在极少数平台/时机读成 NaN；NaN 进滑杆的 value 会让 React 写出非法样式
    const position = Number.isFinite(element.currentTime) ? Math.max(0, element.currentTime) : 0
    this.handlers?.progress?.(position, duration)
  }
}