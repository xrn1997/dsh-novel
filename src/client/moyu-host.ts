/**
 * 摸鱼工作区入口的接入层（**入口不是执行者**）：把宿主公开服务面收成一个可选注入的窄口，
 * 只做三件事——列工作区、在选定工作区开/切一个宿主会话、把该会话的真轮次**只读**镜像进舞台。
 *
 * 本模块**不代发任何消息**：发送、排队、撤销、停止都归宿主自己的会话界面（`ADR-0108`）。
 * 因此插件侧不存在「真任务」这层概念，也不会替用户产生宿主轮次；对宿主的副作用只有
 * `uiWorkspace.openWorkspace` 一件（建/切一个空白会话并把它带到前台）。
 * **服务缺席＝入口隐藏**：每个面单独可选，缺哪个哪个能力不出，不炸面板。
 *
 * 读取面全走 `ctx.get`：cordis 跟踪器对属性访问执行注入门禁，`ctx.<service>` 对未 inject 的
 * 服务直接抛，会把整个 client fiber（含侧栏入口）带走；`get` 是「无注入要求」的读法
 * （`tests/client/host-inject-guard.test.ts` 钉住）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationBinding, UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { Translate } from './copy/index.js'
import { createStore } from './store.js'
import type { Store } from './store.js'
import {
  clearMoyuMirrorSession,
  projectMoyuMirrorTurns,
  replaceMoyuMirrorTurns,
  resetMoyuMirrorForTests,
} from './moyu-mirror.js'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** 摸鱼舞台对入口会话的长持引用（镜像订阅靠它借作用域）。 */
    moyuStage: unknown
  }
}

/** 会话身份：从 `openWorkspace` 的 `beforeOpen` 回调形参推导，不抄第二份品牌类型。 */
type OpenBefore = NonNullable<Parameters<UiWorkspace['openWorkspace']>[1]>
export type MoyuSessionId = Parameters<OpenBefore>[0]

/** 宿主公开服务面的可注入窄口；每格都可缺席（旧代宿主 / 受限 Peer）。 */
export interface MoyuHostPort {
  /** 会话面：只用到长持（镜像借作用域前的持有）。 */
  sessions?: ISessions | undefined
  /** 工作区枚举面（chip 的数据源）。 */
  workspaces?: IWorkspaces | undefined
  /** 轮次读取面（真轮次镜像的读取口）。 */
  uiConversation?: Pick<UiConversation, 'binding'> | undefined
  /** 工作区入口（建/切会话并带到前台）。 */
  uiWorkspace?: Pick<UiWorkspace, 'openWorkspace'> | undefined
  /** 「浏览更多插件」的导航面（可选、可缺席；Discover tab 无公开动词，见 `ADR-0108`）。 */
  pluginNavigation?: { openList(): void } | undefined
}

/** 从插件 fiber 的 ctx 读出窄口：全部走 `ctx.get` 可选读法，服务缺席留 undefined。 */
export function moyuHostPortOf(ctx: Context): MoyuHostPort {
  const c = ctx as unknown as { get(name: string): unknown }
  const read = (name: string): unknown => {
    try {
      return c.get(name)
    } catch {
      // cordis 对缺席服务的读法各代不一：拿不到就当缺席，不炸面板（降级留痕＝对应能力隐藏）。
      return undefined
    }
  }
  return {
    sessions: read('sessions') as ISessions | undefined,
    workspaces: read('workspaces') as IWorkspaces | undefined,
    uiConversation: read('uiConversation') as Pick<UiConversation, 'binding'> | undefined,
    uiWorkspace: read('uiWorkspace') as Pick<UiWorkspace, 'openWorkspace'> | undefined,
    pluginNavigation: read('pluginNavigation') as { openList(): void } | undefined,
  }
}

/* ── 模块级活口（常驻面跨面板卸载存活）────────────────────────────────────── */

export const moyuHostStore: Store<{ port: MoyuHostPort | null }> = createStore<{ port: MoyuHostPort | null }>({ port: null })

/** 把宿主窄口挂进模块级活口；返回摘除句柄（插件 fiber 拆除时跑：收掉工作区订阅与镜像长持）。 */
export function attachMoyuHost(port: MoyuHostPort): () => void {
  moyuHostStore.set({ port })
  return () => {
    if (moyuHostStore.get().port === port) moyuHostStore.set({ port: null })
    workspacesWatching?.()
    workspacesWatching = null
    releaseMirror()
  }
}

/* ── 工作区 chip 的数据面 ──────────────────────────────────────────────────── */

export interface MoyuWorkspaceOption {
  workspaceId: string
  title: string
}

