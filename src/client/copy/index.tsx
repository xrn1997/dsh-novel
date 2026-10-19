import { createContext, useContext, type ReactNode } from 'react'
import { COMMON_EN, COMMON_ZH } from './common.js'
import { NAVIGATION_EN, NAVIGATION_ZH } from './navigation.js'
import { SHELF_EN, SHELF_ZH } from './shelf.js'
import { CITY_EN, CITY_ZH } from './city.js'
import { SEARCH_EN, SEARCH_ZH } from './search.js'
import { READER_EN, READER_ZH } from './reader.js'
import { SOURCES_EN, SOURCES_ZH } from './sources.js'
import { SETTINGS_EN, SETTINGS_ZH } from './settings.js'

/** 第三方命名空间必须带插件前缀；官方占用 `common` / `settings` / `sidebar`。 */
export const COPY_NS = 'xrn1997-dsh-novel'

/** ZH 是真源；EN 用 Record<CopyKey, string> 逐键镜像（漏键编译不过）。 */
export const ZH = {
  ...COMMON_ZH, ...NAVIGATION_ZH, ...SHELF_ZH, ...CITY_ZH,
  ...SEARCH_ZH, ...READER_ZH, ...SOURCES_ZH, ...SETTINGS_ZH,
} as const

export type CopyKey = keyof typeof ZH
export const EN: Record<CopyKey, string> = {
  ...COMMON_EN, ...NAVIGATION_EN, ...SHELF_EN, ...CITY_EN,
  ...SEARCH_EN, ...READER_EN, ...SOURCES_EN, ...SETTINGS_EN,
}

export type CopyParams = Readonly<Record<string, string | number>>
export type Translate = (key: CopyKey, params?: CopyParams) => string

/** 与宿主 translate 同一条替换规则：`{name}`，参数缺席时原样留下占位符。 */
export function interpolate(template: string, params?: CopyParams): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match)
}

export const zhTranslate: Translate = (key, params) => interpolate(ZH[key] ?? key, params)
export const enTranslate: Translate = (key, params) => interpolate(EN[key] ?? key, params)

/** 数量句：中文两侧同文，英文由 one/other 决定单复数。 */
export function plural(
  t: Translate, n: number, one: CopyKey, other: CopyKey, params?: CopyParams,
): string {
  return t(n === 1 ? one : other, { ...params, n })
}

/** 宿主 locale 服务的窄镜像：只声明本插件用到的成员，不装宿主类型包。 */
interface LocaleServiceLike {
  register(ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): () => void
  bind(ns: string): (key: string, params?: CopyParams) => string
}

/** 可选服务的读面：老宿主没有 `ctx.get` 时也要能回退。 */
export interface CopyHostLike {
  get?(name: string): unknown
  effect(execute: () => unknown, label?: string): unknown
}

/**
 * 注册字典并交回本插件的 t。服务缺席（或老宿主没有 ctx.get）时返回 zhTranslate；
 * apply 时读一次、晚到不追（宿主 locale 包声明 immediately，正常组合里先提供）。
 * 注册必须挂 ctx.effect：register 的 disposer 是官方契约，HMR 重挂不摘会撞 "already has locale"。
 *
 * 已知限制：已生成并入 transient / job / 会话快照的错误文案在**生成时**定语言，切换语言不重翻
 * 存量条目（与宿主 locale 包同类）；视图本地 state 里的错误同样冻在生成时的语言。不为此把
 * store / 视图 state 改成消息对象。
 */
export function createTranslate(ctx: CopyHostLike): Translate {
  const service = ctx.get?.('locale') as LocaleServiceLike | undefined
  if (service === undefined) return zhTranslate
  ctx.effect(() => service.register(COPY_NS, { zh: ZH, en: EN }), 'dsh-novel: copy dictionaries')
  // 服务形状畸形（第三方包的旧版 / 半个实现）时 bind 可能缺席或返回非函数：locale 是可选服务，
  // 宁可退回中文，也不能把首帧渲染炸掉。
  if (typeof service.bind !== 'function') return zhTranslate
  const bound = service.bind(COPY_NS)
  return typeof bound === 'function' ? (key, params) => bound(key, params) : zhTranslate
}

const CopyContext = createContext<Translate>(zhTranslate)

/** 入口根提供 t；默认 zh 让测试与直渲组件保持现有中文断言。 */
export function CopyProvider({ value = zhTranslate, children }: {
  value?: Translate
  children: ReactNode
}): ReactNode {
  return <CopyContext.Provider value={value}>{children}</CopyContext.Provider>
}

export function useCopy(): Translate {
  return useContext(CopyContext)
}
