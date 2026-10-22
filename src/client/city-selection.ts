import { useCallback, useRef, useState } from 'react'
import type { CitySelection, RememberedSelection } from './city-entry.js'
import { cityStore } from './store.js'

/** 选中态的唯一写口：React 投影（本挂载）与 `cityStore`（跨卸载）一起写。
 *  `null` = 本挂载还没落位；`isAsked` 是本挂载的 one-shot（自动进入那条路最多动作一次），
 *  卸载即重置，与 `explore-job` 内部的 `submitted`（提交回包已到）不是同一条语义。
 *  one-shot 用 ref 而不是 state：StrictMode 的同实例二次 effect 必须在 state 落地前就看见它。 */
export function useCitySelection(): {
  selection: CitySelection | null
  select: (next: CitySelection, opts?: { asked?: true }) => void
  isAsked: () => boolean
} {
  const [selection, setSelection] = useState<CitySelection | null>(null)
  const asked = useRef(false)
  const select = useCallback((next: CitySelection, opts?: { asked?: true }): void => {
    setSelection(next)
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
