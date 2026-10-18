// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../../src/client/index.js'
import { fakeConfigForms, fakeCtx, fakeHost } from './fake-host.js'

/**
 * 旧宿主 / 跨代混装的平台原语：原语模块在，但两个字段工厂缺席。
 *
 * 配置页的字段清单必须在能力守卫之后才建——若在模块求值期调用缺席的工厂，整个客户端半
 * （侧栏 / main / 状态层）随 import 一起炸，而不是「只少一页配置」。替身 alias 总是全量导出，
 * 表达不了这种残缺模块，所以本文件用 `vi.mock` 换掉别名解析出的那一份：只留三个表单原语。
 *
 * 本文件的 import 能跑起来本身就是断言的一半：模块图加载期没炸。
 */

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  SettingsForm: () => null,
  SettingsFormModel: class {},
  SettingsValueField: () => null,
  // 值显式 undefined，而非省略键：client bundle 是 CJS 闭合工厂，宿主模块表按属性作答，
  // 缺导出在运行时就是 undefined（调用才炸）；Vitest 的 mock 代理对「键不存在」逢读即抛，
  // 省略键会把宿主的真实语义测成另一种失败。守卫看到的仍是一次缺席的能力。
  settingsNumberField: undefined,
  settingsTextField: undefined,
}))

describe('旧宿主：原语模块缺字段工厂', () => {
  it('模块照常加载；apply 仍注册 main / sidebar.panellist，只少一页配置', () => {
    const forms = fakeConfigForms()
    const h = fakeHost({ configForms: forms })
    expect(() => apply(fakeCtx(h) as never)).not.toThrow()
    expect(h.registrations.some((r) => r.name === 'plugins.bundle.config')).toBe(false)
    expect(h.registrations.some((r) => r.name === 'main')).toBe(true)
    expect(h.registrations.some((r) => r.name === 'sidebar.panellist')).toBe(true)
    // 守卫先于一切宿主原语调用：条目问询与 served 挂载都不该发生
    expect(forms.entryIds).toEqual([])
    expect(forms.servedNamespaces).toEqual([])
  })
})
