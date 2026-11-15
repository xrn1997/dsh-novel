import {
  BROWSER_TTS_ENGINE_ID, CORDIS_TTS_ENGINE_ID, TTS_RESERVED_ID_PREFIX,
} from '../../shared/wire.js'
import type { HostSpeechHealth, TtsEnginePublic, TtsSourceInfo } from '../../shared/wire.js'
import type { Translate } from '../copy/index.js'

/** 合成行的 id：只用于列表键与测试锚，不落到任何写路由（那行没有编辑/删除钮）。
 *  「未安装」与「未就绪」共用这一行——两者都是「这一源此刻不能出声」，区别写在文案里。 */
export const CORDIS_UNAVAILABLE_ID = 'cordis:unavailable'

/** 列表行 = 源清单的一行 + （仅 http）注册表投影。`engine` 缺席的内置/浏览器/cordis 行不可写。
 *  `available` 是**客户端**的呈现位：清单只列此刻可用的源，所以清单行一律 true；false 的两种来路
 *  都由本文件合成（订阅行漏报、宿主服务不可用），它们不在清单里，不是清单造出的禁用态。
 *  `host` 只挂在宿主服务那一枚合成行上：缺席与未就绪是两件事（一个要装插件，一个要去配密钥），
 *  健康读数原样带过来，文案按它分叉——`reason` 是服务方的稳定原因码，原样上屏不翻译。 */
export interface EngineRow {
  id: string
  kind: TtsSourceInfo['kind']
  available: boolean
  name?: string
  engine?: TtsEnginePublic
  host?: HostSpeechHealth
}

/** 清单的**就绪读数**：最后一次读成功的源行 + 订阅投影。失败不在这里——它与这份读数分开存：
 *  刷新失败只加一条错误横幅，不清掉已经就绪的清单（「还读得出旧清单」与「此刻读不出来」是两件事）；
 *  首读就失败时没有旧读数可留，那一档由调用方单独显示错误。 */
export interface ListState {
  rows: EngineRow[]
  engines: TtsEnginePublic[]
}

/**
 * 源清单 + 订阅投影 + 宿主服务健康 → 列表行。以源清单为骨架：订阅行按 id 补到对应 http 源上；
 * 源清单漏报、但注册表确有的订阅（投影里有、源清单没有）按 http 行补在尾部——
 * 能编辑的资产不能因为清单漏报而在管理面隐身。cordis 不在清单时合成最后一行灰显，
 * 文案按健康读数分叉（未安装 / 未就绪＋原因码）。
 */
export function rowsOf(
  sources: readonly TtsSourceInfo[],
  engines: readonly TtsEnginePublic[],
  hostSpeech: HostSpeechHealth,
): EngineRow[] {
  const byId = new Map(engines.map((engine) => [engine.id, engine] as const))
  const rows = sources.map((source): EngineRow => {
    // 只有注册表（http）源吃订阅投影：内置 / 浏览器 / cordis 的身份归服务端，不挂写入口。
    const engine = source.kind === 'http' ? byId.get(source.id) : undefined
    return {
      id: source.id,
      kind: source.kind,
      available: true,
      ...(source.name === undefined ? {} : { name: source.name }),
      ...(engine === undefined ? {} : { engine }),
    }
  })
  const seen = new Set(rows.map((row) => row.id))
  for (const engine of engines) {
    if (seen.has(engine.id)) continue
    // 源清单漏报但注册表确有的订阅：按**不可用**行补在尾部。能编辑的资产不能因清单漏报而
    // 在管理面隐身；但「此刻可用」只有源清单能断言（清单只列此刻可用的源），客户端不代它作保。
    rows.push({ id: engine.id, kind: 'http', available: false, engine })
  }
  if (!rows.some((row) => row.kind === 'cordis')) {
    rows.push({ id: CORDIS_UNAVAILABLE_ID, kind: 'cordis', available: false, host: hostSpeech })
  }
  return rows
}

/** 源显示名的唯一判据：插件自有源按 kind 取词（服务端不投展示名，否则英文 locale 会露出中文），
 *  订阅源的名字是订阅数据本身。管理面行与引擎选择下拉共读这一份。 */
export function sourceLabel(t: Translate, source: { kind: TtsSourceInfo['kind']; id: string; name?: string }): string {
  switch (source.kind) {
    case 'builtin': return t('tts.engine.builtin')
    case 'browser': return t('tts.engine.browser')
    case 'cordis': return t('tts.engine.cordis')
    case 'http': return source.name ?? source.id
  }
}

/** 引擎 id 的 kind 判据：给「清单还没到 / 现值已不在清单」这一档认身份用，不依赖源清单。
 *  三支自有源的身份字面量都住 `shared/wire.ts`，客户端不抄一份（缺省引擎那一枚
 *  `TTS_DEFAULTS.engineId` 就落在内置保留前缀里）；认不出才是订阅资产，它的 id 是数据。
 *  内置按**保留前缀**判而不是按缺省 id 那一枚：缺省只是其中一条，按整枚 id 判会把别的内置源
 *  误当订阅、把它的 id 当名字上屏。 */
