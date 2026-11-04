import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseRule } from '../../src/engine/parse.js'
import { probeJavaSurface } from '../java-surface.js'
import { messageSkeleton } from '../content-audit-classify.js'
import { BRIDGE_GAP_NAMES } from '../legado-coverage/bridge-gaps.js'
import { DEMAND_KEYS, KITCHEN_SINK, allStrings, isRecord, type RawSource } from '../legado-coverage/demand-keys.js'
import { COVERAGE } from '../legado-coverage/matrix.js'
import { must } from '../support/fixture.js'

/**
 * **解析面全库普查（`DSH_PARSE_CENSUS=1` 才跑；离线、秒级）**——「书源里写下的规则形态，本插件
 * 都能正确解析」这条目标的**进度读数口**：
 * - **面 A · 规则语法**：现库每条规则串（`raw` 的 rule 容器全集，含本仓字段映射没接的）过真实入口
 *   `parseRule`，收抛错骨架。
 * - **面 B · js 宿主调用**：静态抽 `java.<m>(` / `Packages.<a.b.C>` 调用名比对桥表。静态抽名连注释、
 *   死分支也采到，所以**读数给数量与样例、由人判**，断言只对「抽到且不在已知集合」的形态开火。
 * - **面 D · 需求读数表**：登记册那些「N 源带值」的复数入口一条命令全出，判据跟着数字印。**读数本身
 *   不判红**（分母随增删漂，钉死等于每次改库改测试；要防的是复数只能靠不入库的手写脚本）。判红三件
 *   与分母无关的事：表短了/整表全 0（空转）、矩阵行上的需求绑定落空、零读数判据在合成样品上也为 0。
 *
 * 桥面自证（名册 vs 沙箱挂载面、协议表 vs 桩）住默认门 `tests/legado-coverage/bridge-surface.test.ts`；
 * 本门只负责「问现库才算得出」那一半。
 *
 * 判断言：未知形态必须为 0——本仓拒绝过的语法、脚本调过的缺失桥方法，要么实现了，要么在在册集合里
 * 点名并写明去处，**新形态冒出来即红**。字段面的覆盖不再另设冻结分母：本门的调用读数与矩阵
 * 行就是现量；数据源缺失即红不静默 skip；取值语义等价性归
 * `DSH_CONTENT_AUDIT` 真链路，URL 与请求侧形态在覆盖矩阵 B 组在册。
 *
 * **为什么不设「扫代码注释里的现量」这道门**：那样一条子串扫描必然吃进大量假命中（UI 空态、
 * 文件大小、审计分母、正则切词），做对就得养四类豁免表——正是本仓拒绝的宽判据形状。
 * 注释里的数靠两件事管：本表那条命令（能被引用的数必须有键）+ AGENTS「引用前先重数」。
 */
const ON = process.env.DSH_PARSE_CENSUS === '1'

/** 书源的 rule 容器：本仓只映射其中一部分，这里取全集（含未映射字段） */
const RULE_CONTAINERS = ['rules', 'ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent', 'ruleExplore']

/**
 * **字段 → 实际由哪条消费者读它**。只有进规则引擎求值的字段才该过 `parseRule`，硬塞进来的都是
 * 假阳性（词表字段 `checkKeyWord` 不进 `parseRule`，否则被报成「本仓拒绝的语法」）。取值语义写在值里：
 * `rule-list`/`rule-value` 过 getElements/getString；`js` 进沙箱（面 B 管）；`regex`/`words`/`flag`
 * 各有消费者。未列出的按 `rule-value`（新字段冒出来靠普查的拒绝读数与矩阵行发现，不再设字段分母）。
 */
