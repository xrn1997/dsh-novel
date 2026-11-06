// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../../src/client/index.js'
import { enTranslate } from '../../src/client/copy/index.js'
import type { Registration } from './fake-host.js'
import { fakeCtx, fakeHost, fakeRemoteSettings, type FakeRemoteSettings } from './fake-host.js'
import { must } from '../support/fixture.js'

/**
 * 配置页接入面：插件页（`plugins.bundle.config`）里的「运行参数」表单。
 *
 * 钉两件事：
 *
 * **接线**——宿主没有远程设置面（`remote.settings`）时静默退让、其余座位原样；有设置面时注册在
 * 包名 key 上，保存 = 一次 `mutate(条目 id, ops, revision)`，恢复默认 = `unset`（撤用户层覆盖）。
 * 页面自己持有草稿与脏标记，写协议仍归宿主。
 *
 * **呈现**——行组件是本仓自绘的（每一行要带单位与人话换算），所以单位、人话回读、预设档、分区与
 * 「已覆盖」这几条都无人背书，必须在这里钉住：裸字节数（`209715200`）人眼读不出来，回读与预设档
 * 就是为了让它一眼读得出来。
 */

afterEach(cleanup)

/** 取某字段的人话回读 / 单位后缀：按字段名锚，不按文本锚——预设档 chip 与回读会写同一串字。 */
function readback(container: HTMLElement, name: string) {
  return container.querySelector(`[data-novel-cfg-read="${name}"]`)?.textContent ?? null
}
function unit(container: HTMLElement, name: string) {
  return container.querySelector(`[data-novel-cfg-unit="${name}"]`)?.textContent ?? null
}

function registration(h: ReturnType<typeof fakeHost>): Registration {
  return must(h.registrations.find((r) => r.name === 'plugins.bundle.config'), 'bundle.config 注册')
}

/** 按宿主槽位的方式挂页面：`inject` 的返回值就是组件 props。 */
async function mountConfigPage(
  settings: FakeRemoteSettings = fakeRemoteSettings(),
  t?: typeof enTranslate,
) {
  const h = fakeHost({ remoteSettings: settings })
  apply(fakeCtx(h) as never)
  const reg = registration(h)
  const props = (reg.options.inject as () => Record<string, unknown>)()
  const view = render(createElement(reg.component as never, t === undefined ? props : { ...props, t }))
  // 先等 describe 落地：加载态与三种终态（就绪 / 条目不可用 / 读失败）共用同一段初始渲染。
  await waitFor(() => expect(screen.queryByText('加载中…')).toBeNull())
  return { h, reg, view, settings }
}

