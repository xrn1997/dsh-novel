import type { ReactNode } from 'react'
import { plural, useCopy } from '../copy/index.js'
import type { ExportDraft, RangeParse } from '../export-run.js'

/**
 * 导出范围面板（⤓ 钮的第一步）：起止章输入 + 快捷预设 + 确认/取消。
 * 口径：点⤓不再直接全下——本面板是唯一开下入口（确认前零请求）；草稿（缺省/档位/校验）
 * 归 export-run 的 draftOf / applyPreset / validRangeOf（倒置/越界/非整数/目录未就绪一律禁
 * 确认，宁可不发不发废包），本面板**只渲染**裁决与透传编辑，不自己判。
 * 挂工具栏内（与 PrefsPanel 同款绝对定位，z 值由视图按控制器层单表传入；z 序不变量见 ReaderView
 * 的 CTRL_Z 头注）；运行中换进度视图（沿用 ExportRunState），仍在场可取消。role=dialog + aria-label=导出范围。
 */
export function ExportPanel(props: {
  /** 范围草稿：两个输入框里用户的编辑，由视图持有、编辑经回调回去 */
  draft: ExportDraft
  /** 草稿的校验裁决（唯一判据 validRangeOf，按活章数算出）；失败臂的 reason 由本面板翻译上屏 */
  valid: RangeParse
  /** 当前目录章数：面板上「共 N 章」读数与输入框上限的活值——不是草稿的一部分，每次渲染由视图现给 */
  total: number
  running: boolean
  kb: number
  /** 运行中章数标题（x-novel-total-chapters 头；未给为空串） */
  totalChapters: string
  onFrom: (v: string) => void
  onTo: (v: string) => void
  onPreset: (kind: 'all' | 'rest') => void
  onConfirm: () => void
  onClose: () => void
  onCancel: () => void
  darkController: boolean
  /** 控制器层 z（CTRL_Z.panel，由视图传入） */
  zIndex: number
}): ReactNode {
  const t = useCopy()
  const valid = props.valid
  return (
    <div
      data-novel-ctrl
      role="dialog"
      aria-label={t('reader.export.range')}
      className={props.darkController ? 'novel-dark novel-prefs' : 'novel-prefs'}
      style={{ position: 'absolute', right: 12, top: 40, zIndex: props.zIndex }}
    >
      {props.running ? (
        <>
          <div className="novel-prefs-label">
            {props.totalChapters === ''
              ? t('reader.export.runningBytes', { kb: props.kb })
              : plural(t, Number(props.totalChapters), 'reader.export.running.one', 'reader.export.running.other',
                { total: props.totalChapters, kb: props.kb })}
          </div>
          <div className="novel-chips">
            <button className="novel-chip" onClick={props.onCancel}>{t('reader.export.cancel')}</button>
            <button className="novel-chip" onClick={props.onClose}>{t('reader.export.collapse')}</button>
          </div>
        </>
      ) : (
        <>
          <div className="novel-prefs-label">
            {plural(t, props.total, 'reader.export.rangeTotal.one', 'reader.export.rangeTotal.other',
              { total: props.total })}
          </div>
          <label>
            {t('reader.export.fromPrefix')}
            <input className="novel-input" type="number" min={1} max={props.total}
              value={props.draft.from} onChange={(e) => props.onFrom(e.target.value)} aria-label={t('reader.export.startChapter')} />
            {t('reader.export.between')}
            <input className="novel-input" type="number" min={1} max={props.total}
              value={props.draft.to} onChange={(e) => props.onTo(e.target.value)} aria-label={t('reader.export.endChapter')} />
            {t('reader.export.toSuffix')}
          </label>
          <div className="novel-chips">
            <button className="novel-chip" onClick={() => props.onPreset('all')}>{t('reader.export.all')}</button>
            <button className="novel-chip" onClick={() => props.onPreset('rest')}>{t('reader.export.rest')}</button>
          </div>
          {!valid.ok && <div className="novel-prefs-label" role="status">{t(valid.reason, { total: props.total })}</div>}
          {/* 导出面只有文字：图文书的插图在投影里是占位文字（`chapterContentToText`），
              这句话必须在下手之前说，而不是等用户对着下载到的文件发现插图没了。 */}
          <div className="novel-prefs-label">{t('reader.export.textOnly')}</div>
          <div className="novel-chips">
            <button className="novel-chip" disabled={!valid.ok} onClick={props.onConfirm}>{t('reader.export.download')}</button>
            <button className="novel-chip" onClick={props.onClose}>{t('common.cancel')}</button>
          </div>
        </>
      )}
    </div>
  )
}