const FIELD_CONSUMERS: Record<string, 'rule-list' | 'rule-value' | 'js' | 'regex' | 'words' | 'flag'> = {
  bookList: 'rule-list', chapterList: 'rule-list', ruleBookList: 'rule-list', ruleChapterList: 'rule-list',
  downloadUrls: 'rule-list', relatedBooks: 'rule-list', ruleContentList: 'rule-list',
  nextContentUrl: 'rule-value', nextTocUrl: 'rule-value', ruleNextContentUrl: 'rule-value', ruleNextTocUrl: 'rule-value',
  formatJs: 'js', preUpdateJs: 'js', webJs: 'js', callBackJs: 'js', coverDecodeJs: 'js',
  ruleContentDecode: 'js', imageDecode: 'js', payAction: 'js', ruleReview: 'js',
  sourceRegex: 'regex', replaceRegex: 'regex', ruleReplaceRegex: 'regex', ruleSourceRegex: 'regex',
  checkKeyWord: 'words', ruleCheckKeyWord: 'words',
  canReName: 'flag', isVolume: 'flag', isVip: 'flag', isPay: 'flag', imageStyle: 'flag', ruleImageStyle: 'flag',
  // authorPrefix / authorPattern / ruleBookAuthor 这类是**字面量前后缀**，直接拼接，不过规则引擎
  authorPrefix: 'flag', ruleBookAuthor: 'flag', authorPattern: 'flag', bookListUrl: 'flag',
  init: 'rule-value', ruleInit: 'rule-value',
}

/** 非规则字段不计入 parseRule 分母，但要报出来：它们是「书源读得出、本仓字段都没取」的候选面 */
const isRuleField = (field: string) => {
  const kind = FIELD_CONSUMERS[field]
  return !kind || kind.startsWith('rule-')
}

interface RuleSite { src: string; where: string; rule: string; usage: 'list' | 'value' }

/** 条目 → raw 容器（`raw` 缺席时条目本身就是 raw 层，与导入前的旧库形态同口径） */
const rawOf = (entry: unknown): RawSource => {
  if (!isRecord(entry)) return {}
  return isRecord(entry.raw) ? entry.raw : entry
}

/** 报告里的源名（条目名优先，其次 raw.bookSourceName；都没有才用兜底串） */
const sourceNameOf = (entry: unknown, fallback: string): string => {
  if (!isRecord(entry)) return fallback
  if (typeof entry.name === 'string') return entry.name
  const rawName = rawOf(entry).bookSourceName
  return typeof rawName === 'string' ? rawName : fallback
}

/** 抛错骨架的两半（`parseRule` 抛的是 Error 子类；外来抛出物按有 name/message 串的对象读） */
const errNameOf = (e: unknown): string => (isRecord(e) && typeof e.name === 'string' ? e.name : 'Error')
const errMessageOf = (e: unknown): string => (isRecord(e) && typeof e.message === 'string' ? e.message : '')

/** 收集一个源里所有「会当规则求值」的字符串（数组元素逐个收，如 nextContentUrl: [..]） */
function collectRules(entry: unknown): RuleSite[] {
  const raw = rawOf(entry)
  const src = sourceNameOf(entry, '?')
  const out: RuleSite[] = []
  for (const container of RULE_CONTAINERS) {
    const box = raw[container]
    if (typeof box === 'string') {
      // 字符串化容器（本仓导入时二次 parse；容器本身也可能是 JSON 文本，两种形态都要接）
      try {
        const parsed: unknown = JSON.parse(box)
        if (isRecord(parsed)) collectBox(container, parsed, src, out)
      } catch { /* 坏 JSON 由导入面点名，不在这里重复判 */ }
      continue
    }
    if (isRecord(box)) collectBox(container, box, src, out)
  }
  return out
}

function collectBox(container: string, box: RawSource, src: string, out: RuleSite[]) {
  for (const [field, value] of Object.entries(box)) {
    if (!isRuleField(field)) continue
    const usage = FIELD_CONSUMERS[field] === 'rule-list' ? 'list' : 'value'
    // Json 数组元素在运行时是任意 JSON；逐个判形，元素不是串就不进规则面。
    const vals: unknown[] = Array.isArray(value) ? value as unknown[] : [value]
    for (const v of vals) {
      if (typeof v === 'string' && v.trim() !== '') out.push({ src, where: `${container}.${field}`, rule: v, usage })
    }
  }
}

