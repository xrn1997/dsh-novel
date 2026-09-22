import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { NovelSource, SourceAuth, SourceContentKind, SourceStatus } from './types.js'
import type { NormalizeResult } from './normalize.js'
import { contentTypeOfRaw, rawBookMetaFields, rawHeaderRule, rawRuleDetailInit, rawRulePattern, SOURCE_KIND_LABEL, splitGroups, stripLeadingIcons } from './normalize.js'
import { readJson, writeJsonAtomic } from './storage.js'

/**
 * 书源对外视图：**绝不含 raw / rules / auth**——凭据与原文只落盘，不出现在服务层对外返回值。
 * hasHeader/hasAuth/authExpired 只给布尔状态位，UI 据此提示「已登录/已过期」。
 * 形状定义在 wire 契约（src/shared/wire.ts）；此处 re-export 保持 import 路径可用。
 * 现状真相与口径：docs/design/services.md。
 */
export type { SourcePublic } from '../shared/wire.js'
import type { SourcePublic } from '../shared/wire.js'

/** edit 的变更句柄：原注册表公开 mutator 全部迁到此（方法名与语义不变）。
 *  只在 edit 的 recipe 内可用——变更与落盘不再可分。 */
export interface SourceEdit {
  add(result: NormalizeResult): NovelSource
  replace(id: string, result: NormalizeResult): NovelSource
  remove(id: string): boolean
  removeAll(ids: string[]): number
  setStatus(id: string, status: SourceStatus, detail?: string, probedAt?: number): boolean
  setEnabled(id: string, enabled: boolean): boolean
  setAuth(id: string, auth: SourceAuth | undefined): boolean
}

/** 合并落盘阈值：累计 N 次变更强制写一次
 *  （「每 20 条 persist 一次」的既有决策——从任务运行器搬进注册表，调用方不再知道粒度存在） */
const PERSIST_EVERY = 20
/** 尾沿防抖窗口：阈值内的零散变更合并为一次写（shelf 进度同款 100ms 口径） */
const PERSIST_WINDOW_MS = 100

/**
 * 书源注册表：加载 / 变更（edit 原子入口）/ 只读投影 / 合并落盘。
 * 落盘是内部事务，不是调用方的纪律——
 * 「改完记得 persist」的顺序约束已从 interface 消灭：公开 persist 不存在，忘了落盘不可表达。
 */
export class SourceRegistry {
  private dirty = false
  private mutations = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private chain: Promise<void> = Promise.resolve()
  private readonly tx: SourceEdit

  private constructor(private readonly dir: string, private readonly sources: NovelSource[]) {
    const self = this
    this.tx = {
      add: (r) => self.add(r),
      replace: (id, r) => self.replace(id, r),
      remove: (id) => self.remove(id),
      removeAll: (ids) => self.removeAll(ids),
      setStatus: (id, s, d, p) => self.setStatus(id, s, d, p),
      setEnabled: (id, e) => self.setEnabled(id, e),
      setAuth: (id, a) => self.setAuth(id, a),
    }
  }