describe('插件页配置页', () => {
  it('无 remote.settings：不注册 plugins.bundle.config，其他座位不变', () => {
    const h = fakeHost()
    apply(fakeCtx(h) as never)
    expect(h.registrations.some((r) => r.name === 'plugins.bundle.config')).toBe(false)
    expect(h.registrations.some((r) => r.name === 'main')).toBe(true)
    expect(h.registrations.some((r) => r.name === 'sidebar.panellist')).toBe(true)
  })

  it('有设置面：注册 bundle.config，key 是包名，七个字段 + dataDir 说明', async () => {
    const { reg } = await mountConfigPage(fakeRemoteSettings({ value: { searchParallel: 5, proxyUrl: '' } }))
    expect(reg.options.key).toBe('@xrn1997/dsh-novel')
    expect(screen.getByText(/dataDir/)).toBeTruthy()
    for (const label of [
      '单源搜索超时', '搜索并发源数', 'JS 沙箱预算',
      '磁盘缓存上限', '导出章间节流', '本地文件导入上限', '出站代理',
    ]) {
      expect(screen.getByLabelText(label), label).toBeTruthy()
    }
  })

  it('读的是本插件的条目：describe 被调用，写入带同一个条目 id', async () => {
    const settings = fakeRemoteSettings({ value: { searchParallel: 5 } })
    await mountConfigPage(settings)
    expect(settings.describeCalls).toBe(1)
    fireEvent.change(screen.getByLabelText('搜索并发源数'), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(settings.mutateCalls).toHaveLength(1))
    expect(settings.mutateCalls[0]?.ns).toBe('dsh-novel')
  })

  it('四个分区各自有题：字段按区归类，不等权排成一条纵列', async () => {
    await mountConfigPage()
    for (const title of ['搜索', '阅读与导出', '存储上限', '网络']) {
      expect(screen.getByText(title), title).toBeTruthy()
    }
  })

  it('单位落在框内，不单独占一行', async () => {
    const { view } = await mountConfigPage()
    expect(unit(view.container, 'searchTimeoutMs')).toBe('毫秒')
    expect(unit(view.container, 'searchParallel')).toBe('个源')
    expect(unit(view.container, 'jsTimeoutMs')).toBe('毫秒')
    expect(unit(view.container, 'exportDelayMs')).toBe('毫秒')
    expect(unit(view.container, 'cacheMaxBytes')).toBe('字节')
    expect(unit(view.container, 'localImportMaxBytes')).toBe('字节')
  })

  it('裸字节数配人话回读：209715200 读得出 200 MB', async () => {
    const { view } = await mountConfigPage(fakeRemoteSettings({
      value: { cacheMaxBytes: 209715200, localImportMaxBytes: 73400320 },
    }))
    expect(readback(view.container, 'cacheMaxBytes')).toBe('200 MB')
    expect(readback(view.container, 'localImportMaxBytes')).toBe('70 MB')
  })

  it('毫秒配人话回读：15000 读得出 15 秒，300 读得出 300 毫秒', async () => {
    const { view } = await mountConfigPage(fakeRemoteSettings({
      value: { searchTimeoutMs: 15000, exportDelayMs: 300 },
    }))
    expect(readback(view.container, 'searchTimeoutMs')).toBe('15 秒')
    expect(readback(view.container, 'exportDelayMs')).toBe('300 毫秒')
  })

  it('点预设档写入整字节数，省掉手敲九位', async () => {
    const { view, settings } = await mountConfigPage(fakeRemoteSettings({ value: { cacheMaxBytes: 209715200 } }))
    fireEvent.click(view.getByRole('button', { name: '500 MB' }))
    expect(screen.getByLabelText<HTMLInputElement>('磁盘缓存上限').value).toBe('524288000')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(settings.mutateCalls).toHaveLength(1))
    expect(settings.mutateCalls[0]?.ops).toEqual([
      { op: 'set', path: ['cacheMaxBytes'], value: 524288000 },
    ])
    expect(settings.mutateCalls[0]?.revision).toBe(0)
  })

  it('改动过的字段标出「已覆盖」', async () => {
    const { view } = await mountConfigPage(fakeRemoteSettings({ value: { searchParallel: 5 } }))
    expect(view.queryByText('已覆盖')).toBeNull()
    fireEvent.change(screen.getByLabelText('搜索并发源数'), { target: { value: '8' } })
    expect(screen.getByText('已覆盖')).toBeTruthy()
  })

  it('已覆盖的字段一键恢复默认：发 unset，不把缺省值抄回去', async () => {
    const { view, settings } = await mountConfigPage(fakeRemoteSettings({
      value: { searchParallel: 5 }, defaults: { searchParallel: 3 }, user: { searchParallel: 5 },
    }))
    expect(view.getByText('已覆盖')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '恢复默认' }))
    await waitFor(() => expect(settings.mutateCalls).toHaveLength(1))
    // 恢复默认走 unset 而非「把缺省值抄回去」：出厂值的主人始终是 schema，不是这一页。
    expect(settings.mutateCalls[0]?.ops).toEqual([{ op: 'unset', path: ['searchParallel'] }])
    await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('搜索并发源数').value).toBe('3'))
    expect(screen.queryByText('已覆盖')).toBeNull()
  })

  it('编辑并保存：mutate 收到 set 操作，成功后输入框回读新值', async () => {
    const { settings } = await mountConfigPage(fakeRemoteSettings({ value: { searchParallel: 5 } }))
    fireEvent.change(screen.getByLabelText('搜索并发源数'), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(settings.mutateCalls).toHaveLength(1))
    expect(settings.mutateCalls[0]?.ops).toEqual([{ op: 'set', path: ['searchParallel'], value: 8 }])
    expect(screen.getByLabelText<HTMLInputElement>('搜索并发源数').value).toBe('8')
  })

  it('多个脏字段合成一条原子写：一笔 mutate 带全部 set', async () => {
    const { settings } = await mountConfigPage(fakeRemoteSettings({
      value: { searchParallel: 5, searchTimeoutMs: 15000 },
    }))
    fireEvent.change(screen.getByLabelText('搜索并发源数'), { target: { value: '8' } })
    fireEvent.change(screen.getByLabelText('单源搜索超时'), { target: { value: '20000' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(settings.mutateCalls).toHaveLength(1))
    expect(settings.mutateCalls[0]?.ops).toEqual([
      { op: 'set', path: ['searchTimeoutMs'], value: 20000 },
      { op: 'set', path: ['searchParallel'], value: 8 },
    ])
  })

  it('只读部署：文案在、字段仍在但整体禁用、保存不可点', async () => {
    await mountConfigPage(fakeRemoteSettings({ value: { searchParallel: 5 }, writable: false }))
    expect(screen.getByText('本部署的配置为只读。')).toBeTruthy()
    const field = screen.getByLabelText<HTMLInputElement>('搜索并发源数')
    expect(field.disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存' }).disabled).toBe(true)
  })

  it('条目不可用：显示不可用文案，表单字段不出现', async () => {
    await mountConfigPage(fakeRemoteSettings({ missing: true }))
    expect(screen.getByText('该插件当前未加载，暂时无法配置。')).toBeTruthy()
    expect(screen.queryByLabelText('搜索并发源数')).toBeNull()
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
  })

  it('宿主拒绝写入：显示宿主给的理由，草稿保留供修改', async () => {
    const { settings } = await mountConfigPage(fakeRemoteSettings({
      value: { searchParallel: 5 }, mutateFailure: 'setting rejected: out of range',
    }))
    fireEvent.change(screen.getByLabelText('搜索并发源数'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText(/setting rejected: out of range/)
    expect(screen.getByText(/保存没有成功/)).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>('搜索并发源数').value).toBe('0')
    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy()
    expect(settings.mutateCalls).toHaveLength(1)
  })

  it('设置面读失败：报读失败而不是「插件未加载」，错误原文仍在', async () => {
    await mountConfigPage(fakeRemoteSettings({ describeFailure: 'settings provider not mounted' }))
    expect(screen.getByText('读取运行参数失败，设置服务暂时不可用。')).toBeTruthy()
    expect(screen.getByText('settings provider not mounted')).toBeTruthy()
  })

  it('连续保存：第二笔写带上一笔成功后的新修订号', async () => {
    const { settings } = await mountConfigPage(fakeRemoteSettings({ value: { searchParallel: 5 } }))
    fireEvent.change(screen.getByLabelText('搜索并发源数'), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(settings.mutateCalls).toHaveLength(1))
    fireEvent.change(screen.getByLabelText('搜索并发源数'), { target: { value: '9' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(settings.mutateCalls).toHaveLength(2))
    expect(settings.mutateCalls[0]?.revision).toBe(0)
    expect(settings.mutateCalls[1]?.revision).toBe(1)
  })

  it('外部改动造成冲突：保留草稿，重读修订号后再次保存成功', async () => {
    const settings = fakeRemoteSettings({ value: { searchParallel: 5 } })
    await mountConfigPage(settings)
    // 页面读完后外部写入一笔，页面手里的 revision 0 因此过期。
    await settings.mutate('dsh-novel', [{ op: 'set', path: ['searchParallel'], value: 6 }], 0)
    fireEvent.change(screen.getByLabelText('搜索并发源数'), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText(/revision changed/)
    expect(screen.getByLabelText<HTMLInputElement>('搜索并发源数').value).toBe('8')
    await waitFor(() => expect(settings.describeCalls).toBe(2))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(settings.mutateCalls).toHaveLength(3))
    expect(settings.mutateCalls[1]?.revision).toBe(0)
    expect(settings.mutateCalls[2]?.revision).toBe(1)
    await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('搜索并发源数').value).toBe('8'))
  })

  it('恢复默认失败：显示宿主理由且保留草稿', async () => {
    const settings = fakeRemoteSettings({
      value: { searchParallel: 5 },
      defaults: { searchParallel: 3 },
      user: { searchParallel: 5 },
      mutateFailure: 'setting rejected: locked',
    })
    await mountConfigPage(settings)
    fireEvent.change(screen.getByLabelText('搜索并发源数'), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }))
    await screen.findByText(/setting rejected: locked/)
    expect(screen.getByLabelText<HTMLInputElement>('搜索并发源数').value).toBe('8')
  })

  it('只有本地草稿时，恢复默认只撤草稿、不触远程', async () => {
    const settings = fakeRemoteSettings({ value: { searchParallel: 5 } })
    await mountConfigPage(settings)
    fireEvent.change(screen.getByLabelText('搜索并发源数'), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }))
    expect(settings.mutateCalls).toHaveLength(0)
    expect(screen.getByLabelText<HTMLInputElement>('搜索并发源数').value).toBe('5')
  })

  it('文本位清空：发 unset 而不是写空串', async () => {
    const settings = fakeRemoteSettings({
      value: { proxyUrl: 'http://127.0.0.1:7897' },
      user: { proxyUrl: 'http://127.0.0.1:7897' },
    })
    await mountConfigPage(settings)
    fireEvent.change(screen.getByLabelText('出站代理'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(settings.mutateCalls).toHaveLength(1))
    expect(settings.mutateCalls[0]?.ops).toEqual([{ op: 'unset', path: ['proxyUrl'] }])
  })

  it('放弃修改：草稿清空，保存回到不可点', async () => {
    const settings = fakeRemoteSettings({ value: { searchParallel: 5 } })
    await mountConfigPage(settings)
    fireEvent.change(screen.getByLabelText('搜索并发源数'), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: '放弃修改' }))
    expect(screen.getByLabelText<HTMLInputElement>('搜索并发源数').value).toBe('5')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存' }).disabled).toBe(true)
    expect(settings.mutateCalls).toHaveLength(0)
  })
})

