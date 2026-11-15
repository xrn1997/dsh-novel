import type { ReactNode } from 'react'
import { useId, useState } from 'react'
import { ROUTES, bodies } from '../../shared/wire.js'
import type { TtsEngineImportReceipt, TtsEnginePublic } from '../../shared/wire.js'
import { apiSend, describeError } from '../api.js'
import { useCopy } from '../copy/index.js'
import { exportJsonOf, overwriteIdsOf } from './engine-rows.js'

/**
 * 订阅引擎的导入与导出：两条导入来路（粘贴 JSON / 从 URL 拉取）与一份剥凭据的导出文本。
 * 自持导入现场（粘贴、URL、回执、失败），成功只通知外层重读清单。
 *
 * **覆盖要先点名**：服务端 upsert 对可编辑文本位是整体替换（本次条目缺席的 `header` /
 * `jsLib` / `contentType` = 从记录上删掉），只有 `auth` / `voices` 是「缺席 = 保留」。
 * 粘贴开来的 JSON 若带得出显式 id，就在提交前与现有订阅求交；命中时先摆一条确认，
 * 点名会覆盖几条、会替换哪几格静态数据。URL 来路的清单要到服务端才知道，预览不了——
 * 回执里那句「更新」补一句覆盖含义。
 *
 * 返回 `controls`（标题行的两枚按钮）与 `panels`（展开的表单 / 回执 / 失败），由调用方分别
 * 放进标题行与列表之后——按钮与面板不在同一个 DOM 父级，但状态只住这一份 hook。
 */
