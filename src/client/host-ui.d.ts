/**
 * 宿主表单原语（`@deepseek-ai/dsh-client-ui-primitives`）的窄类型镜像。
 *
 * 为什么不是装包：它是宿主平台模块，client bundle 留 external（平台模块表 / 纯度门），
 * 本仓只消费运行时注入的那一份；装一份真包既会把宿主版本绑死在 devDeps，也过不了纯度门。
 * 镜像只声明本仓用到的成员（ADR 0020 的窄镜像口径）。宿主契约真变了，本镜像**不会自己红**——
 *  本仓不装那个包、vitest 又把模块名 alias 到测试替身，类型层面两边互不相识。能红的是两处：
 *  配置页对每个成员的取用（成员没了就编译不过），以及替身与镜像的形状闸
 *  （`tests/client/ui-primitives-stub.tsx` 的 `_shapeGate`）。
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactNode } from 'react'

  /** 字段状态（0.2.1-rc.2 发布物核实）：当前文本、是否覆盖默认、是否非法。 */
  export interface SettingsFieldState {
    text: string
    overridden: boolean
    invalid: boolean
  }
  /** `SettingsFormModel.shell()` 的壳层状态（0.2.1-rc.2 发布物核实）：可用 / 可写 / 有改动 /
   *  有非法字段 / 保存中 / 上次保存失败。只镜像页面读到的这六项。 */
  export interface SettingsFormState {
    available: boolean
    writable: boolean
    dirty: boolean
    invalid: boolean
    saving: boolean
    failed: boolean
  }
  export interface SnapshotStore<T> {
    getSnapshot(): T
    subscribe(listener: () => void): () => void
  }
  export interface SettingsFormActions {
    save: () => void
    discard: () => void
    edit: (field: string, text: string) => void
    resetField: (field: string) => void
  }
  export class SettingsFormModel {
    /** 第三参是宿主给密文控件用的 write spec 表（本页不消费，只按真容收窄形状）。 */
    constructor(scope: unknown, fields: unknown[], secretSpecs?: unknown[])
    bind<T>(projection: () => T): SnapshotStore<T>
    shell(): SettingsFormState
    field(name: string): SettingsFieldState
    actions(): SettingsFormActions
    dispose(): void
  }
  export function settingsNumberField(name: string): unknown
  export function settingsTextField(name: string): unknown
  export function SettingsForm(props: {
    labels: Record<string, string>
    state: SettingsFormState
    onSave: () => void
    onDiscard: () => void
    children?: ReactNode
  }): ReactNode
}
