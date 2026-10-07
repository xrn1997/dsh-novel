import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { SourceRegistry } from '../../src/services/sources.js'
import { normalizeSource } from '../../src/services/normalize.js'
import { makeTempDir } from '../temp-dir.js'

const raw = { bookSourceName: 'A', bookSourceUrl: 'https://a.com', ruleContent: '@css:#c@text', header: '{"Cookie":"secret=1"}' }
async function tmp(): Promise<string> { return makeTempDir('novel-src-') }

describe('SourceRegistry', () => {
  it('edit(add) → flush → 重新 load 往返一致（raw 原样）', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const src = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    expect(src.id).toBeTruthy()
    expect(src.status).toBe('unverified')
    await reg.flush()
    const reg2 = await SourceRegistry.load(dir)
    expect(reg2.list()).toHaveLength(1)
    expect(reg2.get(src.id)!.raw).toEqual(raw)
    expect(reg2.get(src.id)!.rules.searchUrl).toBeNull()
  })
  it('edit(setStatus) 持久化 detail', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const src = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    await reg.edit((tx) => tx.setStatus(src.id, 'broken', '[search#段0] 没取到'))
    await reg.flush()
    expect((await SourceRegistry.load(dir)).get(src.id)).toMatchObject({ status: 'broken', statusDetail: '[search#段0] 没取到' })
  })
  it('flush 返回后不留挂起的待写：flush 在途期间发生的 edit 也算在内', async () => {
    // 病根与 `createDebouncedWriter.flush` 同族（那条已在 `tests/services/storage.test.ts` 钉住）：
    // flush 原先只 await「调用那一刻」的写链尾，于是落在那次写 I/O 期间的 edit 会换成一枚新的
    // 防抖计时器挂着——进程/测试收尾把数据根删掉之后它才烧，rename 被系统拒绝成为未处理拒绝
    // （全量门里那种「用例全绿但 exit≠0」的现场）。计时器用 fake 钟**数**出来：不靠 sleep，
    // 也不给「放宽断言」留余地。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const dir = await tmp()
      const reg = await SourceRegistry.load(dir)
      const first = await reg.edit((tx) => tx.add(normalizeSource(raw))) // 挂上一枚防抖计时器（尚未落地）
      const p = reg.flush()                                             // 第一次真写开始
      await reg.edit((tx) => tx.setStatus(first.id, 'verified'))        // 落在那次写的在途窗口里
      await p
      expect(vi.getTimerCount(), 'flush 已返回，但还挂着一笔待写的计时器（收尾时它会自己烧）').toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('setStatus 转 verified（无 detail）时清空旧 statusDetail，不残留失败原因', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const src = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    await reg.edit((tx) => tx.setStatus(src.id, 'broken', '上次失败原因'))
    expect(reg.get(src.id)!.statusDetail).toBe('上次失败原因')
    await reg.edit((tx) => tx.setStatus(src.id, 'verified'))
    expect(reg.get(src.id)!.statusDetail).toBeUndefined()
  })
  it('toPublic 不含 raw/rules/auth，只给状态位', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const src = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    const pub = reg.toPublic({ ...src, auth: { cookies: { secret: '1' }, expired: true } })
    expect(pub).not.toHaveProperty('raw')
    expect(pub).not.toHaveProperty('auth')
    expect(pub).not.toHaveProperty('rules')
    expect(pub).toMatchObject({ hasHeader: true, hasAuth: true, authExpired: true, hasLoginUrl: false })
  })
  it('hasLoginUrl 是「有没有登录脚本」的投影（UI 靠它决定「去登录」要不要问服务端）', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const plain = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    expect(reg.toPublic(plain).hasLoginUrl, '未声明 loginUrl').toBe(false)
    const withLogin = await reg.edit((tx) => tx.add(normalizeSource({ ...raw, bookSourceUrl: 'https://b.com', loginUrl: 'https://b.com/login' })))
    expect(reg.toPublic(withLogin).hasLoginUrl, '声明了 loginUrl').toBe(true)
  })
  it('setAuth 录入后 flush 重载可见；toPublic 仍只给布尔位', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const src = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    expect(await reg.edit((tx) => tx.setAuth(src.id, { cookies: { token: 'SECRET' } }))).toBe(true)
    expect(await reg.edit((tx) => tx.setAuth('nope', { cookies: {} }))).toBe(false)
    await reg.flush()
    const reloaded = (await SourceRegistry.load(dir)).get(src.id)!
    expect(reloaded.auth?.cookies).toEqual({ token: 'SECRET' })
    expect(JSON.stringify(reloaded)).toContain('SECRET')     // 内部全量含凭据（落盘需要）
    const pub = (await SourceRegistry.load(dir)).toPublic(reloaded)
    expect(pub.hasAuth).toBe(true)
    expect(JSON.stringify(pub)).not.toContain('SECRET')      // 对外投影绝不含
    await reg.edit((tx) => tx.setAuth(src.id, undefined))
    expect(reg.get(src.id)!.auth).toBeUndefined()
  })
  it('remove 删除', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const src = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    expect(await reg.edit((tx) => tx.remove(src.id))).toBe(true)
    expect(reg.list()).toHaveLength(0)
    await reg.flush()
    expect((await SourceRegistry.load(dir)).list()).toHaveLength(0)
  })
  it('removeAll 批量删除：命中计数、未知 id 静默跳过、重复 id 幂等、一次落盘全落', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const a = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    const b = await reg.edit((tx) => tx.add(normalizeSource({ ...raw, bookSourceName: 'B', bookSourceUrl: 'https://b.com' })))
    const c = await reg.edit((tx) => tx.add(normalizeSource({ ...raw, bookSourceName: 'C', bookSourceUrl: 'https://c.com' })))
    expect(await reg.edit((tx) => tx.removeAll([a.id, 'nope', b.id, a.id]))).toBe(2)   // 未知跳过 + 重复幂等
    expect(reg.list().map((s) => s.id)).toEqual([c.id])
    await reg.flush()
    expect((await SourceRegistry.load(dir)).list().map((s) => s.id)).toEqual([c.id])
    expect(await reg.edit((tx) => tx.removeAll([]))).toBe(0)                            // 空列表 → 0
  })
  it('replace：原位替换保列表序、复用旧 id、status 复位 unverified、flush 重载一致', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const a = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    const b = await reg.edit((tx) => tx.add(normalizeSource({ ...raw, bookSourceName: 'B', bookSourceUrl: 'https://b.com' })))
    await reg.edit((tx) => tx.setStatus(b.id, 'broken', '旧规则坏了'))
    const out = await reg.edit((tx) => tx.replace(b.id, normalizeSource({ ...raw, bookSourceName: 'B2', bookSourceUrl: 'https://b2.com' })))
    expect(out.id).toBe(b.id)                                    // 复用旧 id（书架/引用不断）
    expect(reg.list().map((s) => s.name)).toEqual(['A', 'B2'])   // 原位保序
    expect(reg.list()[1].status).toBe('unverified')              // 复位待重验
    expect(reg.list()[1].baseUrl).toBe('https://b2.com')
    await reg.flush()
    expect((await SourceRegistry.load(dir)).get(b.id)!.name).toBe('B2')
    expect(a.id).toBeTruthy()
  })
  it('replace：id 不存在抛错；result 不 ok 抛错（与 add 同口径）', async () => {
    const reg = await SourceRegistry.load(await tmp())
    await expect(reg.edit((tx) => tx.replace('nope', normalizeSource(raw)))).rejects.toThrowError(/源不存在/)
    await expect(reg.edit((tx) => tx.replace('nope', normalizeSource({ bad: 1 })))).rejects.toThrowError(/只收 ok/)
  })
  it('setEnabled：置位 + flush 重载一致；未知 id false', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const a = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    expect(await reg.edit((tx) => tx.setEnabled(a.id, false))).toBe(true)
    expect(reg.get(a.id)!.enabled).toBe(false)
    expect(await reg.edit((tx) => tx.setEnabled('nope', false))).toBe(false)
    await reg.flush()
    expect((await SourceRegistry.load(dir)).get(a.id)!.enabled).toBe(false)
    await reg.edit((tx) => tx.setEnabled(a.id, true))
    expect(reg.get(a.id)!.enabled).toBe(true)
  })
  it('load 归一：早期数据缺 enabled 字段 → 默认启用（否则搜索面静默排除老源）', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const a = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    await reg.flush()
    // 手工把 enabled 键删掉，模拟早期 sources.json
    const file = path.join(dir, 'sources.json')
    const legacy = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, unknown>>
    for (const s of legacy) delete s.enabled
    await fs.writeFile(file, JSON.stringify(legacy), 'utf8')
    const reloaded = await SourceRegistry.load(dir)
    expect(reloaded.get(a.id)!.enabled).toBe(true)          // 缺省即启用
  })
})

