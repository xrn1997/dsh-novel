import type { ReactNode } from 'react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { ROUTES } from '../../shared/wire.js'
import type { ExploreBook, ExploreSources } from '../../shared/wire.js'
import { bookListEmpty, cityEmptyState, cityMeta, kindCountLabel, roundReadout } from '../city-view-model.js'
import { useExploreJob } from '../explore-job.js'
import { prodCoreDeps } from '../deps.js'
import type { ClientCoreDeps } from '../deps.js'
import { cityStore } from '../store.js'
import { coverTintClass, topAlignIfClipped } from '../util.js'
import { coverFallbackChar, EmptyState } from './bits.js'
import { CityBookSheet } from './CityBookSheet.js'

/** 在途骨架的**张数上界**。首屏第一眼不该是一片空白（源还在往回送时右侧空着，正是进入书城的
 *  第一眼），但也不能无界地铺——铺满一屏空卡等于把「还在等」画成「有这么多」。
 *  这是一枚上界，不是「列数 × 排数」的镜像：列数住在 `styles.tsx` 的网格里（宽档 4 列、窄档 2 列），
 *  把那个数抄进 JS 就会在退档时撒谎（窄档下这 8 张是四排，仍是同一枚上界，只是不叫「两排」）。 */
const SKELETON_CARDS = 8

/** 行身份：React key 与封面失败表的键**必须是同一个算式**。按书名记会让同名不同作者的两条
 *  互相拖累（一条封面坏了把另一条也降级成首字块）。 */
const rowKey = (b: Pick<ExploreBook, 'name' | 'author'>): string => `${b.name}|${b.author ?? ''}`

/** 头行副标题：`源名 · 分组`（分组缺席就不出现）。浏览轴收成按源后，右区头行报的是「这一屏逛的是
 *  哪个源」——源已在左栏第一层点名，这里只复述，不再摆跨源收录数（那是归并层的残影）。 */
const sourceSub = (s: ExploreSources['sources'][number]): string =>
  [s.name, s.groups[0] ?? ''].filter((x) => x !== '').join(' · ')

/**
 * 书城 = 分类浏览（左栏一条**源列表**，只有选中的那个源就地展开自己的分类；只此一层深度，没有独立的分类墙落地页）。
 *
 * 四条呈现口径：
 * ① **源在左栏第一层就点完名**——卡片不带任何跨源角标（单源下「这本书在几个源上」恒为 1，是个谎）。
 *    分类按**书源声明的原样顺序**列出，不排序、不合并、不带计数（计数在单源下恒等于 1）。
 *    源行只写名字 + 自己声明了几类，**分组不写**（理由见 `kindCountLabel` 头上那条）。
 * ② **分类长在它所属的源下面，不另起一列**：整栏因此没有第二个标题、第二条滚动条，也不用再写一遍
 *    「分类 · 某个源」——嵌套结构本身就是归属。代价是展开的源排在列表尾部时，刚长出来的那一串会掉到
 *    折叠线以下（点了却没看见等于没点），所以换源后要把那一行抬到框顶，见 `topAlignIfClipped`。
 * ③ **续页是本轮唯一需要用户按一下的东西**：显隐只认 `hasMore`、`disabled` 只认本地按下那一段——
 *    两个字段各管什么定义在 `client/explore-job.ts` 的 `ExploreRound` 与 `loadMore` 上，本视图照它渲染。
 * ④ **进入即加载，但只在该源+该分类没有轮次时**：源与分类到手先各定一次，提交与否交给 `restored`
 *    与 `asked` 两道闸之后的判据——服务端持有这一轮就是它的家，回来看它跑完即可（见下面那条 effect）。
 *
 * 轮次观察与读面的会话内现场各自有主人：轮次归 `useExploreJob`（全量快照），上次逛的源与分类归
 * `cityStore`（不落盘）。本视图只做装配与呈现，文案与判据一律取 `city-view-model`。
 */
