import type { ReactNode } from 'react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { ROUTES } from '../../shared/wire.js'
import type { ExploreBook, ExploreSources } from '../../shared/wire.js'
import { describeError } from '../api.js'
import { decideCityEntry, resolveCitySelection } from '../city-entry.js'
import { rememberedCitySelection, useCitySelection } from '../city-selection.js'
import { bookListEmpty, cityEmptyState, cityMeta, kindCountLabel, roundReadout } from '../city-view-model.js'
import { plural, useCopy } from '../copy/index.js'
import { useExploreJob } from '../explore-job.js'
import { prodJobViewDeps } from '../deps.js'
import type { JobViewDeps } from '../deps.js'
import { coverTintClass, topAlignIfClipped } from '../util.js'
import { coverFallbackChar, EmptyState } from './bits.js'
import { CityBookSheet } from './CityBookSheet.js'

/** 在途骨架的**张数上界**：首屏第一眼不该空白，也不能无界地铺。这是上界、不是「列数 × 排数」
 *  的镜像——列数住在 `styles/city.ts` 的网格里。 */
const SKELETON_CARDS = 8

/** 行身份：React key 与封面失败表的键**必须是同一个算式**。地址优先（服务端按地址去重）；
 *  没地址的条目退到「名字对 + 行序」，一轮内累积只增不减，行序对已在场的行是稳定的。 */
const rowKey = (b: ExploreBook, i: number): string =>
  b.bookUrl !== null ? JSON.stringify([b.bookUrl]) : `${JSON.stringify([b.name, b.author ?? ''])}#${String(i)}`

/** 头行副标题：`源名 · 分组`（分组缺席就不出现）。源已在左栏点名，这里只复述。 */
const sourceSub = (s: ExploreSources['sources'][number]): string =>
  [s.name, s.groups[0] ?? ''].filter((x) => x !== '').join(' · ')

/**
 * 书城 = 分类浏览（左栏一条**源列表**，只有选中的源就地展开自己的分类；只此一层深度）。
 *
 * 呈现口径：① **源在左栏第一层就点完名**——卡片不带跨源角标，分类按书源声明的原样顺序列出；
 * ② **分类长在所属源下面**，不另起一列；展开的源在列表尾部时把那一行抬到框顶（`topAlignIfClipped`）；
 * ③ **续页只认 `hasMore` 与本地按下那一段**（定义在 `explore-job.ts` 的 `ExploreRound`）；
 * ④ **进入即加载，但只在该源+该分类没有轮次时**（判据在 `city-entry.ts` 的 `decideCityEntry`）。
 *
 * 轮次归 `useExploreJob`，上次逛的源/分类归 `cityStore`；本视图只装配与呈现。
 */
