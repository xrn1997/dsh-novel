import type { ISessions, SessionReference, SessionRetainOptions, SessionTarget } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ConversationBinding } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { MoyuHostPort } from '../../src/client/moyu-host.js'

/**
 * 宿主公开服务面的假体（`tests/client/fake-host.ts` 先例）。判据是宿主契约的「exactly what a
 * test fake must supply」口径：`ISessions` / `IWorkspaces` 按**真实接口**实现（implements 钉住形状），
 * 宿主契约改形状时这里先红——窄镜像抄本抓不到这种漂移。
 *
 * 行为面只做被测编排用得到的几格：`openWorkspace` 记一次入口并同步回调 `beforeOpen`（宿主同款：
 * 被后续导航取代时回调不跑）、`retain` 出可释放的引用与引用计数、`chat` 投影出可推送的快照、
 * `workspaces.list` 出可订阅行。**投递面一概不接**：本仓不再代发消息，假体里出现投递就是越界。
 */

/** 镜像进料的窄测试形状（`ADR-0020` 窄镜像：宿主 `ChatSnapshot` 不进类型路径，形状守卫在投影层）。 */
export interface FakeChatNode {
  key: string
  /** 缺席＝形状漂移档（镜像的「该轮降级」用例）。 */
  kind?: string
  data?: unknown
  visibility?: 'visible' | 'hidden'
  /** 宿主轮号（fake 拼进 `location.turn.turn`；`data.turn` 同时可测两条读路）。 */
  turn?: number
}

/** 镜像读取口只用 `target('chat')`：这里把窄形状标成宿主 binding 类型（形状守卫在投影层）。 */
function asBinding(value: unknown): ConversationBinding {
  return value as ConversationBinding
}

function notWired(what: string): never {
  throw new Error(`fake-moyu-host: ${what} 未接线（用例没打算走这格）`)
}

/** 无类型快照面（chat target）：宿主同款「快照变即推」语义，订阅回调不带实参。 */
class FakeProjectionSource {
  private readonly listeners = new Set<() => void>()
  private snapshot: unknown = undefined

  getSnapshot(): unknown {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 测试推手：换快照并通知订阅者。 */
  push(value: unknown): void {
    this.snapshot = value
    for (const listener of [...this.listeners]) listener()
  }
}

export class FakeSessions implements ISessions {
  /** retain 的来源标签记账（宿主引用身份约定；`moyuStage` 是本仓登记的那枚标签）。 */
  readonly retains: Array<{ sessionId: string; source: string }> = []
  /** 各代际当前存活引用数：入口会话应恰好留一份长持。 */
  private readonly retained = new Map<string, number>()
  private readonly chatBySession = new Map<string, FakeProjectionSource>()

  /** 会话枚举面只出空行（入口编排不读会话清单）；形状按宿主快照面的窄镜像。 */
  readonly list: { getSnapshot(): { items: unknown[] }; subscribe(listener: () => void): () => void } = {
    getSnapshot: () => ({ items: [] }),
    subscribe: () => () => undefined,
  }

  readonly searchResultLimit = 20

  retainedCount(sessionId: string): number {
    return this.retained.get(sessionId) ?? 0
  }

  private projectionOf(sessionId: string): FakeProjectionSource {
    let source = this.chatBySession.get(sessionId)
    if (source === undefined) {
      source = new FakeProjectionSource()
      this.chatBySession.set(sessionId, source)
    }
    return source
  }

  retain(target: SessionTarget, options: SessionRetainOptions): SessionReference {
    const id = typeof target === 'string' ? target : 'subagent-address'
    this.retains.push({ sessionId: id, source: options.source })
    this.retained.set(id, (this.retained.get(id) ?? 0) + 1)
    const reference = {
      sessionId: target,
      // 入口编排只借 `sessions.retain` 的持有语义；轮次读取走 `uiConversation.binding`（宿主同款分工）。
      binding: undefined,
      ready: Promise.resolve({}),
      release: () => {
        const count = Math.max(0, (this.retained.get(id) ?? 1) - 1)
        if (count === 0) this.retained.delete(id)
        else this.retained.set(id, count)
      },
      [Symbol.dispose]: () => undefined,
    }
    return reference as unknown as SessionReference
  }

  /** 测试推手：推一份 chat 快照（真轮次镜像的进料）。`kind` 缺席＝形状漂移档（测降级）。 */
  pushChatSnapshot(sessionId: string, nodes: readonly FakeChatNode[]): void {
    const byKey = new Map(nodes.map((node) => [node.key, {
      ...(node.kind === undefined ? {} : { kind: node.kind }),
      data: node.data,
      visibility: node.visibility ?? 'visible',
      location: node.turn === undefined ? { kind: 'unresolved' } : { kind: 'turn', turn: { turn: node.turn } },
    }]))
    this.projectionOf(sessionId).push({
      order: nodes.map((node) => node.key),
      nodes: { get: (key: string) => byKey.get(key) },
    })
  }

