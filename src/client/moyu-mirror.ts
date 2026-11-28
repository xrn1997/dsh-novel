/**
 * 真轮次镜像：把宿主真会话的 `ChatSnapshot`（`uiConversation.binding(...).target('chat')`）
 * 投影成摸鱼舞台**已有形态**的行（用户气泡 / 思考行 / 工具行 / 助手正文 / 轮尾 / M4 错误行），与章轮次
 * （假数据）按真实进入时刻交错共存于同一条对话流；镜像轮与章轮共用同一套舞台组件，不加「这是真的」标记。
 *
 * 真值口径（镜像轮）：轮尾时刻取宿主事件的真实 epoch（**不走假时钟 `moyu-clock`**），用量取宿主
 * `turn-tail` 的真计账（`tokenUsage.totalTokens`，缺就是没有——宿主对不全的计账本来就不给总数，
 * 我们不折算 `~tok` 补位）。
 *
 * 镜像只读：宿主会话由用户在宿主界面里使用，本模块不投递、不改写、不撤销任何一轮（`ADR-0108`）。
 *
 * 防御（`ADR-0108` 的「跨代形状漂移未核」）：节点形状一律**运行时守卫**——
 * - 认不出的节点种类 → 中性占位行（宁降勿猜，不替宿主种类编舞台语义）；
 * - 认识但形状不对（必填格缺失 / 类型不符）→ **该轮降级**（失败半径＝那一轮），不炸整条流；
 * - 快照顶层形状不对 → 只出一条降级占位轮，镜像面其余照旧。
 * 类型面是宿主契约的窄镜像（`ADR-0020`）：不引宿主 chat 视图包的类型——跨代漂移靠守卫降级，
 * 不靠 tsc 假绿（编译期按宿主当版节点契约核对过形状）。
 */

import { createStore } from './store.js'
import type { Store } from './store.js'

/* ── 镜像行（映射目标只有舞台已有形态：五形态 + M4 错误行 + 中性占位行）──────── */

/** 一轮镜像的行：key 是宿主节点 key（+块序）拼的稳定身份（React key / 折叠态寻址共用）。 */
export type MoyuMirrorRow =
  /** 用户气泡（真 prompt 文本；`user` / `steering` 两种真人消息）。 */
  | { kind: 'user'; key: string; text: string; time: number | null }
  /** 思考行（真 reasoning；`assistant-step` 的 reasoning 块）。 */
  | { kind: 'think'; key: string; body: string }
  /** 工具行（真工具名 / 摘要；`tool-call` 节点的根调用与子调用，照 ToolRow 形态）。 */
  | { kind: 'tool'; key: string; name: string; summary: string; running: boolean }
  /** 助手正文（真文本；`assistant-step` 的 text 块）。 */
  | { kind: 'text'; key: string; text: string }
  /** 轮尾（真时刻 + 真用量；`turn-tail` 节点）。 */
  | { kind: 'tail'; key: string; time: number; usage: number | null }
  /** 错误行（M4 形态：「本轮运行失败」+ 真失败消息 + 错误码芯片；`turn-error` 节点）。 */
  | { kind: 'error'; key: string; message: string; code: string | undefined }
  /** 中性占位行：未映射的节点种类、认不出的内容块、降级轮的兜底。 */
  | { kind: 'placeholder'; key: string }

/** 一轮镜像（宿主一个 turn 投影成一节舞台轮次）。 */
export interface MoyuMirrorTurn {
  /** 稳定身份（宿主轮号 + 首节点 key；降级占位轮用具名 key）。 */
  key: string
  sessionId: string
  /** 起这次入口的书：镜像轮只进这本书的对话流。 */
  bookKey: string
  /** 交错键：该轮进入会话流的真实时刻（epoch ms）——首条用户行的真时刻，缺则行内最早时刻，
   *  再缺才回落投影时刻（只用于排序，不上屏）。 */
  startedAt: number
  /** 形状漂移＝该轮降级（渲染只剩中性占位行；失败半径＝那一轮）。 */
  degraded: boolean
  rows: MoyuMirrorRow[]
}

export interface MoyuMirrorState {
  turns: MoyuMirrorTurn[]
}

/** 镜像投影的活口（跨面板卸载存活，听书播放层同款）：舞台只消费这份成品。 */
export const moyuMirrorStore: Store<MoyuMirrorState> = createStore<MoyuMirrorState>({ turns: [] })

