// @vitest-environment jsdom
/**
 * 宿主服务访问的注入纪律回归（用户症状：侧栏「小说」入口消失）。
 *
 * 根因形态：cordis 的服务跟踪器对**属性访问**执行注入门禁——插件 fiber 的 `inject` 未声明的服务，
 * `ctx.<name>` 直接抛「cannot get property "…" without inject」（@deepseek-ai/cordis 的
 * ReflectService.handler.get）；合法的可选读法是 `ctx.get(name)`（走服务表、无注入要求）。
 * 曾有一处 `moyuHostPortOf` 属性访问 `ctx.remote`，在 apply 期炸掉整个 client fiber，宿主回收
 * 已注册的侧栏槽位——入口随之消失。本文件用**真 cordis Context** 复刻跟踪器语义（fake ctx 是普通
 * 对象，永远抓不到这类越权），钉住两条：服务层零抛、apply 注册走完。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../../src/client/index.js'
import { moyuHostPortOf, resetMoyuHostForTests } from '../../src/client/moyu-host.js'

interface ProbeResult {
  error: unknown
  value: unknown
  injected: string[]
}

/** 真 cordis 跟踪器上下文 + 插件 fiber（inject 与 client 入口同款）：在里面跑被测调用。 */
async function probeUnderTracker(body: (ctx: Context) => unknown, provide?: Record<string, unknown>): Promise<ProbeResult> {
  const root = new Context()
  const injected: string[] = []
  root.reflect.provide('slots', {
    inject: (name: string, fn: () => () => void) => { injected.push(name); return fn() },
    register: () => () => { /* 空注册 */ },
  })
  root.reflect.provide('layout', { selectPanel: () => { /* 空动作 */ } })
  for (const [name, value] of Object.entries(provide ?? {})) root.reflect.provide(name, value)
  const out: ProbeResult = { error: null, value: undefined, injected }
  root.plugin({
    name: 'probe',
    inject: ['slots', 'layout'],
    apply(ctx) {
      try {
        out.value = body(ctx)
      } catch (e) {
        out.error = e
      }
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  return out
}

describe('宿主服务注入纪律（真 cordis 跟踪器）', () => {
  it('moyuHostPortOf 在跟踪器上下文上零抛，缺席的服务面留 undefined', async () => {
    const out = await probeUnderTracker((ctx) => moyuHostPortOf(ctx))
    expect(out.error).toBeNull()
    const port = out.value as { uiWorkspace?: unknown; sessions?: unknown; pluginNavigation?: unknown }
    expect(port.uiWorkspace).toBeUndefined()
    expect(port.sessions).toBeUndefined()
    expect(port.pluginNavigation).toBeUndefined()
  })

  it('可选宿主服务以服务名经服务表读到（workspace 面照常穿透）', async () => {
    const face = { openWorkspace: () => Promise.resolve() }
    const out = await probeUnderTracker((ctx) => moyuHostPortOf(ctx), { uiWorkspace: face })
    expect(out.error).toBeNull()
    const port = out.value as { uiWorkspace?: unknown }
    expect(port.uiWorkspace).toBe(face)
  })

  it('同名服务缺席但邻面在场时不许抛（not 从邻面钻属性）', async () => {
    const out = await probeUnderTracker((ctx) => moyuHostPortOf(ctx), { uiConversation: { binding: () => undefined } })
    expect(out.error).toBeNull()
    const port = out.value as { uiWorkspace?: unknown }
    expect(port.uiWorkspace).toBeUndefined()
  })

  it('apply() 在跟踪器上下文上走完注册（侧栏入口不因服务层越权而消失）', async () => {
    resetMoyuHostForTests()
    const out = await probeUnderTracker((ctx) => {
      apply(ctx)
      return 'applied'
    })
    expect(out.error).toBeNull()
    expect(out.value).toBe('applied')
    // 全局面板双注册走完（sidebar.panellist 是入口本体）
    expect(out.injected).toContain('sidebar.panellist')
    expect(out.injected).toContain('main')
    resetMoyuHostForTests()
  })
})
