import { describe, expect, it } from 'vitest'
import { normalizeSource } from '../../src/services/normalize.js'

const realSource = {
  bookSourceName: '笔趣阁',
  bookSourceUrl: 'https://m.example.com',
  bookSourceGroup: '热门\\本地',
  enabled: false,
  header: '{"User-Agent":"UA"}',
  searchUrl: '/search?keyword={{key}}&page={{page}}',
  ruleBookList: '@css:.list@li',
  ruleBookName: 'tag.a@text',
  ruleAuthor: 'tag.span@text',
  ruleBookUrl: 'tag.a@href',
  ruleTocUrl: 'https://m.example.com/book/{{id}}/',
  ruleChapterName: 'tag.a@text',
  ruleChapterUrl: 'tag.a@href',
  ruleContent: '@css:#content@text',
  nextPageUrl: 'tag.a.next@href',
  unrelatedField: '原样保留不报错',
}

describe('normalizeSource 真实形态', () => {
  it('驼峰字段全映射，缺省补全，raw 原样保留', () => {
    const r = normalizeSource(realSource)
    expect(r.ok).toBe(true)
    expect(r.warnings).toHaveLength(0)
    expect(r.source).toMatchObject({
      name: '笔趣阁', baseUrl: 'https://m.example.com',
      enabled: false, groups: ['热门', '本地'],
    })
    expect(r.source!.rules.ruleBookList).toBe('@css:.list@li')
    expect(r.source!.rules.ruleChapterUrl).toBe('tag.a@href')
    expect(r.source!.rules.nextPageUrl).toBe('tag.a.next@href')
    expect(r.source!.rules.header).toEqual({ 'User-Agent': 'UA' })
    expect(r.source!.raw).toBe(realSource) // 引用同一对象，未 mutate
  })
  it('缺省：enabled=true、groups=[]、各规则 null', () => {
    const r = normalizeSource({ bookSourceName: 'A', bookSourceUrl: 'https://a', ruleContent: 'x' })
    expect(r.ok).toBe(true)
    expect(r.source).toMatchObject({ enabled: true, groups: [] })
    expect(r.source!.rules.searchUrl).toBeNull()
    expect(r.source!.rules.ruleBookList).toBeNull()
  })
})

describe('必填校验', () => {
  it('缺三项逐条列出', () => {
    const r = normalizeSource({})
    expect(r.ok).toBe(false)
    expect(r.missing.map((m) => m.field)).toEqual(['bookSourceName', 'bookSourceUrl', 'ruleContent'])
    expect(r.source).toBeUndefined()
  })
  it('非对象输入 ok:false 不炸', () => {
    expect(normalizeSource('nope').ok).toBe(false)
    expect(normalizeSource(null).ok).toBe(false)
  })
})

describe('warning 口径', () => {
  it('header JSON 解析失败 → warning + null，不阻塞导入', () => {
    const r = normalizeSource({ ...realSource, header: '{bad json' })
    expect(r.ok).toBe(true)
    expect(r.source!.rules.header).toBeNull()
    expect(r.warnings.some((w) => w.field === 'header')).toBe(true)
  })
  it('searchUrl 对象形态 → warning + null（v1 仅字符串模板）', () => {
    const r = normalizeSource({ ...realSource, searchUrl: { action: 'post' } })
    expect(r.ok).toBe(true)
    expect(r.source!.rules.searchUrl).toBeNull()
    expect(r.warnings.some((w) => w.field === 'searchUrl')).toBe(true)
  })
})

