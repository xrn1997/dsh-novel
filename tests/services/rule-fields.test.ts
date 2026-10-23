import { describe, expect, it } from 'vitest'
import { DIALECT_MAP, NATIVE_MAP, NATIVE_TEXT_FIELDS, RULE_FIELDS, RULE_FIELD_SPECS, VACANT_RULE_FIELDS } from '../../src/services/rule-fields.js'
import type { RuleFieldsOf } from '../../src/services/rule-fields.js'
import type { NormalizedRules } from '../../src/services/types.js'

describe('rule-field table', () => {
  it('every field appears exactly once', () => {
    const seen = new Set<string>()
    for (const spec of RULE_FIELD_SPECS) {
      expect(seen.has(spec.model), `duplicate ${String(spec.model)}`).toBe(false)
      seen.add(spec.model)
    }
    expect(seen.size).toBe(RULE_FIELD_SPECS.length)
    expect(RULE_FIELDS).toContain('ruleBookName')
    expect(RULE_FIELDS).not.toContain('searchUrl')
  })

  it('derives the legado and Native maps from the same rows', () => {
    expect(DIALECT_MAP.ruleSearch.name).toBe('ruleBookName')
    expect(NATIVE_MAP.ruleToc.url).toBe('ruleChapterUrl')
    expect(NATIVE_TEXT_FIELDS).toContain('ruleBookName')
    expect(NATIVE_TEXT_FIELDS).not.toContain('ruleChapterUrl')
  })

  it('keeps the rehydrate modes distinct', () => {
    const by = new Map(RULE_FIELD_SPECS.map((s) => [s.model, s.rehydrate]))
    expect(by.get('ruleDetailInit')).toBe('always')
    expect(by.get('ruleExploreName')).toBe('vacant')
    expect(by.get('ruleKind')).toBe('missing')
    expect(by.get('header')).toBe('conditional')
  })

  it('pins the full `always` set: a new or removed always row must update this test', () => {
    // 编译期钉子：清单类型是表派生的 `always` 键集——少一档缺键、多一档多键都在这里红；
    // 运行时再对表取一次数，保证单跑 vitest（不跑 tsc）也抓得住新加的那一行。
    const pinned: Record<RuleFieldsOf<'always'>, true> = {
      ruleDetailInit: true,
      headerRule: true,
      bookUrlPattern: true,
    }
    const fromTable = RULE_FIELD_SPECS
      .filter((s) => s.rehydrate === 'always')
      .map((s) => s.model)
      .sort()
    expect(fromTable).toEqual(Object.keys(pinned).sort())
  })

  it('pins the full `vacant` set: 发现面补推读口的键集就是这一档', () => {
    // `normalize.rawExploreFields` 的返回对象由这份名单铺出（表改档 ⇒ 少填一个键，而书城整族读空、
    // `tsc` 不响）。这里的清单类型是表派生的 `vacant` 键集：多一键、少一键都当场红，运行时再对一次数。
    const pinned: Record<RuleFieldsOf<'vacant'>, true> = {
      ruleExploreUrl: true, ruleExploreList: true, ruleExploreName: true, ruleExploreAuthor: true,
      ruleExploreBookUrl: true, ruleExploreCoverUrl: true, ruleExploreIntro: true, ruleExploreKind: true,
      ruleExploreLastChapter: true, ruleExploreWordCount: true,
    }
    expect([...VACANT_RULE_FIELDS].sort()).toEqual(Object.keys(pinned).sort())
  })

  it('covers every NormalizedRules key except the array one, exactly once', () => {
    const coverage = {
      ruleBookList: true, ruleBookName: true, ruleAuthor: true, ruleBookUrl: true,
      ruleCoverUrl: true, ruleIntro: true, ruleLastChapter: true, ruleKind: true, ruleWordCount: true,
      ruleDetailName: true, ruleDetailAuthor: true, ruleDetailCoverUrl: true, ruleDetailIntro: true,
      ruleDetailLastChapter: true, ruleDetailKind: true, ruleDetailWordCount: true, ruleDetailInit: true,
      ruleTocUrl: true, ruleChapterList: true, ruleChapterName: true, ruleChapterUrl: true,
      ruleContent: true, ruleContentSubContent: true, ruleChapterIsVip: true, ruleChapterIsVolume: true,
      ruleChapterIsPay: true, ruleChapterUpdateTime: true, nextTocUrl: true, nextPageUrl: true,
      probeKeyword: true, bookUrlPattern: true, header: true, headerRule: true,
      ruleExploreUrl: true, ruleExploreList: true, ruleExploreName: true, ruleExploreAuthor: true,
      ruleExploreBookUrl: true, ruleExploreCoverUrl: true, ruleExploreIntro: true, ruleExploreKind: true,
      ruleExploreLastChapter: true, ruleExploreWordCount: true,
      searchUrl: true, exploreUrl: true, jsLib: true,
      // `loginUrl` 也是 required 的 string|null 模型键（平铺循环里读 raw 同名键）——漏了它
      // 上面那条 satisfies 当场红，故这里补上；表同样必须有一行。
      loginUrl: true,
    } satisfies Record<Exclude<keyof NormalizedRules, 'ruleExploreKinds'>, true>
    expect(Object.keys(coverage).sort()).toEqual(RULE_FIELD_SPECS.map((s) => s.model).sort())
  })
})
