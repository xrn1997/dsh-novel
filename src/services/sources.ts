import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { NovelSource, SourceAuth, SourceStatus } from './types.js'
import type { NormalizeResult } from './normalize.js'
import { rehydrateStoredSource } from './normalize.js'
import { createDebouncedWriter, PERSIST_WINDOW_MS, readJson } from './storage.js'
import { log } from './log.js'

/**
 * 书源对外视图：**绝不含 raw / rules / auth**——凭据与原文只落盘，不出现在服务层对外返回值。hasHeader/hasAuth/authExpired 只给
 * 布尔状态位；形状定义在 wire 契约，此处 re-export 保持 import 路径可用。
 */
export type { SourcePublic } from '../shared/wire.js'
import type { LoginUiField, LoginUiText, SourcePublic } from '../shared/wire.js'

/** edit 的变更句柄：注册表的 mutator 只有这一套；它们只在 edit 的 recipe 内可用——变更与落盘不可分。 */
export interface SourceEdit {
  add(result: NormalizeResult): NovelSource
  replace(id: string, result: NormalizeResult): NovelSource
  remove(id: string): boolean
  removeAll(ids: string[]): number
  setStatus(id: string, status: SourceStatus, detail?: string, probedAt?: number): boolean
  setEnabled(id: string, enabled: boolean): boolean
  setAiSearch(id: string, aiSearch: boolean): boolean
  setAuth(id: string, auth: SourceAuth | undefined): boolean
}

/** 合并落盘阈值：累计 N 次变更强制写一次（计数跨定时器/flush 写累计，阈值触发才复位）。export 只为测试按它对齐第 N 次变更。 */
export const PERSIST_EVERY = 20

/**
 * 书源注册表：加载 / 变更（edit 原子入口）/ 只读投影 / 合并落盘。落盘是内部事务，不是调用方的纪律——interface 上没有 persist。
 */
/** loginUi 的可渲染子集：JSON 数组里的 text/password/button 行；`@js:` 生成形态与字面 `webView` 行不投影，UI 回退 cookie 录入。
 *  button 只收有非空 action 的行。**内部行带 action**：服务端按同名行查脚本；`toPublic` 只投影 name/type。`name` 同时是 loginInfo 的键与标签。 */
export interface LoginUiActionRow {
  name: string
  type: 'button'
  action: string
}

export type LoginUiRow = LoginUiText | LoginUiActionRow

export function loginUiOf(raw: unknown): LoginUiRow[] | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const v = (raw as Record<string, unknown>).loginUi
  if (typeof v !== 'string' || v.trim() === '') return undefined
  let parsed: unknown
  try { parsed = JSON.parse(v) } catch { return undefined }
  if (!Array.isArray(parsed)) return undefined
  const out: LoginUiRow[] = []
  for (const row of parsed) {
    if (row === null || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const type = typeof r.type === 'string' ? r.type : 'text'
    const name = typeof r.name === 'string' ? r.name.trim() : ''
    if (name === '') continue
    if (type === 'text' || type === 'password') {
      out.push({ name, type, ...(typeof r.default === 'string' ? { default: r.default } : {}) })
      continue
    }
    if (type === 'button') {
      const action = typeof r.action === 'string' ? r.action.trim() : ''
      if (action === '') continue
      out.push({ name, type: 'button', action })
    }
  }
  return out.length === 0 ? undefined : out
}

export class SourceRegistry {
  /** 落盘调度只住 writer：注册表只排写（调用 schedule）与等 flush，不另持 timer/chain。 */
  private readonly writer: ReturnType<typeof createDebouncedWriter>
  private readonly tx: SourceEdit
  private readonly dir: string
  private readonly sources: NovelSource[]

