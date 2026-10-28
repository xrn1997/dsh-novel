import { describeError } from './api.js'
import type { Translate } from './copy/index.js'
import { closeAll, dismissSurface, escOwner, openSurface } from './reader-surfaces.js'
import type { ReaderSurface, SurfaceChange } from './reader-surfaces.js'
import type { ReaderSession, VisibleNode } from './reader-session.js'
import type { ShelfAddOutcome, ShelfSeatInput } from './shelf-action.js'
import { createStore } from './store.js'
import type { LinkRole, ReadingTarget, SupplementTarget } from './views/types.js'

/**
 * 阅读场景：阅读器里**互相咬合的那组界面状态**——哪一角浮层在场、注释面板的载荷与返回句柄、
 * Esc 归谁、离开时的一句入架询问、入架写入的回执——的持有者与命令面。
 *
 * 为什么独立于视图：这些律的缺陷全出在次序上（谁先退场、谁消费返回项、写完能不能被打断），
 * 而判据散在视图的 state 与闭包里时，证它们要整页渲染并伪造滚动几何。命令与 state 收在这里、
 * 无 DOM 可测，视图只渲染与接线（裁决见 `ADR-0045`）。
 *
 * 边界（别把这三样搬进来）：
 * - 阅读时序（目录→恢复→懒加载→预取→进度落盘）归 `client/reader-session.ts`；
 * - 「至多一角」与退场语义的**纯判据**归 `client/reader-surfaces.ts`，本类只把判据落成 state；
 * - 带遮罩的入架一问仍走 `client/views/dialog.tsx` 的模态契约（Esc / 焦点 / Tab 圈）。
 * 本类也不做 DOM 测量、不取数、不执行导出。
 */

/** 注释面板载荷：目标 + **开面板时压入的那条返回项**（会话给的句柄）+ 打开意图序号。
 *  `entry` 决定关闭语义：非 null = 内链打开（关闭即回引用处）；null = 目录直接点进来（只关面板）。
 *  `seq` 每次「外层重新指向」都 +1，面板内部栈按它重置（只比目标值会漏：同一脚注被点第二次时
 *  目标值不变，但期间用户可能已在面板里跟到别的文档）。 */
export interface ReaderSceneState {
  surface: ReaderSurface | null
  note: { target: SupplementTarget; entry: VisibleNode | null; seq: number } | null
  askShelf: boolean
  joinBusy: boolean
  joinError: string | null
}

export interface ReaderSceneDeps {
  session: ReaderSession
  sourceId: string
  bookKey: string
  title: string
  /** 目录总章数。**目录未到必须给 null 而不是 0**：0 会被写成架位上的真读数，并挡住会话
   *  「缺 totalChapters 才回写」的幂等补数。 */
  tocLength: () => number | null
  navigate: (to: { name: 'shelf' }) => void
  /** 加架写口（生产是 `client/shelf-action.ts` 的 `addShelfSeat`）：回执形状归它，措辞归本类 */
  addSeat: (input: ShelfSeatInput) => Promise<ShelfAddOutcome>
  pushOk: (message: string) => void
  t: Translate
}

export class ReaderScene {
  private readonly store = createStore<ReaderSceneState>({
    surface: null, note: null, askShelf: false, joinBusy: false, joinError: null,
  })
  private noteSeq = 0

  constructor(private readonly deps: ReaderSceneDeps) {}

  get state(): ReaderSceneState { return this.store.get() }

  /** 箭头属性：`useSyncExternalStore` 要求订阅函数跨渲染保持同一身份 */
  subscribe = (cb: () => void): (() => void) => this.store.subscribe(cb)

  /** 点某一角：互斥与「同一角再点是收场」都由判据给，不在这里各抄一遍 */
  toggle(surface: ReaderSurface): void {
    this.applySurface(openSurface(this.state.surface, surface))
  }

  /** 打开注释面板：序号自增（面板按它重置内部栈），目标与返回项句柄一起记下。
   *  同一角第二次进入是**换目标**，不是收场（判据那边对 `supplement` 不吃 toggle）。 */
  openNote(target: SupplementTarget, entry: VisibleNode | null): void {
    this.noteSeq += 1
    this.applySurface(openSurface(this.state.surface, 'supplement'),
      { note: { target, entry, seq: this.noteSeq } })
  }

  /** 收场（Esc 与面板「关闭」钮同一条路）：内链打开的回到引用处——位置提交与返回栈都归会话 */
  close(): void {
    const { note } = this.state
    if (note !== null) this.deps.session.closeSupplement(this.deps.sourceId, note.entry)
    this.applySurface(closeAll(this.state.surface))
  }

