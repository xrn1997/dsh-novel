import type { ReactNode } from 'react'
import { useCopy } from '../copy/index.js'
import { FONT_STEPS, LINE_HEIGHTS, MEASURES, PAPER_PRESETS } from '../prefs-ui.js'
import { prefsStore, setPref, useStore } from '../store.js'
import { paperInk } from '../util.js'

/** 阅读控制器面板：挂 sticky 工具栏内（定位与滚动锚在工具栏上；z 序由视图按控制器层单表传入），
 *  点遮罩关闭。chip 式控件，布局归样式类 .novel-prefs，行内只留定位与 z；role=dialog + aria-label
 *  （能开能关的浮层，Esc 关，共用 ReaderView 的一条 Esc）。 */
export function PrefsPanel({ zIndex }: { zIndex: number }): ReactNode {
  const t = useCopy()
  const prefs = useStore(prefsStore)
  const step = (delta: number): void => {
    const i = FONT_STEPS.indexOf(prefs.fontSize)
    const at = Math.min(FONT_STEPS.length - 1, Math.max(0, (i === -1 ? 3 : i) + delta))
    // 下标已夹在表内：取不到这一步在构造上不成立，夹取证明就在上一行
    const next = FONT_STEPS.at(at)
    if (next !== undefined) setPref({ fontSize: next })
  }
  return (
    <div
      data-novel-ctrl
      role="dialog"
      aria-label={t('reader.settings')}
      className={prefs.darkController ? 'novel-dark novel-prefs' : 'novel-prefs'}
      style={{ position: 'absolute', right: 12, top: 40, zIndex }}
    >
      <div>
        <div className="novel-prefs-label">{t('reader.fontSizeCurrent', { size: prefs.fontSize })}</div>
        <div className="novel-chips">
          <button className="novel-chip" onClick={() => step(-1)} aria-label={t('reader.fontSizeDown')}>A−</button>
          <button className="novel-chip" onClick={() => step(1)} aria-label={t('reader.fontSizeUp')}>A＋</button>
        </div>
      </div>
      <div>
        <div className="novel-prefs-label">{t('reader.lineHeight')}</div>
        <div className="novel-chips">
          {LINE_HEIGHTS.map((lh) => (
            <button key={lh} className={prefs.lineHeight === lh ? 'novel-chip on' : 'novel-chip'}
              aria-pressed={prefs.lineHeight === lh}
              onClick={() => setPref({ lineHeight: lh })}>{lh}</button>
          ))}
        </div>
      </div>
      <div>
        <div className="novel-prefs-label">{t('reader.measureCurrent', { n: prefs.measure })}</div>
        <div className="novel-chips">
          {MEASURES.map((m) => (
            <button key={m.em} className={prefs.measure === m.em ? 'novel-chip on' : 'novel-chip'}
              aria-pressed={prefs.measure === m.em}
              onClick={() => setPref({ measure: m.em })}>{t(m.labelKey)}</button>
          ))}
        </div>
      </div>
      <div>
        <div className="novel-prefs-label">{t('reader.paper')}</div>
        <div className="novel-chips">
          {PAPER_PRESETS.map((p) => (
            <button key={p.color} title={t(p.nameKey)} aria-label={t(p.nameKey)} aria-pressed={prefs.paperColor === p.color}
              className={prefs.paperColor === p.color ? 'novel-chip novel-paper-swatch on' : 'novel-chip novel-paper-swatch'}
              style={{ background: p.color, color: paperInk(p.color) }}
              onClick={() => setPref({ paperColor: p.color })} />
          ))}
          {/* 正文层的唯一取色入口：行内只有值本身，外观归 .novel-prefs-color
              （原生 color 控件不套标度会在面板里显得突兀） */}
          <input type="color" className="novel-prefs-color" aria-label={t('reader.paperCustom')}
            value={prefs.paperColor} onChange={(e) => setPref({ paperColor: e.target.value })} />
        </div>
      </div>
      <label>
        <input type="checkbox" checked={prefs.darkController} onChange={(e) => setPref({ darkController: e.target.checked })} />
        {t('reader.darkController')}
      </label>
    </div>
  )
}
