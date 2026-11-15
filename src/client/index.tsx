import type { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import { ENTRY_ID, registerConfigPage, ttsDefaultsFromSettings } from './config-page.js'
import type { RemoteResult, SettingsDescribeValue } from './config-page.js'
import {
  CopyProvider,
  createTranslate,
  zhTranslate,
  type Translate,
} from './copy/index.js'
import { NOVEL_GLYPH_PATH, NOVEL_GLYPH_VIEWBOX } from './novel-glyph.js'
import { TtsMiniBar } from './tts/TtsMiniBar.js'
import { setTtsDefaults, watchDirectVoices } from './tts/player.js'
import { NovelStatusOverlay } from './views/NovelStatusOverlay.js'
import { NovelView } from './views/NovelView.js'

/** 浏览器半的 fiber 名：cordis 用插件对象的 `name` 命名 fiber，槽位诊断里 `entry.registrant`
 *  缺省就取 `fiber.name`——缺了它，这份注册在诊断里认不出是谁的。带 `/client` 后缀是为了与
 *  Node 半的 `name`（包全名）区分开：两半是两个 fiber。 */
export const name = '@xrn1997/dsh-novel/client'

export const inject = ['slots', 'layout']

/**
 * 浏览器半入口：把「小说」注册为**全局面板**——侧栏
 * `sidebar.panellist` 一行图标 + `main` keyed 槽同 id 的中央面板。
 * 宿主契约如下（以发布物为准）：
 *
 * - `sidebar.panellist`（root 作用域 list）：注册项 `{ id, order?, label? }`；宿主 sidebar
 *   shell 自带行按钮、`aria-current` 选中态、折叠 tooltip，点击 = `ctx.layout.selectPanel(id)`；
 *   占用者组件只收 owner props `{ size, active }` 出一个图标，无障碍名归宿主行的 label。
 * - `main`（root 作用域 keyed）：「Central panel selected by sidebar entry id」，注册项
 *   `{ key }`；宿主中央面板按侧栏选中的 id 渲染 main 里同 key 的占用者。保留键 `conversation`
 *   归 Conversation；其余 key 无 Session 绑定（小说本就不吃会话数据）。
 * - **两个座位必须同批注册**：官方契约明写「selecting a missing main entry throws without
 *   changing the current selection」——apply 内同步双注册，不存在半注册窗口。
 *
 * 小说只挂全局面板这一个入口：不注册 `conversation.view`，也不注册 `settings.section`
 * （单一归属）。视图环内的状态不留：业务真相在服务端
 * （后台任务 + 显式快照），交互现场在模块级 store（routeStore / sourceListUi / jobSurface），
 * keyed 槽切走面板即卸载组件树，回来照常恢复。常驻状态层仍住 `shell.overlay`（root 作用域、
 * list 基数、默认 click-through）：任务读数要在**任何面板**都说得出口。
 */

/** 全局面板行的图标：宿主行给 `{ size, active }`（`SidebarPanelIconOwnerProps`），
 *  行本体（按钮、aria-current、tooltip、选中底色）全归宿主 sidebar shell——我们只出图，
 *  `active` 本层不消费（选中态归 shell，契约字段留在类型里即可）。
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

/** 全局面板的 id/key 同一个词（官方契约：选中缺失的 main entry 会抛）——注册与「带到前台」共用一格。
 *  **带插件专属前缀**：宿主对 list id / keyed key 的规则是「复用已有 id = 进那个格子并替换占用者」，
 *  裸 `novel` 是通用词，别家（或将来的官方小说面板）一旦也用，替换是静默的；前缀是本插件在
 *  槽位域的硬边界，与工具名的 `dshnovel_` 前缀同一条纪律。 */
const NOVEL_PANEL_ID = '@xrn1997/dsh-novel.panel'
/** 常驻状态层的条目 id（`shell.overlay` 是 list 槽，规则同上）。 */
const NOVEL_STATUS_ID = '@xrn1997/dsh-novel.status'
/** 全局听书迷你条的条目 id：与状态层同住 `shell.overlay`，只按 order 排在它前面（90 < 100）。 */
const NOVEL_TTS_MINI_ID = '@xrn1997/dsh-novel.tts-mini'

/** `main` keyed 槽的占用者：小说全局面板本体（root 作用域，无 Session 绑定）。
 *  NovelView 自带样式层与 token 锚点（`data-novel-scope`），在 keyed 槽这棵子树里自足。
 *  `t` 缺省走 zhTranslate：宿主槽位没接 inject 时（含测试直渲）保持既有中文断言。 */
function NovelPanel({ t = zhTranslate }: { t?: Translate }): ReactNode {
  return <CopyProvider value={t}><NovelView /></CopyProvider>
}

/** 浏览器半没有 served 配置路由：听书缺省只能经宿主设置面读**有效值**（用户覆盖叠加 schema
 *  缺省），再推进播放层的回退链。这是可选能力——没有设置面 / 读失败 / 条目缺席都保持
 *  `TTS_DEFAULTS`，不阻断面板。宿主设置面没有变更订阅：接入时读这一发是首屏快照；
 *  配置页每次读到有效值（初始 / 保存 / 恢复默认）也把同一份映射推进播放层（见其内 effect），
 *  两处共用 `ttsDefaultsFromSettings`，不各写一份窄镜像。
 *  命名空间键、describe 形状与「哪几格、怎么算读得出」都住 `config-page.tsx`（同一份 `ENTRY_ID`
 *  与 `ttsDefaultsFromSettings`），这里不另写一份窄镜像。 */
function pushTtsDefaults(ctx: Context): void {
  const remote = (ctx as unknown as {
    remote?: { settings?: { describe(): Promise<RemoteResult<SettingsDescribeValue>> } }
  }).remote?.settings
  if (remote === undefined || typeof remote.describe !== 'function') return
  void remote.describe().then((result) => {
    if (!result.ok) return
    const value = result.value.namespaces.find((ns) => ns.ns === ENTRY_ID)?.value
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return
    setTtsDefaults(ttsDefaultsFromSettings(value))
  }).catch(() => undefined)
}

export function apply(ctx: Context): void {
  const slots = (ctx as unknown as {
    slots: {
      inject(name: string, fn: () => () => void): () => void
      register(options: Record<string, unknown>, component: unknown): () => void
    }
  }).slots
  // 宿主 layout 服务窄镜像（ADR-0020：只声明用到的成员、一次强转）：把面板带到前台是宿主的活，
  // 插件不碰 sidebar shell 的行按钮与选中态，只在「去现场」时调它同款的 selectPanel。
  const { layout } = ctx as unknown as { layout: { selectPanel(id: string | null): void } }
  // 文案入口只有这一处：locale 服务缺席（宿主未提供该 face / 测试假体）时回退 zhTranslate，侧栏 / 面板 /
  // 状态层 / 配置页共用同一个 t。宿主槽位缓存的 inject 结果是这个稳定函数本身，切语言由它在
  // 调用时读当前 locale，故这里不订阅。不声明 slot 的 `locale` 席位：那条路在未安装 locale face
  // 的宿主上会抛，与可选回退冲突（`ADR-0038`）；换语言靠 outlet 的 locale revision 重渲。
  const t = createTranslate(ctx)
  // 直出语音表由平台异步给出（Chromium 冷启动首读常为空，真表随 `voiceschanged` 迟到）：插件一挂上
  // 就触发首读并订阅，别等用户点开设置面或按下听书才第一次问——那一问会白等一次平台加载。
  ctx.effect(() => watchDirectVoices(), 'dsh-novel: direct voices')
  // 全局面板双注册（同 id/key `NOVEL_PANEL_ID`，必须同批——官方契约：选中缺失的 main entry 会抛）
  ctx.effect(() => slots.inject('sidebar.panellist', () => slots.register(
    { name: 'sidebar.panellist', id: NOVEL_PANEL_ID, order: 20, label: () => t('nav.panel') },
    NovelPanelIcon,
  )), 'dsh-novel: sidebar panel icon')
  ctx.effect(() => slots.inject('main', () => slots.register(
    { name: 'main', key: NOVEL_PANEL_ID, inject: () => ({ t }) },
    NovelPanel,
  )), 'dsh-novel: main panel')
  // 常驻层两个条目（状态层 + 听书迷你条）住在**同一次** shell.overlay inject 里：
  // - 座位：root 作用域、list 基数、默认 click-through——与 sidebar/main/rightbar 并列，切面板与
  //   切会话都不卸载它们。任务读数与播放控制因此在任何面板都说得出口，order 100 / 90 只决定
  //   列表先后（迷你条排在状态泳道之前）。pointer-events 由样式层的条目自己收回。
  // - 为什么合并：宿主「同一 slot 二次 inject」的语义在本仓无法验证（宿主 UI 包不安装，只有
  //   `tests/client/fake-host.ts` 的窄镜像）。一次 inject 注册两枚条目，在「inject 是插槽订阅、
  //   可重复」与「inject 是一次性占用」两种可能契约下都成立；两枚注册的退订也必须一起还，
  //   否则插件卸载会留下孤儿条目。
  // - 占用者都包一层只为把宿主口递进去：状态层点「点此查看」、迷你条点「回阅读器」都要把
  //   「小说」面板带到前台（面板树不挂载时其内部路由看不见），而 ctx 只在本接线层在场。
  ctx.effect(() => slots.inject('shell.overlay', () => {
    const StatusOverlay = ({ t = zhTranslate }: { t?: Translate }): ReactNode => (
      <CopyProvider value={t}>
        <NovelStatusOverlay focusPanel={() => layout.selectPanel(NOVEL_PANEL_ID)} />
      </CopyProvider>
    )
    const MiniBar = ({ t = zhTranslate }: { t?: Translate }): ReactNode => (
      <CopyProvider value={t}>
        {/* 样式层归状态层（同一 overlay 树已注入一份 NOVEL_CSS）：迷你条不再自注第二份。 */}
        <TtsMiniBar withStyles={false} focusPanel={() => layout.selectPanel(NOVEL_PANEL_ID)} />
      </CopyProvider>
    )
    const disposeStatus = slots.register(
      { name: 'shell.overlay', id: NOVEL_STATUS_ID, order: 100, label: () => t('nav.overlay'), inject: () => ({ t }) },
      StatusOverlay,
    )
    const disposeMini = slots.register(
      { name: 'shell.overlay', id: NOVEL_TTS_MINI_ID, order: 90, label: () => t('tts.overlay.label'), inject: () => ({ t }) },
      MiniBar,
    )
    return () => { disposeStatus(); disposeMini() }
  }), 'dsh-novel: shell overlay layers')
  // 可选能力：宿主没有设置面（remote.settings）时回调不执行，侧栏/面板完全不受影响。
  // 同一回调里顺带读一次听书缺省（播放层回退链的 served 端），读失败静默退让到 wire 缺省。
  ctx.inject(['remote', 'remote.settings'], (child) => {
    registerConfigPage(child, t)
    pushTtsDefaults(child)
  })
}

export { NovelStatusOverlay, NovelView }
