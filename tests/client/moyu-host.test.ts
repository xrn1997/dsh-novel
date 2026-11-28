// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  attachMoyuHost,
  bindMoyuWorkspace,
  conversationBindingOf,
  moyuWorkspaceStore,
  openMoyuWorkspaceSession,
  openPluginList,
  refreshMoyuWorkspaces,
  resetMoyuHostForTests,
  restoreMoyuWorkspaceBinding,
} from '../../src/client/moyu-host.js'
import { moyuMirrorStore } from '../../src/client/moyu-mirror.js'
import { zhTranslate } from '../../src/client/copy/index.js'
import { makeFakeMoyuHost } from './fake-moyu-host.js'
import type { FakeMoyuHost } from './fake-moyu-host.js'

const t = zhTranslate

/**
 * 工作区入口服务层：开/切宿主会话、只读镜像、工作区枚举与两个宿主真入口。
 * 判据全走宿主公开面的假账（fake-moyu-host 按「test fake 必须供应」口径造）：
 * 插件侧唯一的副作用是 `openWorkspace`；投递面**不接线**——谁想代发，用例会当场炸。
 */

describe('摸鱼工作区入口', () => {
  let host: FakeMoyuHost

  beforeEach(() => {
    resetMoyuHostForTests()
    globalThis.localStorage.clear()
    host = makeFakeMoyuHost()
  })

  it('入口＝uiWorkspace.openWorkspace：只开会话，不投递任何消息', async () => {
    const outcome = await openMoyuWorkspaceSession(host.port, { bookKey: 'book-1', workspaceId: 'w-1' }, t)
    expect(outcome).toEqual({ opened: true, message: null })
    expect(host.openCalls).toEqual([{ workspaceId: 'w-1', sessionId: 's-1' }])
    // 插件不留投递面：假体的 create / using 一接线就抛，这里走完即证明没碰。
    expect(host.sessions.retains).toEqual([{ sessionId: 's-1', source: 'moyuStage' }])
  })

  it('入口会话被长持一份（镜像借作用域），换工作区时旧的引用被释放', async () => {
    await openMoyuWorkspaceSession(host.port, { bookKey: 'book-1', workspaceId: 'w-1' }, t)
    expect(host.sessions.retainedCount('s-1')).toBe(1)
    await openMoyuWorkspaceSession(host.port, { bookKey: 'book-1', workspaceId: 'w-2' }, t)
    expect(host.sessions.retainedCount('s-1')).toBe(0)
    expect(host.sessions.retainedCount('s-2')).toBe(1)
  })

  it('宿主拒绝打开：原文进 outcome，不留长持', async () => {
    host.failNextOpen = new Error('workspace refused')
    const outcome = await openMoyuWorkspaceSession(host.port, { bookKey: 'book-1', workspaceId: 'w-1' }, t)
    expect(outcome).toEqual({ opened: false, message: 'workspace refused' })
    expect(host.sessions.retains).toEqual([])
  })

  it('被后续导航取代：beforeOpen 不跑＝opened:false + 取代文案（不谎报打开）', async () => {
    host.supersedeNextOpen = true
    const outcome = await openMoyuWorkspaceSession(host.port, { bookKey: 'book-1', workspaceId: 'w-1' }, t)
    expect(outcome.opened).toBe(false)
    expect(outcome.message).toBe(t('reader.moyu.err.superseded'))
    expect(host.sessions.retains).toEqual([])
  })

  it('工作区面缺席：如实失败，不炸', async () => {
    const bare = makeFakeMoyuHost()
    bare.port.uiWorkspace = undefined
    const outcome = await openMoyuWorkspaceSession(bare.port, { bookKey: 'book-1', workspaceId: 'w-1' }, t)
    expect(outcome).toEqual({ opened: false, message: t('reader.moyu.err.uiWorkspace') })
  })

  it('入口会话的真轮次进只读镜像（按入口那本书归因），换入口时旧镜像清场', async () => {
    await openMoyuWorkspaceSession(host.port, { bookKey: 'book-1', workspaceId: 'w-1' }, t)
    host.sessions.pushChatSnapshot('s-1', [
      { key: 'u1', kind: 'user', turn: 1, data: { text: '你好', time: 1_700_000_000_000 } },
      { key: 't1', kind: 'assistant-step', turn: 1, data: { blocks: [{ type: 'text', text: '在' }] } },
    ])
    const turns = moyuMirrorStore.get().turns
    expect(turns.length).toBeGreaterThan(0)
    expect(turns[0]?.sessionId).toBe('s-1')
    expect(turns[0]?.bookKey).toBe('book-1')

    await openMoyuWorkspaceSession(host.port, { bookKey: 'book-2', workspaceId: 'w-2' }, t)
    expect(moyuMirrorStore.get().turns.filter((turn) => turn.sessionId === 's-1')).toEqual([])
  })

  it('镜像读取面缺席＝入口照常成功，只是不镜像（失败半径等于镜像那一格）', async () => {
    const bare = makeFakeMoyuHost()
    bare.port.uiConversation = undefined
    const outcome = await openMoyuWorkspaceSession(bare.port, { bookKey: 'book-1', workspaceId: 'w-1' }, t)
    expect(outcome).toEqual({ opened: true, message: null })
    bare.sessions.pushChatSnapshot('s-1', [{ key: 'u1', kind: 'user', turn: 1, data: { text: '你好' } }])
    expect(moyuMirrorStore.get().turns).toEqual([])
  })

  it('工作区选择落 localStorage，恢复读同一份', () => {
    bindMoyuWorkspace('w-9')
    expect(moyuWorkspaceStore.get().boundId).toBe('w-9')
    resetMoyuHostForTests()
    restoreMoyuWorkspaceBinding()
    expect(moyuWorkspaceStore.get().boundId).toBe('w-9')
    bindMoyuWorkspace(null)
    expect(globalThis.localStorage.getItem('novel.moyu.workspace')).toBeNull()
  })

  it('枚举面未就绪（pending 空快照）时不裁决选择：持久化选择不许被 loading 首帧误删', () => {
    bindMoyuWorkspace('w-9')
    refreshMoyuWorkspaces(host.port)
    expect(moyuWorkspaceStore.get().boundId).toBe('w-9')
    expect(globalThis.localStorage.getItem('novel.moyu.workspace')).toBe('w-9')
    host.workspaces.setItems([{ workspaceId: 'w-9', title: '工作区九' }])
    expect(moyuWorkspaceStore.get().boundId).toBe('w-9')
  })

  it('工作区枚举面换代：选择不在列表里即收敛为空（陈旧选择不画在 chip 上）', () => {
    bindMoyuWorkspace('w-gone')
    host.workspaces.setItems([{ workspaceId: 'w-1', title: '工作区一' }])
    refreshMoyuWorkspaces(host.port)
    expect(moyuWorkspaceStore.get().boundId).toBeNull()
    expect(globalThis.localStorage.getItem('novel.moyu.workspace')).toBeNull()
  })

  it('工作区枚举面：有服务出标题行并可订阅；缺席＝chip 隐藏（available=false）', () => {
    const stop = refreshMoyuWorkspaces(host.port)
    host.workspaces.setItems([{ workspaceId: 'w-1', title: '工作区一' }])
    expect(moyuWorkspaceStore.get()).toMatchObject({
      available: true,
      options: [{ workspaceId: 'w-1', title: '工作区一' }],
    })
    stop()
    const bare = makeFakeMoyuHost()
    bare.port.workspaces = undefined
    refreshMoyuWorkspaces(bare.port)
    expect(moyuWorkspaceStore.get().available).toBe(false)
  })

  it('宿主真导航入口：浏览更多插件＝openList；服务缺席＝该行隐藏', () => {
    expect(openPluginList(host.port)).toBe(true)
    expect(host.openListCalls).toBe(1)
    const bare = makeFakeMoyuHost()
    bare.port.pluginNavigation = undefined
    expect(openPluginList(bare.port)).toBe(false)
  })

  it('轮次镜像读取口：conversationBindingOf 走 uiConversation.binding', () => {
    const seen: string[] = []
    const withBinding = makeFakeMoyuHost()
    withBinding.port.uiConversation = {
      binding: ((sessionId: never) => {
        seen.push(String(sessionId))
        return undefined
      }) as never,
    }
    conversationBindingOf(withBinding.port, 's-7' as never)
    expect(seen).toEqual(['s-7'])
  })

  it('attachMoyuHost 的摘除句柄一并收掉工作区订阅与镜像长持', async () => {
    const stop = attachMoyuHost(host.port)
    refreshMoyuWorkspaces(host.port)
    host.workspaces.setItems([{ workspaceId: 'w-1', title: '工作区一' }])
    expect(moyuWorkspaceStore.get().options).toHaveLength(1)
    await openMoyuWorkspaceSession(host.port, { bookKey: 'book-1', workspaceId: 'w-1' }, t)
    expect(host.sessions.retainedCount('s-1')).toBe(1)
    stop()
    host.workspaces.setItems([{ workspaceId: 'w-2', title: '工作区二' }])
    expect(moyuWorkspaceStore.get().options).toEqual([{ workspaceId: 'w-1', title: '工作区一' }])
    expect(host.sessions.retainedCount('s-1')).toBe(0)
    expect(moyuMirrorStore.get().turns).toEqual([])
  })
})