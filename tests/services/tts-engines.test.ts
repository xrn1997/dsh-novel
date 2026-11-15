import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { TtsEngineRegistry } from '../../src/services/tts-engines.js'
import { CorruptJsonError } from '../../src/services/storage.js'
import { InvalidRequestError } from '../../src/services/errors.js'
import { setLogSink } from '../../src/services/log.js'
import { exportJsonOf } from '../../src/client/tts/engine-rows.js'
import { makeTempDir, trackService } from '../temp-dir.js'
import { must, pick } from '../support/fixture.js'

/** legado HttpTTS 订阅条目的典型形状（数字 id、URL 后带 JSON options） */
const baidu = {
  id: '-100',
  name: '百度',
  url: 'http://tts.baidu.com/text2audio,{"method":"POST","body":"tex={{java.encodeURI(speakText)}}"}',
  contentType: 'audio/wav',
}

const UUID_ID = /^http:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** 非对称匹配器的 `any` 挡在类型面外（仓内同款：`epub-import.test.ts` 的 documentIdMatching）。 */
const anyNumber = (): unknown => expect.any(Number)
const containing = (fragment: string): unknown => expect.stringContaining(fragment)

async function tmp(): Promise<string> { return makeTempDir('novel-tts-') }

/** 建在临时目录上的注册表：写侧收尾交给 trackService（删目录前先 flush） */
async function open(dir?: string): Promise<TtsEngineRegistry> {
  return trackService(await TtsEngineRegistry.load(dir ?? (await tmp())))
}