  /** dir = novel 根；sources.json **缺失** → 空表（首启是常态）；**损坏** → CorruptJsonError 响亮失败
   *  （绝不折叠成空表——那会让下一次 edit 覆盖整文件，642 条源静默消失，见 storage.readJson）。
   *  存量归一（改了就落盘收敛）：
   *  enabled 缺省归一为 true——早期数据无此字段，缺省即「启用」，否则搜索面 `s.enabled &&` 静默排除老源；
   *  type 缺省归一为 'text'——早期数据无此字段（当时 bookSourceType 根本没读）；
   *  groups 拆分迁移——早期只按 `\` 拆，真实导出的逗号粘连组合串（「A,B」一段）在此按
   *  splitGroups 收敛成多段（幂等：干净数据拆完原样）；
   *  name 前缀图标迁移——上游分组装饰前缀（「⚡📂xx」）按 stripLeadingIcons 剥掉（幂等）；
   *  type 按 raw.bookSourceType 重推——legado 真值 1=音频/2=图片/3=文件，旧映射读反且
   *  「非文本拒绝」口径晚于存量入库，漫画/短剧源被误标 text 混进聚合搜索与文字书架
   *  （书架诊断实证）；**认不出的编码 → 'unknown'**（2026-09 裁定：读不懂不等于文本源，退出
   *  参与集；不打 status——探针按搜索面判 verified，坏源那条道会被下一次重验洗白）。 */
  static async load(dir: string): Promise<SourceRegistry> {
    const sources = await readJson<NovelSource[]>(path.join(dir, 'sources.json'), [])
    let changed = false
    for (const s of sources) {
      if (typeof s.enabled !== 'boolean') { s.enabled = true; changed = true }
      if (!(s.type in SOURCE_KIND_LABEL)) { s.type = 'text'; changed = true }
      const derived = contentTypeOfRaw(s.raw)
      if (derived !== undefined && s.type !== derived) { s.type = derived; changed = true }
      // ⑥ ruleDetailInit 按 raw 重推（init 换根映射的存量收敛）：normalize 只在入库时映射 ruleBookInfo.init，
      // 存量 rules 是旧版派生、缺此键——缺键则详情换根静默不生效、tocUrl 模板 Miss 回退到详情页
      // 地址 → 目录 `$.rows` 空 → EmptyToc（QQ 源真机判别实证）。raw 是真相、rules 是派生；
      // 定点补这一个字段，不整链重 normalize（那可能拒绝存量源）。raw 非对象 → 不动；
      // raw 在场：键恒落成 string | null（NormalizedRules 是 required 形状）。
      const wantInit = rawRuleDetailInit(s.raw)
      if (wantInit !== undefined && s.rules.ruleDetailInit !== wantInit) {
        s.rules.ruleDetailInit = wantInit; changed = true
      } else if (s.rules.ruleDetailInit === undefined) {
        s.rules.ruleDetailInit = null; changed = true
      }
      // ⑦ headerRule 按 raw 重推（与 ⑥ 同构）：旧版 normalize 把 `@js:` header 当坏 JSON 丢弃
      // （rules.header=null、规则原文只活在 raw 里）——不重推则动态头永远不生效（顶点类源 4004）。
      // raw 非对象 → 不动；raw 在场：键恒落成 string | null。
      const wantHeaderRule = rawHeaderRule(s.raw)
      if (wantHeaderRule !== undefined && s.rules.headerRule !== wantHeaderRule) {
        s.rules.headerRule = wantHeaderRule; changed = true
      } else if (s.rules.headerRule === undefined) {
        s.rules.headerRule = null; changed = true
      }
      // ⑧ bookUrlPattern 按 raw 重推（与 ⑥⑦ 同构）：详情页嗅探字段是后来才读的，存量 rules 缺键
      // → 27/158 声明了它的源搜索时照旧只跑列表规则（对面命中即按详情页解析）。
      const wantPattern = rawRulePattern(s.raw)
      if (wantPattern !== undefined && s.rules.bookUrlPattern !== wantPattern) {
        s.rules.bookUrlPattern = wantPattern; changed = true
      } else if (s.rules.bookUrlPattern === undefined) {
        s.rules.bookUrlPattern = null; changed = true
      }
      // ⑨ kind / wordCount 按 raw 补推（与 ⑥⑦⑧ 同族的存量收敛）：这两个字段后来才接进取值链路，
      // 老数据的 rules 根本没这四个键 → 对面读得出的分类/字数对已入库的源永远是 null。
      // **与 ⑥⑦⑧ 的差别**：只补 `undefined` 的键、不覆盖已有值——新入库的源由 normalize 正确派生
      // （含字符串化容器那条路径），这里再按 raw 读一遍是第二条路，覆盖会把对的改成错的。
      const wantMeta = rawBookMetaFields(s.raw)
      if (wantMeta !== undefined) {
        for (const [k, v] of Object.entries(wantMeta)) {
          const rules = s.rules as unknown as Record<string, string | null | undefined>
          if (rules[k] === undefined) { rules[k] = v; changed = true }
        }
      }
      if (Array.isArray(s.groups)) {
        const migrated = s.groups.flatMap(splitGroups)
        if (migrated.length !== s.groups.length || migrated.some((g, i) => g !== s.groups[i])) {
          s.groups = migrated
          changed = true
        }
      }
      if (typeof s.name === 'string') {
        const cleanName = stripLeadingIcons(s.name)
        if (cleanName !== s.name) { s.name = cleanName; changed = true }
      }
    }
    const reg = new SourceRegistry(dir, sources)
    if (changed) { reg.dirty = true; await reg.flush() }   // 迁移即落盘：脏数据一次收敛，不每次重算
    return reg
  }

  // ── 变更面（唯一入口）────────────────────────────────────────────────

  /** 原子变更：recipe 同步执行（事件循环下一次 edit 内的多步变更对外不可分割），
   *  返回 recipe 的返回值；recipe 抛错 → edit reject（finally 语义：已同步发生的变更照常标脏，不静默丢）。
   *  落盘由内部合并调度——累计 ≥PERSIST_EVERY 的那次 edit 会**等写落地**（旧「每 20 条 persist」同款），
   *  否则 100ms 尾沿防抖后台合并；需要立即持久的收尾点用 flush()。 */
  async edit<T>(recipe: (tx: SourceEdit) => T): Promise<T> {
    try {
      return recipe(this.tx)
    } finally {
      await this.schedule()
    }
  }

