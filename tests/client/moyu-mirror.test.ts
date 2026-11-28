import { describe, expect, it } from 'vitest'
import {
  projectMoyuMirrorTurns,
  replaceMoyuMirrorTurns,
  resetMoyuMirrorForTests,
  moyuMirrorStore,
} from '../../src/client/moyu-mirror.js'

/**
 * 真轮次镜像的投影层：宿主 `ChatSnapshot` 窄镜像 → 舞台行。
 * 判据三条腿：五形态映射、未映射占位（宁降勿猜）、形状漂移＝该轮降级（失败半径＝那一轮）。
 */

interface RawNode {
  key: string
  kind?: string
  data?: unknown
  visibility?: 'visible' | 'hidden'
  turn?: number
}

function snapshotOf(nodes: readonly RawNode[]): unknown {
  const byKey = new Map(nodes.map((node) => [node.key, {
    ...(node.kind === undefined ? {} : { kind: node.kind }),
    data: node.data,
    visibility: node.visibility ?? 'visible',
    location: node.turn === undefined ? { kind: 'unresolved' } : { kind: 'turn', turn: { turn: node.turn } },
  }]))
  return {
    order: nodes.map((node) => node.key),
    nodes: { get: (key: string) => byKey.get(key) },
  }
}

const userNode = (key: string, text: string, time: number, turn: number): RawNode => ({
  key,
  kind: 'user',
  data: { content: [{ type: 'text', text }], time },
  turn,
})

