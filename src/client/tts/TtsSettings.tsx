import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useId, useMemo, useRef } from 'react'
import type { TtsSourceInfo } from '../../shared/wire.js'
import { TTS_RATE, TTS_VOLUME } from '../../shared/wire.js'
import { useCopy } from '../copy/index.js'
import { useStore } from '../store.js'
import { rangePercent } from '../util.js'
import {
  SIZE_PRESETS, miniBarStore, resetMiniBarSize, setMiniBarSize,
} from './mini-bar-state.js'
import { pushError } from '../transient.js'
import { useDialogContract } from '../views/dialog.js'
import { sourceLabel, engineLabelOf } from './engine-rows.js'
import { listenFaceOf, rateLabel, timerChoiceLabel } from './listen-readout.js'
import { ttsErrorMessage } from './tts-error.js'
import {
  directVoicesStore, jumpToChapter, setListenEngine, setListenRate, setListenTimer, setListenVoice,
  setListenVolume, ttsPlayer, watchDirectVoices,
} from './player.js'
import type { DirectVoice } from './player.js'

/** 听书设置面的共享件（`ADR-0100`）：阅读器内条与全局迷你条共读同一份行清单与浮层契约——
 *  离开阅读器不该把语速 / 定时 / 引擎 / 音色 / 音量 / 起播章一起丢掉。行序归 `docs/ui-spec.md` §3.6。
 *  「从阅读位置起播」与上一章 / 下一章动作行仍归 `TtsBar` 自己拼（它读的探针量的是当前打开的书）。
 */
export const RATE = TTS_RATE
export const TIMER_MINUTES = [15, 30, 60] as const

export type TimerChoice = (typeof TIMER_MINUTES)[number] | 'chapter' | null

/** 条上步进与设置卡 chip 共用的档位顺序：关闭 → 15 → 30 → 60 → 本章结束；条上单击沿这一圈前进一档。 */
export const TIMER_SEQUENCE = [null, ...TIMER_MINUTES, 'chapter'] as const

/** 定时档位单击循环：关闭 → 15 → 30 → 60 → 本章结束 → 关闭。非预设分钟数先落到下一档，没有就落到本章结束。 */
export function nextTimerChoice(choice: number | 'chapter' | null): TimerChoice {
  const at = TIMER_SEQUENCE.findIndex((step) => step === choice)
  if (at >= 0) return TIMER_SEQUENCE[(at + 1) % TIMER_SEQUENCE.length] ?? null
  if (typeof choice !== 'number') return null
  return TIMER_MINUTES.find((minutes) => minutes > choice) ?? 'chapter'
}

/** 设置入口的图示（阅读器条与浮窗共用）：两根滑杆加短竖杆钮——零填实，与播放 / 停止同一套线性语言。
 *  隐喻取「参数可调」不取齿轮：齿轮在 13–14px 下会被读成太阳 / 亮度。 */
export const SETTINGS_ICON = (
  <svg aria-hidden="true" viewBox="0 0 16 16">
    <path d="M2.5 5.5h11M2.5 10.5h11M9 3.8v3.4M6 8.8v3.4" />
  </svg>
)

/** 设置卡片：非模态（没有遮罩），但键盘与焦点走 `useDialogContract` 的同一份契约。头行左边是卡名
 *  （`aria-labelledby` 落点），右边是**中性**关闭钮：原来的第一颗是定时档的「关闭」chip，
 *  按 Enter 会静默取消定时；它同时补上非模态卡缺的可见出口。 */
export function TtsSettingsPanel({ label, onClose, children }: {
  label: string
  onClose: () => void
  children: ReactNode
}): ReactNode {
  const t = useCopy()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const titleId = useId()
  useDialogContract({ panelRef, onClose })
  return (
    <div ref={panelRef} className="novel-tts-panel" role="dialog" aria-labelledby={titleId}>
      <div className="novel-tts-panel-head">
        <span className="novel-tts-panel-title" id={titleId}>{label}</span>
        <button
          type="button" className="novel-tts-panel-close"
          aria-label={t('tts.settingsClose')} title={t('tts.settingsClose')}
          onClick={onClose}
        >
          <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </div>
      {children}
    </div>
  )
}

/** 直出型音色表：读数取 `player.ts` 的现场，挂载时补一次量并订 `voiceschanged`——只在渲染里同步
 *  `getVoices()` 会把这一行永远藏掉。 */
export function useDirectVoices(): DirectVoice[] {
  const { list } = useStore(directVoicesStore)
  useEffect(watchDirectVoices, [])
  return list
}

/** 原生 `<select>` 弹出列表会按全表最宽 `<option>` 撑开，CSS 裁不到原生菜单；按半角单位收敛单条展示宽度，完整文本留给 `title`。 */
export const SELECT_OPTION_MAX_UNITS = 34

function visualUnits(text: string): number {
  let units = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    units += code >= 0x1100 ? 2 : 1
  }
  return units
}

