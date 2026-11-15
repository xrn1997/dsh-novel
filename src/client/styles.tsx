import type { ReactNode } from 'react'
import { TOKENS_CSS } from './styles/tokens.js'
import { SHELL_CSS } from './styles/shell.js'
import { CONTROLS_CSS } from './styles/controls.js'
import { SOURCES_CSS } from './styles/sources.js'
import { SEARCH_CSS } from './styles/search.js'
import { READER_CSS } from './styles/reader.js'
import { SHELF_CSS } from './styles/shelf.js'
import { OVERLAYS_CSS } from './styles/overlays.js'
import { CITY_CSS } from './styles/city.js'
import { CONFIG_PAGE_CSS } from './styles/config-page.js'
import { TTS_CSS } from './styles/tts.js'

/** 视觉 token 与全部样式规则的单一拼装点（`NovelStyles` 注入的那一份串）：分块只影响
 *  维护时的 locality，interface 仍是 `NOVEL_CSS` 一个串。
 *  **次序即原单串的字符次序**——CSS 在同等特异度下由先后定胜负，按视图重排就是行为变化；
 *  块间只许有换行与空行，不许增删规则。 */
export const NOVEL_CSS = [
  TOKENS_CSS, SHELL_CSS, CONTROLS_CSS, SOURCES_CSS, SEARCH_CSS,
  READER_CSS, SHELF_CSS, OVERLAYS_CSS, CITY_CSS, CONFIG_PAGE_CSS, TTS_CSS,
].join('\n')

/** 样式注入组件。`NovelView` 在根上注入一次；`SettingsSection` 单飞渲染时自带（`withStyles`
 *  缺省 true），被 NovelView 挂载时让位——同一棵树里注两遍等于同一份 CSS 进 DOM 两次。
 *  以 <style data-novel-style> 注入；HMR 重载随 bundle 整体替换。
 *  走 dangerouslySetInnerHTML 而不是文本子节点：ReactDOMServer 会把文本子节点里的引号 escape
 *  成 `&#x27;`，而 <style> 是 raw text 元素、浏览器不解码实体——`content: ''` 这类带引号的
 *  声明会在 SSR 产物里整条失效（客户端 React DOM 走 textContent 才碰巧没事）。CSS 是仓内
 *  可信常量（NOVEL_CSS），不含任何外部输入，这里没有注入面。 */
export function NovelStyles(): ReactNode {
  return <style data-novel-style dangerouslySetInnerHTML={{ __html: NOVEL_CSS }} />
}
