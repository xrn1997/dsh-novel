import { useCallback, useRef } from 'react'
import type { CitySelection, RememberedSelection } from './city-entry.js'
import { cityStore, useStore } from './store.js'

/** 选中态的唯一写口：`select` 只写 `cityStore`（跨卸载现场）；本挂载的 `selection` 就是它的投影，
 *  不再另持一份 React state——否则外部写 store 不会驱动渲染，两份副本还会靠视图 effect 互相回填。
 *  `null` = 记住的源与分类不俱在（还没选过，或只落了一半）。
 *  `isAsked` 是本挂载的 one-shot（自动进入那条路最多动作一次），卸载即重置，与 `explore-job` 内部的
 *  `submitted`（提交回包已到）不是同一条语义。
 *  one-shot 用 ref 而不是 state：StrictMode 的同实例二次 effect 必须在 state 落地前就看见它。 */
export function useCitySelection(): {
  selection: CitySelection | null
  select: (next: CitySelection, opts?: { asked?: true }) => void
  isAsked: () => boolean
} {
  const remembered = useStore(cityStore)
  const selection = remembered.sourceId !== null && remembered.kind !== null
    ? { sourceId: remembered.sourceId, kind: remembered.kind }
    : null
  const asked = useRef(false)
  const select = useCallback((next: CitySelection, opts?: { asked?: true }): void => {
    cityStore.set(next)
    if (opts?.asked === true) asked.current = true
  }, [])
  const isAsked = useCallback((): boolean => asked.current, [])
  return { selection, select, isAsked }
}

/** 只读跨卸载现场：进入判据需要它，写口仍只有 `select`。 */
export function rememberedCitySelection(): RememberedSelection {
  return cityStore.get()
}
