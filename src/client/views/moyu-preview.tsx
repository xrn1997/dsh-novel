import type { ReactNode } from 'react'
import { useCopy } from '../copy/index.js'
import type { MoyuMarkdownBlock, MoyuMarkdownInline } from '../moyu-markdown.js'
import { parseMoyuMarkdown } from '../moyu-markdown.js'

/* ── 文档预览：README 真 Markdown 渲染 + 章节真文本 ─────────────────
   排版口径照宿主文档预览的 Markdown 排版：
   h1 21/30 700、h2 19/28 700、h3 18/26 700、h4 600 基字、段 16px 上下、行内码
   0.875em l1 发丝芯片、引用 2px caption 左线。正文 markdown 渲染不在此列。 */

function Inline({ inlines }: { inlines: MoyuMarkdownInline[] }): ReactNode {
  return (
    <>
      {inlines.map((inline, index) => {
        if (inline.kind === 'code') return <code key={index}>{inline.text}</code>
        if (inline.kind === 'strong') return <strong key={index}>{inline.text}</strong>
        return <span key={index}>{inline.text}</span>
      })}
    </>
  )
}

/** README 源文 → 宿主 MarkdownBody 排版口径的块级渲染。 */
export function MoyuMarkdownView({ source }: { source: string }): ReactNode {
  const blocks = parseMoyuMarkdown(source)
  return (
    <div className="novel-moyu-md">
      {blocks.map((block, index) => <MarkdownBlock key={index} block={block} />)}
    </div>
  )
}

function MarkdownBlock({ block }: { block: MoyuMarkdownBlock }): ReactNode {
  if (block.kind === 'hr') return <hr className="novel-moyu-md-hr" />
  if (block.kind === 'code') return <pre className="novel-moyu-md-pre">{block.text}</pre>
  if (block.kind === 'heading') {
    const inlines = <Inline inlines={block.inlines} />
    switch (block.level) {
      case 1: return <h1 className="novel-moyu-md-h1">{inlines}</h1>
      case 2: return <h2 className="novel-moyu-md-h2">{inlines}</h2>
      case 3: return <h3 className="novel-moyu-md-h3">{inlines}</h3>
      default: return <h4 className="novel-moyu-md-h4">{inlines}</h4>
    }
  }
  if (block.kind === 'quote') return <blockquote className="novel-moyu-md-quote"><Inline inlines={block.inlines} /></blockquote>
  if (block.kind === 'list') {
    return (
      <ul className="novel-moyu-md-list">
        {block.items.map((item, index) => <li key={index}><Inline inlines={item} /></li>)}
      </ul>
    )
  }
  return <p className="novel-moyu-md-p"><Inline inlines={block.inlines} /></p>
}

/** 预览面板：文件路径头 + 「在阅读器打开」+ 内容体（README 走 Markdown、章节走真文本）。 */
export function MoyuPreviewPane({ path, markdown, text, onOpenInReader }: {
  path: string
  /** README 的 Markdown 源文；与 `text` 二选一。 */
  markdown?: string
  /** 章节真文本（不做正文 markdown 渲染）。 */
  text?: string
  onOpenInReader: () => void
}): ReactNode {
  const t = useCopy()
  return (
    <div className="novel-moyu-preview">
      <div className="novel-moyu-preview-head">
        <span className="novel-moyu-preview-path">{path}</span>
        <button type="button" className="novel-moyu-preview-open" onClick={onOpenInReader}>
          {t('reader.moyu.openInReader')}
        </button>
      </div>
      <div className="novel-moyu-preview-body">
        {markdown !== undefined
          ? <MoyuMarkdownView source={markdown} />
          : <pre className="novel-moyu-preview-text">{text ?? ''}</pre>}
      </div>
    </div>
  )
}