describe('真轮次镜像投影：节点 → 舞台行映射', () => {
  it('五形态映射：用户气泡（真 prompt）/ 思考行（真 reasoning）/ 工具行（真名 · 摘要）/ 助手正文 / 轮尾（真时刻 + 真用量）', () => {
    const turns = projectMoyuMirrorTurns('s-1', 'book-1', snapshotOf([
      userNode('n1', '帮我读第一章', 1_700_000_000_000, 1),
      {
        key: 'n2', kind: 'assistant-step', turn: 1,
        data: {
          status: 'settled', turn: 1, step: 1, time: 1_700_000_001_000,
          blocks: [
            { kind: 'reasoning', text: '先核对章节结构。\n第二行。' },
            { kind: 'text', text: '第一章讲的是……' },
          ],
        },
      },
      {
        key: 'n3', kind: 'tool-call', turn: 1,
        data: {
          root: {
            kind: 'tool-result', callId: 'c1', name: 'dshnovel_read', seq: 3, time: 1_700_000_002_000,
            args: {}, call: { name: 'dshnovel_read', argsRaw: '{"chapterIndex":0}' }, callTime: 1,
            content: [], isError: false, subCalls: [],
          },
        },
      },
      {
        key: 'n4', kind: 'turn-tail', turn: 1,
        data: { turn: 1, seq: 4, time: 1_700_000_003_000, closing: null, branchUnavailable: false, tokenUsage: { totalTokens: 12345, outputTokens: 500 } },
      },
    ]), 0)

    expect(turns).toHaveLength(1)
    const [turn] = turns
    expect(turn?.sessionId).toBe('s-1')
    expect(turn?.degraded).toBe(false)
    expect(turn?.startedAt).toBe(1_700_000_000_000)
    expect(turn?.rows).toEqual([
      { kind: 'user', key: 'n1', text: '帮我读第一章', time: 1_700_000_000_000 },
      { kind: 'think', key: 'n2:0', body: '先核对章节结构。\n第二行。' },
      { kind: 'text', key: 'n2:1', text: '第一章讲的是……' },
      { kind: 'tool', key: 'n3', name: 'dshnovel_read', summary: '{"chapterIndex":0}', running: false },
      { kind: 'tail', key: 'n4', time: 1_700_000_003_000, usage: 12345 },
    ])
  })

  it('steering＝真人消息同出用户气泡；工具行只从 tool-call 节点出（assistant 块里的 tool-call 不重复计数）', () => {
    const turns = projectMoyuMirrorTurns('s-1', 'book-1', snapshotOf([
      userNode('n1', '开始', 1_000, 1),
      {
        key: 'n2', kind: 'steering', turn: 1,
        data: { messageId: 'm1', seq: 2, time: 1_100, content: [{ type: 'text', text: '插一句：先看目录。' }] },
      },
      {
        key: 'n3', kind: 'assistant-step', turn: 1,
        data: {
          turn: 1, step: 1, time: 1_200,
          blocks: [{ kind: 'tool-call', callId: 'c9', name: 'x', argsRaw: '{}' }],
        },
      },
    ]), 0)
    const rows = turns[0]?.rows ?? []
    expect(rows.map((row) => row.kind)).toEqual(['user', 'user'])
    expect(rows[1]).toMatchObject({ kind: 'user', text: '插一句：先看目录。', time: 1_100 })
  })

  it('在跑的工具行带 running 档（preparing 不搬惰性 args、摘要留空）', () => {
    const turns = projectMoyuMirrorTurns('s-1', 'book-1', snapshotOf([
      {
        key: 'n1', kind: 'tool-call', turn: 1,
        data: {
          root: {
            phase: 'preparing', callId: 'c1', name: 'dshnovel_search', turn: 1, step: 1, time: 5, args: {}, subCalls: [],
          },
        },
      },
    ]), 0)
    expect(turns[0]?.rows).toEqual([
      { kind: 'tool', key: 'n1', name: 'dshnovel_search', summary: '', running: true },
    ])
  })

  it('未映射的节点种类如实降级为中性占位行（宁降勿猜：turn-process / compaction / context / model-retry 都不编形态）', () => {
    const turns = projectMoyuMirrorTurns('s-1', 'book-1', snapshotOf([
      userNode('n1', 'hi', 1_000, 1),
      { key: 'n2', kind: 'turn-process', turn: 1, data: { turn: 1 } },
      { key: 'n3', kind: 'compaction', turn: 1, data: {} },
      { key: 'n4', kind: 'context', turn: 1, data: {} },
      { key: 'n5', kind: 'model-retry', turn: 1, data: {} },
    ]), 0)
    expect(turns[0]?.rows.map((row) => row.kind)).toEqual([
      'user', 'placeholder', 'placeholder', 'placeholder', 'placeholder',
    ])
    expect(turns[0]?.degraded).toBe(false)
  })

  it('拍板：turn-error 接 M4 错误行（真失败消息 + 真 code）；message 缺＝该轮降级', () => {
    const turns = projectMoyuMirrorTurns('s-1', 'book-1', snapshotOf([
      userNode('n1', 'hi', 1_000, 1),
      { key: 'n2', kind: 'turn-error', turn: 1, data: { kind: 'turn-error', message: 'quota exceeded', code: 'quota' } },
      { key: 'n3', kind: 'turn-error', turn: 1, data: { kind: 'turn-error', message: '' } },
    ]), 0)
    expect(turns[0]?.degraded).toBe(false)
    expect(turns[0]?.rows).toEqual([
      { kind: 'user', key: 'n1', text: 'hi', time: 1_000 },
      { kind: 'error', key: 'n2', message: 'quota exceeded', code: 'quota' },
      { kind: 'error', key: 'n3', message: '', code: undefined },
    ])
    // 形状守卫不因新映射松动：message 缺（必填格）＝照旧整轮降级。
    const bad = projectMoyuMirrorTurns('s-1', 'book-1', snapshotOf([
      { key: 'n1', kind: 'turn-error', turn: 1, data: { kind: 'turn-error', code: 'quota' } },
    ]), 0)
    expect(bad[0]?.degraded).toBe(true)
  })

  it('轮尾计账不全＝只有真时刻（不折算补位）；用户气泡的非文本内容块＝占位行', () => {
    const turns = projectMoyuMirrorTurns('s-1', 'book-1', snapshotOf([
      {
        key: 'n1', kind: 'user', turn: 1,
        data: { content: [{ type: 'text', text: '带图' }, { type: 'image', attachment: {} }], time: 9 },
      },
      { key: 'n2', kind: 'turn-tail', turn: 1, data: { turn: 1, seq: 2, time: 10 } },
    ]), 0)
    expect(turns[0]?.rows).toEqual([
      { kind: 'user', key: 'n1', text: '带图', time: 9 },
      { kind: 'placeholder', key: 'n1:1' },
      { kind: 'tail', key: 'n2', time: 10, usage: null },
    ])
  })

  it('hidden 节点不上屏（宿主隐藏＝不渲染，不算降级）', () => {
    const turns = projectMoyuMirrorTurns('s-1', 'book-1', snapshotOf([
      userNode('n1', 'hi', 1_000, 1),
      { key: 'n2', kind: 'turn-process', turn: 1, visibility: 'hidden', data: {} },
    ]), 0)
    expect(turns[0]?.rows.map((row) => row.kind)).toEqual(['user'])
  })
})

