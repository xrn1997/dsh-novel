// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 每条用例都要挂载整页配置页（含引擎清单），单次 3 秒上下是常态；全量并行跑时会挤过默认的
// 5 秒上限，于是整份文件统一放宽，免得随机红。
/** jsdom 排版下该页最重的交互实测 ~16s（回车跳转那条），超时留一倍余量——不是掩盖变慢。 */
const SLOW_PAGE = 30_000
import { apply } from '../../src/client/index.js'
import { enTranslate } from '../../src/client/copy/index.js'
import { resetTtsPlayerForTests, ttsPlayer } from '../../src/client/tts/player.js'
import { resetTransient, transientEntries } from '../../src/client/transient.js'
import { BROWSER_TTS_ENGINE_ID, TTS_DEFAULTS } from '../../src/shared/wire.js'
import type { Registration } from './fake-host.js'
import { fakeCtx, fakeHost, fakeRemoteSettings, fiberCleanupOf, type FakeRemoteSettings } from './fake-host.js'
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

afterEach(() => {
  cleanup()
  resetTransient()
})

/** 取某字段的人话回读 / 单位后缀：按字段名锚，不按文本锚——预设档 chip 与回读会写同一串字。 */
function readback(container: HTMLElement, name: string) {
  return container.querySelector(`[data-novel-cfg-read="${name}"]`)?.textContent ?? null
}
function unit(container: HTMLElement, name: string) {
  return container.querySelector(`[data-novel-cfg-unit="${name}"]`)?.textContent ?? null
}
/** 「已覆盖」现在是标签旁的空心点（不占标签宽度），按字段名锚。 */
function overridden(container: HTMLElement, name: string): boolean {
  return container.querySelector(`[data-novel-cfg-overridden="${name}"]`) !== null
}
/** 预设收在框内下拉里：先点这一格的预设钮，再点人话档位。 */
function pickPreset(view: { container: HTMLElement }, name: string, option: string): void {
  const row = must(view.container.querySelector<HTMLElement>(`[data-novel-cfg-row="${name}"]`), `字段行 ${name}`)
  fireEvent.click(within(row).getByRole('button', { name: /选择预设/ }))
  fireEvent.click(within(row).getByRole('menuitem', { name: option }))
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

describe('插件页配置页', { timeout: SLOW_PAGE }, () => {
  it('无 remote.settings：不注册 plugins.bundle.config，其他座位不变', () => {
    const h = fakeHost()
    apply(fakeCtx(h) as never)
    expect(h.registrations.some((r) => r.name === 'plugins.bundle.config')).toBe(false)
    expect(h.registrations.some((r) => r.name === 'main')).toBe(true)
    expect(h.registrations.some((r) => r.name === 'sidebar.panellist')).toBe(true)
  })

  it('有设置面：注册 bundle.config，key 是包名，十二个字段 + dataDir 说明', async () => {
    const { reg } = await mountConfigPage(fakeRemoteSettings({ value: { searchParallel: 5, proxyUrl: '' } }))
    expect(reg.options.key).toBe('@xrn1997/dsh-novel')
    expect(screen.getByText(/dataDir/)).toBeTruthy()
    for (const label of [
      '单源搜索超时', '搜索并发源数', 'JS 沙箱预算',
      '磁盘缓存上限', '导出章间节流', '本地文件导入上限', '出站代理',
      '默认朗读引擎', '默认语速', '默认音量', '朗读音频缓存上限', '朗读预取段数',
    ]) {
      expect(screen.getByLabelText(label), label).toBeTruthy()
    }
  })

  it('读的是本插件的条目：describe 被调用，写入带同一个条目 id', async () => {
    const settings = fakeRemoteSettings({ value: { searchParallel: 5 } })
    await mountConfigPage(settings)
    // 两发：播放层的听书缺省快照（apply 时读一次）+ 页面自己的编目
    expect(settings.describeCalls).toBe(2)
    fireEvent.change(screen.getByLabelText('搜索并发源数'), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(settings.mutateCalls).toHaveLength(1))
    expect(settings.mutateCalls[0]?.ns).toBe('dsh-novel')
  })

  it('五个分区各自有题：字段按区归类，不等权排成一条纵列', async () => {
    await mountConfigPage()
    for (const title of ['搜索', '阅读与导出', '存储上限', '网络', '听书']) {
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
    pickPreset(view, 'cacheMaxBytes', '500 MB')
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
    expect(overridden(view.container, 'searchParallel')).toBe(false)
    fireEvent.change(screen.getByLabelText('搜索并发源数'), { target: { value: '8' } })
    expect(overridden(view.container, 'searchParallel')).toBe(true)
  })

  it('已覆盖的字段一键恢复默认：发 unset，不把缺省值抄回去', async () => {
    const { view, settings } = await mountConfigPage(fakeRemoteSettings({
      value: { searchParallel: 5 }, defaults: { searchParallel: 3 }, user: { searchParallel: 5 },
    }))
    expect(overridden(view.container, 'searchParallel')).toBe(true)
    fireEvent.click(view.getByRole('button', { name: '恢复默认' }))
    await waitFor(() => expect(settings.mutateCalls).toHaveLength(1))
    // 恢复默认走 unset 而非「把缺省值抄回去」：出厂值的主人始终是 schema，不是这一页。
    expect(settings.mutateCalls[0]?.ops).toEqual([{ op: 'unset', path: ['searchParallel'] }])
    await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('搜索并发源数').value).toBe('3'))
    expect(overridden(view.container, 'searchParallel')).toBe(false)
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
    await waitFor(() => expect(settings.describeCalls).toBe(3))
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

describe('配置页的非法值呈现', { timeout: SLOW_PAGE }, () => {
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

describe('配置页的小数位（语速 / 音量）', { timeout: SLOW_PAGE }, () => {
  it('0.8 合法：保存写 number，不写字符串', async () => {
    const { settings } = await mountConfigPage(fakeRemoteSettings({ value: { ttsDefaultRate: 1 } }))
    const input = screen.getByLabelText<HTMLInputElement>('默认语速')
    fireEvent.change(input, { target: { value: '0.8' } })
    expect(input.getAttribute('aria-invalid')).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存' }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(settings.mutateCalls).toHaveLength(1))
    expect(settings.mutateCalls[0]?.ops).toEqual([{ op: 'set', path: ['ttsDefaultRate'], value: 0.8 }])
  })

  it('abc / 负数 / 多个小数点都拒绝：原地报错、草稿保留、保存不可点', async () => {
    const { settings } = await mountConfigPage(fakeRemoteSettings({ value: { ttsDefaultVolume: 0.8 } }))
    const input = screen.getByLabelText<HTMLInputElement>('默认音量')
    for (const bad of ['abc', '-0.5', '1.2.3']) {
      fireEvent.change(input, { target: { value: bad } })
      expect(input.getAttribute('aria-invalid'), bad).toBe('true')
      expect(input.value, bad).toBe(bad)
    }
    expect(screen.getByText('请填数字')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '保存' }).disabled).toBe(true)
    expect(settings.mutateCalls).toHaveLength(0)
  })

  it('小数位回读走一位小数：1.2 显示 1.2，整数不带小数点', async () => {
    const { view } = await mountConfigPage(fakeRemoteSettings({
      value: { ttsDefaultRate: 1.2, ttsDefaultVolume: 1 },
    }))
    expect(readback(view.container, 'ttsDefaultRate')).toBe('1.2')
    expect(readback(view.container, 'ttsDefaultVolume')).toBe('1')
  })

  it('语速预设档写小数倍率', async () => {
    const { view, settings } = await mountConfigPage(fakeRemoteSettings({ value: { ttsDefaultRate: 1 } }))
    pickPreset(view, 'ttsDefaultRate', '1.2')
    expect(screen.getByLabelText<HTMLInputElement>('默认语速').value).toBe('1.2')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(settings.mutateCalls).toHaveLength(1))
    expect(settings.mutateCalls[0]?.ops).toEqual([{ op: 'set', path: ['ttsDefaultRate'], value: 1.2 }])
  })

  it('朗读缓存上限的预设档也写整字节数', async () => {
    const { view, settings } = await mountConfigPage(fakeRemoteSettings({ value: { ttsCacheMaxBytes: 134217728 } }))
    pickPreset(view, 'ttsCacheMaxBytes', '256 MB')
    expect(screen.getByLabelText<HTMLInputElement>('朗读音频缓存上限').value).toBe('268435456')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(settings.mutateCalls).toHaveLength(1))
    expect(settings.mutateCalls[0]?.ops).toEqual([{ op: 'set', path: ['ttsCacheMaxBytes'], value: 268435456 }])
  })
})

describe('英文渲染：配置页', { timeout: SLOW_PAGE }, () => {
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

function makeSyncedConfig(initial: Record<string, unknown>) {
  let current = { ...initial }
  const listeners = new Map<string, Set<() => void>>()
  const refs = new Map<string, {
    get: () => unknown
    getSnapshot: () => unknown
    subscribe: (listener: () => void) => () => void
  }>()
  const refOf = (field: string) => {
    let ref = refs.get(field)
    if (ref === undefined) {
      ref = {
        get: () => current[field],
        getSnapshot: () => current[field],
        subscribe: (listener: () => void) => {
          let set = listeners.get(field)
          if (set === undefined) {
            set = new Set()
            listeners.set(field, set)
          }
          set.add(listener)
          return () => { set.delete(listener) }
        },
      }
      refs.set(field, ref)
    }
    return ref
  }
  const config = new Proxy({}, {
    get: (_target, prop) => (typeof prop === 'string' ? refOf(prop) : undefined),
  })
  const update = (next: Record<string, unknown>): void => {
    const prev = current
    current = { ...next }
    const changed = new Set([...Object.keys(prev), ...Object.keys(current)])
    for (const key of changed) {
      if (prev[key] !== current[key]) {
        for (const listener of listeners.get(key) ?? []) listener()
      }
    }
  }
  const listenerCount = (): number => {
    let total = 0
    for (const set of listeners.values()) total += set.size
    return total
  }
  return { config, update, listenerCount }
}

describe('接入层读听书缺省', { timeout: SLOW_PAGE }, () => {
  /** 只走接线这一发：`apply` 注入 `remote.settings` ⇒ describe 一次 ⇒ 播放层回退链换值。 */
  async function applyWithSettings(settings: FakeRemoteSettings): Promise<ReturnType<typeof fakeHost>> {
    resetTtsPlayerForTests()
    const h = fakeHost({ remoteSettings: settings })
    apply(fakeCtx(h) as never)
    await waitFor(() => expect(settings.describeCalls, '接入层没读过设置面').toBeGreaterThan(0))
    return h
  }

  it('设置面交回的听书缺省推进播放层：引擎 / 语速 / 音量与出声分支跟着换', async () => {
    await applyWithSettings(fakeRemoteSettings({
      value: { ttsDefaultEngine: BROWSER_TTS_ENGINE_ID, ttsDefaultRate: 1.4, ttsDefaultVolume: 0.3 },
    }))
    expect(ttsPlayer.get()).toMatchObject({
      engineId: BROWSER_TTS_ENGINE_ID, rate: 1.4, volume: 0.3, mode: 'direct',
    })
  })

  it('读失败：播放层保持 wire 缺省，其余座位照常注册', async () => {
    const h = await applyWithSettings(fakeRemoteSettings({ describeFailure: '设置面读不出' }))
    expect(ttsPlayer.get()).toMatchObject({
      engineId: TTS_DEFAULTS.engineId, rate: TTS_DEFAULTS.rate, volume: TTS_DEFAULTS.volume,
    })
    expect(h.registrations.some((r) => r.name === 'main')).toBe(true)
  })

  it('同步配置 ref：逐格胜设置面快照，热更实时推进播放层且卸载后退订', async () => {
    resetTtsPlayerForTests()
    const settings = fakeRemoteSettings({ value: { ttsDefaultRate: 0.7 } })
    const h = fakeHost({ remoteSettings: settings })
    const ctx = fakeCtx(h)
    const dispose = fiberCleanupOf(ctx)
    const synced = makeSyncedConfig({
      ttsDefaultEngine: BROWSER_TTS_ENGINE_ID,
      ttsDefaultRate: 1.5,
      ttsDefaultVolume: 0.4,
      ttsPrefetchParagraphs: 6,
    })
    try {
      apply(ctx as never, synced.config)
      await waitFor(() => expect(settings.describeCalls, '设置面快照照旧读一发').toBeGreaterThan(0))
      // 生效值逐格由链子裁决：live ref 在场的格胜过设置面快照的 0.7
      expect(ttsPlayer.get()).toMatchObject({
        engineId: BROWSER_TTS_ENGINE_ID, rate: 1.5, volume: 0.4, mode: 'direct',
      })

      synced.update({
        ttsDefaultEngine: 'http:live',
        ttsDefaultRate: 1.9,
        ttsDefaultVolume: 0.9,
        ttsPrefetchParagraphs: 3,
      })
      expect(ttsPlayer.get()).toMatchObject({
        engineId: 'http:live', rate: 1.9, volume: 0.9, mode: 'bytes',
      })
    } finally {
      dispose()
    }
    expect(synced.listenerCount(), '卸载后同步配置 ref 监听未退订').toBe(0)
    const afterDispose = ttsPlayer.get().rate
    synced.update({ ttsDefaultRate: 0.5 })
    expect(ttsPlayer.get().rate, '卸载后外部再改同步配置不应再写播放层').toBe(afterDispose)
  })

  it('同步配置初值为空：回退 remote.settings.describe() 补首屏快照，后续同步热更仍生效', async () => {
    resetTtsPlayerForTests()
    const settings = fakeRemoteSettings({ value: { ttsDefaultRate: 1.3, ttsDefaultVolume: 0.5 } })
    const h = fakeHost({ remoteSettings: settings })
    const ctx = fakeCtx(h)
    const dispose = fiberCleanupOf(ctx)
    const synced = makeSyncedConfig({})
    try {
      apply(ctx as never, synced.config)
      await waitFor(() => expect(settings.describeCalls).toBe(1))
      await waitFor(() => expect(ttsPlayer.get()).toMatchObject({ rate: 1.3, volume: 0.5 }))

      synced.update({ ttsDefaultRate: 2.1 })
      expect(ttsPlayer.get().rate).toBe(2.1)
    } finally {
      dispose()
    }
  })

  it('配置页保存后的有效值也推进播放层：下一次起播不必等面板重载', async () => {
    resetTtsPlayerForTests()
    await mountConfigPage(fakeRemoteSettings({ value: { ttsDefaultRate: 1.6 } }))
    expect(ttsPlayer.get().rate, '页面读到的有效值先落一次').toBe(1.6)
    fireEvent.change(screen.getByLabelText('默认语速'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    // 保存回包带新的有效值：播放层当场拿到，不靠接入时那一发快照
    await waitFor(() => expect(ttsPlayer.get().rate).toBe(2), { timeout: 5_000 })
  })

  it('半到场同步配置 + 配置页保存另一格 + live ref 热更：配置页保存的格不被盖回旧值', async () => {
    resetTtsPlayerForTests()
    const settings = fakeRemoteSettings({ value: { ttsDefaultEngine: TTS_DEFAULTS.engineId, ttsDefaultRate: 1.2 } })
    const h = fakeHost({ remoteSettings: settings })
    const ctx = fakeCtx(h)
    const dispose = fiberCleanupOf(ctx)
    // 只有 ttsDefaultEngine 到场为同步配置（半到场），rate 归设置面快照管
    const engineControl = makeSyncedConfig({ ttsDefaultEngine: BROWSER_TTS_ENGINE_ID })
    const partialSynced: Record<string, unknown> = {
      ttsDefaultEngine: (engineControl.config as Record<string, unknown>).ttsDefaultEngine,
      ttsDefaultRate: 'not-a-ref',
    }
    try {
      apply(ctx as never, partialSynced)
      const reg = registration(h)
      const props = (reg.options.inject as () => Record<string, unknown>)()
      render(createElement(reg.component as never, props))
      await waitFor(() => expect(screen.queryByText('加载中…')).toBeNull())
      expect(ttsPlayer.get()).toMatchObject({ engineId: BROWSER_TTS_ENGINE_ID, rate: 1.2 })

      // 配置页保存默认语速为 1.9
      fireEvent.change(screen.getByLabelText('默认语速'), { target: { value: '1.9' } })
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await waitFor(() => expect(ttsPlayer.get().rate).toBe(1.9), { timeout: 5_000 })

      // 同步配置 live ref 触发热更（换引擎）：刚保存的 rate 仍由设置面快照守住，不被盖回
      engineControl.update({ ttsDefaultEngine: 'http:live' })
      expect(ttsPlayer.get()).toMatchObject({ engineId: 'http:live', rate: 1.9, mode: 'bytes' })
    } finally {
      dispose()
    }
  })

  it('首屏 describe 迟到与卸载后返回：不回滚已保存的新值，卸载后不再写入', async () => {
    resetTtsPlayerForTests()
    const inner = fakeRemoteSettings({ value: { ttsDefaultRate: 1.1 } })
    let releaseFirstDescribe = (): void => { throw new Error('首屏 describe 闸未就绪') }
    let callIndex = 0
    const gatedSettings: FakeRemoteSettings = {
      get describeCalls() { return inner.describeCalls },
      get mutateCalls() { return inner.mutateCalls },
      describe: async () => {
        callIndex += 1
        const currentCall = callIndex
        const res = await inner.describe()
        // 第 1 发来自 pushSettingsSnapshot（首屏快照），挂起让配置页先读并保存
        if (currentCall === 1) {
          await new Promise<void>((resolve) => { releaseFirstDescribe = resolve })
        }
        return res
      },
      mutate: (ns, ops, revision) => inner.mutate(ns, ops, revision),
    }

    const h = fakeHost({ remoteSettings: gatedSettings })
    const ctx = fakeCtx(h)
    const dispose = fiberCleanupOf(ctx)
    try {
      apply(ctx as never)
      const reg = registration(h)
      const props = (reg.options.inject as () => Record<string, unknown>)()
      render(createElement(reg.component as never, props))
      await waitFor(() => expect(screen.queryByText('加载中…')).toBeNull())

      fireEvent.change(screen.getByLabelText('默认语速'), { target: { value: '2.2' } })
      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      await waitFor(() => expect(ttsPlayer.get().rate).toBe(2.2), { timeout: 5_000 })

      // 迟到的首屏旧快照（1.1）现在才返回：已被新快照取代，不得把 2.2 盖回 1.1
      releaseFirstDescribe()
      await Promise.resolve()
      await Promise.resolve()
      expect(ttsPlayer.get().rate).toBe(2.2)
    } finally {
      dispose()
    }

    // 第二段：卸载时首屏 describe 尚未回来，卸载后回来也不写值
    resetTtsPlayerForTests()
    let releaseAfterUnmount = (): void => { throw new Error('卸载 describe 闸未就绪') }
    let describeSettled = false
    const slowInner = fakeRemoteSettings({ value: { ttsDefaultRate: 1.7 } })
    const slowSettings: FakeRemoteSettings = {
      get describeCalls() { return slowInner.describeCalls },
      get mutateCalls() { return slowInner.mutateCalls },
      describe: async () => {
        await new Promise<void>((resolve) => { releaseAfterUnmount = resolve })
        try {
          return await slowInner.describe()
        } finally {
          describeSettled = true
        }
      },
      mutate: (ns, ops, revision) => slowInner.mutate(ns, ops, revision),
    }
    const h2 = fakeHost({ remoteSettings: slowSettings })
    const ctx2 = fakeCtx(h2)
    const dispose2 = fiberCleanupOf(ctx2)
    apply(ctx2 as never)
    dispose2()
    releaseAfterUnmount()
    await waitFor(() => expect(describeSettled).toBe(true))
    await Promise.resolve()
    expect(ttsPlayer.get().rate).toBe(TTS_DEFAULTS.rate)
  })
})

/** 字段行锚：按字段名读筛选后的行集合，比按文案断言稳（同一句话别处也可能出现）。 */
function rowNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-novel-cfg-row]')]
    .map((row) => row.getAttribute('data-novel-cfg-row') ?? '')
}

describe('配置页的筛选 / 分区 / 折叠', { timeout: SLOW_PAGE }, () => {
  it('搜索按名称与字段键命中：只剩命中行，其它分区整组消失', async () => {
    const { view } = await mountConfigPage()
    const box = screen.getByRole('combobox')
    fireEvent.change(box, { target: { value: '预取' } })
    expect(rowNames(view.container)).toEqual(['ttsPrefetchParagraphs'])
    // 空组整组消失：留一个空标题等于告诉用户「这一区什么都没有」
    expect(view.container.querySelectorAll('[data-novel-cfg-group]')).toHaveLength(1)
    expect(screen.queryByText('存储上限')).toBeNull()

    // 键名也进匹配面：配置表 / 日志里拿到的是键名，不是显示名
    fireEvent.change(box, { target: { value: 'ttsDefaultRate' } })
    expect(rowNames(view.container)).toEqual(['ttsDefaultRate'])
  })

  it('仅看已改：只留脏字段，再点一次复原', async () => {
    const { view } = await mountConfigPage()
    fireEvent.change(screen.getByLabelText('搜索并发源数'), { target: { value: '8' } })
    const only = screen.getByRole('button', { name: '仅看已改' })
    fireEvent.click(only)
    expect(rowNames(view.container)).toEqual(['searchParallel'])
    expect(only.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(only)
    expect(only.getAttribute('aria-pressed')).toBe('false')
    expect(rowNames(view.container)).toContain('cacheMaxBytes')
  })

  it('分区下拉选「网络」：只剩 proxyUrl 一行', async () => {
    const { view } = await mountConfigPage()
    fireEvent.click(screen.getByRole('button', { name: '按分区筛选' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /网络/ }))
    expect(rowNames(view.container)).toEqual(['proxyUrl'])
  })

  it('回车跳到命中行：聚焦那一格，并撤下分区与仅看已改', async () => {
    // jsdom 没实现 scrollIntoView：显式 stub，别让「跳转」在无事发生的环境里蒙混过关
    const scroll = vi.fn()
    Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
      value: scroll, configurable: true,
    })
    const { view } = await mountConfigPage()
    fireEvent.change(screen.getByLabelText('单源搜索超时'), { target: { value: '20000' } })
    fireEvent.click(screen.getByRole('button', { name: '仅看已改' }))
    // 分区切到目标所属的组：跳转后要复位成「全部」，否则下一次跳转还会被旧分区挡住
    const sectionButton = screen.getByRole('button', { name: '按分区筛选' })
    fireEvent.click(sectionButton)
    fireEvent.click(screen.getByRole('menuitem', { name: /搜索/ }))
    const box = screen.getByRole('combobox')
    fireEvent.change(box, { target: { value: '单源' } })

    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(document.activeElement?.id).toBe('novel-config-searchTimeoutMs'))
    expect(scroll).toHaveBeenCalled()
    // 筛选与分区都复位了：仅看已改撤下、分区回到全部
    expect(screen.getByRole('button', { name: '仅看已改' }).getAttribute('aria-pressed')).toBe('false')
    expect(sectionButton.textContent).toContain('全部')
    // 清掉搜索词：此刻没有任何筛选，全部字段行应当都在（复位不是只改了按钮上的字）
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))
    await waitFor(() => expect(rowNames(view.container)).toHaveLength(12))
  })

  it('折叠一组：字段行消失、aria-expanded 转 false；搜索期间强制展开', async () => {
    const { view } = await mountConfigPage()
    const group = must(
      view.container.querySelector<HTMLElement>('[data-novel-cfg-group="config.group.search"]'),
      '搜索组',
    )
    const head = within(group).getByRole('button', { name: '搜索' })
    expect(head.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(within(view.container).queryByLabelText('单源搜索超时')).toBeNull()
    // 筛选期间一律展开：收起的组里藏着命中行等于把结果又藏起来
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '单源' } })
    expect(screen.getByLabelText('单源搜索超时')).toBeTruthy()
  })
})

