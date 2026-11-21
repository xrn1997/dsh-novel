import type { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import { ENTRY_ID, registerConfigPage, ttsDefaultsFromSettings } from './config-page.js'
import type { RemoteResult, SettingsDescribeValue } from './config-settings.js'
import {
  CopyProvider,
  createTranslate,
  zhTranslate,
  type Translate,
} from './copy/index.js'
import { NOVEL_GLYPH_PATH, NOVEL_GLYPH_VIEWBOX } from './novel-glyph.js'
import { TtsMiniBar } from './tts/TtsMiniBar.js'
import { disposeTtsPlayer, setTtsDefaults, watchDirectVoices } from './tts/player.js'
import { NovelStatusOverlay } from './views/NovelStatusOverlay.js'
import { NovelView } from './views/NovelView.js'

/** 浏览器半的 fiber 名：cordis 用插件对象的 name 命名 fiber；带 `/client` 后缀与 Node 半的 name 区分（两半是两个 fiber）。 */
export const name = '@xrn1997/dsh-novel/client'

export const inject = ['slots', 'layout']

/**
 * 浏览器半入口：把「小说」注册为**全局面板**——侧栏 `sidebar.panellist` 一行图标 + `main` keyed
 * 槽同 id 的中央面板。`sidebar.panellist` 注册 `{ id, order?, label? }`，占用者只出图标；
 * `main` 注册 `{ key }`，按侧栏选中的 id 渲染同 key 的占用者（保留键 `conversation` 归 Conversation）。
 * **两个座位必须同批注册**：官方契约明写选中缺失的 main entry 会抛，apply 内同步双注册。
 *
 * 小说只挂全局面板这一个入口（不注册 `conversation.view` / `settings.section`）。业务真相在服务端，
 * 交互现场在模块级 store；keyed 槽切走即卸载，回来照常恢复。常驻状态层住 `shell.overlay`——
 * 任务读数要在**任何面板**都说得出口。
 */

/** 全局面板行的图标：宿主行给 `{ size, active }`，行本体（按钮、aria-current、tooltip）全归宿主
 *  sidebar shell——我们只出图。字形单点见 `novel-glyph.ts`；`fill="currentColor"` 随宿主行前景色。 */
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

/** 全局面板的 id/key 同一个词（选中缺失的 main entry 会抛）。**带插件专属前缀**：宿主对 list id
 *  的规则是「复用已有 id = 替换占用者」，裸 `novel` 会被别家静默替换。 */
const NOVEL_PANEL_ID = '@xrn1997/dsh-novel.panel'
/** 常驻状态层的条目 id（`shell.overlay` 是 list 槽，规则同上）。 */
const NOVEL_STATUS_ID = '@xrn1997/dsh-novel.status'
/** 全局听书迷你条的条目 id：与状态层同住 `shell.overlay`，只按 order 排在它前面（90 < 100）。 */
const NOVEL_TTS_MINI_ID = '@xrn1997/dsh-novel.tts-mini'

/** `main` keyed 槽的占用者：小说全局面板本体；NovelView 自带样式层与 token 锚点，在 keyed 槽里自足。
 *  `t` 缺省走 zhTranslate：宿主槽位没接 inject 时保持既有中文断言。 */
function NovelPanel({ t = zhTranslate }: { t?: Translate }): ReactNode {
  return <CopyProvider value={t}><NovelView /></CopyProvider>
}

/** 浏览器半没有 served 配置路由：听书缺省只能经宿主设置面读**有效值**，再推进播放层的回退链。
 *  可选能力——没有设置面 / 读失败 / 条目缺席都保持 `TTS_DEFAULTS`，不阻断面板。宿主设置面没有
 *  变更订阅：接入时这一发是首屏快照；配置页每次读到有效值也把同一份映射推进播放层。 */
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
  // 宿主 layout 服务窄镜像（ADR-0020：只声明用到的成员）：把面板带到前台是宿主的活，
  // 插件不碰 sidebar shell 的行按钮与选中态。
  const { layout } = ctx as unknown as { layout: { selectPanel(id: string | null): void } }
  // 文案入口只有这一处：locale 服务缺席时回退 zhTranslate，侧栏 / 面板 / 状态层 / 配置页共用同一个 t。
  // 宿主槽位缓存的是这个稳定函数本身，切语言由它调用时读当前 locale（`ADR-0038`）。
  const t = createTranslate(ctx)
  // 直出语音表由平台异步给出：插件一挂上就触发首读并订阅，别等用户点开设置面才第一次问。
  ctx.effect(() => watchDirectVoices(), 'dsh-novel: direct voices')
  // 播放层随插件收口（热替换 / 停用 / 升级）：宿主拆 fiber 时会跑完 ctx.effect 清理，而模块图重建后
  // 旧模块里的单例与正在放的 Audio 不会自己消失——不收口就是没有控制面的幽灵朗读。
  // 视图卸载不走这里：常驻播放层跨面板卸载存活（`ADR-0072`）。
  ctx.effect(() => () => { disposeTtsPlayer() }, 'dsh-novel: tts playback')
  // 全局面板双注册（同 id/key `NOVEL_PANEL_ID`，必须同批——官方契约：选中缺失的 main entry 会抛）
  ctx.effect(() => slots.inject('sidebar.panellist', () => slots.register(
    { name: 'sidebar.panellist', id: NOVEL_PANEL_ID, order: 20, label: () => t('nav.panel') },
    NovelPanelIcon,
  )), 'dsh-novel: sidebar panel icon')
  ctx.effect(() => slots.inject('main', () => slots.register(
    { name: 'main', key: NOVEL_PANEL_ID, inject: () => ({ t }) },
    NovelPanel,
  )), 'dsh-novel: main panel')
  // 常驻层两个条目（状态层 + 听书迷你条）住在**同一次** shell.overlay inject 里：root 作用域、
  // list 基数、默认 click-through，切面板与切会话都不卸载；order 100/90 只决定列表先后。
  // 合并的理由：宿主「同一 slot 二次 inject」的语义无法在本仓验证，一次 inject 注册两枚在两种可能
  // 契约下都成立；两枚注册的退订也必须一起还。占用者都包一层只为把 ctx 递进去（把面板带到前台）。
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
  // 可选能力：宿主没有设置面时回调不执行；同一回调顺带读一次听书缺省，读失败静默退到 wire 缺省。
  ctx.inject(['remote', 'remote.settings'], (child) => {
    registerConfigPage(child, t)
    pushTtsDefaults(child)
  })
}

export { NovelStatusOverlay, NovelView }