describe('配置页的非法值呈现', () => {
  it('非法字段就地报原文、标 aria-invalid，且不因非法而丢草稿', async () => {
    const { settings } = await mountConfigPage(fakeRemoteSettings({
      value: { cacheMaxBytes: 209715200, proxyUrl: 'http://127.0.0.1:7897' },
    }))
    const numeric = screen.getByLabelText('磁盘缓存上限')
    fireEvent.change(numeric, { target: { value: 'abc' } })
    expect(numeric.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('请填数字')).toBeTruthy()
    expect((numeric as HTMLInputElement).value).toBe('abc')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存' }).disabled).toBe(true)

    const proxy = screen.getByLabelText('出站代理')
    fireEvent.change(proxy, { target: { value: 'not a url!' } })
    expect(proxy.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText(/代理地址不合法/)).toBeTruthy()
    expect(settings.mutateCalls).toHaveLength(0)
  })

  it('非法值没有换算可给：回读位留空而不是编一个数', async () => {
    const { view } = await mountConfigPage(fakeRemoteSettings({ value: { cacheMaxBytes: 209715200 } }))
    fireEvent.change(screen.getByLabelText('磁盘缓存上限'), { target: { value: 'abc' } })
    expect(readback(view.container, 'cacheMaxBytes')).toBeNull()
    // `Number('1e3')` 认得出 1000，但这一页的数字语法只认十进制整数；回读不能比判据更宽。
    fireEvent.change(screen.getByLabelText('磁盘缓存上限'), { target: { value: '1e3' } })
    expect(readback(view.container, 'cacheMaxBytes')).toBeNull()
  })
})

describe('英文渲染：配置页', () => {
  it('英文：标题、字段、分区与代理说明', async () => {
    await mountConfigPage(fakeRemoteSettings({ value: { searchParallel: 5 } }), enTranslate)
    expect(screen.getByLabelText('Search timeout')).toBeTruthy()
    expect(screen.getByText('Search')).toBeTruthy()
    // 说明的主语必须是代理：原文把站点写成被填对象，会教用户往代理框里填站点 URL。
    expect(screen.getByText(/enter the proxy here explicitly/)).toBeTruthy()
  })

  it('英文：量词随框内数值变单数，中文同字', async () => {
    const en = await mountConfigPage(fakeRemoteSettings({ value: { searchParallel: 1, cacheMaxBytes: 1 } }), enTranslate)
    expect(unit(en.view.container, 'searchParallel')).toBe('source')
    expect(unit(en.view.container, 'cacheMaxBytes')).toBe('byte')
    cleanup()
    const zh = await mountConfigPage(fakeRemoteSettings({ value: { searchParallel: 1, cacheMaxBytes: 1 } }))
    expect(unit(zh.view.container, 'searchParallel')).toBe('个源')
  })
})
