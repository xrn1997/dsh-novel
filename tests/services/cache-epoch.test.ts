import { describe, expect, it } from 'vitest'
import { contentSlot, RULE_EPOCH_IMPACT, rulesEpoch } from '../../src/services/cache-epoch.js'
import type { NormalizedRules } from '../../src/services/types.js'

const NULLS: NormalizedRules = {
  searchUrl: null, exploreUrl: null, ruleBookList: null, ruleBookName: null, ruleAuthor: null,
  ruleBookUrl: null, ruleCoverUrl: null, ruleIntro: null, ruleLastChapter: null, ruleTocUrl: null,
  ruleChapterList: null, ruleChapterName: null, ruleChapterUrl: null, ruleDetailName: null,
  ruleDetailAuthor: null, ruleDetailCoverUrl: null, ruleDetailIntro: null, ruleDetailLastChapter: null,
  ruleDetailInit: null,
  ruleContent: null, nextTocUrl: null, nextPageUrl: null, header: null, loginUrl: null, jsLib: null,
  headerRule: null,
}

describe('rulesEpoch', () => {
  it('只改搜索面字段 → 目录与正文代际都不变（不过度失效）', () => {
    const a = rulesEpoch(NULLS, 'https://s.com', 'toc')
    const b = rulesEpoch({ ...NULLS, searchUrl: '/search?q={{key}}' }, 'https://s.com', 'toc')
    expect(b).toBe(a)
    // 代际含 facet 名入指纹（目录/正文两串天然不同），故与**同面**基线比，不跨面比
    expect(rulesEpoch({ ...NULLS, ruleBookName: 'tag.a@text' }, 'https://s.com', 'content'))
      .toBe(rulesEpoch(NULLS, 'https://s.com', 'content'))
  })

  it('改目录规则 → 目录代际变，且正文代际也变（正文的输入是目录的产物）', () => {
    // 章名不变、只有章节地址变了的情形（改 ruleChapterUrl）：槽位（代际+章名）里的章名那一半
    // 不会动，挡不住旧正文；只有代际跟着变才挡得住。与「槽位不含章节 url」不矛盾——那里排除的
    // 是站点侧的 url 抖动（时效 token），这里是规则侧的 url 变更。
    expect(rulesEpoch({ ...NULLS, ruleChapterUrl: 'tag.a@href' }, 'https://s.com', 'toc'))
      .not.toBe(rulesEpoch(NULLS, 'https://s.com', 'toc'))
    expect(rulesEpoch({ ...NULLS, ruleChapterUrl: 'tag.a@href' }, 'https://s.com', 'content'))
      .not.toBe(rulesEpoch(NULLS, 'https://s.com', 'content'))
  })

  it('只改正文规则 → 正文代际变、目录代际不变', () => {
    expect(rulesEpoch({ ...NULLS, ruleContent: '@css:#c@text' }, 'https://s.com', 'content'))
      .not.toBe(rulesEpoch(NULLS, 'https://s.com', 'content'))
    expect(rulesEpoch({ ...NULLS, ruleContent: '@css:#c@text' }, 'https://s.com', 'toc'))
      .toBe(rulesEpoch(NULLS, 'https://s.com', 'toc'))
  })

  it('header 键序不同不算改（同一份 header 必须同指纹）', () => {
    const h1 = { 'User-Agent': 'ua', Referer: 'https://s.com' }
    const h2 = { Referer: 'https://s.com', 'User-Agent': 'ua' }
    expect(rulesEpoch({ ...NULLS, header: h1 }, 'https://s.com', 'toc'))
      .toBe(rulesEpoch({ ...NULLS, header: h2 }, 'https://s.com', 'toc'))
  })

  it('baseUrl 入指纹：换站点即换代际', () => {
    expect(rulesEpoch(NULLS, 'https://a.com', 'toc')).not.toBe(rulesEpoch(NULLS, 'https://b.com', 'toc'))
  })

  it('逐字段翻转：每个字段只影响它声称影响的面（钉的是机器，不是行数）', () => {
    const tocBase = rulesEpoch(NULLS, 'https://s.com', 'toc')
    const contentBase = rulesEpoch(NULLS, 'https://s.com', 'content')
    for (const key of Object.keys(RULE_EPOCH_IMPACT) as Array<keyof NormalizedRules>) {
      const impact = RULE_EPOCH_IMPACT[key]
      const bumped = {
        ...NULLS,
        [key]: key === 'header' ? { 'X-A': '1' } : `${key}-value`,
      } as NormalizedRules
      // 影响面若没被 FACES_OF 接住，两个 moved 都会是 false = 静默退化成 none，这里就红。
      // 期望值写的是不变量本身：影响目录的字段必然影响正文（正文的输入是目录的产物），
      // 只影响正文的字段不影响目录，none 两边都不动。
      expect({ key, impact, moved: [
        rulesEpoch(bumped, 'https://s.com', 'toc') !== tocBase,
        rulesEpoch(bumped, 'https://s.com', 'content') !== contentBase,
      ] }).toEqual({ key, impact, moved: [
        impact === 'toc' || impact === 'both',
        impact !== 'none',
      ] })
    }
  })

  it('null 与空串不共用指纹（空串规则与缺规则在求值层行为不同）', () => {
    expect(rulesEpoch({ ...NULLS, ruleContent: '' }, 'https://s.com', 'content'))
      .not.toBe(rulesEpoch(NULLS, 'https://s.com', 'content'))
  })

  it('存量数据缺 ruleDetailInit 键（undefined）按缺省参与指纹——老 sources.json 不炸、与显式 null 同代际', () => {
    const { ruleDetailInit: _legacyOmit, ...legacy } = NULLS
    expect(rulesEpoch(legacy as NormalizedRules, 'https://s.com', 'toc'))
      .toBe(rulesEpoch(NULLS, 'https://s.com', 'toc'))
    expect(rulesEpoch(legacy as NormalizedRules, 'https://s.com', 'content'))
      .toBe(rulesEpoch(NULLS, 'https://s.com', 'content'))
  })
})

describe('contentSlot', () => {
  it('章名变 → 槽位变（章序位移不串配）；章名与代际都同 → 槽位同', () => {
    expect(contentSlot('e1', '第一章')).not.toBe(contentSlot('e1', '第二章'))
    expect(contentSlot('e1', '第一章')).toBe(contentSlot('e1', '第一章'))
    expect(contentSlot('e1', '第一章')).not.toBe(contentSlot('e2', '第一章'))
  })
})
