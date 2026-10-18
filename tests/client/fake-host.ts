import { vi } from 'vitest'
import type { Mock } from 'vitest'

/**
 * 宿主壳层假体（槽位 + layout 服务 + 可选的 configForms 表单服务）的唯一住址。为什么需要它：
 * 注册面测试与行为测试都要一个「像宿主一样接注册、像宿主一样选面板、像宿主一样发配置表单」的
 * 假体，形状漂移即假红/假绿（fake-deps 先例）。形状只镜像本仓消费的宿主契约面（ADR 0020
 * 窄镜像口径）：注册入席、effect 可退订、`selectPanel(id | null)`——null 选中会话，这是宿主
 * 发布物的原文语义；configForms 缺省 = 旧宿主，配置页接入必须静默退让。
 */

export interface Registration { name: string; options: Record<string, unknown>; component: unknown }

export interface FakeConfigFormSnapshot {
  status: string
  value: Record<string, unknown>
  writable: boolean
  revision: number
  base?: unknown
  user?: unknown
}
export interface FakeConfigForm {
  getSnapshot(): FakeConfigFormSnapshot
  subscribe(listener: () => void): () => void
  mutate: Mock
}
export interface FakeConfigForms {
  /** 页面问过的条目 id（按调用顺序）：`ENTRY_ID` 写错时这里立刻显形，而不是共享假表单兜住。 */
  entryIds: string[]
  /** `whileServed` 收到的名单（按调用顺序、逐次拷贝）：名单写错则配置页整页不露面。 */
  servedNamespaces: string[][]
  get(entryId: string): FakeConfigForm
  whileServed(namespaces: string[], register: (served: Set<string>) => () => void): () => void
}

export interface FakeHost {
  slots: {
    inject: (name: string, fn: () => () => void) => () => void
    register: (options: Record<string, unknown>, component: unknown) => () => void
  }
  layout: { selectPanel: Mock }
  configForms?: FakeConfigForms
  injected: string[]
  registrations: Registration[]
  effects: string[]
}

export function fakeHost(options: { configForms?: FakeConfigForms } = {}): FakeHost {
  const injected: string[] = []
  const registrations: Registration[] = []
  const effects: string[] = []
  return {
    injected,
    registrations,
    effects,
    configForms: options.configForms,
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

/** 一份「就绪、可写、revision 0」的共享表单：测试从同一个 `get` 读保存结果。
 *  `options.status` 是假表单服务的条目状态（替身的 `shell()` 把它折成可用性：`unavailable`
 *  即整页不可用），`options.writable` 直接落进快照——只读部署与条目不可用两条壳层分支
 *  因此可以真渲染，而不是只测到「一切正常」。`options.user` 是用户层覆盖：真容的
 *  「已覆盖 / 恢复默认」与 unset 都只认这一层，不认「值恰好等于缺省」。
 *  `whileServed` 立刻以全部 namespaces 已服务回调——配置页的注册路径因此同步可达。
 *  调用入参逐条留痕：页面拿错条目 id / 报错 served 名单，测试必须红，而不是被共享表单带绿。 */
export function fakeConfigForms(
  value: Record<string, unknown> = {},
  options: { status?: string; writable?: boolean; user?: Record<string, unknown> } = {},
): FakeConfigForms {
  const snapshot: FakeConfigFormSnapshot = {
    status: options.status ?? 'ready',
    value,
    writable: options.writable ?? true,
    revision: 0,
    base: {},
    user: options.user ?? {},
  }
  const form: FakeConfigForm = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate: vi.fn(async () => true),
  }
  const entryIds: string[] = []
  const servedNamespaces: string[][] = []
  return {
    entryIds,
    servedNamespaces,
    get(entryId) {
      entryIds.push(entryId)
      return form
    },
    whileServed(namespaces, register) {
      servedNamespaces.push([...namespaces])
      return register(new Set(namespaces))
    },
  }
}

export function fakeCtx(h: FakeHost): unknown {
  const ctx = {
    slots: h.slots,
    layout: h.layout,
    configForms: h.configForms,
    effect(fn: () => unknown, label?: string): unknown {
      h.effects.push(String(label))
      return fn()
    },
    inject(deps: string[], callback: (child: unknown) => void): unknown {
      h.injected.push(...deps)
      if (deps.includes('configForms') && h.configForms === undefined) return
      callback(ctx)
    },
  }
  return ctx
}
