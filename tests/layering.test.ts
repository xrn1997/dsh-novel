import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

/**
 * 仓内方向守卫：`docs/architecture.md` §2「Node 半的分层与依赖方向」（外加浏览器半那条）
 * 的机器版——§4 是语义的主人清单，不是方向表。
 *
 * 为什么要有这一道：此前「services 不许反向 import api」只有人眼与一次 grep 守着，破了
 * 不会有任何东西变红；跨插件那一头有 `tsdown.config.ts` 的 dsh-novel-bundle-purity，
 * 仓内这一头一直是空白。本门随 `pnpm test` 跑，不额外要一条命令。
 *
 * 为什么不用 dependency-cruiser：它的 engines 是 ^22 / ^24 / >=26，本机 node 25 直接拒跑
 * ——装上来跑不起来的闸不算闸。这里只取本仓真正需要的那一小截（静态 import 的方向、值环、
 * wire 的运行时依赖），与 copy-guard / comment-altitude 同用 ts 的 AST，不引新依赖。
 *
 * 射程：静态 import 与所有 `export ... from`。动态 import 本门看不见方向，故单独管：不许指仓内，
 * 且出现新动态 import 必须登记进 `DYNAMIC_IMPORTS_OK`（现存唯一一处只够 `node:worker_threads`
 * ——沙箱的 worker 惰性装载）。
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url))

/** 一条 import 边：所在文件（`src/` 前缀、`/` 分隔）、被引 specifier、是否只在类型面 */
type Edge = { from: string; spec: string; typeOnly: boolean }

/** 层名即 `src/` 下的一级目录；根上的 `index.ts`（组合根）与 `config.ts` 归 'root' */
const layerOf = (rel: string): string => {
  const seg = rel.split('/')[1] ?? ''
  return /\.(ts|tsx)$/.test(seg) ? 'root' : seg
}

/** from 层不许够到的 to 层（允许：向下、向 shared、root 够一切） */
const FORBIDDEN: ReadonlyArray<{ from: string; to: readonly string[]; why: string }> = [
  { from: 'engine', to: ['services', 'api', 'tools', 'client'], why: '规则引擎不认识服务与界面' },
  { from: 'services', to: ['api', 'tools', 'client'], why: '服务层不许够路由面与工具面' },
  { from: 'api', to: ['tools', 'client'], why: 'HTTP 面与 AI 工具面各自独立，不许互抄' },
  { from: 'tools', to: ['api', 'client'], why: '同上' },
  { from: 'shared', to: ['engine', 'services', 'api', 'tools', 'client'], why: 'shared 是两半共同的叶子' },
  { from: 'client', to: ['api', 'services', 'engine', 'tools'], why: '浏览器半只经 shared/wire 与 Node 半对话' },
]

/** 收一个文件的静态 import 与所有 `export ... from` 边。
 *  `import type { X }` 的标志在 importClause 上（不在声明节点上——读错过一次，整仓的类型边
 *  会全数冒充值边、凭空长出几个环）；行内 `import { type X, Y }` 按值边算：宁可多认一条边，
 *  不可漏认一条方向。具名 re-export 同样收；只有全类型 specifier 才算类型边。 */
function edgesOf(rel: string, code: string): Edge[] {
  const file = ts.createSourceFile(rel, code, ts.ScriptTarget.Latest, true)
  const edges: Edge[] = []
  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const spec = (node.moduleSpecifier as ts.StringLiteral).text
      edges.push({ from: rel, spec, typeOnly: node.importClause?.isTypeOnly === true })
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const clause = node.exportClause
      const allType = clause !== undefined && ts.isNamedExports(clause)
        && clause.elements.every((e) => e.isTypeOnly)
      edges.push({ from: rel, spec: (node.moduleSpecifier as ts.StringLiteral).text, typeOnly: node.isTypeOnly || allType })
    }
    ts.forEachChild(node, walk)
  }
  walk(file)
  return edges
}

