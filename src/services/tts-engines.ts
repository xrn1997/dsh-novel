import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { UnsupportedRuleError } from '../engine/errors.js'
import { InvalidRequestError } from './errors.js'
import { log } from './log.js'
import { createDebouncedWriter, readJson } from './storage.js'
import type { HttpTtsEngine, SourceAuth } from './types.js'
import { TTS_ENGINE_TEXT_FIELDS, isReservedTtsEngineId, readTtsVoices } from '../shared/wire.js'
import type { TtsEngineImportReceipt, TtsEngineInput, TtsEnginePublic, TtsEngineTextField } from '../shared/wire.js'

/**
 * 朗读引擎注册表（legado HttpTTS 订阅）：`tts-engines.json` 常驻内存镜像，写盘走防抖合并
 * （与 `Shelf` / `SourceRegistry` 同一份 writer 合同）。
 * 凭据（auth）只落盘、只经 `get` 交服务内部；对外一律 `list` / `put` 的投影。
 * 落盘是内部事务——公开写动词只经私有 `edit` 排写，调用方没有「改完记得 persist」这类纪律。
 */

/** 两向可赋值 = 这两个形状是同一件事的两半。wire 不能 type-import services（layering 门），
 *  所以「公开投影 = 实体剥 auth + 一个状态位（hasAuth）」「凭据入参 = SourceAuth 的三个可录入键」
 *  这份绑定只能住这里：任一边改字段而漏改另一边，tsc 当场红。 */
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T
type _PublicIsEntityMinusAuth = Assert<
  Eq<TtsEnginePublic, Omit<HttpTtsEngine, 'auth'> & { hasAuth: boolean }>
>
type _InputAuthIsSourceAuthSlice = Assert<
  Eq<NonNullable<TtsEngineInput['auth']>, Pick<SourceAuth, 'cookies' | 'headers' | 'loginInfo'>>
>
export type { _PublicIsEntityMinusAuth, _InputAuthIsSourceAuthSlice }

/** 与静态兄弟路由段重名的 id（只在这一层有冲突）：`src/api/routes.ts` 的匹配次序是**静态优先于
 *  参数**（判据③），`POST tts/engines/import` 先于 `tts/engines/:id` 命中——id 恰为 `import` 的
 *  引擎能创建，但 `PUT` / `DELETE tts/engines/import` 永远落 405。收下它等于造一条管理面够不着
 *  （改不了、删不掉）的记录，故在导入与注册入口按保留值拒掉；id 只是前缀相同（如 `http:import`）
 *  不受影响。 */
const RESERVED_ENGINE_IDS: readonly string[] = ['import']

/** 导入回执里回显的原始条目上限：回执会随 HTTP 响应发出去，整条回显等于把 header / loginInfo
 *  里的凭据与超长 jsLib 原样抄给调用方。长度与 `tts-request.ts` 的段级定位原文同一耐心（200）。 */
const RECEIPT_RAW_LIMIT = 200

/** 回执里的「坏的是哪一条」：只投影可定位身份（index 由回执项自带，这里给 id / name），不整条
 *  回显。URL 也不收：查询串里可能带凭据；header / loginInfo / jsLib 更可能带 token。 */
function locatableRawOf(raw: unknown): string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    const kind = raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw
    return JSON.stringify({ kind })
  }
  const obj = raw as Record<string, unknown>
  const out: Record<string, string | number> = {}
  const id = obj.id
  if (typeof id === 'string') out.id = id
  else if (typeof id === 'number' && Number.isFinite(id)) out.id = id
  const name = obj.name
  if (typeof name === 'string') out.name = name
  return JSON.stringify(out).slice(0, RECEIPT_RAW_LIMIT)
}

/** 实体里由 `put` 的入参决定的可编辑字段（其余是身份 id 与注册表盖章的 lastUpdateTime）。
 *  `voices` 不进这张表：它是「缺席 = 保留」的特例（整体替换会把源声明的音色一起删掉），
 *  落位单走 `upsert`。 */
type EditableFields = Omit<TtsEngineInput, 'name' | 'url' | 'auth' | 'voices'>

