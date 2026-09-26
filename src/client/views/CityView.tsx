import type { ReactNode } from 'react'
import { EmptyState } from './bits.js'

/** 书城（未上线占位视图）：IA 上书架/书城/书源管理是并列 tab（2026 变更，用户拍板）。
 *  书城内容尚未实现——tab 结构成型，这里是诚实的占位空态：不假装可点、不留假入口；
 *  内容上线后直接填充本分支，导航结构不用再改。 */
export function CityView(): ReactNode {
  return (
    <div data-novel-view="city" className="novel-view">
      <EmptyState
        title="书城未上线，敬请期待"
        hint="上线后这里会聚合各书源的榜单与分类；现在可以先在书架搜索，或经「书源管理」导入书源 / 本地 TXT 与 EPUB"
      />
    </div>
  )
}
