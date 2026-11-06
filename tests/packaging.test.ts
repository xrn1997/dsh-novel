import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import * as semver from 'semver'
import { NOVEL_GLYPH_PATH, NOVEL_GLYPH_VIEWBOX } from '../src/client/novel-glyph.js'

/**
 * `package.json` / locale 文件的读数面：`JSON.parse` 交出来的是 unknown，这里按路径逐段取。
 * 这是**发布产物清单门**，所以取法必须是「取不到就抛」——静默读到 undefined 会让下面的
 * toBe 断言变成「两个 undefined 相等」的假绿。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function at(root: unknown, ...path: string[]): unknown {
  let cur = root
  for (const key of path) {
    if (!isRecord(cur)) throw new Error(`清单路径 ${path.join('.')} 在 ${key} 处不是对象`)
    if (!(key in cur)) throw new Error(`清单缺键：${path.join('.')}`)
    cur = cur[key]
  }
  return cur
}

function textAt(root: unknown, ...path: string[]): string {
  const value = at(root, ...path)
  if (typeof value !== 'string') throw new Error(`清单 ${path.join('.')} 不是字符串`)
  return value
}

function recordAt(root: unknown, ...path: string[]): Record<string, unknown> {
  const value = at(root, ...path)
  if (!isRecord(value)) throw new Error(`清单 ${path.join('.')} 不是对象`)
  return value
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string')
}

function stringsAt(root: unknown, ...path: string[]): string[] {
  const value = at(root, ...path)
  if (!isStringArray(value)) throw new Error(`清单 ${path.join('.')} 不是字符串数组`)
  return value
}

const jsonOf = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'))

const pkg = jsonOf('package.json')
const patch = readFileSync('cordis.patch.yml', 'utf8')

/** 宿主版本号 → 可比较元组 `[major, minor, patch, 预发布档, 预发布序号]`。
 *  预发布档：无预发布(2) > rc(1) > alpha(0)——DSH 已发过 alpha / rc 两档。
 *  不认识的档位直接抛（宁炸不猜）：静默归到某一档会让版本比较悄悄给出错的次序。 */
const verTuple = (v: unknown): number[] => {
  if (typeof v !== 'string') throw new Error(`兼容声明里出现非字符串版本号：${JSON.stringify(v)}`)
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/)
  if (m === null) throw new Error(`认不出的宿主版本号：${v}`)
  const [, major, minor, patch, label, num] = m
  if (label !== undefined && label !== 'rc' && label !== 'alpha') {
    throw new Error(`认不出的预发布档（只认 alpha / rc，无预发布即稳定版）：${v}`)
  }
  const tier = label === undefined ? 2 : label === 'rc' ? 1 : 0
  return [Number(major), Number(minor), Number(patch), tier, label === undefined ? 0 : Number(num)]
}
/** 逐位比较到预发布序号。**不截断到 minor**：宿主按 `0.1.N-rc.M` 递增，截断会让
 *  `0.1.5-rc.2 → 0.1.7-rc.1`、`0.1.7-rc.1 → 0.1.8-rc.1` 这类同代漂移静默通过。 */
const cmpVer = (a: number[], b: number[]): number => {
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    // 两侧元组由 verTuple 恒造 5 位；长度不齐说明有别的构造口混进来，宁可炸也不给出错的次序
    if (x === undefined || y === undefined) throw new Error('版本元组长度不一致：两侧都该是 5 位')
    if (x !== y) return x - y
  }
  return 0
}

