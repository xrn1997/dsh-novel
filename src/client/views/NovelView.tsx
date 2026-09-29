import type { ReactNode } from 'react'
import { navigate, routeStore, useStore } from '../store.js'
import type { Route } from '../store.js'
import { NovelStyles } from '../styles.js'
import { CityView } from './CityView.js'
import { ReaderView } from './ReaderView.js'
import { SearchView } from './SearchView.js'
import { SettingsSection } from './SettingsSection.js'
import { ShelfView } from './ShelfView.js'

/** 「小说」view 根：顶部 tab 导航 + 按 routeStore 分发五分支；样式层全局注入一次。
 *  IA（2026 变更，用户拍板）：书架 | 书城 | 书源管理 **并列 tab**——选择即切换下方内容；
 *  书源管理 = 原宿主设置「小说」区块整体（slots 的 settings.section 注册已撤，单一归属：
 *  轮询单实例、现场 store 单份）。书城未上线 → CityView 占位空态，内容上线后填充该分支。
 *  reader/search 是 tab 之下的沉浸内容流（各有自己的返回导航），顶部 tab 不随行。
 *  布局钉死：根 = flex 列；视图区（flex:1 + overflowY:auto）——视图区曾写 height:100% 而被挤出视口。 */

/** tab 常量：key = Route['name'] 的 tab 子集；route 是无参路由对象（点击即 navigate） */
const TABS: Array<{ key: 'shelf' | 'city' | 'sources'; label: string; route: Route }> = [
  { key: 'shelf', label: '书架', route: { name: 'shelf' } },
  { key: 'city', label: '书城', route: { name: 'city' } },
  { key: 'sources', label: '书源管理', route: { name: 'sources' } },
]

export function NovelView(): ReactNode {
  const { route } = useStore(routeStore)
  const tabbed = route.name === 'shelf' || route.name === 'city' || route.name === 'sources'
  return (
    <div data-novel data-novel-root data-novel-scope className="novel-root">
      <NovelStyles />
      {tabbed
        ? (
          <div className="novel-tabs" role="group" aria-label="小说视图导航">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={route.name === t.key ? 'on' : undefined}
                aria-pressed={route.name === t.key}
                onClick={() => navigate(t.route)}
              >{t.label}</button>
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