export function CityView({ deps = prodCoreDeps }: { deps?: ClientCoreDeps }): ReactNode {
  const { round, error, submit, restored, loadMore } = useExploreJob(deps)
  /** 可选源清单（`null` = 还在读）：**空清单**是「库里没有源提供分类浏览」，与读面失败不是一件事 */
  const [sources, setSources] = useState<ExploreSources['sources'] | null>(null)
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  /** 当前源与当前分类（左栏高亮 + 标题）：按源清单到手时各定一次，之后只由点击改 */
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [kind, setKind] = useState<string | null>(null)
  const [sourceQuery, setSourceQuery] = useState('')
  const [kindQuery, setKindQuery] = useState('')
  const [picked, setPicked] = useState<ExploreBook | null>(null)
  const [imgFailed, setImgFailed] = useState<Record<string, boolean>>({})
  /** 「已经为某个源+分类要过一轮了」：自动那条路只走一次，此后一律由点击路径提交 */
  const asked = useRef(false)
  /** 落位的三件锚：整栏（本视图唯一的滚动容器）、展开的那一行、它下面刚长出来的那一串 */
  const railRef = useRef<HTMLElement | null>(null)
  const headRef = useRef<HTMLButtonElement | null>(null)
  const kidsRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void (async () => {
      let list: ExploreSources['sources']
      try {
        list = (await deps.apiGet<ExploreSources>(ROUTES.exploreKinds.path)).sources ?? []
      } catch (e) {
        // 读不到源清单 ≠ 没有源可用：只报错，不落空列表（落空列表会多摆一个「还没有源提供分类」的假空态）
        setSourcesError(`分类入口读取失败：${e instanceof Error ? e.message : String(e)}`)
        return
      }
      setSources(list)
      // 记住的源失效（禁用/删掉）即回落到可选清单的第一项——回落同时把选中态改写到真实存在的源上，
      // 不留一个指向不存在源的选中态；分类同理，记住的不在这一源声明的分类里就落它声明的第一个分类。
      const remembered = list.find((s) => s.id === cityStore.get().sourceId) ?? list[0]
      if (remembered === undefined) return                       // 没有任何源进城：不提交任何一轮
      const rememberedKind = cityStore.get().kind
      const title = remembered.kinds.includes(rememberedKind ?? '') ? rememberedKind! : remembered.kinds[0]
      setSourceId(remembered.id)
      setKind(title)
      cityStore.set({ sourceId: remembered.id, kind: title })    // 自动选中也记住（与手点同一条路）
    })()
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 进入即加载：**只在该源+该分类没有轮次时提交**。轮次住在服务端（`ExploreJob` 的槽），离开再回来
   * 只该看它跑完——重提一次会把它杀掉，书单空闪一帧再从头抓，正是本条要守住的性质。
   * 所以判据是「`round` 没有、或不是这个源/这个分类」，而不是「挂载了就提交」。
   *
   * 两道先后都不能省的闸：① `restored`——挂载恢复读没定之前 `round` 恒为 `null`（那是「还没问过」
   * 而非「服务端说没有」），此刻提交就是上面那个破口；② `asked`——自动这条路只走一次，
   * 用户手点的那条（`pick`）不等恢复读、立刻落地，两者不能互相追加提交。
   */
  useEffect(() => {
    if (asked.current || !restored || sourceId === null || kind === null) return
    asked.current = true
    if (round === null || round.sourceId !== sourceId || round.kind !== kind) submit(sourceId, kind)
  }, [sourceId, kind, restored, round, submit])

  /** 换轮即清空封面失败表：封面坏掉是**这一轮这张卡**的事实（同址换一轮那张图就好了），
   *  上一轮的同名条目不该继承——不清就是「一次坏封面永久降级」。 */
  useEffect(() => { setImgFailed({}) }, [round?.id])

  /** 与手点同一条路：记住源+分类、写现场、立刻提交（不等恢复读，切源/切类必须马上有反应）。 */
  const pick = (nextSourceId: string, nextKind: string): void => {
    asked.current = true
    setSourceId(nextSourceId)
    setKind(nextKind)
    cityStore.set({ sourceId: nextSourceId, kind: nextKind })
    submit(nextSourceId, nextKind)
  }

  /** 换源：分类栏跟着换成新源声明的那几条；当前分类若新源也声明了就沿用，否则落新源的第一个分类。 */
  const pickSource = (s: ExploreSources['sources'][number]): void => {
    pick(s.id, s.kinds.includes(kind ?? '') ? kind! : s.kinds[0])
  }

  const shownSources = sources === null ? [] : sources.filter((s) => s.name.includes(sourceQuery.trim()))
  const currentSource = sources === null ? null : sources.find((s) => s.id === sourceId) ?? null
  const shownKinds = currentSource === null ? [] : currentSource.kinds.filter((k) => k.includes(kindQuery.trim()))
  /** 换源后把展开的那一行抬到框顶——只在展开出来的一串装不下时才动（策略与理由见 `topAlignIfClipped`）。
   *  跟一次 `shownSources.length`：源清单后到时选中才落地，那一刻才是第一次真正展开。 */
  useEffect(() => {
    if (railRef.current !== null && headRef.current !== null) {
      topAlignIfClipped(railRef.current, headRef.current, kidsRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, shownSources.length])
  const books = round?.books ?? []
  const empty = round === null ? null : bookListEmpty(round, error)
  return (
    <div data-novel-view="city" className="novel-view">
      <div className="novel-city">
        <aside className="novel-city-rail" aria-label="源与分类" ref={railRef}>
          <input
            className="novel-input novel-city-filter"
            value={sourceQuery}
            onChange={(e) => setSourceQuery(e.target.value)}
            placeholder="搜索书源"
            aria-label="搜索书源"
          />
          {shownSources.map((s) => {
            const on = s.id === sourceId
            return (
              <Fragment key={s.id}>
                <button
                  ref={on ? headRef : undefined}
                  className={`novel-city-source${on ? ' on' : ''}`}
                  aria-expanded={on}
                  onClick={() => pickSource(s)}
                >
                  <span className="novel-city-source-name">{s.name}</span>
                  {s.status === 'broken' ? <span className="novel-city-source-broken">坏</span> : null}
                  <span className="novel-city-source-n">{kindCountLabel(s.kinds.length)}</span>
                </button>
                {/* 分类只长在**选中的那个源**下面：归属由嵌套说，不再另起一列、也不再写一遍源名 */}
                {on ? (
                  <div className="novel-city-kids" ref={kidsRef}>
                    <input
                      className="novel-input novel-city-filter novel-city-kfilter"
                      value={kindQuery}
                      onChange={(e) => setKindQuery(e.target.value)}
                      placeholder="筛选分类"
                      aria-label="筛选分类"
                    />
                    {shownKinds.map((k) => (
                      <button
                        key={k}
                        className={`novel-city-kind${k === kind ? ' on' : ''}`}
                        aria-pressed={k === kind}
                        onClick={() => { pick(s.id, k) }}
                      >
                        {k}
                      </button>
                    ))}
                  </div>
                ) : null}
              </Fragment>
            )
          })}
        </aside>
        <section className="novel-city-main">
          {kind === null ? null : (
            <header className="novel-city-head">
              <h2>{kind}</h2>
              {currentSource === null ? null : <span className="novel-city-sub">{sourceSub(currentSource)}</span>}
            </header>
          )}
          {kind === null ? null : <div className="novel-city-note">按书源声明的顺序</div>}
          {sourcesError === null ? null : <div className="novel-err novel-note-sm">{sourcesError}</div>}
          {/* 抓失败说在这一条横幅上（`adr/0028` 那张表第二行）：已到的书单留在原位、尾行只报跑到哪儿。
              被停止的那一轮到不了这里——`useExploreJob` 已把「任务已取消」那句咽掉，停止不是失败。 */}
          {error === null ? null : <div className="novel-err novel-note-sm">{error}</div>}
          {sources !== null && cityEmptyState(sources.length) === 'no-sources' ? (
            <EmptyState
              title="还没有书源提供分类浏览"
              hint="发现面来自书源声明的分类入口（原生方言的 ruleFind、legado 的 exploreUrl，脚本形态除外）。导入带它的书源后，左栏会按源列出它们各自声明的分类——搜索与书架不受影响，照常可用。"
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
                            aria-label={`查看这本书：${b.name}`}
                            onClick={() => setPicked(b)}
                          >
                            {b.coverUrl !== null && imgFailed[key] !== true
                              ? <img className="novel-city-cover" src={b.coverUrl} alt="" loading="lazy"
                                  onError={() => setImgFailed((m) => ({ ...m, [key]: true }))} />
                              : <span className={`novel-city-cover ${coverTintClass(b.name)}`}>{coverFallbackChar(b.name)}</span>}
                            <span className="novel-city-card-body">
                              <span className="novel-city-card-title">
                                <span className="novel-city-name">{b.name}</span>
                              </span>
                              {meta === '' ? null : <span className="novel-city-card-meta">{meta}</span>}
                              {b.intro === null ? null : <span className="novel-city-card-intro">{b.intro}</span>}
                              {b.lastChapter === null ? null : <span className="novel-city-card-last">最新：{b.lastChapter}</span>}
                            </span>
                          </button>
                        )
                      })}
                      {/* 在途骨架卡：**只在本轮还在跑时**铺（轮次一终态就撤——活过轮次的骨架就是
                          一句谎），且只补到那枚上界（不足就铺到 8 张，够了就一张不加） */}
                      {round !== null && round.running
                        ? Array.from({ length: Math.max(0, SKELETON_CARDS - books.length) }, (_, i) => (
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
              {/* 尾行按**有没有轮次**渲染，不是按文案空不空：单源的轮次只有页与本数可说，读数交给
                  `roundReadout`（被停止 / 还在跑 / 本数读数，三条各说各的；抓失败那句归上面那条横幅）。按钮只在
                  `hasMore` 时出现（服务端说没了就收掉，不留一个点了没反应的饼）；`disabled` 管的是
                  **本地按下之后**那一段——服务端那一批在途时 `hasMore` 本已是 false，钮不在场 */}
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
        {/* 浮层的源身份来自**带来这本书的那一轮**（不是左栏此刻的选中态）：一本书属于哪个源，
            答案就在产出它的轮次里；浮层的两个动作与跨源那一次都要用它。 */}
        {picked === null || round === null ? null : (
          <CityBookSheet book={picked} sourceId={round.sourceId} sourceName={round.sourceName}
            deps={deps} onClose={() => setPicked(null)} />
        )}
      </div>
    </div>
  )
}