export interface MoyuWorkspaceState {
  /** 工作区服务是否在场（缺席＝chip 隐藏，不显示空座）。 */
  available: boolean
  options: MoyuWorkspaceOption[]
  /** 选中的工作区 id（入口目标，持久化）；null＝还没选过。 */
  boundId: string | null
}

export const moyuWorkspaceStore: Store<MoyuWorkspaceState> = createStore<MoyuWorkspaceState>({
  available: false,
  options: [],
  boundId: null,
})

/** 选择持久化键（localStorage，读写都包 try：配额 / 无痕不打扰使用）。 */
const WORKSPACE_BIND_KEY = 'novel.moyu.workspace'

function loadBoundWorkspaceId(): string | null {
  try {
    return globalThis.localStorage.getItem(WORKSPACE_BIND_KEY)
  } catch {
    return null
  }
}

/** 启动时恢复选择（存的是宿主 uuid）；是否仍有效由枚举面第一次投影裁决，不在这里猜。 */
export function restoreMoyuWorkspaceBinding(): void {
  const boundId = loadBoundWorkspaceId()
  if (boundId !== null) moyuWorkspaceStore.set({ boundId })
}

function persistWorkspaceBinding(workspaceId: string | null): void {
  try {
    if (workspaceId === null) globalThis.localStorage.removeItem(WORKSPACE_BIND_KEY)
    else globalThis.localStorage.setItem(WORKSPACE_BIND_KEY, workspaceId)
  } catch {
    // 存不进 localStorage 只丢跨重启记忆，本会话的选择照常生效。
  }
}

/** 记住选中的工作区（写盘 + 推 store）；入口动作本身由 `openMoyuWorkspaceSession` 执行。 */
export function bindMoyuWorkspace(workspaceId: string | null): void {
  moyuWorkspaceStore.set({ boundId: workspaceId })
  persistWorkspaceBinding(workspaceId)
}

let workspacesWatching: (() => void) | null = null

/** 订阅工作区枚举面并投影 `{workspaceId, title}` 行；服务缺席＝chip 隐藏。返回退订句柄。 */
export function refreshMoyuWorkspaces(port: MoyuHostPort): () => void {
  workspacesWatching?.()
  workspacesWatching = null
  const source = port.workspaces?.list
  if (source === undefined) {
    // 工作区枚举面缺席（旧代宿主 / 受限 Peer）：chip 隐藏，舞台退回纯阅读。
    if (moyuWorkspaceStore.get().boundId !== null) persistWorkspaceBinding(null)
    moyuWorkspaceStore.set({ available: false, options: [], boundId: null })
    return () => undefined
  }
  /** 选择即投影：枚举面里不再有的工作区把选择收敛为 null。
   *  **只信权威快照**（phase=ready）：首帧 list 是空 loading 快照，拿它裁决会把用户持久化的选择误删。 */
  const project = (): void => {
    const snapshot = source.getSnapshot()
    const ready = snapshot.phase === 'ready'
    const options = ready ? snapshot.items.map((item) => ({ workspaceId: String(item.workspaceId), title: item.title })) : []
    const boundId = moyuWorkspaceStore.get().boundId
    const nextBound = ready && boundId !== null && !options.some((option) => option.workspaceId === boundId) ? null : boundId
    moyuWorkspaceStore.set(nextBound === boundId ? { available: ready, options } : { available: ready, options, boundId: nextBound })
    if (nextBound !== boundId) persistWorkspaceBinding(null)
  }
  project()
  const stop = source.subscribe(project)
  workspacesWatching = stop
  return stop
}

/* ── 工作区入口（开会话，不代发）──────────────────────────────────────────── */

export interface MoyuEntryRequest {
  /** 起这次入口的书：镜像轮只进这本书的对话流。 */
  bookKey: string
  workspaceId: string
}

export interface MoyuEntryOutcome {
  /** 宿主会话是否真的被带到前台（被后续导航取代时为 false）。 */
  opened: boolean
  /** 失败原因（宿主原文）；成功为 null。 */
  message: string | null
}

/**
 * 入口动作：`uiWorkspace.openWorkspace` 建/复用该工作区的空白会话并带到前台；`beforeOpen`
 * 是宿主给的同步准备位，在那里长持会话并挂只读镜像（镜像失败不影响打开——失败半径＝镜像那一格）。
 * 本函数**不产生任何轮次**：会话怎么用由用户在宿主里决定。
 */
