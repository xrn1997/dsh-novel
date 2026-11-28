/**
 * README 文档预览的 Markdown 面：合成 README 源文 → 块级 AST → 视图按宿主文档预览的
 * Markdown 排版口径渲染。
 *
 * 为什么自造一小截渲染器：纯度门把 client 运行时 import 限在平台模块表（现只有 react），
 * 宿主的 Markdown 渲染原语进不来；而 README 面要的是「真 Markdown 渲染」而不是灰底正文。
 * 于是这里只覆盖 README 源文实际用到的块（标题 / 段落 / 无序列表 / 围栏代码 / 分隔线 /
 * 引用）与行内（`code` / **strong**），排版数值逐项照宿主文档预览的字阶与间距。
 * 正文 markdown 渲染不在此列——那要完整渲染器，另议。
 */

import type { Translate } from './copy/index.js'

export type MoyuMarkdownInline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }

export type MoyuMarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; inlines: MoyuMarkdownInline[] }
  | { kind: 'paragraph'; inlines: MoyuMarkdownInline[] }
  | { kind: 'list'; items: MoyuMarkdownInline[][] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; inlines: MoyuMarkdownInline[] }
  | { kind: 'hr' }

/** 行内解析：`code` 与 **strong** 两种标记，其余原样成文本（README 源文不带链接语法）。 */
export function parseMoyuMarkdownInlines(text: string): MoyuMarkdownInline[] {
  const out: MoyuMarkdownInline[] = []
  let rest = text
  let buffer = ''
  const flush = (): void => {
    if (buffer !== '') out.push({ kind: 'text', text: buffer })
    buffer = ''
  }
  while (rest !== '') {
    const code = /`([^`]+)`/.exec(rest)
    const strong = /\*\*([^*]+)\*\*/.exec(rest)
    const at = [code, strong]
      .map((match) => match === null ? -1 : match.index)
      .reduce((best, value) => value === -1 ? best : best === -1 ? value : Math.min(best, value), -1)
    if (at < 0) {
      buffer += rest
      break
    }
    buffer += rest.slice(0, at)
    if (code !== null && code.index === at) {
      flush()
      out.push({ kind: 'code', text: code[1] ?? '' })
      rest = rest.slice(at + code[0].length)
      continue
    }
    if (strong !== null && strong.index === at) {
      flush()
      out.push({ kind: 'strong', text: strong[1] ?? '' })
      rest = rest.slice(at + strong[0].length)
      continue
    }
  }
  flush()
  return out
}

/** 块级解析：按空行分块，围栏代码优先整块吞掉。 */
export function parseMoyuMarkdown(source: string): MoyuMarkdownBlock[] {
  const blocks: MoyuMarkdownBlock[] = []
  const lines = source.split('\n')
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') {
      index += 1
      continue
    }
    if (line.startsWith('```')) {
      const body: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? '').startsWith('```')) {
        body.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      blocks.push({ kind: 'code', text: body.join('\n') })
      continue
    }
    if (/^-{3,}$/.test(line.trim())) {
      blocks.push({ kind: 'hr' })
      index += 1
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading !== null) {
      const level = Math.min(4, heading[1]?.length ?? 1) as 1 | 2 | 3 | 4
      blocks.push({ kind: 'heading', level, inlines: parseMoyuMarkdownInlines(heading[2] ?? '') })
      index += 1
      continue
    }
    if (line.startsWith('- ')) {
      const items: MoyuMarkdownInline[][] = []
      while (index < lines.length && (lines[index] ?? '').startsWith('- ')) {
        items.push(parseMoyuMarkdownInlines((lines[index] ?? '').slice(2)))
        index += 1
      }
      blocks.push({ kind: 'list', items })
      continue
    }
    if (line.startsWith('> ')) {
      blocks.push({ kind: 'quote', inlines: parseMoyuMarkdownInlines(line.slice(2)) })
      index += 1
      continue
    }
    const paragraph: string[] = []
    while (index < lines.length && (lines[index] ?? '').trim() !== '' && !(lines[index] ?? '').startsWith('```')) {
      paragraph.push(lines[index] ?? '')
      index += 1
    }
    blocks.push({ kind: 'paragraph', inlines: parseMoyuMarkdownInlines(paragraph.join(' ')) })
  }
  return blocks
}

/**
 * README 源文（伪装工作区根文件的内容）：`#` 书名、元信息无序列表、分隔线与说明段。
 * 结构是 markdown 语法（语言无关），字句全走文案表——视图不持一个上屏字。
 */
export function moyuReadmeMarkdown(t: Translate, title: string, totalChapters: number, importNotesCount: number): string {
  const last = String(totalChapters).padStart(4, '0')
  const lines = [
    `# ${title}`,
    '',
    `- **${t('reader.moyu.readme.meta.module')}**: ${t('reader.moyu.readme.moduleValue', { title })}`,
    `- **${t('reader.moyu.readme.meta.chapters')}**: ${t('reader.moyu.readme.chaptersValue', { n: totalChapters, last })}`,
    `- **${t('reader.moyu.readme.meta.runtime')}**: ${t('reader.moyu.readme.runtimeValue')}`,
  ]
  if (importNotesCount > 0) {
    lines.push(`- **${t('reader.moyu.readme.meta.notes')}**: ${t('reader.moyu.readme.notesValue', { n: importNotesCount })}`)
  }
  lines.push('', '---', '', t('reader.moyu.readme.body', { n: totalChapters }))
  return lines.join('\n')
}