describe('load 内容形态迁移（bookSourceType 编码订正的存量收敛）', () => {
  it('raw.bookSourceType=2 的存量源：type 由误标的 text 重推为 image（legado 2=图片）；enabled 不动', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    await reg.edit((tx) => tx.add(normalizeSource(raw)))
    await reg.edit(() => {
      const s = reg.list()[0]
      s.type = 'text'                                    // 迁移前的存量误标形态
      s.raw = { ...(s.raw as Record<string, unknown>), bookSourceType: 2 }
    })
    await reg.flush()
    const re = (await SourceRegistry.load(dir)).list()[0]
    expect(re.type).toBe('image')                        // 书源格式的 bookSourceType 真值：2=图片
    expect(re.enabled).toBe(true)                        // 迁移不动启用态
  })
  it('未知数值（如 4）的存量源：按 raw 重推为 unknown——退出参与集，但不打 status（探针会洗白）', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    await reg.edit((tx) => tx.add(normalizeSource(raw)))
    await reg.edit(() => {
      const s = reg.list()[0]
      s.raw = { ...(s.raw as Record<string, unknown>), bookSourceType: 4 }
    })
    await reg.flush()
    const re = (await SourceRegistry.load(dir)).list()[0]
    expect(re.type).toBe('unknown')
    expect(re.enabled).toBe(true)                         // 只出参与集，不动启用态
  })
  it('存量 raw 无 bookSourceType 字段 → text（Native 方言根本不产这个字段，缺省是合法形态）', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    await reg.edit((tx) => tx.add(normalizeSource(raw)))
    await reg.flush()
    const re = (await SourceRegistry.load(dir)).list()[0]
    expect(re.type).toBe('text')
  })
  it('raw.ruleBookInfo.init 存在而 rules 缺 ruleDetailInit → load 按 raw 重推（init 换根映射的存量收敛——QQ 源真机判别实证：缺键则换根静默不生效、tocUrl 回退 → EmptyToc）', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    await reg.edit((tx) => tx.add(normalizeSource({
      bookSourceName: 'QQ', bookSourceUrl: 'https://qq.example.com', ruleContent: 'x',
      ruleBookInfo: { init: '$.data.bookInfo', name: '$.name' },
    })))
    expect(reg.list()[0].rules.ruleDetailInit).toBe('$.data.bookInfo')   // 入库时已映射
    await reg.edit(() => {
      const s = reg.list()[0]
      delete (s.rules as unknown as Record<string, unknown>).ruleDetailInit          // 模拟旧版派生的存量形态
    })
    await reg.flush()
    expect((await SourceRegistry.load(dir)).list()[0].rules.ruleDetailInit).toBe('$.data.bookInfo')
  })
  it('raw 无 init 而 rules 键缺席 → load 补 null（NormalizedRules 是 required 形状，键应恒在场）', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    await reg.edit((tx) => tx.add(normalizeSource(raw)))
    await reg.edit(() => {
      const s = reg.list()[0]
      delete (s.rules as unknown as Record<string, unknown>).ruleDetailInit
    })
    await reg.flush()
    expect((await SourceRegistry.load(dir)).list()[0].rules.ruleDetailInit).toBeNull()
  })
  it('rules 缺 ruleExploreKinds 键 → load 补空数组（数组键同样按 required 形状收敛：消费者按 .length 读分类面，缺键是 TypeError）', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    await reg.edit((tx) => tx.add(normalizeSource(raw)))
    await reg.edit(() => {
      const s = reg.list()[0]
      delete (s.rules as unknown as Record<string, unknown>).ruleExploreKinds   // 模拟本任务之前入库的存量
    })
    await reg.flush()
    expect((await SourceRegistry.load(dir)).list()[0].rules.ruleExploreKinds).toEqual([])
    expect((await SourceRegistry.load(dir)).list()[0].rules.ruleExploreKinds).toEqual([])  // 二次 load 幂等
    // 这个夹具是 legado 平铺源、raw 里没有发现面：正确值**就是**空数组（不是「没补出来」）
  })
  it('原生方言的存量源缺 explore 键 → load 按 raw 的 ruleFind 补推（不是补空数组：本机那唯一原生源 raw 带 14 个 kinds，只补 [] 则书城整个是空的；ruleExploreUrl 同样缺席会让分类抓取一律判规则缺失）', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    await reg.edit((tx) => tx.add(normalizeSource({
      name: '笔趣阁', url: 'https://www.bqquge.com',
      searchUrl: '/so/{{keyword}}/{{page}}',
      ruleSearch: { list: '.item', name: 'h3 a', bookUrl: 'h3 a@href' },
      ruleContent: { content: '.con' },
      ruleFind: {
        url: '/{{kind}}/{{page}}',
        kinds: [{ title: '玄幻', url: 'xuanhuan' }, { title: '都市', url: 'dushi' }],
      },
    })))
    expect(reg.list()[0].rules.ruleExploreKinds).toHaveLength(2)                 // 入库时已映射
    await reg.edit(() => {
      const rules = reg.list()[0].rules as unknown as Record<string, unknown>
      for (const k of Object.keys(rules)) if (k.startsWith('ruleExplore')) delete rules[k]  // 旧版派生的存量形态
    })
    await reg.flush()
    const rules = (await SourceRegistry.load(dir)).list()[0].rules
    expect(rules.ruleExploreUrl).toBe('/{{kind}}/{{page}}')                      // 只补空数组的实现这里是 null
    expect(rules.ruleExploreKinds).toEqual([
      { title: '玄幻', url: 'xuanhuan' }, { title: '都市', url: 'dushi' },
    ])
    expect(rules.ruleExploreList).toBeNull()                                     // ruleFind 没带 ruleSearch → 整套不给
    expect((await SourceRegistry.load(dir)).list()[0].rules.ruleExploreKinds).toHaveLength(2)  // 二次 load 幂等
  })
  it('发现面补推不覆盖在场且非空的值：新入库源已有的值不被第二条路改写', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    await reg.edit((tx) => tx.add(normalizeSource({
      name: '手改', url: 'https://manual.example.com',
      ruleContent: { content: '.con' },
      ruleFind: { url: '/{{kind}}/{{page}}', kinds: [{ title: '玄幻', url: 'xuanhuan' }] },
    })))
    // 键在场且与 raw 派生值不同——同值夹具下「只填缺席」与「恒覆盖」同绿，这条用例才可证伪
    await reg.edit(() => { reg.list()[0].rules.ruleExploreUrl = '/manual/{{page}}' })
    await reg.flush()
    const rules = (await SourceRegistry.load(dir)).list()[0].rules
    expect(rules.ruleExploreUrl).toBe('/manual/{{page}}')                        // 恒覆盖的实现会把它改成 /{{kind}}/{{page}}
    expect(rules.ruleExploreKinds).toEqual([{ title: '玄幻', url: 'xuanhuan' }])
  })
  it('存量 legado 源在 load 时按 raw 补上发现面；第二次 load 不再改动（幂等，且迁移即落盘）', async () => {
    const dir = await tmp()
    const staleRaw = {
      bookSourceName: '甲', bookSourceUrl: 'https://a.com', ruleContent: '@css:#c@text',
      exploreUrl: '玄幻::/xh/{{page}}', ruleExplore: { bookList: '.e@li', name: 'tag.a@text' },
    }
    // 旧版本入库的形状：发现面十一键**在场但全是空**（那一版还没接 legado）。
    // 手写 sources.json 而不是 edit(add)——后者入库的源已带新派生值，造不出这个现场。
    const stale = {
      id: 's1', name: '甲', baseUrl: 'https://a.com', enabled: true, type: 'text',
      groups: [], status: 'unverified', importedAt: 0, raw: staleRaw,
      rules: {
        ruleExploreKinds: [], ruleExploreUrl: null, ruleExploreList: null, ruleExploreName: null,
        ruleExploreAuthor: null, ruleExploreBookUrl: null, ruleExploreCoverUrl: null,
        ruleExploreIntro: null, ruleExploreKind: null, ruleExploreLastChapter: null,
        ruleExploreWordCount: null,
      },
    }
    await fs.writeFile(path.join(dir, 'sources.json'), JSON.stringify([stale]), 'utf8')

    const reg = await SourceRegistry.load(dir)
    expect(reg.get('s1')!.rules.ruleExploreKinds).toEqual([{ title: '玄幻', url: '/xh/{{page}}' }])
    expect(reg.get('s1')!.rules.ruleExploreList).toBe('.e@li')
    expect(reg.get('s1')!.rules.ruleExploreName).toBe('tag.a@text')

    // 幂等的证据必须是**文件层**的，不能是「再 load 一次值相同」：「当前值为空就写、哪怕派生值
    // 也是空」那种实现写回的是同一个空值，逐字段比值全等，代价却是每次启动重写整库。这里钉的是
    // 「changed → dirty → flush 那条链第二次没被走」。先把 mtime 拨到一个整块的时间再核回原值，
    // 不赌文件系统的时间戳粒度（粒度粗于写间隔时，「两次读到的 mtime 相等」会假绿）。
    const file = path.join(dir, 'sources.json')
    const epoch = new Date('2020-01-01T00:00:00Z')
    await fs.utimes(file, epoch, epoch)
    const bytesBefore = await fs.readFile(file, 'utf8')
    const again = await SourceRegistry.load(dir)
    expect(again.get('s1')!.rules).toEqual(reg.get('s1')!.rules)
    const after = await fs.stat(file)
    expect([after.mtimeMs, await fs.readFile(file, 'utf8')]).toEqual([epoch.getTime(), bytesBefore])
  })
  // ⑥ 的读原先是自己解释 raw 的**第二份**规则解释：只认对象容器、且容器优先于平铺——
  // 与导入侧（flattenDialect：字符串化容器照解析、平铺优先）在两种形态上分岔。恒覆盖
  // 于是会把导入侧派生的正确值改写掉（抹成 null 或换成另一处的值），且落盘后看不出来。
  it('⑥ init 往返：字符串化 ruleBookInfo 容器不被 load 抹成 null', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    await reg.edit((tx) => tx.add(normalizeSource({
      bookSourceName: '字符串容器 init', bookSourceUrl: 'https://str-init.example.com', ruleContent: 'x',
      ruleBookInfo: JSON.stringify({ init: '$.data', name: '$.name' }),
    })))
    expect(reg.list()[0].rules.ruleDetailInit).toBe('$.data')     // 导入侧解析了字符串化容器
    await reg.flush()
    expect((await SourceRegistry.load(dir)).list()[0].rules.ruleDetailInit).toBe('$.data')
  })
  it('⑥ init 往返：平铺与容器并存时 load 与导入侧同一优先级（平铺优先）', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    await reg.edit((tx) => tx.add(normalizeSource({
      bookSourceName: '两说 init', bookSourceUrl: 'https://two-init.example.com', ruleContent: 'x',
      ruleDetailInit: '$.flat',
      ruleBookInfo: { init: '$.nested' },
    })))
    expect(reg.list()[0].rules.ruleDetailInit).toBe('$.flat')     // 导入侧：平铺优先（setIfVacant）
    await reg.flush()
    expect((await SourceRegistry.load(dir)).list()[0].rules.ruleDetailInit).toBe('$.flat')
  })
  it('⑥ 单一读路后恒覆盖是幂等的：已被第二条读路抹成 null 的存量在 load 时按 raw 修复', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    await reg.edit((tx) => tx.add(normalizeSource({
      bookSourceName: '受损存量', bookSourceUrl: 'https://damaged.example.com', ruleContent: 'x',
      ruleBookInfo: JSON.stringify({ init: '$.data', name: '$.name' }),
    })))
    await reg.edit(() => {
      const s = reg.list()[0]
      s.rules.ruleDetailInit = null                              // 模拟旧实现已经写坏并落盘的存量
    })
    await reg.flush()
    const re = (await SourceRegistry.load(dir)).list()[0]
    expect(re.rules.ruleDetailInit).toBe('$.data')
    expect((await SourceRegistry.load(dir)).list()[0].rules.ruleDetailInit).toBe('$.data')  // 二次 load 幂等
  })
  it('存量 rules 缺 bookUrlPattern 而 raw 带值 → load 按 raw 重推（详情页嗅探是后来才读的字段：不重推则 27 个声明了它的源照旧只跑列表规则）', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    await reg.edit((tx) => tx.add(normalizeSource({
      bookSourceName: '嗅探', bookSourceUrl: 'https://sniff.example.com', ruleContent: 'x',
      bookUrlPattern: 'https://sniff\\.example\\.com/book/\\d+/',
    })))
    expect(reg.list()[0].rules.bookUrlPattern).toBe('https://sniff\\.example\\.com/book/\\d+/')
    await reg.edit(() => {
      delete (reg.list()[0].rules as unknown as Record<string, unknown>).bookUrlPattern  // 旧版派生的存量形态
    })
    await reg.flush()
    expect((await SourceRegistry.load(dir)).list()[0].rules.bookUrlPattern)
      .toBe('https://sniff\\.example\\.com/book/\\d+/')
  })
  it('存量 rules 缺 kind/wordCount 四键 → load 按 raw 补推（审计真机读数：不补则已入库的源到货率恒为 0）', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    await reg.edit((tx) => tx.add(normalizeSource({
      bookSourceName: '分类', bookSourceUrl: 'https://kind.example.com', ruleContent: 'x',
      searchUrl: 'https://kind.example.com/s?q={{key}}',
      ruleSearch: { bookList: '.b', name: 'tag.a@text', kind: 'tag.span@class', wordCount: '12345' },
      ruleBookInfo: { name: 'tag.h1@text', kind: '.cat@text' },
    })))
    expect(reg.list()[0].rules.ruleKind).toBe('tag.span@class')       // 入库时已映射
    await reg.edit(() => {
      const rules = reg.list()[0].rules as unknown as Record<string, unknown>
      for (const k of ['ruleKind', 'ruleWordCount', 'ruleDetailKind', 'ruleDetailWordCount']) delete rules[k]
    })
    await reg.flush()
    const rules = (await SourceRegistry.load(dir)).list()[0].rules as unknown as Record<string, unknown>
    expect(rules.ruleKind).toBe('tag.span@class')
    expect(rules.ruleWordCount).toBe('12345')
    expect(rules.ruleDetailKind).toBe('.cat@text')
    expect(rules.ruleDetailWordCount).toBeNull()                       // raw 没有 → 键恒在场为 null
  })
  it('补推只填缺席键：新入库源已有的值不被第二条路改写', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    // 两条读路的**优先级不同**：导入侧平铺优先（setIfVacant），raw 重推侧容器优先（inBox 先取）——
    // 夹具要让两处给出**不同的值**，这条用例才有可证伪性：同值夹具下「只填缺席」与「恒覆盖」同绿
    // （曾用字符串化容器当夹具，两路算出同一个值，改坏了也照绿）。
    await reg.edit((tx) => tx.add(normalizeSource({
      bookSourceName: '两说', bookSourceUrl: 'https://two.example.com', ruleContent: 'x',
      ruleKind: 'tag.flat@text',
      ruleSearch: { bookList: '.b', name: 'tag.a@text', kind: 'tag.nested@text' },
    })))
    expect(reg.list()[0].rules.ruleKind).toBe('tag.flat@text')        // 导入侧：平铺优先
    await reg.flush()
    const rules = (await SourceRegistry.load(dir)).list()[0].rules as unknown as Record<string, unknown>
    expect(rules.ruleKind).toBe('tag.flat@text')                      // 恒覆盖的实现会把它改成 tag.nested@text
  })
  it('字符串化容器的值照旧由导入侧解析，load 不推翻它', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    await reg.edit((tx) => tx.add(normalizeSource({
      bookSourceName: '字符串容器', bookSourceUrl: 'https://str.example.com', ruleContent: 'x',
      ruleSearch: JSON.stringify({ bookList: '.b', name: 'tag.a@text', kind: 'tag.i@text' }),
    })))
    expect(reg.list()[0].rules.ruleKind).toBe('tag.i@text')
    await reg.flush()
    expect((await SourceRegistry.load(dir)).list()[0].rules.ruleKind).toBe('tag.i@text')
  })
})

