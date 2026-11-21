import { describe, expect, it } from 'vitest'
import { buildTools } from '../../src/tools/tools.js'
import type { ReadingService } from '../../src/services/reading.js'
import { must } from '../support/fixture.js'

/**
 * 工具声明面钉子：action 行是唯一清单。
 *
 * ① 每个 action 都有 render，且不会落到「未知 action」兜底；
 * ② 缺参错误里点名的键必须在参数表里有声明。per-action 必填只住 `needs`——宿主只收
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
  return must(tool, `工具 ${name}`)
}

interface ParamSchema {
  properties?: Record<string, { enum?: string[]; description?: string }>
}

const paramsOf = (tool: ReturnType<typeof buildTools>[number]): ParamSchema =>
  tool.parameters

const actionsOf = (name: string): string[] => {
  const values = paramsOf(toolNamed(name)).properties?.action?.enum
  expect(values, `${name} 没有 action enum`).toBeDefined()
  return must(values, `${name} 的 action enum`)
}

const exec = { signal: new AbortController().signal } as never

/** 抛出值可能是任何东西：先取它的 message，取不到就把值本身串起来（中转成 `unknown` 是为了绕过把 `{}` 当对象的收窄）。 */
function thrownMessage(e: unknown): string {
  const thrown: unknown = e
  return String((thrown as { message?: unknown }).message ?? thrown)
}

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
    'ai-enable': { action: 'ai-enable', sourceId: 's', aiSearch: true },
    'ai-disable': { action: 'ai-disable', sourceId: 's', aiSearch: false },
    remove: { action: 'remove', sourceId: 's', removed: true },
  },
}

describe('工具声明：action 行是唯一清单', () => {
  it('每个 action 都有 render，且不落「未知 action」兜底', () => {
    for (const name of ['dshnovel_shelf', 'dshnovel_source']) {
      const tool = toolNamed(name)
      for (const action of actionsOf(name)) {
        const value = must(must(renderValues[name], `${name} 的 render 样本`)[action], `${name}.${action} 的 render 样本`)
        const blocks = tool.output.render({ action }, value as never)
        expect(blocks.length, `${name}.${action} 没有 render 输出`).toBeGreaterThan(0)
        expect(JSON.stringify(blocks), `${name}.${action} 落到未知 action 兜底`).not.toContain('未知 action')
      }
    }
  })

  it('缺参错误点名的键都在参数表里有声明', async () => {
    for (const name of ['dshnovel_shelf', 'dshnovel_source']) {
      const tool = toolNamed(name)
      const properties = paramsOf(tool).properties ?? {}
      for (const action of actionsOf(name)) {
        const error = await tool.execute({ action }, exec).then(() => null, (e: unknown) => e)
        if (error === null) continue   // list 无必填：stub 服务直接跑通
        const message = thrownMessage(error)
        expect(message, `${name}.${action} 缺参没有点名`).toContain('缺少参数：')
        const keys = message.slice(message.indexOf('缺少参数：') + '缺少参数：'.length).split('、')
        for (const key of keys) expect(properties[key], `${name}.${action} 的 ${key} 不在参数表`).toBeDefined()
      }
    }
  })

  /**
   * 描述里的「哪个 action 必填」由 `needs` 行派生（加 action 不必回来改第二份清单）。
   * 这条用例**从缺参回执反推**必填集再对描述——不抄 needs 表、也不抄 needsDoc 的措辞格式：
   * 描述改写成另一种说法仍可过，漏掉某个 action 才红。
   */
  it('参数描述点名了必填它的 action（黑盒反推，不抄行表）', async () => {
    for (const name of ['dshnovel_shelf', 'dshnovel_source']) {
      const tool = toolNamed(name)
      const properties = paramsOf(tool).properties ?? {}
      const actions = actionsOf(name)
      const requiredBy = new Map<string, string[]>()
      for (const action of actions) {
        const error = await tool.execute({ action }, exec).then(() => null, (e: unknown) => e)
        if (error === null) continue
        const message = thrownMessage(error)
        if (!message.includes('缺少参数：')) continue
        for (const key of message.slice(message.indexOf('缺少参数：') + '缺少参数：'.length).split('、')) {
          requiredBy.set(key, [...(requiredBy.get(key) ?? []), action])
        }
      }
      expect(requiredBy.size, `${name} 反推不出任何必填键：黑盒判据空转`).toBeGreaterThan(0)
      for (const [key, prop] of Object.entries(properties)) {
        const desc = prop.description ?? ''
        const required = requiredBy.get(key) ?? []
        if (required.length === 0) {
          expect(desc, `${name}.${key} 并不必填，描述却说必填`).not.toContain('必填')
          continue
        }
        if (required.length === actions.length) {
          expect(desc, `${name}.${key} 全部 action 都必填，描述没这么说`).toContain('所有')
          continue
        }
        for (const action of required) {
          expect(desc, `${name}.${key} 描述漏了必填它的 ${action}`).toContain(action)
        }
      }
    }
  })
})
