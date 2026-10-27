import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { useCopy } from '../copy/index.js'
import type { CopyKey } from '../copy/index.js'
import { resetPanelShelf } from '../panel-shelf.js'
import { navigate, routeStore, useStore } from '../store.js'
import type { ViewRoute } from '../store.js'
import { NovelStyles } from '../styles.js'
import { CityView } from './CityView.js'
import { ReaderView } from './ReaderView.js'
import { SearchView } from './SearchView.js'
import { SettingsSection } from './SettingsSection.js'
import { ShelfView } from './ShelfView.js'

/** 「小说」view 根：顶部 tab 导航 + 按 routeStore 分发五分支；样式层全局注入一次。
 *  IA：书架 | 书城 | 书源管理 **并列 tab**——选择即切换下方内容；
 *  书源管理 = 宿主设置「小说」区块整体（单一归属：
 *  轮询单实例、现场 store 单份）。书城 = 分类浏览（左栏点名一个源、再点它自己声明的分类，右区是
 *  该源这一类的书单；跨源视野只在书籍详情浮层里手动发起，见 CityView 与 `docs/adr/0028`）。
 *  reader/search 是 tab 之下的沉浸内容流（各有自己的返回导航），顶部 tab 不随行。
 *  布局钉死：根 = flex 列；视图区（flex:1 + overflowY:auto）——不要给视图区写 height:100%，
 *  那会被挤出视口。 */

/** tab 常量：key = ViewRoute['name'] 的 tab 子集；labelKey 指向字典（t 在渲染时取，tab 常量不持文案）；
 *  route 是无参路由对象（点击即 navigate） */
const TABS: Array<{ key: 'shelf' | 'city' | 'sources'; labelKey: CopyKey; route: ViewRoute }> = [
  { key: 'shelf', labelKey: 'nav.tabs.shelf', route: { name: 'shelf' } },
  { key: 'city', labelKey: 'nav.tabs.city', route: { name: 'city' } },
  { key: 'sources', labelKey: 'nav.tabs.sources', route: { name: 'sources' } },
]

export function NovelView(): ReactNode {
  const t = useCopy()
  const { route } = useStore(routeStore)
  // 投影的生命周期就是面板：视图内切 tab 不卸载本根，现场照旧保留；宿主切走面板会卸载
  // 这棵树，投影随卸载丢弃（下次进入重新取）。在途响应由 panel-shelf 的代际守卫丢弃。
  useEffect(() => () => { resetPanelShelf() }, [])
  const tabbed = route.name === 'shelf' || route.name === 'city' || route.name === 'sources'
  return (
    <div data-novel data-novel-root data-novel-scope className="novel-root">
      <NovelStyles />
      {tabbed
        ? (
          <div className="novel-tabs" role="group" aria-label={t('nav.tabs.label')}>
            {TABS.map((tab) => (
              <button
                key={tab.key}
                className={route.name === tab.key ? 'on' : undefined}
                aria-pressed={route.name === tab.key}
                onClick={() => navigate(tab.route)}
              >{t(tab.labelKey)}</button>
            ))}
          </div>
        )
        : null}
      <div data-novel-main className="novel-main">
        {route.name === 'reader'
          ? <ReaderView sourceId={route.sourceId} bookKey={route.bookKey} title={route.title} />
          : route.name === 'search'
            ? <SearchView />
            : route.name === 'city'
              ? <CityView />
              : route.name === 'sources'
                // 样式层本视图根已注入（`<NovelStyles/>` 在上面），这里显式让位——两处各注一份
                // 就是 58KB CSS 在 DOM 里出现两遍（SettingsSection 单飞时仍自带，默认 true）
                ? <SettingsSection withStyles={false} />
                : <ShelfView />}
      </div>
    </div>
  )
}
