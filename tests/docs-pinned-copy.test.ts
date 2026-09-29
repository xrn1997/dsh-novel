/**
 * 文档钉子文案守卫（docs ↔ src 双侧一致）：`docs/design/client.md` 与 `README.md` 用引号引用的
 * 用户可见文案必须真实存在于 `src/`，否则文档在描述一个不存在的界面（2026 审查实证：README 还在
 * 教用户点已退役的入口）。`docs-references.test.ts` 只守文件路径，本文件守文案；反向也断言钉子在
 * 文档里有引用，防清单变孤本。
 * 覆盖面是**手工清单**而非全文提取（引号还用于概念引用，全自动提取必误报）；src 侧扫**剥注释后**
 * 的源码——影子文案不算命中（UI 串删了、注释留着，文档会继续教人认不存在的按钮）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DOCS = [join(ROOT, 'docs', 'design', 'client.md'), join(ROOT, 'README.md')]

/** 钉子文案：src/ 原文 ↔ 文档引用，两侧都要在（哪一侧漂了这里都红） */
const PINNED = [
  '搜书名 / 作者',
  '书架空空——上方搜一本书开始阅读',
  '可以关掉页面，任务在服务端继续',
  '原始文件不受影响',
  '＋ 导入书源',
  '聚合全部书源',
  '批量重验',
  '一键验证',
  '书城未上线',
  '选择或拖入 legado 书源文件',
  '导入是后台任务——提交后本窗自动关闭，任务在服务端继续',
  '停止搜索',
  '来源已删除',
  '删除所选',
  // 本地书（TXT / EPUB）导入面（2026-09）：上传入口收两种格式、导入说明可在阅读器重看、
  // 导出面板点明只有文字。三条都是用户照着文档找得到的控件/口径，双侧必须同源。
  '导入 TXT / EPUB',
  '导入说明',
  'TXT 文字导出，不包含图片',
]

function collectText(dir: string, ext: RegExp): string {
  const acc: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (ext.test(e.name)) acc.push(readFileSync(p, 'utf8'))
    }
  }
  walk(dir)
  return acc.join('\n')
}

/** 剥注释——只认块注释与**整行**注释（`//`、` * `、`/*` 开头），字符串里的 `//`（URL）不碰。
 *  理由：UI 文案删掉后若在注释里留了个影子，本守卫会当它还在，文档就继续教人认一个不存在的按钮。 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}

describe('守卫自身的可红性', () => {
  it('只活在注释里的文案不算 src 命中；字符串里的不算注释', () => {
    expect(stripComments('/* 书城未上线 */\n// 又一处\nconst x = 1')).not.toContain('书城未上线')
    expect(stripComments('const a = "https://x/书城未上线"')).toContain('书城未上线')
  })
})

describe('文档钉子文案 ↔ src/ 两侧一致', () => {
  const src = stripComments(collectText(join(ROOT, 'src'), /\.tsx?$/))
  const docs = DOCS.map((d) => readFileSync(d, 'utf8')).join('\n')

  for (const s of PINNED) {
    it(`「${s}」在 src/ 与文档两侧都在`, () => {
      expect(src, `src/ 里找不到钉子文案——文档在教人认不存在的界面（或清单该同步删除该钉）`).toContain(s)
      expect(docs, `文档里找不到钉子引用——钉子清单与文档脱节（补文档引用或从清单移除）`).toContain(s)
    })
  }
})
