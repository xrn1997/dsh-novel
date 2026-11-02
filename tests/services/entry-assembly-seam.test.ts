import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { withoutComments } from '../without-comments.js'

/**
 * 条目装配消费面的缝宽守卫（G2）：搜索面 / 发现面 / 探针手里不许再出现 `EngineValue` 或它的
 * 值投影原语——链尾求值产物是**引擎 → 服务**的缝上类型，装配面只经 `bridge` 的读口消费，
 * 不自己接住中间值再转发。收窄只限这三处的消费面：目录/正文管线（`online-reading`）合法消费
 * `itemContextsOf` / `firstValue`，那些 export 必须原样在场，故本组也钉住保留面。
 *
 * 为什么不靠类型而靠源码扫描：`EngineValue` 只要被 import 就说明中间值跨过了缝，而它完全可以
 * 只出现在类型标注里、不改变任何运行行为——行为用例拦不住这种回潮。扫描剥注释（注释里点名
 * 符号是合法指路），但不剥字符串：本仓的证据有一大半正当住在串里（判据见 `without-comments`）。
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

function codeOf(rel: string): string {
  return withoutComments(readFileSync(join(ROOT, rel), 'utf8'))
}

/** 装配消费面三处：它们的共同点是「手里有求值器、却只该拿到业务串或条目上下文」。 */
const ENTRY_ASSEMBLY = [
  'src/services/search-face.ts',
  'src/services/explore-face.ts',
  'src/services/probe.ts',
] as const

/** 跨缝取值的形态：缝上类型本身 + 四个值投影原语 + 列表派生（它的入参就是一个 `EngineValue`）。 */
const SEAM_TOKENS = /EngineValue|firstValue|firstUrlValue|listValue|extractItems|itemContextsOf/

describe('条目装配面不跨缝取 EngineValue（G2 收窄边界）', () => {
  it.each(ENTRY_ASSEMBLY)('%s 剥注释后不含任何值投影原语', (rel) => {
    const hits = codeOf(rel).match(SEAM_TOKENS) ?? []
    expect(hits, `${rel} 仍在装配面接住 EngineValue 或自己转发投影：改走 bridge 的读口`).toEqual([])
  })

  it('正控：搜索面与发现面的列表求值走合成读口 listContextsOf', () => {
    // 删掉调用也能过上一组（禁词一条不剩），所以正控与禁词是同一枚钉子的两面
    for (const rel of ['src/services/search-face.ts', 'src/services/explore-face.ts']) {
      expect(codeOf(rel), `${rel} 没有走 listContextsOf：列表求值与条目派生被拆回了两处`).toMatch(/(?<![A-Za-z])listContextsOf\(/)
    }
  })

  it('正控：探针的书名读取走 fieldOf 读口（用途定档在门内）', () => {
    // 这条正控不会因「改回某个 *FieldOf」而假绿：正则大小写敏感，`urlFieldOf` / `auxFieldOf` /
    // `kindFieldOf`（大写 F）不命中 `fieldOf(`；改道者还得摘掉 `fieldOf` 的 import，否则
    // `noUnusedLocals` 让编译先红。前缀守卫保留，挡住将来同小写后缀（如 `xfieldOf`）的标识符。
    expect(codeOf('src/services/probe.ts')).toMatch(/(?<![A-Za-z_])fieldOf\(/)
  })

  it('保留面：bridge 仍 export 目录/正文管线与详情面共用的读口（G2 不越界内收）', () => {
    const code = codeOf('src/services/bridge.ts')
    for (const name of ['itemContextsOf', 'firstValue', 'hitFieldsOf']) {
      expect(code, `bridge 不再 export ${name}：online-reading / 详情面的合法消费被断了`)
        .toMatch(new RegExp(`export (?:async )?function ${name}\\b`))
    }
    for (const type of ['Page', 'SubRuleEval']) {
      expect(code, `bridge 不再 export 类型 ${type}：装配面的求值器缝跟着消失`)
        .toMatch(new RegExp(`export (?:interface|type) ${type}\\b`))
    }
  })
})
