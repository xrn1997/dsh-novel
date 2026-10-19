// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../../src/client/index.js'
import { NovelConfigCardView } from '../../src/client/config-page.js'
import { enTranslate, type Translate } from '../../src/client/copy/index.js'
import { fakeConfigForms, fakeCtx, fakeHost } from './fake-host.js'

/**
 * 配置页接入面：插件页（`plugins.bundle.config`）里的「运行参数」表单。
 *
 * 钉两件事：
 *
 * **接线**——旧宿主（无 configForms）时静默退让、其余座位原样；有服务时注册在包名 key 上，
 * 编辑 → 保存走「模型动作 → mutate(op, revision)」，证明页面接的是宿主表单模型而不是一张静态表。
 * 壳层分支按真容的键集钉两条：只读部署与条目不可用都在页面上真渲染，不靠旧替身的
 * `status` 字符串自说自话。
 *
 * **呈现**——行组件是本仓自绘的（宿主 `SettingsValueField` 只吃 label/hint，装不下单位与
 * 换算），所以单位、人话回读、预设档、分区与「已覆盖」这几条都无人背书，必须在这里钉住：
 * 裸字节数（`209715200`）读不出来是这一页最初的病，回读与预设是它的药。
 */

afterEach(cleanup)

/** 取某字段的人话回读 / 单位后缀：按字段名锚，不按文本锚——预设档 chip 与回读会写同一串字。 */
function readback(container: HTMLElement, name: string) {
  return container.querySelector(`[data-novel-cfg-read="${name}"]`)?.textContent ?? null
}
function unit(container: HTMLElement, name: string) {
  return container.querySelector(`[data-novel-cfg-unit="${name}"]`)?.textContent ?? null
}

function mountConfigPage(
  scope?: Record<string, unknown>,
  opts?: Parameters<typeof fakeConfigForms>[1],
  t?: Translate,
) {
  const forms = fakeConfigForms(scope ?? {}, opts)
  const h = fakeHost({ configForms: forms })
  apply(fakeCtx(h) as never)
  const reg = h.registrations.find((r) => r.name === 'plugins.bundle.config')!
  const view = render(createElement(reg.component as never, t === undefined ? {} : { t }))
  return { forms, reg, view }
}

