import { describeError } from './api.js'
import type { Translate } from './copy/index.js'
import { closeAll, dismissSurface, escOwner, maskFor, openSurface } from './reader-surfaces.js'
import type { EscOwner, ReaderSurface, SurfaceChange } from './reader-surfaces.js'
import type { ReaderSession, VisibleNode } from './reader-session.js'
import type { ShelfAddOutcome, ShelfSeatInput } from './shelf-action.js'
import { createStore } from './store.js'
import type { LinkRole, ReadingTarget, SupplementTarget } from './views/types.js'

/**
 * 阅读场景：阅读器里**互相咬合的那组界面状态**——哪一角浮层在场、注释面板的载荷与返回句柄、
 * Esc 归谁、离开时的一句入架询问、入架写入的回执——的持有者与命令面。
 *
 * 为什么独立于视图：缺陷全出在次序上（谁先退场、谁消费返回项、写完能不能被打断），判据散在
 * 视图 state 里时证它们要整页渲染；命令与 state 收在这里、无 DOM 可测。边界：阅读时序归
 * `reader-session.ts`，「至多一角」的纯判据归 `reader-surfaces.ts`，入架一问的模态契约归 `dialog.tsx`。
 */

/** 注释面板载荷：目标 + **开面板时压入的那条返回项**（句柄）+ 意图序号。`entry` 决定关闭语义
 *  （非 null = 内链打开，关闭即回引用处）；`seq` 每次外层重新指向都 +1，面板内部栈按它重置。 */
export interface ReaderSceneState {
  surface: ReaderSurface | null
  note: { target: SupplementTarget; entry: VisibleNode | null; seq: number } | null
  askShelf: boolean
  joinBusy: boolean
  joinError: string | null
  /** 纯判据的两枚投影：每次写入按合并后的 surface/askShelf 重算，与状态同一笔通知 */
  mask: boolean
  escOwner: EscOwner
}

export interface ReaderSceneDeps {
  session: ReaderSession
  sourceId: string
  bookKey: string
  title: string
  /** 目录总章数。**目录未到必须给 null 而不是 0**：0 会被写成架位上的真读数，并挡住幂等补数。 */
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
    mask: false, escOwner: 'none',
  })
  private readonly deps: ReaderSceneDeps
  private noteSeq = 0

  constructor(deps: ReaderSceneDeps) { this.deps = deps }

  get state(): ReaderSceneState { return this.store.get() }

  /** 箭头属性：`useSyncExternalStore` 要求订阅函数跨渲染保持同一身份 */
  subscribe = (cb: () => void): (() => void) => this.store.subscribe(cb)

  /** 点某一角：互斥与「同一角再点是收场」都由判据给，不在这里各抄一遍 */
  toggle(surface: ReaderSurface): void {
    this.applySurface(openSurface(this.state.surface, surface))
  }

  /** 打开注释面板：序号自增（面板按它重置内部栈），目标与返回项句柄一起记下。同一角第二次进入是**换目标**。 */
  openNote(target: SupplementTarget, entry: VisibleNode | null): void {
    this.noteSeq += 1
    this.applySurface(openSurface(this.state.surface, 'supplement'),
      { note: { target, entry, seq: this.noteSeq } })
  }

  /** 这次收场会不会真的返回引用处：视图据此决定跟读要不要让位；栈顶已不是它时关闭只收浮层、不导航。 */
  willReturnOnClose(): boolean {
    const { note } = this.state
    return note !== null && this.deps.session.returnTopIs(note.entry)
  }

  /** 收场（Esc 与面板「关闭」钮同一条路）：内链打开的回到引用处——位置提交与返回栈都归会话 */
  close(): void {
    const { note } = this.state
    if (note !== null) this.deps.session.closeSupplement(note.entry)
    this.applySurface(closeAll(this.state.surface))
  }

  /** 浮层那条 Esc：模态在场时视图那条监听根本不装（一次 Esc 不许既关模态又收浮层），这里再判一次。
   *  模态的 Esc 走 `dismissAsk`。 */
  handleEsc(): void {
    if (this.state.escOwner !== 'surface') return
    this.close()
  }

  /** 收回入架一问的唯一判据：写完不许被 Esc 或遮罩打断（钮已禁用，但通道还在） */
  dismissAsk(): void {
    if (this.state.joinBusy) return
    this.set({ askShelf: false })
  }

  /** 目标分发：主序列目标走会话跳章（含章内锚点），补充文档开注释面板。**目录点击是纯导航**，不押返回项。 */
  openTarget(target: ReadingTarget): void {
    if (target.kind === 'chapter') {
      this.deps.session.requestJump(target.index, target.anchorId)
      return
    }
    this.openNote(target, null)                          // 目录进来：没有引用处可回
  }

  /** 正文内链：先由会话采点/消费返回项，再按目标分流。`backlink` 本身就是「回正文」，会话据此不压新栈。 */
  bodyLink(target: ReadingTarget, role: LinkRole): void {
    const entry = this.deps.session.followLink(target, role)
    if (target.kind === 'supplement') this.openNote(target, entry)
  }

  /** 注释面板里点到主序列：面板退场、由会话跳。这条退场**不消费返回项**（返回项归这次跟随，会话自己采与消费）。 */
  panelLink(target: ReadingTarget, role: LinkRole): void {
    this.applySurface(dismissSurface())
    this.deps.session.followLink(target, role)
  }

  /** 离开阅读器回书架：这本书**不在架上**时先问一句。「问不到」不问——书架拉不到是不知道，不是没有。
   *  不静默代劳（书城把「加入书架」与「读这本」分成两个动作，`ADR-0028`）；不问会丢进度：不在架的
   *  书进度 PUT 被判 `NOT_ON_SHELF`，这一屏读到哪儿就此消失。 */
  exitToShelf(): void {
    if (this.deps.session.onShelf === 'off') {
      this.set({ joinError: null, askShelf: true })
      return
    }
    this.deps.navigate({ name: 'shelf' })
  }

  /** 「加入书架并返回」：写成功后才离开（失败把话留在问它的那一层）。书目字段只带阅读器问得到的
   *  那几样，其余一律缺席——缺的整段不出现，比拿猜出的作者/封面填进架子诚实。失败**只**落 `joinError`。 */
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

  /** 换面只走这一条：判据在 `reader-surfaces.ts`，这里把退场语义落成 state。面与载荷一次写齐——
   *  分两次通知会让订阅者读到「面已开、载荷还是上一条」的中间态。 */
  private applySurface(change: SurfaceChange, patch?: Partial<ReaderSceneState>): void {
    this.set({
      surface: change.surface,
      // `keep` = 注释面板换目标，载荷由调用方给；其余退场语义都不留载荷
      ...(change.supplement === 'keep' ? {} : { note: null }),
      ...patch,
    })
  }

  private set(patch: Partial<ReaderSceneState>): void {
    // 两枚投影按合并后的状态重算、与 patch 同一笔写入：订阅者不会读到「面已换、遮罩/归属还是上一面」。
    const next = { ...this.state, ...patch }
    this.store.set({ ...patch, mask: maskFor(next.surface), escOwner: escOwner(next.surface, next.askShelf) })
  }
}
