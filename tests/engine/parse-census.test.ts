import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseRule } from '../../src/engine/parse.js'
import { evalJs } from '../../src/engine/js-sandbox.js'
import { JAVA_PROTOCOL } from '../../src/engine/js-protocol.js'
import { messageSkeleton } from '../content-audit-classify.js'
import { readSnapshot } from '../legado-coverage/upstream-facts.js'

/**
 * **解析面全库普查（`DSH_PARSE_CENSUS=1` 才跑；离线、不联网，秒级）**——「彻底适配 legado 书源规则」
 * 这条目标的**进度读数口**。
 *
 * 目标口径不是「矩阵行都标了 implemented」，而是：**凡书源里写下的规则形态，本插件都能正确解析**。
 * 要按这个口径推进，必须先有一个不靠人想、不靠站点今天是否活着的清单：现库里到底有哪些规则
 * 是本仓**当场拒绝**的。此前这件事靠一份一次性脚本（写在不入库目录里，已经消失过一次），
 * 且只跑了 `parseRule` 一面。本文件把它做成在册的门，并补齐第二面：
 *
 * **面 A · 规则语法**：把现库每一条规则串（从 `raw` 的 rule 容器取，含本仓字段映射**没接**的那些——
 *  那正是「书源写得出、本仓连字段都没映射」的一批）过本仓真实入口 `parseRule`，收集抛错骨架。
 * **面 B · js 宿主调用**：静态抽出全库脚本里的 `java.<m>(` 与 `Packages.<a.b.C>` 调用名，
 *  比对桥表（`SANDBOX_MOUNTS.javaSync`）。脚本约定该有的方法我们没挂 → 脚本跑到那句就抛错。
 *  这是静态抽名：注释与死分支里的调用也会被采到，所以**读数按名字给数量与样例、由人判**，
 *  断言只对「抽到且不在已知集合」的形态开火。
 * **面 C · 桥可达性**：协议表里已登记实现的名字，绝不允许在沙箱里仍被「需要安卓宿主环境」桩覆盖。
 *  面 B 只问"挂没挂"，问不出"挂的是实现还是桩"——`digestHex` 一族正是这样实现了却够不着
 *  （协议表测试全绿、脚本一调就抛），所以这一面单独对账。
 *
 * **两面的断言同一条**：未知形态必须为 0。也就是说——本仓拒绝过的语法 / 脚本调过的缺失桥方法，
 * 要么已被实现，要么在下面的在册集合里被点名并写明为什么排在那儿；**新形态冒出来即红**，
 * 不靠任何人记得去查。这与 `tests/legado-coverage/upstream-fields.test.ts`（字段面有主吗）互补：
 * 那道门管「字段有没有归属」，本门管「规则串与脚本调用真能不能跑」。
 *
 * 数据源缺失即红（不静默 skip）：判据的分母架在会消失的文件上等于没有判据
 * （见 AGENTS.md「引用活性」与 docs/design/legado-compat.md 判据①一节）。
 *
 * 覆盖面如实声明：本门只判**离线可判**的两面。取值语义是否等价（同一条规则两边取出的值一样吗）
 * 仍归 `DSH_CONTENT_AUDIT` 真链路审计；URL 构造与请求侧形态（`<a,b,c>`、`@result`、`retry`）
 * 在覆盖矩阵 B 组在册。
 */
const ON = process.env.DSH_PARSE_CENSUS === '1'

/** 书源的 rule 容器：本仓只映射其中一部分，这里取全集（含未映射字段） */
const RULE_CONTAINERS = ['rules', 'ruleSearch', 'ruleBookInfo', 'ruleToc', 'ruleContent', 'ruleExplore']

