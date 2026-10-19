import { describe, expect, it, vi } from 'vitest'
import {
  COPY_NS, EN, ZH, createTranslate, enTranslate, interpolate, plural, zhTranslate,
} from '../../src/client/copy/index.js'
import { COMMON_ZH } from '../../src/client/copy/common.js'
import { NAVIGATION_ZH } from '../../src/client/copy/navigation.js'
import { SHELF_ZH } from '../../src/client/copy/shelf.js'
import { CITY_ZH } from '../../src/client/copy/city.js'
import { SEARCH_ZH } from '../../src/client/copy/search.js'
import { READER_ZH } from '../../src/client/copy/reader.js'
import { SOURCES_ZH } from '../../src/client/copy/sources.js'
import { SETTINGS_ZH } from '../../src/client/copy/settings.js'

type Dicts = { zh: Record<string, string>; en: Record<string, string> }

function fakeLocale() {
  let active: 'zh' | 'en' = 'zh'
  let dicts: Dicts | undefined
  const register = vi.fn((_ns: string, value: Dicts) => {
    dicts = value
    return () => { dicts = undefined }
  })
  const bind = vi.fn((_ns: string) => (key: string, params?: Record<string, string | number>) => {
    const template = dicts?.[active][key] ?? key
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      params?.[name] === undefined ? match : String(params[name]))
  })
  return { register, bind, setLocale: (locale: 'zh' | 'en') => { active = locale } }
}

function host(service?: ReturnType<typeof fakeLocale>) {
  const effect = vi.fn((execute: () => unknown) => execute())
  return {
    get: (name: string) => name === 'locale' ? service : undefined,
    effect,
  }
}

describe('文案字典', () => {
  it('zh / en 键集合逐字相同，en 不是空壳', () => {
    expect(Object.keys(EN).sort()).toEqual(Object.keys(ZH).sort())
    expect(enTranslate('nav.panel')).toBe('Novel')
    expect(enTranslate('common.cancel')).toBe('Cancel')
  })

  it('合成没有重复键（八个域键数之和等于 ZH 键数）', () => {
    const modules = [COMMON_ZH, NAVIGATION_ZH, SHELF_ZH, CITY_ZH, SEARCH_ZH, READER_ZH, SOURCES_ZH, SETTINGS_ZH]
    const total = modules.reduce((sum, dict) => sum + Object.keys(dict).length, 0)
    expect(Object.keys(ZH).length).toBe(total)
  })

  it('服务在：注册字典挂进 effect，t 随 active locale 切换', () => {
    const service = fakeLocale()
    const ctx = host(service)
    const t = createTranslate(ctx)
    expect(ctx.effect).toHaveBeenCalledWith(expect.any(Function), 'dsh-novel: copy dictionaries')
    expect(service.register).toHaveBeenCalledWith(COPY_NS, { zh: ZH, en: EN })
    expect(t('nav.panel')).toBe('小说')
    service.setLocale('en')
    expect(t('nav.panel')).toBe('Novel')
  })

  it('服务缺席：退回 zh，不注册', () => {
    const ctx = host()
    const t = createTranslate(ctx)
    expect(t).toBe(zhTranslate)
    expect(t('nav.panel')).toBe('小说')
    expect(ctx.effect).not.toHaveBeenCalled()
  })

  it('老宿主没有 ctx.get：退回 zh，不注册', () => {
    const effect = vi.fn((execute: () => unknown) => execute())
    const t = createTranslate({ effect })
    expect(t).toBe(zhTranslate)
    expect(t('nav.panel')).toBe('小说')
    expect(effect).not.toHaveBeenCalled()
  })

  it('服务畸形：bind 缺席或返回非函数时退回 zh，不在首帧抛', () => {
    const effect = vi.fn((execute: () => unknown) => execute())
    const missingBind = createTranslate({ get: () => ({ register: vi.fn(() => () => {}) }), effect })
    expect(missingBind).toBe(zhTranslate)
    const notFunction = createTranslate({
      get: () => ({ register: vi.fn(() => () => {}), bind: vi.fn(() => undefined) }),
      effect,
    })
    expect(notFunction).toBe(zhTranslate)
    expect(notFunction('nav.panel')).toBe('小说')
  })

  it('插值：缺参数保留占位符', () => {
    expect(interpolate('{n} 本', { n: 2 })).toBe('2 本')
    expect(interpolate('{n} 本')).toBe('{n} 本')
  })

  it('复数：n=1 走 one，其余走 other', () => {
    expect(plural(enTranslate, 1, 'count.books.one', 'count.books.other')).toBe('1 book')
    expect(plural(enTranslate, 2, 'count.books.one', 'count.books.other')).toBe('2 books')
    expect(plural(zhTranslate, 2, 'count.books.one', 'count.books.other')).toBe('2 本')
  })
})