  /** 等待全部待写落地（任务收尾 / 测试断言）；无脏零开销 */
  async flush(): Promise<void> {
    this.mutations = 0
    await this.writeNow()
  }

  /** 标脏 + 调度写：阈值到点 → 立即写并等齐（await 语义在 edit 的 finally 里）；否则尾沿防抖后台写 */
  private async schedule(): Promise<void> {
    this.dirty = true
    if (++this.mutations >= PERSIST_EVERY) { this.mutations = 0; await this.writeNow(); return }
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = undefined; void this.writeNow() }, PERSIST_WINDOW_MS)
  }

  /** 写链尾随：同文件并发写由 writeJsonAtomic 的 rename 链串行；此处只管脏标记与链序 */
  private writeNow(): Promise<void> {
    if (!this.dirty) return this.chain
    this.dirty = false
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    this.chain = this.chain
      .catch(() => undefined)                       // 排队者只关心「轮到我」，不被前一次失败带崩
      .then(() => writeJsonAtomic(path.join(this.dir, 'sources.json'), this.sources))
      .catch((e: unknown) => { console.error('[dsh-novel] sources.json 落盘失败:', e) })
    return this.chain
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
    return {
      id: s.id,
      name: s.name,
      baseUrl: s.baseUrl,
      enabled: s.enabled,
      groups: s.groups,
      type: s.type,
      status: s.status,
      statusDetail: s.statusDetail,
      importedAt: s.importedAt,
      lastProbedAt: s.lastProbedAt,
      hasHeader: s.rules.header != null || s.rules.headerRule != null,
      hasAuth: !!s.auth,
      authExpired: s.auth?.expired ?? false,
    }
  }

  // ── 实现细节（tx 句柄绑定；不对外）────────────────────────────────────

  /** 只准收 ok:true 的 normalize 产物；id=uuid，status='unverified' */
  private add(result: NormalizeResult): NovelSource {
    if (!result.ok || !result.source) throw new Error('add 只收 ok 的 normalize 产物')
    const src: NovelSource = {
      id: randomUUID(),
      status: 'unverified',
      importedAt: Date.now(),
      ...result.source,
    }
    this.sources.push(src)
    return src
  }

  /** 去重替换：原位 splice 保列表序，复用旧 id（书架/引用不断）；
   *  status 复位 unverified（新规则需重验），importedAt 更新为现在。只准收 ok 的 normalize 产物（与 add 同口径） */
  private replace(id: string, result: NormalizeResult): NovelSource {
    if (!result.ok || !result.source) throw new Error('replace 只收 ok 的 normalize 产物')
    const i = this.sources.findIndex((s) => s.id === id)
    if (i < 0) throw new Error(`replace: 源不存在 ${id}`)
    const src: NovelSource = { id, status: 'unverified', importedAt: Date.now(), ...result.source }
    this.sources[i] = src
    return src
  }

  private remove(id: string): boolean {
    const i = this.sources.findIndex((s) => s.id === id)
    if (i < 0) return false
    this.sources.splice(i, 1)
    return true
  }

  /** 批量删除：返回实删数；未知 id 静默跳过、重复 id 幂等。
   *  一次 removeAll + 一次合并落盘，替代逐删逐写的 N 次全量重写 sources.json */
  private removeAll(ids: string[]): number {
    const doomed = new Set(ids)
    const before = this.sources.length
    for (let i = this.sources.length - 1; i >= 0; i--) {   // 倒序 splice：就地删，保持 readonly 引用
      if (doomed.has(this.sources[i].id)) this.sources.splice(i, 1)
    }
    return before - this.sources.length
  }

  /** 更新探针状态；probedAt 缺省取当前时间。返回是否找到并更新。
   * detail 缺省时清空旧 statusDetail——verified 不许残留上次 broken 的原因。 */
  private setStatus(id: string, status: SourceStatus, detail?: string, probedAt?: number): boolean {
    const s = this.get(id)
    if (!s) return false
    s.status = status
    if (detail !== undefined) s.statusDetail = detail
    else delete s.statusDetail
    s.lastProbedAt = probedAt ?? Date.now()
    return true
  }

  /** 启用/停用：停用 = 不参与聚合搜索（reading.search 面已过滤）；
   *  试跑/验证不受影响。返回是否找到 */
  private setEnabled(id: string, enabled: boolean): boolean {
    const s = this.get(id)
    if (!s) return false
    s.enabled = enabled
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
