import type { ReactNode } from 'react'
import { useState } from 'react'
import { parseCookieString } from '../../shared/cookies.js'
import { bodies, paramOps, type LoginActionReceipt, type RunLoginReceipt } from '../../shared/wire.js'
import { describeError } from '../api.js'
import { useCopy } from '../copy/index.js'
import { prodDeps } from '../deps.js'
import type { RowActionDeps } from '../deps.js'
import type { SourcePublic } from './types.js'

/** 登录表单的初值：只有 text/password 行进 loginInfo；button 行不是键。 */
function initLoginInfo(rows: NonNullable<SourcePublic['loginUi']>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of rows) if (f.type !== 'button') out[f.name] = f.default ?? ''
  return out
}

/** 登录配置：cookie 录入（输入值不进 store，直接 POST）+ 去登录。
 *  反馈全走全局状态条——成功条自动退场。
 *  `anchor` 是该行的错误锚点：与行内红边、全局条「定位 →」共用同一个选择器。 */
export function SourceAuthPane({ source, anchor, onDone, deps = prodDeps }: {
  source: SourcePublic; anchor: string; onDone: () => void; deps?: RowActionDeps
}): ReactNode {
  const t = useCopy()
  const [cookie, setCookie] = useState('')
  const [loginInfo, setLoginInfo] = useState<Record<string, string>>(() =>
    initLoginInfo(source.loginUi ?? []))
  /** 「去登录」按源是否有登录脚本分岔（`hasLoginUrl` 是服务端投影的事实，不在客户端猜分支）：
   *  ① 声明了 loginUrl：问服务端要计划——URL 形态开那个 URL，JS 形态服务端沙箱跑完存登录态，
   *     这里只报成功并刷新；② 未声明：站点的登录页就是它自己，直接开 baseUrl。 */
  const goLogin = (): void => {
    if (!source.hasLoginUrl) {
      window.open(source.baseUrl, '_blank', 'noopener,noreferrer')
      return
    }
    void deps.apiSend<RunLoginReceipt>(paramOps.sourceAuth.at(source.id), bodies.runLogin()).then((r) => {
      if ('mode' in r && r.loginUrl !== '') {
        window.open(r.loginUrl, '_blank', 'noopener,noreferrer')
        return
      }
      deps.pushOk(t('sources.auth.scriptDone'))
      onDone()
    }, (e: unknown) => deps.pushError(t('sources.auth.goFailed', { detail: describeError(e, t) }), anchor))
  }
  const save = (): void => {
    if (source.loginUi !== undefined) {
      void (async () => {
        await deps.apiSend(paramOps.sourceAuth.at(source.id), bodies.authLoginInfo(loginInfo))
        if (source.hasLoginUrl) await deps.apiSend(paramOps.sourceAuth.at(source.id), bodies.runLogin())
        deps.pushOk(t('sources.auth.saved'))
        onDone()
      })().catch((e: unknown) => deps.pushError(t('sources.auth.saveFailed', { detail: describeError(e, t) }), anchor))
      return
    }
    void deps.apiSend(paramOps.sourceAuth.at(source.id), bodies.authCookies(parseCookieString(cookie))).then(() => {
      setCookie('')                      // 输入值即刻清空
      deps.pushOk(t('sources.auth.saved'))
      onDone()
    }, (e: unknown) => deps.pushError(t('sources.auth.saveFailed', { detail: describeError(e, t) }), anchor))
  }
  /** `loginUi` 按钮行：先落当前 text/password 的 loginInfo，再按行名跑服务端动作。
   *  外链只开新页；脚本动作成功后刷新源列表（动作可能改了登录态）。 */
  const runRowAction = (name: string): void => {
    void (async () => {
      if ((source.loginUi ?? []).some((f) => f.type !== 'button')) {
        await deps.apiSend(paramOps.sourceAuth.at(source.id), bodies.authLoginInfo(loginInfo))
      }
      const r = await deps.apiSend<LoginActionReceipt>(
        paramOps.sourceAuth.at(source.id), bodies.loginAction(name),
      )
      if (r.mode === 'external') {
        window.open(r.url, '_blank', 'noopener,noreferrer')
        return
      }
      deps.pushOk(t('sources.auth.actionDone'))
      onDone()
    })().catch((e: unknown) => deps.pushError(t('sources.auth.actionFailed', { detail: describeError(e, t) }), anchor))
  }
  return (
    <span className="novel-auth-pane" onClick={(e) => e.stopPropagation()}>
      {/* 书源是任意第三方站点：显式 noopener,noreferrer 关掉新页对 DSH GUI tab 的反向
          tabnabbing（新式浏览器多已隐式 noopener，显式写是零成本保险） */}
      <button className="novel-btn sm" onClick={goLogin}>{t('sources.auth.go')}</button>
      {source.loginUi === undefined
        ? <input
            className="novel-input"
            value={cookie}
            onChange={(e) => setCookie(e.target.value)}
            placeholder={t('sources.auth.cookiePlaceholder')}
            aria-label={t('sources.auth.cookieLabel', { name: source.name })}
          />
        : source.loginUi.map((f, i) => f.type === 'button'
          ? (
              <button key={`${f.type}:${i}:${f.name}`} className="novel-btn sm" onClick={() => { runRowAction(f.name) }}>
                {f.name}
              </button>
            )
          : (
              <input
                key={`${f.type}:${i}:${f.name}`}
                className="novel-input"
                type={f.type}
                value={loginInfo[f.name] ?? ''}
                onChange={(e) => setLoginInfo((prev) => ({ ...prev, [f.name]: e.target.value }))}
                placeholder={f.name}
                aria-label={f.name}
              />
            ))}
      {/* 纯按钮源没有可保存的 loginInfo：不摆「保存登录」，否则会落一张空 auth 把 hasAuth 点亮 */}
      {(source.loginUi === undefined || source.loginUi.some((f) => f.type !== 'button')) && (
        <button className="novel-btn sm" onClick={save}>{t('sources.auth.save')}</button>
      )}
    </span>
  )
}
