import { normalizeSource } from './normalize.js'
import type { NormalizeIssue } from './normalize.js'
import type { SourceRegistry } from './sources.js'
import type { NovelSource } from './types.js'

/**
 * 源入库（intake）：「书源进入系统」规则的唯一实现——
 * normalize → 批内去重（留首条）→ 按址去重（CONTEXT.md 入库规则：同 baseUrl 只留一条，
 * 已有 verified 优先保留；无可用者 → 新条替换 preferred，复用旧 id，清同键脏数据）。
 *
 * 此前这套规则只住在后台导入任务（import-job.runImport）里，同步 importOne（工具面）
 * 缺去重——同一 baseUrl 可重复入库，入库规则半套。现在两条调用路（同步 / 任务）都只是调用方。
 * 批 = 一个 SourceIntake 实例的生命周期：库内快照在构造时冻结，批内新键实时并入。
 *
 * 现状真相与口径：docs/design/services.md。
 */

/** 去重键：trim + 去尾部斜杠——不改大小写（站点地址区分路径大小写，魔改会误判） */
export function dedupKey(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

/** 入库裁决（唯一判定输出）：调用方（任务计数 / 工具投影）只做呈现映射，不再各自判去重 */
export type IntakeDecision =
  | { kind: 'failed'; name: string; missing: NormalizeIssue[]; warnings: NormalizeIssue[] }
  | { kind: 'added'; source: NovelSource; warnings: NormalizeIssue[] }
  | { kind: 'replaced'; source: NovelSource; clearedRest: number; warnings: NormalizeIssue[] }
  | { kind: 'skipped'; reason: 'batch' | 'verified'; name: string; existing: NovelSource | null; warnings: NormalizeIssue[] }

export class SourceIntake {
  /** 地址索引快照：批开始时的库内容（O(1) 查重；批内新键实时并入） */
  private readonly byKey = new Map<string, NovelSource[]>()
  /** 批内已落键：批内重复留首条（不与「库内已有」的替换语义混用） */
  private readonly batchKeys = new Set<string>()

  constructor(private readonly registry: SourceRegistry) {
    for (const s of registry.list()) {
      const k = dedupKey(s.baseUrl)
      const arr = this.byKey.get(k)
      if (arr === undefined) this.byKey.set(k, [s])
      else arr.push(s)
    }
  }

  /** 单条入库：裁决 + 落库一步完成（failed/skipped 不动库；added/replaced 经 registry.edit 合并落盘） */
  async intake(raw: unknown): Promise<IntakeDecision> {
    const result = normalizeSource(raw)
    const source = result.source
    if (!result.ok || source === undefined) {
      return { kind: 'failed', name: rawName(raw), missing: result.missing, warnings: result.warnings }
    }
    const name = source.name
    const key = dedupKey(source.baseUrl)
    if (this.batchKeys.has(key)) {
      return { kind: 'skipped', reason: 'batch', name, existing: this.byKey.get(key)?.[0] ?? null, warnings: result.warnings }
    }
    const existing = this.byKey.get(key)
    if (existing !== undefined && existing.length > 0) {
      const preferred = existing.find((s) => s.status === 'verified') ?? existing[0]
      if (preferred.status === 'verified') {
        this.batchKeys.add(key)                       // 与任务旧口径一致：verified 跳过也占批内键
        return { kind: 'skipped', reason: 'verified', name, existing: preferred, warnings: result.warnings }
      }
      // 无可用者：新条替换 preferred（新导出的规则通常更新），顺带清掉其余同键条目（历史脏数据收敛到一条）
      const rest = existing.filter((s) => s.id !== preferred.id).map((s) => s.id)
      const src = await this.registry.edit((tx) => {
        const replaced = tx.replace(preferred.id, result)
        if (rest.length > 0) tx.removeAll(rest)
        return replaced
      })
      this.byKey.set(key, [src])
      this.batchKeys.add(key)
      return { kind: 'replaced', source: src, clearedRest: rest.length, warnings: result.warnings }
    }
    const src = await this.registry.edit((tx) => tx.add(result))
    this.byKey.set(key, [src])
    this.batchKeys.add(key)
    return { kind: 'added', source: src, warnings: result.warnings }
  }
}

/** 归一化前的名称兜底（同步/任务两条路同一口径——此前两份手抄靠注释对齐） */
function rawName(item: unknown): string {
  const r = item as Record<string, unknown> | null
  return typeof r?.bookSourceName === 'string' && r.bookSourceName !== '' ? r.bookSourceName : '(未命名)'
}