/**
 * **字段 → 实际由哪条消费者读它**。只有进规则引擎求值的字段
 * 才是「规则串」，才该过 `parseRule`；其余各有消费者，硬塞进规则引擎只会造假阳性
 * （普查第一版就因此把 `checkKeyWord ← 我的` 这类词表报成了「本仓拒绝的语法」）。
 *
 * 每条都按取值语义归过类，锚点写在值里：
 * - `rule-list` / `rule-value`：过 `getElements` / `getString`，差别是取值用途。
 * - `js`：脚本，进沙箱（本仓用 `node:vm`）——由本普查的**面 B** 管。
 * - `regex`：Java 正则，不进规则引擎。
 * - `words`：逗号分隔词表。
 * - `flag`：布尔 / 排版字符串。
 * 未列出的字段按 `rule-value` 处理（新字段冒出来会被上游字段门 `upstream-fields.test.ts` 拦住）。
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

/** 收集一个源里所有「会当规则求值」的字符串（数组元素逐个收，如 nextContentUrl: [..]） */
function collectRules(entry: any): RuleSite[] {
  const raw = entry?.raw ?? entry ?? {}
  const src = String(entry?.name ?? raw.bookSourceName ?? '?')
  const out: RuleSite[] = []
  for (const container of RULE_CONTAINERS) {
    const box = raw[container]
    if (typeof box === 'string') {
      // 字符串化容器（本仓导入时二次 parse；容器本身也可能是 JSON 文本，两种形态都要接）
      try { collectBox(container, JSON.parse(box), src, out) } catch { /* 坏 JSON 由导入面点名，不在这里重复判 */ }
      continue
    }
    if (box && typeof box === 'object') collectBox(container, box, src, out)
  }
  return out
}

function collectBox(container: string, box: Record<string, unknown>, src: string, out: RuleSite[]) {
  for (const [field, value] of Object.entries(box)) {
    if (!isRuleField(field)) continue
    const usage = FIELD_CONSUMERS[field] === 'rule-list' ? 'list' : 'value'
    const vals = Array.isArray(value) ? value : [value]
    for (const v of vals) {
      if (typeof v === 'string' && v.trim() !== '') out.push({ src, where: `${container}.${field}`, rule: v, usage })
    }
  }
}

/** 递归抽出任意 JSON 里的字符串（脚本面用：jsLib 与各 @js: 段都在其中） */
function allStrings(node: unknown, acc: string[] = []): string[] {
  if (typeof node === 'string') acc.push(node)
  else if (Array.isArray(node)) for (const v of node) allStrings(v, acc)
  else if (node && typeof node === 'object') for (const v of Object.values(node)) allStrings(v, acc)
  return acc
}

/**
 * 在册已知形态（**按族**登记，不是按整条骨架）：本仓当前会拒绝、且已在覆盖矩阵 / 设计文档排队或
 * 被裁决的规则语法骨架。按族是因为骨架里的规则片段被 messageSkeleton 归一成长度类
 * （`"#"` 数字、`"…"` 长串），逐条精确登记会把门变成天天要改的白名单。代价如实写明：
 * **同族内的新样例不会报红**，所以每次跑普查要看「N× M源」读数变化，别只盯红/绿。
 *
 * 在册的是**仍在被拒的族**：普查头一跑（2026-09-22）在这里登记过 4 族，其余 3 族逐一收口——
 * 空白分支按吞分支（`a-blank-branch-dropped`）、纯数字段是 children 索引
 * （`a-bare-index-segment`）、`clasd.T-R-T-B2-Box1` 与 `text下一页` 本就不是"认不出"而是 CSS
 * 选择器——白名单外的段本就该交 CSS（`select(beforeRule)`，边界订正见
 * `a-unknown-segment-throws`）。留下的这一族每次跑都要看「N× M源」读数变化，别只盯红/绿。
 * 这张表留着只为让**新**形态冒出来即红：加条目必须先有矩阵行 id，实现了就删条目——
 * 留着当墓碑会被下一轮误读成「这是裁决」。
 */
const KNOWN_RULE_SHAPES: Record<string, string> = {
  '无法识别的段类型（default 段白名单之外）（规则片段: "#"':
    '无 `@` 单段（`kind: "0"` 等）——取值路径 = `attr(整串)` → 也取空；矩阵 `a-bare-index-segment` 记为不适用（guard 族），非欠账',
}

/**
 * 在册已知桥缺口：书源脚本用得到、本仓没挂、且已在矩阵行排队的 `java.*` 方法名。
 * 普查头两批抓出的 connect / getWebViewUA / androidId 各自有了去处（前两个实现，
 * `androidId` 走宿主桩点名抛错）。这张表留着是为了让**新**缺口冒出来即红，不是给存量挡红：
 * 往里加条目必须先有矩阵行 id。
 *
 * 下面三条全部来自**换分母**那一次（2026-09-22 第 23 批：本库 214 源之外另取两份独立公开合集
 * 共 67 源跑同一条普查，`DSH_PARSE_CENSUS_FILE` 指过去即可复现）——本库从未用过它们，
 * 所以「当前为空」那句话只对旧分母成立。`java.post` 也在同一次被发现（9 源在用），
 * 它不登记在这里：已经实现了（矩阵 `h-java-post`）。
 */
