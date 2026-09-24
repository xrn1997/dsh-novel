import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import * as semver from 'semver'

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
    expect(Array.isArray(pkg.dsh.client.inject)).toBe(true)
    expect(pkg.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-primitives')
    // 对话区 tab 注册已撤（docs/design/client.md 的单一归属口径）：dsh.client.inject 只是
    // boot graph 排序边——留一个运行时不再 import 的包 = 给极简 profile 留一条解析不开的死边
    expect(pkg.dsh.client.inject).not.toContain('@deepseek-ai/dsh-client-ui-conversation')
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
  it('peerDeps 覆盖宿主面：官方 @deepseek-ai/* 一律 peer，不进 dependencies', () => {
    expect(Object.keys(pkg.peerDependencies)).toEqual(
      expect.arrayContaining(['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery', 'react', 'react-dom']))
    // 官方包由宿主提供（收录规范：官方 @deepseek-ai/* 用 peerDependencies 声明）
    expect(Object.keys(pkg.dependencies).filter((name) => name.startsWith('@deepseek-ai/'))).toEqual([])
  })
  it('dsh-tools peer 区间必须放行我们正在跑的那一代（semver 预发布规则）', () => {
    const range = pkg.peerDependencies['@deepseek-ai/dsh-tools']
    const dev = pkg.devDependencies['@deepseek-ai/dsh-tools']
    // semver 的预发布规则：带预发布标签的版本，只有在某个比较符与它**同 major.minor.patch**、
    // 且该比较符自己也带预发布时才算满足。所以「>= 某代最低预发布 < 下一代-0」必须**逐代显式列出**——
    // 写成一个看着覆盖的大区间，实际只开了最低那代一层（本仓踩过：`>=0.1.5-rc.1 <0.1.6-0 ||
    // >=0.1.6-rc.1 <0.2.0-0` 只放行 0.1.5 系 3 个版本，连正在跑的 0.1.7-rc.1 都挡在外面）。
    // 判据走真解析器而不是查字符串形状：正则能证明「写了预发布」，证明不了「放行了这一代」。
    expect(semver.satisfies(dev, range)).toBe(true)
    // 上界必须挡住下一代：否则 0.2.0 一发就自动变成「被兼容」
    expect(semver.satisfies('0.2.0-rc.1', range)).toBe(false)
    // 下限的理由：三个硬 inject 里只有 `jobs` 有下限——`webServer`（补丁 id 写的是 `webserver`，
    // 按 camelCase grep 会漏）在 dsh-web-app 每个已发版本里都在，`tools` 连 0.0.1-rc.1 就有。
    // `jobs` 行在 dsh-base 侧从 0.0.1-rc.3 起就有，但那一版只有组件侧发过（`@deepseek-ai/dsh`
    // 与 dsh-web-app 都没有这版），所以**可安装的宿主**里最低带 jobs 的是 0.0.1-rc.5。
    // 故 0.0.1-rc.1 / -rc.2 必须挡在外面：缺 jobs 的宿主插进去整树拒绝挂载。
    expect(semver.satisfies('0.0.1-rc.2', range)).toBe(false)
  })
  it('cordis.patch.yml：单条 insert，name=包名', () => {
    expect(patch.trimStart().startsWith('- insert:')).toBe(true)
    expect(patch).toContain('id: dsh-novel')
    expect(patch).toContain("name: '@xrn1997/dsh-novel'")
    expect(patch.match(/- insert:/g)).toHaveLength(1)   // 双挂载 = 整树 boot 失败（调研 §风险 5）
  })
})