  private constructor(dir: string, sources: NovelSource[]) {
    this.dir = dir
    this.sources = sources
    this.writer = createDebouncedWriter(PERSIST_WINDOW_MS, { threshold: PERSIST_EVERY })
    // 箭头函数天然捕获本实例的 this：不需要（也不该）先把它别名为一个局部变量
    this.tx = {
      add: (r) => this.add(r),
      replace: (id, r) => this.replace(id, r),
      remove: (id) => this.remove(id),
      removeAll: (ids) => this.removeAll(ids),
      setStatus: (id, s, d, p) => this.setStatus(id, s, d, p),
      setEnabled: (id, e) => this.setEnabled(id, e),
      setAiSearch: (id, e) => this.setAiSearch(id, e),
      setAuth: (id, a) => this.setAuth(id, a),
    }
  }

/** dir = novel 根；sources.json **缺失** → 空表（首启常态）；**损坏** → CorruptJsonError 响亮失败（绝不折叠成空表——下一次 edit 会覆盖整文件）。
 * 存量收敛的逐字段机械住 `normalize.rehydrateStoredSource`；这里只触发一次并落盘。 */
  static async load(dir: string): Promise<SourceRegistry> {
    const sources = await readJson<NovelSource[]>(path.join(dir, 'sources.json'), [])
    let changed = false
    for (const s of sources) if (rehydrateStoredSource(s)) changed = true
    const reg = new SourceRegistry(dir, sources)
    if (changed) {
      await reg.scheduleWrite()   // flush 只处理挂起写；迁移后的内存必须先 schedule 成待写
      await reg.flush()       // 迁移即落盘：脏数据一次收敛，不每次重算
    }
    return reg
  }

  // ── 变更面（唯一入口）────────────────────────────────────────────────

  /** 原子变更：recipe 同步执行（事件循环下一次 edit 内的多步变更对外不可分割），返回 recipe 的值；recipe 抛错 → edit reject。落盘由内部
   *  合并调度——累计 ≥PERSIST_EVERY 的那次 edit 会**等写落地**，否则 100ms 尾沿防抖；需要立即持久用 flush()。 */
  async edit<T>(recipe: (tx: SourceEdit) => T): Promise<T> {
    // recipe 的结果先收在手里再落盘：写盘失败要看它是否已成立，但**不在 finally 里抛**（会盖掉 recipe 错误）。
    let result: { ok: true; value: T } | { ok: false; error: unknown }
    try {
      result = { ok: true, value: recipe(this.tx) }
    } catch (e) {
      result = { ok: false, error: e }
    }
    try {
      // 阈值到点的那次返回写 promise（失败如实抛）；其余交给 writer 的尾沿防抖。
      await this.scheduleWrite()
    } catch (e) {
      // recipe 已在抛错时，写失败没有交付路径：记进 writer 的失败账，收尾 flush 可见；recipe 的错误优先。recipe 成功时写失败直接抛。
      if (result.ok) throw e
      this.writer.retainFailure(this.file, e)
      log.error('recipe 抛错期间的落盘失败（保留 recipe 错误）:', e)
    }
    if (!result.ok) throw result.error
    return result.value
  }

  /** 排一次写：writer 的 schedule 是唯一写调度入口；阈值返回写 promise，其余返回 undefined。 */
  private scheduleWrite(): Promise<void> | undefined {
    return this.writer.schedule(this.file, this.sources)
  }

  /** 等待全部待写落地（任务收尾 / 测试断言）；排到静默、失败如实抛——合同归 writer 一份。 */
  async flush(): Promise<void> {
    return this.writer.flush(this.file)
  }

  /** 调用方接住了 `edit` 的落盘失败、但仍要让收尾 `flush` 看见时，把失败移交 writer 的失败账；同一文件下一次写成功即清账（批量探针用）。 */
  retainWriteFailure(error: unknown): void {
    this.writer.retainFailure(this.file, error)
  }

  private get file(): string {
    return path.join(this.dir, 'sources.json')
  }

  // ── 只读面 ───────────────────────────────────────────────────────────

  /** 内部全量（service 内部用；对外走 toPublic）。活体引用：import-job 的地址索引依赖其做状态判定 */
  list(): NovelSource[] {
    return this.sources
  }

  get(id: string): NovelSource | undefined {
    return this.sources.find((s) => s.id === id)
  }