/** 按会话替换镜像轮（同一会话的旧投影整体换代；其他会话的镜像不动）。 */
export function replaceMoyuMirrorTurns(sessionId: string, turns: readonly MoyuMirrorTurn[]): void {
  moyuMirrorStore.set({
    turns: [...moyuMirrorStore.get().turns.filter((turn) => turn.sessionId !== sessionId), ...turns],
  })
}

/** 摘掉一个会话的镜像（换入口 / 引用释放时清场）。 */
export function clearMoyuMirrorSession(sessionId: string): void {
  moyuMirrorStore.set({
    turns: moyuMirrorStore.get().turns.filter((turn) => turn.sessionId !== sessionId),
  })
}

/** 测试收口：清空镜像活口。 */
export function resetMoyuMirrorForTests(): void {
  moyuMirrorStore.set({ turns: [] })
}

/* ── 运行时守卫（跨代漂移的防线）───────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 形状漂移信号：认识的节点种类缺必填格 / 类型不符＝该轮降级（不是抛给外面炸流）。 */
class MirrorDrift extends Error {}

function drift(): never {
  throw new MirrorDrift('moyu mirror shape drift')
}

/** 必填字符串格：缺失或类型不符＝漂移。 */
function requiredString(source: Record<string, unknown>, field: string): string {
  const value = source[field]
  if (typeof value !== 'string') drift()
  return value
}

/** 可选数字格：缺失＝回落 null；给了但不是数字＝漂移。 */
function optionalNumber(source: Record<string, unknown>, field: string): number | null {
  const value = source[field]
  if (value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) drift()
  return value
}

/** 可选数组格：缺失＝空；给了但不是数组＝漂移。 */
function optionalArray(source: Record<string, unknown>, field: string): readonly unknown[] {
  const value = source[field]
  if (value === undefined) return []
  if (!Array.isArray(value)) drift()
  return value
}

/* ── 节点 → 行（纯函数，逐格守卫）─────────────────────────────────────────── */

/** `user` / `steering` → 用户气泡（真 prompt 文本）；非文本内容块如实占位。 */
function rowsOfMessage(key: string, data: Record<string, unknown>): MoyuMirrorRow[] {
  const content = data['content']
  if (!Array.isArray(content)) drift()
  const time = optionalNumber(data, 'time')
  const rows: MoyuMirrorRow[] = []
  const texts: string[] = []
  for (const [index, block] of content.entries()) {
    if (!isRecord(block) || typeof block['type'] !== 'string') drift()
    const blockKey = `${key}:${index}`
    if (block['type'] === 'text') {
      const text = requiredString(block, 'text')
      if (text !== '') texts.push(text)
      continue
    }
    // 内容块是宿主 merge-extensible 的（image / file / 未知档都可能来）：认不出的档不猜形态，占位。
    rows.push({ kind: 'placeholder', key: blockKey })
  }
  const text = texts.join('\n')
  return [{ kind: 'user', key, text, time }, ...rows]
}

/** `assistant-step` → 思考行（真 reasoning）/ 助手正文（真文本）；工具行只从 `tool-call` 节点出（防重复计数）。 */
function rowsOfAssistantStep(key: string, data: Record<string, unknown>): MoyuMirrorRow[] {
  const blocks = data['blocks']
  if (!Array.isArray(blocks)) drift()
  const rows: MoyuMirrorRow[] = []
  for (const [index, block] of blocks.entries()) {
    const blockKey = `${key}:${index}`
    if (!isRecord(block) || typeof block['kind'] !== 'string') drift()
    const kind = block['kind']
    if (kind === 'text') {
      const text = requiredString(block, 'text')
      if (text !== '') rows.push({ kind: 'text', key: blockKey, text })
      continue
    }
    if (kind === 'reasoning') {
      const body = requiredString(block, 'text')
      if (body !== '') rows.push({ kind: 'think', key: blockKey, body })
      continue
    }
    if (kind === 'tool-call') {
      // 工具行的唯一来源是 `tool-call` 节点（ToolChatData 的根生命周期）：这里跳过，避免同一调用出两行。
      continue
    }
    // image / other / 未登记块档：不猜形态，中性占位（正文 markdown 渲染不在本期）。
    rows.push({ kind: 'placeholder', key: blockKey })
  }
  return rows
}