  /** 浮层那条 Esc。归属先问判据：模态在场时**视图那条监听根本不安装**（一次 Esc 不许既关模态
   *  又收浮层）；这里再判一次，是为了让命令自身也守得住这条律。模态的 Esc 走 `dismissAsk`。 */
  handleEsc(): void {
    if (escOwner(this.state.surface, this.state.askShelf) !== 'surface') return
    this.close()
  }

  /** 收回入架一问的唯一判据：写完不许被 Esc 或遮罩打断（钮已禁用，但通道还在） */
  dismissAsk(): void {
    if (this.state.joinBusy) return
    this.set({ askShelf: false })
  }

  /** 目标分发：主序列目标走会话跳章（含章内锚点），补充文档开注释面板。
   *  **目录点击是纯导航**（不押返回项）——只有正文内链才建立「返回原处」。 */
  openTarget(target: ReadingTarget): void {
    if (target.kind === 'chapter') {
      this.deps.session.requestJump(this.deps.sourceId, target.index, target.anchorId)
      return
    }
    this.openNote(target, null)                          // 目录进来：没有引用处可回
  }

  /** 正文内链：先由会话采点/消费返回项，再按目标分流。角色必须带过去——`backlink` 本身就是
   *  「回正文」，会话据此不压新栈；采点返回的那条随面板记下，关闭时只说「消费我打开面板时压的那条」。 */
  bodyLink(target: ReadingTarget, role: LinkRole): void {
    const entry = this.deps.session.followLink(this.deps.sourceId, target, role)
    if (target.kind === 'supplement') this.openNote(target, entry)
  }

  /** 注释面板里点到主序列：面板退场、由会话跳。这条退场**不消费返回项**（`dismissSurface`
   *  的 `hide` 那一档）——返回项归这次跟随，会话自己采与消费，面板不许再消费一次。 */
  panelLink(target: ReadingTarget, role: LinkRole): void {
    this.applySurface(dismissSurface())
    this.deps.session.followLink(this.deps.sourceId, target, role)
  }

  /** 离开阅读器回书架：这本书**不在架上**时先问一句要不要加入。在架与「问不到」都不问——
   *  书架拉不到是「不知道」，不是「没有」，不许拿不知道拦用户。
   *  为什么不在「读这本」那一刻静默加：书城那一层刻意把「加入书架」与「读这本」分成两个动作
   *  （`ADR-0028`），静默代劳就是替用户做一个他没要过的写操作。
   *  不问会丢什么：不在架的书，进度 PUT 被服务端判 `NOT_ON_SHELF`，`saveProgress` 咽掉那句 400 ⇒
   *  这一屏读到哪儿就此消失。先入架再离开，会话 dispose 那一次 flush 才落得到地上。 */
  exitToShelf(): void {
    if (this.deps.session.onShelf === 'off') {
      this.set({ joinError: null, askShelf: true })
      return
    }
    this.deps.navigate({ name: 'shelf' })
  }

  /** 「加入书架并返回」：写成功后才离开（失败把话留在问它的那一层，用户可重试也可先不走）。
   *  写口由 `addSeat` 注入（生产是整仓唯一那一发 `shelf-action.addShelfSeat`）；书目字段只带阅读器
   *  问得到的那几样（书名来自进入参数、总章数来自目录），其余一律缺席——缺的整段不出现，比拿猜出来
   *  的作者/封面填进架子诚实。失败**只**落 `joinError`（模态内联）；不散落全局条，那里是第二个家。 */
  async joinAndBack(): Promise<void> {
    this.set({ joinBusy: true, joinError: null })
    const outcome = await this.deps.addSeat({
      sourceId: this.deps.sourceId,
      url: this.deps.bookKey,
      title: this.deps.title,
      totalChapters: this.deps.tocLength(),
    })
    this.set({ joinBusy: false })
    if (!outcome.ok) {
      this.set({ joinError: describeError(outcome.error, this.deps.t) })
      return
    }
    this.set({ askShelf: false })
    this.deps.pushOk(this.deps.t('reader.join.ok', { title: this.deps.title }))
    this.deps.navigate({ name: 'shelf' })
  }

  /** 换面只走这一条：判据在 `client/reader-surfaces.ts`，这里负责把退场语义落成 state。
   *  面与载荷一次写齐（`patch` 最后合）：分两次通知会让订阅者读到「面已开、载荷还是上一条」的
   *  中间态——「面板开着就得带载荷」这条前提不该靠 React 的批处理来兜。 */
  private applySurface(change: SurfaceChange, patch?: Partial<ReaderSceneState>): void {
    this.set({
      surface: change.surface,
      // `keep` = 注释面板换目标，载荷由调用方给；其余退场语义都不留载荷
      ...(change.supplement === 'keep' ? {} : { note: null }),
      ...patch,
    })
  }

  private set(patch: Partial<ReaderSceneState>): void {
    this.store.set(patch)
  }
}
