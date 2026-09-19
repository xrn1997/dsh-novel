import { beforeEach, describe, expect, it } from 'vitest'
import { parseCookieString, validateSourceJson } from '../../src/client/importer.js'
import { clearSelection, filterByGroup, filterByStatus, filterSources, groupIcon, selectMany, setEditMode, setGroupFilter, setQuery, setStatusFilter, resetSourceListUi, sourceListUi, toggleSelect, UNGROUPED } from '../../src/client/source-list.js'
import type { SourcePublic } from '../../src/client/views/types.js'

/** 登录面板输入解析（原埋在 SourceAuthPane 的 JSX 里无人能测——拆出即测） */
describe('parseCookieString', () => {
  it('a=1; b=2 形态；无 = 的段与空段跳过、不炸', () => {
    expect(parseCookieString('token=abc; sid=def')).toEqual({ token: 'abc', sid: 'def' })
    expect(parseCookieString(' a = 1 ;; junk ;x=2 ')).toEqual({ a: '1', x: '2' })
    expect(parseCookieString('')).toEqual({})
    expect(parseCookieString('=nokey; ok=1')).toEqual({ ok: '1' })
  })
  it('值里含 = 只切第一个（cookie 值可以是 base64/URL）', () => {
    expect(parseCookieString('t=a=b=c')).toEqual({ t: 'a=b=c' })
  })
})

/** 导入预检：结构可解析即可导入（服务端 normalize 是权威）；条目缺失只提示不连坐。
 * 注：文件导入不经此——原文直通服务端后台任务，无客户端合并/分批逻辑。 */
describe('validateSourceJson', () => {
  const good = '{"bookSourceName":"A","bookSourceUrl":"https://a","ruleContent":"x@text"}'
  it('平铺三必填齐全 → ok，无缺失', () => {
    const c = validateSourceJson(good)
    expect(c).toMatchObject({ ok: true, total: 1 })
    expect(c.bad).toEqual([])
  })
  it('对象形态 ruleContent（content 非空）也算合法——对象方言不误杀', () => {
    const c = validateSourceJson('{"bookSourceName":"A","bookSourceUrl":"https://a","ruleContent":{"content":"x@text"}}')
    expect(c.ok).toBe(true)
    expect(c.bad).toEqual([])
  })
  it('数组一好一坏 → ok（不连坐，按钮可用），坏条目点名缺什么', () => {
    const c = validateSourceJson(`[{"bookSourceName":"好源","bookSourceUrl":"https://a","ruleContent":"x"},${good}]`)
    expect(c).toMatchObject({ ok: true, total: 2 })
    expect(c.bad).toEqual([])
    // 真正的坏条目：缺 ruleContent
    const c2 = validateSourceJson('[{"bookSourceName":"坏源","bookSourceUrl":"https://b"},' + good + ']')
    expect(c2.ok).toBe(true)                                    // 结构可解析——不连坐
    expect(c2.bad).toEqual([{ index: 0, name: '坏源', missing: ['ruleContent'] }])
  })
  it('对象 ruleContent 缺 content 子字段 → 缺失点名 ruleContent', () => {
    const c = validateSourceJson('{"bookSourceName":"A","bookSourceUrl":"https://a","ruleContent":{"webJs":""}}')
    expect(c.ok).toBe(true)
    expect(c.bad[0]?.missing).toContain('ruleContent')
  })
  it('坏 JSON / 空文本 → ok false（按钮禁用）', () => {
    expect(validateSourceJson('not json').ok).toBe(false)
    expect(validateSourceJson('').ok).toBe(false)
    expect(validateSourceJson('[]').ok).toBe(false)             // 空数组无从导入
  })
})

/** 源列表过滤：名称/地址/分组子串命中，大小写不敏感——630 个源必须能快速定位 */
describe('filterSources', () => {
  const src = (name: string, baseUrl: string, groups: string[] = []): SourcePublic => ({
    id: name, name, baseUrl, enabled: true, groups, type: 'text', status: 'unverified',
    importedAt: 0, hasHeader: false, hasAuth: false, authExpired: false,
  })
  const list = [src('笔趣阁', 'https://m.biqu.com', ['热门']), src('SiS文学', 'https://b.sis.la', ['特殊'])]
  it('空 query → 原样全量', () => {
    expect(filterSources(list, '')).toHaveLength(2)
    expect(filterSources(list, '   ')).toHaveLength(2)
  })
  it('名称/地址/分组子串命中，大小写不敏感', () => {
    expect(filterSources(list, '笔趣').map((s) => s.id)).toEqual(['笔趣阁'])
    expect(filterSources(list, 'SIS').map((s) => s.id)).toEqual(['SiS文学'])   // 大小写
    expect(filterSources(list, 'biqu').map((s) => s.id)).toEqual(['笔趣阁'])   // 地址命中
    expect(filterSources(list, '特殊').map((s) => s.id)).toEqual(['SiS文学'])  // 分组命中
  })
  it('无命中 → 空数组', () => {
    expect(filterSources(list, '不存在')).toEqual([])
  })
})

