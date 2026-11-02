import { describe, expect, it } from 'vitest'
import {
  DIALECT_MAP, EXPLORE_FALLBACK_FIELDS, EXPLORE_GATE_SUBS, EXPLORE_LEGADO_SUBS, EXPLORE_NATIVE_SUBS,
  NATIVE_MAP, NATIVE_TEXT_FIELDS, PAIR_OF, REHYDRATE_PHASE, REHYDRATE_PHASES,
  RULE_FIELDS, RULE_FIELD_SPECS, VACANT_RULE_FIELDS, WHOLE_SET_FIELD, wholeSetEnabled,
} from '../../src/services/rule-fields.js'
import type { RuleFieldsOf } from '../../src/services/rule-fields.js'
import { rawExploreFields } from '../../src/services/normalize.js'
import type { NormalizedRules } from '../../src/services/types.js'
import { must } from '../support/fixture.js'

describe('rule-field table', () => {
  it('every field appears exactly once', () => {
    const seen = new Set<string>()
    for (const spec of RULE_FIELD_SPECS) {
      expect(seen.has(spec.model), `duplicate ${spec.model}`).toBe(false)
      seen.add(spec.model)
    }
    expect(seen.size).toBe(RULE_FIELD_SPECS.length)
    expect(RULE_FIELDS).toContain('ruleBookName')
    expect(RULE_FIELDS).not.toContain('searchUrl')
  })

  it('derives the legado and Native maps from the same rows', () => {
    expect(must(DIALECT_MAP.ruleSearch, 'DIALECT_MAP.ruleSearch').name).toBe('ruleBookName')
    expect(must(NATIVE_MAP.ruleToc, 'NATIVE_MAP.ruleToc').url).toBe('ruleChapterUrl')
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

describe('rule-field table: 配对 / 整套闸 / 段序三列', () => {
  /** 测试侧名单**不派生**（派生即同义反复）：这里照抄一份期望，实现那边改一处而这里没跟才叫钉子。 */
  const PINNED_PAIRS = {
    header: 'headerRule',
    ruleDetailName: 'ruleBookName', ruleDetailAuthor: 'ruleAuthor', ruleDetailCoverUrl: 'ruleCoverUrl',
    ruleDetailIntro: 'ruleIntro', ruleDetailLastChapter: 'ruleLastChapter',
    ruleDetailKind: 'ruleKind', ruleDetailWordCount: 'ruleWordCount',
    ruleExploreList: 'ruleBookList', ruleExploreName: 'ruleBookName', ruleExploreAuthor: 'ruleAuthor',
    ruleExploreBookUrl: 'ruleBookUrl', ruleExploreCoverUrl: 'ruleCoverUrl', ruleExploreIntro: 'ruleIntro',
    ruleExploreKind: 'ruleKind', ruleExploreLastChapter: 'ruleLastChapter',
    ruleExploreWordCount: 'ruleWordCount',
  } as const satisfies Partial<Record<keyof NormalizedRules, keyof NormalizedRules>>

  it('PAIR_OF 逐键等于钉住的字面：header 一对、详情面七对、发现面九对', () => {
    expect(PAIR_OF).toEqual(PINNED_PAIRS)
  })

  it('配对不成链：每个目标都在表里，且目标行自身不再带 pairWith', () => {
    const rows = new Map<string, (typeof RULE_FIELD_SPECS)[number]>(RULE_FIELD_SPECS.map((s) => [s.model, s]))
    for (const [from, to] of Object.entries(PINNED_PAIRS) as Array<[keyof NormalizedRules, keyof NormalizedRules]>) {
      const target = rows.get(to)
      expect(target, `${from} 的配对目标 ${to} 不在表里`).toBeDefined()
      expect('pairWith' in must(target, 'target'), `${to} 自身还带 pairWith——配对成了链`).toBe(false)
    }
  })

  it('整套闸只登记一行：WHOLE_SET_FIELD 与两方言子字段名（经配对目标反推）', () => {
    const gates = RULE_FIELD_SPECS.filter((s) => 'wholeSetGate' in s)
    expect(gates.map((s) => s.model)).toEqual(['ruleExploreList'])
    expect(WHOLE_SET_FIELD).toBe('ruleExploreList')
    expect(EXPLORE_GATE_SUBS).toEqual({ legado: 'bookList', native: 'list' })
  })

  it('实现派生 == 钉住字面：发现面两方言子字段九项（经 pair 目标的方言键反推）', () => {
    expect(EXPLORE_LEGADO_SUBS).toEqual({
      bookList: 'ruleExploreList', name: 'ruleExploreName', author: 'ruleExploreAuthor',
      bookUrl: 'ruleExploreBookUrl', coverUrl: 'ruleExploreCoverUrl', intro: 'ruleExploreIntro',
      kind: 'ruleExploreKind', lastChapter: 'ruleExploreLastChapter', wordCount: 'ruleExploreWordCount',
    })
    expect(EXPLORE_NATIVE_SUBS).toEqual({
      list: 'ruleExploreList', name: 'ruleExploreName', author: 'ruleExploreAuthor',
      bookUrl: 'ruleExploreBookUrl', coverUrl: 'ruleExploreCoverUrl', intro: 'ruleExploreIntro',
      kind: 'ruleExploreKind', lastChapter: 'ruleExploreLastChapter', wordCount: 'ruleExploreWordCount',
    })
  })

  it('EXPLORE_FALLBACK_FIELDS 九键且按表行序（次序即 exploreEpoch 指纹次序，不许漂）', () => {
    expect([...EXPLORE_FALLBACK_FIELDS]).toEqual([
      'ruleBookList', 'ruleBookName', 'ruleAuthor', 'ruleBookUrl', 'ruleCoverUrl',
      'ruleIntro', 'ruleLastChapter', 'ruleKind', 'ruleWordCount',
    ])
  })

  it('段序：REHYDRATE_PHASE 是表级段号，REHYDRATE_PHASES 按段号升序', () => {
    expect(REHYDRATE_PHASE).toEqual({ always: 10, vacant: 20, conditional: 30, missing: 40 })
    expect([...REHYDRATE_PHASES]).toEqual(['always', 'vacant', 'conditional', 'missing'])
  })

  it('wholeSetEnabled：非空串才算整套启用', () => {
    expect(wholeSetEnabled('.box')).toBe(true)
    for (const v of ['', null, undefined, 42, ['x'], { a: 1 }]) {
      expect(wholeSetEnabled(v), `值 ${JSON.stringify(v)} 不应当成套`).toBe(false)
    }
  })

  it('rawExploreFields 的键集恰为 vacant 档 + 分类入口数组（派生真的被读口消费）', () => {
    const got = must(rawExploreFields({ bookSourceName: 'A', bookSourceUrl: 'https://a', ruleContent: 'x' }), 'rawExploreFields 的读口')
    expect(Object.keys(got).sort()).toEqual([...VACANT_RULE_FIELDS, 'ruleExploreKinds'].sort())
  })
})