/** 文本位的落位判据（**单点**：put 的编辑字段与导入条共用）：非空 string 才建键——空串按缺席
 *  （「源没这条信息」不建键），类型不符同样按缺席（不猜成空串）。 */
function textFieldOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** 可编辑字段的落位：非空才建键（判据住 `textFieldOf`）。
 *  更新时**整体替换**：本次入参缺席的可编辑键 = 从记录上删掉（否则 jsLib / header 永远删不掉）。 */
function editableFieldsOf(input: TtsEngineInput): EditableFields {
  const out: EditableFields = {}
  for (const field of TTS_ENGINE_TEXT_FIELDS) {
    const value = textFieldOf(input[field])
    if (value !== undefined) out[field] = value
  }
  return out
}

/** 导入条的可选文本字段：与 put 同一条判据（`textFieldOf`），不另写一份「非空才收」。 */
function importedTextFields(obj: Record<string, unknown>): Partial<Record<TtsEngineTextField, string>> {
  const out: Partial<Record<TtsEngineTextField, string>> = {}
  for (const key of TTS_ENGINE_TEXT_FIELDS) {
    const value = textFieldOf(obj[key])
    if (value !== undefined) out[key] = value
  }
  return out
}

/** 解析期抛错的段级定位：类型直接从 `UnsupportedRuleError` 的入参派生，不另抄一份形状。 */
type Where = ConstructorParameters<typeof UnsupportedRuleError>[1]

/** 导入条的 id：自带（legado 的数字 id 也收，转 string 保留）→ 用；缺失/空 → `http:<uuid>`。
 *  同一订阅重复导入同一个 id 因此自然按「更新」算，注册表不会长出第二条同名引擎。
 *  保留命名空间（`builtin:` / 浏览器直出 / 宿主服务）按「认不出的形状」处理：解析期抛，
 *  由 `importJson` 只剪那一条——合成面按这些身份分流，收下它们等于在源清单里造一行
 *  「此刻可用、合成必失败」的幽灵源（同名内置还会让清单长出两行）。
 *  与静态路由段重名的 id（`RESERVED_ENGINE_IDS`）同样按解析期抛处理，半径 = 该条。 */
function engineIdOf(obj: Record<string, unknown>, where: Where): string {
  const raw = obj.id
  const taken = typeof raw === 'string' ? raw.trim()
    : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : ''
  if (taken !== '' && isReservedTtsEngineId(taken)) {
    // 回执会发出去：超长的非法 id 同样按回显上限截断，不另开一条无上限的出口。
    throw new UnsupportedRuleError(
      `朗读引擎条目的 id 是保留命名空间（内置 / 浏览器直出 / 宿主服务）：${taken.slice(0, RECEIPT_RAW_LIMIT)}`, where)
  }
  if (taken !== '' && RESERVED_ENGINE_IDS.includes(taken)) {
    throw new UnsupportedRuleError(`朗读引擎条目的 id 与静态路由段重名（改 / 删路由永远到不了这条记录）：${taken}`, where)
  }
  if (taken !== '') return taken
  return `http:${randomUUID()}`
}

/** 字符串值记录（cookies / headers / loginInfo 三格的公共形状）：非对象、null、数组、值非 string
 *  都不算一份可用凭据——混进对象/数字会原样进 SourceAuth，最后被 fetch 的 WebIDL 强转成
 *  `"[object Object]"` 之类的垃圾出站头。空对象是**合法的空表**，是否算「有内容」由调用方判。 */
function stringRecordOf(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value)
  return entries.every(([, v]) => typeof v === 'string') ? Object.fromEntries(entries) : undefined
}

/** 可选凭据格：空表与缺席同义（落位不建键——`hasAuth` 与出站头都只认有内容的表）。 */
function nonEmptyRecord(value: Record<string, string> | undefined): Record<string, string> | undefined {
  return value === undefined || Object.keys(value).length === 0 ? undefined : value
}

/**
 * 凭据的可用形状判据（**单点**：写入口 `upsert` 与落盘读口 `load` 共用）：只收 SourceAuth 的
 * 三个可录入键（acquiredAt / expired 由登录面盖章，听书面没有这一档），逐格校验字符串值记录。
 * - 坏格只剪该格：cookies 坏（它必填）→ 整份 auth 不留；headers / loginInfo 坏或为空 → 少那一格；
 * - 空凭据 = 没有 auth：cookies 空表且 headers / loginInfo 也空或缺席 → undefined。
 *   投影只有 `hasAuth` 一个布尔位，留下一条空 auth 只会让它为一条没有任何凭据的记录报 true。
 */