/**
 * 在册已知形态（**按族**登记，不是按整条骨架——骨架被 messageSkeleton 归一成长度类，逐条登记会把门
 * 变成天天改的白名单）。代价如实：**同族内的新样例不报红**，所以每次跑要看「N× M源」读数变化，
 * 别只盯红/绿。
 * 表只为让**新**形态冒出来即红：加条目必须先有矩阵行 id，实现了就删条目——留着当墓碑会被误读成裁决。
 */
const KNOWN_RULE_SHAPES: Record<string, string> = {
  '无法识别的段类型（default 段白名单之外）（规则片段: "#"':
    '无 `@` 单段（`kind: "0"` 等）——取值路径 = `attr(整串)` → 也取空；矩阵 `a-bare-index-segment` 记为不适用（guard 族），非欠账',
  '一条规则混用了多个连接符（|| / && / %%）':
    '刻意分歧（解析期拒）：混用真正走得通的只剩「首个 `||` 命中即停、其后换符残片直抛」这半条路（2026-10-16 现算）——矩阵 `a-combining-mixed`',
  '无法识别的段类型（default 段白名单之外）（规则片段: "…"':
    '语法级不可解析、本仓解析期拒的段：`{baseUrl}` / `java.refreshBookUrl()` / `category_tag.*.*` 解析直抛；`href\\n书名h4` 可解析但零命中——双侧盲区非欠账；矩阵 `a-reject-double-blind`',
  '无法识别的段类型（default 段白名单之外）（规则片段: "<"':
    '`<<js>` 双尖括号笔误：同样解析期直抛——矩阵 `a-reject-double-blind`',
}

/** 本仓 `java` 挂载面：**问沙箱本体**，探针单点在 `tests/java-surface.ts`；为什么只能问沙箱本体
 * 写在那个文件头上。 */

