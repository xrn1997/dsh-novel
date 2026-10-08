import { vi } from 'vitest'
import type { Mock } from 'vitest'

/**
 * 宿主壳层假体（槽位 + layout 服务）的唯一住址。为什么需要它：注册面测试与行为测试都要
 * 一个「像宿主一样接注册、像宿主一样选面板」的假体，形状漂移即假红/假绿（fake-deps 先例）。
 * 形状只镜像本仓消费的宿主契约面（ADR 0020 窄镜像口径）：注册入席、effect 可退订、
 * `selectPanel(id | null)`——null 选中会话，这是宿主发布物的原文语义。
 */

export interface Registration { name: string; options: Record<string, unknown>; component: unknown }

export interface FakeHost {
  slots: {
    inject: (name: string, fn: () => () => void) => () => void
    register: (options: Record<string, unknown>, component: unknown) => () => void
  }
  layout: { selectPanel: Mock }
  injected: string[]
  registrations: Registration[]
  effects: string[]
}

export function fakeHost(): FakeHost {
  const injected: string[] = []
  const registrations: Registration[] = []
  const effects: string[] = []
  return {
    injected,
    registrations,
    effects,
    slots: {
      inject(name: string, fn: () => () => void): () => void {
        injected.push(name)
        return fn()
      },
      register(options: Record<string, unknown>, component: unknown): () => void {
        registrations.push({ name: String(options.name), options, component })
        return () => {}
      },
    },
    layout: { selectPanel: vi.fn() },
  }
}

export function fakeCtx(h: FakeHost): unknown {
  return {
    slots: h.slots,
    layout: h.layout,
    effect(fn: () => unknown, label?: string): unknown {
      h.effects.push(String(label))
      return fn()
    },
  }
}