export function useEngineImportExport({ engines, onChanged, disabled }: {
  engines: readonly TtsEnginePublic[] | null
  onChanged: () => void
  /** 只读部署：订阅写口禁用（导出与清单是读面，不受影响）。 */
  disabled: boolean
}): { controls: ReactNode; panels: ReactNode } {
  const t = useCopy()
  const [showImport, setShowImport] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [pasteJson, setPasteJson] = useState('')
  const [importUrl, setImportUrl] = useState('')
  const [importing, setImporting] = useState(false)
  /** 待确认的覆盖：粘贴原文 + 会被改写的既有 id。确认前一个写口都不发。 */
  const [pendingOverwrite, setPendingOverwrite] = useState<{ json: string; ids: string[] } | null>(null)
  const [receipt, setReceipt] = useState<TtsEngineImportReceipt | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const pasteId = useId()
  const urlId = useId()
  const exportId = useId()
  const ready = engines !== null
  const exportText = engines === null ? '' : exportJsonOf(engines)

  /** 两条导入路共用提交：body 恰带一位（JSON 或 URL），另一位由调用点根本不传。 */
  const submitImport = (body: { json: string } | { url: string }): void => {
    if (importing || disabled) return
    setImporting(true)
    setActionError(null)
    setReceipt(null)
    void apiSend<TtsEngineImportReceipt>(ROUTES.ttsEnginesImport, bodies.ttsEnginesImport(body)).then(
      (result) => {
        setImporting(false)
        setReceipt(result)
        if ('json' in body) setPasteJson('')
        else setImportUrl('')
        onChanged()
      },
      (error: unknown) => {
        setImporting(false)
        setActionError(t('tts.engines.importFailed', { detail: describeError(error, t) }))
      },
    )
  }

  const importFromJson = (): void => {
    if (pasteJson.trim() === '' || disabled) return
    // 只有「读得出 id 且命中现有订阅」才拦一步；解不开的 JSON 交给服务端回执点名，
    // 客户端不替它猜「这条算不算覆盖」。
    const ids = overwriteIdsOf(pasteJson, engines ?? [])
    if (ids.length > 0) {
      setActionError(null)
      setReceipt(null)
      setPendingOverwrite({ json: pasteJson, ids })
      return
    }
    submitImport({ json: pasteJson })
  }

  const confirmOverwrite = (): void => {
    if (pendingOverwrite === null) return
    const target = pendingOverwrite
    setPendingOverwrite(null)
    submitImport({ json: target.json })
  }

  const importFromUrl = (): void => {
    if (importUrl.trim() === '' || disabled) return
    // URL 位的首尾空白是用户的输入习惯，不是地址的一部分：发出去之前先归一。
    submitImport({ url: importUrl.trim() })
  }

  const controls = (
    <>
      <button type="button" className="novel-btn sm" aria-expanded={showImport} disabled={disabled}
        onClick={() => {
          // 收起面板 = 放弃这次导入现场：待确认的覆盖跟着一起撤。
          if (showImport) setPendingOverwrite(null)
          setShowImport((open) => !open)
        }}>
        {t('tts.engines.importToggle')}
      </button>
      <button type="button" className="novel-btn sm" aria-expanded={showExport}
        disabled={!ready}
        onClick={() => { setShowExport((open) => !open) }}>
        {t('tts.engines.export')}
      </button>
    </>
  )

  const panels = (
    <>
      {showImport ? (
        <div className="novel-tts-import">
          <div className="novel-tts-edit-field">
            <label htmlFor={pasteId}>{t('tts.engines.import.pasteLabel')}</label>
            <textarea
              id={pasteId} className="novel-textarea" rows={4} disabled={disabled}
              value={pasteJson} onChange={(event) => {
                setPasteJson(event.target.value)
                // 原文一改，上一条确认就对应的不是这份内容了：撤掉，重新判。
                setPendingOverwrite(null)
              }}
            />
          </div>
          {pendingOverwrite === null ? (
            <div>
              <button type="button" className="novel-btn sm primary"
                disabled={importing || disabled || !ready || pasteJson.trim() === ''} onClick={importFromJson}>
                {importing ? t('tts.engines.importing') : t('tts.engines.importJson')}
              </button>
            </div>
          ) : (
            <div className="novel-tts-receipt has-failed" role="alert">
              <strong>{t('tts.engines.import.overwrite', { n: pendingOverwrite.ids.length })}</strong>
              <div>
                <button type="button" className="novel-btn sm danger solid" disabled={importing}
                  onClick={confirmOverwrite}>
                  {importing ? t('tts.engines.importing') : t('tts.engines.import.overwriteConfirm')}
                </button>
                <button type="button" className="novel-btn sm" disabled={importing}
                  onClick={() => { setPendingOverwrite(null) }}>
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          )}
          <div className="novel-tts-edit-field">
            <label htmlFor={urlId}>{t('tts.engines.import.urlLabel')}</label>
            <div className="novel-tts-import-url">
              <input
                id={urlId} className="novel-input" type="url" disabled={disabled}
                placeholder={t('tts.engines.import.urlPlaceholder')}
                value={importUrl} onChange={(event) => { setImportUrl(event.target.value) }}
              />
              <button type="button" className="novel-btn sm"
                disabled={importing || disabled || !ready || importUrl.trim() === ''} onClick={importFromUrl}>
                {importing ? t('tts.engines.importing') : t('tts.engines.importUrl')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showExport && engines !== null ? (
        <div className="novel-tts-export">
          <label htmlFor={exportId}>{t('tts.engines.export.label')}</label>
          <textarea
            id={exportId} className="novel-textarea" rows={6} readOnly
            value={exportText} onFocus={(event) => { event.currentTarget.select() }}
          />
          <p className="novel-tts-note">{t('tts.engines.export.note')}</p>
        </div>
      ) : null}

      {receipt === null ? null : (
        <div className={receipt.failed.length > 0 ? 'novel-tts-receipt has-failed' : 'novel-tts-receipt'}
          role="status">
          <strong>{t('tts.engines.receipt.title')}</strong>
          <span>{t('tts.engines.receipt.added', { n: receipt.added })}</span>
          <span>{t('tts.engines.receipt.updated', { n: receipt.updated })}</span>
          {/* URL 来路没有提交前的预览：这里的「更新」就是覆盖，必须说清含义。 */}
          {receipt.updated > 0 ? <p className="novel-tts-note">{t('tts.engines.import.overwriteNote')}</p> : null}
          {receipt.failed.map((entry) => (
            <div key={entry.index} className="novel-err">
              {/* wire 契约里 `index` 是导入 JSON 数组的 0 基下标（坏条定位要能回查原文），
                  上屏的是给人读的序数：这里 +1，别把「第一条」显示成「第 0 条」。 */}
              {t('tts.engines.receipt.failed', { index: entry.index + 1, message: entry.message })}
            </div>
          ))}
        </div>
      )}

      {actionError === null ? null : <p className="novel-err novel-note-sm" role="alert">{actionError}</p>}
    </>
  )

  return { controls, panels }
}