// legado 嵌套对象方言（阅读系 App 主流导出形态）：五个规则字段是对象不是字符串。
// 子字段拍平到模型；搜索上下文（ruleSearch）与详情上下文（ruleBookInfo）分别落位
// ——实测真实源包 541 条共有源里 508 条两上下文规则不同，混用会造垃圾标题（open item ③ 同款陷阱）。
const objectSource = {
  bookSourceName: '对象源', bookSourceUrl: 'https://o.com',
  searchUrl: 'https://o.com/s?wd={{key}}',
  ruleSearch: {
    bookList: '@css:.sl@li', name: 'tag.a@text', author: 'tag.span@text',
    bookUrl: 'tag.a@href', coverUrl: 'tag.img@src', intro: 'tag.p@text', lastChapter: 'tag.i@text',
    kind: '玄幻', wordCount: '100万字', checkKeyWord: '',
  },
  ruleBookInfo: {
    name: 'tag.h1@text', author: 'tag.a.author@text', coverUrl: 'meta.cover@content',
    intro: '@css:#intro@text', lastChapter: 'tag.a.last@text', tocUrl: 'tag.a.toc@href',
    canReName: '', init: '', downloadUrls: '',
  },
  ruleToc: {
    chapterList: '@css:#chs@li', chapterName: 'tag.a@text', chapterUrl: 'tag.a@href',
    nextTocUrl: 'tag.a.next@href',
    formatJs: '', isPay: '', isVip: '', isVolume: '', preUpdateJs: '', updateTime: '',
  },
  ruleContent: {
    content: '@css:#content@textNodes', nextContentUrl: 'a.next@href', replaceRegex: '广告\\S*',
    callBackJs: 'result;', imageDecode: '', imageStyle: '', payAction: '', sourceRegex: '', subContent: '', title: '', webJs: 'result;',
  },
  ruleExplore: {
    bookList: '@css:.e@li', name: 'tag.a@text', author: '', bookUrl: 'tag.a@href',
    coverUrl: '', intro: '', kind: '', lastChapter: '', wordCount: '',
  },
}

describe('对象形态方言（legado 嵌套导出）', () => {
  it('ruleSearch 子字段 → 搜索面字段；ruleBookInfo → ruleDetail* 详情面字段', () => {
    const r = normalizeSource(objectSource)
    expect(r.ok).toBe(true)
    const rules = r.source!.rules
    expect(rules.ruleBookList).toBe('@css:.sl@li')
    expect(rules.ruleBookName).toBe('tag.a@text')
    expect(rules.ruleAuthor).toBe('tag.span@text')
    expect(rules.ruleBookUrl).toBe('tag.a@href')
    expect(rules.ruleCoverUrl).toBe('tag.img@src')
    expect(rules.ruleIntro).toBe('tag.p@text')
    expect(rules.ruleLastChapter).toBe('tag.i@text')
    // 详情面上下文独立落位——与搜索面不同（508/541 实测不同，不许互相污染）
    expect(rules.ruleDetailName).toBe('tag.h1@text')
    expect(rules.ruleDetailAuthor).toBe('tag.a.author@text')
    expect(rules.ruleDetailCoverUrl).toBe('meta.cover@content')
    expect(rules.ruleDetailIntro).toBe('@css:#intro@text')
    expect(rules.ruleDetailLastChapter).toBe('tag.a.last@text')
    expect(rules.ruleTocUrl).toBe('tag.a.toc@href')
  })
  it('ruleBookInfo.init → ruleDetailInit（详情上下文初始化规则——legado BookInfo.init 口径，2026-09 补）', () => {
    const r = normalizeSource({
      bookSourceName: 'A', bookSourceUrl: 'https://a', ruleContent: 'x',
      ruleBookInfo: { init: '$.data.bookInfo', name: '$.name' },
    })
    expect(r.ok).toBe(true)
    expect(r.source!.rules.ruleDetailInit).toBe('$.data.bookInfo')
    expect(r.source!.rules.ruleDetailName).toBe('$.name')   // 同上下文其余字段照常映射
  })
  it('ruleToc → ruleChapterList/Name/Url + nextTocUrl；ruleContent → ruleContent/nextPageUrl', () => {
    const rules = normalizeSource(objectSource).source!.rules
    expect(rules.ruleChapterList).toBe('@css:#chs@li')
    expect(rules.ruleChapterName).toBe('tag.a@text')
    expect(rules.ruleChapterUrl).toBe('tag.a@href')
    expect(rules.nextTocUrl).toBe('tag.a.next@href')
    expect(rules.ruleContent!.startsWith('@css:#content@textNodes')).toBe(true) // 净化尾见下一用例
    expect(rules.nextPageUrl).toBe('a.next@href')
  })
  it('replaceRegex → 追加 ##净化## 尾（legado 语义：匹配替换为空串）', () => {
    const rules = normalizeSource(objectSource).source!.rules
    expect(rules.ruleContent).toBe('@css:#content@textNodes##广告\\S*##')
  })
  it('平铺字段优先：平铺与对象并存时对象不覆盖平铺', () => {
    const rules = normalizeSource({
      ...objectSource,
      ruleBookName: 'flat@text', ruleChapterList: '@css:.flat@li',
    }).source!.rules
    expect(rules.ruleBookName).toBe('flat@text')
    expect(rules.ruleChapterList).toBe('@css:.flat@li')
  })
  it('ruleContent 对象缺 content 字符串 → missing ruleContent（诚实拦截，不猜）', () => {
    const r = normalizeSource({ ...objectSource, ruleContent: { nextContentUrl: 'a@href', webJs: '' } })
    expect(r.ok).toBe(false)
    expect(r.missing.map((m) => m.field)).toContain('ruleContent')
  })
  it('不支持的子字段与 ruleExplore → 聚合 warning，不阻塞导入', () => {
    const r = normalizeSource(objectSource)
    expect(r.ok).toBe(true)
    const warn = r.warnings.map((w) => w.message).join(' ')
    expect(warn).toContain('ruleContent.webJs')     // 未支持子字段点名
    expect(warn).toContain('ruleContent.callBackJs')
    expect(r.warnings.some((w) => w.field === 'ruleExplore')).toBe(true)  // v1 无 explore 面
    expect(r.warnings.some((w) => w.field === 'ruleSearch.kind')).toBe(false) // kind 被点名而非漏掉
  })
})