/** specifier 折成仓内相对路径（纯词法，不碰真实 fs——合成负例要在没有磁盘文件时也解析得动）；
 *  非仓内（npm、宿主平台模块、Node 内建）返回 null */
function resolveSpec(fromRel: string, spec: string, exists: (p: string) => boolean): string | null {
  if (!spec.startsWith('.')) return null
  const segs = fromRel.split('/').slice(0, -1).concat(spec.split('/'))
  const out: string[] = []
  for (const s of segs) {
    if (s === '' || s === '.') continue
    if (s === '..') out.pop()
    else out.push(s)
  }
  // 桶形 specifier（`../engine/index.js` / `./copy/index.js`）要按 `<dir>/index.ts(x)` 找：
  // 早先那版先剥掉尾上的 `index` 再去旁找 `engine.ts`，整类桶边在图上失明（方向与值环一起假绿）。
  const stem = out.join('/').replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, '')
  for (const cand of [`${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, `${stem}/index.tsx`]) {
    if (exists(cand)) return cand
  }
  return null
}

type Violation = { kind: 'direction' | 'cycle' | 'wire'; where: string; detail: string }

/** 纯函数：给定「相对路径 → 边」的图，报方向违例、wire 运行时依赖与值环（按强连通分量报） */
function checkGraph(edgesByFile: ReadonlyMap<string, readonly Edge[]>): Violation[] {
  const files = [...edgesByFile.keys()]
  const exists = (p: string): boolean => files.includes(p)
  const out: Violation[] = []

  for (const [file, edges] of edgesByFile) {
    const from = layerOf(file)
    const runtime = edges.filter((e) => !e.typeOnly)
    if (file === 'src/shared/wire.ts' && runtime.length > 0) {
      out.push({ kind: 'wire', where: file, detail: `wire.ts 要零运行时依赖，却有 ${runtime.length} 条值 import` })
    }
    for (const e of edges) {
      const target = resolveSpec(file, e.spec, exists)
      if (target === null) continue
      const bad = FORBIDDEN.find((r) => r.from === from && r.to.includes(layerOf(target)))
      if (bad !== undefined) {
        out.push({ kind: 'direction', where: `${file} -> ${target}`, detail: `${from} 不许够 ${layerOf(target)}（${bad.why}）` })
      }
    }
  }

  // 值环：类型边不参与——类型互相引用在 TS 里合法，不制造「两个主人」
  const adj = new Map<string, string[]>()
  for (const [file, edges] of edgesByFile) {
    adj.set(file, edges.filter((e) => !e.typeOnly)
      .map((e) => resolveSpec(file, e.spec, exists))
      .filter((t): t is string => t !== null))
  }
  for (const scc of strongComponents(adj)) {
    out.push({ kind: 'cycle', where: scc.join(' '), detail: `${scc.length} 个模块互相依赖成环` })
  }
  return out
}

/** Tarjan 强连通分量：只报非平凡环（成员数多于一个，或自环）。按环成员集合定形，
 *  环内再加一条边不改变读数——基线才不会天天漂 */
function strongComponents(adj: ReadonlyMap<string, readonly string[]>): string[][] {
  let counter = 0
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const sccs: string[][] = []
  const strong = (node: string): void => {
    index.set(node, counter); low.set(node, counter); counter += 1
    stack.push(node); onStack.add(node)
    for (const next of adj.get(node) ?? []) {
      if (!index.has(next)) { strong(next); low.set(node, Math.min(low.get(node)!, low.get(next)!)) }
      else if (onStack.has(next)) { low.set(node, Math.min(low.get(node)!, index.get(next)!)) }
    }
    if (low.get(node) === index.get(node)) {
      const comp: string[] = []
      for (;;) {
        const m = stack.pop()!
        onStack.delete(m)
        comp.push(m)
        if (m === node) break
      }
      const selfLoop = comp.length === 1 && (adj.get(comp[0]) ?? []).includes(comp[0])
      if (comp.length > 1 || selfLoop) sccs.push(comp.sort())
    }
  }
  for (const node of adj.keys()) if (!index.has(node)) strong(node)
  return sccs
}

/** 真图：src/** 全量，路径统一成 `src/…` 的 `/` 分隔形态 */
const walkDir = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const abs = join(dir, name)
  if (statSync(abs).isDirectory()) return walkDir(abs)
  return /\.(ts|tsx)$/.test(name) ? [abs] : []
})

const REAL = new Map<string, string>(
  walkDir(SRC).map((abs) => [`src/${abs.slice(SRC.length + 1).split(sep).join('/')}`, readFileSync(abs, 'utf8')]),
)
const REAL_EDGES = (): Map<string, Edge[]> =>
  new Map([...REAL].map(([rel, code]) => [rel, edgesOf(rel, code)]))

/** 允许出现动态 import 的文件（本门看不见动态边的方向，新出现即红、登记后再放行）：
 *  `js-sandbox.ts` 的那处只够 `node:worker_threads`（沙箱 worker 惰性装载） */
const DYNAMIC_IMPORTS_OK = new Set<string>(['src/engine/js-sandbox.ts'])

describe('仓内方向守卫', () => {
  it('真图零方向违例：六组规则全清', () => {
    expect(checkGraph(REAL_EDGES()).filter((v) => v.kind === 'direction')).toEqual([])
  })

  it('真图零 wire 运行时依赖', () => {
    expect(checkGraph(REAL_EDGES()).filter((v) => v.kind === 'wire')).toEqual([])
  })

  it('值环零：src 的值面是一张 DAG（类型边不算环，见 strongComponents 上面那条注释）', () => {
    expect(checkGraph(REAL_EDGES()).filter((v) => v.kind === 'cycle')).toEqual([])
  })

  it('探测器本身有负例：反向 import、值环、wire 依赖各报一条', () => {
    const dir = new Map<string, Edge[]>([
      ['src/engine/a.ts', [{ from: 'src/engine/a.ts', spec: '../services/b.js', typeOnly: false }]],
      ['src/services/b.ts', []],
    ])
    expect(checkGraph(dir).filter((v) => v.kind === 'direction')).toHaveLength(1)

    const barrel = new Map<string, Edge[]>([
      ['src/engine/a.ts', [{ from: 'src/engine/a.ts', spec: '../services/index.js', typeOnly: false }]],
      ['src/services/index.ts', []],
    ])
    expect(checkGraph(barrel).filter((v) => v.kind === 'direction')).toHaveLength(1)

    const cyc = new Map<string, Edge[]>([
      ['src/services/x.ts', [{ from: 'src/services/x.ts', spec: './y.js', typeOnly: false }]],
      ['src/services/y.ts', [{ from: 'src/services/y.ts', spec: './x.js', typeOnly: false }]],
    ])
    expect(checkGraph(cyc).filter((v) => v.kind === 'cycle').map((v) => v.where))
      .toEqual(['src/services/x.ts src/services/y.ts'])

    const wire = new Map<string, Edge[]>([
      ['src/shared/wire.ts', [{ from: 'src/shared/wire.ts', spec: './cookies.js', typeOnly: false }]],
      ['src/shared/cookies.ts', []],
    ])
    expect(checkGraph(wire).filter((v) => v.kind === 'wire')).toHaveLength(1)
  })

  it('类型面的反向引用照样算方向违例（不许靠「只是类型」绕过这张表）', () => {
    const dir = new Map<string, Edge[]>([
      ['src/engine/a.ts', [{ from: 'src/engine/a.ts', spec: '../services/b.js', typeOnly: true }]],
      ['src/services/b.ts', []],
    ])
    expect(checkGraph(dir).filter((v) => v.kind === 'direction')).toHaveLength(1)
    expect(checkGraph(dir).filter((v) => v.kind === 'cycle')).toHaveLength(0)
  })

  it(`import type 与 import { type X } 的分别要认得——整条类型边不许冒充值边`, () => {
    const a = edgesOf('src/a.ts', `import type { X } from './b.js'`)
    expect(a).toEqual([{ from: 'src/a.ts', spec: './b.js', typeOnly: true }])
    const b = edgesOf('src/a.ts', `import { type X, y } from './b.js'`)
    expect(b[0].typeOnly).toBe(false)
  })

  it('具名 re-export 也是值边；只有全类型 specifier 才算类型边', () => {
    expect(edgesOf('src/a.ts', `export { x } from './b.js'`))
      .toEqual([{ from: 'src/a.ts', spec: './b.js', typeOnly: false }])
    expect(edgesOf('src/a.ts', `export { type X } from './b.js'`)[0].typeOnly).toBe(true)
    expect(edgesOf('src/a.ts', `export * from './b.js'`)[0].typeOnly).toBe(false)
    expect(edgesOf('src/a.ts', `export type * from './b.js'`)[0].typeOnly).toBe(true)
  })

  it('wire 只禁值边：import type 不算运行时依赖', () => {
    const wireType = new Map<string, Edge[]>([
      ['src/shared/wire.ts', [{ from: 'src/shared/wire.ts', spec: './types.js', typeOnly: true }]],
      ['src/shared/types.ts', []],
    ])
    expect(checkGraph(wireType).filter((v) => v.kind === 'wire')).toEqual([])
  })

  it('浏览器半经 wire 之外的路够 Node 半即红', () => {
    const bad = new Map<string, Edge[]>([
      ['src/client/x.ts', [
        { from: 'src/client/x.ts', spec: '../services/reading.js', typeOnly: false },
        { from: 'src/client/x.ts', spec: '../tools/tools.js', typeOnly: false },
      ]],
      ['src/services/reading.ts', []],
      ['src/tools/tools.ts', []],
    ])
    expect(checkGraph(bad).map((v) => v.where)).toEqual([
      'src/client/x.ts -> src/services/reading.ts',
      'src/client/x.ts -> src/tools/tools.ts',
    ])
  })

  it(`动态 import 不许指仓内，出现新动态 import 须登记进 DYNAMIC_IMPORTS_OK（本门看不见它的方向，这条把口子钉住）`, () => {
    const dyn = new Map<string, string[]>()
    for (const [rel, code] of REAL) {
      const file = ts.createSourceFile(rel, code, ts.ScriptTarget.Latest, true)
      const hits: string[] = []
      const walk = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0] as ts.Node)) {
          hits.push((node.arguments[0] as ts.StringLiteral).text)
        }
        ts.forEachChild(node, walk)
      }
      walk(file)
      if (hits.length > 0) dyn.set(rel, hits)
    }
    for (const [rel, specs] of dyn) {
      expect(specs.filter((s) => s.startsWith('.')), `动态 import 不许指仓内：${rel}`).toEqual([])
    }
    expect(new Set(dyn.keys()), '新动态 import 须登记进 DYNAMIC_IMPORTS_OK（本门看不见它的方向）')
      .toEqual(DYNAMIC_IMPORTS_OK)
  })

  it('真图每一条相对 specifier 都解析得到（解析不动的边在方向与值环检查里失明，不许有）', () => {
    const edges = REAL_EDGES()
    const blind = [...edges].flatMap(([rel, es]) =>
      es.filter((e) => e.spec.startsWith('.') && resolveSpec(rel, e.spec, (p) => edges.has(p)) === null)
        .map((e) => `${rel} -> ${e.spec}`))
    expect(blind).toEqual([])
    // 桶边不再失明：`../engine/index.js` 是 api/services 两层的公共入口，它必须在解析结果里
    const resolved = [...edges].flatMap(([rel, es]) =>
      es.map((e) => resolveSpec(rel, e.spec, (p) => edges.has(p)))).filter((p) => p !== null)
    expect(resolved).toContain('src/engine/index.ts')
  })
})