describe('TtsEngineRegistry 加载与投影', () => {
  it('load 空目录 → 空表（首启是常态）', async () => {
    const reg = await open()
    expect(reg.list()).toEqual([])
  })

  it('put/get/list round-trip：get 给全量（含凭据），list 只给投影（剥 auth + hasAuth 位）', async () => {
    const reg = await open()
    const before = Date.now()
    const pub = reg.put('http:1', {
      name: '甲',
      url: 'http://a.example/tts?text={{speakText}}',
      contentType: 'audio/mpeg',
      auth: { cookies: { sid: 'SECRET' }, loginInfo: { user: 'u' } },
    })
    expect(pub).toEqual({
      id: 'http:1', name: '甲', url: 'http://a.example/tts?text={{speakText}}', contentType: 'audio/mpeg',
      hasAuth: true, lastUpdateTime: anyNumber(),
    })
    expect(pub).not.toHaveProperty('auth')
    expect(pub).not.toHaveProperty('authExpired')
    // 凭据只在内部全量里（落盘需要）
    expect(must(reg.get('http:1'), 'get 到的引擎').auth).toEqual({ cookies: { sid: 'SECRET' }, loginInfo: { user: 'u' } })
    expect(reg.get('nope')).toBeNull()
    expect(reg.list()).toHaveLength(1)
    expect(JSON.stringify(reg.list())).not.toContain('SECRET')
    expect(must(reg.get('http:1'), 'get 到的引擎').lastUpdateTime).toBeGreaterThanOrEqual(before)
  })

  it('put 整体替换可编辑字段；凭据缺席 = 保留（投影读不回来，改元数据不该抹掉登录态）', async () => {
    const reg = await open()
    reg.put('e1', {
      name: '甲', url: 'http://a.example', jsLib: 'function f() {}', header: '{"X":"1"}',
      auth: { cookies: { sid: 'SECRET' } },
    })
    reg.put('e1', { name: '甲（改名）', url: 'http://b.example' })
    const got = must(reg.get('e1'), '更新后的引擎')
    expect(got).toMatchObject({ id: 'e1', name: '甲（改名）', url: 'http://b.example' })
    expect(got.jsLib).toBeUndefined()
    expect(got.header).toBeUndefined()
    expect(got.auth?.cookies).toEqual({ sid: 'SECRET' })
    // 显式交凭据 = 覆盖
    reg.put('e1', { name: '甲（改名）', url: 'http://b.example', auth: { cookies: { sid: 'NEW' } } })
    expect(must(reg.get('e1'), '再次更新后的引擎').auth?.cookies).toEqual({ sid: 'NEW' })
  })

  it('显式空凭据 = 删掉 auth：hasAuth 不为一条没有凭据的记录报 true', async () => {
    const reg = await open()
    reg.put('e1', { name: '甲', url: 'http://a.example', auth: { cookies: { sid: 'SECRET' } } })
    expect(pick(reg.list(), 0).hasAuth).toBe(true)

    // 空 cookies 且 headers / loginInfo 缺席 = 用户把凭据清空了：auth 键整个消失，不是留一条空表
    const cleared = reg.put('e1', { name: '甲', url: 'http://a.example', auth: { cookies: {} } })
    expect(cleared.hasAuth).toBe(false)
    expect(must(reg.get('e1'), '清空凭据后的引擎')).not.toHaveProperty('auth')

    // 缺席仍是保留（改名不该抹凭据）：清空之后显式再交一份，同样能覆盖回来
    reg.put('e1', { name: '甲', url: 'http://a.example', auth: { cookies: { sid: 'KEEP' } } })
    reg.put('e1', { name: '甲（改名）', url: 'http://a.example' })
    expect(pick(reg.list(), 0).hasAuth).toBe(true)
    expect(must(reg.get('e1'), '改名后的引擎').auth?.cookies).toEqual({ sid: 'KEEP' })

    // 空 cookies 但有 headers 仍是一份凭据（「空」只看三格合起来是不是都没内容）
    reg.put('e2', { name: '乙', url: 'http://b.example', auth: { cookies: {}, headers: { 'X-Api-Key': 'K' } } })
    expect(pick(reg.list(), 1).hasAuth).toBe(true)
    expect(must(reg.get('e2'), '只有 headers 的引擎').auth).toEqual({ cookies: {}, headers: { 'X-Api-Key': 'K' } })
  })

  it('更新不丢源声明的音色表：音色经导入写口落盘，put 缺席 = 保留盘上那份', async () => {
    const dir = await tmp()
    const reg = await open(dir)
    reg.importJson(JSON.stringify({
      id: 'http:v', name: '带音色', url: 'http://v.example/tts',
      voices: [{ id: 'v1', name: '音色一' }],
    }))
    reg.put('http:v', { name: '带音色（改名）', url: 'http://v.example/tts' })
    expect(pick(reg.list(), 0).voices).toEqual([{ id: 'v1', name: '音色一' }])
    expect(must(reg.get('http:v'), '更新后的引擎').voices).toEqual([{ id: 'v1', name: '音色一' }])
    await reg.flush()
    expect(pick((await open(dir)).list(), 0).voices).toEqual([{ id: 'v1', name: '音色一' }])
  })

  it('put 的 voices 三态：缺席 = 保留；显式数组 = 整组替换；空数组 = 清掉', async () => {
    const reg = await open()
    reg.put('http:v', { name: '甲', url: 'http://a.example', voices: [{ id: 'v1', name: '音色一' }] })
    // 缺席 = 保留（与 auth 同族：改名不该抹掉源声明的音色表）
    reg.put('http:v', { name: '甲（改名）', url: 'http://a.example' })
    expect(must(reg.get('http:v'), '改名后的引擎').voices).toEqual([{ id: 'v1', name: '音色一' }])
    // 显式数组 = 整组替换（不是逐项合并）
    reg.put('http:v', {
      name: '甲（改名）', url: 'http://a.example',
      voices: [{ id: 'v2', name: '音色二' }, { id: 'v3', name: '音色三' }],
    })
    expect(must(reg.get('http:v'), '替换后的引擎').voices).toHaveLength(2)
    // 空数组 = 清掉（合法值，不是「缺席」）
    reg.put('http:v', { name: '甲（改名）', url: 'http://a.example', voices: [] })
    expect(must(reg.get('http:v'), '清空后的引擎').voices).toBeUndefined()
    expect(pick(reg.list(), 0)).not.toHaveProperty('voices')
  })

  it('import 带 voices 往返不丢：导出 → 导入 → list 的 voices 保留', async () => {
    const seeded = await open()
    seeded.importJson(JSON.stringify({
      id: 'http:v', name: '带音色', url: 'http://v.example/tts',
      voices: [{ id: 'v1', name: '音色一' }],
    }))
    // 导出走 client 的真出口（公共投影 + 剥凭据），不是手搓 JSON
    const exported = exportJsonOf(seeded.list())
    const fresh = await open()
    expect(fresh.importJson(exported)).toEqual({ added: 1, updated: 0, failed: [] })
    expect(pick(fresh.list(), 0).voices).toEqual([{ id: 'v1', name: '音色一' }])
    // 形状不符的音色表按缺席：坏表整键不带，不折成半份
    const noVoices = await open()
    noVoices.importJson(JSON.stringify({ id: 'http:bad', name: '坏表', url: 'http://b.example/tts', voices: 'nope' }))
    expect(pick(noVoices.list(), 0)).not.toHaveProperty('voices')
  })

  it('导入条的音色表只落 { id, name } 两格：多余键（如 lang）不进持久化形状', async () => {
    const reg = await open()
    reg.importJson(JSON.stringify({
      id: 'http:v', name: '带音色', url: 'http://v.example/tts',
      voices: [{ id: 'v1', name: '音色一', lang: 'zh' }],
    }))
    // 订阅是外部数据：本仓不消费的键不许原样落盘（落盘形状与公共投影都只有两格）
    expect(must(reg.get('http:v'), '带音色的引擎').voices).toStrictEqual([{ id: 'v1', name: '音色一' }])
    expect(pick(reg.list(), 0).voices).toStrictEqual([{ id: 'v1', name: '音色一' }])
  })

  it('load 剪掉保留命名空间的行并 warn 点名（手改文件不长幽灵源），好行照留', async () => {
    const dir = await tmp()
    await fs.writeFile(path.join(dir, 'tts-engines.json'), JSON.stringify([
      { id: 'builtin:fake', name: '假内置', url: 'http://x.example/tts' },
      { id: 'browser:local', name: '假直出', url: 'http://x.example/tts' },
      { id: 'cordis:speechSynthesis', name: '假宿主', url: 'http://x.example/tts' },
      { id: 'http:ok', name: '好行', url: 'http://ok.example/tts' },
    ]), 'utf8')
    const warns: string[] = []
    setLogSink({ info: () => {}, warn: (...a) => { warns.push(a.map(String).join(' ')) }, error: () => {} })
    let ids: string[]
    try {
      ids = (await TtsEngineRegistry.load(dir)).list().map((e) => e.id)
    } finally {
      setLogSink(console)
    }
    expect(ids).toEqual(['http:ok'])
    const traced = warns.join('\n')
    expect(traced).toContain('builtin:fake')
    expect(traced).toContain('browser:local')
    expect(traced).toContain('cordis:speechSynthesis')
  })

  it('load 剪掉与静态路由段重名的行（`import`）：改 / 删永远落 405 的幽灵记录不进表', async () => {
    const dir = await tmp()
    await fs.writeFile(path.join(dir, 'tts-engines.json'), JSON.stringify([
      { id: 'import', name: '假导入段', url: 'http://x.example/tts' },
      { id: 'http:ok', name: '好行', url: 'http://ok.example/tts' },
    ]), 'utf8')
    const warns: string[] = []
    setLogSink({ info: () => {}, warn: (...a) => { warns.push(a.map(String).join(' ')) }, error: () => {} })
    let ids: string[]
    try {
      ids = (await TtsEngineRegistry.load(dir)).list().map((e) => e.id)
    } finally {
      setLogSink(console)
    }
    expect(ids).toEqual(['http:ok'])
    expect(warns.join('\n')).toContain('import')
  })

  it('load 剪掉缺 id / name / url 的行并点名：清单只列此刻可用的源，坏行半径 = 该行', async () => {
    const dir = await tmp()
    await fs.writeFile(path.join(dir, 'tts-engines.json'), JSON.stringify([
      { name: '缺 id', url: 'http://x.example/tts' },
      { id: 'http:nourl', name: '缺 url' },
      { id: 'http:noname', url: 'http://x.example/tts' },
      { id: 'http:badvoices', name: '坏音色表', url: 'http://x.example/tts', voices: 'nope' },
      { id: 'http:emptyvoices', name: '空音色表', url: 'http://x.example/tts', voices: [] },
      { id: 'http:ok', name: '好行', url: 'http://ok.example/tts' },
    ]), 'utf8')
    const warns: string[] = []
    setLogSink({ info: () => {}, warn: (...a) => { warns.push(a.map(String).join(' ')) }, error: () => {} })
    let ids: string[]
    try {
      ids = (await TtsEngineRegistry.load(dir)).list().map((e) => e.id)
    } finally {
      setLogSink(console)
    }
    expect(ids).toEqual(['http:badvoices', 'http:emptyvoices', 'http:ok'])
    expect(warns.join('\n')).toContain('http:nourl')
    expect(warns.join('\n')).toContain('http:noname')
    expect(must((await TtsEngineRegistry.load(dir)).list()[0], '坏音色表那一行')).not.toHaveProperty('voices')
    // 空表与缺席同义（落盘读口与 put/导入同口径）：不许长出一行选不出东西的音色行
    expect(must((await TtsEngineRegistry.load(dir)).list()[1], '空音色表那一行')).not.toHaveProperty('voices')
  })

  it('load 凭据三格逐格校验：cookies 坏 → 整份 auth 不留；headers / loginInfo 坏 → 只剪那一格', async () => {
    const dir = await tmp()
    await fs.writeFile(path.join(dir, 'tts-engines.json'), JSON.stringify([
      { id: 'http:badcookies', name: '坏 cookies', url: 'http://x.example/tts', auth: { cookies: { sid: 42 }, headers: { X: '1' } } },
      { id: 'http:notobject', name: 'cookies 不是对象', url: 'http://x.example/tts', auth: { cookies: 'sid=1' } },
      {
        id: 'http:badheaders', name: '坏 headers', url: 'http://x.example/tts',
        auth: { cookies: { sid: 'S' }, headers: 'nope', loginInfo: { u: 'alice' } },
      },
      { id: 'http:ok', name: '好行', url: 'http://ok.example/tts', auth: { cookies: { sid: 'S' } } },
    ]), 'utf8')
    const reg = await TtsEngineRegistry.load(dir)
    // 凭据坏不杀行：源本身仍可用（没有登录需求的端点照常合成），只是这份 auth 不可用
    expect(reg.list().map((e) => e.id)).toEqual(['http:badcookies', 'http:notobject', 'http:badheaders', 'http:ok'])
    // cookies 是必填格：坏形状 → 整份 auth 不留（hasAuth 不许报 true 而没有可用凭据）
    expect(pick(reg.list(), 0).hasAuth).toBe(false)
    expect(must(reg.get('http:badcookies'), '坏 cookies 那一行')).not.toHaveProperty('auth')
    expect(pick(reg.list(), 1).hasAuth).toBe(false)
    // headers 坏只剪那一格：cookies 与 loginInfo 照留，合成链取的仍是可用凭据
    const badHeaders = must(reg.get('http:badheaders'), '坏 headers 那一行')
    expect(badHeaders.auth).toEqual({ cookies: { sid: 'S' }, loginInfo: { u: 'alice' } })
    expect(badHeaders).not.toHaveProperty('auth.headers')
    expect(pick(reg.list(), 3).hasAuth).toBe(true)
  })

  it('load 同 id 重复行只留先出现的那一条并 warn 点名（半径同保留 id 剪除）', async () => {
    const dir = await tmp()
    await fs.writeFile(path.join(dir, 'tts-engines.json'), JSON.stringify([
      { id: 'http:dup', name: '先出现', url: 'http://a.example/tts' },
      { id: 'http:dup', name: '后出现', url: 'http://b.example/tts' },
      { id: 'http:ok', name: '好行', url: 'http://ok.example/tts' },
    ]), 'utf8')
    const warns: string[] = []
    setLogSink({ info: () => {}, warn: (...a) => { warns.push(a.map(String).join(' ')) }, error: () => {} })
    let rows: Array<{ id: string; name: string }>
    try {
      rows = (await TtsEngineRegistry.load(dir)).list()
    } finally {
      setLogSink(console)
    }
    // id 是身份：两条同 id 会让 get / 路由改删只命中前者，后者成为够不着的幽灵记录
    expect(rows.map((e) => e.name)).toEqual(['先出现', '好行'])
    expect(warns.join('\n')).toContain('http:dup')
  })

  it('load 文本位类型闸：手改文件塞非 string 的 header / contentType 按缺席，不留给合成链 .trim() 炸成 500', async () => {
    const dir = await tmp()
    await fs.writeFile(path.join(dir, 'tts-engines.json'), JSON.stringify([
      {
        id: 'http:bad', name: '坏文本位', url: 'http://x.example/tts',
        header: 42, contentType: { x: 1 }, jsLib: 'function f(){}',
        loginUrl: 'http://x.example/login', concurrentRate: '500/1000',
      },
      { id: 'http:ok', name: '好行', url: 'http://ok.example/tts', contentType: 'audio/wav' },
    ]), 'utf8')
    const reg = await TtsEngineRegistry.load(dir)
    const bad = must(reg.get('http:bad'), '坏文本位那一行')
    expect(bad.header, '非 string 的 header 按缺席').toBeUndefined()
    expect(bad.contentType, '非 string 的 contentType 同样按缺席').toBeUndefined()
    expect(bad.jsLib, '合法 jsLib 照留').toBe('function f(){}')
    // 本仓不支持的 legado 字段不落盘（与 importJson 同口径），手改文件不长第二条持久化形状
    expect(bad).not.toHaveProperty('loginUrl')
    expect(bad).not.toHaveProperty('concurrentRate')
    expect(reg.list().map((e) => e.id), '坏格不杀整行，好行照留').toEqual(['http:bad', 'http:ok'])
  })

  it('put / remove 的 id 首尾空白归一：不会长出「同一个 id 的两条记录」', async () => {
    const reg = await open()
    reg.put(' http:1 ', { name: '甲', url: 'http://a.example' })
    expect(reg.list().map((e) => e.id)).toEqual(['http:1'])
    expect(reg.remove(' http:1 ')).toBe(true)
    expect(reg.list()).toEqual([])
  })

  it('降级注册表：空表 + degradedReason 在场，读面照常给空（不炸、不冒充有数据）', async () => {
    const reg = TtsEngineRegistry.degraded(await tmp(), 'tts-engines.json 损坏')
    expect(reg.degradedReason).toBe('tts-engines.json 损坏')
    expect(reg.list()).toEqual([])
    expect(reg.get('http:x')).toBeNull()
  })

  it('落盘到自己那一份 tts-engines.json（不碰 sources.json），flush 前不写', async () => {
    const dir = await tmp()
    const reg = await open(dir)
    reg.put('e1', { name: '甲', url: 'http://a.example' })
    const file = path.join(dir, 'tts-engines.json')
    await expect(fs.readFile(file, 'utf8')).rejects.toThrow()       // 防抖窗口里还没落
    await reg.flush()
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8')) as unknown
    expect(onDisk).toMatchObject([{ id: 'e1', name: '甲', url: 'http://a.example' }])
    await expect(fs.readFile(path.join(dir, 'sources.json'), 'utf8')).rejects.toThrow()
  })

  it('remove：命中删一条并落盘；未知 id → false', async () => {
    const dir = await tmp()
    const reg = await open(dir)
    reg.put('e1', { name: '甲', url: 'http://a.example' })
    expect(reg.remove('nope')).toBe(false)
    expect(reg.remove('e1')).toBe(true)
    expect(reg.list()).toEqual([])
    await reg.flush()
    expect((await TtsEngineRegistry.load(dir)).list()).toEqual([])
  })

  it('重载后凭据仍在盘上；list 仍不含凭据', async () => {
    const dir = await tmp()
    const reg = await open(dir)
    reg.put('e1', {
      name: '甲', url: 'http://a.example',
      auth: {
        cookies: { sid: 'SECRET' },
        headers: { Authorization: 'Bearer SECRET' },
        loginInfo: { user: 'u' },
      },
    })
    await reg.flush()
    expect(await fs.readFile(path.join(dir, 'tts-engines.json'), 'utf8')).toContain('SECRET')   // 盘上含凭据
    const again = await open(dir)
    expect(must(again.get('e1'), '重载后的引擎').auth).toEqual({
      cookies: { sid: 'SECRET' }, headers: { Authorization: 'Bearer SECRET' }, loginInfo: { user: 'u' },
    })
    expect(pick(again.list(), 0)).toMatchObject({ hasAuth: true })
    expect(JSON.stringify(again.list())).not.toContain('SECRET')
  })

  it('load 读坏文件响亮失败（CorruptJsonError），不折叠成空表', async () => {
    const dir = await tmp()
    await fs.writeFile(path.join(dir, 'tts-engines.json'), '{oops', 'utf8')
    await expect(TtsEngineRegistry.load(dir)).rejects.toBeInstanceOf(CorruptJsonError)
  })

  it('load 顶层不是数组：点名形状错误，不把引擎实现的 TypeError 漏进降级原因', async () => {
    const dir = await tmp()
    await fs.writeFile(path.join(dir, 'tts-engines.json'), '{"engines":[]}', 'utf8')
    await expect(TtsEngineRegistry.load(dir)).rejects.toThrow('顶层应为引擎订阅数组')
  })
})