// Native（android-ebook 原生规则格式，legado 规则文档（android-ebook））：name/url 顶层、
// ruleSearch.list 三件套、ruleToc.list/name/url、ruleContent.nextPage/replaceRules[]、{{keyword}} 占位。
// 与 legado 字段体系不同——判别走 Native 映射，语义直通内部模型。
const nativeSource = {
  name: '笔趣阁', url: 'https://www.bqquge.com',
  headers: { 'User-Agent': 'UA' },
  searchUrl: '/so/{{keyword}}/{{page}}',
  ruleSearch: {
    list: '.item', name: '.itemtxt h3 a', author: ".itemtxt p a[href^='/zuozhe']",
    kind: '.itemtxt p span:last-child', lastChapter: '.itemtxt ul li:first-child a',
    coverUrl: 'img@src', bookUrl: '.itemtxt h3 a@href',
  },
  ruleBookInfo: {
    name: '.booktxt h1', author: ".booktxt p a[href^='/zuozhe']", coverUrl: '.bookdetail img@src',
    intro: '.des', kind: '.booktxt p:nth-child(2)', authorPrefix: '作者：',
  },
  ruleToc: { list: '#list ul li', name: 'a', url: 'a@href' },
  ruleContent: {
    content: '.con', nextPage: '.prenext span:last-child a@href',
    replaceRules: [
      { pattern: '天才一秒记住.*?地址' },
      { pattern: '请收藏本站.*?地址', replacement: '' },
      { pattern: '站名', replacement: '本书', enabled: false },
    ],
  },
  ruleFind: { url: '/{{kind}}/{{page}}', kinds: [{ title: '玄幻', url: 'xuanhuan' }] },
  ruleRank: { url: '/paihang' },
  charset: 'utf-8',
}

