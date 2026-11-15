import { useEffect, useState } from 'react'
import { ROUTES } from '../../shared/wire.js'
import type { TtsSourceInfo } from '../../shared/wire.js'
import { describeError } from '../api.js'
import { useCopy } from '../copy/index.js'

/**
 * 引擎清单读面（听书条与迷你条共用）：只在面板打开时取（面板才需要它；直出模式的音色表
 * 另有同步读面），每次打开都重取——订阅引擎可能在配置页被增删，组件常驻不重挂也不该拿
 * 旧清单糊弄。失败不保留旧清单：收起后下次打开重试，这一轮按「不知道音色」渲染（行不出现）。
 *
 * 读面与失败上报由调用方注入：阅读器条那束来自 ReaderView 的注入面，迷你条走全局读口——
 * 取数失败都进瞬态错误层，这里不自造第二个错误家。
 */
export function useTtsSources(
  open: boolean,
  apiGet: <T>(path: string) => Promise<T>,
  pushError: (message: string) => void,
): TtsSourceInfo[] | null {
  const t = useCopy()
  const [sources, setSources] = useState<TtsSourceInfo[] | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    setSources(null)
    void apiGet<TtsSourceInfo[]>(ROUTES.ttsSources.path).then(
      (list) => { if (alive) setSources(list) },
      (error: unknown) => {
        if (alive) pushError(t('tts.sourcesFailed', { detail: describeError(error, t) }))
      },
    )
    return () => { alive = false }
  }, [open, apiGet, pushError, t])

  return sources
}
