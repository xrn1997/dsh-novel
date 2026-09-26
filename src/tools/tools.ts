import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ReadingService } from '../services/reading.js'
import type { ShelfBook } from '../services/types.js'
import { project } from './project.js'

/** defineTool 产物（registry-ready definition）；registerTools 的 ctxLike 结构镜像 Cordis ToolRuntime */
export type ToolDefinition = ReturnType<typeof defineTool>

export interface ToolsCtxLike {
  tools: { register(t: ToolDefinition): () => void }
}

/** action 枚举工具的参数缺口防线（宁炸不猜）：schema 层 enum 拦未知 action，
 *  这里拦「action 对但参数没给」——缺参静默兜底会写出永远读不了的书 / 摸到不存在的源。 */
const requireArgs = (action: string, present: Record<string, unknown>, needs: readonly string[]): void => {
  const missing = needs.filter((k) => present[k] === undefined || present[k] === null)
  if (missing.length > 0) throw new Error(`dshnovel_${action} 缺少参数：${missing.join('、')}`)
}

/**
 * agent 六工具：与 HTTP 面共用 ReadingService，返回值一律规范 JSON
 * （凭据红线同 HTTP——分组/书目/源清单全经服务层投影）；render 只做文本投影，规范值全文保留。
 *
 * 名字全部锁 `dshnovel_` 前缀（tests/tools/tools.test.ts 断言名字集合）：宿主对工具重名直接抛
 * `already registered`，前缀是与生态其他插件的硬边界——2026-09 全生态核查时 `novel_` 前缀已被
 * 写作类插件占了 80+ 个词，阅读域的新词（toc/source）虽暂无占用，但插件专属前缀才是根治。
 *
 * 形状取「工具少 + action 枚举」而非每动词一工具：弱模型对 6 个工具名的辨识远好于 11+，
 * action 的合法取值锁在 schema enum 里，缺参由 requireArgs 抛清楚的错。
 */