const KNOWN_BRIDGE_GAPS: Record<string, string> = {
  t2s: '繁简词典不在本仓，且对面在转换前还会跑自家补丁词典——换轮子（opencc 一类）得到的文本与对面不逐字相等，要拍板：矩阵 h-java-t2s',
  cacheFile: '裁决已有（真实文件 API = 数据外泄面），这一条的作用是确认该裁决真有需求方：矩阵 h-java-cache-file',
  toURL: '返回的是 JVM URL 对象；先看清那 1 源真调了哪些成员再造壳：矩阵 h-java-tourl',
}

/**
 * 本仓 `java` 挂载面：**在沙箱里跑一句探针，让真对象自己报**，并顺带标出哪些是「需要安卓宿主」桩。
 * 不抄协议表、也不正则抠 BOOTSTRAP 源码——两者都是第二份抄本，必漂：
 * 普查第一版拿 `SANDBOX_MOUNTS.javaSync` 当分母，把 async 行（`ajax`）与 BOOTSTRAP 手工挂载的
 * no-op 族（`toast`/`log`/`startBrowser`…）全误报成缺口；改成正则抠源码后又漏了「一行挂两个键」
 * 的 `longToast`。真挂载面只住在沙箱对象里。
 *
 * 顺带产出的**桩名单**用于面 C：2026-09-22 实证 `digestHex`/`digestBase64Str`/`HMacHex`/`HMacBase64`
 * 同时在协议表（真实现）与 BOOTSTRAP 桩名单里，而后挂的桩覆盖了真实现——协议表测试全绿，脚本一调
 * 就抛「需要安卓宿主环境」。这类"实现了但够不着"的缺陷，只有问沙箱本体才查得出来。
 */
async function probeJavaSurface(): Promise<{ names: Set<string>; stubs: Set<string> }> {
  const url = 'https://census.example.com/read/1'
  const out = await evalJs(
    'var o = []; for (var n in java) { var f = java[n]; o.push(n + (typeof f === "function" ' +
    '&& String(f).indexOf("\u9700\u8981\u5b89\u5353\u5bbf\u4e3b\u73af\u5883") >= 0 ? "\\tSTUB" : "")); } return o.join("\\n")',
    { result: '', baseUrl: url, source: 'https://census.example.com' },
    { baseUrl: url, source: 'https://census.example.com', vars: {} },
    { segmentIndex: 0, segmentRaw: '@js:parse-census' },
    'content',
  )
  const text = out.value.kind === 'value' ? out.value.text : ''
  const names = new Set<string>()
  const stubs = new Set<string>()
  for (const line of text.split('\n').filter(Boolean)) {
    const [n, tag] = line.split('\t')
    names.add(n)
    if (tag === 'STUB') stubs.add(n)
  }
  expect(names.size, `沙箱报出的 java 方法名只有 ${names.size} 个，探针或挂载面出了问题`).toBeGreaterThan(20)
  return { names, stubs }
}

/** 脚本侧 `java` 对象的权威定义：从**仓内快照**读公开 fun 名（含重载去重）。
 *  快照由 `tests/legado-coverage/capture-upstream-snapshot.test.ts` 在开发阶段生成——
 *  本普查（连同其他两条判据）运行时不依赖任何外部 checkout。 */
