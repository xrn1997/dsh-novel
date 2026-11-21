import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { GROUPS } from './config-groups.js'
import type { FieldState } from './config-draft.js'
import { FIELDS, FIELD_NAMES, type FieldName } from './config-fields.js'
import type { CopyKey, Translate } from './copy/index.js'
import { createStore, useStore } from './store.js'

/** 分区选择器的值：`all` 是「不过分区」这一档，不是某个分区名。 */
export type ConfigSection = 'all' | CopyKey

interface IndexState {
  query: string
  section: ConfigSection
  onlyChanged: boolean
  secOpen: boolean
  resultsOpen: boolean
  /** 键盘高亮项在结果里的下标；结果变短后由派生夹回第一项，状态本身不追。 */
  activeResult: number
  collapsed: ReadonlySet<CopyKey>
  managerOpen: boolean
}

export interface ConfigIndexBinding {
  cardRef: RefObject<HTMLDivElement>
  filterRef: RefObject<HTMLInputElement>
  filterBoxRef: RefObject<HTMLDivElement>
  query: string
  section: ConfigSection
  onlyChanged: boolean
  secOpen: boolean
  resultsOpen: boolean
  activeResult: number
  managerOpen: boolean
  q: string
  results: readonly FieldName[]
  activeOptionId: string | undefined
  resultsId: string
  sectionItems: readonly { key: ConfigSection; label: string; count: number }[]
  labelOf: (name: FieldName) => string
  sectionLabelOf: (name: FieldName) => string
  visibleOf: (name: FieldName) => boolean
  anyVisible: boolean
  collapsedOf: (key: CopyKey) => boolean
  search: (value: string) => void
  focusSearch: () => void
  clearSearch: () => void
  toggleSections: () => void
  selectSection: (key: ConfigSection) => void
  toggleOnlyChanged: () => void
  onFilterKey: (event: ReactKeyboardEvent<HTMLInputElement>) => void
  jumpTo: (name: FieldName) => void
  toggleGroup: (key: CopyKey) => void
  toggleManager: () => void
}

/** 字段 → 所属分区：GROUPS 是分区的唯一表，这里只是按字段反查一次。 */
const GROUP_OF = new Map<FieldName, (typeof GROUPS)[number]>()
for (const group of GROUPS) for (const name of group.names) GROUP_OF.set(name, group)

export interface ConfigIndexOptions {
  t: Translate
  fields: Record<FieldName, FieldState>
  onSave: () => void
}

const INITIAL: IndexState = {
  query: '',
  section: 'all',
  onlyChanged: false,
  secOpen: false,
  resultsOpen: false,
  activeResult: 0,
  collapsed: new Set(),
  managerOpen: false,
}

/**
 * 配置索引现场：搜索词、分区、仅看已改、结果与高亮项、折叠集合、引擎管理区的开合。
 *
 * 筛选的每个 setter 都自带「页码/结果复位」的同一组副作用（输入即开结果并清高亮、换分区收起
 * 结果、跳转前松开所有会藏住目标的筛选），这些组合只在这里写一份。键盘（⌘K / ⌘S / Esc）也归
 * 这里：焦点在卡内才接 ⌘K；⌘S 一律拦浏览器默认、是否真写由草稿机判；配置页不是阅读浮层，
 * 不接宿主键盘层。
 */
