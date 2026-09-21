import type { ReactNode } from 'react'
import { prodDeps } from '../deps.js'
import type { SettingsDeps } from '../deps.js'
import { requestJobOpen, useJobPolling, useJobSurface } from '../jobs.js'
import { navigate } from '../store.js'
import { NovelStyles } from '../styles.js'
import { GlobalStatusBar } from './SettingsStatusBar.js'

/**
 * 常驻状态层：注册在宿主 `shell.overlay`（root 作用域、list 基数、官方明写「a badge, a toast
 * stack or a status pill all belong here」），做的事只有一件——把「任务还在跑 / 出了错」这句话
 * 在**任何界面**都说得出口。
 *
 * 为什么不能住在小说视图里：中央呈现座位一次只渲染一个面板（旧 `conversation.view`「rendered
 * one at a time」；2026-09 迁移后的 `main` keyed 槽同样按侧栏选中渲染），住在面板内的状态条
 * 一切走就没了，而任务其实在服务端照跑——「任务在服务端继续」那句文案原先只在人坐着不动时成立。
 * 轮询单实例也一起搬到这里：它是这份现场的唯一读者与写者（`useJobPolling` → `jobSurface`），
 * 视图环内的书源管理区只读镜像，不再各自轮询。
 *
 * 点击任务泳道是跨子树动作（overlay 与小说视图不同分支）：记一次意图 + 路由去书源管理，
 * `SettingsSection` 消费意图（开弹层 / 滚到任务卡）。不靠 querySelector 隔空点钮。
 *
 * 样式层与 token 锚点**必须自带**，不能借小说视图那份：本层与视图不同分支，切到「对话」tab 即
 * 视图卸载、`<style data-novel-style>` 随之消失（真机实测：状态条剥成 16px 裸文字、
 * `z-index` 塌成 `auto`）。而 `--novel-*` 定义在 `.novel-root, [data-novel-scope]` 上，
 * 宿主 overlay 子树里没有 `.novel-root` 祖先 ⇒ 不给 `data-novel-scope` 就整棵取不到值
 * （同「独立挂载点自带样式层」的 `SettingsSection` 先例）。
 */
export function NovelStatusOverlay({ deps = prodDeps }: { deps?: SettingsDeps } = {}): ReactNode {
  useJobPolling(deps)
  const { job, stale } = useJobSurface()
  const onOpen = (): void => {
    if (job === null) return
    requestJobOpen(job.kind === 'import' ? 'import' : 'probe')
    navigate({ name: 'sources' })
  }
  return (
    <div data-novel-shell-status data-novel-scope className="novel-shell-status">
      <NovelStyles />
      <GlobalStatusBar job={job} stale={stale} onOpen={onOpen} />
    </div>
  )
}