export function buildTools(service: ReadingService): ToolDefinition[] {
  const text = (s: string): Array<{ type: 'text'; text: string }> => [{ type: 'text', text: s }]

  const searchBooks = defineTool({
    name: 'dshnovel_search',
    description: '在已启用的文本书源里聚合搜索书籍（本插件当前仅支持小说文本面），结果逐源分组（一源挂了不影响他源）。返回的 url 字段是详情页地址，可作为其他 dshnovel 工具的 bookKey。结果可能较长，按需使用。',
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
                      kind: { type: 'string', description: '分类（源的 ruleSearch.kind / ruleBookInfo.kind）' },
                      wordCount: { type: 'string', description: '字数（原样字符串，可能是「120万字」这类站点文案）' },
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
        hits: Array<{ title: string; url?: string; author?: string; coverUrl?: string; intro?: string; lastChapterName?: string; kind?: string; wordCount?: string }>
      }> = project(await service.search(args.keyword, args.sourceIds === undefined ? undefined : { sourceIds: args.sourceIds }))
      return { groups }
    },
  })

  const readChapter = defineTool({
    name: 'dshnovel_read',
    description: '取某本书第 N 章（0 起）的正文纯文本。chapterIndex 从 dshnovel_toc 的结果查（章名→下标只在那里映射）；bookKey 用 dshnovel_search 返回的 url 字段。正文可能很长（数千字），只有用户确实需要全文时再读。图文书（本地 EPUB）同样只给文字：插图落成 [图片：替代文字] 占位（没有替代文字则 [图片]），不包含图片本身。',
    parameters: {
      sourceId: { type: 'string', required: true, description: '源 id（来自搜索结果/源列表）' },
      bookKey: { type: 'string', required: true, description: '书籍详情页 URL' },
      chapterIndex: { type: 'integer', required: true, description: '章序（0 起，从 dshnovel_toc 查）' },
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

  const tocTool = defineTool({
    name: 'dshnovel_toc',
    description: '取书籍目录：逐章返回章名与 0 起的 chapterIndex（章名→下标的唯一映射处，dshnovel_read 靠它定位）、章 URL。sourceId/bookKey 来自 dshnovel_search 的结果。目录可能上千章——render 只显示前 10 章，规范值含全部。',
    parameters: {
      sourceId: { type: 'string', required: true, description: '源 id' },
      bookKey: { type: 'string', required: true, description: '书籍详情页 URL' },
      refresh: { type: 'boolean', description: 'true=跳过目录缓存强制重拉（默认用缓存）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          sourceId: { type: 'string', required: true, description: '源 id' },
          bookKey: { type: 'string', required: true, description: '书籍键' },
          total: { type: 'integer', required: true, description: '总章数' },
          chapters: {
            type: 'array', required: true, description: '目录（按阅读顺序）',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                chapterIndex: { type: 'integer', required: true, description: '0 起章序（喂给 dshnovel_read）' },
                name: { type: 'string', required: true, description: '章名' },
                url: { type: 'string', required: true, description: '章节 URL' },
              },
            },
          },
        },
      },
      render: (_args, v) => text(`《${v.bookKey}》共 ${v.total} 章：\n${v.chapters.slice(0, 10).map((c) => `[${c.chapterIndex}] ${c.name}`).join('\n')}${v.total > 10 ? '\n…（截断，规范值含全部）' : ''}`),
    },
    execute: async (args: { sourceId: string; bookKey: string; refresh?: boolean }) => {
      const toc = await service.getToc(args.sourceId, args.bookKey, args.refresh === true ? { refresh: true } : undefined)
      const chapters = toc.map((c, i) => ({ chapterIndex: i, name: c.name, url: c.url }))
      return project({ sourceId: args.sourceId, bookKey: args.bookKey, total: toc.length, chapters })
    },
  })

  const shelf = defineTool({
    name: 'dshnovel_shelf',
    description: '书架与阅读进度。action 必填：list=列书与进度（只读，可单独用）；add=加书，需同时给 bookKey、title、sourceId；save_progress=存进度，需 bookKey、chapterIndex（0 起）、offsetRatio（0~1，书须已在架）；remove=移出书架，需 bookKey。按所选 action 提供对应参数，缺参会报错。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'add', 'save_progress', 'remove'], description: '操作类型' },
      bookKey: { type: 'string', description: '书籍详情页 URL（add/save_progress/remove 必填）' },
      title: { type: 'string', description: '书名（仅 add 必填）' },
      sourceId: { type: 'string', description: '源 id（仅 add 必填）' },
      chapterIndex: { type: 'integer', description: '读到的章序 0 起（仅 save_progress 必填）' },
      offsetRatio: { type: 'number', description: '章内进度 0~1（仅 save_progress 必填）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, description: '回显所执行的 action' },
          books: {
            type: 'array', description: '书架条目（仅 list）',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                sourceId: { type: 'string', required: true, description: '源 id' },
                bookKey: { type: 'string', required: true, description: '书籍键（详情页 URL）' },
                title: { type: 'string', required: true, description: '书名' },
                author: { type: 'string', description: '作者' },
                lastChapterName: { type: 'string', description: '最新章名' },
                kind: { type: 'string', description: '分类' },
                wordCount: { type: 'string', description: '字数（站点文案原样）' },
                progress: { type: 'object', additionalProperties: true, required: true, description: '{chapterIndex, offsetRatio, updatedAt}' },
                addedAt: { type: 'integer', required: true, description: '加入时间戳' },
              },
            },
          },
          book: {
            type: 'object', additionalProperties: false,
            description: '受影响的单本条目（仅 add/save_progress，字段与 books 条目同形）',
            properties: {
              sourceId: { type: 'string', required: true, description: '源 id' },
              bookKey: { type: 'string', required: true, description: '书籍键（详情页 URL）' },
              title: { type: 'string', required: true, description: '书名' },
              author: { type: 'string', description: '作者' },
              lastChapterName: { type: 'string', description: '最新章名' },
              kind: { type: 'string', description: '分类' },
              wordCount: { type: 'string', description: '字数（站点文案原样）' },
              progress: { type: 'object', additionalProperties: true, required: true, description: '{chapterIndex, offsetRatio, updatedAt}' },
              addedAt: { type: 'integer', required: true, description: '加入时间戳' },
            },
          },
          removed: { type: 'boolean', description: '是否真的移除了（仅 remove）' },
        },
      },
      render: (args, v) => {
        if (args.action === 'list') {
          return text((v.books ?? []).length === 0
            ? '书架是空的。'
            : (v.books ?? []).map((b) => {
              const p = (b.progress ?? {}) as { chapterIndex?: number; offsetRatio?: number }
              return `《${b.title}》${b.author === undefined ? '' : ` / ${String(b.author)}`} 读到第 ${p.chapterIndex ?? 0} 章（${Math.round((p.offsetRatio ?? 0) * 100)}%）`
            }).join('\n'))
        }
        if (args.action === 'remove') return text(`已移出书架（removed=${String(v.removed)}）`)
        const b = v.book!
        const p = (b.progress ?? {}) as { chapterIndex?: number }
        return text(args.action === 'add'
          ? `已加书：《${b.title}》`
          : `已存进度：《${b.title}》读到第 ${p.chapterIndex ?? 0} 章`)
      },
    },
    execute: async (args: {
      action: 'list' | 'add' | 'save_progress' | 'remove'
      bookKey?: string; title?: string; sourceId?: string; chapterIndex?: number; offsetRatio?: number
    }) => {
      if (args.action === 'list') {
        const books: ShelfItem[] = project(service.shelfList().map(pickShelfItem))
        return { action: 'list' as const, books }
      }
      if (args.action === 'add') {
        requireArgs(args.action, args, ['bookKey', 'title', 'sourceId'])
        // 投影改变类型（可空→缺席），出参类型由调用方断言——tools/project.ts 口径
        const book: ShelfItem = project(pickShelfItem(service.shelfAdd(args.bookKey!, { sourceId: args.sourceId!, title: args.title! })))
        return { action: 'add' as const, book }
      }
      if (args.action === 'save_progress') {
        requireArgs(args.action, args, ['bookKey', 'chapterIndex', 'offsetRatio'])
        // 不在架 → null：镜像 HTTP 面 400，不静默造书（reading.shelfSaveProgress 口径）
        const updated = service.shelfSaveProgress(args.bookKey!, args.chapterIndex!, args.offsetRatio!)
        if (updated === null) throw new Error(`dshnovel_shelf 书架里没有这本书：${args.bookKey}`)
        const book: ShelfItem = project(pickShelfItem(updated))
        return { action: 'save_progress' as const, book }
      }
      // remove：remove 自身的 boolean 就是权威回执（未知键 false），不再二次核存在性
      requireArgs(args.action, args, ['bookKey'])
      const { removed } = await service.removeBook(args.bookKey!)
      return { action: 'remove' as const, removed }
    },
  })

  const sourceTool = defineTool({
    name: 'dshnovel_source',
    description: '书源管理。action 必填：list=列出全部源（只读）；probe=对单源发真实搜索请求验证可用性，需 sourceId，返回实测结论与失败定位；enable/disable=启停单源，需 sourceId；remove=删除单源，需 sourceId。导入新源走 dshnovel_import_source。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'probe', 'enable', 'disable', 'remove'], description: '操作类型' },
      sourceId: { type: 'string', description: '源 id（probe/enable/disable/remove 必填；list 不用）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, description: '回显所执行的 action' },
          sources: {
            type: 'array', description: '源清单（仅 list）',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                sourceId: { type: 'string', required: true, description: '源 id' },
                name: { type: 'string', required: true, description: '源名' },
                baseUrl: { type: 'string', required: true, description: '源站地址' },
                enabled: { type: 'boolean', required: true, description: '是否启用（参与搜索）' },
                type: { type: 'string', required: true, description: '内容形态（text=文本）' },
                status: { type: 'string', required: true, description: 'verified/broken/unverified' },
                statusDetail: { type: 'string', description: 'broken 原因（含段级定位）' },
              },
            },
          },
          sourceId: { type: 'string', description: '目标源 id（probe/enable/disable/remove 回显）' },
          enabled: { type: 'boolean', description: '启停后的状态（仅 enable/disable）' },
          removed: { type: 'boolean', description: '是否真的删除了（仅 remove）' },
          status: { type: 'string', description: '探针后状态 verified/broken（仅 probe）' },
          ok: { type: 'boolean', description: '探针是否跑通（仅 probe）' },
          itemCount: { type: 'integer', description: '搜索命中条目数（仅 probe）' },
          firstTitle: { type: 'string', description: '首条书名（仅 probe）' },
          error: { type: 'object', additionalProperties: true, description: '失败原因，含段级定位（仅 probe）' },
          probedAt: { type: 'integer', description: '探针时间戳（仅 probe）' },
        },
      },
      render: (args, v) => {
        if (args.action === 'list') {
          const on = (v.sources ?? []).filter((s) => s.enabled).length
          return text(`共 ${v.sources?.length ?? 0} 个源（启用 ${on}）：${(v.sources ?? []).slice(0, 10).map((s) => `${s.name}（${s.status}${s.enabled ? '' : '，已停用'}）`).join('；')}${(v.sources?.length ?? 0) > 10 ? '…（截断，规范值含全部）' : ''}`)
        }
        if (args.action === 'probe') {
          return text(v.ok
            ? `源可用：命中 ${v.itemCount ?? 0} 条，首条「${v.firstTitle ?? ''}」`
            : `源不可用：${v.error?.code ?? ''} ${v.error?.message ?? ''}`)
        }
        if (args.action === 'remove') return text(`已删除源 ${String(v.sourceId)}（removed=${String(v.removed)}）`)
        return text(`已${v.enabled ? '启用' : '停用'}源 ${String(v.sourceId)}`)
      },
    },
    execute: async (args: {
      action: 'list' | 'probe' | 'enable' | 'disable' | 'remove'; sourceId?: string
    }) => {
      if (args.action === 'list') {
        const sources: Array<{
          sourceId: string; name: string; baseUrl: string; enabled: boolean
          type: string; status: string; statusDetail?: string
        }> = project(service.listPublicSources().map((s) => ({
          sourceId: s.id, name: s.name, baseUrl: s.baseUrl, enabled: s.enabled,
          type: s.type, status: s.status, statusDetail: s.statusDetail,
        })))
        return { action: 'list' as const, sources }
      }
      requireArgs(args.action, args, ['sourceId'])
      const id = args.sourceId!
      if (args.action === 'probe') {
        const r = await service.probe(id)
        return project({
          action: 'probe', sourceId: id, status: r.ok ? 'verified' : 'broken',
          ok: r.ok, itemCount: r.itemCount, probedAt: r.probedAt,
          firstTitle: r.firstTitle ?? undefined, error: r.error,
        })
      }
      if (args.action === 'enable' || args.action === 'disable') {
        // 存在性防线住这里（setEnabled 的 bool 语义不自明，不拿它当回执）：
        // 摸到不存在的 id 若静默回「已停用」，是空头承诺——宁炸不猜
        if (!service.hasSource(id)) throw new Error(`dshnovel_source 源不存在：${id}`)
        const enabled = args.action === 'enable'
        await service.setEnabled(id, enabled)
        return { action: args.action, sourceId: id, enabled }
      }
      const removed = await service.removeSource(id)
      if (!removed) throw new Error(`dshnovel_source 源不存在：${id}`)
      return { action: 'remove' as const, sourceId: id, removed }
    },
  })

  const addSource = defineTool({
    name: 'dshnovel_import_source',
    description: '导入 legado 书源 JSON（文本，对象或数组）。导入只做规范化+落盘，不探针——新源状态为「未验证」，需要结论时用 dshnovel_source 的 probe action 逐源验证；同址已有可用源时按址去重保留已有（dupSkipped=true）。ok 字段反映规则可用性，missing 列出缺什么。',
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
        return `✓ ${o.name}（已导入，未验证——用 dshnovel_source probe 验证）`
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

  return [searchBooks, readChapter, tocTool, shelf, sourceTool, addSource]
}

/** 书架单本投影的唯一形状（books 条目与 book 回执同源，不长第二份）：
 *  schema 声明的字段集——intro/totalChapters/coverUrl 刻意不投影（additionalProperties:false 下超集会被拒） */
type ShelfItem = {
  sourceId: string; bookKey: string; title: string
  author?: string; lastChapterName?: string; kind?: string; wordCount?: string
  progress: ShelfBook['progress']; addedAt: number
}
const pickShelfItem = (b: ShelfBook): ShelfItem => ({
  sourceId: b.sourceId, bookKey: b.bookKey, title: b.title,
  author: b.author, lastChapterName: b.lastChapterName,
  kind: b.kind, wordCount: b.wordCount,
  progress: b.progress, addedAt: b.addedAt,
})

/** 注册六工具并返回聚合 disposer（apply 里 ctx.effect 用） */
export function registerTools(ctxLike: ToolsCtxLike, service: ReadingService): () => void {
  const disposers = buildTools(service).map((t) => ctxLike.tools.register(t))
  return () => { for (const d of disposers) d() }
}
