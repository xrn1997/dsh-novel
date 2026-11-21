import { useEffect, useState } from 'react'
import type { Translate } from './copy/index.js'
import { FIELDS, FIELD_NAMES, parseField, type FieldName } from './config-fields.js'
import type { JsonValue, RemoteSettingsLike, SettingsNamespaceView, SettingsPathOp } from './config-settings.js'
import { createStore, useStore, type Store } from './store.js'
import { pushError } from './transient.js'

/** 字段状态：当前文本、是否与宿主存的值不同（草稿脏）、是否被用户层覆盖、是否类型非法。 */
export interface FieldState {
  text: string
  overridden: boolean
  invalid: boolean
  /** 有未保存的草稿（与「已覆盖」不同：那是盘上的状态，这是这一屏的草稿）。 */
  dirty: boolean
}

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 宿主值 → 框内文本。数字原样；字符串原样；缺席（未设置）给空串。 */
function textOf(value: JsonValue | undefined): string {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  return ''
}

/** 页面读数面：`loading` 与 `unavailable` 是两种不同的「还没好」，不折叠成一个布尔。 */
interface ReadyPage {
  status: 'ready'
  writable: boolean
  revision: number
  value: Record<string, JsonValue>
  user: Record<string, JsonValue>
}

type UnavailableState = { status: 'unavailable'; reason?: string }

type PageState =
  | { status: 'loading' }
  | UnavailableState
  | ReadyPage

function readyPage(view: SettingsNamespaceView, writable: boolean): ReadyPage {
  return {
    status: 'ready',
    writable,
    revision: view.revision,
    value: isRecord(view.value) ? view.value : {},
    user: isRecord(view.user) ? view.user : {},
  }
}

function unavailablePage(reason?: string): UnavailableState {
  return reason === undefined ? { status: 'unavailable' } : { status: 'unavailable', reason }
}

/** 草稿机的投影：视图只吃 `fields` 与三个聚合布尔/计数，不自己重算 dirty / invalid / overridden。 */
export type ConfigDraftState =
  | { status: 'loading' }
  | { status: 'unavailable'; reason?: string }
  | {
    status: 'ready'
    writable: boolean
    fields: Record<FieldName, FieldState>
    dirty: boolean
    invalid: boolean
    dirtyCount: number
    saving: boolean
    failure: string | null
  }

/** 脏字段计数：只认已保存值之外的草稿（与「已覆盖」正交）。 */
export function dirtyCountOf(fields: Record<FieldName, FieldState>): number {
  let count = 0
  for (const name of FIELD_NAMES) if (fields[name].dirty) count += 1
  return count
}

export interface ConfigDraft {
  store: Store<ConfigDraftState>
  /** 按 remote 重读一遍编目：挂载与替换设置面都走这里。 */
  load: (remote: RemoteSettingsLike) => void
  edit: (name: FieldName, text: string) => void
  reset: (name: FieldName) => void
  save: () => void
  discard: () => void
  setTranslate: (translate: Translate) => void
  /** 卸载：带脏草稿离开时把「丢了几项」交给全局错误出口。 */
  dispose: () => void
}

export interface ConfigDraftOptions {
  ns: string
  translate: Translate
  /** 每次读到有效值（初始 / 保存 / 恢复默认 / 冲突重读）都交给播放层推进回退链。 */
  onEffectiveValue: (value: Record<string, JsonValue>) => void
}

/**
 * 草稿机。宿主设置面没有变更订阅，写协议只有 `describe` / `mutate` 两发；本模块按住这一屏的
 * 草稿、修订号与写入编排，React 只读它的投影。失败一律保留草稿并原样显示宿主理由：值域归
 * schema，冲突时重读修订号但不碰用户刚敲的值。
 */
