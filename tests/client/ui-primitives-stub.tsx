import type { SettingsFieldState, SettingsFormActions, SettingsFormState } from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement, type ReactNode } from 'react'

/**
 * 宿主表单原语（`@deepseek-ai/dsh-client-ui-primitives`）的测试替身。真容是宿主平台模块，
 * 本仓不装它（client bundle 留 external）；没有这份替身，配置页的接线（表单模型 → 快照 →
 * 保存动作）就只能对着静态渲染断言，等于把「页面对上了没有」测丢。
 *
 * 替身必须照真容的**语义**走，而不是形状像：`SettingsFormModel.bind` 真会调用投影回调、
 * 按版本缓存快照；`shell()` 的六键（可用 / 可写 / 有改动 / 非法 / 保存中 / 保存失败）驱动
 * `SettingsForm` 的不可用、只读、保存失败与提交禁用；`SettingsForm` 真把提交接到 `onSave`、
 * 只在**可用**之后渲染 children——只读部署仍画行（禁用由页面自己决定），只多一条只读提示。
 * 测试因此能以「编辑 → 保存」整条链驱动页面。
 *
 * 这里**没有** `SettingsValueField`：配置页的行是本仓自绘的（宿主原语装不下单位与换算），
 * 替身只镜像本仓真消费的那几个成员，多留一份就是给一份没人走的接线背书。
 */

export interface StubField { name: string; kind: 'number' | 'text' }
export interface StubFieldState { text: string; overridden: boolean; invalid: boolean }
export interface StubFormState {
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
}
export interface StubActions {
  save: () => void
  discard: () => void
  edit: (field: string, text: string) => void
  resetField: (field: string) => void
}

/** 替身与宿主镜像（`src/client/host-ui.d.ts`）的形状闸：三个读数形状必须与镜像**互相**可赋值。
 *  双向才拦得住两种漂移——镜像加了成员（替身不再顶替）与替身多带成员（页面读到真容没有的东西）。
 *  没有这道闸，「宿主契约变了这里与配置页一起红」就只是愿望：本仓不装那个包，vitest 又把它
 *  alias 到本文件，类型层面两边原本互不相识。 */
type Mutually<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const _shapeGate: [
  Mutually<StubFieldState, SettingsFieldState>,
  Mutually<StubFormState, SettingsFormState>,
  Mutually<StubActions, SettingsFormActions>,
] = [true, true, true]
void _shapeGate

export function settingsNumberField(name: string): StubField { return { name, kind: 'number' } }
export function settingsTextField(name: string): StubField { return { name, kind: 'text' } }

export class SettingsFormModel {
  private readonly scope: any
  private readonly fields: StubField[]
  private readonly edits = new Map<string, { op: 'set' | 'unset'; value?: unknown }>()
  private listeners = new Set<() => void>()
  private version = 0
  private cachedVersion = -1
  private cached: unknown
  private projection: (() => unknown) | null = null

  constructor(scope: any, fields: StubField[]) {
    this.scope = scope
    this.fields = fields
  }
  private value(): Record<string, unknown> {
    const base = { ...(this.scope?.getSnapshot?.().value ?? {}) }
    for (const [key, edit] of this.edits) {
      if (edit.op === 'set') base[key] = edit.value
      else delete base[key]
    }
    return base
  }
  private fieldState(name: string): StubFieldState {
    const value = this.value()[name]
    const edit = this.edits.get(name)
    const user = this.scope?.getSnapshot?.().user
    return {
      text: value === undefined || value === null ? '' : String(value),
      // 真容：staged 的 set 才算覆盖（staged 的 clear 不算）；没动过的字段看 user 层有没有这个键，
      // 与「值恰好等于缺省」无关。
      overridden: edit === undefined ? user !== undefined && Object.hasOwn(user, name) : edit.op === 'set',
      // 替身不重演 schema 的数值校验：只钉页面接线，不钉校验语义。
      invalid: false,
    }
  }
  shell(): StubFormState {
    const snapshot = this.scope?.getSnapshot?.() ?? {}
    return {
      // 真容只把 ready 态算作可用；loading 与 unavailable 都不可用。
      available: snapshot.status === 'ready',
      writable: snapshot.writable ?? true,
      dirty: this.edits.size > 0,
      invalid: false,
      saving: false,
      failed: false,
    }
  }
  field(name: string): StubFieldState { return this.fieldState(name) }
  bind<T>(projection: () => T) {
    this.projection = projection
    return {
      getSnapshot: () => {
        if (this.cachedVersion !== this.version) {
          this.cached = this.projection?.() ?? this.shell()
          this.cachedVersion = this.version
        }
        return this.cached as T
      },
      subscribe: (listener: () => void) => {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
      },
    }
  }
  private notify() {
    this.version += 1
    for (const listener of this.listeners) listener()
  }
  actions(): StubActions {
    return {
      save: () => {
        // 真容的 plan：set 直发；clear 只对「user 层真有这个键」的字段发 unset，否则无操作。
        const user = this.scope?.getSnapshot?.().user
        const ops: Array<{ op: 'set' | 'unset'; path: string[]; value?: unknown }> = []
        for (const [field, edit] of this.edits) {
          if (edit.op === 'set') ops.push({ op: 'set', path: [field], value: edit.value })
          else if (user !== undefined && Object.hasOwn(user, field)) ops.push({ op: 'unset', path: [field] })
        }
        if (ops.length > 0) void this.scope?.mutate?.(ops, this.scope?.getSnapshot?.().revision)
        this.edits.clear()
        this.notify()
      },
      discard: () => { this.edits.clear(); this.notify() },
      edit: (field, text) => {
        const meta = this.fields.find((f) => f.name === field)
        if (meta === undefined) return
        this.edits.set(field, { op: 'set', value: meta.kind === 'number' ? Number(text) : text })
        this.notify()
      },
      resetField: (field) => { this.edits.set(field, { op: 'unset' }); this.notify() },
    }
  }
  dispose(): void { this.listeners.clear() }
}

/**
 * 真容的壳层：不可用 → 只剩一句；可用 → 只读另起一条提示、children 照画（禁用由页面自己给）、
 * 底部是失败提示与保存钮。保存钮的禁用只由「没改动 / 非法 / 保存中」决定——只读部署靠
 * 「输入框禁用 ⇒ 改不动 ⇒ 不 dirty」自然落到禁用，壳层不额外判 writable。
 * 这里没有「放弃」按钮：真容的放弃是离开页面时 `onDiscard` 被调用，不是一枚控件。
 */
export function SettingsForm({ labels, state, onSave, children }: any): ReactNode {
  if (!state.available) {
    return createElement('p', { role: 'status' }, labels.unavailable)
  }
  const saveDisabled = state.dirty !== true || state.invalid === true || state.saving === true
  return createElement('div', { className: 'novel-test-form' },
    state.writable === true ? null : createElement('p', { role: 'status' }, labels.readOnly),
    children,
    createElement('div', { className: 'novel-test-form-footer' },
      state.failed === true ? createElement('p', { role: 'status' }, labels.saveFailed) : null,
      createElement('button', {
        type: 'button',
        disabled: saveDisabled,
        onClick: onSave,
      }, state.saving === true ? labels.saving : labels.save),
    ),
  )
}