export function useConfigIndex(options: ConfigIndexOptions): ConfigIndexBinding {
  const { t, fields, onSave } = options
  const [store] = useState(() => createStore<IndexState>(INITIAL))
  const state = useStore(store)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const filterRef = useRef<HTMLInputElement | null>(null)
  const filterBoxRef = useRef<HTMLDivElement | null>(null)
  const resultsId = useId()

  const q = state.query.trim().toLowerCase()
  const labelOf = (name: FieldName): string => t(FIELDS[name].labelKey)
  const sectionLabelOf = (name: FieldName): string => {
    const group = GROUP_OF.get(name)
    return group === undefined ? '' : t(group.titleKey)
  }
  // 匹配面三处：显示名、说明，以及字段键本身（`ttsDefaultRate` 这类）——占位符承诺「名称」，
  // 而使用者手里最容易拿到的恰恰是键名（配置表 / 日志 / 文档里写的都是它）。
  const matchOf = (name: FieldName): boolean => q === ''
    || name.toLowerCase().includes(q)
    || labelOf(name).toLowerCase().includes(q)
    || t(FIELDS[name].meaningKey).toLowerCase().includes(q)
  const visibleOf = (name: FieldName): boolean =>
    (state.section === 'all' || GROUP_OF.get(name)?.titleKey === state.section)
    && matchOf(name)
    && (!state.onlyChanged || fields[name].dirty)
  const results = q === '' ? [] : FIELD_NAMES.filter(visibleOf)
  /** 键盘高亮那一项（越界时回落到第一项）：combobox 的 aria-activedescendant 指向它。 */
  const activeName = results[state.activeResult] ?? results[0]
  const activeIndex = activeName === undefined ? undefined : results.indexOf(activeName)
  const activeOptionId = activeIndex === undefined ? undefined : `${resultsId}-opt-${activeIndex}`
  const anyVisible = FIELD_NAMES.some(visibleOf)
  const collapsedOf = (key: CopyKey): boolean =>
    q === '' && !state.onlyChanged && state.collapsed.has(key)
  const sectionItems = [
    { key: 'all' as const, label: t('config.filter.all'), count: FIELD_NAMES.length },
    ...GROUPS.map((group) => ({ key: group.titleKey, label: t(group.titleKey), count: group.names.length })),
  ]

  const closeMenus = (): void => { store.set({ secOpen: false, resultsOpen: false }) }
  const search = (value: string): void => {
    store.set({ query: value, resultsOpen: true, secOpen: false, activeResult: 0 })
  }
  const focusSearch = (): void => { store.set({ resultsOpen: store.get().query.trim() !== '' }) }
  const clearSearch = (): void => { store.set({ query: '', resultsOpen: false }) }
  const toggleSections = (): void => {
    store.set({ secOpen: !store.get().secOpen, resultsOpen: false })
  }
  const selectSection = (key: ConfigSection): void => { store.set({ section: key, secOpen: false }) }
  const toggleOnlyChanged = (): void => { store.set({ onlyChanged: !store.get().onlyChanged }) }
  const stepActive = (delta: number, count: number): void => {
    const current = store.get().activeResult
    store.set({
      resultsOpen: true,
      activeResult: delta > 0 ? Math.min(current + 1, count - 1) : Math.max(current - 1, 0),
    })
  }

  const jumpTo = (name: FieldName): void => {
    // 跳过去之前先松开会藏住它的筛选（只看已改 / 分区）：目标已经在结果里，说明它过搜索这一关。
    store.set({ onlyChanged: false, section: 'all', resultsOpen: false })
    const target = document.getElementById(`novel-config-${name}`)
    if (target === null) return
    target.scrollIntoView({ block: 'center' })
    target.focus({ preventScroll: true })
  }

  const onFilterKey = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' && results.length > 0) {
      event.preventDefault()
      stepActive(1, results.length)
      return
    }
    if (event.key === 'ArrowUp' && results.length > 0) {
      event.preventDefault()
      stepActive(-1, results.length)
      return
    }
    if (event.key === 'Enter') {
      const target = results[state.activeResult] ?? results[0]
      if (target !== undefined) {
        event.preventDefault()
        jumpTo(target)
      }
      return
    }
    if (event.key === 'Escape') closeMenus()
  }

  const toggleGroup = (key: CopyKey): void => {
    const next = new Set(store.get().collapsed)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    store.set({ collapsed: next })
  }
  const toggleManager = (): void => { store.set({ managerOpen: !store.get().managerOpen }) }

  // 筛选区的两枚浮层要有统一的出口：点别处收起来（Esc 走键盘那一条）。
  useEffect(() => {
    if (!state.secOpen && !state.resultsOpen) return
    const onDown = (event: MouseEvent): void => {
      if (filterBoxRef.current !== null && !filterBoxRef.current.contains(event.target as Node)) {
        store.set({ secOpen: false, resultsOpen: false })
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('mousedown', onDown) }
  }, [state.secOpen, state.resultsOpen, store])

  // 快捷键：⌘/Ctrl+K 聚焦筛选、⌘/Ctrl+S 保存、Esc 收浮层（输入法打开时 Esc 归输入法）。
  //  · K 是宿主也会用的全局命令（命令面板一类）：焦点不在本卡时一律不接管，否则等于替宿主
  //    改写同名键的语义。落在卡内任何位置（含筛选框自己）才把焦点交回筛选框。
  //  · S 先 preventDefault 再判条件：只在真保存时拦，浏览器「另存网页」就会在只读 / 非法 /
  //    无改动这三档里弹出来——那也是用户没要的意外。条件判在草稿机里（它知道此时此刻的脏值）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const meta = event.metaKey || event.ctrlKey
      const active = document.activeElement
      const inCard = cardRef.current !== null && active instanceof HTMLElement
        && cardRef.current.contains(active)
      if (meta && event.key.toLowerCase() === 'k') {
        if (!inCard) return
        event.preventDefault()
        filterRef.current?.focus()
        return
      }
      if (meta && event.key.toLowerCase() === 's') {
        event.preventDefault()
        onSave()
        return
      }
      if (event.key === 'Escape') store.set({ secOpen: false, resultsOpen: false })
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [store, onSave])

  return {
    cardRef, filterRef, filterBoxRef,
    query: state.query,
    section: state.section,
    onlyChanged: state.onlyChanged,
    secOpen: state.secOpen,
    resultsOpen: state.resultsOpen,
    activeResult: state.activeResult,
    managerOpen: state.managerOpen,
    q, results, activeOptionId, resultsId, sectionItems,
    labelOf, sectionLabelOf, visibleOf, anyVisible, collapsedOf,
    search, focusSearch, clearSearch, toggleSections, selectSection, toggleOnlyChanged,
    onFilterKey, jumpTo, toggleGroup, toggleManager,
  }
}
