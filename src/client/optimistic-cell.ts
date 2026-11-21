import { useEffect, useState } from 'react'

/**
 * 行内乐观单元格：点击即翻本地展示——大列表的全量 reload 有一拍延迟，没有乐观反馈用户会
 * 以为「点不动」；失败即刻清零回滚，不等 reload。
 *
 * 让位判据只在此一处：服务端值一变就清乐观值——另一入口（批量条 / AI 工具）改了服务端后，
 * 残留的乐观值会永久顶住真相。「ok = 服务端已应用」是本仓契约，故同值 reload 不清
 * （清了会在落地前闪回旧态）。
 *
 * 在途计数是「保存中」装饰的精确生命周期：并发的多击各自增减，任一在途即装饰；
 * 成功静默，失败由 `commit` 自己上报。
 *
 * 已知残余：同一格连点两下、先发那笔后失败时，清乐观值会闪一帧服务端旧值（后一笔落地或
 * reload 纠正）；为这一格给每次提交排号不划算，如实记在这里。
 */

export interface OptimisticCell {
  /** 展示值：乐观态在场用它，否则服务端值 */
  value: boolean
  /** 在途写数大于零（行内装饰据此显示「保存中」） */
  saving: boolean
  /** 提交一次翻转；`commit` 返回 false = 已报错，乐观值即刻清掉 */
  toggle: (next: boolean) => void
}

/** 一份实现服务同族的多个布尔格：服务端值 + 写口 → 乐观值 / 在途 / 提交。 */
export function useOptimisticCell(
  server: boolean,
  commit: (next: boolean) => Promise<boolean>,
): OptimisticCell {
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const [savingN, setSavingN] = useState(0)
  useEffect(() => { setOptimistic(null) }, [server])
  return {
    value: optimistic ?? server,
    saving: savingN > 0,
    toggle: (next) => {
      setOptimistic(next)
      setSavingN((n) => n + 1)
      void commit(next).then((ok) => {
        setSavingN((n) => n - 1)
        if (!ok) setOptimistic(null)
      })
    },
  }
}
