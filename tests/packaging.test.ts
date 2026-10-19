import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import * as semver from 'semver'
import { NOVEL_GLYPH_PATH, NOVEL_GLYPH_VIEWBOX } from '../src/client/novel-glyph.js'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
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
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

describe('包形态声明', () => {
  it('入口与 exports', () => {
    expect(pkg.main).toBe('lib/index.js')
    expect(pkg.types).toBe('lib/index.d.ts')
    expect(pkg.exports['./client']).toBe('./lib/client.js')
    expect(pkg.exports['.'].default).toBe('./lib/index.js')
  })
  it('dsh 声明（嵌套形态，client-modules 与 plugin add 依赖它）', () => {
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(pkg.dsh.client.platform).toBe('web')
    // 零 require 的到达依赖已摘，boot 不再绑一个用不到的包行。
    // dsh.client.inject 是包名依赖边（宿主 client-modules 的 WebBootEntry，可选），与运行时
    // 服务名 inject 两套；client bundle 的 require 集合里没有 ui-primitives，声明它 = 过度声明，
    // 激活期与别的解析失败聚合成 AggregateError。
    expect(pkg.dsh.client.inject).toBeUndefined()
    // 「对话区 tab 已撤 / 单一归属」由 tests/client/panel-registration.test.tsx 钉（座位集合），
    // 这里不留一条对着 undefined 的空断言。
  })
  it('兼容面声明：编译所依的宿主必须在册，且状态词只许「compatible」', () => {
    const releases = pkg.dsh.compatibility?.dshReleases
    expect(releases).toBeDefined()
    // 编译所依的 dsh-tools 号 = 宿主号（官方包同号下发）：它必须自己就在册，
    // 否则就是拿一版没声明过的类型面在编译
    const dev = pkg.devDependencies['@deepseek-ai/dsh-tools']
    expect(releases[dev]).toBe('compatible')   // 本轮实测：dump-config 挂载 + 工具真调用
    // 只许出现已验过的状态词：多一个 'unknown' / 'incompatible' 就是把「没验过」写进兼容门面
    expect([...new Set(Object.values(releases))]).toEqual(['compatible'])
  })
  it('编译期 dsh-tools：精确钉版 + 不早于已声明兼容的最新宿主（否则漂移 typecheck 抓不住）', () => {
    const dev = pkg.devDependencies['@deepseek-ai/dsh-tools']
    // 精确版本（不带 ^/>=）：契约对齐口径——range 会让「今天绿」随安装悄悄漂
    expect(dev).toMatch(/^\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?$/)
    // 已声明兼容的宿主版本里取最高宿主，逐位比到预发布序号
    const newest = Object.keys(pkg.dsh.compatibility.dshReleases)
      .map(verTuple)
      .reduce((a, b) => (cmpVer(b, a) > 0 ? b : a))
    // devDep 编译于比声称兼容的宿主更老的类型面 = 假绿
    expect(cmpVer(verTuple(dev), newest)).toBeGreaterThanOrEqual(0)
  })
  it('files 含 lib 与 cordis.patch.yml', () => {
    expect(pkg.files).toContain('lib')
    expect(pkg.files).toContain('cordis.patch.yml')
  })
  it('展示元信息：icon 与 locale meta 随包导出（宿主未激活也读，缺失即落包名与默认插画）', () => {
    expect(pkg.icon).toBe('./icon.svg')
    expect(pkg.exports['./icon']).toBe('./icon.svg')
    expect(pkg.exports['./locale/*.json']).toBe('./locale/*.json')
    expect(pkg.files).toEqual(expect.arrayContaining(['locale', 'icon.svg']))
    const icon = readFileSync('icon.svg', 'utf8')
    expect(icon).toContain('<svg')
    // 宿主把解析后的主题写成根节点 color-scheme，SVG 内部据此切换深浅两档颜色
    expect(icon).toContain('prefers-color-scheme: dark')
    expect(Buffer.byteLength(icon)).toBeLessThanOrEqual(256 * 1024)
    for (const lang of ['zh', 'en']) {
      const { meta } = JSON.parse(readFileSync(`locale/${lang}.json`, 'utf8'))
      expect(typeof meta.title).toBe('string')
      expect(meta.title.trim().length).toBeGreaterThan(0)
      expect(typeof meta.description).toBe('string')
      expect(meta.description.trim().length).toBeGreaterThan(0)
    }
  })
  it('图标字形与侧栏组件同一份 pathData（静态资源不能 import 单点，测试对齐）', () => {
    const icon = readFileSync('icon.svg', 'utf8')
    expect(icon).toContain(`viewBox="${NOVEL_GLYPH_VIEWBOX}"`)
    expect(icon).toContain(`d="${NOVEL_GLYPH_PATH}"`)
  })
  it('peerDeps 覆盖宿主面：官方 @deepseek-ai/* 一律 peer，不进 dependencies', () => {
    expect(Object.keys(pkg.peerDependencies)).toEqual(
      expect.arrayContaining(['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery', 'react', 'react-dom']))
    // 官方包由宿主提供（收录规范：官方 @deepseek-ai/* 用 peerDependencies 声明）
    expect(Object.keys(pkg.dependencies).filter((name) => name.startsWith('@deepseek-ai/'))).toEqual([])
  })
  it('dsh-tools peer 区间按宿主线开口——线内 rc / patch 放行，跨线挡住', () => {
    const range = pkg.peerDependencies['@deepseek-ai/dsh-tools']
    const dev = pkg.devDependencies['@deepseek-ai/dsh-tools']
    // 宿主安装闸按 `includePrerelease` 比较 peer 区间：一条连续区间即可放行线内所有 rc / patch，
    // 不必逐代开口。这里钉区间语义而不是字符串形状——线内自动放行，跨到下一宿主线才要重验。
    // 比较模式必须与宿主一致：若按默认 semver（排除预发布）来验，会得出相反读数。
    const asHost = (v: string): boolean => semver.satisfies(v, range, { includePrerelease: true })
    expect(asHost(dev)).toBe(true)
    // 线内下一个 rc / patch 跟着放行：宿主升级不再要求本插件同步发一版
    expect(asHost('0.2.2-rc.1')).toBe(true)
    // 上界必须挡住**下一条宿主线**：0.3 起要先真机验过再开口
    expect(asHost('0.3.0-rc.1')).toBe(false)
    // 下限的理由：三个硬 inject 里只有 `jobs` 有下限——`webServer`（补丁 id 写的是 `webserver`，
    // 按 camelCase grep 会漏）在 dsh-web-app 每个已发版本里都在，`tools` 连 0.0.1-rc.1 就有。
    // `jobs` 行在 dsh-base 侧从 0.0.1-rc.3 起就有，但那一版只有组件侧发过（`@deepseek-ai/dsh`
    // 与 dsh-web-app 都没有这版），所以**可安装的宿主**里最低带 jobs 的是 0.0.1-rc.5。
    // 故 0.0.1-rc.1 / -rc.2 必须挡在外面：缺 jobs 的宿主插进去整树拒绝挂载。
    expect(asHost('0.0.1-rc.2')).toBe(false)
    expect(asHost('0.0.1-rc.5')).toBe(true)
  })
  it('cordis.patch.yml：单条 insert，name=包名', () => {
    expect(patch.trimStart().startsWith('- insert:')).toBe(true)
    expect(patch).toContain('id: dsh-novel')
    expect(patch).toContain("name: '@xrn1997/dsh-novel'")
    expect(patch.match(/- insert:/g)).toHaveLength(1)   // 双挂载 = 整树 boot 失败（调研 §风险 5）
  })
})
