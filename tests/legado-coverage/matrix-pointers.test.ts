/**
 * **「指矩阵行 id」这条纪律的另外一半：那个 id 必须还存在。** 外部出处只许四处、其余指行 id 的
 * 口径已由 `citation-liveness.test.ts` 管「不许指外面」，这一门管「指的那一行在不在」——行改名/
 * 删掉后指针静默落到不存在的地址，读的人找不到登记就把裁决当成"没登记过"重问一遍。
 *
 * 判据只吃窄形状：「矩阵」/「矩阵行」后面紧跟的 kebab-case 记号 = 行 id 指针，须在 `COVERAGE` 里
 * 现查得到；带 `*` 的族指认（`a-replace-tail-*`）要求至少命中一行。刻意不扫其它反引号 kebab 串
 * （配置键、CSS 类名、测试标题片段）——扫它们会把门变成豁免表，同 `docs-module-symbols.test.ts`
 * 只吃「唯一实现」那句的理由：判据的力量来自形状窄。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { COVERAGE } from './matrix.js'

const POINTER = /矩阵(?:行)?\s*[`'“"]?([a-z][a-z0-9]*(?:-[a-z0-9]+)+)(\*)?/g

function trackedFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) trackedFiles(p, acc)
    else if (/\.(ts|tsx|md)$/.test(name)) acc.push(p)
  }
  return acc
}

describe('矩阵行 id 指针：指的那一行必须还在', () => {
  const ids = new Set(COVERAGE.map((r) => r.id))

  it('全仓「矩阵 <id>」形态的指针都能在 COVERAGE 里查到', () => {
    const dangling: string[] = []
    let pointers = 0
    for (const file of [...trackedFiles('src'), ...trackedFiles('tests'), ...trackedFiles('docs'),
      'README.md', 'AGENTS.md', 'CONTEXT.md']) {
      const txt = readFileSync(file, 'utf8')
      txt.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(POINTER)) {
          const [, id, wildcard] = m
          pointers++
          const ok = wildcard
            ? COVERAGE.some((r) => r.id.startsWith(id))
            : ids.has(id)
          if (!ok) dangling.push(`${file}:${i + 1}  矩阵 ${id}${wildcard ?? ''}（行不在册）`)
        }
      })
    }
    // 空转防线：这条判据靠"仓里确实有几十处指针"成立，指针数骤降说明形状改了而非都对了
    expect(pointers, '全仓只认出极少行 id 指针——抽取形状与本仓写法不符，判据已空转').toBeGreaterThan(20)
    expect(dangling, `这些指针指着不存在的矩阵行（改名/删行没同步指针）：\n  ${dangling.join('\n  ')}`).toEqual([])
  })

  it('每条 open 行的行 id 在设计文档这一侧可达（不许只活在矩阵里）', () => {
    // 反向那半。AGENTS.md 把「改哪块先读那份文档的『已知开口』」定成接活入口，而矩阵是排队面——
    // 一条 open 行若只在矩阵里，读设计文档的人根本走不到它，效果等同于没登记。
    // **矩阵文件本身不算引用**（它当然含每个 id，混进 corpus 这条判据就恒真）。
    const corpus = ['engine', 'services', 'client', 'legado-compat']
      .map((f) => readFileSync(`docs/design/${f}.md`, 'utf8')).join('\n') +
      readFileSync('CONTEXT.md', 'utf8') + readFileSync('README.md', 'utf8')
    const open = COVERAGE.filter((r) => r.status === 'open')
    expect(open.length, 'open 行为空——本层的分母没了，判据恒真').toBeGreaterThan(10)
    // **整词匹配，不用子串**：`corpus.includes(id)` 会让 `h-rhino-javaimporter-scope-MOVED`
    // 这种"改名后残留的旧名前缀"照样算命中（红检就是这么发现的），而改名恰恰是本判据要抓的事。
    const wholeWord = (id: string) =>
      new RegExp(`(^|[^a-z0-9-])${id.replace(/-/g, '\\-')}(?![a-z0-9-])`)
    const unmentioned = open.filter((r) => !wholeWord(r.id).test(corpus))
    expect(unmentioned.map((r) => r.id),
      `这些 open 行的行 id 在 docs/design/*.md + CONTEXT.md + README.md 里一次都没出现（要么并进别行、要么在对应文档的已知开口留一条可达项）：\n  ` +
      unmentioned.map((r) => `${r.id} :: ${r.capability.slice(0, 40)}`).join('\n  ')).toEqual([])
  })
})
