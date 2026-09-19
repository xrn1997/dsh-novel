import type { Context } from '@deepseek-ai/cordis'
import { NovelStatusOverlay } from './views/NovelStatusOverlay.js'
import { NovelView } from './views/NovelView.js'

export const inject = ['slots', 'sessions']

/**
 * 浏览器半入口：注册对话区视图环的「小说」tab（slot-only 路线——DSH 插件 API 调研（docs/reference/dsh-plugin-api.md）§5 证实：
 * 独立应用 view 不需要 uiConversation.views/events.register，壳层对未注册 target 宽容）。
 *
 * 2026 IA 变更（用户拍板）：书架 | 书城 | 书源管理 并列为小说视图内 tab——书源管理整体搬入
 * 主界面（routeStore 的 sources 成员渲染 SettingsSection），宿主设置「小说」区块的
 * settings.section 注册随之**撤除**：单一归属（轮询单实例、现场 store 单份），不搞双入口。
 * SettingsSection 组件本体未动（deps 整壳注入 + 自带 NovelStyles/data-novel-scope，
 * 在哪棵树渲染都自足）；挂载点只有一个的事实由本文件的注册清单守着。
 */
export function apply(ctx: Context): void {
  const slots = (ctx as unknown as {
    slots: {
      inject(name: string, fn: () => () => void): () => void
      register(options: Record<string, unknown>, component: unknown): () => void
    }
  }).slots
  ctx.effect(() => slots.inject('conversation.view', () => slots.register(
    { name: 'conversation.view', id: 'novel', order: 20, label: '小说' },
    NovelView,
  )), 'dsh-novel: conversation view')
  // 常驻状态层挂 shell.overlay（root 作用域、list 基数、默认 click-through）：与 sidebar/main/
  // rightbar 并列，切 tab 与切会话都不卸载它——任务读数的唯一常驻住址。
  // pointer-events 由样式层 .novel-shell-status 的条目自己收回（浮层层默认不吃点击）。
  ctx.effect(() => slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'novel-status', order: 100, label: '小说任务状态' },
    NovelStatusOverlay,
  )), 'dsh-novel: shell overlay status layer')
}

export { NovelStatusOverlay, NovelView }
