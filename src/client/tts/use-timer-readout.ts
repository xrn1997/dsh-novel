import { useEffect, useState } from 'react'
import type { Translate } from '../copy/index.js'
import { timerReadout } from './listen-readout.js'
import type { ListenReadoutState, TimerReadout } from './listen-readout.js'

/**
 * 定时读数的每秒节拍：听书条与浮窗定时 chip 共用这一份。
 *
 * 读数换算仍归 `listen-readout.ts` 的纯函数（它不读墙钟、不碰 React）；本文件只补「秒表由
 * 哪个表面驱动」——两个表面各自 `setInterval` 就是两份节拍，卸载/暂停时的清理也各写一遍。
 * 只在分钟档计时中装表；本章档与未定时没有可跳的读数，不装。
 */
export function useTimerReadout(st: ListenReadoutState, t: Translate): TimerReadout {
  const readout = timerReadout(st, t, Date.now())
  const [, setBeat] = useState(0)
  useEffect(() => {
    if (!readout.counting) return
    const handle = setInterval(() => { setBeat((n) => n + 1) }, 1000)
    return () => { clearInterval(handle) }
  }, [readout.counting])
  return readout
}