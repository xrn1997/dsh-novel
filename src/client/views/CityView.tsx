import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ROUTES } from '../../shared/wire.js'
import type { ExploreBook, ExploreKinds } from '../../shared/wire.js'
import { bookListEmpty, cityEmptyKind, cityMeta, failureSummary, roundReadout, sourceCountLabel } from '../city-view-model.js'
import { useExploreJob } from '../explore-job.js'
import { prodCoreDeps } from '../deps.js'
import type { ClientCoreDeps } from '../deps.js'
import { cityStore, useStore } from '../store.js'
import { coverTintClass } from '../util.js'
import { coverFallbackChar, EmptyState } from './bits.js'
import { CitySourceDrawer } from './CitySourceDrawer.js'

/** 在途骨架的行数上限。首屏第一眼不该是一片空白（源还在往回送时右侧空着，正是进入书城的
 *  第一眼），但也不能无界地铺——铺满一屏空卡等于把「还在等」画成「有这么多」。两行（4 列
 *  网格的两排）够占住形状，也够收敛。 */
const SKELETON_ROWS = 2

/** 行身份：React key 与封面失败表的键**必须是同一个算式**。按书名记会让同名不同作者的两条
 *  互相拖累（一条封面坏了把另一条也降级成首字块）。 */
const rowKey = (b: Pick<ExploreBook, 'name' | 'author'>): string => `${b.name}|${b.author ?? ''}`

/**
 * 书城 = 分类浏览（两级，只此一层深度：分类只住左栏，没有独立的分类墙落地页）。
 *
 * 三条呈现口径：
 * ① **逛的时候源不可见**——书只带「N 源」数量角标，源名只出现在两个地方：选源抽屉（看到书之后）
 *    与失败条（源坏了要如实摊开，那是这条原则的刻意例外）。
 * ② **排序是被动读数，续页是本轮唯一需要用户按一下的东西**：排序键服务端只有一个（收录源数），
 *    摆下拉就是假控件，故只留一句说明；「加载更多」不是——服务端**不问就不打下一页**，
 *    故它是真控件。它的**显隐只认 `hasMore`**（服务端说此刻能不能点），**禁用只认本轮自己的
 *    `running`**（在途那一段）：从 `running` 反推「还有更多」就会在刚提交、一页都还没回来时
 *    先把按钮亮给用户。
 * ③ **进入即加载，但只在该分类没有轮次时**：词表到手先定分类，提交与否交给 `restored` 之后的
 *    判据——服务端持有这一轮就是它的家，回来看它跑完即可（见下面那条 effect）。
 *
 * 轮次观察与读面的会话内现场各自有主人：轮次归 `useExploreJob`（全量快照），上次看的分类归
 * `cityStore`（不落盘）。本视图只做装配与呈现，文案与判据一律取 `city-view-model`。
 */
