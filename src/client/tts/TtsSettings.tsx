import type { ReactNode } from 'react'
import { useEffect, useId, useMemo, useRef } from 'react'
import type { TtsSourceInfo } from '../../shared/wire.js'
import { TTS_RATE, TTS_VOLUME } from '../../shared/wire.js'
import { useCopy } from '../copy/index.js'
import { useStore } from '../store.js'
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

/**
 * 听书设置面的共享件（`ADR-0073`）：阅读器内条与全局迷你条共读同一份行清单与浮层契约——
 * 离开阅读器不该把语速 / 定时 / 引擎 / 音色 / 音量 / 起播章一起丢掉，能力对齐靠共用而不是抄第二份。
 * 行序归 `docs/ui-spec.md` §3.6；「从阅读位置起播」与上一章 / 下一章动作行仍归 `TtsBar` 自己拼：
 * 它读的探针量的是**当前打开的书**，只有「本书 = 正在听的书」的挂载闸门能保证那本书就是会话本书。
 */
export const RATE = TTS_RATE
export const TIMER_MINUTES = [15, 30, 60] as const

export type TimerChoice = (typeof TIMER_MINUTES)[number] | 'chapter' | null

/** 条上步进与设置卡 chip 共用的档位顺序：关闭 → 15 → 30 → 60 → 本章结束。
 *  两端相接，条上单击就是沿这一圈前进一档；设置卡里仍是直选。 */
export const TIMER_SEQUENCE = [null, ...TIMER_MINUTES, 'chapter'] as const

/** 定时档位单击循环：关闭 → 15 → 30 → 60 → 本章结束 → 关闭。档位只有这几格，
 *  单钮循环让条上只留一颗钮；非预设分钟数先落到下一个更大的档，没有就落到本章结束。 */
export function nextTimerChoice(choice: number | 'chapter' | null): TimerChoice {
  const at = TIMER_SEQUENCE.findIndex((step) => step === choice)
  if (at >= 0) return TIMER_SEQUENCE[(at + 1) % TIMER_SEQUENCE.length] ?? null
  if (typeof choice !== 'number') return null
  return TIMER_MINUTES.find((minutes) => minutes > choice) ?? 'chapter'
}

/** 设置入口的图示（阅读器条与浮窗共用）：两根滑杆加短竖杆钮——全图四根直线、零填实，
 *  与播放 / 停止同一套线性语言。隐喻取「参数可调」而不取齿轮：圆心加放射线那版在 13–14px
 *  下会被读成太阳 / 亮度，轮廓齿那版同尺寸下齿谷只剩约 1px、糊成一团；三根带实心圆钮的
 *  滑杆又嫌吵，减到两根杆钮是这个尺寸下最干净、还说得清「可调」的形状。 */
export const SETTINGS_ICON = (
  <svg aria-hidden="true" viewBox="0 0 16 16">
    <path d="M2.5 5.5h11M2.5 10.5h11M9 3.8v3.4M6 8.8v3.4" />
  </svg>
)

/** 设置卡片：非模态（没有遮罩），但键盘与焦点走 `useDialogContract` 的同一份契约——
 *  Esc 关闭、入场焦点落第一颗控件、Tab 圈在卡片内、关闭后还焦到触发它的那颗钮。
 *  头行左边是卡名（可见标题，同时是 `aria-labelledby` 的落点），右边是**中性**关闭钮：
 *  契约把入场焦点给第一颗未禁用钮，而这张卡原来的第一颗正是定时档的「关闭」chip——定时在走时
 *  按 Enter 会静默取消定时。它同时补上非模态卡缺的可见出口（Esc 不是所有人都知道，触屏用户
 *  更没有 Esc）。 */
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

/** 直出型音色表：读数取 `player.ts` 的现场，挂载时补一次量并订 `voiceschanged`（迟到真表的
 *  刷新口径同住那里）——只在渲染里同步 `getVoices()` 会把这一行永远藏掉。 */
