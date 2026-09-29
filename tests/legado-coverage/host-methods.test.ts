/**
 * **判据①的第 4 层机器检查：对面 `java` 宿主方法面的缺席项必须逐字在册**（快照的第三个分母）。
 * 快照三个分母：路径集（`inventory-coverage`）、规则实体字段表（`upstream-fields`）、**java 方法名集
 * （本文件）**。第三个此前只被 parse-census 用来判「真源调了而本仓没挂」，于是有一整类缺席项永远
 * 不进任何判据：对面有、没人调、本仓没做、登记面也没说不适用——正是「把裁决写成遗忘」。
 *
 * 判据两侧都机械可数：快照里每个方法名**要么真实现**（问沙箱本体，见 `tests/java-surface.ts`）、
 * **要么在矩阵逐字点名**（`h-java-unmounted-uncalled` 及同族行），两边都对不上即红。
 *
 * **「挂在对象上」不等于「做到了」**：BOOTSTRAP 有一族抛「需要安卓宿主环境」的点名桩，出现在
 * `for (var n in java)` 里但语义是「如实拒绝」——判据因此取「在挂载面上**且不是桩**」（这个区分是
 * 门自己抓出来的：名册里引 `queryTTF` 时反向那半报「其实已挂载」，一查是桩；是收紧不是放宽）。
 *
 * 不判「未做即红」：零调用方就挂桥面 = 造没有需求方的机制（本仓反复拒的那类）；也不做前缀/大小写
 * 模糊匹配（会把 `getTag` 算成被 `getTags` 覆盖）。新名字的出路只有两条：真实现，或在矩阵逐字点名。
 * 快照缺失即红，不许 skip-if-missing。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { probeJavaSurface } from '../java-surface.js'
import { readSnapshot } from './upstream-facts.js'

const MATRIX = 'tests/legado-coverage/matrix.ts'

/** 三侧真值：本仓**真实现**的名字（扣掉点名桩）、矩阵的逐字点名判据、以及桩名单本身 */
async function surface() {
  const { names: mountedAll, stubs } = await probeJavaSurface()
  const implemented = new Set([...mountedAll].filter((n) => !stubs.has(n)))
  const matrix = readFileSync(MATRIX, 'utf8')
  // 逐字点名 = 矩阵文本里出现该名（前后不是标识符字符）
  const isNamed = (n: string) => new RegExp(`(^|[^A-Za-z0-9_])${n}([^A-Za-z0-9_]|$)`).test(matrix)
  return { mountedAll, stubs, implemented, matrix, isNamed }
}

describe('对面 java 宿主方法面：没做到的必须在矩阵里逐字点名', () => {
  it('快照的每个方法名要么真实现、要么被点名（两侧都机械可数）', async () => {
    const snapshot = readSnapshot()
    expect(existsSync(MATRIX), `覆盖矩阵读不到：${MATRIX}`).toBe(true)
    const { implemented, stubs, isNamed } = await surface()

    expect(snapshot.javaMethods.length, '快照的 java 方法名集过小，判据已失效——刷新快照').toBeGreaterThan(50)
    expect(implemented.size, '沙箱自报的实现面（扣掉点名桩）过小，探针或桩名单出了问题').toBeGreaterThan(20)

    const homeless = snapshot.javaMethods.filter((n) => !implemented.has(n) && !isNamed(n))
    const stubbed = snapshot.javaMethods.filter((n) => stubs.has(n))
    console.log(`[宿主方法面] 快照 ${snapshot.javaMethods.length} 名` +
      ` / 真实现 ${snapshot.javaMethods.filter((n) => implemented.has(n)).length}` +
      ` / 点名桩 ${stubbed.length}（${stubbed.join('/') || '无'}）` +
      ` / 未实现但已点名 ${snapshot.javaMethods.filter((n) => !implemented.has(n) && isNamed(n)).length}` +
      ` / 两边都不沾 ${homeless.length}`)
    expect(homeless, `这些对面宿主方法既没真实现、矩阵也没点名：${homeless.join(', ')}`).toEqual([])
  })

  it('反向：矩阵「未挂名册」里点名的名字不能其实已经真实现了（过期读数）', async () => {
    // 单向门只防漏登记；这半防的是**过期缺席项被当成裁决**：某条 note 写着「本仓没做 getX」，
    // 而后来真接进了桥面——读的人会照旧不去做，或反过来把已实现的当欠账再接一遍。
    // 比的是 implemented（不是 mountedAll）：点名桩本来就该出现在名册里，那是正当归属。
    const { implemented, matrix } = await surface()
    const row = matrix.split('\n').find((l) => l.includes("id: 'h-java-unmounted-uncalled'")) ?? ''
    expect(row.length, '矩阵里没有 h-java-unmounted-uncalled 行').toBeGreaterThan(0)
    // 反引号里的驼峰标识符 = 这行点名的宿主方法（全大写常量名与短散文词被形状筛挡掉）
    const cited = [...row.matchAll(/`([a-z][A-Za-z0-9_]{3,})`/g)].map((m) => m[1])
    expect(cited.length, '这行没点到方法名，判据退化').toBeGreaterThan(10)
    const stale = cited.filter((n) => implemented.has(n))
    expect(stale, `这些名字其实已真实现，却被列在未挂名册里：${stale.join(', ')}`).toEqual([])
  })
})
