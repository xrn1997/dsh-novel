/**
 * **对面事实快照的生成器（门控：`DSH_CAPTURE_UPSTREAM=1`，默认不跑）**。
 *
 * 这是「借鉴参考仓」唯一剩下的运行时用途：把闸门要用的对面事实（两个源根的路径集、7 个规则实体的
 * 字段表、java 宿主方法名集）抽出来冻进 `compat/upstream/snapshot.json`。冻完之后：
 * - 三个判据（`upstream-fields` / `citation-liveness` / `parse-census` 的面 B）只读快照，
 *   运行时**不再需要**任何外部 checkout——上游下架、checkout 搬盘都不再影响本仓判据；
 * - 需要跟上游对账时，人再跑本文件刷新一次快照，差值会进版本控制、可见可审。
 *
 * 与 `tests/compat/capture.test.ts` 同款形态：工具入库、产物入库、生成需要外部输入（那边要网络，
 * 这边要 checkout）。缺席即抛，不静默产半份快照。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  JS_HOST_FILE, RULE_CLASSES, RULE_DIR, SNAPSHOT_PATH, UPSTREAM_ROOTS,
  fieldsOf, javaMethodNames, listFiles,
} from './upstream-facts.js'

const DEFAULT_REF = 'C:/develop/GitHub/legado-with-MD3'

describe.skipIf(process.env.DSH_CAPTURE_UPSTREAM !== '1')('刷新对面事实快照（开发阶段工具）', () => {
  it('从对面 checkout 抽事实 → compat/upstream/snapshot.json', { timeout: 120_000 }, () => {
    const ref = process.env.DSH_LEGADO_REF ?? DEFAULT_REF
    if (!fs.existsSync(ref)) {
      throw new Error(
        `对面 checkout 不在场：${ref}\n` +
        '  刷新快照需要一份对面 checkout（DSH_LEGADO_REF 指路）；闸门运行时不需要它。',
      )
    }

    // 路径集：两个源根下的全部文件（引用活性判据的分母）
    const paths: string[] = []
    for (const root of UPSTREAM_ROOTS) {
      const abs = path.join(ref, root)
      if (!fs.existsSync(abs)) throw new Error(`对面源根不在场：${abs}（源根改名即需同步本文件与闸门）`)
      paths.push(...listFiles(abs))
    }
    paths.sort()

    // 字段面：7 个规则实体的字段名
    const ruleFields: Record<string, string[]> = {}
    for (const cls of RULE_CLASSES) {
      const p = path.join(ref, UPSTREAM_ROOTS[0], RULE_DIR, `${cls}.kt`)
      if (!fs.existsSync(p)) throw new Error(`对面的 ${cls}.kt 不在场：${p}（上游改名/挪目录，归属表要跟着对账）`)
      ruleFields[cls] = fieldsOf(fs.readFileSync(p, 'utf8')).sort()
    }

    // java 宿主方法名集
    const jsHost = path.join(ref, UPSTREAM_ROOTS[0], JS_HOST_FILE)
    if (!fs.existsSync(jsHost)) throw new Error(`对面的 ${JS_HOST_FILE} 不在场：${jsHost}`)
    const javaMethods = javaMethodNames(fs.readFileSync(jsHost, 'utf8'))

    const commit = ((): string => {
      try {
        return execFileSync('git', ['-C', ref, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
      } catch { return 'unknown' }
    })()

    const snapshot = {
      meta: {
        repo: 'HapeLee/legado-with-MD3（上游 gedoor/legado 已下架，fork 是活着的出处）',
        commit,
        capturedAt: new Date().toISOString().slice(0, 10),
        roots: UPSTREAM_ROOTS,
        refresh: 'DSH_CAPTURE_UPSTREAM=1 pnpm vitest run tests/legado-coverage/capture-upstream-snapshot.test.ts（需 DSH_LEGADO_REF 指向对面 checkout）',
      },
      paths,
      ruleFields,
      javaMethods,
    }

    // 防退化：抽空即判据失效，宁可生成失败也不落一份空分母
    expect(paths.length, '源根路径集抽空了').toBeGreaterThan(1000)
    expect(Object.keys(ruleFields).length).toBe(RULE_CLASSES.length)
    expect(javaMethods.length, 'java 方法名抽少了').toBeGreaterThan(50)

    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true })
    fs.writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    console.log(`快照已写入 ${SNAPSHOT_PATH}（${paths.length} 条路径 / ${javaMethods.length} 个方法 / commit ${commit.slice(0, 8)}）`)
  })
})
