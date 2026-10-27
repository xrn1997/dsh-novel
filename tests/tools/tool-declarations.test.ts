import { describe, expect, it } from 'vitest'
import { buildTools } from '../../src/tools/tools.js'
import type { ReadingService } from '../../src/services/reading.js'

/**
 * 工具声明面钉子：action 行是唯一清单。
 *
 * ① enum 与行集一致；② 每个 action 都有 render，且不会落到「未知 action」兜底；
 * ③ 缺参错误里点名的键必须在参数表里有声明。per-action 必填只住 `needs`——宿主只收
 * 一份 implicit-open 参数 schema，`schema.required` 表达不了「按 action 条件必填」。
 */

const service = {
  shelfList: () => [],
  listPublicSources: () => [],
} as unknown as ReadingService

const tools = buildTools(service)
const toolNamed = (name: string): ReturnType<typeof buildTools>[number] => {
  const tool = tools.find((t) => t.name === name)
  expect(tool, `工具 ${name} 不存在`).toBeDefined()
  return tool!
}

interface ParamSchema {
  properties?: Record<string, { enum?: string[]; description?: string }>
}

const paramsOf = (tool: ReturnType<typeof buildTools>[number]): ParamSchema =>
  tool.parameters as unknown as ParamSchema

const actionsOf = (name: string): string[] => {
  const values = paramsOf(toolNamed(name)).properties?.action?.enum
  expect(values, `${name} 没有 action enum`).toBeDefined()
  return values!
}

const exec = { signal: new AbortController().signal } as never

const shelfItem = {
  sourceId: 's', bookKey: 'k', title: 'T',
  progress: { chapterIndex: 0, offsetRatio: 0, updatedAt: 0 }, addedAt: 0,
}

/** 每个 action 的最小规范值：render 不许为缺失字段编回执，声明测试喂的必须是 execute 真会产出的形状。 */
const renderValues: Record<string, Record<string, Record<string, unknown>>> = {
  dshnovel_shelf: {
    list: { action: 'list', books: [] },
    add: { action: 'add', book: shelfItem },
    save_progress: { action: 'save_progress', book: shelfItem },
    remove: { action: 'remove', removed: true },
  },
  dshnovel_source: {
    list: { action: 'list', sources: [] },
    probe: { action: 'probe', ok: true, itemCount: 0 },
    enable: { action: 'enable', sourceId: 's', enabled: true },
    disable: { action: 'disable', sourceId: 's', enabled: false },
    remove: { action: 'remove', sourceId: 's', removed: true },
  },
}

describe('工具声明：action 行是唯一清单', () => {
  it('书架与书源的 enum 与行集一致', () => {
    expect(actionsOf('dshnovel_shelf')).toEqual(['list', 'add', 'save_progress', 'remove'])
    expect(actionsOf('dshnovel_source')).toEqual(['list', 'probe', 'enable', 'disable', 'remove'])
  })

  it('每个 action 都有 render，且不落「未知 action」兜底', () => {
    for (const name of ['dshnovel_shelf', 'dshnovel_source']) {
      const tool = toolNamed(name)
      for (const action of actionsOf(name)) {
        const blocks = tool.output.render({ action }, renderValues[name]![action]! as never)
        expect(blocks.length, `${name}.${action} 没有 render 输出`).toBeGreaterThan(0)
        expect(JSON.stringify(blocks), `${name}.${action} 落到未知 action 兜底`).not.toContain('未知 action')
      }
    }
  })

  it('参数描述里的必填 action 由行派生（加 action 不再手改第二份清单）', () => {
    const shelf = paramsOf(toolNamed('dshnovel_shelf')).properties!
    expect(shelf.bookKey?.description).toBe('书籍详情页 URL（add/save_progress/remove 必填；list 不用）')
    expect(shelf.title?.description).toBe('书名（仅 add 必填）')
    expect(shelf.sourceId?.description).toBe('源 id（仅 add 必填）')
    expect(shelf.chapterIndex?.description).toBe('读到的章序 0 起（仅 save_progress 必填）')
    const source = paramsOf(toolNamed('dshnovel_source')).properties!
    expect(source.sourceId?.description).toBe('源 id（probe/enable/disable/remove 必填；list 不用）')
  })

  it('缺参错误点名的键都在参数表里有声明', async () => {
    for (const name of ['dshnovel_shelf', 'dshnovel_source']) {
      const tool = toolNamed(name)
      const properties = paramsOf(tool).properties ?? {}
      for (const action of actionsOf(name)) {
        const error = await tool.execute({ action }, exec).then(() => null, (e: unknown) => e)
        if (error === null) continue   // list 无必填：stub 服务直接跑通
        const message = String((error as Error).message ?? error)
        expect(message, `${name}.${action} 缺参没有点名`).toContain('缺少参数：')
        const keys = message.slice(message.indexOf('缺少参数：') + '缺少参数：'.length).split('、')
        for (const key of keys) expect(properties[key], `${name}.${action} 的 ${key} 不在参数表`).toBeDefined()
      }
    }
  })

  it('六个工具都交出了 render', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'dshnovel_import_source', 'dshnovel_read', 'dshnovel_search',
      'dshnovel_shelf', 'dshnovel_source', 'dshnovel_toc',
    ])
    for (const tool of tools) expect(typeof tool.output.render).toBe('function')
  })
})
