import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { useCopy } from '../copy/index.js'
import {
  FONT_STEPS, LINE_HEIGHT_RANGE, MEASURES, MOYU_REVEALS, MOYU_STYLES, PAGE_ANIMATIONS, PAGE_COLUMNS, PAPER_PRESETS, READING_MODES,
} from '../prefs-ui.js'
import { DEFAULT_PREFS, prefsStore, setPref, useStore } from '../store.js'
import {
  hexToHsl, hslToHex, normalizeHex, paperContrastRatio, paperInk, paperLiveInk, rangePercent,
} from '../util.js'

function CheckMark(): ReactNode {
  return (
    <svg className="novel-swatch-check" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.2 8.4 6.5 11.6 12.8 4.8" />
    </svg>
  )
}

function CloseGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}

/** 阅读控制器面板：挂工具栏内（z 序由视图按控制器层单表传入），分组呈现排版 / 纸色外观 / 阅读方式与复位；
 *  自定义取色器的实时配色走 CSS 变量，避免 TSX 内出现颜色字面量。 */
export function PrefsPanel({ zIndex, onClose, hostThemed = false }: {
  zIndex: number
  onClose?: () => void
  hostThemed?: boolean
}): ReactNode {
  const t = useCopy()
  const prefs = useStore(prefsStore)
  const lhId = useId()
  const hexId = useId()
  const isPresetPaper = PAPER_PRESETS.some((p) => p.color.toLowerCase() === prefs.paperColor.toLowerCase())
  const savedCustom = prefs.customPaperColor ?? (!isPresetPaper ? prefs.paperColor : null)
  const [customOpen, setCustomOpen] = useState(false)
  const hexFocusedRef = useRef(false)
  const [hexDraft, setHexDraft] = useState(() => prefs.paperColor.replace(/^#/, '').toUpperCase())
  const [hsl, setHsl] = useState<[number, number, number]>(() => hexToHsl(prefs.paperColor) ?? [44, 52, 94])

  useEffect(() => {
    if (!hexFocusedRef.current) {
      setHexDraft(prefs.paperColor.replace(/^#/, '').toUpperCase())
    }
    setHsl((prev) => {
      if (hslToHex(prev[0], prev[1], prev[2]).toLowerCase() === prefs.paperColor.toLowerCase()) return prev
      const parsed = hexToHsl(prefs.paperColor)
      if (parsed === null) return prev
      // 灰阶或纯白/纯黑没有有效色相或饱和度：保留滑杆既有的 H/S，防止从纯白起手时拖不动
      const h = parsed[1] === 0 || parsed[2] === 0 || parsed[2] === 100 ? prev[0] : parsed[0]
      const s = parsed[2] === 0 || parsed[2] === 100 ? prev[1] : parsed[1]
      return [h, s, parsed[2]]
    })
  }, [prefs.paperColor])

  const applyCustomColor = (hex: string): void => {
    setPref({ paperColor: hex, customPaperColor: hex })
  }

  const updateHsl = (next: [number, number, number]): void => {
    setHsl(next)
    applyCustomColor(hslToHex(next[0], next[1], next[2]))
  }

  const commitHexDraft = (): void => {
    const norm = normalizeHex(hexDraft)
    if (norm !== null) {
      applyCustomColor(norm)
      setHexDraft(norm.slice(1).toUpperCase())
    } else {
      setHexDraft(prefs.paperColor.replace(/^#/, '').toUpperCase())
    }
  }

  const selectPreset = (color: string): void => {
    hexFocusedRef.current = false
    if (!isPresetPaper && prefs.customPaperColor === null) {
      setPref({ paperColor: color, customPaperColor: prefs.paperColor })
    } else {
      setPref({ paperColor: color })
    }
    setCustomOpen(false)
  }

  const toggleCustom = (): void => {
    if (customOpen) {
      setCustomOpen(false)
      return
    }
    hexFocusedRef.current = false
    if (savedCustom !== null && prefs.paperColor.toLowerCase() !== savedCustom.toLowerCase()) {
      setPref({ paperColor: savedCustom, customPaperColor: savedCustom })
    }
    setCustomOpen(true)
  }

  const step = (delta: number): void => {
    const i = FONT_STEPS.indexOf(prefs.fontSize)
    const at = Math.min(FONT_STEPS.length - 1, Math.max(0, (i === -1 ? 3 : i) + delta))
    const next = FONT_STEPS.at(at)
    if (next !== undefined) setPref({ fontSize: next })
  }

  const measureIdxRaw = MEASURES.findIndex((m) => m.px === prefs.measure)
  const modeIdx = READING_MODES.findIndex((mode) => mode.value === prefs.readingMode)
  const revealIdx = MOYU_REVEALS.findIndex((reveal) => reveal.value === prefs.moyuReveal)
  const contrast = paperContrastRatio(prefs.paperColor)

  const pickerVars: CSSProperties = {
    '--novel-picker-h': String(hsl[0]),
    '--novel-picker-s': `${hsl[1]}%`,
    '--novel-picker-l': `${hsl[2]}%`,
    '--novel-picker-color': prefs.paperColor,
    '--novel-picker-ink': paperInk(prefs.paperColor),
    '--novel-picker-live': paperLiveInk(prefs.paperColor),
  } as CSSProperties

  /** 摸鱼模式里的 Aa 是「伪装的宿主浮层」：只留三组与呈现直接相关的偏好（阅读方式 /
   *  呈现风格 / 输出节奏），容器走宿主 popover 面（316px、面板层 2 底、12px 圆角）。
   *  纸色 / 字号那组是纸面阅读的语言，不在这个浮层里出现——与宿主里那枚「⋯」菜单同形。 */
  if (hostThemed) {
    const segStyle = (count: number, index: number): CSSProperties => ({
      '--novel-seg-count': String(count),
      '--novel-seg-index': String(index),
    } as CSSProperties)
    return (
      <div
        data-novel-ctrl
        role="dialog"
        aria-label={t('reader.settings')}
        className="novel-prefs novel-prefs-host"
        style={{ zIndex }}
      >
        <div className="novel-panel-head">
          <span className="novel-panel-head-title">{t('reader.moyu.prefsTitle')}</span>
          {onClose !== undefined && (
            <button type="button" className="novel-panel-close" aria-label={t('common.close')} title={t('common.close')} onClick={onClose}>
              <CloseGlyph />
            </button>
          )}
        </div>
        <div className="novel-prefs-body">
          <section className="novel-setting-section">
            <div className="novel-setting-title">{t('reader.readingMode')}</div>
            <div className="novel-rdr-seg" role="group" aria-label={t('reader.readingMode')} style={segStyle(READING_MODES.length, modeIdx)}>
              {READING_MODES.map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  className={prefs.readingMode === mode.value ? 'on' : undefined}
                  aria-pressed={prefs.readingMode === mode.value}
                  onClick={() => {
                    setPref({ readingMode: mode.value })
                    onClose?.()
                  }}
                >
                  {t(mode.labelKey)}
                </button>
              ))}
            </div>
          </section>
          <section className="novel-setting-section">
            <div className="novel-setting-title">{t('prefs.moyuStyle.label')}</div>
            <div
              className="novel-rdr-seg"
              role="group"
              aria-label={t('prefs.moyuStyle.label')}
              style={segStyle(MOYU_STYLES.length, MOYU_STYLES.findIndex((style) => style.value === prefs.moyuStyle))}
            >
              {MOYU_STYLES.map((style) => (
                <button
                  key={style.value}
                  type="button"
                  className={prefs.moyuStyle === style.value ? 'on' : undefined}
                  aria-pressed={prefs.moyuStyle === style.value}
                  onClick={() => setPref({ moyuStyle: style.value })}
                >
                  {t(style.labelKey)}
                </button>
              ))}
            </div>
          </section>
          <section className="novel-setting-section">
            <div className="novel-setting-title">{t('prefs.moyuReveal.label')}</div>
            <div className="novel-rdr-seg" role="group" aria-label={t('prefs.moyuReveal.label')} style={segStyle(MOYU_REVEALS.length, revealIdx)}>
              {MOYU_REVEALS.map((reveal) => (
                <button
                  key={reveal.value}
                  type="button"
                  className={prefs.moyuReveal === reveal.value ? 'on' : undefined}
                  aria-pressed={prefs.moyuReveal === reveal.value}
                  onClick={() => setPref({ moyuReveal: reveal.value })}
                >
                  {t(reveal.labelKey)}
                </button>
              ))}
            </div>
          </section>
          <div className="novel-note-sm">{t('prefs.moyu.shortcut')}</div>
        </div>
      </div>
    )
  }

  return (
    <div
      data-novel-ctrl
      role="dialog"
      aria-label={t('reader.settings')}
      className={prefs.darkController ? 'novel-dark novel-prefs' : 'novel-prefs'}
      style={{ position: 'absolute', right: 12, top: 52, zIndex }}
    >
      <div className="novel-panel-head">
        <span className="novel-panel-head-title">{t('reader.settings')}</span>
        {onClose !== undefined && (
          <button type="button" className="novel-panel-close" aria-label={t('common.close')} title={t('common.close')} onClick={onClose}>
            <CloseGlyph />
          </button>
        )}
      </div>

      <div className="novel-prefs-body" style={pickerVars}>
        <section className="novel-setting-section">
          <div className="novel-setting-title">{t('reader.prefs.typography')}</div>
          <div className="novel-setting-row">
            <span className="novel-setting-row-label">{t('reader.fontSizeCurrent', { size: prefs.fontSize })}</span>
            <div className="novel-stepper">
              <button
                type="button"
                onClick={() => step(-1)}
                disabled={prefs.fontSize <= (FONT_STEPS[0] ?? 12)}
                aria-label={t('reader.fontSizeDown')}
              >
                A−
              </button>
              <span>{prefs.fontSize}px</span>
              <button
                type="button"
                onClick={() => step(1)}
                disabled={prefs.fontSize >= (FONT_STEPS.at(-1) ?? 28)}
                aria-label={t('reader.fontSizeUp')}
              >
                A＋
              </button>
            </div>
          </div>

          <div className="novel-setting-row">
            <label className="novel-setting-row-label" htmlFor={lhId}>{t('reader.lineHeight')}</label>
            <div className="novel-range-ctl">
              <input
                id={lhId}
                type="range"
                className="novel-rdr-range"
                min={LINE_HEIGHT_RANGE.min}
                max={LINE_HEIGHT_RANGE.max}
                step={LINE_HEIGHT_RANGE.step}
                value={prefs.lineHeight}
                style={{
                  '--novel-range-fill': rangePercent(prefs.lineHeight, LINE_HEIGHT_RANGE.min, LINE_HEIGHT_RANGE.max),
                } as CSSProperties}
                onChange={(e) => setPref({ lineHeight: Number(e.target.value) })}
              />
              <output htmlFor={lhId}>{prefs.lineHeight.toFixed(1)}</output>
            </div>
          </div>

          <div className="novel-setting-sublabel">{t('reader.measureCurrent', { n: prefs.measure })}</div>
          <div
            className="novel-rdr-seg"
            role="group"
            aria-label={t('reader.measureCurrent', { n: prefs.measure })}
            style={{
              '--novel-seg-count': String(MEASURES.length),
              '--novel-seg-index': String(Math.max(0, measureIdxRaw)),
            } as CSSProperties}
          >
            {measureIdxRaw >= 0 && <span className="novel-rdr-seg-thumb" aria-hidden="true" />}
            {MEASURES.map((m) => (
              <button
                key={m.px}
                type="button"
                className={prefs.measure === m.px ? 'on' : undefined}
                aria-pressed={prefs.measure === m.px}
                onClick={() => setPref({ measure: m.px })}
              >
                {t(m.labelKey)}
              </button>
            ))}
          </div>
        </section>

        <section className="novel-setting-section">
          <div className="novel-setting-title">{t('reader.prefs.appearance')}</div>
          <div className="novel-setting-sublabel">{t('reader.paper')}</div>
          <div className="novel-swatches">
            {PAPER_PRESETS.map((p) => {
              const active = prefs.paperColor.toLowerCase() === p.color.toLowerCase()
              return (
                <div key={p.color} className="novel-swatch-item">
                  <button
                    type="button"
                    title={t(p.nameKey)}
                    aria-label={t(p.nameKey)}
                    aria-pressed={active}
                    className={active ? 'novel-rdr-swatch on' : 'novel-rdr-swatch'}
                    style={{ background: p.color, color: paperInk(p.color) }}
                    onClick={() => selectPreset(p.color)}
                  >
                    <CheckMark />
                  </button>
                  <span className="novel-swatch-name">{t(p.nameKey)}</span>
                </div>
              )
            })}
            <div className="novel-swatch-item">
              <button
                type="button"
                title={t('reader.paperCustom')}
                aria-label={t('reader.paperCustom')}
                aria-expanded={customOpen}
                className={!isPresetPaper ? 'novel-rdr-custom-swatch on' : 'novel-rdr-custom-swatch'}
                onClick={toggleCustom}
              >
                <span
                  className="novel-custom-swatch-core"
                  style={savedCustom !== null ? { background: savedCustom, color: paperInk(savedCustom) } : undefined}
                >
                  <CheckMark />
                </span>
              </button>
              <span className="novel-swatch-name">{t('prefs.paper.custom')}</span>
            </div>
          </div>

          {customOpen && (
            <div className="novel-custom-picker">
              <div className="novel-custom-preview">
                <div className="novel-custom-preview-text">
                  {t('reader.prefs.previewBody')}
                  <span className="novel-custom-preview-live">{t('reader.prefs.previewLive')}</span>
                </div>
                <span className="novel-custom-preview-badge">{t('reader.prefs.contrastBadge', { ratio: contrast })}</span>
              </div>

              <label className="novel-hex-field" htmlFor={hexId}>
                <span aria-hidden="true">#</span>
                <input
                  id={hexId}
                  type="text"
                  maxLength={7}
                  aria-label={t('reader.prefs.hexColor')}
                  value={hexDraft}
                  onFocus={() => { hexFocusedRef.current = true }}
                  onChange={(e) => {
                    const clean = e.target.value.replace(/^#/, '')
                    setHexDraft(clean)
                    // 仅在 6 位完整 hex 时即时应用，3 位简写留到失焦/回车再展开，避免手打 6 位到第 3 位被覆写
                    if (/^[0-9a-f]{6}$/i.test(clean.trim())) {
                      const norm = normalizeHex(clean)
                      if (norm !== null) applyCustomColor(norm)
                    }
                  }}
                  onBlur={() => {
                    hexFocusedRef.current = false
                    commitHexDraft()
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitHexDraft()
                    }
                  }}
                />
              </label>

              <label className="novel-color-slider-row">
                <span>{t('reader.prefs.hue')}</span>
                <input
                  type="range"
                  className="novel-color-slider is-h"
                  min={0}
                  max={360}
                  value={hsl[0]}
                  aria-label={t('reader.prefs.hue')}
                  onChange={(e) => updateHsl([Number(e.target.value), hsl[1], hsl[2]])}
                />
                <output>{hsl[0]}°</output>
              </label>
              <label className="novel-color-slider-row">
                <span>{t('reader.prefs.saturation')}</span>
                <input
                  type="range"
                  className="novel-color-slider is-s"
                  min={0}
                  max={100}
                  value={hsl[1]}
                  aria-label={t('reader.prefs.saturation')}
                  onChange={(e) => updateHsl([hsl[0], Number(e.target.value), hsl[2]])}
                />
                <output>{hsl[1]}%</output>
              </label>
              <label className="novel-color-slider-row">
                <span>{t('reader.prefs.lightness')}</span>
                <input
                  type="range"
                  className="novel-color-slider is-l"
                  min={4}
                  max={99}
                  value={hsl[2]}
                  aria-label={t('reader.prefs.lightness')}
                  onChange={(e) => updateHsl([hsl[0], hsl[1], Number(e.target.value)])}
                />
                <output>{hsl[2]}%</output>
              </label>

              {contrast < 4.5 && (
                <div className="novel-contrast-warn" role="status">
                  {t('reader.prefs.contrastWarn', { ratio: contrast })}
                </div>
              )}

              <button type="button" className="novel-custom-done" onClick={() => setCustomOpen(false)}>
                {t('reader.prefs.done')}
              </button>
            </div>
          )}

          <label className="novel-switch-row">
            <span className="novel-switch-copy">
              <span>{t('reader.darkController')}</span>
              <small>{t('reader.prefs.darkControllerHint')}</small>
            </span>
            <span className="novel-rdr-switch">
              <input
                type="checkbox"
                className="novel-rdr-switch-input"
                checked={prefs.darkController}
                onChange={(e) => setPref({ darkController: e.target.checked })}
              />
              <span className="novel-rdr-switch-track" aria-hidden="true" />
            </span>
          </label>
        </section>

        <section className="novel-setting-section">
          <div className="novel-setting-title">{t('reader.prefs.modeSection')}</div>
          <div
            className="novel-rdr-seg"
            role="group"
            aria-label={t('reader.readingMode')}
            style={{
              '--novel-seg-count': String(READING_MODES.length),
              '--novel-seg-index': String(modeIdx),
            } as CSSProperties}
          >
            <span className="novel-rdr-seg-thumb" aria-hidden="true" />
            {READING_MODES.map((mode) => (
              <button
                key={mode.value}
                type="button"
                className={prefs.readingMode === mode.value ? 'on' : undefined}
                aria-pressed={prefs.readingMode === mode.value}
                onClick={() => {
                  setPref({ readingMode: mode.value })
                  if (mode.value === 'moyu') onClose?.()
                }}
              >
                {t(mode.labelKey)}
              </button>
            ))}
          </div>

          {prefs.readingMode === 'page' && (
            <div className="novel-reveal-down">
              <div className="novel-setting-sublabel">{t('reader.pageColumns')}</div>
              <div className="novel-rdr-pills" role="group" aria-label={t('reader.pageColumns')}>
                {PAGE_COLUMNS.map((col) => (
                  <button
                    key={col.value}
                    type="button"
                    className={prefs.pageColumns === col.value ? 'novel-rdr-pill on' : 'novel-rdr-pill'}
                    aria-pressed={prefs.pageColumns === col.value}
                    onClick={() => setPref({ pageColumns: col.value })}
                  >
                    {t(col.labelKey)}
                  </button>
                ))}
              </div>
              <div className="novel-setting-sublabel">{t('reader.pageAnimation')}</div>
              <div className="novel-rdr-pills" role="group" aria-label={t('reader.pageAnimation')}>
                {PAGE_ANIMATIONS.map((anim) => (
                  <button
                    key={anim.value}
                    type="button"
                    className={prefs.pageAnimation === anim.value ? 'novel-rdr-pill on' : 'novel-rdr-pill'}
                    aria-pressed={prefs.pageAnimation === anim.value}
                    onClick={() => setPref({ pageAnimation: anim.value })}
                  >
                    {t(anim.labelKey)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {prefs.readingMode === 'moyu' && (
            <div className="novel-reveal-down">
              <div className="novel-setting-sublabel">{t('prefs.moyuStyle.label')}</div>
              <div className="novel-rdr-pills" role="group" aria-label={t('prefs.moyuStyle.label')}>
                {MOYU_STYLES.map((style) => (
                  <button
                    key={style.value}
                    type="button"
                    className={prefs.moyuStyle === style.value ? 'novel-rdr-pill on' : 'novel-rdr-pill'}
                    aria-pressed={prefs.moyuStyle === style.value}
                    onClick={() => setPref({ moyuStyle: style.value })}
                  >
                    {t(style.labelKey)}
                  </button>
                ))}
              </div>
              <div className="novel-setting-sublabel">{t('prefs.moyuReveal.label')}</div>
              <div className="novel-rdr-pills" role="group" aria-label={t('prefs.moyuReveal.label')}>
                {MOYU_REVEALS.map((reveal) => (
                  <button
                    key={reveal.value}
                    type="button"
                    className={prefs.moyuReveal === reveal.value ? 'novel-rdr-pill on' : 'novel-rdr-pill'}
                    aria-pressed={prefs.moyuReveal === reveal.value}
                    onClick={() => setPref({ moyuReveal: reveal.value })}
                  >
                    {t(reveal.labelKey)}
                  </button>
                ))}
              </div>
              <div className="novel-note-sm">{t('prefs.moyu.shortcut')}</div>
            </div>
          )}
        </section>

        <div className="novel-prefs-reset-row">
          <button
            type="button"
            className="novel-prefs-reset"
            onClick={() => {
              hexFocusedRef.current = false
              setPref({ ...DEFAULT_PREFS })
              setCustomOpen(false)
            }}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9L2.5 5.5M2.5 2.5v3h3" />
            </svg>
            {t('reader.prefs.reset')}
          </button>
        </div>
      </div>
    </div>
  )
}