export async function openMoyuWorkspaceSession(
  port: MoyuHostPort,
  request: MoyuEntryRequest,
  t: Translate,
): Promise<MoyuEntryOutcome> {
  const face = port.uiWorkspace
  if (face === undefined) return { opened: false, message: t('reader.moyu.err.uiWorkspace') }
  // 宿主在 `beforeOpen` 里把会话 id 递进来；被后续导航取代时该回调不跑——用列表接住，
  // 空表即「没打开」（布尔哨兵会被 TS 的闭包窄化误判，这里用可观测的产物代替）。
  const openedIds: MoyuSessionId[] = []
  try {
    await face.openWorkspace(request.workspaceId as Parameters<typeof face.openWorkspace>[0], (sessionId) => {
      openedIds.push(sessionId)
      attachMirror(port, sessionId, request.bookKey)
    })
  } catch (cause) {
    return { opened: false, message: cause instanceof Error ? cause.message : String(cause) }
  }
  const openedId = openedIds[0]
  return { opened: openedId !== undefined, message: openedId === undefined ? t('reader.moyu.err.superseded') : null }
}

/* ── 只读镜像 ──────────────────────────────────────────────────────────────── */

interface MirrorHandle {
  sessionId: MoyuSessionId
  reference: SessionReference
  stop: () => void
}

/** 只挂一路入口会话的镜像（换工作区＝换会话，旧的那份整体收掉）。 */
let mirrorHandle: MirrorHandle | null = null

/** 镜像读面：`binding.target('chat')` 的窄镜像（宿主 chat 视图包的声明合并带进来的键，不引该包类型）。 */
interface MirrorSource {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
}

function releaseMirror(): void {
  const handle = mirrorHandle
  mirrorHandle = null
  if (handle === null) return
  try {
    handle.stop()
    handle.reference.release()
  } catch {
    // 已退订 / 引用已释放（换代）：摘除到此为止。
  }
  clearMoyuMirrorSession(String(handle.sessionId))
}

/**
 * 长持入口会话并订阅它的 chat 快照；三类缺席各自降级、互不牵连：
 * `sessions` 缺席＝不镜像；`uiConversation` 缺席＝不镜像；binding / target 读不出（会话未 catalog /
 * 换代 / 该组合没装宿主 chat 视图）＝该会话不镜像。形状漂移的失败半径在投影层收口（＝那一轮）。
 */
function attachMirror(port: MoyuHostPort, sessionId: MoyuSessionId, bookKey: string): void {
  releaseMirror()
  const sessions = port.sessions
  const ui = port.uiConversation
  if (sessions === undefined || ui === undefined) return
  let reference: SessionReference
  try {
    // 借 binding 前必须先长持：`scope(id)` / `binding(id)` 对未 retain 的代际返回 undefined。
    reference = sessions.retain(sessionId, { source: 'moyuStage' })
  } catch {
    return
  }
  try {
    const binding = conversationBindingOf(port, sessionId)
    const source = (binding as unknown as { target(name: string): MirrorSource | undefined } | undefined)?.target('chat')
    if (source === undefined) {
      reference.release()
      return
    }
    const project = (): void => {
      try {
        replaceMoyuMirrorTurns(sessionId, projectMoyuMirrorTurns(sessionId, bookKey, source.getSnapshot(), Date.now()))
      } catch {
        // 订阅面抛（快照读不出）：保留已投影的镜像，等下一次通知——失败半径＝这一次读数。
      }
    }
    project()
    mirrorHandle = { sessionId, reference, stop: source.subscribe(project) }
  } catch {
    // binding 对未 catalog / 换代会话 fail loud：该会话不镜像，入口照常成功。
    reference.release()
  }
}

/** 轮次镜像的读取口（`attachMirror` 经它拿 `target('chat')`；对未 catalog / 换代会话 fail loud）。 */
export function conversationBindingOf(port: MoyuHostPort, sessionId: MoyuSessionId): ConversationBinding | undefined {
  const binding = port.uiConversation?.binding(sessionId)
  return binding ?? undefined
}

/* ── 宿主导航入口 ──────────────────────────────────────────────────────────── */

/** 「浏览更多插件」＝宿主公开导航面 `pluginNavigation.openList()`（只到 Plugins 面板 installed 列表；
 *  Discover tab 无公开动词，缺口记 `ADR-0108`）。服务缺席＝该行隐藏。 */
export function openPluginList(port: MoyuHostPort): boolean {
  const face = port.pluginNavigation
  if (face === undefined) return false
  face.openList()
  return true
}

/** 测试收口：清空活口与 store（宿主拆 fiber 时由 attach 句柄收口，这里给用例一个干净起点）。 */
export function resetMoyuHostForTests(): void {
  workspacesWatching?.()
  workspacesWatching = null
  releaseMirror()
  moyuHostStore.set({ port: null })
  moyuWorkspaceStore.set({ available: false, options: [], boundId: null })
  resetMoyuMirrorForTests()
}