describe('插件页配置页', () => {
  it('无 configForms：不注册 plugins.bundle.config，其他座位不变', () => {
    const h = fakeHost()
    apply(fakeCtx(h) as never)
    expect(h.registrations.some((r) => r.name === 'plugins.bundle.config')).toBe(false)
    expect(h.registrations.some((r) => r.name === 'main')).toBe(true)
    expect(h.registrations.some((r) => r.name === 'sidebar.panellist')).toBe(true)
  })

  it('有 configForms：注册 bundle.config，key 是包名，七个字段 + dataDir 说明', () => {
    const { reg } = mountConfigPage({ searchParallel: 5, proxyUrl: '' })
    expect(reg?.options.key).toBe('@xrn1997/dsh-novel')
    expect(screen.getByText('运行参数')).toBeTruthy()
    expect(screen.getByText(/dataDir/)).toBeTruthy()
    for (const label of [
      '单源搜索超时', '搜索并发源数', 'JS 沙箱预算',
      '磁盘缓存上限', '导出章间节流', '本地文件导入上限', '出站代理',
    ]) {
      expect(screen.getByLabelText(label), label).toBeTruthy()
    }
  })

  it('定位参数：问宿主取的条目 id 与 served 名单', () => {
    // 两个参数都是与宿主契约的接缝，写错即整页错位；假表单本身不区分入参，不记调用就发现不了。
    const forms = fakeConfigForms({})
    const h = fakeHost({ configForms: forms })
    apply(fakeCtx(h) as never)
    expect(forms.entryIds).toEqual(['dsh-novel'])
    expect(forms.servedNamespaces).toEqual([['dsh-novel']])
  })

  it('四个分区各自有题：七个字段不再等权排成一条纵列', () => {
    mountConfigPage()
    for (const title of ['搜索', '阅读与导出', '存储上限', '网络']) {
      expect(screen.getByText(title), title).toBeTruthy()
    }
  })

  it('单位落在框内，不再单独占一行', () => {
    const { view } = mountConfigPage()
    expect(unit(view.container, 'searchTimeoutMs')).toBe('毫秒')
    expect(unit(view.container, 'searchParallel')).toBe('个源')
    expect(unit(view.container, 'jsTimeoutMs')).toBe('毫秒')
    expect(unit(view.container, 'exportDelayMs')).toBe('毫秒')
    expect(unit(view.container, 'cacheMaxBytes')).toBe('字节')
    expect(unit(view.container, 'localImportMaxBytes')).toBe('字节')
  })

  it('裸字节数配人话回读：209715200 读得出 200 MB', () => {
    const { view } = mountConfigPage({ cacheMaxBytes: 209715200, localImportMaxBytes: 73400320 })
    expect(readback(view.container, 'cacheMaxBytes')).toBe('200 MB')
    expect(readback(view.container, 'localImportMaxBytes')).toBe('70 MB')
  })

  it('毫秒配人话回读：15000 读得出 15 秒，300 读得出 300 毫秒', () => {
    const { view } = mountConfigPage({ searchTimeoutMs: 15000, exportDelayMs: 300 })
    expect(readback(view.container, 'searchTimeoutMs')).toBe('15 秒')
    expect(readback(view.container, 'exportDelayMs')).toBe('300 毫秒')
  })

  it('点预设档写入整字节数，省掉手敲九位', async () => {
    const { forms, view } = mountConfigPage({ cacheMaxBytes: 209715200 })
    fireEvent.click(view.getByRole('button', { name: '500 MB' }))
    expect((screen.getByLabelText('磁盘缓存上限') as HTMLInputElement).value).toBe('524288000')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await Promise.resolve()
    expect(forms.get('dsh-novel').mutate).toHaveBeenCalledWith(
      [{ op: 'set', path: ['cacheMaxBytes'], value: 524288000 }],
      0,
    )
  })

  it('改动过的字段标出「已覆盖」', () => {
    const { view } = mountConfigPage({ searchParallel: 5 })
    expect(view.queryByText('已覆盖')).toBeNull()
    fireEvent.change(screen.getByLabelText('搜索并发源数'), { target: { value: '8' } })
    expect(screen.getByText('已覆盖')).toBeTruthy()
  })

  it('已覆盖的字段一键恢复默认：发 unset，不把缺省值抄回去', async () => {
    // user 层有值才算「已覆盖」——这也是真实宿主上「恢复默认」会发 unset 的前提。
    const { forms, view } = mountConfigPage({ searchParallel: 5 }, { user: { searchParallel: 5 } })
    expect(view.getByText('已覆盖')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '恢复默认' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await Promise.resolve()
    // 恢复默认走 unset 而非「把缺省值抄回去」：出厂值的主人始终是 schema，不是这一页。
    expect(forms.get('dsh-novel').mutate).toHaveBeenCalledWith(
      [{ op: 'unset', path: ['searchParallel'] }],
      0,
    )
  })

  it('编辑并保存：mutate 收到 set 操作', async () => {
    const { forms } = mountConfigPage({ searchParallel: 5 })
    fireEvent.change(screen.getByLabelText('搜索并发源数'), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await Promise.resolve()
    expect(forms.get('dsh-novel').mutate).toHaveBeenCalledWith(
      [{ op: 'set', path: ['searchParallel'], value: 8 }],
      0,
    )
  })

  it('只读部署：文案在、字段仍在但整体禁用、保存不可点', () => {
    // 真容的 SettingsForm 只在 unavailable 时收起 children；只读只加一条提示，禁用归页面。
    mountConfigPage({ searchParallel: 5 }, { writable: false })
    expect(screen.getByText('本部署的配置为只读。')).toBeTruthy()
    const field = screen.getByLabelText('搜索并发源数') as HTMLInputElement
    expect(field.disabled).toBe(true)
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('条目不可用：显示不可用文案，表单字段不出现', () => {
    mountConfigPage({}, { status: 'unavailable' })
    expect(screen.getByText('该插件当前未加载，暂时无法配置。')).toBeTruthy()
    expect(screen.queryByLabelText('搜索并发源数')).toBeNull()
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
  })
})

describe('配置页的非法值呈现', () => {
  /** 非法态由宿主模型报上来，替身不重演 schema 校验，所以直渲呈现组件钉这一支。 */
  const ok = { text: '5', overridden: false, invalid: false }
  const state = {
    available: true, writable: true, dirty: true, invalid: true, saving: false, failed: false,
    searchTimeoutMs: ok, searchParallel: ok, jsTimeoutMs: ok,
    cacheMaxBytes: { text: 'abc', overridden: true, invalid: true },
    exportDelayMs: ok, localImportMaxBytes: ok,
    proxyUrl: { text: 'not a url!', overridden: false, invalid: true },
  }

  it('非法字段就地报原文、标 aria-invalid，且不因非法而丢草稿', () => {
    const actions = { save: () => {}, discard: () => {}, edit: () => {}, resetField: () => {} }
    render(createElement(NovelConfigCardView, { state: state as never, actions: actions as never }))
    const box = screen.getByLabelText('磁盘缓存上限')
    expect(box.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('请填数字')).toBeTruthy()
    expect((box as HTMLInputElement).value).toBe('abc')
    expect(screen.getByText(/代理地址不合法/)).toBeTruthy()
  })

  it('非法值没有换算可给：回读位留空而不是编一个数', () => {
    const actions = { save: () => {}, discard: () => {}, edit: () => {}, resetField: () => {} }
    const { container } = render(
      createElement(NovelConfigCardView, { state: state as never, actions: actions as never }),
    )
    expect(readback(container, 'cacheMaxBytes')).toBeNull()
  })
})

describe('英文渲染：配置页', () => {
  it('英文：标题、字段、分区与代理说明', () => {
    mountConfigPage({ searchParallel: 5 }, undefined, enTranslate)
    expect(screen.getByText('Runtime settings')).toBeTruthy()
    expect(screen.getByLabelText('Search timeout')).toBeTruthy()
    expect(screen.getByText('Search')).toBeTruthy()
    // 说明的主语必须是代理：原文把站点写成被填对象，会教用户往代理框里填站点 URL。
    expect(screen.getByText(/enter the proxy here explicitly/)).toBeTruthy()
  })

  it('英文：量词随框内数值变单数，中文同字', () => {
    const en = mountConfigPage({ searchParallel: 1, cacheMaxBytes: 1 }, undefined, enTranslate)
    expect(unit(en.view.container, 'searchParallel')).toBe('source')
    expect(unit(en.view.container, 'cacheMaxBytes')).toBe('byte')
    cleanup()
    const zh = mountConfigPage({ searchParallel: 1, cacheMaxBytes: 1 })
    expect(unit(zh.view.container, 'searchParallel')).toBe('个源')
  })
})
