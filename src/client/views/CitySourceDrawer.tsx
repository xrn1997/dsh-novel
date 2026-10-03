import type { ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import type { ExploreBook } from '../../shared/wire.js'
import { cityMeta } from '../city-view-model.js'
import { navigate } from '../store.js'

/**
 * 选源抽屉：**浏览面上唯一点名源的地方**（卡片只有「N 源」角标）——「逛的时候源不可见，
 * 看到书的时候源才出现」这条原则的落点，也是「把这本书读起来」的唯一入口。
 *
 * 三条口径：
 * ① `bookUrl` 为 null 的源**照样列出、但不给按钮**：那一行是「这个源收录了它」的交代，
 *    给一个点了没反应的钮，等于把「这个源读不了」伪装成「能读」。没地址就没有入口。
 * ② 抽屉是**覆盖层**：书单留在原位（不卸载、不动滚动位置）。它自己滚动（`.novel-city-drawer`）。
 * ③ a11y 三件套齐：`aria-modal`、遮罩与 Esc 两条退出路、入场焦点进抽屉。焦点口径沿用
 *    `ImportModal` 那条（入场焦点落关闭钮）——同一仓里长两套焦点语言，会让「打开浮层后键盘在
 *    哪儿」变成要分情况背的东西。Esc 挂 `document`（焦点可能在抽屉内任意处），effect 空依赖 +
 *    onClose 走 ref：抽屉活着的期间父层随时会重渲染（轮次推送），闭包进依赖会把监听搬来搬去。
 */
export function CitySourceDrawer({ book, onClose }: { book: ExploreBook; onClose: () => void }): ReactNode {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onCloseRef.current() }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      // 焦点归还给打开抽屉的那个控件（书单还在场，那张卡没被卸载）。这是 nice-to-have，
      // 所以只在原元素仍挂在文档里时才还——别把焦点扔给一个已经不在文档里的节点。
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  const meta = cityMeta(book)
  return (
    <>
      <div className="novel-city-scrim" aria-hidden="true" onClick={onClose} />
      <div className="novel-city-drawer" role="dialog" aria-modal="true" aria-label={`选源：${book.name}`}>
        <div className="novel-city-drawer-head">
          <strong className="novel-city-drawer-title">{book.name}</strong>
          <button ref={closeRef} className="novel-btn sm" onClick={onClose}>关闭</button>
        </div>
        <div className="novel-city-bookhead">
          {/* 元信息与卡片同源（`cityMeta`）：同一本书在两个地方写法不一致就是两份抄本 */}
          {meta === '' ? null : <div className="novel-city-bookhead-meta">{meta}</div>}
          <div className="novel-city-tags">
            <span className="novel-city-tag">{book.sourceCount} 个源收录</span>
            {book.lastChapter === undefined ? null : <span className="novel-city-tag">最新 {book.lastChapter}</span>}
          </div>
        </div>
        {/* 各源一律同款按钮：**没有排序**，就没有「推荐这一源」——把第一条刷成主色等于替用户排序 */}
        <div className="novel-city-srclist">
          {book.origins.map((o) => (
            <div key={o.sourceId} className="novel-city-srcrow">
              <span className="novel-city-srcrow-who">{o.sourceName}</span>
              {o.lastChapter === undefined ? null : <span className="novel-city-srcrow-last">最新：{o.lastChapter}</span>}
              {o.bookUrl === null ? null : (
                <button
                  className="novel-btn sm primary novel-city-srcrow-go"
                  onClick={() => navigate({ name: 'reader', sourceId: o.sourceId, bookKey: o.bookUrl ?? '', title: book.name })}
                >
                  读这本
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