describe('配置页的快捷键与离开提示', { timeout: SLOW_PAGE }, () => {
  it('搜索框是标准 combobox：展开态、受控弹出层与键盘高亮项都有标记', async () => {
    await mountConfigPage()
    const box = screen.getByRole('combobox')
    expect(box.getAttribute('aria-expanded')).toBe('false')
    const listId = box.getAttribute('aria-controls')
    expect(listId).toBeTruthy()
    fireEvent.change(box, { target: { value: '语速' } })
    expect(box.getAttribute('aria-expanded')).toBe('true')
    const list = screen.getByRole('listbox')
    expect(list.id).toBe(listId)
    const active = box.getAttribute('aria-activedescendant')
    expect(active).toBeTruthy()
    expect(screen.getByRole('option', { name: /默认语速/ }).id).toBe(active)
  })

  it('⌘/Ctrl+K：焦点在卡内才接管，卡外不抢宿主的同名命令', async () => {
    await mountConfigPage()
    const outside = document.createElement('button')
    outside.textContent = 'host'
    document.body.appendChild(outside)
    outside.focus()
    // 卡外：默认行为没被拦、焦点没被抢
    expect(fireEvent.keyDown(document, { key: 'k', ctrlKey: true })).toBe(true)
    expect(document.activeElement).toBe(outside)
    outside.remove()

    screen.getByLabelText('搜索并发源数').focus()
    expect(fireEvent.keyDown(document, { key: 'k', ctrlKey: true })).toBe(false)
    expect(document.activeElement).toBe(screen.getByRole('combobox'))
  })

  it('⌘/Ctrl+S：条件不满足也先拦浏览器默认，只有合法且脏才真保存', async () => {
    const { settings } = await mountConfigPage()
    // 非法草稿：保存不可点，但「另存网页」也不该弹出来
    fireEvent.change(screen.getByLabelText('搜索并发源数'), { target: { value: 'abc' } })
    expect(fireEvent.keyDown(document, { key: 's', ctrlKey: true })).toBe(false)
    expect(settings.mutateCalls).toHaveLength(0)

    fireEvent.change(screen.getByLabelText('搜索并发源数'), { target: { value: '9' } })
    expect(fireEvent.keyDown(document, { key: 's', ctrlKey: true })).toBe(false)
    await waitFor(() => expect(settings.mutateCalls).toHaveLength(1))
    expect(settings.mutateCalls[0]?.ops).toEqual([{ op: 'set', path: ['searchParallel'], value: 9 }])
  })

  it('只读部署的 ⌘/Ctrl+S 同样先拦默认，且一笔都不写', async () => {
    const { settings } = await mountConfigPage(fakeRemoteSettings({ writable: false }))
    expect(fireEvent.keyDown(document, { key: 's', ctrlKey: true })).toBe(false)
    expect(settings.mutateCalls).toHaveLength(0)
  })

  it('带脏字段离开页面：瞬态层留一条「丢了几项」，静默丢弃不再发生', async () => {
    const { view } = await mountConfigPage()
    fireEvent.change(screen.getByLabelText('搜索并发源数'), { target: { value: '8' } })
    view.unmount()
    const entries = transientEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe('error')
    expect(entries[0]?.label).toContain('1 项未保存的修改')
    expect(entries[0]?.label).toContain('丢弃')
  })

  it('没有脏字段离开：不留痕', async () => {
    const { view } = await mountConfigPage()
    view.unmount()
    expect(transientEntries()).toHaveLength(0)
  })
})