/** 将下拉选项标签归一化为单行并按视觉半角宽度截断：短文本原样保留，超宽按码点边界收尾 `…`。 */
export function clampSelectOptionLabel(text: string, maxUnits = SELECT_OPTION_MAX_UNITS): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (visualUnits(clean) <= maxUnits) return clean
  const limit = Math.max(2, maxUnits - 2)
  let used = 0
  let out = ''
  for (const ch of clean) {
    const w = (ch.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1
    if (used + w > limit) break
    out += ch
    used += w
  }
  return `${out.trimEnd()}…`
}

/** 音色行的读面：平台表带语区，订阅与宿主源的音色表只有名字——同一张 select 吃两种来源。 */
type VoiceRow = { id: string; name: string; lang?: string }

/** 六行设置（语速 / 音量 / 音色 / 定时 / 引擎 / 起播章）。音色行按「不可用入口不渲染」与「有这项
 *  能力但当前没有音色」两案分开。引擎清单未到 / 现值不在清单里时仍摆出现值，不静默换源。 */
export function TtsSettingsRows({ sources, surface }: {
  sources: TtsSourceInfo[] | null
  /** 哪一份设置面在摆这张卡：浮窗尺寸是浮窗自己的现场，只投影给 `float`（`ADR-0080`）。 */
  surface: 'float' | 'bar'
}): ReactNode {
  const t = useCopy()
  const st = useStore(ttsPlayer)
  const mini = useStore(miniBarStore)
  // 音色行看哪张表是上屏投影的一部分（直出型 = 平台表，字节型 = 引擎源声明），组件不自己拿 mode 判。
  const face = listenFaceOf(st)

  const platformVoices: VoiceRow[] = useDirectVoices()
  const voices: VoiceRow[] | null = face.voiceTable === 'platform'
    ? (platformVoices.length > 0 ? platformVoices : null)
    : (sources?.find((source) => source.id === st.engineId)?.voices ?? null)
  const voiceValue = voices?.some((voice) => voice.id === st.voice) === true ? st.voice ?? '' : ''

  // 档位读会话自己（`ttsPlayer`），不读组件本地态：条卸载再挂回来时已定的定时器仍在场（`ADR-0072`）。
  const timerChoice = st.timerChoice
  const setTimer = (choice: TimerChoice): void => { setListenTimer(choice) }

  const engineIds = sources?.map((source) => source.id) ?? []
  const engineOptions = sources ?? []
  const chapterFullTitle = (index: number): string => {
    const prefix = t('tts.mini.chapter', { n: index + 1 })
    const cleanName = (st.chapterNames[index] ?? '').replace(/\s+/g, ' ').trim()
    return cleanName === '' ? prefix : `${prefix} ${cleanName}`
  }
  const currentChapterTitle = st.chapterIndex >= 0 && st.chapterIndex < st.chapterNames.length
    ? chapterFullTitle(st.chapterIndex)
    : undefined
  // 全书章名一次铺成 option：元素数组按章名清单 memo，段间推进时 React 拿到同一批引用即可跳过协调。
  const chapterOptions = useMemo(
    () => st.chapterNames.map((name, index) => {
      const prefix = t('tts.mini.chapter', { n: index + 1 })
      const cleanName = name.replace(/\s+/g, ' ').trim()
      const full = cleanName === '' ? prefix : `${prefix} ${cleanName}`
      return (
        <option key={index} value={index} title={full}>
          {clampSelectOptionLabel(full)}
        </option>
      )
    }),
    [st.chapterNames, t],
  )

  return (
    <>
      <div className="novel-tts-group">
        <div className="novel-tts-row">
          <span className="novel-tts-label">{t('tts.rate')}</span>
          <input
            className="novel-tts-range" type="range"
            min={RATE.min} max={RATE.max} step={RATE.step}
            aria-label={t('tts.rate')} value={st.rate}
            style={{ '--novel-range-fill': rangePercent(st.rate, RATE.min, RATE.max) } as CSSProperties}
            onChange={(event) => { setListenRate(Number(event.target.value)) }}
          />
          <span className="novel-tts-val">{rateLabel(st, t)}</span>
        </div>
        <div className="novel-tts-row">
          <span className="novel-tts-label">{t('tts.volume')}</span>
          <input
            className="novel-tts-range" type="range"
            min={TTS_VOLUME.min} max={TTS_VOLUME.max} step={TTS_VOLUME.step}
            aria-label={t('tts.volume')} value={st.volume}
            style={{ '--novel-range-fill': rangePercent(st.volume, TTS_VOLUME.min, TTS_VOLUME.max) } as CSSProperties}
            onChange={(event) => { setListenVolume(Number(event.target.value)) }}
          />
          <span className="novel-tts-val">{t('tts.volumeValue', { percent: Math.round(st.volume * 100) })}</span>
        </div>
        {voices !== null && (
          <div className="novel-tts-row">
            <span className="novel-tts-label">{t('tts.voice')}</span>
            <span className="novel-select-wrap">
              <select
                className="novel-tts-select" aria-label={t('tts.voice')} value={voiceValue}
                onChange={(event) => { setListenVoice(event.target.value === '' ? null : event.target.value) }}
              >
                <option value="">{t('tts.voiceDefault')}</option>
                {/* 平台音色带语区（见 `browserTtsVoices`）：几十支跨语种的音色只给名字就是让用户盲选。 */}
                {voices.map((voice) => {
                  const lang = voice.lang ?? ''
                  const full = lang ? t('tts.voiceOption', { name: voice.name, lang }) : voice.name
                  const display = (() => {
                    if (!lang) return clampSelectOptionLabel(voice.name)
                    const cleanFull = full.replace(/\s+/g, ' ').trim()
                    if (visualUnits(cleanFull) <= SELECT_OPTION_MAX_UNITS) return cleanFull
                    const suffixUnits = visualUnits(t('tts.voiceOption', { name: '', lang }))
                    const nameBudget = Math.max(8, SELECT_OPTION_MAX_UNITS - suffixUnits)
                    return t('tts.voiceOption', { name: clampSelectOptionLabel(voice.name, nameBudget), lang })
                  })()
                  return (
                    <option key={voice.id} value={voice.id} title={full}>
                      {display}
                    </option>
                  )
                })}
              </select>
              <svg className="novel-select-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
            </span>
          </div>
        )}
      </div>

      <div className="novel-tts-group">
        <div className="novel-tts-row">
          <span className="novel-tts-label">{t('tts.timer')}</span>
          <div className="novel-tts-timer-grid">
            {TIMER_SEQUENCE.map((choice) => (
              <button key={choice === null ? 'off' : choice} type="button"
                className={timerChoice === choice ? 'novel-chip on' : 'novel-chip'}
                aria-pressed={timerChoice === choice} onClick={() => { setTimer(choice) }}>
                {timerChoiceLabel(choice, t)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="novel-tts-group">
        <div className="novel-tts-row">
          <span className="novel-tts-label">{t('tts.engine')}</span>
          <span className="novel-select-wrap">
            <select
              className="novel-tts-select" aria-label={t('tts.engine')} value={st.engineId}
              onChange={(event) => {
                // 换到直出源要先等语音表（等待与判据都在 `setListenEngine`）；失败时 DOM 的受控值必须写回实际生效值。
                const select = event.currentTarget
                void setListenEngine(select.value).catch((error: unknown) => {
                  select.value = ttsPlayer.get().engineId
                  pushError(ttsErrorMessage(t, error))
                })
              }}
            >
              {/* 清单未到 / 当前引擎已不在清单里：仍把现值摆出来（选中态不说谎），不静默换成别的引擎。 */}
              {(sources === null || !engineIds.includes(st.engineId)) && (() => {
                const label = engineLabelOf(t, st.engineId)
                return <option value={st.engineId} title={label}>{clampSelectOptionLabel(label)}</option>
              })()}
              {engineOptions.map((source) => {
                const label = sourceLabel(t, source)
                return <option key={source.id} value={source.id} title={label}>{clampSelectOptionLabel(label)}</option>
              })}
            </select>
            <svg className="novel-select-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
          </span>
        </div>
        <div className="novel-tts-row">
          <span className="novel-tts-label">{t('tts.startChapter')}</span>
          <span className="novel-select-wrap">
            <select
              className="novel-tts-select" aria-label={t('tts.startChapter')}
              title={currentChapterTitle} value={st.chapterIndex}
              onChange={(event) => {
                // 与引擎下拉同一条：跳章失败时选中的章没有生效，受控值写回实际会话的章号。
                const select = event.currentTarget
                void jumpToChapter(Number(select.value)).catch((error: unknown) => {
                  select.value = String(ttsPlayer.get().chapterIndex)
                  pushError(ttsErrorMessage(t, error))
                })
              }}
            >
              {chapterOptions}
            </select>
            <svg className="novel-select-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
          </span>
        </div>
        {surface === 'float'
          ? (
            <div className="novel-tts-row">
              <span className="novel-tts-label">{t('tts.floatSize')}</span>
              <div className="novel-tts-float-sizes">
                {SIZE_PRESETS.map((preset) => {
                  const on = presetOn(preset.width, preset.height, mini.w, mini.h)
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      className={on ? 'novel-tts-chip on' : 'novel-tts-chip'}
                      aria-pressed={on}
                      onClick={() => { setMiniBarSize(preset.width, preset.height) }}
                    >
                      {t(`tts.floatSize.${preset.id}`)}
                    </button>
                  )
                })}
                <button type="button" className="novel-tts-chip" onClick={resetMiniBarSize}>
                  {t('tts.floatSizeReset')}
                </button>
              </div>
            </div>
          )
          : null}
      </div>
    </>
  )
}

/** 档位高亮：两轴都没调过时算缺省档（中）；否则按两轴数值匹配。 */
function presetOn(width: number, height: number, w: number | null, h: number | null): boolean {
  const current = { w: w ?? DEFAULT_PRESET.width, h: h ?? DEFAULT_PRESET.height }
  return current.w === width && current.h === height
}

const DEFAULT_PRESET = SIZE_PRESETS[1]

/** 两处设置面共用同一句位置提示，不在各条上另写抄本。 */
export function TtsSettingsNote(): ReactNode {
  const t = useCopy()
  return <div className="novel-tts-note">{t('tts.positionNote')}</div>
}
