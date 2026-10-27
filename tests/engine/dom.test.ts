import { describe, expect, it } from 'vitest'
import * as cheerio from 'cheerio'
import { rawTextOf } from '../../src/engine/dom.js'

describe('rawTextOf（判定用的子树文本口径）', () => {
  it('与 cheerio .text() 同口径：含脚本文本、排除注释、含全部后代', () => {
    const $ = cheerio.load('<div id="r">甲<script>var x="乙"</script><span>丙</span><p>丁<b>戊</b></p><!--注释--></div>')
    const root = $('#r').get(0)!
    expect(rawTextOf(root)).toBe($('#r').text())
    expect(rawTextOf(root)).toBe('甲var x="乙"丙丁戊')
  })

  it('文本节点自身与文档根都按同一口径（谓词候选里两种形状都会出现）', () => {
    const $ = cheerio.load('<div id="r">甲<b>乙</b></div>')
    const doc = $.root().get(0)!
    expect(rawTextOf(doc)).toBe($.root().text())
    const textNode = $('#r').contents().get(0)!
    expect(rawTextOf(textNode)).toBe('甲')
  })
})
