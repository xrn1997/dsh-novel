/**
 * **规则字段面 → 矩阵归属**：对面 `data/entities/rule/*.kt` 里每一个规则字段，都必须在本仓的
 * 覆盖矩阵里有归属（`COVERAGE` 某一行的文本提到它，或在 `FIELD_OWNERSHIP` 里显式挂到某行并给理由）。
 *
 * 分母是**仓内快照**（`compat/upstream/snapshot.json`，由 `capture-upstream-snapshot.test.ts` 在开发
 * 阶段从对面 checkout 抽一次）。为什么不让判据现读对面 checkout：那份 checkout 是**开发阶段的输入**，
 * 不是本仓的运行前提——上游仓整仓下架、本机 checkout 搬盘都会让判据红，而红的原因与书源兼容性无关。
 * 快照入版本控制后，分母的每次变化都是一次可审的 diff。
 *
 * 为什么这道门比原先那份「清单」强：先前那份人手抄的字段清单不在库里——抄漏一条谁也发现不了，
 * 而且它一消失，以它为分母的检查会静默转 skip（引用活性那道门守的就是这件事）；而对面 rule
 * 实体类**就是格式的权威定义**，字段是机器可读的。上游加了字段（快照刷新时必然体现出来），
 * 这里直接报红，不需要任何人记得改笔记。
 *
 * 归属判据有意宽松在「名字对得上」，严格在「必须有主」：
 * - 本仓导入时会给字段换名（`lastChapter` → `ruleLastChapter` / `ruleDetailLastChapter`，
 *   见 `src/services/normalize.ts` 的字段映射表），所以按**大小写不敏感**且允许 `rule` 前缀匹配矩阵文本；
 * - 整块被裁决「环境不适用」的面（段评面）不要求逐字段建行，但要在 `FIELD_OWNERSHIP`
 *   里点名它挂哪一行、理由锚点在哪——**不登记就是没主**，红。
 * - `FIELD_OWNERSHIP` 里出现快照里已经没有的字段 = 僵尸条目，同样红（防止改了名就当已处理）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COVERAGE } from './matrix.js'
import { RULE_CLASSES, readSnapshot } from './upstream-facts.js'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

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

/** 矩阵是否认领这个字段：整词匹配，容忍本仓换名（首字母大写 + `rule` 前缀） */
function claimedByMatrix(field: string, matrixText: string): boolean {
  const forms = [field, `rule${field[0].toUpperCase()}${field.slice(1)}`]
  return forms.some(f => new RegExp(`(?<![A-Za-z0-9_])${f}(?![A-Za-z0-9_])`, 'i').test(matrixText))
}

const knownRows = new Set(COVERAGE.map(r => r.id))

describe('规则字段面 → 矩阵归属（分母＝仓内快照）', () => {
  it('FIELD_OWNERSHIP 每条都指向真实存在的矩阵行', () => {
    const orphan = Object.entries(FIELD_OWNERSHIP)
      .filter(([, v]) => !knownRows.has(v.row) || !v.why.trim())
      .map(([f, v]) => `${f} → ${v.row}`)
    expect(orphan, `归属指向了不存在的行或没写理由：${orphan.join(' / ')}`).toEqual([])
  })

  it(`${RULE_CLASSES.length} 个规则实体的每个字段都有归属`, () => {
    const snap = readSnapshot()
    const missingClass = RULE_CLASSES.filter(c => (snap.ruleFields[c] ?? []).length === 0)
    expect(missingClass, `快照里这些实体没有字段：${missingClass.join(' / ')}（刷新快照或对账实体清单）`).toEqual([])

    const matrixText = fs.readFileSync(path.join(ROOT, 'tests', 'legado-coverage', 'matrix.ts'), 'utf8')
    const fields = new Set(Object.values(snap.ruleFields).flat())
    expect(fields.size).toBeGreaterThan(30) // 防快照退化导致读空

    const unowned = [...fields].filter(f => !FIELD_OWNERSHIP[f] && !claimedByMatrix(f, matrixText)).sort()
    const zombies = Object.keys(FIELD_OWNERSHIP).filter(f => !fields.has(f)).sort()
    expect(
      { unowned, zombies },
      `对面字段共 ${fields.size} 个。无归属（矩阵没提、也没登记）：${unowned.join(' / ') || '无'}；` +
      `登记了但快照里已无此字段（僵尸）：${zombies.join(' / ') || '无'}`,
    ).toEqual({ unowned: [], zombies: [] })
  })
})