describe('Native 格式（android-ebook 原生规则）', () => {
  it('判别与顶层映射：name/url → bookSource*；headers → header；group → groups', () => {
    const input = { ...nativeSource, group: '小说' }
    const r = normalizeSource(input)
    expect(r.ok).toBe(true)
    expect(r.source).toMatchObject({ name: '笔趣阁', baseUrl: 'https://www.bqquge.com', groups: ['小说'] })
    expect(r.source!.rules.header).toEqual({ 'User-Agent': 'UA' })
    expect(r.source!.raw).toBe(input) // raw 原样保留（引用同一对象）
  })
  it('searchUrl {{keyword}} → {{key}} 占位符改写；{{page}} 不动', () => {
    const rules = normalizeSource(nativeSource).source!.rules
    expect(rules.searchUrl).toBe('/so/{{key}}/{{page}}')
  })
  it('三个规则对象 list 三件套 → 搜索/详情/目录面字段；取值字段补隐式 @text 终端', () => {
    const rules = normalizeSource(nativeSource).source!.rules
    expect(rules.ruleBookList).toBe('.item')                     // list 字段保持节点集，不补终端
    expect(rules.ruleBookName).toBe('.itemtxt h3 a@text')        // 裸选择器 = 取文本（Native 终端语义）
    expect(rules.ruleDetailName).toBe('.booktxt h1@text')
    expect(rules.ruleDetailCoverUrl).toBe('.bookdetail img@src') // 属性字段已有 @src，不动
    expect(rules.ruleChapterList).toBe('#list ul li')
    expect(rules.ruleChapterName).toBe('a@text')
    expect(rules.ruleChapterUrl).toBe('a@href')
  })
  it('authorPrefix → 详情面作者规则 ##^前缀## 净化尾（正则转义；@text 在链体、尾不动）', () => {
    const rules = normalizeSource(nativeSource).source!.rules
    expect(rules.ruleDetailAuthor).toBe(".booktxt p a[href^='/zuozhe']@text##^作者：##")
    // 前缀含正则元字符时转义
    const r2 = normalizeSource({
      ...nativeSource, ruleBookInfo: { ...nativeSource.ruleBookInfo, authorPrefix: '作者(a)：' },
    }).source!.rules
    expect(r2.ruleDetailAuthor).toBe(".booktxt p a[href^='/zuozhe']@text##^作者\\(a\\)：##")
  })
  it('ruleContent.nextPage → nextPageUrl；replaceRules[] → ##正则##替换## 尾（enabled:false 跳过）', () => {
    const rules = normalizeSource(nativeSource).source!.rules
    expect(rules.ruleContent).toBe('.con@text##天才一秒记住.*?地址####请收藏本站.*?地址##')
    expect(rules.nextPageUrl).toBe('.prenext span:last-child a@href') // URL 字段不补终端
  })
  it('隐式终端边界：legado 显式 @ 不重复补；|| 分支逐段补', () => {
    const rules = normalizeSource({
      name: 'A', url: 'https://a',
      ruleSearch: { name: 'tag.h1@text' },
      ruleBookInfo: { intro: '.left||.right' },
      ruleContent: { content: '@css:#c@textNodes' },
    }).source!.rules
    expect(rules.ruleBookName).toBe('tag.h1@text')            // 已有 @ → 不动
    expect(rules.ruleDetailIntro).toBe('.left@text||.right@text') // 每个 || 分支各自补
    expect(rules.ruleContent).toBe('@css:#c@textNodes')
  })
  it('ruleFind/ruleRank/kind/charset → 聚合 warning（宁吵不瞒），不阻塞导入', () => {
    const r = normalizeSource(nativeSource)
    expect(r.ok).toBe(true)
    const warn = r.warnings.map((w) => w.message).join(' ')
    expect(warn).toContain('ruleSearch.kind')
    expect(warn).toContain('ruleBookInfo.kind')
    expect(warn).toContain('ruleFind')
    expect(warn).toContain('ruleRank')
    expect(warn).toContain('charset')
  })
  it('authorPrefix 不误报 unsupported（专门逻辑已处理）', () => {
    const warn = normalizeSource(nativeSource).warnings.map((w) => w.message).join(' ')
    expect(warn).not.toContain('authorPrefix')
  })
  it('最小形态：仅 name/url/ruleContent 对象 → ok，其余规则 null', () => {
    const r = normalizeSource({ name: 'A', url: 'https://a', ruleContent: { content: '#c' } })
    expect(r.ok).toBe(true)
    expect(r.source!.rules.ruleContent).toBe('#c@text')
    expect(r.source!.rules.ruleBookList).toBeNull()
  })
  it('ruleContent 对象缺 content → missing ruleContent（与 legado 口径一致）', () => {
    const r = normalizeSource({ name: 'A', url: 'https://a', ruleContent: { nextPage: 'x@href' } })
    expect(r.ok).toBe(false)
    expect(r.missing.map((m) => m.field)).toEqual(['ruleContent'])
  })
  it('不判 Native 的边界：缺 name 或 url → 走 legado 路径报三件套缺失', () => {
    const r = normalizeSource({ name: '只有name' })
    expect(r.ok).toBe(false)
    expect(r.missing.map((m) => m.field)).toEqual(['bookSourceName', 'bookSourceUrl', 'ruleContent'])
  })
  it('两形态字段并存 → legado 优先（bookSourceName 不被 Native 抢跑）', () => {
    const r = normalizeSource({
      bookSourceName: '标准', bookSourceUrl: 'https://legado.com', ruleContent: 'x',
      name: '别名', url: 'https://native.com',
    })
    expect(r.ok).toBe(true)
    expect(r.source).toMatchObject({ name: '标准', baseUrl: 'https://legado.com' })
  })
})

