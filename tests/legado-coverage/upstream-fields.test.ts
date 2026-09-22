/**
 * **对面字段面 → 矩阵归属**：对面 `data/entities/rule/*.kt` 里每一个规则字段，都必须在本仓的
 * 覆盖矩阵里有归属（`COVERAGE` 某一行的文本提到它，或在 `FIELD_OWNERSHIP` 里显式挂到某行并给理由）。
 *
 * 为什么这道门比原先那份「清单」强：先前那份人手抄的字段清单不在库里——抄漏一条谁也发现不了，
 * 而且它一消失，以它为分母的检查会静默转 skip（引用活性那道门守的就是这件事）；而对面 rule
 * 实体类**就是格式的权威定义**，字段是机器可读的。上游加了字段
 * （legado-with-MD3 还在合并上游，本仓已两次被分母漂移坑过），这里直接报红，不需要任何人记得改笔记。
 *
 * 归属判据有意宽松在「名字对得上」，严格在「必须有主」：
 * - 本仓导入时会给字段换名（legado `ruleBookInfo.lastChapter` → `ruleLastChapter` /
 *   `ruleDetailLastChapter`，见 `src/services/normalize.ts` 的字段映射表），所以按**大小写不敏感**
 *   且允许 `rule` 前缀匹配矩阵文本；
 * - 整块被裁决「环境不适用」的面（段评 ReviewRule）不要求逐字段建行，但要在 `FIELD_OWNERSHIP`
 *   里点名它挂哪一行、理由锚点在哪——**不登记就是没主**，红。
 * - `FIELD_OWNERSHIP` 里出现对面已经没有的字段 = 僵尸条目，同样红（防止改了名就当已处理）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COVERAGE } from './matrix.js'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const DEFAULT_REF = 'C:/develop/GitHub/legado-with-MD3'
const REF = process.env.DSH_LEGADO_REF ?? DEFAULT_REF
const REF_OFF = REF === 'off'

/** 对面的规则实体类：书源 JSON 里每个 rules 容器各对应一份 */
const RULE_CLASSES = [
  'BookInfoRule', 'BookListRule', 'ExploreRule', 'SearchRule', 'TocRule', 'ContentRule', 'ReviewRule',
]
/** `jsonDeserializer` 是 companion object 的解析器成员，不是书源字段 */
const NOT_A_FIELD = new Set(['jsonDeserializer'])

/**
 * 整块裁决 / 换名归属：字段 → 它由哪条矩阵行承担。每条都要理由，理由里点出锚点。
 */
const FIELD_OWNERSHIP: Record<string, { row: string; why: string }> = {
  avatarRule: { row: 'j-review', why: '段评面整块不接，见 docs/design/legado-compat.md「不适用：评论与段评面」' },
  postTimeRule: { row: 'j-review', why: '同上：段评面整块不接' },
  reviewQuoteUrl: { row: 'j-review', why: '同上：段评面整块不接' },
  voteUpUrl: { row: 'j-review', why: '同上：段评面整块不接' },
  voteDownUrl: { row: 'j-review', why: '同上：段评面整块不接' },
  postReviewUrl: { row: 'j-review', why: '同上：段评面整块不接' },
  postQuoteUrl: { row: 'j-review', why: '同上：段评面整块不接' },
  deleteUrl: { row: 'j-review', why: '同上：段评面整块不接（且是写操作，本仓无写评论面）' },
}

/** 对面源根：规则实体在 main 源根 */
const RULE_DIR = 'app/src/main/java/io/legado/app/data/entities/rule'

/** 从一个 Kotlin data class 里取字段名（`override var chapterList: String? = null` → chapterList） */
function fieldsOf(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/^\s*(?:override\s+)?(?:var|val)\s+([A-Za-z][A-Za-z0-9]*)\s*:/gm)) {
    if (!NOT_A_FIELD.has(m[1])) out.push(m[1])
  }
  return out
}

/** 矩阵是否认领这个字段：整词匹配，容忍本仓换名（首字母大写 + `rule` 前缀） */
function claimedByMatrix(field: string, matrixText: string): boolean {
  const forms = [field, `rule${field[0].toUpperCase()}${field.slice(1)}`]
  return forms.some(f => new RegExp(`(?<![A-Za-z0-9_])${f}(?![A-Za-z0-9_])`, 'i').test(matrixText))
}

const knownRows = new Set(COVERAGE.map(r => r.id))

describe('对面规则字段面 → 矩阵归属（分母直接读对面源码）', () => {
  it('FIELD_OWNERSHIP 每条都指向真实存在的矩阵行', () => {
    const orphan = Object.entries(FIELD_OWNERSHIP)
      .filter(([, v]) => !knownRows.has(v.row) || !v.why.trim())
      .map(([f, v]) => `${f} → ${v.row}`)
    expect(orphan, `归属指向了不存在的行或没写理由：${orphan.join(' / ')}`).toEqual([])
  })

  const gate = REF_OFF ? it.skip : it
  gate(`${RULE_CLASSES.length} 个对面规则实体的每个字段都有归属（参考仓 ${REF}）`, () => {
    if (!fs.existsSync(path.resolve(REF, RULE_DIR))) {
      throw new Error(
        `对面参考仓不在场：${REF}\n` +
        '  字段面分母读不到就不判——请 checkout 并设 DSH_LEGADO_REF，或显式 DSH_LEGADO_REF=off。',
      )
    }
    const matrixText = fs.readFileSync(path.join(ROOT, 'tests', 'legado-coverage', 'matrix.ts'), 'utf8')
    const fields = new Set<string>()
    for (const cls of RULE_CLASSES) {
      const p = path.resolve(REF, RULE_DIR, `${cls}.kt`)
      expect(fs.existsSync(p), `对面的 ${cls}.kt 不在了：${p}（上游改名 / 挪目录，归属表要跟着对账）`).toBe(true)
      for (const f of fieldsOf(fs.readFileSync(p, 'utf8'))) fields.add(f)
    }
    expect(fields.size).toBeGreaterThan(30) // 防对面重构导致读空

    const unowned = [...fields].filter(f => !FIELD_OWNERSHIP[f] && !claimedByMatrix(f, matrixText)).sort()
    const zombies = Object.keys(FIELD_OWNERSHIP).filter(f => !fields.has(f)).sort()
    expect(
      { unowned, zombies },
      `对面字段共 ${fields.size} 个。无归属（矩阵没提、也没登记）：${unowned.join(' / ') || '无'}；` +
      `登记了但对面已无此字段（僵尸）：${zombies.join(' / ') || '无'}`,
    ).toEqual({ unowned: [], zombies: [] })
  })
})