describe('importJson（legado HttpTTS 订阅）', () => {
  it('单对象 → added=1；数字 id 字符串化保留；flush 后重载可见', async () => {
    const dir = await tmp()
    const reg = await open(dir)
    const receipt = reg.importJson(JSON.stringify(baidu))
    expect(receipt).toEqual({ added: 1, updated: 0, failed: [] })
    expect(reg.list()).toEqual([{
      id: '-100', name: '百度', url: baidu.url, contentType: 'audio/wav',
      hasAuth: false, lastUpdateTime: anyNumber(),
    }])
    await reg.flush()
    expect(pick((await TtsEngineRegistry.load(dir)).list(), 0).id).toBe('-100')
  })

  it('数组 → added=2；缺 id 生成 http:<uuid>', async () => {
    const reg = await open()
    const receipt = reg.importJson(JSON.stringify([baidu, { name: '乙', url: 'http://b.example/tts' }]))
    expect(receipt).toEqual({ added: 2, updated: 0, failed: [] })
    expect(reg.list().map((e) => e.id)).toEqual(['-100', expect.stringMatching(UUID_ID)])
  })

  it('只收合成链会读的字段；legado 的登录 / 限速 / cookie jar 字段在导入时忽略', async () => {
    const reg = await open()
    const entry = {
      id: 7,
      name: '订阅', url: 'http://x.example/tts',
      contentType: 'audio/mpeg', header: '{"User-Agent":"x"}', jsLib: 'function f() {}',
      loginUrl: 'http://x.example/login', loginUi: '[]', loginCheckJs: 'ok',
      enabledCookieJar: false, concurrentRate: '500/1000',
    }
    reg.importJson(JSON.stringify(entry))
    expect(reg.get('7')).toEqual({
      id: '7', name: '订阅', url: 'http://x.example/tts',
      contentType: 'audio/mpeg', header: '{"User-Agent":"x"}', jsLib: 'function f() {}',
      lastUpdateTime: anyNumber(),
    })
  })

  /** 保留命名空间（`isReservedTtsEngineId` 的判据）：注册表收下它们就等于在源清单里造一行
   *  「此刻可用、合成必失败」的幽灵源；同名内置还会让清单长出两行同 id 的源。 */
  it('导入条自带保留 id：只剪那一条并点名，其余照进', async () => {
    const reg = await open()
    const receipt = reg.importJson(JSON.stringify([
      { id: 'builtin:baidu', name: '假内置', url: 'http://x.example/tts' },
      { id: 'browser:local', name: '假直出', url: 'http://x.example/tts' },
      { id: 'cordis:speechSynthesis', name: '假宿主', url: 'http://x.example/tts' },
      baidu,
    ]))
    expect(receipt).toEqual({ added: 1, updated: 0, failed: [
      { index: 0, message: containing('保留命名空间') },
      { index: 1, message: containing('保留命名空间') },
      { index: 2, message: containing('保留命名空间') },
    ] })
    expect(reg.list().map((e) => e.id)).toEqual(['-100'])
  })

  it('写入口收保留 id → InvalidRequestError（put 与导入同一条判据，不各写一份）', async () => {
    const reg = await open()
    for (const id of ['builtin:x', 'browser:local', 'cordis:speechSynthesis']) {
      expect(() => reg.put(id, { name: '甲', url: 'http://x.example/tts' }), id).toThrow(InvalidRequestError)
    }
    expect(reg.list()).toEqual([])
  })

  /** 静态兄弟路由优先于参数路由（`src/api/routes.ts` 判据③）：`POST tts/engines/import` 先于
   *  `tts/engines/:id` 命中，id 恰为 `import` 的引擎能创建，但 PUT / DELETE 永远 405。 */
  it('导入条 id 与静态路由段重名（import）：只剪那一条并点名，其余照进', async () => {
    const reg = await open()
    const receipt = reg.importJson(JSON.stringify([
      { id: 'import', name: '撞静态段', url: 'http://x.example/tts' },
      baidu,
    ]))
    expect(receipt).toEqual({ added: 1, updated: 0, failed: [{ index: 0, message: containing('静态路由') }] })
    expect(reg.list().map((e) => e.id)).toEqual(['-100'])
  })

  it('写入口收与静态路由段重名的 id → InvalidRequestError；只是前缀相同的 id 不受影响', async () => {
    const reg = await open()
    expect(() => reg.put('import', { name: '甲', url: 'http://x.example/tts' })).toThrow(InvalidRequestError)
    expect(reg.list()).toEqual([])
    reg.put('http:import', { name: '乙', url: 'http://x.example/tts' })
    expect(reg.list().map((e) => e.id)).toEqual(['http:import'])
  })

  it('失败回执只回显可定位身份：header / auth / 超长 jsLib 里的凭据与正文不进 message', async () => {
    const reg = await open()
    const token = 'Bearer SECRET-TOKEN-7f2a'
    const receipt = reg.importJson(JSON.stringify([
      {
        id: 'http:leaky',
        name: '长'.repeat(4_000),
        // 解析失败点是缺 url；下面这些字段本就不该被回显
        header: JSON.stringify({ Authorization: token }),
        jsLib: `function leak() { return ${JSON.stringify('x'.repeat(5_000))} }`,
        auth: { cookies: { sid: 'SECRET-COOKIE' }, loginInfo: { token } },
      },
      baidu,
    ]))
    expect(receipt.added).toBe(1)
    expect(receipt.updated).toBe(0)
    expect(receipt.failed.map((f) => f.index)).toEqual([0])
    const failed = must(receipt.failed[0], '失败回执')
    expect(failed.message, '仍能定位是哪一条').toContain('http:leaky')
    expect(failed.message, '凭据字段值不回显').not.toContain('SECRET')
    expect(JSON.stringify(receipt), '整份回执都不带凭据').not.toContain('SECRET')
    expect(failed.message, '超长 name 被投影截断').not.toContain('长'.repeat(400))
    // 200 字符投影 + 段级定位那一层 JSON 转义：上限远小于整条原始条目
    expect(failed.message.length).toBeLessThanOrEqual(600)
  })

  it('失败半径：坏条只剪自己并点名 index，其余照进', async () => {
    const reg = await open()
    const receipt = reg.importJson(JSON.stringify([
      null,                                     // 非对象
      { name: '甲' },                           // 缺 url
      { name: '乙', url: 42 },                  // url 非 string
      { url: 'http://c.example' },              // 缺 name
      { name: '丁', url: 'http://d.example' },  // 好
    ]))
    expect(receipt.added).toBe(1)
    expect(receipt.updated).toBe(0)
    expect(receipt.failed.map((f) => f.index)).toEqual([0, 1, 2, 3])
    expect(receipt.failed.every((f) => f.message.includes('朗读引擎条目'))).toBe(true)
    expect(reg.list().map((e) => e.name)).toEqual(['丁'])
  })

  it('单条坏对象不是整次失败：回执 failed[0]（只有顶层形状才整次抛）', async () => {
    const reg = await open()
    const receipt = reg.importJson(JSON.stringify({ name: '没有地址' }))
    expect(receipt).toEqual({ added: 0, updated: 0, failed: [{ index: 0, message: containing('url') }] })
    expect(reg.list()).toEqual([])
  })

  it('id 冲突 → updated 计数（不是 failed），记录被新内容覆盖', async () => {
    const reg = await open()
    reg.importJson(JSON.stringify(baidu))
    const receipt = reg.importJson(JSON.stringify({ ...baidu, name: '百度（新版）' }))
    expect(receipt).toEqual({ added: 0, updated: 1, failed: [] })
    expect(pick(reg.list(), 0).name).toBe('百度（新版）')
  })

  it('重新导入同一个 id 不抹掉盘上凭据（导入条不带 auth）', async () => {
    const dir = await tmp()
    const reg = await open(dir)
    reg.put('-100', { name: '百度', url: baidu.url, auth: { cookies: { sid: 'SECRET' } } })
    reg.importJson(JSON.stringify({ ...baidu, contentType: 'audio/mpeg' }))
    expect(must(reg.get('-100'), '导入更新后的引擎').auth?.cookies).toEqual({ sid: 'SECRET' })
    await reg.flush()
    expect(must((await TtsEngineRegistry.load(dir)).get('-100'), '重载后的引擎').auth?.cookies).toEqual({ sid: 'SECRET' })
  })

  it('空数组 → 全零回执', async () => {
    const reg = await open()
    expect(reg.importJson('[]')).toEqual({ added: 0, updated: 0, failed: [] })
  })

  it('顶层既非对象也非数组 / 非法 JSON → 整次失败（抛 InvalidRequestError），不落任何条目', async () => {
    const reg = await open()
    for (const bad of ['"nope"', '42', 'null', 'true']) {
      expect(() => reg.importJson(bad), bad).toThrow(InvalidRequestError)
    }
    expect(() => reg.importJson('{oops')).toThrow(InvalidRequestError)
    expect(reg.list()).toEqual([])
  })
})