export function CityView({ deps = prodJobViewDeps }: { deps?: JobViewDeps }): ReactNode {
  const t = useCopy()
  const { round, error, submit, restored, loadMore } = useExploreJob(deps, t)
  /** 可选源清单（`null` = 还在读）：**空清单**是「库里没有源提供分类浏览」，与读面失败不是一件事 */
  const [sources, setSources] = useState<ExploreSources['sources'] | null>(null)
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  /** 当前源与当前分类：唯一写口是 `useCitySelection` 的 select（只写 `cityStore`）；本视图读的是 store 投影。 */
  const { selection, select, isAsked } = useCitySelection()
  const sourceId = selection?.sourceId ?? null
  const kind = selection?.kind ?? null
  const [sourceQuery, setSourceQuery] = useState('')
  const [kindQuery, setKindQuery] = useState('')
  const [picked, setPicked] = useState<ExploreBook | null>(null)
  const [imgFailed, setImgFailed] = useState<Record<string, boolean>>({})
  /** 落位的三件锚：整栏（本视图唯一的滚动容器）、展开的那一行、它下面刚长出来的那一串 */
  const railRef = useRef<HTMLElement | null>(null)
  const headRef = useRef<HTMLButtonElement | null>(null)
  const kidsRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void (async () => {
      let list: ExploreSources['sources']
      try {
        const body = await deps.apiGet<ExploreSources>(ROUTES.exploreKinds.path)
        // 过线形状不靠类型声明作保：缺清单按「读不到」处置，与下面 catch 同一口径——落成空列表等于多摆个假空态。
        const raw: unknown = body.sources
        if (!Array.isArray(raw)) {
          setSourcesError(t('city.kindsReadFailed', { detail: t('city.kindsMalformed') }))
          return
        }
        list = body.sources
      } catch (e) {
        // 读不到源清单 ≠ 没有源可用：只报错，不落空列表（落空列表会多摆一个「还没有源提供分类」的假空态）
        setSourcesError(t('city.kindsReadFailed', { detail: describeError(e, t) }))
        return
      }
      setSources(list)
      // 记住的源失效即回落到可选清单第一项，同时把选中态改写到真实存在的源；分类同理。
      // 算式归 `city-entry.ts` 的 `resolveCitySelection`。
      const chosen = resolveCitySelection(list, rememberedCitySelection())
      if (chosen === null) return                          // 没有可落的源+分类：不提交任何一轮
      select(chosen)                                       // 自动选中也记住（与手点同一条路）
    })()
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 进入即加载：**只在该源+该分类没有轮次时提交**。轮次住在服务端，重提会把它杀掉、书单空闪一帧。
   * 回落与 one-shot 收在 `city-entry.ts` 的 `decideCityEntry`；`action` 只决定要不要提交。
   */
  useEffect(() => {
    const decision = decideCityEntry({
      sources,
      remembered: rememberedCitySelection(),
      restored,
      asked: isAsked(),
      round: round === null ? null : { sourceId: round.sourceId, kind: round.kind },
    })
    if (decision.type !== 'select') return
    select({ sourceId: decision.sourceId, kind: decision.kind }, { asked: true })
    if (decision.action === 'submit') submit(decision.sourceId, decision.kind)
  }, [sources, restored, round, submit, select, isAsked])

  // 换轮即清空封面失败表：封面坏掉是**这一轮这张卡**的事实，上一轮的同名条目不该继承。
  useEffect(() => { setImgFailed({}) }, [round?.id])

  /** 与手点同一条路：记住源+分类、写现场、立刻提交（不等恢复读，切源/切类必须马上有反应）。 */
  const pick = (nextSourceId: string, nextKind: string): void => {
    select({ sourceId: nextSourceId, kind: nextKind }, { asked: true })
    submit(nextSourceId, nextKind)
  }

  /** 换源：分类栏跟着换成新源声明的那几条；当前分类若新源也声明了就沿用，否则落新源的第一个分类。 */
  const pickSource = (s: ExploreSources['sources'][number]): void => {
    const chosen = resolveCitySelection([s], { sourceId: s.id, kind })
    if (chosen !== null) pick(chosen.sourceId, chosen.kind)
  }

  const shownSources = sources === null ? [] : sources.filter((s) => s.name.includes(sourceQuery.trim()))
  const currentSource = sources === null ? null : sources.find((s) => s.id === sourceId) ?? null
  const shownKinds = currentSource === null ? [] : currentSource.kinds.filter((k) => k.includes(kindQuery.trim()))
  /** 分类头只在**当前源在场且声明了这个分类**时出现——只认分类会在没有可逛内容的上方悬一个假头。 */
  const headKind = currentSource !== null && kind !== null && currentSource.kinds.includes(kind) ? kind : null
  /** 换源后把展开的那一行抬到框顶——只在装不下时才动（见 `topAlignIfClipped`）；跟 `shownSources.length`。 */
  useEffect(() => {
    if (railRef.current !== null && headRef.current !== null) {
      topAlignIfClipped(railRef.current, headRef.current, kidsRef.current)
    }
  }, [sourceId, shownSources.length])
  const books = round?.books ?? []
  const empty = round === null ? null : bookListEmpty(round, error, t)
  return (
    <div data-novel-view="city" className="novel-view">
      <div className="novel-city">
        <aside className="novel-city-rail" aria-label={t('city.rail')} ref={railRef}>
          <input
            className="novel-input novel-city-filter"
            value={sourceQuery}
            onChange={(e) => setSourceQuery(e.target.value)}
            placeholder={t('city.sourceSearch')}
            aria-label={t('city.sourceSearch')}
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
                  {s.status === 'broken' ? <span className="novel-city-source-broken">{t('city.sourceBroken')}</span> : null}
                  <span className="novel-city-source-n">{kindCountLabel(s.kinds.length, t)}</span>
                </button>
                {/* 分类只长在**选中的那个源**下面：归属由嵌套说，不再另起一列、也不再写一遍源名 */}
                {on ? (
                  <div className="novel-city-kids" ref={kidsRef}>
                    <input
                      className="novel-input novel-city-filter novel-city-kfilter"
                      value={kindQuery}
                      onChange={(e) => setKindQuery(e.target.value)}
                      placeholder={t('city.kindFilter')}
                      aria-label={t('city.kindFilter')}
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
          {headKind === null ? null : (
            <header className="novel-city-head">
              <h2>{headKind}</h2>
              {currentSource === null ? null : <span className="novel-city-sub">{sourceSub(currentSource)}</span>}
            </header>
          )}
          {headKind === null ? null : <div className="novel-city-note">{t('city.orderNote')}</div>}
          {sourcesError === null ? null : <div className="novel-err novel-note-sm">{sourcesError}</div>}
          {/* 抓失败说在这一条横幅上：已到的书单留在原位、尾行只报跑到哪儿。
              被停止的那一轮到不了这里——`useExploreJob` 已把「任务已取消」那句咽掉，停止不是失败。 */}
          {error === null ? null : <div className="novel-err novel-note-sm">{error}</div>}
          {sources !== null && cityEmptyState(sources.length) === 'no-sources' ? (
            <EmptyState title={t('city.noSources')} hint={t('city.noSources.hint')} />
          ) : (
            <>
              {empty === null
                ? (
                  <div className="novel-city-gridwrap">
                    <div className="novel-city-grid">
                      {books.map((b, i) => {
                        const meta = cityMeta(b)
                        const key = rowKey(b, i)
                        return (
                          <button
                            key={key}
                            className="novel-city-card"
                            aria-label={t('city.card.open', { title: b.name })}
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
                              {b.lastChapter === null ? null : <span className="novel-city-card-last">{t('city.latest', { chapter: b.lastChapter })}</span>}
                            </span>
                          </button>
                        )
                      })}
                      {/* 在途骨架卡：**只在本轮还在跑时**铺（轮次一终态就撤）。 */}
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
              {/* 尾行按**有没有轮次**渲染；`disabled` 只认**本地按下之后**那一段——服务端在途时
                  `hasMore` 本已是 false。 */}
              {round === null ? null : (
                <div className="novel-city-foot">
                  <span>{roundReadout(round, t)}</span>
                  {round.hasMore ? (
                    <button className="novel-btn sm" disabled={round.running} onClick={loadMore}>
                      {plural(t, round.page, 'city.loadMore.one', 'city.loadMore.other', { n: round.page })}
                    </button>
                  ) : null}
                </div>
              )}
            </>
          )}
        </section>
        {/* 浮层的源身份来自**带来这本书的那一轮**，不是左栏此刻的选中态。 */}
        {picked === null || round === null ? null : (
          <CityBookSheet
            book={picked} sourceId={round.sourceId} sourceName={round.sourceName}
            deps={deps} onClose={() => setPicked(null)} />
        )}
      </div>
    </div>
  )
}
