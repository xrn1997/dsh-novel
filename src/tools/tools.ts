import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ReadingService } from '../services/reading.js'
import type { ShelfBook } from '../services/types.js'
import { project } from './project.js'

/** defineTool 产物（registry-ready definition）；registerTools 的 ctxLike 结构镜像 Cordis ToolRuntime */
export type ToolDefinition = ReturnType<typeof defineTool>

export interface ToolsCtxLike {
  tools: { register(t: ToolDefinition): () => void }
}

/**
 * agent 五工具：与 HTTP 面共用 ReadingService，返回值一律规范 JSON
 * （凭据红线同 HTTP——分组/书目全经服务层投影）；render 只做文本投影，规范值全文保留。
 */
export function buildTools(service: ReadingService): ToolDefinition[] {
  const text = (s: string): Array<{ type: 'text'; text: string }> => [{ type: 'text', text: s }]

  const searchBooks = defineTool({
    name: 'novel_search_books',
    description: '在已启用的文本书源里聚合搜索书籍（本插件当前仅支持小说文本面），结果逐源分组（一源挂了不影响他源）。返回的 url 字段是详情页地址，可作为其他 novel 工具的 bookKey。结果可能较长，按需使用。',
    parameters: {
      keyword: { type: 'string', required: true, description: '书名/作者关键词' },
      sourceIds: { type: 'array', description: '限定源 id 列表（缺省搜全部启用的文本源）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          groups: {
            type: 'array', required: true, description: '逐源分组',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                sourceId: { type: 'string', required: true, description: '源 id' },
                sourceName: { type: 'string', required: true, description: '源名' },
                status: { type: 'string', required: true, description: 'verified/broken/unverified' },
                statusDetail: { type: 'string', description: 'broken 原因（含段级定位）' },
                error: { type: 'object', additionalProperties: true, description: '该源本次失败（网络/规则）' },
                hits: {
                  type: 'array', required: true, description: '书目',
                  items: {
                    type: 'object', additionalProperties: false,
                    properties: {
                      title: { type: 'string', required: true, description: '书名' },
                      author: { type: 'string', description: '作者' },
                      url: { type: 'string', description: '详情页 URL（bookKey）' },
                      coverUrl: { type: 'string', description: '封面' },
                      intro: { type: 'string', description: '简介' },
                      lastChapterName: { type: 'string', description: '最新章名' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, v) => {
        const total = v.groups.reduce((n, g) => n + g.hits.length, 0)
        const lines = v.groups.map((g) => g.error
          ? `【${g.sourceName}（${g.status}）】失败：${g.error.code}: ${g.error.message}`
          : `【${g.sourceName}（${g.status}）】${g.hits.length} 本：${g.hits.slice(0, 5).map((h) => `${h.title}${h.author === null ? '' : ` / ${h.author}`}`).join('；')}${g.hits.length > 5 ? '…' : ''}`)
        return text(`共 ${v.groups.length} 组、${total} 本：\n${lines.join('\n')}`)
      },
    },
    execute: async (args: { keyword: string; sourceIds?: string[] }) => {
      // 缺键纪律归 project()（tools/project.ts 单点）：null/undefined 字段整键省略——
      // harness 的 lossless-JSON 校验对 undefined 属性值一票否决
      const groups: Array<{
        sourceId: string; sourceName: string; status: string
        statusDetail?: string; error?: { code: string; message: string }
        hits: Array<{ title: string; url?: string; author?: string; coverUrl?: string; intro?: string; lastChapterName?: string }>
      }> = project(await service.search(args.keyword, args.sourceIds === undefined ? undefined : { sourceIds: args.sourceIds }))
      return { groups }
    },
  })

  const readChapter = defineTool({
    name: 'novel_read_chapter',
    description: '取某本书第 N 章（0 起）的正文纯文本。先用 novel_search_books 拿 bookKey（url 字段）。正文可能很长（数千字），只有用户确实需要全文时再读。',
    parameters: {
      sourceId: { type: 'string', required: true, description: '源 id（来自搜索结果/源列表）' },
      bookKey: { type: 'string', required: true, description: '书籍详情页 URL' },
      chapterIndex: { type: 'integer', required: true, description: '章序（0 起）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          sourceId: { type: 'string', required: true, description: '源 id' },
          bookKey: { type: 'string', required: true, description: '书籍键' },
          chapterIndex: { type: 'integer', required: true, description: '章序' },
          chapterName: { type: 'string', required: true, description: '章名（来自目录）' },
          text: { type: 'string', required: true, description: '正文纯文本' },
        },
      },
      render: (_args, v) => text(`《${v.bookKey}》第 ${v.chapterIndex} 章（${v.chapterName}）共 ${v.text.length} 字：\n${v.text.slice(0, 2000)}${v.text.length > 2000 ? '…（截断，规范值含全文）' : ''}`),
    },
    execute: async (args: { sourceId: string; bookKey: string; chapterIndex: number }) => {
      const toc = await service.getToc(args.sourceId, args.bookKey)
      // 越界判定归服务层（ChapterNotFoundError）——此处不再复读同一检查与文案
      const textValue = await service.getChapter(args.sourceId, args.bookKey, args.chapterIndex)
      return { sourceId: args.sourceId, bookKey: args.bookKey, chapterIndex: args.chapterIndex, chapterName: toc[args.chapterIndex].name, text: textValue }
    },
  })

  const addSource = defineTool({
    name: 'novel_add_source',
    description: '导入 legado 书源 JSON（文本，对象或数组）。导入只做规范化+落盘，不探针——新源状态为「未验证」，需要结论时用 novel_probe_source 逐源验证；同址已有可用源时按址去重保留已有（dupSkipped=true）。ok 字段反映规则可用性，missing 列出缺什么。',
    parameters: {
      sourceJson: { type: 'string', required: true, description: 'legado 书源 JSON 文本' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          outcomes: {
            type: 'array', required: true, description: '逐条导入结果',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                sourceId: { type: 'string', description: '成功导入的源 id（去重命中时=已有可用源 id）' },
                name: { type: 'string', required: true, description: '源名' },
                ok: { type: 'boolean', required: true, description: '规范化是否通过' },
                dupSkipped: { type: 'boolean', description: '按址去重命中：同址已有可用源，保留已有未新增' },
                missing: { type: 'array', description: '缺的必填字段' },
                warnings: { type: 'array', description: '警告（header 解析等）' },
              },
            },
          },
        },
      },
      render: (_args, v) => text((v.outcomes ?? []).map((o) => {
        if (!o.ok) return `✗ ${o.name}：缺 ${(o.missing ?? []).map((m) => String((m as { field?: unknown })?.field ?? '?')).join('、')}`
        if (o.dupSkipped === true) return `↷ ${o.name}：同址已有可用源，按址去重保留已有（未新增）`
        return `✓ ${o.name}（已导入，未验证——用 novel_probe_source 验证）`
      }).join('\n')),
    },
    execute: async (args: { sourceJson: string }) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(args.sourceJson)
      } catch (e) {
        return {
          outcomes: [{
            name: '(未解析)', ok: false,
            missing: [{ field: 'sourceJson', message: `JSON 解析失败: ${(e as Error).message}` }],
            warnings: [],
          }],
        }
      }
      const outcomes: Array<{
        name: string; ok: boolean; sourceId?: string; dupSkipped?: boolean
        missing: Array<{ field: string; message: string }>
        warnings: Array<{ field: string; message: string }>
      }> = project((await service.importSource(parsed)).map((o) => ({
        name: o.name, ok: o.ok, sourceId: o.sourceId ?? undefined,
        dupSkipped: o.dupSkipped === true ? true : undefined,
        missing: o.missing.map((m) => ({ field: m.field, message: m.message })),
        warnings: o.warnings.map((w) => ({ field: w.field, message: w.message })),
      })))
      return { outcomes }
    },
  })

  const probeSourceTool = defineTool({
    name: 'novel_probe_source',
    description: '对已有源跑一次探针（真实搜索请求），返回实测结论与段级失败定位——用于判断源是否可用。',
    parameters: {
      sourceId: { type: 'string', required: true, description: '源 id' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          sourceId: { type: 'string', required: true, description: '源 id' },
          status: { type: 'string', required: true, description: '探针后状态 verified/broken' },
          ok: { type: 'boolean', required: true, description: '是否跑通' },
          itemCount: { type: 'integer', description: '搜索命中条目数' },
          firstTitle: { type: 'string', description: '首条书名' },
          error: { type: 'object', additionalProperties: true, description: '失败原因（含段级定位）' },
          probedAt: { type: 'integer', required: true, description: '探针时间戳' },
        },
      },
      render: (_args, v) => text(v.ok
        ? `源可用：命中 ${v.itemCount ?? 0} 条，首条「${v.firstTitle ?? ''}」`
        : `源不可用：${v.error?.code ?? ''} ${v.error?.message ?? ''}`),
    },
    execute: async (args: { sourceId: string }) => {
      const r = await service.probe(args.sourceId)
      return project({
        sourceId: args.sourceId, status: r.ok ? 'verified' : 'broken',
        ok: r.ok, itemCount: r.itemCount, probedAt: r.probedAt,
        firstTitle: r.firstTitle ?? undefined,
        error: r.error,
      })
    },
  })

  const shelf = defineTool({
    name: 'novel_shelf',
    description: '查询书架与阅读进度（「我上次读到哪」有据可答）。v1 仅支持 list；加书/更新进度走阅读器 UI。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list'], description: '固定 list' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          books: {
            type: 'array', required: true, description: '书架条目',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                sourceId: { type: 'string', required: true, description: '源 id' },
                bookKey: { type: 'string', required: true, description: '书籍键（详情页 URL）' },
                title: { type: 'string', required: true, description: '书名' },
                author: { type: 'string', description: '作者' },
                lastChapterName: { type: 'string', description: '最新章名' },
                progress: { type: 'object', additionalProperties: true, required: true, description: '{chapterIndex, offsetRatio, updatedAt}' },
                addedAt: { type: 'integer', required: true, description: '加入时间戳' },
              },
            },
          },
        },
      },
      render: (_args, v) => text((v.books ?? []).length === 0
        ? '书架是空的。'
        : (v.books ?? []).map((b) => {
          const p = (b.progress ?? {}) as { chapterIndex?: number; offsetRatio?: number }
          return `《${b.title}》${b.author === undefined ? '' : ` / ${String(b.author)}`} 读到第 ${p.chapterIndex ?? 0} 章（${Math.round((p.offsetRatio ?? 0) * 100)}%）`
        }).join('\n')),
    },
    execute: async (_args: { action: 'list' }) => {
      // 只投影 schema 声明的字段（intro/totalChapters 不在 shelf 工具 schema 里——
      // additionalProperties:false 下多带字段会被 harness 拒；此前直出整条 ShelfBook 是超集）
      const books: Array<{
        sourceId: string; bookKey: string; title: string
        author?: string; lastChapterName?: string
        progress: ShelfBook['progress']; addedAt: number
      }> = project(service.shelfList().map((b) => ({
        sourceId: b.sourceId, bookKey: b.bookKey, title: b.title,
        author: b.author, lastChapterName: b.lastChapterName,
        progress: b.progress, addedAt: b.addedAt,
      })))
      return { books }
    },
  })

  return [searchBooks, readChapter, addSource, probeSourceTool, shelf]
}

/** 注册五工具并返回聚合 disposer（apply 里 ctx.effect 用） */
export function registerTools(ctxLike: ToolsCtxLike, service: ReadingService): () => void {
  const disposers = buildTools(service).map((t) => ctxLike.tools.register(t))
  return () => { for (const d of disposers) d() }
}
