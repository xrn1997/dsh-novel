import type { ReactNode } from 'react'
import { useId, useState } from 'react'
import { TTS_ENGINE_TEXT_FIELDS, bodies, paramOps } from '../../shared/wire.js'
import type {
  TtsEngineInput, TtsEnginePublic, TtsEngineTextField,
} from '../../shared/wire.js'
import { apiSend, describeError } from '../api.js'
import { plural, useCopy } from '../copy/index.js'
import type { CopyKey } from '../copy/index.js'
import { Dialog } from '../views/dialog.js'

/** 文本位的标签、说明与呈现：字段集合来自 wire 的 `TTS_ENGINE_TEXT_FIELDS`（只含合成链会读的三格），
 *  这份 Record 只补「叫什么、说明什么、单行还是多行」；漏一个字段编译不过。`jsLib` 是代码、
 *  `header` 是 JSON 头表：单行 input 的值净化会吞掉换行，故这两格走多行 textarea。
 *  legado 的登录 / 限速 / cookie jar 字段本仓不支持，不摆编辑框——假控件比没有这个能力更坏。 */
const EDIT_FIELD: Record<TtsEngineTextField, { labelKey: CopyKey; hintKey: CopyKey; multiline?: boolean }> = {
  contentType: { labelKey: 'tts.engines.edit.contentType', hintKey: 'tts.engines.edit.contentTypeHint' },
  header: { labelKey: 'tts.engines.edit.header', hintKey: 'tts.engines.edit.headerHint', multiline: true },
  jsLib: { labelKey: 'tts.engines.edit.jsLib', hintKey: 'tts.engines.edit.jsLibHint', multiline: true },
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
 * 结构按「常用 / 高级 / 登录态」分三组：接口地址走多行 textarea（legado 规则常带换行）；
 * 高级组（内容类型 / 静态请求头 / JS 库）与凭据三格默认收起，组标题报已填 N 项 / 状态位。
 * 表单本体只有一个滚动容器，动作行固定在抽屉底部。
 *
 * 盘上已有登录态时组内另给「清除」：不摆就等于「登录态只能换不能删」；勾上后提交空凭据，
 * 组收起时状态位改报「保存后清除」。保存失败留在表单里显示服务端理由，不关模态。
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
  /** 两组都默认收起：常用两格之外的一切不占首屏；组标题上的「已填 N 项」保证有值不被藏掉。 */
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [authOpen, setAuthOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  /** 高级组已填几格：组收起时也让「有没有内容」可见（订阅导入就带值的条目不该被折叠藏掉）。 */
  const advancedCount = TTS_ENGINE_TEXT_FIELDS.filter((field) => textValues[field] !== '').length

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
    options: {
      multiline?: boolean; disabled?: boolean; initial?: boolean; hint?: string
    } = {}): ReactNode => (
    // key 用调用点给的字段名：这些行由 `TTS_ENGINE_TEXT_FIELDS.map` 批量产出，没有 key 就是每次重渲整列重建。
    <div key={id} className="novel-tts-edit-field">
      <label htmlFor={fieldId(id)}>{label}</label>
      {options.multiline === true ? (
        <textarea
          id={fieldId(id)} className="novel-textarea" rows={3}
          disabled={options.disabled === true}
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
      {options.hint === undefined ? null : <p className="novel-tts-note">{options.hint}</p>}
    </div>
  )

  /** 组标题（折叠开关）。`bodyId` 是组体 id 的认领口：组体只在展开时渲染，`aria-controls` 也只在
   *  展开时引用它——收起后不留悬空引用。 */
  const groupToggle = (label: string, bodyId: string, open: boolean, onToggle: () => void,
    status: string): ReactNode => (
    <button
      type="button" className="novel-tts-edit-group-toggle"
      aria-expanded={open}
      aria-controls={open ? bodyId : undefined}
      onClick={onToggle}
    >
      <svg className="novel-tts-edit-chevron" aria-hidden="true" viewBox="0 0 16 16">
        <path d="M6 4l4 4-4 4" />
      </svg>
      <span>{label}</span>
      <span className="novel-tts-edit-status">{status}</span>
    </button>
  )

  return (
    <Dialog
      variant="form"
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
        <div className="novel-tts-edit-section">{t('tts.engines.edit.basic')}</div>
        {textField('name', t('tts.engines.edit.name'), name, setName, { initial: true })}
        {textField('url', t('tts.engines.edit.url'), url, setUrl, {
          multiline: true, hint: t('tts.engines.edit.urlHint'),
        })}

        <div className="novel-tts-edit-group" data-novel-tts-edit-group="advanced">
          {groupToggle(t('tts.engines.edit.advanced'), fieldId('advanced-body'), advancedOpen,
            () => { setAdvancedOpen((open) => !open) },
            advancedCount === 0
              ? t('tts.engines.edit.advancedEmpty')
              : plural(t, advancedCount, 'tts.engines.edit.advancedCount.one', 'tts.engines.edit.advancedCount.other', { n: advancedCount }))}
          {advancedOpen ? (
            <div className="novel-tts-edit-group-body" id={fieldId('advanced-body')}>
              {TTS_ENGINE_TEXT_FIELDS.map((field) => textField(
                field,
                t(EDIT_FIELD[field].labelKey),
                textValues[field],
                (next) => { setTextField(field, next) },
                { multiline: EDIT_FIELD[field].multiline === true, hint: t(EDIT_FIELD[field].hintKey) },
              ))}
            </div>
          ) : null}
        </div>

        <div className="novel-tts-edit-group" data-novel-tts-edit-group="auth">
          {groupToggle(t('tts.engines.edit.credentials'), fieldId('auth-body'), authOpen,
            () => { setAuthOpen((open) => !open) },
            clearAuth
              ? t('tts.engines.edit.clearAuthPending')
              : t(engine.hasAuth ? 'tts.engines.auth.configured' : 'tts.engines.auth.none'))}
          {authOpen ? (
            <div className="novel-tts-edit-group-body" id={fieldId('auth-body')}>
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
            </div>
          ) : null}
        </div>
        {failure === null ? null : <p className="novel-err novel-note-sm" role="alert">{failure}</p>}
      </div>
    </Dialog>
  )
}