describe('load 分组迁移（逗号粘连存量收敛）', () => {  it('早期形态「A,B 一段」在 load 时拆开并落盘；幂等', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const src = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    // 回灌脏数据（当年只按 \ 拆的产物）——直改活体对象，包进 edit 以标脏落盘
    await reg.edit(() => { src.groups = ['快速书源 ⚡,通常书源 📂', '小说'] })
    await reg.flush()
    const reg2 = await SourceRegistry.load(dir)
    expect(reg2.get(src.id)!.groups).toEqual(['快速书源 ⚡', '通常书源 📂', '小说'])
    expect((await SourceRegistry.load(dir)).get(src.id)!.groups)   // 再载不变（幂等）
      .toEqual(['快速书源 ⚡', '通常书源 📂', '小说'])
  })
})
describe('load 名称迁移（前缀图标收敛）', () => {
  it('⚡📂打头的装饰前缀在 load 时剥掉并落盘；幂等', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const src = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    await reg.edit(() => { src.name = '⚡📂旧名' })               // 回灌脏数据（迁移前的存量形态）
    await reg.flush()
    const reg2 = await SourceRegistry.load(dir)
    expect(reg2.get(src.id)!.name).toBe('旧名')
    expect((await SourceRegistry.load(dir)).get(src.id)!.name).toBe('旧名')   // 再载不变（幂等）
  })
})

