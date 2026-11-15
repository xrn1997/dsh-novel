import type { ReactNode } from 'react'
import { useId, useState } from 'react'
import { TTS_ENGINE_TEXT_FIELDS, bodies, paramOps } from '../../shared/wire.js'
import type {
  TtsEngineInput, TtsEnginePublic, TtsEngineTextField,
} from '../../shared/wire.js'
import { apiSend, describeError } from '../api.js'
import { useCopy } from '../copy/index.js'
import type { CopyKey } from '../copy/index.js'
import { Dialog } from '../views/dialog.js'

/** 文本位的标签与呈现：字段集合来自 wire 的 `TTS_ENGINE_TEXT_FIELDS`（只含合成链会读的三格），
 *  这份 Record 只补「叫什么、单行还是多行」；漏一个字段编译不过。
 *  `jsLib` 是代码（`//` 注释按行生效）、`header` 是 JSON 头表：单行 input 的值净化会吞掉换行，
 *  编辑后保存就把多行代码压成一行（注释吃掉其余代码），故这两格走多行 textarea；contentType 是单值 MIME，单行即可。
 *  legado 的登录 / 限速 / cookie jar 字段本仓不支持，故不摆编辑框——假控件比没有这个能力更坏。 */
const EDIT_FIELD: Record<TtsEngineTextField, { labelKey: CopyKey; multiline?: boolean }> = {
  contentType: { labelKey: 'tts.engines.edit.contentType' },
  header: { labelKey: 'tts.engines.edit.header', multiline: true },
  jsLib: { labelKey: 'tts.engines.edit.jsLib', multiline: true },
}

/** 凭据文本框 → 对象位：空 = 保留（省略），非对象 / 非字符串值 = 表单报错，不发写口。 */
type ParsedRecord = { ok: true; value: Record<string, string> | undefined } | { ok: false }

function parseRecordText(text: string): ParsedRecord {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true, value: undefined }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false }
  const record = parsed as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string') return { ok: false }
    out[key] = value
  }
  return { ok: true, value: out }
}

/** 空串按缺席：可编辑文本位「没这条信息」不建键（与注册表 put 的整体替换语义对齐）。 */
function textOrUndefined(value: string): string | undefined {
  return value.trim() === '' ? undefined : value
}

/**
 * 编辑抽屉：只服务 http 订阅引擎。可编辑字段集 = `TtsEngineInput` 的非凭据位 + 三个凭据位；
 * 凭据位留空 = 不交 `auth`（注册表保留盘上登录态），填写才整组覆盖。
 *
 * 盘上已有登录态时另给一条「清除」：投影读不回凭据，不摆这个入口就等于「登录态只能换不能删」。
 * 勾上后提交 `auth: { cookies: {} }`（空凭据 = 删 auth 那一条由服务端认），本次填写的凭据不生效。
 *
 * 保存失败留在表单里显示服务端理由，不关模态。
 */