describe('bookSourceType（内容形态，增补 2026-09-16）', () => {
  const base = { bookSourceName: 'A', bookSourceUrl: 'https://a', ruleContent: 'x' }
  it('缺省/0/-1 → text，零 warning', () => {
    for (const v of [undefined, 0, -1] as const) {
      const r = normalizeSource(v === undefined ? base : { ...base, bookSourceType: v })
      expect(r.ok).toBe(true)
      expect(r.source!.type).toBe('text')
      expect(r.warnings).toHaveLength(0)
    }
  })
  it('1/2/3 → audio/image/file（legado BookSourceType 真值：1=音频、2=图片、3=文件——此前映射读反），点名拒绝', () => {
    const msgOf = (v: number): string => {
      const r = normalizeSource({ ...base, bookSourceType: v })
      expect(r.ok).toBe(false)
      return r.missing.find((m) => m.field === 'bookSourceType')?.message ?? '(无)'
    }
    expect(msgOf(1)).toContain('音频')
    expect(msgOf(2)).toContain('图片')
    expect(msgOf(3)).toContain('文件')
  })
  it('非文本源即便带 ruleContent 也拒绝——不是缺不缺正文的问题，是规则体系不同', () => {
    expect(normalizeSource({ ...base, bookSourceType: 2 }).ok).toBe(false)
  })
  it('认不出的编码 → unknown 并拒绝：读不懂不等于文本（书架诊断实证）', () => {
    for (const v of [4, 7] as const) {
      const r = normalizeSource({ ...base, bookSourceType: v })
      expect(r.ok).toBe(false)
      expect(r.missing.find((m) => m.field === 'bookSourceType')?.message).toContain('未知')
    }
  })
})
describe('分组拆分 splitGroups（修复 2026-09-16：真实导出是逗号分隔）', () => {
  const groupsOf = (g: string): string[] => {
    const r = normalizeSource({ bookSourceName: 'A', bookSourceUrl: 'https://a', ruleContent: 'x', bookSourceGroup: g })
    expect(r.ok).toBe(true)
    return r.source!.groups
  }
  it('半角逗号（本库 201 源实测主流形态）逐段拆开——多组源每组独立成段', () => {
    expect(groupsOf('快速书源 ⚡,通常书源 📂')).toEqual(['快速书源 ⚡', '通常书源 📂'])
    expect(groupsOf('漫画书源 🎨,特殊书源 🔞')).toEqual(['漫画书源 🎨', '特殊书源 🔞'])
  })
  it('反斜杠（阅读 App 文档口径）与全角逗号兼容；混用亦可', () => {
    expect(groupsOf('热门\\本地')).toEqual(['热门', '本地'])
    expect(groupsOf('a，b')).toEqual(['a', 'b'])
    expect(groupsOf('a\\b,c')).toEqual(['a', 'b', 'c'])
  })
  it('trim、去空段、段内去重', () => {
    expect(groupsOf(' a , , b ')).toEqual(['a', 'b'])
    expect(groupsOf('热门,热门')).toEqual(['热门'])
  })
})
describe('名称前缀图标剥离（修复 2026-09-16）', () => {
  const nameOf = (n: string): string => {
    const r = normalizeSource({ bookSourceName: n, bookSourceUrl: 'https://a', ruleContent: 'x' })
    expect(r.ok).toBe(true)
    return r.source!.name
  }
  it('上游分组装饰前缀剥掉——图标即分组徽标，分组列已独立呈现', () => {
    expect(nameOf('⚡📂听小说APP')).toBe('听小说APP')
    expect(nameOf('🎬影视频道')).toBe('影视频道')
    expect(nameOf('  ⚡ 米读小说')).toBe('米读小说')            // 前缀段含空格一并剥
  })
  it('无前缀不动；中部/尾部图标不动（实测 0 例，保守只剥前缀）', () => {
    expect(nameOf('笔趣阁')).toBe('笔趣阁')
    expect(nameOf('五一书城📖')).toBe('五一书城📖')
  })
  it('整名都是图标 → 保留原名（宁丑不空）；【】括号不剥（名字本体装饰）', () => {
    expect(nameOf('📂⚡')).toBe('📂⚡')
    expect(nameOf('【小说】书源网')).toBe('【小说】书源网')
  })
})