// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SourceList } from '../../src/client/views/SettingsSourceList.js'
import { makeDeps } from './fake-deps.js'
import { resetSourceListUi } from '../../src/client/source-list.js'
import { bodies, paramOps } from '../../src/shared/wire.js'
import type { SourcePublic } from '../../src/client/views/types.js'

/** loginUi 的 text/password/button 渲染与提交（@js 生成与 webView 行仍按矩阵 b-login-ui 记 open）。 */
const authSrc: SourcePublic = {
  id: 's1', name: '源A', baseUrl: 'https://a.com', enabled: true, groups: ['小说'],
  type: 'text', status: 'verified', importedAt: 0, hasHeader: false, hasAuth: false, authExpired: false, hasLoginUrl: false,
  loginUi: [
    { name: 'user', type: 'text', default: 'u' },
    { name: 'pass', type: 'password' },
  ],
}

const buttonSrc: SourcePublic = {
  ...authSrc,
  loginUi: [
    { name: 'user', type: 'text', default: 'u' },
    { name: '打开', type: 'button' },
  ],
}

const onlyButtonSrc: SourcePublic = {
  ...authSrc,
  loginUi: [{ name: '执行', type: 'button' }],
}

beforeEach(() => { resetSourceListUi() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('SourceAuthPane 的 loginUi 文本/密码行', () => {
  it('渲染默认值，保存时把两行原样交给 authLoginInfo（不跑 loginUrl）', async () => {
    const deps = makeDeps()
    const onChanged = vi.fn()
    const { container } = render(
      <SourceList sources={[authSrc]} job={null} onChanged={onChanged} onProbe={() => {}} onImport={() => {}} deps={deps} />,
    )
    fireEvent.click(container.querySelector('button[aria-haspopup="menu"]')!)
    fireEvent.click(screen.getByRole('menuitem', { name: /登录态/ }))

    const user = screen.getByLabelText('user') as HTMLInputElement
    const pass = screen.getByLabelText('pass') as HTMLInputElement
    expect(user.value).toBe('u')
    expect(pass.value).toBe('')
    fireEvent.change(user, { target: { value: 'alice' } })
    fireEvent.change(pass, { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: '保存登录' }))

    await waitFor(() => expect(deps.apiSend).toHaveBeenCalledTimes(1))
    expect(deps.apiSend).toHaveBeenCalledWith(
      paramOps.sourceAuth.at('s1'),
      bodies.authLoginInfo({ user: 'alice', pass: 'secret' }),
    )
    expect(deps.pushOk).toHaveBeenCalledWith('已保存登录态')
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('button 行：先保存 loginInfo，再 POST loginAction；外链 open 不关面板', async () => {
    const apiSend = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ mode: 'external', url: 'https://login.example/x' })
    const deps = makeDeps({ apiSend })
    const onChanged = vi.fn()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const { container } = render(
      <SourceList sources={[buttonSrc]} job={null} onChanged={onChanged} onProbe={() => {}} onImport={() => {}} deps={deps} />,
    )
    fireEvent.click(container.querySelector('button[aria-haspopup="menu"]')!)
    fireEvent.click(screen.getByRole('menuitem', { name: /登录态/ }))
    fireEvent.change(screen.getByLabelText('user'), { target: { value: 'alice' } })
    fireEvent.click(screen.getByRole('button', { name: '打开' }))

    await waitFor(() => expect(apiSend).toHaveBeenCalledTimes(2))
    expect(apiSend).toHaveBeenNthCalledWith(1, paramOps.sourceAuth.at('s1'), bodies.authLoginInfo({ user: 'alice' }))
    expect(apiSend).toHaveBeenNthCalledWith(2, paramOps.sourceAuth.at('s1'), bodies.loginAction('打开'))
    expect(open).toHaveBeenCalledWith('https://login.example/x', '_blank', 'noopener,noreferrer')
    expect(deps.pushOk).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('button 行：没有表单字段时跳过保存；脚本动作成功 → 回执并刷新', async () => {
    const apiSend = vi.fn().mockResolvedValueOnce({ mode: 'script' })
    const deps = makeDeps({ apiSend })
    const onChanged = vi.fn()
    const { container } = render(
      <SourceList sources={[onlyButtonSrc]} job={null} onChanged={onChanged} onProbe={() => {}} onImport={() => {}} deps={deps} />,
    )
    fireEvent.click(container.querySelector('button[aria-haspopup="menu"]')!)
    fireEvent.click(screen.getByRole('menuitem', { name: /登录态/ }))
    expect(screen.queryByRole('button', { name: '保存登录' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '执行' }))

    await waitFor(() => expect(apiSend).toHaveBeenCalledTimes(1))
    expect(apiSend).toHaveBeenCalledWith(paramOps.sourceAuth.at('s1'), bodies.loginAction('执行'))
    await waitFor(() => expect(deps.pushOk).toHaveBeenCalledWith('按钮动作已执行'))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })
})
