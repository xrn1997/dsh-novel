import { vi } from 'vitest'
import type { Mock } from 'vitest'

/**
 * 宿主壳层假体（槽位 + layout 服务 + 可选的远程设置面）的唯一住址。为什么需要它：
 * 注册面测试与行为测试都要一个「像宿主一样接注册、像宿主一样选面板、像宿主一样收发设置」的
 * 假体，形状漂移即假红/假绿（fake-deps 先例）。形状只镜像本仓消费的宿主契约面（ADR-0020
 * 窄镜像口径）：注册入席、effect 可退订、`selectPanel(id | null)`——null 那一档是「回到会话面板」，
 * 判据是本仓镜像声明（`src/client/index.tsx` 的窄镜像类型）；`remote.settings` 缺席即宿主未提供
 * 配置面，配置页接入必须静默退让。
 *
 * 设置面替身按**编目契约**演（host `settingsController` 的 `describe` / `mutate`）：
 * 读回 `{ ok, value: { writable, namespaces } }`，写入按 set/unset 落值并回新 view；
 * 断言读 `mutateCalls`，而不是读页面内部状态。
 */

export interface Registration { name: string; options: Record<string, unknown>; component: unknown }

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface SettingsNamespaceView {
  ns: string
  schema: JsonValue
  value: JsonValue
  base?: JsonValue
  user?: JsonValue
  revision: number
}

export type SettingsPathOp =
  | { op: 'set'; path: string[]; value: JsonValue }
  | { op: 'unset'; path: string[] }

export type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: { message: string; code?: string } }

export interface FakeRemoteSettings {
  /** 每次 `describe` 的调用次数与返回的命名空间（诊断页面读的是不是我们的条目）。 */
  describeCalls: number
  /** 每次写入的入参与当时的 revision：`ENTRY_ID` / ops 形状 / 带修订号写错都在这里显形。 */
  mutateCalls: Array<{ ns: string; ops: SettingsPathOp[]; revision: number | undefined }>
  describe(): Promise<RemoteResult<{ writable: boolean; hasDocument: boolean; namespaces: SettingsNamespaceView[] }>>
  mutate(ns: string, ops: readonly SettingsPathOp[], revision?: number): Promise<RemoteResult<SettingsNamespaceView>>
}

export interface FakeRemoteSettingsOptions {
  /** 解析后的值（schema 缺省 → 宿主基准 → 用户层）：页面的输入框从这一份渲染。 */
  value?: Record<string, unknown>
  /** 出厂值：`unset` 后回到这里，模拟「撤用户层覆盖」而不是删成空。 */
  defaults?: Record<string, unknown>
  /** 用户层覆盖：键在 = 该字段显示「已覆盖」。 */
  user?: Record<string, unknown>
  writable?: boolean
  /** true = `describe` 里没有我们的命名空间（插件未加载的形态）。 */
  missing?: boolean
  /** 一次 `describe` 失败（宿主未挂载设置提供方）。 */
  describeFailure?: string
  /** 写失败：下一次 `mutate` 回这个理由（`settings/rejected` 一类）。 */
  mutateFailure?: string
  schema?: JsonValue
}

export interface FakeHost {
  slots: {
    inject: (name: string, fn: () => () => void) => () => void
    register: (options: Record<string, unknown>, component: unknown) => () => void
  }
  layout: { selectPanel: Mock }
  remote?: { settings?: FakeRemoteSettings } | undefined
  injected: string[]
  registrations: Registration[]
  effects: string[]
}

export function fakeHost(options: { remoteSettings?: FakeRemoteSettings } = {}): FakeHost {
  const injected: string[] = []
  const registrations: Registration[] = []
  const effects: string[] = []
  return {
    injected,
    registrations,
    effects,
    remote: options.remoteSettings === undefined ? undefined : { settings: options.remoteSettings },
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

/**
 * 一份「就绪、可写、revision 0」的远程设置面：`describe` 交回一个命名空间，`mutate` 按
 * set/unset 落值并回新 view。替身只演契约里的那一层语义（值、用户层、修订号、错误信封），
 * 不重演 schema 校验——值域由宿主裁决，页面只负责显示它给的理由。
 */
export function fakeRemoteSettings(options: FakeRemoteSettingsOptions = {}): FakeRemoteSettings {
  // 宿主交回的 `value` 是**解析后的值**（schema 缺省 → 宿主基准 → 用户层）：七个字段都有值，
  // 否则页面会按「空框」判非法。替身照这条语义给一份出厂值，测试只覆盖它关心的字段。
  const factoryDefaults: Record<string, unknown> = {
    searchTimeoutMs: 15000,
    searchParallel: 5,
    jsTimeoutMs: 15000,
    exportDelayMs: 300,
    cacheMaxBytes: 209715200,
    localImportMaxBytes: 52428800,
    proxyUrl: '',
  }
  const defaults: Record<string, unknown> = { ...factoryDefaults, ...(options.defaults ?? {}) }
  const value: Record<string, unknown> = { ...defaults, ...(options.value ?? {}) }
  const user: Record<string, unknown> = { ...(options.user ?? {}) }
  let revision = 0
  let mutateFailure = options.mutateFailure
  const view = (): SettingsNamespaceView => ({
    ns: 'dsh-novel',
    schema: options.schema ?? { type: 'object', properties: {} },
    value: { ...value } as JsonValue,
    base: { ...defaults } as JsonValue,
    user: { ...user } as JsonValue,
    revision,
  })
  const fake: FakeRemoteSettings = {
    describeCalls: 0,
    mutateCalls: [],
    async describe() {
      fake.describeCalls += 1
      if (options.describeFailure !== undefined) {
        return { ok: false, error: { message: options.describeFailure } }
      }
      return {
        ok: true,
        value: {
          writable: options.writable ?? true,
          hasDocument: true,
          namespaces: options.missing === true ? [] : [view()],
        },
      }
    },
    async mutate(ns, ops, rev) {
      fake.mutateCalls.push({ ns, ops: [...ops], revision: rev })
      // 编目契约的乐观并发：带的修订号不是当前值 = 外部已改，回冲突而不是覆盖。
      if (rev !== undefined && rev !== revision) {
        return { ok: false, error: { message: 'settings/conflict: revision changed', code: 'settings/conflict' } }
      }
      if (mutateFailure !== undefined) {
        const message = mutateFailure
        mutateFailure = undefined
        return { ok: false, error: { message } }
      }
      for (const op of ops) {
        const field = op.path[0]
        if (field === undefined) continue
        if (op.op === 'set') {
          value[field] = op.value
          user[field] = op.value
        } else {
          Reflect.deleteProperty(user, field)
          if (Object.hasOwn(defaults, field)) value[field] = defaults[field]
          else Reflect.deleteProperty(value, field)
        }
      }
      revision += 1
      return { ok: true, value: view() }
    },
  }
  return fake
}

export function fakeCtx(h: FakeHost): unknown {
  const ctx = {
    slots: h.slots,
    layout: h.layout,
    remote: h.remote,
    effect(fn: () => unknown, label?: string): unknown {
      h.effects.push(String(label))
      return fn()
    },
    inject(deps: string[], callback: (child: unknown) => void): unknown {
      h.injected.push(...deps)
      if (deps.includes('remote.settings') && h.remote?.settings === undefined) return
      callback(ctx)
    },
  }
  return ctx
}
