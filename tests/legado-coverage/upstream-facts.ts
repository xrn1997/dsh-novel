import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * **对面事实的仓内快照**：闸门要用的对面事实（源根路径集 / 7 个规则实体字段表 / java 宿主方法名集）
 * 开发阶段从对面 checkout 抽一次、冻进 `compat/upstream/snapshot.json`。原先是**现读对面 checkout**——
 * 上游下架或本机搬盘就红，而红与书源兼容性无关；借鉴参考仓是开发阶段的事，库里留的应当是能自己
 * 站住的证据，外部 checkout 只剩刷新快照一个用途。
 * 单一事实来源：抽取正则、实体清单都在这里，生成器与三个闸门共用（两边各写必漂）。
 */

/** 对面源根：主源与测试源都要认（测试源码根下才有分析器的复现测试） */
export const UPSTREAM_ROOTS = [
  'app/src/main/java/io/legado/app',
  'app/src/test/java/io/legado/app',
]

/** 对面的规则实体类：书源 JSON 里每个 rules 容器各对应一份 */
export const RULE_CLASSES = [
  'BookInfoRule', 'BookListRule', 'ExploreRule', 'SearchRule', 'TocRule', 'ContentRule', 'ReviewRule',
]

/** 规则实体在 main 源根下的目录 */
export const RULE_DIR = 'data/entities/rule'

/** `jsonDeserializer` 是 companion object 的解析器成员，不是书源字段 */
const NOT_A_FIELD = new Set(['jsonDeserializer'])

/** 从一个 Kotlin data class 里取字段名（`override var chapterList: String? = null` → chapterList） */
export function fieldsOf(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/^\s*(?:override\s+)?(?:var|val)\s+([A-Za-z][A-Za-z0-9]*)\s*:/gm)) {
    if (!NOT_A_FIELD.has(m[1])) out.push(m[1])
  }
  return out
}

/** 对面 java 宿主方法名（`help/JsExtensions.kt` 的四空格缩进 `fun name(`，含注解与修饰符前缀） */
export function javaMethodNames(src: string): string[] {
  const out = new Set<string>()
  for (const m of src.matchAll(/^\s{4}(?:@\w+(?:\([^)]*\))?\s+)*(?:open |override |suspend )*fun ([a-zA-Z][A-Za-z0-9]*)\s*\(/gm)) {
    out.add(m[1])
  }
  return [...out].sort()
}

/** 对面 java 宿主面的定义文件（相对源根） */
export const JS_HOST_FILE = 'help/JsExtensions.kt'

export interface UpstreamSnapshot {
  meta: {
    /** 快照来路：开发阶段抽取用的对面仓 */
    repo: string
    commit: string
    capturedAt: string
    roots: string[]
    /** 刷新方式（README 有同一条） */
    refresh: string
  }
  /** 两个源根下的**全部文件路径**（相对源根，正斜杠）——引用活性判据的分母 */
  paths: string[]
  /** 规则实体 → 字段名（字段面判据的分母） */
  ruleFields: Record<string, string[]>
  /** java 宿主方法名（js 面普查的分母） */
  javaMethods: string[]
}

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const SNAPSHOT_PATH = path.join(ROOT, 'compat', 'upstream', 'snapshot.json')

/** 读快照（**模块级缓存**——一次 pnpm test 里多个判据共用这一份，别各自重读 90KB）。
 *  缺失即抛：判据没有分母不许静默降级（沿用旧门对「仓不在场」的态度）。 */
let cachedSnapshot: UpstreamSnapshot | null = null
export function readSnapshot(): UpstreamSnapshot {
  if (cachedSnapshot !== null) return cachedSnapshot
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    throw new Error(
      `对面事实快照不在场：${SNAPSHOT_PATH}\n` +
      '  闸门的分母就在这份快照里（运行时**不**依赖任何外部 checkout）。\n' +
      '  开发阶段可用 `DSH_CAPTURE_UPSTREAM=1 pnpm vitest run tests/legado-coverage/capture-upstream-snapshot.test.ts` 重新生成，' +
      '生成时需要对面 checkout（DSH_LEGADO_REF 指路）。',
    )
  }
  const snap = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8')) as UpstreamSnapshot
  for (const k of ['paths', 'ruleFields', 'javaMethods'] as const) {
    if (!snap[k] || (Array.isArray(snap[k]) ? snap[k].length === 0 : Object.keys(snap[k]).length === 0)) {
      throw new Error(`快照的 ${k} 是空的：${SNAPSHOT_PATH}（分母读空即判据失效，不许静默放行）`)
    }
  }
  cachedSnapshot = snap
  return snap
}

/** 递归列出目录下所有**文件**的相对路径（正斜杠），不含目录本身 */
export function listFiles(absDir: string, relDir = ''): string[] {
  const out: string[] = []
  for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
    const rel = relDir === '' ? ent.name : `${relDir}/${ent.name}`
    if (ent.isDirectory()) out.push(...listFiles(path.join(absDir, ent.name), rel))
    else if (ent.isFile()) out.push(rel)
  }
  return out
}
