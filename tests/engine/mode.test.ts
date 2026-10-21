import { describe, expect, it } from 'vitest'
import { isJsonRule } from '../../src/engine/mode.js'

describe('isJsonRule', () => {
  it('JSON content / 整条 JSON 形态 → true', () => {
    expect(isJsonRule('data[*]', { json: { data: [] } })).toBe(true)
    expect(isJsonRule('data[*]', { html: '  {"data":[]}' })).toBe(true)
    expect(isJsonRule('data[*]', { html: '[1,2]' })).toBe(true)
    expect(isJsonRule('$.data', { html: '<div/>' })).toBe(true)
    expect(isJsonRule('$[0]', { html: '<div/>' })).toBe(true)
  })

  it('显式段前缀 / 模板 / 链段 / URL → false（前缀归 parse.classifySegment）', () => {
    expect(isJsonRule('@json:$.data[*]', { html: '<div/>' })).toBe(false)
    expect(isJsonRule('json:$.data', { html: '<div/>' })).toBe(false)
    expect(isJsonRule('css:.item', { json: {} })).toBe(false)
    expect(isJsonRule('xpath://a', { json: {} })).toBe(false)
    expect(isJsonRule('js:1+1', { json: {} })).toBe(false)
    expect(isJsonRule('get:{x}', { json: {} })).toBe(false)
    expect(isJsonRule('put:{a:1}', { json: {} })).toBe(false)
    expect(isJsonRule('@webjs:1', { json: {} })).toBe(false)
    expect(isJsonRule('  @WEBJS:1  ', { json: {} })).toBe(false)
    expect(isJsonRule('@css:.item', { json: {} })).toBe(false)
    expect(isJsonRule('@@div@text', { json: {} })).toBe(false)
    expect(isJsonRule('@xpath://a', { json: {} })).toBe(false)
    expect(isJsonRule('@js:1+1', { json: {} })).toBe(false)
    expect(isJsonRule('<js>1</js>', { json: {} })).toBe(false)
    expect(isJsonRule('{{$.id}}', { json: {} })).toBe(false)
    expect(isJsonRule('id@get:{x}', { json: {} })).toBe(false)
    expect(isJsonRule('$.source_id@js:"x"+result', { json: {} })).toBe(false)
    expect(isJsonRule('$.id<js>1</js>', { json: {} })).toBe(false)
    expect(isJsonRule('$.rows[*]@$.t', { json: {} })).toBe(false)
    expect(isJsonRule('/books?bookId={$.bookId}', { json: {} })).toBe(false)
    expect(isJsonRule('https://x.test/{$.id}', { json: {} })).toBe(false)
  })

  it('HTML / 空上下文 → false', () => {
    expect(isJsonRule('class.item', { html: '<div class="item"></div>' })).toBe(false)
    expect(isJsonRule('class.item', {})).toBe(false)
  })
})
