import { chapterContentLines, playUnitStarts, playUnitStartsByNode } from '../shared/chapter-text.js'
import type { ChapterContent, ContentNode, LinkRole, ReadingTarget } from '../shared/wire.js'

export const MOYU_TICK_MS = 70
export const MOYU_TICK_CHARS = 6
export const MOYU_PIN_RELEASE_PX = 40
export const MOYU_ACTION_MARKS = ['▸', '»', '⇣', '✎'] as const

export type MoyuPhase = 'streaming' | 'chapter-ready' | 'complete' | 'error'

export interface MoyuParagraph {
  text: string
  done: boolean
  index: number
}

export type MoyuInlineSegment =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; target: ReadingTarget; role: LinkRole; nodeId: string }

export type MoyuTurnBlock =
  | { kind: 'paragraph'; text: string; paragraphIndex: number; nodeId: string | null; segments?: MoyuInlineSegment[] }
  | {
      kind: 'image'
      resourceId: string
      alt: string
      width: number
      height: number
      paragraphIndex: number
      nodeId: string
    }
  | {
      kind: 'link'
      text: string
      target: ReadingTarget
      role: LinkRole
      paragraphIndex: number
      nodeId: string
    }

export function isPinnedToTail(box: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= MOYU_PIN_RELEASE_PX
}

export function nextPhase(revealed: number, total: number, isLastChapter: boolean): MoyuPhase {
  if (total === 0 || revealed < total) return 'streaming'
  return isLastChapter ? 'complete' : 'chapter-ready'
}

export function projectLines(lines: readonly string[], revealed: number): MoyuParagraph[] {
  const out: MoyuParagraph[] = []
  let used = 0
  let index = 0
  for (const line of lines) {
    if (line === '') continue
    if (used >= revealed) break
    const units = Array.from(line)
    const remaining = revealed - used
    const done = remaining >= units.length
    out.push({ text: done ? line : units.slice(0, remaining).join(''), done, index })
    used += done ? units.length : remaining
    index += 1
    if (!done) break
  }
  return out
}

export function isMainLine(index: number): boolean {
  return index % 4 === 0
}

export function actionMarkFor(index: number): string {
  const nthSmall = Math.floor(index / 4) * 3 + ((index % 4) - 1)
  return MOYU_ACTION_MARKS[((nthSmall % MOYU_ACTION_MARKS.length) + MOYU_ACTION_MARKS.length) % MOYU_ACTION_MARKS.length]
    ?? MOYU_ACTION_MARKS[0]
}

/** 伪装工作区里的章节路径：文件坞、读取行与用户气泡共用一份拼法（别在视图里各拼一遍）。 */
export function moyuChapterPath(index: number, rawTitle: string): string {
  return `chapters/${chapterFileName(index, rawTitle)}`
}

/** 伪装工作区固定文件名（README 预览的入口与标题共用）。 */
export const MOYU_README_NAME = 'README.md'

export function chapterFileName(index: number, rawTitle: string): string {
  const clean = rawTitle
    .replace(/^第[一二三四五六七八九十百千0-9]+章\s*/, '')
    .trim()
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_') || 'chapter'
  const clipped = Array.from(clean).slice(0, 32).join('')
  return `${String(index + 1).padStart(4, '0')}_${clipped}.ts`
}