describe.skipIf(!ON)('解析面全库普查（DSH_PARSE_CENSUS=1）', () => {
  const sj = process.env.DSH_PARSE_CENSUS_FILE
    ?? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'novel', 'sources.json')

  it('现库全部规则串过 parseRule + 全部脚本的桥调用名比对桥表', async () => {
    if (!fs.existsSync(sj)) {
      throw new Error(
        `解析面普查读不到书源库：${sj}\n` +
        '  它是在册判据，不做静默跳过——设 DSH_PARSE_CENSUS_FILE 指到 sources.json，' +
        '或导入书源后再跑。',
      )
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(sj, 'utf8'))
    const entries: unknown[] = Array.isArray(parsed)
      ? parsed as unknown[]
      : isRecord(parsed) && Array.isArray(parsed.sources) ? parsed.sources as unknown[] : []
    expect(entries.length, '普查分母为空').toBeGreaterThan(0)

    // ── 面 A：规则语法 ──────────────────────────────────────────────
    const sites = entries.flatMap(collectRules)
    const ruleRejects = new Map<string, { n: number; srcs: Set<string>; sample: string }>()
    for (const s of sites) {
      try {
        parseRule(s.rule, 'rule', s.usage)
      } catch (e) {
        const sk = `${errNameOf(e)} | ${messageSkeleton(errMessageOf(e))}`
        const hit = ruleRejects.get(sk) ?? { n: 0, srcs: new Set<string>(), sample: s.rule.slice(0, 160) }
        hit.n++; hit.srcs.add(s.src)
        if (hit.sample.startsWith('') && hit.n === 1) hit.sample = `${s.where} ← ${s.rule.slice(0, 160)}`
        ruleRejects.set(sk, hit)
      }
    }

    // ── 面 B：js 宿主调用 ───────────────────────────────────────────
    const { names: mounted } = await probeJavaSurface()
    const javaCalls = new Map<string, { n: number; srcs: Set<string> }>()
    const packages = new Map<string, { n: number; srcs: Set<string> }>()
    entries.forEach((e, i) => {
      for (const text of allStrings(rawOf(e))) {
        for (const m of text.matchAll(/\bjava\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
          // 正则唯一捕获组匹配成功时必在场；缺席即提取逻辑脱节，当场抛。
          const name = must(m[1], 'java.<方法名> 捕获组')
          const hit = javaCalls.get(name) ?? { n: 0, srcs: new Set<string>() }
          hit.n++; hit.srcs.add(sourceNameOf(e, `#${i}`)); javaCalls.set(name, hit)
        }
        for (const m of text.matchAll(/\bPackages\.((?:[A-Za-z_][A-Za-z0-9_]*\.)*(?:[A-Z][A-Za-z0-9_]*))/g)) {
          const name = must(m[1], 'Packages.<类路径> 捕获组')
          const hit = packages.get(name) ?? { n: 0, srcs: new Set<string>() }
          hit.n++; hit.srcs.add(sourceNameOf(e, `#${i}`)); packages.set(name, hit)
        }
      }
    })
    // 不再有外部方法名册：所有「脚本调了、本仓没挂」的名字都进缺口面。名字可能是源脚本写错、
    // 扩展名或真缺口——已裁决的缺席项在桥缺口名册逐条点名，新名字在下面判红。
    const bridgeGaps = [...javaCalls.entries()].filter(([n]) => !mounted.has(n))

    // ── 读数（报告，不是通过率）─────────────────────────────────────
    const fmt = (m: Map<string, { n: number; srcs: Set<string> }>) =>
      [...m.entries()].sort((a, b) => b[1].n - a[1].n)
        .map(([k, v]) => `    ${String(v.n).padStart(4)}×  ${v.srcs.size}源  ${k}`).join('\n')
    console.log(
      `\n[parse-census] 分母 ${entries.length} 源 / 规则串 ${sites.length} 条 / ` +
      `java.* 调用名 ${javaCalls.size} 种（未挂 ${bridgeGaps.length} 种）/ Packages 引用 ${packages.size} 种`,
    )
    if (ruleRejects.size) {
      console.log(`[parse-census] 本仓拒绝的规则语法形态 ${ruleRejects.size} 种：`)
      for (const [sk, v] of [...ruleRejects.entries()].sort((a, b) => b[1].n - a[1].n)) {
        console.log(`    ${String(v.n).padStart(4)}×  ${v.srcs.size}源  ${sk}\n             例: ${v.sample}`)
      }
    }
    if (bridgeGaps.length) {
      console.log(`[parse-census] 脚本调了、本仓没挂的 java.* 方法 ${bridgeGaps.length} 种：`)
      console.log(fmt(new Map(bridgeGaps)))
      // 在册那几条**只报不红**（登记过的缺席）；未在册的在下面的断言里判红。
      const rostered = bridgeGaps.filter(([n]) => BRIDGE_GAP_NAMES.has(n)).map(([n]) => n)
      const unlisted = bridgeGaps.filter(([n]) => !BRIDGE_GAP_NAMES.has(n)).map(([n]) => n)
      console.log(`    在册只报：${rostered.join(' / ') || '无'} ｜ 未在册即红：${unlisted.join(' / ') || '无'}`)
    }
    if (packages.size) {
      console.log('[parse-census] Packages 引用（按包名聚合，含本仓已挂的 org.jsoup/jsoup 元素桥）：')
      console.log(fmt(packages))
    }

    // ── 面 D：需求读数表（登记册那些「N 源带值」的复数入口）────────────
    const demand = DEMAND_KEYS.map((d) => ({ key: d.key, label: d.label, test: d.test, hits: entries.filter((e) => d.test(rawOf(e))).length }))
    // 当下数出 0 的判据，必须在反空转样品上数得出东西来——否则那个 0 分不清「没人用」与「判据坏了」。
    const silentZero = demand.filter((d) => d.hits === 0 && !d.test(KITCHEN_SINK)).map((d) => d.key)
    console.log(`[parse-census] 需求读数（分母 ${entries.length} 源；括号内是判据，不是键名——同一个键常有两种数法）：`)
    for (const d of demand) console.log(`    ${String(d.hits).padStart(4)} 源  ${d.label}`)
    // `##` 这条**故意标注分母**：本表只数「过规则引擎的字段」，矩阵 a-replace-tail-* 是「raw 全容器扫」，
    // 两边数字本就该不同——在这里另写一条更弱的判据就是给同一个量造第二份抄本。
    console.log(`    ${String(sites.filter((s) => s.rule.includes('##')).length).padStart(4)} 条  含 ## 的规则串（判据=过规则引擎的字段集，窄于矩阵行的 raw 全容器口径）`)

    // ── 面 D 对账：矩阵行上的需求读数绑到可复算的来源 ──────────────────────
    // 键取自本表 hits 与**面 B 已算好的调用名集**（`java.<名>` 走后者，不另立判据）。断言只有一条
    // 硬的：绑的键必须算得出；**数不一致只打印漂移不判红**——那是某天的现量，增删源后必然不等，
    // 判红等于把门变成天天改的白名单。
    const hitsByKey = new Map<string, number>(demand.map((d) => [d.key, d.hits]))
    const demandRows = COVERAGE.filter((row) => row.demand !== undefined)
    // `java.<名>` 一类键：先按矩阵行绑的键铺 0（没人调就是 0，正是绑定要回答的），再用面 B
    // 现读覆盖——只从 javaCalls 起步会让「零调用」的键算不出来，而零恰恰是绑定要能表达的值。
    for (const row of demandRows) {
      for (const binding of row.demand ?? []) {
        if (binding.key.startsWith('java.')) hitsByKey.set(binding.key, 0)
      }
    }
    for (const [name, v] of javaCalls) hitsByKey.set('java.' + name, v.srcs.size)
    const badBinding: string[] = []
    const drift: string[] = []
    for (const row of demandRows) {
      for (const b of row.demand ?? []) {
        const live = hitsByKey.get(b.key)
        if (live === undefined) { badBinding.push(`${row.id} 绑的键「${b.key}」面 D 与面 B 都算不出来`); continue }
        if (live !== b.n) drift.push(`${row.id} · ${b.key}：记的 ${b.n}（截至 ${b.asOf}）→ 现算 ${live}`)
      }
    }
    console.log(drift.length
      ? `[parse-census] 需求读数漂移 ${drift.length} 处（只提示，不判红）：\n  ${drift.join('\n  ')}`
      : `[parse-census] 需求读数对账：${demandRows.length} 行的读数与现算一致`)
    expect(badBinding, `读数绑定指向了不存在的东西：\n  ${badBinding.join('\n  ')}`).toEqual([])

    // ── 断言：未知形态为 0 ─────────────────────────────────────────
    // 读数不判红，判据的**形状**判红：表短了、整表全 0、或零读数判据在合成样品上也数不出。
    expect(demand.length, '需求读数表条目过少，判据在空转').toBeGreaterThan(15)
    expect(demand.some((d) => d.hits > 0), '需求读数表整表为 0：键名或判据错了').toBe(true)
    // 逐条零读数防空转：现库数出 0 的判据必须在合成样品上数出非 0——「0 需求方」那几行的裁决
    // 整条架在「0 是真 0」上，而判据接不上东西时也会报 0。
    expect(silentZero, `这些判据当下为 0、在反空转样品上也为 0（分不清「没人用」与「判据坏了」）：${silentZero.join(', ')}`).toEqual([])
    const knownFamilies = Object.keys(KNOWN_RULE_SHAPES)
    const unknownShapes = [...ruleRejects.keys()].filter(s => !knownFamilies.some(k => s.includes(k)))
    const unknownBridge = bridgeGaps.map(([n]) => n).filter((n) => !BRIDGE_GAP_NAMES.has(n))
    expect(
      { unknownShapes, unknownBridge },
      `出现未在册的新形态。\n  规则语法：${unknownShapes.join(' || ') || '无'}\n` +
      `  js 桥：${unknownBridge.join(' / ') || '无'}\n` +
      '  处理：能实现就实现并删掉在册条目；要排队就补矩阵行 + 写进 KNOWN_* 并注明去处。',
    ).toEqual({ unknownShapes: [], unknownBridge: [] })
  })
})