describe('edit 原子变更 + 合并落盘', () => {
  it('edit 后不 flush：内存可见、磁盘未写；flush 后重载一致', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const src = await reg.edit((tx) => tx.add(normalizeSource(raw)))
    expect(reg.get(src.id)).toBeTruthy()                                     // 内存即见
    await expect(fs.readFile(path.join(dir, 'sources.json'), 'utf8')).rejects.toThrow()   // 磁盘未写
    await reg.flush()
    expect((await SourceRegistry.load(dir)).get(src.id)!.name).toBe('A')
  })
  it('20 次变更阈值强制落盘（无需 flush 即重载可见）', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    for (let i = 0; i < 20; i++) {
      await reg.edit((tx) => tx.add(normalizeSource({ ...raw, bookSourceName: `S${i}`, bookSourceUrl: `https://s${i}.com` })))
    }
    expect((await SourceRegistry.load(dir)).list()).toHaveLength(20)         // 第 20 次触发强制写
  })
  it('并发 edit：两次变更都完整生效、互不吞并', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    const [a] = await Promise.all([
      reg.edit((tx) => tx.add(normalizeSource(raw))),
      reg.edit((tx) => tx.add(normalizeSource({ ...raw, bookSourceName: 'B', bookSourceUrl: 'https://b.com' }))),
    ])
    expect(reg.list()).toHaveLength(2)
    await reg.flush()
    expect((await SourceRegistry.load(dir)).list()).toHaveLength(2)
    expect(a.id).toBeTruthy()
  })
  it('recipe 抛错：edit reject，已同步发生的变更照常标脏可落盘（finally 语义）', async () => {
    const dir = await tmp()
    const reg = await SourceRegistry.load(dir)
    await expect(reg.edit((tx) => { tx.add(normalizeSource(raw)); throw new Error('boom') })).rejects.toThrow('boom')
    expect(reg.list()).toHaveLength(1)                                        // 同步已发生的变更在内存
    await reg.flush()
    expect((await SourceRegistry.load(dir)).list()).toHaveLength(1)           // 落得下去（不静默丢）
  })
})