function upstreamJavaNames(): Set<string> {
  const out = new Set(readSnapshot().javaMethods)
  expect(out.size, `快照里的 java 方法名过少（${out.size}），判据已失效——刷新快照`).toBeGreaterThan(50)
  return out
}

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
    const parsed = JSON.parse(fs.readFileSync(sj, 'utf8'))
    const entries: any[] = Array.isArray(parsed) ? parsed : (parsed.sources ?? [])
    expect(entries.length, '普查分母为空').toBeGreaterThan(0)

    // ── 面 A：规则语法 ──────────────────────────────────────────────
    const sites = entries.flatMap(collectRules)
    const ruleRejects = new Map<string, { n: number; srcs: Set<string>; sample: string }>()
    for (const s of sites) {
      try {
        parseRule(s.rule, 'rule', s.usage)
      } catch (e: any) {
        const sk = `${e?.name ?? 'Error'} | ${messageSkeleton(String(e?.message ?? ''))}`
        const hit = ruleRejects.get(sk) ?? { n: 0, srcs: new Set<string>(), sample: s.rule.slice(0, 160) }
        hit.n++; hit.srcs.add(s.src)
        if (hit.sample.startsWith('') && hit.n === 1) hit.sample = `${s.where} ← ${s.rule.slice(0, 160)}`
        ruleRejects.set(sk, hit)
      }
    }

    // ── 面 B：js 宿主调用 ───────────────────────────────────────────
    const { names: mounted, stubs } = await probeJavaSurface()
    const upstream = upstreamJavaNames()
    const javaCalls = new Map<string, { n: number; srcs: Set<string> }>()
    const packages = new Map<string, { n: number; srcs: Set<string> }>()
    entries.forEach((e, i) => {
      for (const text of allStrings(e?.raw ?? e)) {
        for (const m of text.matchAll(/\bjava\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
          const hit = javaCalls.get(m[1]) ?? { n: 0, srcs: new Set<string>() }
          hit.n++; hit.srcs.add(String(e?.name ?? `#${i}`)); javaCalls.set(m[1], hit)
        }
        for (const m of text.matchAll(/\bPackages\.((?:[A-Za-z_][A-Za-z0-9_]*\.)*(?:[A-Z][A-Za-z0-9_]*))/g)) {
          const hit = packages.get(m[1]) ?? { n: 0, srcs: new Set<string>() }
          hit.n++; hit.srcs.add(String(e?.name ?? `#${i}`)); packages.set(m[1], hit)
        }
      }
    })
    // 缺口只在「这个公开方法确实在脚本面上」时才成立；本来就没有的名字（脚本写错、别的 fork、
    // 私有扩展）只报读数，不判红——否则把源脚本的坏冒成我们的欠。
    const notMounted = [...javaCalls.entries()].filter(([n]) => !mounted.has(n))
    const bridgeGaps = notMounted.filter(([n]) => upstream.has(n))
    const notUpstream = notMounted.filter(([n]) => !upstream.has(n))

    // ── 读数（报告，不是通过率）─────────────────────────────────────
    const fmt = (m: Map<string, { n: number; srcs: Set<string> }>, key: string) =>
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
      console.log(`[parse-census] 脚本调了、快照里有、本仓没挂的 java.* 方法 ${bridgeGaps.length} 种：`)
      console.log(fmt(new Map(bridgeGaps), 'name'))
    }
    if (notUpstream.length) {
      console.log(`[parse-census] 快照的 java 方法集里也没有的调用名 ${notUpstream.length} 种（不判红，只报）：`)
      console.log(fmt(new Map(notUpstream), 'name'))
    }
    if (packages.size) {
      console.log('[parse-census] Packages 引用（按包名聚合，含本仓已挂的 org.jsoup/jsoup 元素桥）：')
      console.log(fmt(packages, 'pkg'))
    }

    // ── 面 C：桥可达性对账（协议表有真实现的名字，不许在沙箱里仍是抛错桩）──────────
    // 病史：digestHex/HMacHex 一族同时存在于协议表与 BOOTSTRAP 桩名单，桩后挂覆盖真实现——
    // 协议表测试全绿，脚本一调就抛。见 probeJavaSurface 的注释。
    const clobbered = JAVA_PROTOCOL.map(r => r.name).filter(n => stubs.has(n))

    // ── 断言：未知形态为 0 ─────────────────────────────────────────
    const knownFamilies = Object.keys(KNOWN_RULE_SHAPES)
    const unknownShapes = [...ruleRejects.keys()].filter(s => !knownFamilies.some(k => s.includes(k)))
    const unknownBridge = bridgeGaps.map(([n]) => n).filter(n => !KNOWN_BRIDGE_GAPS[n])
    expect(
      { unknownShapes, unknownBridge, clobbered },
      `出现未在册的新形态。\n  规则语法：${unknownShapes.join(' || ') || '无'}\n` +
      `  js 桥：${unknownBridge.join(' / ') || '无'}\n` +
      `  桩吃掉真实现：${clobbered.join(' / ') || '无'}\n` +
      '  处理：能实现就实现并删掉在册条目；要排队就补矩阵行 + 写进 KNOWN_* 并注明去处。',
    ).toEqual({ unknownShapes: [], unknownBridge: [], clobbered: [] })
  })
})