describe('包形态声明', () => {
  it('入口与 exports', () => {
    expect(at(pkg, 'main')).toBe('lib/index.js')
    expect(at(pkg, 'types')).toBe('lib/types/index.d.ts')
    expect(at(pkg, 'exports', './client', 'types')).toBe('./lib/types/client/index.d.ts')
    expect(at(pkg, 'exports', './client', 'default')).toBe('./lib/client.js')
    expect(at(pkg, 'exports', '.', 'default')).toBe('./lib/index.js')
    expect(at(pkg, 'exports', '.', 'types')).toBe('./lib/types/index.d.ts')
  })
  it('dsh 声明（嵌套形态，client-modules 与 plugin add 依赖它）', () => {
    expect(at(pkg, 'dsh', 'bundle', 'patch')).toBe('./cordis.patch.yml')
    expect(at(pkg, 'dsh', 'client', 'platform')).toBe('web')
    // dsh.client.inject 是**包名**依赖边（宿主 client-modules 的 WebBootEntry，可选），与客户端
    // 条目里那份**服务名** inject 是两套东西：这条只管激活期排序，不产生运行时 import，
    // 所以 client bundle 的 require 集合仍只有平台模块表里那些（见 tsdown.config.ts）。
    // locale 是唯一的在册条目：文案字典靠 ctx.get('locale') 读宿主语言服务。这条边只保证包
    // 按序到达；服务本身由 locale 包的 immediately 在正常组合里先提供——apply 时读一次，
    // 晚到/缺席退回内置中文（ADR-0038），不炸。
    // client bundle 的 require 集合只有宿主静态模块表里的 react 两条（ADR-0067）：配置页走
    // `ctx.remote.settings`，不引任何宿主 client 包，因此没有其它到达依赖可声明。
    expect(stringsAt(pkg, 'dsh', 'client', 'inject')).toEqual(['@deepseek-ai/dsh-client-locale'])
    // 「对话区 tab 已撤 / 单一归属」由 tests/client/panel-registration.test.tsx 钉（座位集合），
    // 本文件不重复那条读数，只钉包声明面。
  })
  it('兼容面声明：编译所依的宿主必须在册，且状态词只许「compatible」', () => {
    const releases = at(pkg, 'dsh', 'compatibility', 'dshReleases')
    expect(releases).toBeDefined()
    // 编译所依的 dsh-tools 号 = 宿主号（官方包同号下发）：它必须自己就在册，
    // 否则就是拿一版没声明过的类型面在编译
    const dev = textAt(pkg, 'devDependencies', '@deepseek-ai/dsh-tools')
    expect(at(releases, dev)).toBe('compatible')   // 在册即声称实测过：每一版「真跑了什么」住把它加进册的那次提交正文，注释不抄那份读数
    // 只许出现已验过的状态词：多一个 'unknown' / 'incompatible' 就是把「没验过」写进兼容门面
    expect([...new Set(Object.values(recordAt(releases)))]).toEqual(['compatible'])
  })
  it('编译期 dsh-tools：精确钉版 + 不早于已声明兼容的最新宿主（否则漂移 typecheck 抓不住）', () => {
    const dev = textAt(pkg, 'devDependencies', '@deepseek-ai/dsh-tools')
    // 精确版本（不带 ^/>=）：契约对齐口径——range 会让「今天绿」随安装悄悄漂
    expect(dev).toMatch(/^\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?$/)
    // 已声明兼容的宿主版本里取最高宿主，逐位比到预发布序号
    const newest = Object.keys(recordAt(pkg, 'dsh', 'compatibility', 'dshReleases'))
      .map(verTuple)
      .reduce((a, b) => (cmpVer(b, a) > 0 ? b : a))
    // devDep 编译于比声称兼容的宿主更老的类型面 = 假绿
    expect(cmpVer(verTuple(dev), newest)).toBeGreaterThanOrEqual(0)
  })
  it('files 含 lib 与 cordis.patch.yml', () => {
    expect(stringsAt(pkg, 'files')).toContain('lib')
    expect(stringsAt(pkg, 'files')).toContain('cordis.patch.yml')
  })
  it('展示元信息：icon 与 locale meta 随包导出（宿主未激活也读，缺失即落包名与默认插画）', () => {
    expect(at(pkg, 'icon')).toBe('./icon.svg')
    expect(at(pkg, 'exports', './icon')).toBe('./icon.svg')
    expect(at(pkg, 'exports', './locale/*.json')).toBe('./locale/*.json')
    expect(stringsAt(pkg, 'files')).toEqual(expect.arrayContaining(['locale', 'icon.svg']))
    const icon = readFileSync('icon.svg', 'utf8')
    expect(icon).toContain('<svg')
    // 宿主把解析后的主题写成根节点 color-scheme，SVG 内部据此切换深浅两档颜色
    expect(icon).toContain('prefers-color-scheme: dark')
    expect(Buffer.byteLength(icon)).toBeLessThanOrEqual(256 * 1024)
    for (const lang of ['zh', 'en']) {
      const meta = recordAt(jsonOf(`locale/${lang}.json`), 'meta')
      expect(typeof meta.title).toBe('string')
      expect(textAt(meta, 'title').trim().length).toBeGreaterThan(0)
      expect(typeof meta.description).toBe('string')
      expect(textAt(meta, 'description').trim().length).toBeGreaterThan(0)
    }
  })
  it('图标字形与侧栏组件同一份 pathData（静态资源不能 import 单点，测试对齐）', () => {
    const icon = readFileSync('icon.svg', 'utf8')
    expect(icon).toContain(`viewBox="${NOVEL_GLYPH_VIEWBOX}"`)
    expect(icon).toContain(`d="${NOVEL_GLYPH_PATH}"`)
  })
  it('peerDeps 覆盖宿主面：官方 @deepseek-ai/* 一律 peer，不进 dependencies', () => {
    expect(Object.keys(recordAt(pkg, 'peerDependencies'))).toEqual(
      expect.arrayContaining(['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery', 'react', 'react-dom']))
    // 官方包由宿主提供（收录规范：官方 @deepseek-ai/* 用 peerDependencies 声明）
    expect(Object.keys(recordAt(pkg, 'dependencies')).filter((name) => name.startsWith('@deepseek-ai/'))).toEqual([])
  })
  it('dsh-tools peer 区间按宿主线开口——线内 rc / patch 放行，跨线挡住', () => {
    const range = textAt(pkg, 'peerDependencies', '@deepseek-ai/dsh-tools')
    const dev = textAt(pkg, 'devDependencies', '@deepseek-ai/dsh-tools')
    // 宿主安装闸按 `includePrerelease` 比较 peer 区间：一条连续区间即可放行线内所有 rc / patch，
    // 不必逐代开口。这里钉区间语义而不是字符串形状——线内自动放行，跨到下一宿主线才要重验。
    // 比较模式必须与宿主一致：若按默认 semver（排除预发布）来验，会得出相反读数。
    const asHost = (v: string): boolean => semver.satisfies(v, range, { includePrerelease: true })
    expect(asHost(dev)).toBe(true)
    // 线内下一个 rc / patch 跟着放行：宿主升级不再要求本插件同步发一版
    expect(asHost('0.2.2-rc.1')).toBe(true)
    // 上界必须挡住**下一条宿主线**：0.3 起要先真机验过再开口
    expect(asHost('0.3.0-rc.1')).toBe(false)
    // 下限的理由是**任务输出契约**：0.1.7-rc.1 起 `JobSpec` 才有 `output` 拉源（注册表按自己的
    // 字节游标拉 `read(fromByte)`）；更早的 0.1 宿主只有 hooks 上的消费式 `readOutput`，本插件按
    // 新契约接线，装进去任务过程行会静默丢失。区间与实测名单的事实源都在 `package.json`
    // （两层的关系见 `ADR-0020`），这里只钉区间语义：低于下限必须挡，实测名单最早的 rc 必须放行。
    expect(asHost('0.1.5-rc.3')).toBe(false)      // 旧契约：hooks 上的 readOutput
    expect(asHost('0.1.6-alpha.2')).toBe(false)   // 同上，仍未出现 output 拉源
    expect(asHost('0.1.7-rc.1')).toBe(true)       // output 拉源从这一版开始
  })
  it('cordis.patch.yml：单条 insert，name=包名', () => {
    expect(patch.trimStart().startsWith('- insert:')).toBe(true)
    expect(patch).toContain('id: dsh-novel')
    expect(patch).toContain("name: '@xrn1997/dsh-novel'")
    expect(patch.match(/- insert:/g)).toHaveLength(1)   // 双挂载 = 整树 boot 失败（调研 §风险 5）
  })
})