export function engineKindOf(id: string): TtsSourceInfo['kind'] {
  if (id.startsWith(TTS_RESERVED_ID_PREFIX)) return 'builtin'
  if (id === BROWSER_TTS_ENGINE_ID) return 'browser'
  if (id === CORDIS_TTS_ENGINE_ID) return 'cordis'
  return 'http'
}

/** 引擎显示名的唯一判据：**清单外的现值**也走这里（`engineKindOf` 认出自带源就按 kind 取词，
 *  只有订阅 id 才回落原始 id），引擎下拉与管理面行不各写一套「裸 id 上屏」。 */
export function engineLabelOf(t: Translate, id: string): string {
  return sourceLabel(t, { kind: engineKindOf(id), id })
}

/** 列表行的显示名：订阅行可能只带注册表投影（清单漏报那一支），名字从那儿补。 */
export function labelOf(t: Translate, row: EngineRow): string {
  const name = row.name ?? row.engine?.name
  return sourceLabel(t, { kind: row.kind, id: row.id, ...(name === undefined ? {} : { name }) })
}

/** 行首状态徽标的唯一判据：可用 / 未检测到 / 未就绪。「装了没配」与「没装」不折叠成同一句
 *  ——两者的修法不同，徽标是用户最先看到的那一格。 */
export function statusLabelOf(t: Translate, row: EngineRow): string {
  if (row.available) return t('tts.engines.status.available')
  if (row.host?.state === 'not-ready') return t('tts.engines.status.notReady')
  return t('tts.engines.status.unavailable')
}

/** 凭据状态位（永不读值）：无记录 / 未配置 / 已配置。TTS 没有登录面，不存在「已过期」这一档。 */
export function authLabelOf(t: Translate, engine: TtsEnginePublic | undefined): string {
  if (engine === undefined) return t('tts.engines.auth.unknown')
  if (!engine.hasAuth) return t('tts.engines.auth.none')
  return t('tts.engines.auth.configured')
}

export function descOf(t: Translate, row: EngineRow): string {
  switch (row.kind) {
    case 'builtin': return t('tts.engines.desc.builtin')
    case 'browser': return t('tts.engines.desc.browser')
    case 'cordis':
      // 三分：在场可用 / 未安装 / 装了但没配好（后者带服务方的原因码，那格数据不译）
      if (row.available) return t('tts.engines.desc.cordis')
      if (row.host?.state === 'not-ready') {
        return row.host.reason === undefined
          ? t('tts.engines.desc.cordisNotReady')
          : t('tts.engines.desc.cordisNotReadyReason', { reason: row.host.reason })
      }
      return t('tts.engines.desc.cordisAbsent')
    case 'http':
      return t('tts.engines.desc.http', { id: row.id, auth: authLabelOf(t, row.engine) })
  }
}

/** 导出剥凭据的键集：复数 `headers` 与 `auth` 是凭据；单数 `header` 是订阅的静态请求头，保留。 */
const CREDENTIAL_KEYS = new Set(['auth', 'cookies', 'headers', 'loginInfo'])

/** 递归剥凭据：投影本来就干净，这里仍自己剥一遍——导出不依赖「服务端一定记得剥」。 */
function stripCredentials(value: unknown): unknown {
  const list = Array.isArray(value) ? value : null
  if (list !== null) return list.map((item) => stripCredentials(item))
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(record)) {
    if (CREDENTIAL_KEYS.has(key)) continue
    out[key] = stripCredentials(inner)
  }
  return out
}

/** 导出 JSON：公共投影 + 剥凭据。纯函数，测试与实际导出走同一条。 */
export function exportJsonOf(engines: readonly TtsEnginePublic[]): string {
  return JSON.stringify(stripCredentials(engines), null, 2)
}

/** 粘贴 JSON 会被写成"更新"的那几条：导入按条目自带的显式 id 认身份（缺 id 的条目服务端另起
 *  一个 `http:<uuid>`，撞不上任何既有订阅），所以这里也只认显式 id——字符串 trim 或有限数
 *  转字符串，与注册表导入的 id 判据同形。
 *
 *  返回命中的既有 id（去重、按 JSON 里首次出现的次序），给导入前那条确认用：服务端 upsert 对
 *  可编辑文本位是整体替换（本次条目缺席的 `header` / `jsLib` / `contentType` = 从记录上删掉），
 *  一次粘贴就能静默清掉盘上那几格。JSON 解不开 / 不是对象或数组时返回空表：那一条的解析失败
 *  归服务端回执，不在客户端猜。 */
export function overwriteIdsOf(json: string, engines: readonly TtsEnginePublic[]): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json) as unknown
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object') return []
  const existing = new Set(engines.map((engine) => engine.id))
  const hits = new Set<string>()
  for (const raw of Array.isArray(parsed) ? parsed : [parsed]) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const id = rawIdOf(raw as Record<string, unknown>)
    if (id !== '' && existing.has(id)) hits.add(id)
  }
  return [...hits]
}

/** 导入条目的显式 id：字符串 trim / 有限数转字符串，其余按缺席。 */
function rawIdOf(raw: Record<string, unknown>): string {
  const value = raw.id
  if (typeof value === 'string') return value.trim()
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}