/** 一枚工具调用（根或子调用）→ 工具行（真工具名 / 摘要）。 */
function rowOfToolCall(key: string, block: Record<string, unknown>, depth: number, out: MoyuMirrorRow[]): void {
  if (depth > 8) return
  const callId = block['callId']
  if (typeof callId !== 'string') drift()
  const settled = block['kind'] === 'tool-result'
  let name: string
  let summary = ''
  let running = false
  if (settled) {
    const call = block['call']
    const callHead = isRecord(call) ? call : null
    name = typeof block['name'] === 'string' ? block['name'] : ''
    if (name === '' && callHead !== null && typeof callHead['name'] === 'string') name = callHead['name']
    if (name === '') name = callId
    if (callHead !== null && typeof callHead['argsRaw'] === 'string') summary = callHead['argsRaw']
    else if (typeof block['argsRaw'] === 'string') summary = block['argsRaw']
  } else {
    // preparing / start 两档在跑（`phase` 辨识）；preparing 的 args 是惰性读面，不搬进自持状态（宿主契约口径）。
    const phase = block['phase']
    if (phase !== 'preparing' && phase !== 'start') drift()
    name = requiredString(block, 'name')
    running = true
    if (typeof block['argsRaw'] === 'string') summary = block['argsRaw']
  }
  out.push({
    kind: 'tool',
    key,
    name,
    summary: summary.replace(/\s+/g, ' ').trim().slice(0, 160),
    running,
  })
  const subCalls = optionalArray(block, 'subCalls')
  for (const [index, subCall] of subCalls.entries()) {
    if (!isRecord(subCall)) drift()
    rowOfToolCall(`${key}:${index}`, subCall, depth + 1, out)
  }
}

/** `tool-call` → 工具行（根调用 + 子调用按派发序摊平）。 */
function rowsOfToolNode(key: string, data: Record<string, unknown>): MoyuMirrorRow[] {
  const root = data['root']
  if (!isRecord(root)) drift()
  const rows: MoyuMirrorRow[] = []
  rowOfToolCall(key, root, 0, rows)
  return rows
}

/** `turn-tail` → 轮尾（真时刻 + 真用量；计账不全＝只有真时刻，不折算补位）。 */
function rowsOfTurnTail(key: string, data: Record<string, unknown>): MoyuMirrorRow[] {
  const time = data['time']
  if (typeof time !== 'number' || !Number.isFinite(time)) drift()
  const tokenUsage = data['tokenUsage']
  let usage: number | null = null
  if (isRecord(tokenUsage) && typeof tokenUsage['totalTokens'] === 'number' && Number.isFinite(tokenUsage['totalTokens'])) {
    usage = tokenUsage['totalTokens']
  }
  return [{ kind: 'tail', key, time, usage }]
}

/** `turn-error` → 错误行（M4 形态：真失败消息 + 真错误 code；芯片档位渲染时按 `moyu-metrics.errorCodeOf` 归档）。 */
function rowsOfTurnError(key: string, data: Record<string, unknown>): MoyuMirrorRow[] {
  const message = requiredString(data, 'message')
  const code = data['code']
  if (code !== undefined && typeof code !== 'string') drift()
  return [{ kind: 'error', key, message, code: typeof code === 'string' ? code : undefined }]
}

/** 认识的节点种类 → 行；认不出的种类 → 中性占位行（宁降勿猜）。 */
function rowsOfNode(key: string, kind: string, data: unknown): MoyuMirrorRow[] {
  if (kind === 'user' || kind === 'steering') {
    // `steering` 的判据（拍板）：宿主语义里它是「插话进在跑一轮的**真人消息**」（records.ts 原话），
    // 内容形状与 `user` 同（真 prompt 文本）——同一条「真人消息 → 用户气泡」映射，不是猜形态。
    if (!isRecord(data)) drift()
    return rowsOfMessage(key, data)
  }
  if (kind === 'assistant-step') {
    if (!isRecord(data)) drift()
    return rowsOfAssistantStep(key, data)
  }
  if (kind === 'tool-call') {
    if (!isRecord(data)) drift()
    return rowsOfToolNode(key, data)
  }
  if (kind === 'turn-tail') {
    if (!isRecord(data)) drift()
    return rowsOfTurnTail(key, data)
  }
  if (kind === 'turn-error') {
    if (!isRecord(data)) drift()
    return rowsOfTurnError(key, data)
  }
  // turn-process / turn-max-tokens / model-retry / command / compaction / context /
  // turn-trigger / system-prompt / unknown / 未来种类：不映射五形态之外的语义，如实占位。
  return [{ kind: 'placeholder', key }]
}