function authOf(value: unknown): SourceAuth | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const cookies = stringRecordOf(record.cookies)
  if (cookies === undefined) return undefined
  const headers = nonEmptyRecord(stringRecordOf(record.headers))
  const loginInfo = nonEmptyRecord(stringRecordOf(record.loginInfo))
  if (Object.keys(cookies).length === 0 && headers === undefined && loginInfo === undefined) return undefined
  return {
    cookies,
    ...(headers === undefined ? {} : { headers }),
    ...(loginInfo === undefined ? {} : { loginInfo }),
  }
}

/** 对外投影：显式字段组装，**剥 auth**、只给 `hasAuth` 一个布尔位
 *  （与 `SourceRegistry.toPublic` 同口径；按需建键，不给 wire 类型补 `| undefined`）。
 *  TTS 没有登录面：凭据只在编辑表单手工录入，没有「过期」这一档，故不投 authExpired。 */
function toPublic(e: HttpTtsEngine): TtsEnginePublic {
  const out: TtsEnginePublic = {
    id: e.id,
    name: e.name,
    url: e.url,
    ...(e.voices === undefined ? {} : { voices: e.voices }),
    ...(e.lastUpdateTime === undefined ? {} : { lastUpdateTime: e.lastUpdateTime }),
    hasAuth: e.auth !== undefined,
  }
  for (const field of TTS_ENGINE_TEXT_FIELDS) {
    const value = e[field]
    if (value !== undefined) out[field] = value
  }
  return out
}

/**
 * 一条 legado HttpTTS 订阅 → 可入库形状。**认不出的形状在解析期抛**（宁炸不猜），
 * 由 `importJson` 按条剪除并记 failed；facet 取现有最贴近值 `'rule'`（engine 的 Facet 是五面
 * 词汇，没有朗读面），`segmentRaw` 只留可定位身份（`locatableRawOf`）——回执消息里能看见坏的
 * 是哪一条，又不把整条原始数据（凭据字段、超长 jsLib）抄回给调用方。
 */
