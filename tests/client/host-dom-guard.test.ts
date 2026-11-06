import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { withoutComments } from '../without-comments.js'

/**
 * 宿主 DOM 边界守卫：client 源码里不许出现宿主私有的 `data-*` 选择器。
 *
 * 为什么要有这条门：面板曾经用 `:has()` + 宿主的会话滚动容器 / composer 座位 / 列宽把手属性去藏
 * 宿主 UI。那些属性不在槽位契约里——宿主改名不会让任何东西变红，只会让规则**静默失效**：轻则留
 * 一份没人命中的样式，重则在某一代宿主上把正文压到输入框底下。插件的作用域是自己的两棵树；
 * 要动宿主布局，先有槽位契约，再改这条门。
 *
 * 判据只认「代码里」：注释里点名（解释为什么不做）不算——`withoutComments` 连 CSS 块注释一起剥。
 */
const HOST_OWNED_SELECTORS = [
  'data-conversation-scroll',
  'data-chain-overlay-fallback',
  'data-width-handle',
  'data-composer-seat',
]

const clientDir = fileURLToPath(new URL('../../src/client/', import.meta.url))

function clientSources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(entry.name)) out.push({ file: path.relative(clientDir, p).split(path.sep).join('/'), text: readFileSync(p, 'utf8') })
    }
  }
  walk(clientDir)
  return out
}

/** 命中即「代码里引用了宿主私有属性」；注释不参与判定。 */
function scanHostSelectors(text: string): string[] {
  const code = withoutComments(text)
  return HOST_OWNED_SELECTORS.filter((selector) => code.includes(selector))
}

describe('宿主 DOM 边界守卫（client 不读宿主私有属性）', () => {
  const sources = clientSources()

  it('扫到源码（守卫本身别空转）', () => {
    expect(sources.length).toBeGreaterThan(5)
  })

  it('client 代码里零宿主私有选择器', () => {
    const bad: string[] = []
    for (const { file, text } of sources) {
      for (const selector of scanHostSelectors(text)) bad.push(`${file}: ${selector}`)
    }
    expect(bad, `client 代码引用了宿主私有 DOM 属性（要动宿主布局请先有槽位契约；注释里点名不算）：\n${bad.join('\n')}`).toEqual([])
  })

  it('负断言：真选择器抓得住，注释里的点名与自家 data-novel-* 不抓', () => {
    expect(scanHostSelectors('.x [data-conversation-scroll] .y { display: none }'))
      .toEqual(['data-conversation-scroll'])
    expect(scanHostSelectors('/* 解释：别用 data-width-handle */ .x { color: red }')).toEqual([])
    expect(scanHostSelectors('.novel-root[data-novel-view="shelf"] { color: red }')).toEqual([])
  })
})