/* ── 快照 → 轮次（纯函数，分组 + 交错键）──────────────────────────────────── */

function turnOrdinalOf(data: unknown, location: unknown): number | null {
  if (isRecord(data) && typeof data['turn'] === 'number' && Number.isFinite(data['turn'])) return data['turn']
  if (isRecord(location)) {
    const turn = location['turn']
    if (isRecord(turn) && typeof turn['turn'] === 'number' && Number.isFinite(turn['turn'])) return turn['turn']
    const step = location['step']
    if (isRecord(step) && typeof step['turn'] === 'number' && Number.isFinite(step['turn'])) return step['turn']
    if (isRecord(step) && isRecord(step['turn']) && typeof step['turn']['turn'] === 'number') return step['turn']['turn']
  }
  return null
}

function startedAtOf(rows: readonly MoyuMirrorRow[], fallback: number): number {
  const times: number[] = []
  for (const row of rows) {
    if (row.kind === 'user' && row.time !== null) times.push(row.time)
    if (row.kind === 'tail') times.push(row.time)
  }
  return times.length === 0 ? fallback : Math.min(...times)
}

/**
 * `ChatSnapshot` 窄镜像 → 舞台轮次（wholesale 投影：每次快照通知整体重建该会话的镜像）。
 * `nowMs` 只作交错键兜底（不上屏）。形状守卫逐轮生效：某轮漂移只降那一轮。
 */
export function projectMoyuMirrorTurns(
  sessionId: string,
  bookKey: string,
  snapshot: unknown,
  nowMs: number,
): MoyuMirrorTurn[] {
  if (snapshot === undefined || snapshot === null) return []
  if (!isRecord(snapshot)) return [degradedTurn(sessionId, bookKey)]
  const order = snapshot['order']
  const nodes = snapshot['nodes']
  if (!Array.isArray(order) || !isRecord(nodes) || typeof nodes['get'] !== 'function') return [degradedTurn(sessionId, bookKey)]
  const get = nodes['get'] as (key: string) => unknown
  const turns: MoyuMirrorTurn[] = []
  let current: { key: string; turn: number | null; rows: MoyuMirrorRow[]; degraded: boolean } | null = null
  const push = (): void => {
    if (current === null) return
    const startedAt = startedAtOf(current.rows, nowMs)
    turns.push({
      key: current.key,
      sessionId,
      bookKey,
      startedAt,
      degraded: current.degraded,
      rows: current.rows,
    })
    current = null
  }
  for (const entry of order) {
    if (typeof entry !== 'string') continue
    let node: unknown
    try {
      node = get(entry)
    } catch {
      node = undefined
    }
    if (node === undefined || !isRecord(node)) continue
    const kind = node['kind']
    if (typeof kind !== 'string') {
      // 节点连种类都没有＝形状漂移：按「该轮降级」处理（归当前轮；没有当前轮就自成降级轮）。
      if (current === null) current = { key: `mirror-${sessionId}-${turns.length}`, turn: null, rows: [], degraded: true }
      current.degraded = true
      continue
    }
    if (node['visibility'] === 'hidden') continue
    const ordinal = turnOrdinalOf(node['data'], node['location'])
    // `user` 是开轮消息：带轮号时按轮号分组，无轮号时自开一轮；`steering` 是插话进当前轮的真人消息。
    const opensTurn = kind === 'user'
      && current !== null
      && current.rows.length > 0
      && (ordinal === null || current.turn === null || ordinal !== current.turn)
    if (current === null || (ordinal !== null && current.turn !== null && ordinal !== current.turn) || (ordinal !== null && current.turn === null && current.rows.length > 0) || opensTurn) {
      push()
      current = { key: `mirror-${sessionId}-${ordinal ?? turns.length}`, turn: ordinal, rows: [], degraded: false }
    }
    if (current.turn === null && ordinal !== null) current.turn = ordinal
    try {
      current.rows.push(...rowsOfNode(entry, kind, node['data']))
    } catch (cause) {
      if (!(cause instanceof MirrorDrift)) throw cause
      // 形状漂移＝该轮降级（失败半径＝那一轮），已产出的行保留给渲染层换占位。
      current.degraded = true
    }
  }
  push()
  return turns
}

function degradedTurn(sessionId: string, bookKey: string): MoyuMirrorTurn {
  return {
    key: `mirror-${sessionId}-degraded`,
    sessionId,
    bookKey,
    startedAt: 0,
    degraded: true,
    rows: [],
  }
}
