import type { ReactNode } from 'react'
import { useCopy } from '../copy/index.js'
import { moyuStore, toggleMoyu } from '../moyu-store.js'
import { useStoreValue } from '../store.js'

/** 阅读器工具条的「摸鱼」钮：外观复用 novel-rdr-ctl，在场位自管 store 订阅。 */
export function MoyuToggle(): ReactNode {
  const t = useCopy()
  const on = useStoreValue(moyuStore, (s) => s.on)
  return (
    <button
      className={on ? 'novel-rdr-ctl novel-moyu-on' : 'novel-rdr-ctl'}
      aria-pressed={on}
      aria-label={t('reader.moyu.open')}
      title={t('reader.moyu.open')}
      onClick={toggleMoyu}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16">
        <path d="M2 8c2.2-2.6 5.8-2.6 8 0-2.2 2.6-5.8 2.6-8 0z" />
        <path d="M10 8l3.2-2.4v4.8z" />
        <path d="M4.9 7.5h.01" />
      </svg>
      {t('reader.moyu.open')}
    </button>
  )
}
