import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { ROUTES } from '../../shared/wire.js'
import type { ExploreBook, ExploreKinds } from '../../shared/wire.js'
import { cityEmptyKind, cityMeta, cityProgress, failureSummary, sourceCountLabel } from '../city-view-model.js'
import { useExploreJob } from '../explore-job.js'
import type { ExploreRound } from '../explore-job.js'
import { prodCoreDeps } from '../deps.js'
import type { ClientCoreDeps } from '../deps.js'
import { cityStore, useStore } from '../store.js'
import { coverTintClass } from '../util.js'
import { coverFallbackChar, EmptyState } from './bits.js'

/**
 * 书城 = 分类浏览（两级，只此一层深度：分类只住左栏，没有独立的分类墙落地页）。
 *
 * 三条呈现口径：
 * ① **逛的时候源不可见**——书只带「N 源」数量角标，源名只出现在两个地方：选源抽屉（看到书之后）
 *    与失败条（源坏了要如实摊开，那是这条原则的刻意例外）。
 * ② **排序与进度都是被动读数**：服务端只有一个排序键（收录源数）且自己按并发分批抓完，
 *    摆下拉或「继续加载」钮就是假控件，所以左栏/尾行只有说明与读数。
 * ③ **进入即加载**：词表到手就提交首项（或记住的那一项），换类零跳转——重提同一类很便宜，
 *    逐源结果在服务端有缓存（`KindCache`）。
 *
 * 轮次观察与读面的会话内现场各自有主人：轮次归 `useExploreJob`（全量快照），上次看的分类归
 * `cityStore`（不落盘）。本视图只做装配与呈现，文案与判据一律取 `city-view-model`。
 */
export function CityView({ deps = prodCoreDeps }: { deps?: ClientCoreDeps }): ReactNode {
  const { kind: remembered } = useStore(cityStore)
  const { round, error, submit } = useExploreJob(deps)
  /** 词表（`null` = 还在读）：**空词表**是「库里没有源提供分类浏览」，与读面失败不是一件事 */
  const [kinds, setKinds] = useState<ExploreKinds['kinds'] | null>(null)
  const [kindsError, setKindsError] = useState<string | null>(null)
  /** 当前看的分类（左栏高亮 + 标题）。词表到手时定一次，之后只由点击改 */
  const [kind, setKind] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<ExploreBook | null>(null)
  const [imgFailed, setImgFailed] = useState<Record<string, boolean>>({})

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
      submit(title)
    })()
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (title: string): void => {
    setKind(title)
    cityStore.set({ kind: title })
    submit(title)
  }

  const shown = kinds === null ? [] : kinds.filter((k) => k.title.includes(query.trim()))
  const current = kinds === null ? null : kinds.find((k) => k.title === kind) ?? null
  const books = round?.books ?? []
  const failures = round?.failures ?? []
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
              <div className="novel-city-gridwrap">
                <div className="novel-city-grid">
                  {books.map((b) => {
                    const meta = cityMeta(b)
                    return (
                      <button
                        key={`${b.name}|${b.author ?? ''}`}
                        className="novel-city-card"
                        aria-label={`选择书源：${b.name}`}
                        onClick={() => setPicked(b)}
                      >
                        {b.coverUrl !== undefined && imgFailed[b.name] !== true
                          ? <img className="novel-city-cover" src={b.coverUrl} alt="" loading="lazy"
                              onError={() => setImgFailed((m) => ({ ...m, [b.name]: true }))} />
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
                </div>
              </div>
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
                  「一轮里源数是 0」两处都产出空串，用它判空就把两件事折成一件 */}
              {round === null ? null : <div className="novel-city-foot">{roundReadout(round)}</div>}
            </>
          )}
        </section>
        {picked === null ? null : (
          <>
            <div className="novel-city-scrim" onClick={() => setPicked(null)} />
            <aside className="novel-city-drawer" role="dialog" aria-label={`选源：${picked.name}`}>
              <div className="novel-city-drawer-head">
                <strong className="novel-city-drawer-title">{picked.name}</strong>
                <button className="novel-btn sm" onClick={() => setPicked(null)}>关闭</button>
              </div>
              {/* 书单留在原位（抽屉是覆盖层，不卸载、不动滚动位置）；这里是唯一点名源的地方 */}
              <div className="novel-city-srclist">
                {picked.origins.map((o) => (
                  <div key={o.sourceId} className="novel-city-srcrow">
                    <span className="novel-city-srcrow-who">{o.sourceName}</span>
                    {o.lastChapter === undefined ? null : <span className="novel-city-srcrow-last">最新：{o.lastChapter}</span>}
                  </div>
                ))}
              </div>
            </aside>
          </>
        )}
      </div>
    </div>
  )
}

/** 轮次读数（**被动读数**：服务端按并发自跑分批，没有需要用户按一下的东西）。
 *  **停止不是完成**：取消后不许说成一个走到了底的轮次，故「已停止」优先于进度文案。 */
function roundReadout(round: ExploreRound): string {
  if (round.cancelled) return '已停止'
  return round.running && round.total === 0 ? '正在启动分类抓取…' : cityProgress(round.done, round.total)
}
