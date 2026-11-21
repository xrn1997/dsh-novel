/** 与宿主设置面同一条 wire 语义的窄镜像（`ADR-0020`）：只声明配置页用到的成员。
 *  写协议与值域仍归宿主 schema；这里只给表单面一个可替换的类型缝。 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface SettingsNamespaceView {
  ns: string
  value: JsonValue
  user?: JsonValue
  revision: number
}

export interface SettingsDescribeValue {
  writable: boolean
  namespaces: SettingsNamespaceView[]
}

export type SettingsPathOp =
  | { op: 'set'; path: string[]; value: JsonValue }
  | { op: 'unset'; path: string[] }

export type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: { message: string; code?: string } }

export interface RemoteSettingsLike {
  describe(): Promise<RemoteResult<SettingsDescribeValue>>
  mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<RemoteResult<SettingsNamespaceView>>
}
