import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { withoutComments } from '../without-comments.js'
import { NOVEL_CSS } from '../../src/client/styles.js'

/**
 * 宿主设计 token 词表守卫（防「引用了宿主根本不存在的 token」这类静默失败）：不存在的别名
 * 不报错、只静默落回硬编码 fallback，深浅两态都不再跟随宿主（深色适配曾被它拖住）。
 * 词表取自宿主 `@deepseek-ai/dsh-client-ui-theme` 的 design-platform CSS（光/暗两套同名），冻结
 * 在此以免测试依赖宿主安装路径；宿主升级改名 token 时更新本词表（那是契约变了的信号）。
 */
const HOST_TOKENS = new Set<string>([
  "--dsw-alias-bg-base", "--dsw-alias-bg-layer-1", "--dsw-alias-bg-layer-2",
  "--dsw-alias-bg-layer-3", "--dsw-alias-bg-mask-1", "--dsw-alias-bg-mask-2",
  "--dsw-alias-bg-mask-3", "--dsw-alias-bg-mask-drop", "--dsw-alias-bg-mask-photo",
  "--dsw-alias-bg-module-platform", "--dsw-alias-bg-multi-select", "--dsw-alias-bg-overlay",
  "--dsw-alias-bg-skeleton", "--dsw-alias-border-inverted", "--dsw-alias-border-inverted2",
  "--dsw-alias-border-l1", "--dsw-alias-border-l2", "--dsw-alias-border-l2-darkmode-thin",
  "--dsw-alias-border-l3", "--dsw-alias-border-l4", "--dsw-alias-brand-primary",
  "--dsw-alias-brand-primary-invert", "--dsw-alias-brand-primary-new-colorprimary-new-color", "--dsw-alias-brand-text",
  "--dsw-alias-button-contrast-fill", "--dsw-alias-button-elevated-fill", "--dsw-alias-button-floating-fill",
  "--dsw-alias-button-floating-hover", "--dsw-alias-button-ghost-active-border", "--dsw-alias-button-ghost-active-fill",
  "--dsw-alias-button-ghost-active-hover", "--dsw-alias-button-info-fill", "--dsw-alias-button-info-hover",
  "--dsw-alias-button-primary-dimmed", "--dsw-alias-button-primary-fill", "--dsw-alias-button-primary-hover",
  "--dsw-alias-button-tool-bar-fill", "--dsw-alias-button-tool-bar-fill-invisible", "--dsw-alias-button-tool-bar-hover",
  "--dsw-alias-interactive-bg-active", "--dsw-alias-interactive-bg-hover", "--dsw-alias-interactive-bg-hover-accent",
  "--dsw-alias-interactive-bg-hover-danger", "--dsw-alias-interactive-bg-hover-solid", "--dsw-alias-label-caption",
  "--dsw-alias-label-dimmed", "--dsw-alias-label-primary", "--dsw-alias-label-primary-bluish",
  "--dsw-alias-label-primary-dimmed", "--dsw-alias-label-primary-foreground", "--dsw-alias-label-primary-inverted",
  "--dsw-alias-label-secondary", "--dsw-alias-label-tertiary", "--dsw-alias-link",
  "--dsw-alias-markdown-citation", "--dsw-alias-markdown-code-block", "--dsw-alias-markdown-code-block-banner",
  "--dsw-alias-markdown-code-segment-selected", "--dsw-alias-markdown-code-segment-unselected", "--dsw-alias-markdown-inline-code",
  "--dsw-alias-markdown-placeholder", "--dsw-alias-markdown-tag", "--dsw-alias-scrollbar-bg-l1",
  "--dsw-alias-scrollbar-bg-l2", "--dsw-alias-scrollbar-hover-l1", "--dsw-alias-scrollbar-hover-l2",
  "--dsw-alias-state-business-primary", "--dsw-alias-state-business-tertiary", "--dsw-alias-state-error-primary",
  "--dsw-alias-state-error-secondary", "--dsw-alias-state-success-primary", "--dsw-alias-state-success-secondary",
  "--dsw-alias-state-success-tertiary", "--dsw-alias-state-warn-label", "--dsw-alias-state-warn-primary",
  "--dsw-alias-state-warn-secondary", "--dsw-alias-state-warn-tertiary", "--dsw-alias-toast-bg",
  "--dsw-alias-tooltip-bg", "--dsw-specific-bubble", "--dsw-specific-bubble-highlight",
  "--dsw-specific-input-major", "--dsw-specific-login-input", "--dsw-specific-menu",
  "--dsw-specific-selector", "--dsw-specific-sidebar-fill", "--dsw-specific-sidebar-nav-item-active",
  "--dsw-specific-sidebar-nav-item-active-accent", "--dsw-specific-sidebar-nav-item-hover", "--dsw-specific-tip",
  "--dsw-static-amber-100", "--dsw-static-amber-400", "--dsw-static-amber-500",
  "--dsw-static-amber-600", "--dsw-static-amber-900", "--dsw-static-blue-100",
  "--dsw-static-blue-300", "--dsw-static-blue-400", "--dsw-static-blue-450",
  "--dsw-static-blue-50", "--dsw-static-blue-500", "--dsw-static-blue-50p",
  "--dsw-static-blue-600", "--dsw-static-blue-75", "--dsw-static-blue-800",
  "--dsw-static-blue-900", "--dsw-static-blue-950", "--dsw-static-deepseek-100",
  "--dsw-static-deepseek-200", "--dsw-static-deepseek-300", "--dsw-static-deepseek-400",
  "--dsw-static-deepseek-450", "--dsw-static-deepseek-50", "--dsw-static-deepseek-500",
  "--dsw-static-deepseek-600", "--dsw-static-deepseek-700-delete", "--dsw-static-deepseek-800",
  "--dsw-static-deepseek-900", "--dsw-static-green-100", "--dsw-static-green-400",
  "--dsw-static-green-500", "--dsw-static-green-900", "--dsw-static-neutral-00",
  "--dsw-static-neutral-100", "--dsw-static-neutral-1000", "--dsw-static-neutral-150",
  "--dsw-static-neutral-200", "--dsw-static-neutral-250", "--dsw-static-neutral-300",
  "--dsw-static-neutral-400", "--dsw-static-neutral-50", "--dsw-static-neutral-500",
  "--dsw-static-neutral-550", "--dsw-static-neutral-600", "--dsw-static-neutral-700",
  "--dsw-static-neutral-800", "--dsw-static-neutral-850", "--dsw-static-neutral-900",
  "--dsw-static-neutral-bluish-00", "--dsw-static-neutral-bluish-100", "--dsw-static-neutral-bluish-1000",
  "--dsw-static-neutral-bluish-150", "--dsw-static-neutral-bluish-200", "--dsw-static-neutral-bluish-300",
  "--dsw-static-neutral-bluish-400", "--dsw-static-neutral-bluish-50", "--dsw-static-neutral-bluish-500",
  "--dsw-static-neutral-bluish-60", "--dsw-static-neutral-bluish-600", "--dsw-static-neutral-bluish-700",
  "--dsw-static-neutral-bluish-75", "--dsw-static-neutral-bluish-750", "--dsw-static-neutral-bluish-800",
  "--dsw-static-neutral-bluish-850", "--dsw-static-neutral-bluish-875", "--dsw-static-neutral-bluish-900",
  "--dsw-static-neutral-bluish-950", "--dsw-static-red-100", "--dsw-static-red-400",
  "--dsw-static-red-50", "--dsw-static-red-500", "--dsw-static-red-600",
  "--dsw-static-red-900",
])