  /** 对外视图：显式字段组装，剥离 raw/rules/auth */
  toPublic(s: NovelSource): SourcePublic {
    const rows = loginUiOf(s.raw)
    // button 的 action 是源脚本，只服务端用；对外视图只留标签与类型
    const loginUi = rows?.map((r): LoginUiField => r.type === 'button' ? { name: r.name, type: 'button' } : r)
    return {
      id: s.id,
      name: s.name,
      baseUrl: s.baseUrl,
      enabled: s.enabled,
      groups: s.groups,
      aiSearch: s.aiSearch === true,
      type: s.type,
      status: s.status,
      // 对外投影是会过 JSON 的载荷：这两格按需建键，不给 wire 类型补 `| undefined`（口径见 wire.ts 头注与 `ADR-0053`）。
      ...(s.statusDetail === undefined ? {} : { statusDetail: s.statusDetail }),
      importedAt: s.importedAt,
      ...(s.lastProbedAt === undefined ? {} : { lastProbedAt: s.lastProbedAt }),
      hasHeader: s.rules.header != null || s.rules.headerRule != null,
      hasAuth: !!s.auth,
      authExpired: s.auth?.expired ?? false,
      hasLoginUrl: s.rules.loginUrl !== null,
      ...(loginUi === undefined ? {} : { loginUi }),
    }
  }

  // ── 实现细节（tx 句柄绑定；不对外）────────────────────────────────────

  /** 只准收 ok:true 的 normalize 产物；id=uuid，status='unverified'。`aiSearch` 是用户偏好，新入库缺省关闭——不从 normalize 产物取。 */
  private add(result: NormalizeResult): NovelSource {
    if (!result.ok || !result.source) throw new Error('add 只收 ok 的 normalize 产物')
    const src: NovelSource = {
      id: randomUUID(),
      status: 'unverified',
      importedAt: Date.now(),
      aiSearch: false,
      ...result.source,
    }
    this.sources.push(src)
    return src
  }

  /** 去重替换：原位 splice 保列表序，复用旧 id（书架/引用不断）；status 复位 unverified、importedAt 更新。`aiSearch` 跨重导入保留旧值——
   *  替换规则不等于撤销用户对 AI 搜索的选择。 */
  private replace(id: string, result: NormalizeResult): NovelSource {
    if (!result.ok || !result.source) throw new Error('replace 只收 ok 的 normalize 产物')
    const i = this.sources.findIndex((s) => s.id === id)
    if (i < 0) throw new Error(`replace: 源不存在 ${id}`)
    const prev = this.sources[i]
    const src: NovelSource = {
      id, status: 'unverified', importedAt: Date.now(), aiSearch: prev?.aiSearch ?? false, ...result.source,
    }
    this.sources[i] = src
    return src
  }

  private remove(id: string): boolean {
    const i = this.sources.findIndex((s) => s.id === id)
    if (i < 0) return false
    this.sources.splice(i, 1)
    return true
  }

  /** 批量删除：返回实删数；未知 id 静默跳过、重复 id 幂等。一次 removeAll + 一次合并落盘，替代逐删逐写的 N 次全量重写。 */
  private removeAll(ids: string[]): number {
    const doomed = new Set(ids)
    const before = this.sources.length
    for (let i = this.sources.length - 1; i >= 0; i--) {   // 倒序 splice：就地删，保持 readonly 引用
      const victim = this.sources[i]
      if (victim !== undefined && doomed.has(victim.id)) this.sources.splice(i, 1)
    }
    return before - this.sources.length
  }

  /** 更新探针状态；probedAt 缺省取当前时间。返回是否找到。detail 缺省时清空旧 statusDetail——verified 不许残留上次 broken 的原因。 */
  private setStatus(id: string, status: SourceStatus, detail?: string, probedAt?: number): boolean {
    const s = this.get(id)
    if (!s) return false
    s.status = status
    if (detail !== undefined) s.statusDetail = detail
    else delete s.statusDetail
    s.lastProbedAt = probedAt ?? Date.now()
    return true
  }

  /** 启用/停用：停用 = 不参与聚合搜索（试跑/验证不受影响）。返回是否找到。 */
  private setEnabled(id: string, enabled: boolean): boolean {
    const s = this.get(id)
    if (!s) return false
    s.enabled = enabled
    return true
  }

  /** AI 搜索标记：与启停正交，只收窄 AI 工具面的参与集。返回是否找到 */
  private setAiSearch(id: string, aiSearch: boolean): boolean {
    const s = this.get(id)
    if (!s) return false
    s.aiSearch = aiSearch
    return true
  }

  /** 录入/更新登录态（auth 路由用）；auth=undefined 即清除。返回是否找到 */
  private setAuth(id: string, auth: SourceAuth | undefined): boolean {
    const s = this.get(id)
    if (!s) return false
    if (auth === undefined) delete s.auth
    else s.auth = auth
    return true
  }
}