export function useDirectVoices(): DirectVoice[] {
  const { list } = useStore(directVoicesStore)
  useEffect(watchDirectVoices, [])
  return list
}

/** 音色行的读面：平台表带语区（`DirectVoice`），订阅与宿主源的音色表只有名字——
 *  同一张 select 吃两种来源，语区缺席就只报名字。 */
type VoiceRow = { id: string; name: string; lang?: string }

/** 六行设置（语速 / 音色 / 音量 / 定时 / 引擎 / 起播章）。音色行按「不可用入口不渲染」与
 *  「有这项能力但当前没有音色」两案分开：直出且平台零音色 → 行不渲染；字节型空数组 → 行仍在
 *  （只剩默认音色这一档）。引擎清单未到 / 现值不在清单里时仍把现值摆出来，不静默换源。 */
export function TtsSettingsRows({ sources, surface }: {
  sources: TtsSourceInfo[] | null
  /** 哪一份设置面在摆这张卡：浮窗尺寸是浮窗自己的现场，只投影给 `float`（`ADR-0080`）。 */
  surface: 'float' | 'bar'
}): ReactNode {
  const t = useCopy()
  const st = useStore(ttsPlayer)
  const mini = useStore(miniBarStore)
  // 音色行看哪张表是上屏投影的一部分（直出型 = 平台表，字节型 = 引擎源声明），
  // 组件不再自己拿 mode 判。
  const face = listenFaceOf(st)

  const platformVoices: VoiceRow[] = useDirectVoices()
  const voices: VoiceRow[] | null = face.voiceTable === 'platform'
    ? (platformVoices.length > 0 ? platformVoices : null)
    : (sources?.find((source) => source.id === st.engineId)?.voices ?? null)
  const voiceValue = voices?.some((voice) => voice.id === st.voice) === true ? st.voice ?? '' : ''

  // 档位读会话自己（`ttsPlayer`），不读组件本地态：条卸载再挂回来时，已经定好的定时器仍在场，
  // chip 必须仍显示那一档（`ADR-0072`：定时属于跨卸载的会话，不属于这一挂载）。
  const timerChoice = st.timerChoice
  const setTimer = (choice: TimerChoice): void => { setListenTimer(choice) }

  const engineIds = sources?.map((source) => source.id) ?? []
  const engineOptions = sources ?? []
  // 全书章名一次铺成 option：三千章的书是三千个元素，性能够呛。元素数组按章名清单 memo，
  // 段间推进（`ttsPlayer` 高频变化）时 React 拿到同一批元素引用即可整段跳过协调。
  const chapterOptions = useMemo(
    () => st.chapterNames.map((name, index) => (
      <option key={index} value={index}>
        {t('tts.mini.chapter', { n: index + 1 })} {name}
      </option>
    )),
    [st.chapterNames, t],
  )

  return (
    <>
      <div className="novel-tts-row">
        <span className="novel-tts-label">{t('tts.rate')}</span>
        <input
          className="novel-tts-range" type="range"
          min={RATE.min} max={RATE.max} step={RATE.step}
          aria-label={t('tts.rate')} value={st.rate}
          onChange={(event) => { setListenRate(Number(event.target.value)) }}
        />
        <span className="novel-tts-val">{rateLabel(st, t)}</span>
      </div>
      {voices !== null && (
        <div className="novel-tts-row">
          <span className="novel-tts-label">{t('tts.voice')}</span>
          <select
            className="novel-tts-select" aria-label={t('tts.voice')} value={voiceValue}
            onChange={(event) => { setListenVoice(event.target.value === '' ? null : event.target.value) }}
          >
            <option value="">{t('tts.voiceDefault')}</option>
            {/* 平台音色带语区（见 `browserTtsVoices`）：几十支跨语种的音色只给名字就是让用户盲选。
                订阅 / 宿主源的音色表没有这一格（源自己报名字），缺席就只显示名字。 */}
            {voices.map((voice) => {
              const lang = voice.lang ?? ''
              return (
                <option key={voice.id} value={voice.id}>
                  {lang ? t('tts.voiceOption', { name: voice.name, lang }) : voice.name}
                </option>
              )
            })}
          </select>
        </div>
      )}
      <div className="novel-tts-row">
        <span className="novel-tts-label">{t('tts.volume')}</span>
        <input
          className="novel-tts-range" type="range"
          min={TTS_VOLUME.min} max={TTS_VOLUME.max} step={TTS_VOLUME.step}
          aria-label={t('tts.volume')} value={st.volume}
          onChange={(event) => { setListenVolume(Number(event.target.value)) }}
        />
        <span className="novel-tts-val">{t('tts.volumeValue', { percent: Math.round(st.volume * 100) })}</span>
      </div>
      <div className="novel-tts-row">
        <span className="novel-tts-label">{t('tts.timer')}</span>
        <div className="novel-chips">
          {TIMER_SEQUENCE.map((choice) => (
            <button key={choice === null ? 'off' : choice} type="button"
              className={timerChoice === choice ? 'novel-chip on' : 'novel-chip'}
              aria-pressed={timerChoice === choice} onClick={() => { setTimer(choice) }}>
              {timerChoiceLabel(choice, t)}
            </button>
          ))}
        </div>
      </div>
      <div className="novel-tts-row">
        <span className="novel-tts-label">{t('tts.engine')}</span>
        <select
          className="novel-tts-select" aria-label={t('tts.engine')} value={st.engineId}
          onChange={(event) => {
            // 换到直出源要先等平台把语音表交出来（Chromium 冷启动首读常为空）：等待与判据都在
            // `setListenEngine` 里，这里只负责把失败翻成人话——选择不生效，会话不回滚。
            // 失败时 DOM 的受控值必须写回实际生效值：只 pushError 不会让本组件重渲，
            // 下拉会停在那个没生效的选项上（读到的值与真正在用的引擎不一致）。
            const select = event.currentTarget
            void setListenEngine(select.value).catch((error: unknown) => {
              select.value = ttsPlayer.get().engineId
              pushError(ttsErrorMessage(t, error))
            })
          }}
        >
          {/* 清单未到 / 当前引擎已不在清单里：仍把现值摆出来（选中态不说谎），不静默换成别的引擎。
              显示名走 `engineLabelOf` 的同一份 kind 判据——自有的内置 / 浏览器 / cordis 源取词，
              只有订阅 id 才回落原始 id，不把 `builtin:baidu` 这类机器串上屏。 */}
          {(sources === null || !engineIds.includes(st.engineId)) && (
            <option value={st.engineId}>{engineLabelOf(t, st.engineId)}</option>
          )}
          {engineOptions.map((source) => (
            <option key={source.id} value={source.id}>{sourceLabel(t, source)}</option>
          ))}
        </select>
      </div>
      <div className="novel-tts-row">
        <span className="novel-tts-label">{t('tts.startChapter')}</span>
        <select
          className="novel-tts-select" aria-label={t('tts.startChapter')} value={st.chapterIndex}
          onChange={(event) => {
            // 与引擎下拉同一条：跳章失败（章正文拉不到）时选中的章并没有生效，受控值写回
            // 实际会话的章号，否则下拉会停在一个没播的章上。
            const select = event.currentTarget
            void jumpToChapter(Number(select.value)).catch((error: unknown) => {
              select.value = String(ttsPlayer.get().chapterIndex)
              pushError(ttsErrorMessage(t, error))
            })
          }}
        >
          {chapterOptions}
        </select>
      </div>
      {surface === 'float'
        ? (
          <div className="novel-tts-row">
            <span className="novel-tts-label">{t('tts.floatSize')}</span>
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
        )
        : null}
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
