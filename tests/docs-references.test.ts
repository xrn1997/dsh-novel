/**
 * 文档引用可解析——`docs/design/*.md` 是三个子系统的现状真相，它们指着不存在的文件就是误导。
 *
 * 为什么只校「文件存在」不校行号：`file.ts:<行号>` 会随上方任何一次编辑漂移，校行号等于造一道天天假红的门，
 * 人一旦习惯性忽略它，守卫就等于没有；文件级引用只在重命名 / 删除时失效——那是需要人明确处理的动作。
 * （行号形态本身由 `tests/legado-coverage/citation-liveness.test.ts` 禁掉。）
 *
 * 覆盖面：三份现状真相文档里出现的每个 `xxx.ts` / `xxx.tsx` / `xxx.mjs` 路径（模块地图、测试钉子表、
 * 已知开口的逐处引用都算）。外部项目的路径（第三方仓库、外部文档）不写成仓内路径，故不受影响。
 *
 * 这就是「文档跟着实现走」的机器守卫：改了文件名而文档还指着旧名字，这里会红。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DESIGN_DIR = join(ROOT, 'docs', 'design')
const DESIGN_DOCS = ['engine.md', 'services.md', 'client.md', 'legado-compat.md']
const SKIP_DIRS = new Set(['node_modules', 'lib', '.git'])
const SOURCE_EXT = /\.(?:tsx|ts|mjs)$/
/** `path/to/file.ts` 或带行号的写法（后者已被 citation-liveness 禁掉，这里只做定位剥离）。 */
const REF = /([A-Za-z0-9_\-./]+\.(?:tsx|ts|mjs))(?::\d+(?:-\d+)?)?/g

/** 仓库内所有可被文档引用的源文件（仓库相对路径，统一正斜杠）。 */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectSourceFiles(full, acc)
    else if (SOURCE_EXT.test(entry.name)) acc.push(relative(ROOT, full).split(sep).join('/'))
  }
  return acc
}

describe('文档引用可解析（docs/design/*.md）', () => {
  it('三份现状真相文档都在', () => {
    const present = readdirSync(DESIGN_DIR)
    expect(DESIGN_DOCS.filter((d) => !present.includes(d))).toEqual([])
  })

  it('每个源文件引用都真实存在（改名 / 删除后这里会红）', () => {
    const files = collectSourceFiles(ROOT)
    const known = new Set(files)
    const unresolved: string[] = []

    for (const doc of DESIGN_DOCS) {
      const lines = readFileSync(join(DESIGN_DIR, doc), 'utf8').split(/\r?\n/)
      lines.forEach((line, i) => {
        for (const m of line.matchAll(REF)) {
          const ref = m[1]
          if (ref.includes('*') || ref.startsWith('.')) continue // glob 或片段，不是路径
          if (known.has(ref) || files.some((f) => f.endsWith(`/${ref}`))) continue
          unresolved.push(`${doc}:${i + 1} → ${ref}`)
        }
      })
    }

    // 文档里写的是 `engine/select.ts` 这类相对片段，故按后缀匹配；匹配不到即文档指着不存在的文件。
    expect(unresolved).toEqual([])
  })
})
