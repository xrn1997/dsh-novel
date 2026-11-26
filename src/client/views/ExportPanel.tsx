import type { CSSProperties, ReactNode } from 'react'
import { plural, useCopy } from '../copy/index.js'
import type { ExportDraft, ExportPreset, RangeParse } from '../export-run.js'

const PRESETS: ReadonlyArray<{ kind: ExportPreset; labelKey: 'reader.export.all' | 'reader.export.rest' | 'reader.export.current' }> = [
  { kind: 'all', labelKey: 'reader.export.all' },
  { kind: 'rest', labelKey: 'reader.export.rest' },
  { kind: 'current', labelKey: 'reader.export.current' },
]

/**
 * 导出范围面板（⤓ 钮的第一步）：起止章输入 + 三档预设 + 确认/取消。
 * 校验与范围推导归 export-run 的 validRangeOf / applyPreset / matchPreset，本面板只负责呈现。
 */
export function ExportPanel(props: {
  draft: ExportDraft
  activePreset: ExportPreset | null
  valid: RangeParse
  total: number
  running: boolean
  kb: number
  totalChapters: string
  onFrom: (v: string) => void
  onTo: (v: string) => void
  onPreset: (kind: ExportPreset) => void
  onConfirm: () => void
  onClose: () => void
  onCancel: () => void
  darkController: boolean
  zIndex: number
}): ReactNode {
  const t = useCopy()
  const valid = props.valid
  const activePreset = props.activePreset
  const presetIdx = activePreset === null ? -1 : PRESETS.findIndex((p) => p.kind === activePreset)

  return (
    <div
      data-novel-ctrl
      role="dialog"
      aria-label={t('reader.export.range')}
      className={props.darkController ? 'novel-dark novel-prefs' : 'novel-prefs'}
      style={{ position: 'absolute', right: 12, top: 52, zIndex: props.zIndex }}
    >
      <div className="novel-panel-head">
        <span className="novel-panel-head-title">
          {t('reader.export.range')}
          <span className="novel-panel-head-sub">
            {plural(t, props.total, 'reader.export.chapterCount.one', 'reader.export.chapterCount.other', { total: props.total })}
          </span>
        </span>
        <button
          type="button"
          className="novel-panel-close"
          aria-label={t('common.close')}
          title={t('common.close')}
          onClick={props.onClose}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </div>

      <div className="novel-export-body">
        {props.running ? (
          <>
            <div className="novel-export-progress">
              <div className="novel-export-bar streaming" aria-hidden="true"><i /></div>
              <div className="novel-export-meta">
                {props.totalChapters === ''
                  ? t('reader.export.runningBytes', { kb: props.kb })
                  : plural(t, Number(props.totalChapters), 'reader.export.running.one', 'reader.export.running.other',
                    { total: props.totalChapters, kb: props.kb })}
              </div>
            </div>
            <div className="novel-export-actions">
              <button type="button" className="novel-btn" onClick={props.onCancel}>{t('reader.export.cancel')}</button>
              <button type="button" className="novel-btn" onClick={props.onClose}>{t('reader.export.collapse')}</button>
            </div>
          </>
        ) : (
          <>
            <div
              className="novel-rdr-seg"
              role="group"
              aria-label={plural(t, props.total, 'reader.export.rangeTotal.one', 'reader.export.rangeTotal.other',
                { total: props.total })}
              style={{
                '--novel-seg-count': String(PRESETS.length),
                '--novel-seg-index': String(Math.max(0, presetIdx)),
              } as CSSProperties}
            >
              {presetIdx >= 0 && <span className="novel-rdr-seg-thumb" aria-hidden="true" />}
              {PRESETS.map((p) => (
                <button
                  key={p.kind}
                  type="button"
                  className={activePreset === p.kind ? 'on' : undefined}
                  aria-pressed={activePreset === p.kind}
                  onClick={() => {
                    props.onPreset(p.kind)
                  }}
                >
                  {t(p.labelKey)}
                </button>
              ))}
            </div>

            <div className="novel-range-pair">
              <label className="novel-export-field">
                <span>{t('reader.export.startChapter')}</span>
                <input
                  type="number"
                  min={1}
                  max={props.total}
                  value={props.draft.from}
                  aria-label={t('reader.export.startChapter')}
                  aria-invalid={!valid.ok}
                  onChange={(e) => {
                    props.onFrom(e.target.value)
                  }}
                />
              </label>
              <span className="novel-range-dash" aria-hidden="true">—</span>
              <label className="novel-export-field">
                <span>{t('reader.export.endChapter')}</span>
                <input
                  type="number"
                  min={1}
                  max={props.total}
                  value={props.draft.to}
                  aria-label={t('reader.export.endChapter')}
                  aria-invalid={!valid.ok}
                  onChange={(e) => {
                    props.onTo(e.target.value)
                  }}
                />
              </label>
            </div>

            {!valid.ok && (
              <div className="novel-export-error" role="status">{t(valid.reason, { total: props.total })}</div>
            )}

            {/* 导出面只有文字：图文书的插图在投影里是占位文字（chapterContentToText），必须在确认前说明。 */}
            <div className="novel-export-notice">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r="6" />
                <path d="M8 7v4M8 4.8h.01" />
              </svg>
              <span>{t('reader.export.textOnly')}</span>
            </div>

            <div className="novel-export-actions">
              <button type="button" className="novel-btn primary" disabled={!valid.ok} onClick={props.onConfirm}>
                {t('reader.export.download')}
              </button>
              <button type="button" className="novel-btn" onClick={props.onClose}>
                {t('common.cancel')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