/** 状态过滤：chips 五维单选过滤，与文本过滤交集语义 */
describe('filterByStatus', () => {
  const src = (name: string, over: Partial<SourcePublic> = {}): SourcePublic => ({
    id: name, name, baseUrl: `https://${name}.com`, enabled: true, groups: [], type: 'text', status: 'unverified',
    importedAt: 0, hasHeader: false, hasAuth: false, authExpired: false, ...over,
  })
  const list = [
    src('a', { status: 'verified' }),
    src('b', { status: 'broken' }),
    src('c'),                                              // unverified
    src('d', { status: 'verified', enabled: false }),      // 已停用（维度是 enabled 布尔）
  ]
  it('all → 原样全量', () => {
    expect(filterByStatus(list, 'all')).toHaveLength(4)
  })
  it('verified/broken/unverified 按状态过滤', () => {
    expect(filterByStatus(list, 'verified').map((s) => s.id)).toEqual(['a', 'd'])
    expect(filterByStatus(list, 'broken').map((s) => s.id)).toEqual(['b'])
    expect(filterByStatus(list, 'unverified').map((s) => s.id)).toEqual(['c'])
  })
  it('disabled 按 enabled 布尔过滤（非 status）', () => {
    expect(filterByStatus(list, 'disabled').map((s) => s.id)).toEqual(['d'])
  })
  it('与 filterSources 交集：先状态后文本', () => {
    const byStatus = filterByStatus(list, 'verified')
    expect(filterSources(byStatus, 'd').map((s) => s.id)).toEqual(['d'])
  })
})

/** 分组过滤：''=全部、精确匹配分组名；与状态/文本过滤叠加（交集） */
describe('filterByGroup', () => {
  const src = (name: string, groups: string[]): SourcePublic => ({
    id: name, name, baseUrl: `https://${name}.com`, enabled: true, groups, type: 'text', status: 'unverified',
    importedAt: 0, hasHeader: false, hasAuth: false, authExpired: false,
  })
  const list = [src('a', ['热门']), src('b', ['热门', '本地']), src('c', [])]
  it('空串 → 原样全量', () => {
    expect(filterByGroup(list, '')).toHaveLength(3)
  })
  it('精确匹配分组名（子串不算——「热」不命中「热门」）；多组源任一命中即入选', () => {
    expect(filterByGroup(list, '热门').map((s) => s.id)).toEqual(['a', 'b'])
    expect(filterByGroup(list, '热')).toEqual([])
  })
  it('无分组源被任何组过滤排除；不存在的组 → 空', () => {
    expect(filterByGroup(list, '本地').map((s) => s.id)).toEqual(['b'])
    expect(filterByGroup(list, '不存在')).toEqual([])
  })
  it('UNGROUPED 哨兵 → 只看无分组源（「未分组」伪选项：定位得到才能批量补分组）', () => {
    expect(filterByGroup(list, UNGROUPED).map((s) => s.id)).toEqual(['c'])
    expect(filterByGroup(list.slice(0, 2), UNGROUPED)).toEqual([])   // 全有分组 → 空
  })
  it('与 filterByStatus/filterSources 叠加：先状态再分组再文本', () => {
    const chain = filterSources(filterByGroup(filterByStatus(list, 'unverified'), '热门'), 'b')
    expect(chain.map((s) => s.id)).toEqual(['b'])
  })
})

/** 组名图标提取：分组列只显示图标，hover 出全名；无符号组回退全名 */
describe('groupIcon', () => {
  it('尾部装饰图标提取——图标即组的视觉身份', () => {
    expect(groupIcon('快速书源 ⚡')).toBe('⚡')
    expect(groupIcon('漫画书源 🎨')).toBe('🎨')
    expect(groupIcon('影视频源 🎬')).toBe('🎬')
  })
  it('无符号组返回 null（显示侧回退全名，不造图标）', () => {
    expect(groupIcon('小说')).toBeNull()
  })
  it('中段图标也取（宽松提取，实测数据都在尾部）', () => {
    expect(groupIcon('⚡快速')).toBe('⚡')
  })
})

/** 列表 UI store：query/chip/selection/editMode 模块级存活——试跑下钻返回不丢现场 */
describe('sourceListUi store', () => {
  beforeEach(resetSourceListUi)   // 整现场一次复位——setter 手工复位既啰嗦又漏项（groupFilter 曾被漏过）

  it('toggleSelect 进出选择集；selectMany 并集', () => {
    toggleSelect('a')
    toggleSelect('b')
    toggleSelect('a')                                       // 再点取消
    expect(sourceListUi.get().selection).toEqual(['b'])
    selectMany(['b', 'c'])
    expect(sourceListUi.get().selection).toEqual(['b', 'c']) // 并集不重复
  })
  it('退出编辑态顺带清选择（选择集只在编辑态有意义）', () => {
    setEditMode(true)
    toggleSelect('a')
    setEditMode(false)
    expect(sourceListUi.get().editMode).toBe(false)
    expect(sourceListUi.get().selection).toEqual([])
  })
  it('clearSelection：只清勾选、编辑态不动（批量动作做完的收尾——借 setEditMode(false) 清会连带退出编辑态）', () => {
    setEditMode(true)
    toggleSelect('a')
    selectMany(['b'])
    clearSelection()
    expect(sourceListUi.get().selection).toEqual([])
    expect(sourceListUi.get().editMode).toBe(true)
  })
  it('query/chip 状态跨调用存活（模块级——组件卸载不重置）', () => {
    setQuery('笔趣')
    setStatusFilter('broken')
    expect(sourceListUi.get()).toMatchObject({ query: '笔趣', statusFilter: 'broken' })
  })
  it('resetSourceListUi：五字段整现场一次复位（测试隔离专用，先例 resetTransient）', () => {
    setQuery('x'); setStatusFilter('broken'); setGroupFilter('小说'); setEditMode(true); toggleSelect('a')
    resetSourceListUi()
    expect(sourceListUi.get()).toEqual({ query: '', statusFilter: 'all', groupFilter: '', selection: [], editMode: false })
  })
})
