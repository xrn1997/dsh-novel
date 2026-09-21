import type { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import { NovelStatusOverlay } from './views/NovelStatusOverlay.js'
import { NovelView } from './views/NovelView.js'

export const inject = ['slots', 'sessions']

/**
 * 浏览器半入口：把「小说」注册为**全局面板**（2026-09 迁移，用户拍板）——侧栏
 * `sidebar.panellist` 一行图标 + `main` keyed 槽同 id 的中央面板，不再是对话区
 * `conversation.view` tab。宿主契约（本机 host checkout 实证，`docs/reference/dsh-plugin-api.md`
 * §10 证据 10c）：
 *
 * - `sidebar.panellist`（root 作用域 list）：注册项 `{ id, order?, label? }`；宿主 sidebar
 *   shell 自带行按钮、`aria-current` 选中态、折叠 tooltip，点击 = `ctx.layout.selectPanel(id)`；
 *   占用者组件只收 owner props `{ size, active }` 出一个图标，无障碍名归宿主行的 label。
 * - `main`（root 作用域 keyed）：「Central panel selected by sidebar entry id」，注册项
 *   `{ key }`；AppFrame 按侧栏选中的 id 渲染 main 里同 key 的占用者。保留键 `conversation`
 *   归 Conversation；其余 key 无 Session 绑定（小说本就不吃会话数据）。
 * - **两个座位必须同批注册**：官方契约明写「selecting a missing main entry throws without
 *   changing the current selection」——apply 内同步双注册，不存在半注册窗口。
 *
 * `conversation.view` 注册随之**撤除**：单一归属口径延续（2026 IA 撤 `settings.section`、
 * 本轮撤对话区 tab）——小说只挂全局面板这一个入口。视图环内的状态不留：业务真相在服务端
 * （后台任务 + 显式快照），交互现场在模块级 store（routeStore / sourceListUi / jobSurface），
 * keyed 槽切走面板即卸载组件树，回来照常恢复。常驻状态层仍住 `shell.overlay`（root 作用域、
 * list 基数、默认 click-through）：任务读数要在**任何面板**都说得出口，与本次迁移正交。
 */

/** 全局面板行的图标：宿主行给 `{ size, active }`（`SidebarPanelIconOwnerProps`），
 *  行本体（按钮、aria-current、tooltip、选中底色）全归宿主 sidebar shell——我们只出图，
 *  `active` 刻意不用（不自造第二套选中态；宿主行的 `panelActive` 类 + `aria-current` 已是
 *  唯一选中呈现，契约字段留在类型里即可）。
 *
 * 字形 = **android-ebook 的启动器前景**（用户指定，2026-09）：外部资产原文
 * `xrn1997/android-ebook @ master` 的 `module_app/src/main/res/drawable-v24/
 * ic_launcher_foreground.xml`（blob 80f575c：viewport 2178.7234 + group translate
 * 577.3617，fillColor 为不透明黑 0xFF000000）。搬运用法：pathData **原样**保留，裁掉
 * 自适应图标的安全区留白——viewBox 取 group 坐标系 `0 0 1025 1025`（字形 bbox 约
 * 39..986 × 20..979，原 canvas 里字形只占 ~47%，16px 行图标下会糊成一点），
 * `fill="currentColor"` 写在 path 上（随宿主行前景色走明暗主题；hex 不进本仓——
 * theme-tokens 守卫扫到即红，色值主人始终是宿主行）。背景层（`ic_launcher_background.xml`
 * = 纯白方块，blob b5cd46e）刻意不搬：侧栏行自带底色，白方块在暗色主题下是块白斑。
 * 机器钉子在 `tests/client/panel-registration.test.tsx`（pathData 来源防随手换回通用图标）。 */
function NovelPanelIcon({ size = 16 }: { size?: number; active?: boolean }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1025 1025"
      aria-hidden="true"
    >
      <path fill="currentColor" d="M410.74,19.6l81.7,0 0,171.54 343.06,0 -20.43,285.7 142.94,0c-5.44,68.08 -10.9,140.24 -16.34,216.46 -5.44,114.37 -62.62,170.18 -171.52,167.46 -51.74,0 -100.75,0 -147.02,0 0,-13.62 -5.46,-40.85 -16.34,-81.68 51.71,5.44 102.08,8.16 151.1,8.16 68.06,8.18 104.82,-25.86 110.27,-102.1 2.72,-51.73 5.44,-98.02 8.16,-138.86L492.43,546.27l0,432.91 -81.7,0L410.74,546.27 39.09,546.27l0,-69.44 371.65,0L410.74,264.67 104.43,264.67l0,-73.54 306.3,0L410.74,19.6zM749.71,264.67l-257.28,0 0,212.16 245.04,0L749.71,264.67zM716.72,76.62l53.1,-53.1c84.38,54.46 156.54,103.47 216.45,147.02l-53.09,65.34C889.62,197.78 817.46,144.69 716.72,76.62z" />
    </svg>
  )
}

/** `main` keyed 槽的占用者：小说全局面板本体（root 作用域，无 Session 绑定）。
 *  NovelView 自带样式层与 token 锚点（`data-novel-scope`），在 keyed 槽这棵子树里自足。 */
function NovelPanel(): ReactNode {
  return <NovelView />
}

export function apply(ctx: Context): void {
  const slots = (ctx as unknown as {
    slots: {
      inject(name: string, fn: () => () => void): () => void
      register(options: Record<string, unknown>, component: unknown): () => void
    }
  }).slots
  // 全局面板双注册（同 id/key「novel」，必须同批——官方契约：选中缺失的 main entry 会抛）
  ctx.effect(() => slots.inject('sidebar.panellist', () => slots.register(
    { name: 'sidebar.panellist', id: 'novel', order: 20, label: '小说' },
    NovelPanelIcon,
  )), 'dsh-novel: sidebar panel icon')
  ctx.effect(() => slots.inject('main', () => slots.register(
    { name: 'main', key: 'novel' },
    NovelPanel,
  )), 'dsh-novel: main panel')
  // 常驻状态层挂 shell.overlay（root 作用域、list 基数、默认 click-through）：与 sidebar/main/
  // rightbar 并列，切面板与切会话都不卸载它——任务读数的唯一常驻住址。
  // pointer-events 由样式层 .novel-shell-status 的条目自己收回（浮层层默认不吃点击）。
  ctx.effect(() => slots.inject('shell.overlay', () => slots.register(
    { name: 'shell.overlay', id: 'novel-status', order: 100, label: '小说任务状态' },
    NovelStatusOverlay,
  )), 'dsh-novel: shell overlay status layer')
}

export { NovelStatusOverlay, NovelView }