export function createConfigDraft(options: ConfigDraftOptions): ConfigDraft {
  const { ns, onEffectiveValue } = options
  let translate = options.translate
  let remote: RemoteSettingsLike | null = null
  let page: PageState = { status: 'loading' }
  let drafts: Partial<Record<FieldName, string>> = {}
  let saving = false
  let failure: string | null = null
  let seq = 0
  let disposed = false
  const store = createStore<ConfigDraftState>({ status: 'loading' })

  const project = (): ConfigDraftState => {
    if (page.status === 'loading') return { status: 'loading' }
    if (page.status === 'unavailable') return unavailablePage(page.reason)
    const ready = page
    const stored = ready.value
    const fields = {} as Record<FieldName, FieldState>
    for (const name of FIELD_NAMES) {
      const text = drafts[name] ?? textOf(stored[name])
      const fieldDirty = drafts[name] !== undefined && text !== textOf(stored[name])
      const fieldInvalid = !parseField(FIELDS[name], text).ok
      fields[name] = {
        text,
        overridden: Object.hasOwn(ready.user, name) || fieldDirty,
        invalid: fieldInvalid,
        dirty: fieldDirty,
      }
    }
    const dirtyCount = dirtyCountOf(fields)
    return {
      status: 'ready',
      writable: ready.writable,
      fields,
      dirty: dirtyCount > 0,
      invalid: FIELD_NAMES.some((name) => fields[name].dirty && fields[name].invalid),
      dirtyCount,
      saving,
      failure,
    }
  }

  const publish = (): void => {
    if (!disposed) store.set(project())
  }

  /** 读到新 view = 新修订号与新有效值：有效值同步给播放层，回退链不用等面板重载。 */
  const readPage = (view: SettingsNamespaceView, writable: boolean): ReadyPage => {
    const ready = readyPage(view, writable)
    page = ready
    onEffectiveValue(ready.value)
    return ready
  }

  const applyView = (view: SettingsNamespaceView, writable: boolean): void => {
    readPage(view, writable)
    drafts = {}
    publish()
  }

  const dropDraft = (name: FieldName): void => {
    const next = { ...drafts }
    Reflect.deleteProperty(next, name)
    drafts = next
  }

  const refresh = async (): Promise<void> => {
    const active = remote
    if (active === null) return
    try {
      const result = await active.describe()
      if (disposed || !result.ok) return
      const view = result.value.namespaces.find((candidate) => candidate.ns === ns)
      if (view !== undefined) {
        readPage(view, result.value.writable)
        publish()
      }
    } catch {
      // 刷新也失败时保留原失败提示；旧修订号会让下一次写继续报冲突，不会静默覆盖。
    }
  }

  const fail = async (error: { message: string; code?: string }): Promise<void> => {
    failure = error.message
    publish()
    if (error.code === 'settings/conflict') await refresh()
  }

  const edit = (name: FieldName, text: string): void => {
    drafts = { ...drafts, [name]: text }
    failure = null
    publish()
  }

  const discard = (): void => {
    drafts = {}
    failure = null
    publish()
  }

  const save = (): void => {
    const snapshot = store.get()
    if (page.status !== 'ready' || !page.writable || saving) return
    if (snapshot.status !== 'ready' || !snapshot.dirty || snapshot.invalid) return
    const active = remote
    if (active === null) return
    const ops: SettingsPathOp[] = []
    for (const name of FIELD_NAMES) {
      const field = snapshot.fields[name]
      if (!field.dirty) continue
      const parsed = parseField(FIELDS[name], field.text)
      if (parsed.ok) ops.push(parsed.op)
    }
    if (ops.length === 0) return
    const current = page
    saving = true
    failure = null
    publish()
    void (async () => {
      try {
        const result = await active.mutate(ns, ops, current.revision)
        if (disposed) return
        if (!result.ok) { await fail(result.error); return }
        applyView(result.value, current.writable)
      } catch (error: unknown) {
        failure = error instanceof Error ? error.message : String(error)
        publish()
      } finally {
        saving = false
        publish()
      }
    })()
  }

  const reset = (name: FieldName): void => {
    if (page.status !== 'ready' || !page.writable || saving) return
    const active = remote
    if (active === null) return
    failure = null
    // 没有用户层覆盖：这一下只是撤本地草稿，不触远程。
    if (!Object.hasOwn(page.user, name)) {
      if (drafts[name] !== undefined) dropDraft(name)
      publish()
      return
    }
    const current = page
    saving = true
    publish()
    void (async () => {
      try {
        const result = await active.mutate(ns, [{ op: 'unset', path: [name] }], current.revision)
        if (disposed) return
        // 草稿只在 unset 成功后丢：失败时用户刚敲的值仍在（与保存失败同一口径）。
        if (!result.ok) { await fail(result.error); return }
        readPage(result.value, current.writable)
        dropDraft(name)
        publish()
      } catch (error: unknown) {
        failure = error instanceof Error ? error.message : String(error)
        publish()
      } finally {
        saving = false
        publish()
      }
    })()
  }

  const load = (next: RemoteSettingsLike): void => {
    // 同一实例会连跑两趟 effect（StrictMode 的 mount → cleanup → mount）：load 是它的复活点。
    disposed = false
    remote = next
    const ticket = ++seq
    page = { status: 'loading' }
    failure = null
    publish()
    const failDescribe = (error: unknown): void => {
      if (disposed || ticket !== seq) return
      page = unavailablePage(error instanceof Error ? error.message : String(error))
      publish()
    }
    try {
      void next.describe().then((result) => {
        if (disposed || ticket !== seq) return
        if (!result.ok) {
          page = unavailablePage(result.error.message)
          publish()
          return
        }
        const view = result.value.namespaces.find((candidate) => candidate.ns === ns)
        if (view === undefined) {
          page = unavailablePage()
          publish()
          return
        }
        applyView(view, result.value.writable)
      }).catch(failDescribe)
    } catch (error: unknown) {
      failDescribe(error)
    }
  }

  const setTranslate = (next: Translate): void => { translate = next }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    seq += 1
    const current = store.get()
    const lost = current.status === 'ready' ? current.dirtyCount : 0
    if (lost > 0) pushError(translate('config.droppedOnLeave', { n: lost }))
  }

  return { store, load, edit, reset, save, discard, setTranslate, dispose }
}

export interface ConfigDraftBinding {
  state: ConfigDraftState
  edit: (name: FieldName, text: string) => void
  reset: (name: FieldName) => void
  save: () => void
  discard: () => void
}

/** React 面：每挂载一台草稿机；remote 换人时重读编目，卸载那一发由草稿机自己结账。 */
export function useConfigDraft(options: ConfigDraftOptions & { remote: RemoteSettingsLike }): ConfigDraftBinding {
  const { ns, remote, translate, onEffectiveValue } = options
  const [draft] = useState(() => createConfigDraft({ ns, translate, onEffectiveValue }))
  const state = useStore(draft.store)
  useEffect(() => { draft.setTranslate(translate) }, [draft, translate])
  useEffect(() => { draft.load(remote) }, [draft, remote])
  useEffect(() => () => { draft.dispose() }, [draft])
  return { state, edit: draft.edit, reset: draft.reset, save: draft.save, discard: draft.discard }
}
