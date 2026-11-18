import { useEffect, useState } from 'react'
import { ROUTES } from '../../shared/wire.js'
import type { TtsSourceInfo, TtsSourcesView } from '../../shared/wire.js'
import { describeError } from '../api.js'
import { useCopy } from '../copy/index.js'

/**
 * 引擎清单读面（听书条与迷你条共用）：只在面板打开时取（面板才需要它；直出模式的音色表
 * 另有同步读面），每次打开都重取——订阅引擎可能在配置页被增删，组件常驻不重挂也不该拿
 * 旧清单糊弄。**重取期间不清空旧清单**（stale-while-revalidate）：清单决定音色行在不在，
 * 每次打开先置空会让那一行先消失再出现，设置卡跟着长高/长矮一行——就是用户看到的那下「闪」。
 * 失败不保留旧清单：这一轮按「不知道音色」渲染（行不出现），收起后下次打开重试。
 *
 * 只取清单那一半：宿主服务为何缺席（`hostSpeech`）是管理面要回答的事，选择面里那行本来就不在
 * 清单上——把健康读数摆进下拉只会多出一个选了也合成不出的选项。
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
    void apiGet<TtsSourcesView>(ROUTES.ttsSources.path).then(
      (view) => { if (alive) setSources(view.sources) },
      (error: unknown) => {
        if (!alive) return
        setSources(null)                       // 失败不留旧清单：按「不知道音色」渲染，下次重试
        pushError(t('tts.sourcesFailed', { detail: describeError(error, t) }))
      },
    )
    return () => { alive = false }
  }, [open, apiGet, pushError, t])

  return sources
}