  /** `uiConversation.binding(...)` 的假体：`target('chat')` 出可推送的镜像快照面（其余 target 不供）。 */
  uiBinding(sessionId: unknown): { target(name: string): FakeProjectionSource | undefined } {
    return {
      target: (name: string) => (name === 'chat' ? this.projectionOf(String(sessionId)) : undefined),
    }
  }

  /* 投递面一律不接：本仓不再代发消息，触到即炸（越界要立刻显形）。 */
  create = (): never => notWired('sessions.create')
  scope = (): never => notWired('sessions.scope')
  binding = (): never => notWired('sessions.binding')
  using = (): never => notWired('sessions.using')
  retainInfo = (): never => notWired('sessions.retainInfo')
  refreshProjections = (): never => notWired('sessions.refreshProjections')
  refresh = (): never => notWired('sessions.refresh')
  search = (): never => notWired('sessions.search')
  fork = (): never => notWired('sessions.fork')
  subagentAddress = (): never => notWired('sessions.subagentAddress')
  scopeOf = (): never => notWired('sessions.scopeOf')
  sessionOf = (): never => notWired('sessions.sessionOf')
}

export class FakeWorkspaces implements IWorkspaces {
  private items: WorkspaceView[] = []
  /** 宿主列表生命周期：pending（加载中）→ ready（权威快照）。 */
  private phase: 'pending' | 'ready' = 'pending'
  private readonly listeners = new Set<() => void>()

  readonly list = {
    getSnapshot: () => ({
      items: this.items,
      archivedSessionIds: [],
      pinnedSessionIds: [],
      state: this.phase === 'ready' ? 'idle' : 'loading',
      phase: this.phase,
      error: null,
    }),
    subscribe: (listener: () => void) => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    },
  } as unknown as IWorkspaces['list']

  /** 测试推手：换工作区行并通知（枚举面的「快照变即推」语义）。`phase=pending` 是未就绪首帧。 */
  setItems(items: Array<{ workspaceId: string; title: string }>, phase: 'pending' | 'ready' = 'ready'): void {
    this.items = items.map((item) => ({ ...item, path: `/w/${item.workspaceId}`, sessionIds: [], createdAt: 0, updatedAt: 0 })) as unknown as WorkspaceView[]
    this.phase = phase
    for (const listener of [...this.listeners]) listener()
  }

  /** 工作区命令面（注册 / 改名 / 归档…）不归摸鱼舞台：触到即炸，不猜行为。 */
  create = (): never => notWired('workspaces.create')
  initializeDefault = (): never => notWired('workspaces.initializeDefault')
  rename = (): never => notWired('workspaces.rename')
  delete = (): never => notWired('workspaces.delete')
  insertBefore = (): never => notWired('workspaces.insertBefore')
  archiveSession = (): never => notWired('workspaces.archiveSession')
  unarchiveSession = (): never => notWired('workspaces.unarchiveSession')
  pinSession = (): never => notWired('workspaces.pinSession')
  unpinSession = (): never => notWired('workspaces.unpinSession')
  insertSessionBefore = (): never => notWired('workspaces.insertSessionBefore')
}

export interface FakeMoyuHost {
  port: MoyuHostPort
  sessions: FakeSessions
  workspaces: FakeWorkspaces
  /** 入口动作记账（每次 `openWorkspace` 一条）。 */
  openCalls: Array<{ workspaceId: string; sessionId: string | null }>
  /** 「浏览更多插件」的导航记账。 */
  openListCalls: number
  /** 让下一次入口抛（宿主拒绝打开）。 */
  failNextOpen: Error | null
  /** 让下一次入口的 `beforeOpen` 不跑（宿主语义：被后续导航取代）。 */
  supersedeNextOpen: boolean
}

/** 组一套齐装满员的宿主窄口（服务缺席场景另组缺件的 port）。 */
export function makeFakeMoyuHost(): FakeMoyuHost {
  const sessions = new FakeSessions()
  const workspaces = new FakeWorkspaces()
  let seq = 0
  const host: FakeMoyuHost = {
    sessions,
    workspaces,
    openCalls: [],
    openListCalls: 0,
    failNextOpen: null,
    supersedeNextOpen: false,
    port: {
      sessions,
      workspaces,
      uiConversation: {
        // 只供 `target('chat')` 这一格：镜像读取口按窄镜像用，不抄宿主 binding 全家。
        binding: (sessionId: unknown) => asBinding(sessions.uiBinding(sessionId)),
      },
      uiWorkspace: {
        openWorkspace: (async (workspaceId: unknown, beforeOpen?: (sessionId: never) => void): Promise<void> => {
          if (host.failNextOpen !== null) {
            const failure = host.failNextOpen
            host.failNextOpen = null
            host.openCalls.push({ workspaceId: String(workspaceId), sessionId: null })
            throw failure
          }
          seq += 1
          const sessionId = `s-${seq}`
          if (host.supersedeNextOpen) {
            host.supersedeNextOpen = false
            host.openCalls.push({ workspaceId: String(workspaceId), sessionId: null })
            return
          }
          host.openCalls.push({ workspaceId: String(workspaceId), sessionId })
          beforeOpen?.(sessionId as never)
        }),
      },
      pluginNavigation: { openList: () => { host.openListCalls += 1 } },
    },
  }
  return host
}