import type { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import { registerConfigPage } from './config-page.js'
import {
  CopyProvider,
  createTranslate,
  zhTranslate,
  type CopyHostLike,
  type Translate,
} from './copy/index.js'
import { NOVEL_GLYPH_PATH, NOVEL_GLYPH_VIEWBOX } from './novel-glyph.js'
import { NovelStatusOverlay } from './views/NovelStatusOverlay.js'
import { NovelView } from './views/NovelView.js'

export const inject = ['slots', 'layout']

/**
 * 浏览器半入口：把「小说」注册为**全局面板**（2026-09 迁移，用户拍板）——侧栏
 * `sidebar.panellist` 一行图标 + `main` keyed 槽同 id 的中央面板，不再是对话区
 * `conversation.view` tab。宿主契约（本机 host checkout 实证）：
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
 *  `active` 刻意不用（宿主行已是唯一选中呈现，契约字段留在类型里即可）。
 *
 * 字形单点见 `novel-glyph.ts`；`fill="currentColor"` 随宿主行前景色走明暗。 */
function NovelPanelIcon({ size = 16 }: { size?: number; active?: boolean }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox={NOVEL_GLYPH_VIEWBOX}
      aria-hidden="true"
    >
      <path fill="currentColor" d={NOVEL_GLYPH_PATH} />
    </svg>
  )
}

/** 全局面板的 id/key 同一个词（官方契约：选中缺失的 main entry 会抛）——注册与「带到前台」共用一格。 */
const NOVEL_PANEL_ID = 'novel'

/** `main` keyed 槽的占用者：小说全局面板本体（root 作用域，无 Session 绑定）。
 *  NovelView 自带样式层与 token 锚点（`data-novel-scope`），在 keyed 槽这棵子树里自足。
 *  `t` 缺省走 zhTranslate：宿主槽位没接 inject 时（含测试直渲）保持既有中文断言。 */
function NovelPanel({ t = zhTranslate }: { t?: Translate }): ReactNode {
  return <CopyProvider value={t}><NovelView /></CopyProvider>
}

export function apply(ctx: Context): void {
  const slots = (ctx as unknown as {
    slots: {
      inject(name: string, fn: () => () => void): () => void
      register(options: Record<string, unknown>, component: unknown): () => void
    }
  }).slots
  // 宿主 layout 服务窄镜像（ADR 0020：只声明用到的成员、一次强转）：把面板带到前台是宿主的活，
  // 插件不碰 sidebar shell 的行按钮与选中态，只在「去现场」时调它同款的 selectPanel。
  const { layout } = ctx as unknown as { layout: { selectPanel(id: string | null): void } }
  // 文案入口只有这一处：locale 服务缺席（老宿主 / 测试假体）时回退 zhTranslate，侧栏 / 面板 /
  // 状态层 / 配置页共用同一个 t。宿主槽位缓存的 inject 结果是这个稳定函数本身，切语言由它在
  // 调用时读当前 locale，故这里不订阅。不声明 slot 的 `locale` 席位：那条路在未安装 locale face
  // 的宿主上会抛，与可选回退冲突（`docs/adr/0038`）；换语言靠 outlet 的 locale revision 重渲。
  const t = createTranslate(ctx as unknown as CopyHostLike)
  // 全局面板双注册（同 id/key「novel」，必须同批——官方契约：选中缺失的 main entry 会抛）
  ctx.effect(() => slots.inject('sidebar.panellist', () => slots.register(
    { name: 'sidebar.panellist', id: NOVEL_PANEL_ID, order: 20, label: () => t('nav.panel') },
    NovelPanelIcon,
  )), 'dsh-novel: sidebar panel icon')
  ctx.effect(() => slots.inject('main', () => slots.register(
    { name: 'main', key: NOVEL_PANEL_ID, inject: () => ({ t }) },
    NovelPanel,
  )), 'dsh-novel: main panel')
  // 常驻状态层挂 shell.overlay（root 作用域、list 基数、默认 click-through）：与 sidebar/main/
  // rightbar 并列，切面板与切会话都不卸载它——任务读数的唯一常驻住址。
  // pointer-events 由样式层 .novel-shell-status 的条目自己收回（浮层层默认不吃点击）。
  // 占用者包一层只为把宿主口递进去：状态层点「点此查看」要把「小说」面板带到前台（面板树
  // 不挂载时它的内部路由看不见），而 ctx 只在本接线层在场。
  ctx.effect(() => slots.inject('shell.overlay', () => {
    const StatusOverlay = ({ t = zhTranslate }: { t?: Translate }): ReactNode => (
      <CopyProvider value={t}>
        <NovelStatusOverlay focusPanel={() => layout.selectPanel(NOVEL_PANEL_ID)} />
      </CopyProvider>
    )
    return slots.register(
      { name: 'shell.overlay', id: 'novel-status', order: 100, label: () => t('nav.overlay'), inject: () => ({ t }) },
      StatusOverlay,
    )
  }), 'dsh-novel: shell overlay status layer')
  // 可选能力：旧宿主没有 configForms 时回调不执行，侧栏/面板完全不受影响。
  ctx.inject(['configForms'], (child) => registerConfigPage(child, t))
}

export { NovelStatusOverlay, NovelView }