export function extractMoyuTurnBlocks(content: ChapterContent): MoyuTurnBlock[] {
  const lines = chapterContentLines(content)
  const starts = playUnitStarts(lines)
  const paragraphs: MoyuTurnBlock[] = []
  const hasRichBlocks = content.kind === 'rich' && lines.some((line) => line.nodeId !== null)
  lines.forEach((line, index) => {
    if (line.text.trim() === '' || (hasRichBlocks && line.nodeId === null)) return
    paragraphs.push({
      kind: 'paragraph',
      text: line.text,
      paragraphIndex: starts[index] ?? 0,
      nodeId: line.nodeId,
    })
  })
  if (content.kind === 'text') return paragraphs

  const pids = playUnitStartsByNode(lines)
  const nodesById = new Map<string, ContentNode>()
  const collectNodes = (nodes: readonly ContentNode[]): void => {
    for (const node of nodes) {
      if (node.kind !== 'text') nodesById.set(node.id, node)
      if (node.kind === 'element' || node.kind === 'link') collectNodes(node.children)
    }
  }
  collectNodes(content.nodes)
  if (hasRichBlocks) {
    for (const block of paragraphs) {
      if (block.kind !== 'paragraph' || block.nodeId === null) continue
      const node = nodesById.get(block.nodeId)
      if (node === undefined || !hasAttachment(node)) continue
      const segments = inlineSegmentsOf(node)
      block.text = segments.map((segment) => segment.text).join('')
      if (segments.some((segment) => segment.kind === 'link')) block.segments = segments
    }
  }
  const rootInline = !hasRichBlocks
  if (rootInline) {
    const segments = content.nodes.flatMap(inlineSegmentsOf)
    const text = segments.map((segment) => segment.text).join('').replace(/\s+/g, ' ').trim()
    paragraphs.splice(0, paragraphs.length, ...(text === '' ? [] : [{
      kind: 'paragraph' as const,
      text,
      paragraphIndex: 0,
      nodeId: null,
      ...(segments.some((segment) => segment.kind === 'link') ? { segments } : {}),
    }]))
  }
  const attachments: Array<{ block: MoyuTurnBlock; paragraphIndex: number; order: number }> = []
  let paragraphIndex = 0
  let order = 0
  const walk = (nodes: readonly ContentNode[], insideParagraph: boolean): void => {
    for (const node of nodes) {
      if (node.kind === 'element') {
        const start = pids.get(node.id)
        if (start !== undefined) paragraphIndex = start
        walk(node.children, insideParagraph || start !== undefined)
        continue
      }
      if (node.kind === 'image') {
        attachments.push({
          block: {
            kind: 'image',
            resourceId: node.resourceId,
            alt: node.alt,
            width: node.width,
            height: node.height,
            paragraphIndex,
            nodeId: node.id,
          },
          paragraphIndex,
          order: order++,
        })
        continue
      }
      if (node.kind === 'link') {
        if (!insideParagraph) {
          attachments.push({
            block: {
              kind: 'link',
              text: textOf(node).replace(/\s+/g, ' ').trim(),
              target: node.target,
              role: node.role,
              paragraphIndex,
              nodeId: node.id,
            },
            paragraphIndex,
            order: order++,
          })
        }
        walk(node.children, insideParagraph)
      }
    }
  }
  walk(content.nodes, rootInline)

  const byParagraph = new Map<number, typeof attachments>()
  for (const attachment of attachments) {
    const list = byParagraph.get(attachment.paragraphIndex) ?? []
    list.push(attachment)
    byParagraph.set(attachment.paragraphIndex, list)
  }
  const out: MoyuTurnBlock[] = []
  for (const paragraph of paragraphs) {
    out.push(paragraph)
    if (paragraph.kind !== 'paragraph') continue
    for (const attachment of byParagraph.get(paragraph.paragraphIndex) ?? []) out.push(attachment.block)
    byParagraph.delete(paragraph.paragraphIndex)
  }
  for (const list of byParagraph.values()) {
    list.sort((a, b) => a.order - b.order)
    for (const attachment of list) out.push(attachment.block)
  }
  return out
}

function inlineSegmentsOf(node: ContentNode): MoyuInlineSegment[] {
  const out: MoyuInlineSegment[] = []
  const pushText = (text: string): void => {
    if (text === '') return
    const last = out.at(-1)
    if (last?.kind === 'text') last.text += text
    else out.push({ kind: 'text', text })
  }
  const visit = (current: ContentNode): void => {
    switch (current.kind) {
      case 'text':
        pushText(current.text)
        return
      case 'element':
        current.children.forEach(visit)
        return
      case 'link':
        out.push({ kind: 'link', text: textOf(current), target: current.target, role: current.role, nodeId: current.id })
        return
      case 'break':
        pushText('\n')
        return
      case 'image':
      case 'rule':
        return
    }
  }
  visit(node)
  return out
}

function hasAttachment(node: ContentNode): boolean {
  if (node.kind === 'image' || node.kind === 'link') return true
  return (node.kind === 'element' ? node.children : []).some(hasAttachment)
}

function textOf(node: ContentNode): string {
  switch (node.kind) {
    case 'text':
      return node.text
    case 'element':
    case 'link':
      return node.children.map(textOf).join('')
    case 'break':
      return '\n'
    case 'image':
    case 'rule':
      return ''
  }
}