const clientDir = fileURLToPath(new URL('../../src/client/', import.meta.url))

function clientSources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(entry.name)) out.push({ file: path.relative(clientDir, p), text: readFileSync(p, 'utf8') })
    }
  }
  walk(clientDir)
  return out
}

describe('宿主 token 词表守卫（--dsw-* 必须是宿主真名）', () => {
  const sources = clientSources()

  it('扫到源码（守卫本身别空转）', () => {
    expect(sources.length).toBeGreaterThan(5)
  })

  it('client 全部源码引用的 --dsw-* 都在宿主词表内', () => {
    const bad: string[] = []
    for (const { file, text } of sources) {
      for (const m of text.matchAll(/var\(\s*(--dsw-[\w-]+)/g)) {
        if (!HOST_TOKENS.has(m[1])) bad.push(`${file}: ${m[1]}`)
      }
    }
    expect(bad, `引用了宿主不存在的 token（会静默落回 fallback）：\n${bad.join('\n')}`).toEqual([])
  })

  it('NOVEL_CSS 里引用的 --dsw-* 都在宿主词表内', () => {
    const bad: string[] = []
    for (const m of NOVEL_CSS.matchAll(/var\(\s*(--dsw-[\w-]+)/g)) {
      if (!HOST_TOKENS.has(m[1])) bad.push(m[1])
    }
    expect(bad).toEqual([])
  })

  it('词表自身没有「仅单态存在」的假 token（border-l / bg-layer-4 是两个已踩过的坑）', () => {
    expect(HOST_TOKENS.has('--dsw-alias-border-l')).toBe(false)
    expect(HOST_TOKENS.has('--dsw-alias-bg-layer-4')).toBe(false)
    // l1..l4 四级齐全、层板止于 layer-3
    for (const l of ['l1', 'l2', 'l3', 'l4']) expect(HOST_TOKENS.has(`--dsw-alias-border-${l}`)).toBe(true)
    for (const n of ['1', '2', '3']) expect(HOST_TOKENS.has(`--dsw-alias-bg-layer-${n}`)).toBe(true)
  })
})

/**
 * hex 字面量守卫：上面的 --dsw-* 词表守卫只查宿主 token 真名，管不住视图内联
 * brand hex——SettingsSourceList/SettingsImportPane 曾内联 #2f6feb14/1f/44 与 #79a8ff 绕开
 * token seam（宿主换 brand 即全部失联）。本守卫扫 client 全源码的 hex 字面量，白名单只有两处：
 *  ① token 定义处本身（styles.tsx：fallback 与 .novel-dark 钉值的唯一住址）；
 * ② 钉死的正文层色值（正文层永不接 token——paperInk 两端字色 / 纸张预设 / 默认纸色）。
 * 视图里再出现任何非白名单 hex 即红。
 */
const HEX_ALLOWED: Record<string, string[] | '*'> = {
  'styles.tsx': '*',
  'util.ts': ['#222', '#e8e8ea'],                                   // paperInk 深/浅字（正文层）
  'prefs-ui.ts': ['#f7f3e8', '#ffffff', '#e8f0e8', '#f0e8e8'],      // 四款纸张预设（正文层）
  'store.ts': ['#f7f3e8'],                                          // DEFAULT_PREFS.paperColor（正文层）
}

/** 颜色字面量的**两种形态**都算：hex，以及带字面量成分的颜色函数（`rgb()/rgba()/hsl()/hsla()/color-mix()`）。
 *  口径是「**派生色只准住 token 层**」，所以 `color-mix(in srgb, var(--novel-brand) 8%, transparent)`
 *  这种「基于 token 的派生」同样只准写在 token 层，写在视图里即红。
 *  白名单（`HEX_ALLOWED`）只列 hex 值，函数形态没有白名单——只有整文件 `'*'`（token 层）放行。 */
const COLOR_LITERAL_RE = /#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?|color-mix)\s*\(/g

/** 注释先剥掉再扫（`tests/without-comments.ts` 单点）：口径是「**代码里**不准内联颜色」，
 *  注释里提一句 `rgb()` 不是内联色。 */

function scanColorLiterals(sources: Array<{ file: string; text: string }>): string[] {
  const bad: string[] = []
  for (const { file, text } of sources) {
    const allowed = HEX_ALLOWED[file]
    for (const m of withoutComments(text).matchAll(COLOR_LITERAL_RE)) {
      const lit = m[0].toLowerCase().replace(/\s+$/, '')
      if (allowed === '*') continue
      if (allowed !== undefined && allowed.includes(lit)) continue
      bad.push(`${file}: ${lit}`)
    }
  }
  return bad
}

describe('颜色字面量守卫（派生色只准住 token 层，视图内联即红）', () => {
  it('client 全源码除白名单外零颜色字面量（hex 与 rgb()/hsl()/color-mix() 两种形态）', () => {
    const bad = scanColorLiterals(clientSources())
    expect(bad, `视图/逻辑层出现内联颜色（应改引 --novel-* token；正文层色值加白名单）：\n${bad.join('\n')}`).toEqual([])
  })

  it('负断言：守卫自身有效——假视图里的 brand hex 会被抓出来', () => {
    expect(scanColorLiterals([{ file: 'views/Fake.tsx', text: "style={{ background: '#2f6feb14' }} " }]))
      .toEqual(['views/Fake.tsx: #2f6feb14'])
  })

  it('负断言：白名单文件里的非白名单 hex 也照抓（util.ts 再写 #123 就红）', () => {
    expect(scanColorLiterals([{ file: 'util.ts', text: "return '#123'" }])).toEqual(['util.ts: #123'])
  })

  // 2026-09-28 补：此前只扫 hex，`rgba(...)`/`color-mix(...)` 写进视图能绕过守卫（登记的已知开口 #2）
  it('负断言：函数形态同样抓——视图里写死 rgba() 即红', () => {
    expect(scanColorLiterals([{ file: 'views/Fake.tsx', text: 'style={{ background: "rgba(0,0,0,.45)" }}' }]))
      .toEqual(['views/Fake.tsx: rgba('])
  })

  it('负断言：基于 token 的 color-mix() 派生写在视图里也抓（派生色只准住 token 层）', () => {
    expect(scanColorLiterals([{ file: 'views/Fake.tsx', text: 'background: color-mix(in srgb, var(--novel-brand) 8%, transparent);' }]))
      .toEqual(['views/Fake.tsx: color-mix('])
  })

  it('注释里的颜色提法不抓（口径是「代码里不准内联」）——util.ts 的 `// … rgb()` 说明就是这一条', () => {
    expect(scanColorLiterals([{ file: 'views/Fake.tsx', text: '// 非 hex（color input 也可能给 rgb()）：退回原行为\nconst a = 1' }]))
      .toEqual([])
  })

  it('白名单与正文层字色对齐：正文层字色两端成对存在（#222 深字 / #e8e8ea 浅字）', () => {
    expect(HEX_ALLOWED['util.ts']).toEqual(['#222', '#e8e8ea'])
  })

  it('品牌派生色 token 在场（--novel-brand-soft/tint/line/strong 四件套）', () => {
    for (const t of ['--novel-brand-soft', '--novel-brand-tint', '--novel-brand-line', '--novel-brand-strong']) {
      expect(NOVEL_CSS).toContain(t)
    }
  })
})