describe('真轮次镜像投影：分组与交错键', () => {
  it('按宿主轮号分组；user 开新轮；startedAt＝首条用户行的真时刻', () => {
    const turns = projectMoyuMirrorTurns('s-1', 'book-1', snapshotOf([
      userNode('n1', '第一问', 1_000, 1),
      { key: 'n2', kind: 'turn-tail', turn: 1, data: { turn: 1, seq: 2, time: 1_500 } },
      userNode('n3', '第二问', 2_000, 2),
      { key: 'n4', kind: 'turn-tail', turn: 2, data: { turn: 2, seq: 4, time: 2_500 } },
    ]), 9_999)
    expect(turns.map((turn) => turn.startedAt)).toEqual([1_000, 2_000])
    expect(turns.map((turn) => turn.rows.map((row) => row.kind))).toEqual([
      ['user', 'tail'],
      ['user', 'tail'],
    ])
    expect(turns.map((turn) => turn.key)).toEqual(['mirror-s-1-1', 'mirror-s-1-2'])
  })

  it('轮号缺席时 user 自开一轮；startedAt 拿不到真时刻才回落投影时刻', () => {
    const turns = projectMoyuMirrorTurns('s-1', 'book-1', snapshotOf([
      { key: 'n1', kind: 'user', data: { content: [{ type: 'text', text: 'a' }] } },
      { key: 'n2', kind: 'user', data: { content: [{ type: 'text', text: 'b' }] } },
    ]), 7_777)
    expect(turns).toHaveLength(2)
    expect(turns.map((turn) => turn.startedAt)).toEqual([7_777, 7_777])
    expect(turns.map((turn) => turn.rows[0])).toMatchObject([
      { kind: 'user', text: 'a', time: null },
      { kind: 'user', text: 'b', time: null },
    ])
  })
})

describe('真轮次镜像投影：形状漂移的失败半径', () => {
  it('认识的节点形状不对＝该轮降级，别轮照常（失败半径＝那一轮）', () => {
    const turns = projectMoyuMirrorTurns('s-1', 'book-1', snapshotOf([
      userNode('n1', '好轮', 1_000, 1),
      { key: 'n2', kind: 'turn-tail', turn: 1, data: { turn: 1, seq: 2, time: 1_500 } },
      // 第二轮的 user 节点缺 content（必填格）＝形状漂移。
      { key: 'n3', kind: 'user', turn: 2, data: { time: 2_000 } },
      userNode('n4', '好轮', 3_000, 3),
    ]), 0)
    expect(turns).toHaveLength(3)
    expect(turns.map((turn) => turn.degraded)).toEqual([false, true, false])
    expect(turns[0]?.rows.map((row) => row.kind)).toEqual(['user', 'tail'])
    expect(turns[2]?.rows.map((row) => row.kind)).toEqual(['user'])
  })

  it('节点连种类都没有＝归当前轮降级；轮尾时间不是数字＝该轮降级', () => {
    const turns = projectMoyuMirrorTurns('s-1', 'book-1', snapshotOf([
      userNode('n1', 'hi', 1_000, 1),
      { key: 'n2', turn: 1, data: {} },
    ]), 0)
    expect(turns[0]?.degraded).toBe(true)
    const turns2 = projectMoyuMirrorTurns('s-1', 'book-1', snapshotOf([
      { key: 'n1', kind: 'turn-tail', turn: 1, data: { turn: 1, time: 'not-a-time' } },
    ]), 0)
    expect(turns2[0]?.degraded).toBe(true)
    expect(turns2).toHaveLength(1)
  })

  it('快照顶层形状不对＝只出一条降级占位轮；无快照＝不镜像（不是失败）', () => {
    expect(projectMoyuMirrorTurns('s-1', 'book-1', undefined, 0)).toEqual([])
    const degraded = projectMoyuMirrorTurns('s-1', 'book-1', { order: 'not-an-array', nodes: {} }, 0)
    expect(degraded).toHaveLength(1)
    expect(degraded[0]?.degraded).toBe(true)
    const noGet = projectMoyuMirrorTurns('s-1', 'book-1', { order: [], nodes: {} }, 0)
    expect(noGet[0]?.degraded).toBe(true)
  })
})

describe('镜像活口的按会话换代', () => {
  it('replaceMoyuMirrorTurns 只换本会话的镜像；clear 摘掉一个会话', () => {
    resetMoyuMirrorForTests()
    replaceMoyuMirrorTurns('s-1', projectMoyuMirrorTurns('s-1', 'book-1', snapshotOf([userNode('n1', 'a', 1, 1)]), 0))
    replaceMoyuMirrorTurns('s-2', projectMoyuMirrorTurns('s-2', 'book-2', snapshotOf([userNode('n2', 'b', 2, 1)]), 0))
    expect(moyuMirrorStore.get().turns.map((turn) => turn.sessionId)).toEqual(['s-1', 's-2'])
    replaceMoyuMirrorTurns('s-1', projectMoyuMirrorTurns('s-1', 'book-1', snapshotOf([
      userNode('n1', 'a', 1, 1),
      userNode('n3', 'c', 3, 2),
    ]), 0))
    expect(moyuMirrorStore.get().turns.map((turn) => turn.sessionId)).toEqual(['s-2', 's-1', 's-1'])
    resetMoyuMirrorForTests()
  })
})