export function CityView({ deps = prodCoreDeps }: { deps?: ClientCoreDeps }): ReactNode {
  const { kind: remembered } = useStore(cityStore)
  const { round, error, submit, restored, loadMore } = useExploreJob(deps)
  /** 词表（`null` = 还在读）：**空词表**是「库里没有源提供分类浏览」，与读面失败不是一件事 */
  const [kinds, setKinds] = useState<ExploreKinds['kinds'] | null>(null)
  const [kindsError, setKindsError] = useState<string | null>(null)
  /** 当前看的分类（左栏高亮 + 标题）。词表到手时定一次，之后只由点击改 */
  const [kind, setKind] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<ExploreBook | null>(null)
  const [imgFailed, setImgFailed] = useState<Record<string, boolean>>({})
  /** 「已经为某个分类要过一轮了」：自动那条路只走一次，此后一律由 `pick` 提交 */
  const asked = useRef(false)

  useEffect(() => {
    void (async () => {
      let list: ExploreKinds['kinds']
      try {
        list = (await deps.apiGet<ExploreKinds>(ROUTES.exploreKinds.path)).kinds ?? []
      } catch (e) {
        // 读不到词表 ≠ 没有分类可用：只报错，不落空列表（落空列表会多摆一个「还没有源提供分类」的假空态）
        setKindsError(`分类词表读取失败：${e instanceof Error ? e.message : String(e)}`)
        return
      }
      setKinds(list)
      if (cityEmptyKind(list.length) === 'no-kinds') return      // 没有源提供分类：不提交任何一轮
      const title = remembered !== null && list.some((k) => k.title === remembered) ? remembered : list[0].title
      setKind(title)
      cityStore.set({ kind: title })                             // 自动选中的那一项也记住（与手点同一条路）
    })()
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 进入即加载：**只在该分类没有轮次时提交**。轮次住在服务端（`ExploreJob` 的槽），离开再回来
   * 只该看它跑完——重提一次会把它杀掉，书单空闪一帧再从头抓，正是本条要守住的性质。
   * 所以判据是「`round` 没有或不是这个分类」，而不是「挂载了就提交」。
   *
   * 两道先后都不能省的闸：① `restored`——挂载恢复读没定之前 `round` 恒为 `null`（那是「还没问过」
   * 而非「服务端说没有」），此刻提交就是上面那个破口；② `asked`——自动这条路只走一次，
   * 用户手点的那条（`pick`）不等恢复读、立刻落地，两者不能互相追加提交。
   */
  useEffect(() => {
    if (asked.current || !restored || kind === null) return
    asked.current = true
    if (round === null || round.kind !== kind) submit(kind)
  }, [kind, restored, round, submit])

  /** 换轮即清空封面失败表：封面坏掉是**这一轮这张卡**的事实（同址换一轮那张图就好了），
   *  上一轮的同名条目不该继承——不清就是「一次坏封面永久降级」。 */
  useEffect(() => { setImgFailed({}) }, [round?.id])

  const pick = (title: string): void => {
    asked.current = true
    setKind(title)
    cityStore.set({ kind: title })
    submit(title)                                              // 手点必须立刻有反应：不等恢复读
  }

  const shown = kinds === null ? [] : kinds.filter((k) => k.title.includes(query.trim()))
  const current = kinds === null ? null : kinds.find((k) => k.title === kind) ?? null
  const books = round?.books ?? []
  const failures = round?.failures ?? []
  const empty = round === null ? null : bookListEmpty(round, failures.length, error)
  return (
    <div data-novel-view="city" className="novel-view">
      <div className="novel-city">
        <aside className="novel-city-rail" aria-label="分类词表">
          <input
            className="novel-input novel-city-filter"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="筛选分类"
            aria-label="筛选分类"
          />
          <div className="novel-city-rail-head">
            {kinds === null ? '正在读取分类…' : `全部分类 · ${kinds.length}`}
          </div>
          {shown.map((k) => (
            <button
              key={k.title}
              className={`novel-city-kind${k.title === kind ? ' on' : ''}`}
              aria-pressed={k.title === kind}
              onClick={() => pick(k.title)}
            >
              {k.title}<span className="novel-city-kind-n">{k.sources} 源</span>
            </button>
          ))}
        </aside>
        <section className="novel-city-main">
          {kind === null ? null : (
            <header className="novel-city-head">
              <h2>{kind}</h2>
              {/* 静态读数：这一类的收录源数来自词表（已经跑过的那一轮进度在尾行） */}
              {current === null ? null : <span className="novel-city-sub">{current.sources} 个源收录</span>}
            </header>
          )}
          {kind === null ? null : <div className="novel-city-note">按收录源数排序</div>}
          {kindsError === null ? null : <div className="novel-err novel-note-sm">{kindsError}</div>}
          {error === null ? null : <div className="novel-err novel-note-sm">{error}</div>}
          {kinds !== null && cityEmptyKind(kinds.length) === 'no-kinds' ? (
            <EmptyState
              title="还没有书源提供分类浏览"
              hint="发现面来自书源的 ruleFind（原生格式）。导入带它的书源后，这里会按分类聚合各源的书单——搜索与书架不受影响，照常可用。"
            />
          ) : (
            <>
              {empty === null
                ? (
                  <div className="novel-city-gridwrap">
                    <div className="novel-city-grid">
                      {books.map((b) => {
                        const meta = cityMeta(b)
                        const key = rowKey(b)
                        return (
                          <button
                            key={key}
                            className="novel-city-card"
                            aria-label={`选择书源：${b.name}`}
                            onClick={() => setPicked(b)}
                          >
                            {b.coverUrl !== undefined && imgFailed[key] !== true
                              ? <img className="novel-city-cover" src={b.coverUrl} alt="" loading="lazy"
                                  onError={() => setImgFailed((m) => ({ ...m, [key]: true }))} />
                              : <span className={`novel-city-cover ${coverTintClass(b.name)}`}>{coverFallbackChar(b.name)}</span>}
                            <span className="novel-city-card-body">
                              <span className="novel-city-card-title">
                                <span className="novel-city-name">{b.name}</span>
                                <span className="novel-city-src">{sourceCountLabel(b.sourceCount)}</span>
                              </span>
                              {meta === '' ? null : <span className="novel-city-card-meta">{meta}</span>}
                              {b.intro === undefined ? null : <span className="novel-city-card-intro">{b.intro}</span>}
                              {b.lastChapter === undefined ? null : <span className="novel-city-card-last">最新：{b.lastChapter}</span>}
                            </span>
                          </button>
                        )
                      })}
                      {/* 在途骨架卡：**只在本轮还在跑时**铺（轮次一终态就撤——活过轮次的骨架就是
                          一句谎），且只补到网格的形状（不足两行就铺到两行，够了就一张不加） */}
                      {round !== null && round.running
                        ? Array.from({ length: Math.max(0, SKELETON_ROWS * 4 - books.length) }, (_, i) => (
                          <div key={`sk-${i}`} className="novel-city-card novel-city-sk" aria-hidden="true">
                            <div className="novel-sk novel-city-cover" />
                            <span className="novel-city-card-body">
                              <span className="novel-sk novel-sk-line" />
                              <span className="novel-sk novel-sk-line sm" />
                            </span>
                          </div>
                        ))
                        : null}
                    </div>
                  </div>
                )
                : <EmptyState title={empty.title} hint={empty.hint} />}
              {failures.length === 0 ? null : (
                <details className="novel-city-fail">
                  {/* 坏源名 + 错误码就摆在这一行：这一条是「逛时源不可见」的刻意例外，
                      藏进展开里等于把「哪个源坏了」这条唯一的交代再收回去 */}
                  <summary>
                    <b>{failureSummary(failures)}</b>
                    <span className="novel-city-fail-who">
                      {failures.map((f) => `${f.sourceName}·${f.code}`).join(' ｜ ')}
                    </span>
                    <span className="novel-city-fail-more">展开</span>
                  </summary>
                  <div className="novel-city-fail-msgs">
                    {failures.map((f) => <div key={f.sourceId} className="novel-muted novel-note-sm">{f.message}</div>)}
                  </div>
                </details>
              )}
              {/* 尾行按**有没有轮次**渲染，不是按文案空不空：`cityProgress` 在「还没有一轮」与
                  「一轮里源数是 0」两处都产出空串，用它判空就把两件事折成一件。按钮只在
                  `hasMore` 时出现（服务端说没了就收掉，不留一个点了没反应的饼），在途时禁用 */}
              {round === null ? null : (
                <div className="novel-city-foot">
                  <span>{roundReadout(round)}</span>
                  {round.hasMore ? (
                    <button className="novel-btn sm" disabled={round.running} onClick={loadMore}>
                      {`加载更多（已 ${round.page} 页）`}
                    </button>
                  ) : null}
                </div>
              )}
            </>
          )}
        </section>
        {picked === null ? null : <CitySourceDrawer book={picked} onClose={() => setPicked(null)} />}
      </div>
    </div>
  )
}