export function EngineEditDialog({ engine, onClose, onSaved }: {
  engine: TtsEnginePublic
  onClose: () => void
  onSaved: (saved: TtsEnginePublic) => void
}): ReactNode {
  const t = useCopy()
  const base = useId()
  const [name, setName] = useState(engine.name)
  const [url, setUrl] = useState(engine.url)
  const [textValues, setTextValues] = useState<Record<TtsEngineTextField, string>>(() => {
    const out = {} as Record<TtsEngineTextField, string>
    for (const field of TTS_ENGINE_TEXT_FIELDS) out[field] = engine[field] ?? ''
    return out
  })
  // 凭据投影读不回来：三格恒从空开始，占位语义就是「留空 = 保留」。
  const [cookies, setCookies] = useState('')
  const [headers, setHeaders] = useState('')
  const [loginInfo, setLoginInfo] = useState('')
  /** 清除盘上登录态：不是「填一组新凭据」，而是一次显式的删除意图。 */
  const [clearAuth, setClearAuth] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const fieldId = (nameOfField: string): string => `${base}-${nameOfField}`
  const setTextField = (field: TtsEngineTextField, value: string): void => {
    setTextValues((current) => ({ ...current, [field]: value }))
  }

  const save = (): void => {
    if (saving) return
    const trimmedName = name.trim()
    const trimmedUrl = url.trim()
    if (trimmedName === '' || trimmedUrl === '') {
      setFailure(t('tts.engines.edit.required'))
      return
    }
    let auth: TtsEngineInput['auth']
    if (clearAuth) {
      // 空凭据组 = 删掉盘上那一份（服务端按「空凭据 = 删 auth」落位）；文本框此时是禁用的。
      auth = { cookies: {} }
    } else {
      const cookieValue = parseRecordText(cookies)
      if (!cookieValue.ok) {
        setFailure(t('tts.engines.edit.badJson', { field: t('tts.engines.edit.cookies') }))
        return
      }
      const headerValue = parseRecordText(headers)
      if (!headerValue.ok) {
        setFailure(t('tts.engines.edit.badJson', { field: t('tts.engines.edit.headers') }))
        return
      }
      const loginInfoValue = parseRecordText(loginInfo)
      if (!loginInfoValue.ok) {
        setFailure(t('tts.engines.edit.badJson', { field: t('tts.engines.edit.loginInfo') }))
        return
      }
      if (cookieValue.value === undefined
        && (headerValue.value !== undefined || loginInfoValue.value !== undefined)) {
        setFailure(t('tts.engines.edit.cookiesRequired'))
        return
      }
      auth = cookieValue.value === undefined
        ? undefined
        : {
          cookies: cookieValue.value,
          ...(headerValue.value === undefined ? {} : { headers: headerValue.value }),
          ...(loginInfoValue.value === undefined ? {} : { loginInfo: loginInfoValue.value }),
        }
    }
    const textInput: Partial<Record<TtsEngineTextField, string>> = {}
    for (const field of TTS_ENGINE_TEXT_FIELDS) {
      const value = textOrUndefined(textValues[field])
      if (value !== undefined) textInput[field] = value
    }
    const input: TtsEngineInput = {
      name: trimmedName,
      url: trimmedUrl,
      ...textInput,
      ...(auth === undefined ? {} : { auth }),
    }
    setSaving(true)
    setFailure(null)
    void apiSend<TtsEnginePublic>(paramOps.ttsEnginePut.at(engine.id), bodies.ttsEnginePut(input)).then(
      (saved) => { onSaved(saved) },
      (error: unknown) => {
        setSaving(false)
        setFailure(t('tts.engines.edit.failed', { detail: describeError(error, t) }))
      },
    )
  }

  const textField = (id: string, label: string, value: string, onChange: (next: string) => void,
    options: { multiline?: boolean; disabled?: boolean; initial?: boolean } = {}): ReactNode => (
    // key 用调用点给的字段名（name / url / 三个文本位 / 三个凭据位各一）：这些行由
    // `TTS_ENGINE_TEXT_FIELDS.map` 批量产出，没有 key 就是每次重渲都整列重建（React 当场告警）。
    <div key={id} className="novel-tts-edit-field">
      <label htmlFor={fieldId(id)}>{label}</label>
      {options.multiline === true ? (
        <textarea
          id={fieldId(id)} className="novel-textarea" rows={3} disabled={options.disabled === true}
          value={value} onChange={(event) => { onChange(event.target.value) }}
        />
      ) : (
        <input
          id={fieldId(id)} className="novel-input" type="text" disabled={options.disabled === true}
          // 模态契约的入场焦点位（`views/dialog.tsx` 认这个属性）：名称是这一表单的第一格。
          {...(options.initial === true ? { 'data-dialog-initial': '' } : {})}
          value={value} onChange={(event) => { onChange(event.target.value) }}
        />
      )}
    </div>
  )

  return (
    <Dialog
      title={t('tts.engines.edit.title', { name: engine.name })}
      onClose={() => { if (!saving) onClose() }}
      actions={<>
        <button type="button" className="novel-btn sm" disabled={saving} onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="button" className="novel-btn sm primary" disabled={saving} onClick={save}>
          {saving ? t('tts.engines.edit.saving') : t('tts.engines.edit.save')}
        </button>
      </>}
    >
      <div className="novel-tts-edit-form">
        {textField('name', t('tts.engines.edit.name'), name, setName, { initial: true })}
        {textField('url', t('tts.engines.edit.url'), url, setUrl)}
        {TTS_ENGINE_TEXT_FIELDS.map((field) => textField(
          field,
          t(EDIT_FIELD[field].labelKey),
          textValues[field],
          (next) => { setTextField(field, next) },
          { multiline: EDIT_FIELD[field].multiline === true },
        ))}
        <div className="novel-tts-edit-section">{t('tts.engines.edit.credentials')}</div>
        <p className="novel-tts-note">{t('tts.engines.edit.credentialsNote')}</p>
        {textField('cookies', t('tts.engines.edit.cookies'), cookies, setCookies,
          { multiline: true, disabled: clearAuth })}
        {textField('headers', t('tts.engines.edit.headers'), headers, setHeaders,
          { multiline: true, disabled: clearAuth })}
        {textField('loginInfo', t('tts.engines.edit.loginInfo'), loginInfo, setLoginInfo,
          { multiline: true, disabled: clearAuth })}
        {engine.hasAuth ? (
          <div className="novel-tts-edit-field">
            <label htmlFor={fieldId('clearAuth')}>
              <input
                id={fieldId('clearAuth')} type="checkbox" checked={clearAuth}
                disabled={saving}
                onChange={(event) => { setClearAuth(event.target.checked) }}
              />
              {t('tts.engines.edit.clearAuth')}
            </label>
            <p className="novel-tts-note">{t('tts.engines.edit.clearAuthNote')}</p>
          </div>
        ) : null}
        {failure === null ? null : <p className="novel-err novel-note-sm" role="alert">{failure}</p>}
      </div>
    </Dialog>
  )
}