function parseImported(raw: unknown, segmentIndex: number): TtsEngineInput & { id: string } {
  const where = { facet: 'rule', segmentIndex, segmentRaw: locatableRawOf(raw) } as const
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UnsupportedRuleError('朗读引擎条目必须是 JSON 对象', where)
  }
  const obj = raw as Record<string, unknown>
  const name = typeof obj.name === 'string' ? obj.name.trim() : ''
  if (name === '') throw new UnsupportedRuleError('朗读引擎条目缺 name（需为非空字符串）', where)
  const url = typeof obj.url === 'string' ? obj.url.trim() : ''
  if (url === '') throw new UnsupportedRuleError('朗读引擎条目缺 url（需为非空字符串）', where)
  const voices = readTtsVoices(obj.voices)
  return {
    id: engineIdOf(obj, where),
    name,
    url,
    ...importedTextFields(obj),
    ...(voices === undefined ? {} : { voices }),
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export class TtsEngineRegistry {
  private readonly dir: string
  private readonly engines: HttpTtsEngine[]
  /** 落盘调度只住 writer：注册表只排写（schedule）与等 flush，不另持 timer / chain */
  private readonly writer: ReturnType<typeof createDebouncedWriter>
  /** 非空 = 注册表降级（`load` 失败的落点）：值是原因。半径的判据只此一处——门面的订阅动词
   *  按它抛具名错误，读面（list/get）照常给空，源清单因此只少订阅行、不整片停摆。 */
  readonly degradedReason?: string

  private constructor(dir: string, engines: HttpTtsEngine[], degradedReason?: string) {
    this.dir = dir
    this.engines = engines
    this.writer = createDebouncedWriter()
    if (degradedReason !== undefined) this.degradedReason = degradedReason
  }

  /** dir = novel 根；`tts-engines.json` **缺失** → 空表（首启是常态）；**损坏**（JSON 语法错、
   *  顶层不是数组）→ 响亮失败（readJson 备份后抛 / 本函数点名形状，绝不折叠成空表——
   *  下一次 put 会把整文件覆盖成一条）。接住它换降级注册表是装配处（`ReadingService.create`）
   *  的裁决，半径只到订阅那一格。
   *  解析成功后逐条校验：保留命名空间的行剪除（那只可能是手改文件长出的幽灵源，put / import
   *  已在写入口守住同一条判据）；同 id 的重复行只留先出现的那一条（id 是身份，两条同 id 会让
   *  `get` / 路由改删只命中前者、后者成为永远够不着的幽灵记录）；缺 id / name / url 的行同样剪除
   *  并点名。源清单的承诺是「列出的源都在此刻可用」——带一条缺 url 的行会让合成在请求求值处炸成
   *  500，而不是一格坏、其余照常。坏行半径 = 该行，warn 点名，好行照留。 */
  static async load(dir: string): Promise<TtsEngineRegistry> {
    const parsed = await readJson<unknown>(path.join(dir, 'tts-engines.json'), [])
    if (!Array.isArray(parsed)) {
      throw new Error('tts-engines.json 顶层应为引擎订阅数组（读到的是其它 JSON 形状）')
    }
    const engines: HttpTtsEngine[] = []
    const seenIds = new Set<string>()
    for (const row of parsed as unknown[]) {
      // 行的字段不设类型信任（手改文件塞什么都不奇怪）：只做「合成链能安全消费」的最低校验，
      // 认不出的行剪除并点名；这里是落盘读口，不是第二个导入解析器。
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        log.warn('朗读引擎注册表剪掉非对象的条目')
        continue
      }
      const record = row as Record<string, unknown>
      const id = typeof record.id === 'string' ? record.id.trim() : ''
      if (id === '') {
        log.warn('朗读引擎注册表剪掉缺 id 的条目')
        continue
      }
      if (isReservedTtsEngineId(id)) {
        log.warn(`朗读引擎注册表剪掉保留命名空间的条目（保留 id 归内置 / 浏览器直出 / 宿主服务）：${id}`)
        continue
      }
      // 与静态兄弟路由段重名（`RESERVED_ENGINE_IDS`）：写入口与导入都拒它，落盘读口也必须拒——
      // 手改 / 旧文件留下这一行，它就是一条「改不了删不掉」（PUT/DELETE 撞静态路由必 405）的幽灵记录。
      if (RESERVED_ENGINE_IDS.includes(id)) {
        log.warn(`朗读引擎注册表剪掉与静态路由段重名的条目（PUT / DELETE 会命中静态路由）：${id}`)
        continue
      }
      // 重复 id：半径同保留 id 的剪除——只剪后出现的那条并点名，先出现的那条照留。
      if (seenIds.has(id)) {
        log.warn(`朗读引擎注册表剪掉重复 id 的条目（保留先出现的那一条）：${id}`)
        continue
      }
      const name = typeof record.name === 'string' ? record.name.trim() : ''
      const url = typeof record.url === 'string' ? record.url.trim() : ''
      if (name === '' || url === '') {
        log.warn(`朗读引擎注册表剪掉缺 name / url 的条目：${id}`)
        continue
      }
      // 音色表与导入同一条判据：形状不符按缺席（整键不带），不让坏表把源清单带崩。
      const voices = readTtsVoices(record.voices)
      // 文本位也走导入那条判据（只收非空 string）：手改文件把 header / contentType 塞成
      // number / object，会让合成链在 `.trim()` 处炸成未分类 500，而不是「这一格坏、其余照常」。
      // 显式重组而非原样 spread：顺带丢掉本仓不支持的 legado 字段（loginUrl / concurrentRate…），
      // 与 importJson 的落盘口径一致（「不导入、不落盘」），不让手改文件长出第二条持久化形状。
      const engine: HttpTtsEngine = {
        id, name, url,
        ...importedTextFields(record),
        // 空表与缺席同义：`wire` 的口径是「缺席 = 没有音色表，空数组 = 有这项能力但当前没有」，
        // 而本仓没有任何源能声明「有能力但零音色」；留 `[]` 会在界面渲染一行选不出东西的假控件。
        // 与 `upsert` 的「空数组 = 清掉」同口径，手改文件不许长出第二种落盘形状。
        ...(voices === undefined || voices.length === 0 ? {} : { voices }),
      }
      // 凭据与变更时刻：形状对才留（手改文件塞错类型不该让合成链或投影炸）。凭据按三格逐格
      // 校验（与写入口同一条判据 `authOf`）：坏格只剪该格，不把垃圾值带进出站头。
      const auth = authOf(record.auth)
      if (auth !== undefined) engine.auth = auth
      if (typeof record.lastUpdateTime === 'number') engine.lastUpdateTime = record.lastUpdateTime
      seenIds.add(id)
      engines.push(engine)
    }
    return new TtsEngineRegistry(dir, engines)
  }

  /** 降级注册表：`load` 失败时的落点——空表 + 原因，读面照常（不炸、不冒充有数据）。
   *  写动词不在这里设防：半径的判据只写一份，由门面的订阅动词按 `degradedReason` 抛错。 */
  static degraded(dir: string, reason: string): TtsEngineRegistry {
    return new TtsEngineRegistry(dir, [], reason)
  }

  /** 对外清单（剥凭据）。顺序 = 落盘顺序（导入 / 新增的次序） */
  list(): TtsEnginePublic[] {
    return this.engines.map(toPublic)
  }

  /** 内部全量（合成请求要用 url / header / jsLib / auth）：**不外发**，路由只准用 list。
   *  活体引用（与 SourceRegistry.get 同口径）：调用方只读。 */
  get(id: string): HttpTtsEngine | null {
    return this.engines.find((e) => e.id === id) ?? null
  }

  /** 新增 / 更新一条引擎（id 是身份，来自路由路径）：返回对外投影。
   *  `auth` 三态：缺席 = 保留盘上凭据——投影读不回来，「改个名字」不该连带抹掉登录态；
   *  非空 = 覆盖；显式空凭据（空 cookies 且 headers / loginInfo 缺席或为空）= 删掉 auth
   *  （否则 `hasAuth` 会为一条没有任何凭据的记录报 true）。判据住 `authOf`。
   *  其余可编辑字段整体替换（缺席 = 删掉那一格）。
   *  第二个特例是 `voices`：缺席 = 保留盘上（改名不抹源声明的音色），显式数组 = 整组替换，
   *  空数组 = 清掉；语义住 `TtsEngineInput` 与 `upsert`。 */
  put(id: string, input: TtsEngineInput): TtsEnginePublic {
    // 身份首尾空白归一：导入路径已 trim，写入口不归一会让 ' http:1 ' 与 'http:1' 成为两条
    // 逻辑相同、id 不同的记录（路由路径里的空白还必须百分号编码）。
    const key = id.trim()
    if (key === '') throw new InvalidRequestError('朗读引擎 id 不能为空')
    // 保留命名空间与导入同一条判据（`isReservedTtsEngineId`）：写入口收下就等于造一行
    // 「清单里可用、合成必失败」的幽灵源，而清单的承诺是「列出的源都在此刻可用」。
    if (isReservedTtsEngineId(key)) {
      throw new InvalidRequestError(`朗读引擎 id 是保留命名空间（内置 / 浏览器直出 / 宿主服务）：${id}`)
    }
    // 与静态兄弟段重名（`RESERVED_ENGINE_IDS`）：路由静态优先，这条记录的改 / 删永远到不了服务。
    if (RESERVED_ENGINE_IDS.includes(key)) {
      throw new InvalidRequestError(`朗读引擎 id 与静态路由段重名（PUT / DELETE 会命中静态路由）：${id}`)
    }
    return this.edit(() => toPublic(this.upsert(key, input).engine))
  }

  /** 删除；返回是否命中（未知 id 静默 false，不排空写） */
  remove(id: string): boolean {
    const key = id.trim()
    const i = this.engines.findIndex((e) => e.id === key)
    if (i < 0) return false
    this.edit(() => { this.engines.splice(i, 1) })
    return true
  }

  /**
   * 导入 legado HttpTTS 订阅：单对象或数组（与书源订阅同形）。
   * - 顶层既非对象也非数组 / JSON 语法错 → **整次失败**（InvalidRequestError，HTTP 面 400）；
   * - 单条认不出（非对象、缺 name / url、url 非 string）→ 解析期抛 UnsupportedRuleError，
   *   只剪那一条并记 `failed`（失败半径 = 该条），其余照进；
   * - id 已在表里 → `updated`，否则 `added`（显式 id 冲突不是失败）。
   * 导入不携带凭据（导出侧剥凭据，与公共投影同口径）：更新既有 id 时盘上凭据照旧保留。
   * 音色表随条携带（`readTtsVoices`，形状不符按缺席）：缺席同样保留盘上那份。
   */
  importJson(json: string): TtsEngineImportReceipt {
    let parsed: unknown
    try {
      parsed = JSON.parse(stripBom(json)) as unknown
    } catch (e) {
      throw new InvalidRequestError(`导入 JSON 解析失败：${e instanceof Error ? e.message : String(e)}`)
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new InvalidRequestError('导入 JSON 需为对象或数组（legado HttpTTS 订阅）')
    }
    const receipt: TtsEngineImportReceipt = { added: 0, updated: 0, failed: [] }
    for (const [index, raw] of (Array.isArray(parsed) ? parsed : [parsed]).entries()) {
      let input: TtsEngineInput & { id: string }
      try {
        input = parseImported(raw, index)
      } catch (e) {
        // 只接解析器那一种：别的异常是 bug，不许被吞成「导入了一条坏数据」
        if (!(e instanceof UnsupportedRuleError)) throw e
        receipt.failed.push({ index, message: e.message })
        continue
      }
      const { existed } = this.edit(() => this.upsert(input.id, input))
      if (existed) receipt.updated += 1
      else receipt.added += 1
    }
    return receipt
  }

  /** 等待全部待写落地（任务收尾 / 测试断言）；排到静默、失败如实抛——合同归 writer 一份 */
  async flush(): Promise<void> {
    return this.writer.flush(this.file)
  }

  /** 写配方口：recipe 改内存 → 排一次防抖写 → 返回 recipe 值（Shelf.edit 同款：
   *  同步执行是公开写动词保持同步签名的前提，排写只是 schedule，不 await 落地）。 */
  private edit<T>(recipe: () => T): T {
    const value = recipe()
    void this.writer.schedule(this.file, this.engines)
    return value
  }

  /** 新增或原位替换：id 命中 → 保位次（列表序不因更新而漂），miss → 追加。
   *  lastUpdateTime 由这里盖章（注册表是「最近变更时刻」的主人，不来自调用方）。 */
  private upsert(id: string, input: TtsEngineInput): { engine: HttpTtsEngine; existed: boolean } {
    const name = input.name.trim()
    const url = input.url.trim()
    if (name === '') throw new InvalidRequestError('朗读引擎 name 不能为空')
    if (url === '') throw new InvalidRequestError('朗读引擎 url 不能为空')
    const i = this.engines.findIndex((e) => e.id === id)
    const prev = i < 0 ? undefined : this.engines[i]
    const auth = input.auth === undefined ? prev?.auth : authOf(input.auth)
    // 音色表的落位是特例：缺席 = 保留盘上那份（改名不该抹掉源声明的音色——与 `auth` 同族），
    // 显式数组 = 整组替换、空数组 = 清掉；区别于可编辑文本位的「整体替换」（缺席 = 删掉那格）。
    // 清掉落成**删键**而不是存 `[]`：「没有音色表」的表达是缺席（界面据此不渲染音色行），
    // 存空表会渲染出一行选不出东西的假控件。
    const voices = input.voices === undefined ? prev?.voices : input.voices
    const engine: HttpTtsEngine = {
      id,
      name,
      url,
      ...editableFieldsOf(input),
      lastUpdateTime: Date.now(),
      ...(voices === undefined || voices.length === 0 ? {} : { voices }),
      ...(auth === undefined ? {} : { auth }),
    }
    if (i < 0) this.engines.push(engine)
    else this.engines[i] = engine
    return { engine, existed: i >= 0 }
  }

  private get file(): string {
    return path.join(this.dir, 'tts-engines.json')
  }
}
