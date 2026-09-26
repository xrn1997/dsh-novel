import { describe, expect, it } from 'vitest'
import { classify } from '../../src/services/errors.js'
import type { ErrorCategory } from '../../src/services/errors.js'
import { ChapterNotFoundError, DecodeError, FetchError, InvalidRequestError, LocalNotMountedError, RuleMissingError, SourceNotFoundError } from '../../src/services/errors.js'
import { JsSandboxError, RuleEvalError, UnsupportedRuleError } from '../../src/engine/index.js'
import { LocalArtifactNotFoundError, LocalFileTooLargeError, LocalImportError } from '../../src/services/localbooks.js'
import { EpubImportError } from '../../src/services/epub/errors.js'
import { JobRunningError } from '../../src/services/import-job.js'
import type { JobState } from '../../src/shared/wire.js'
import { errorStatusOf } from '../../src/api/wire.js'
import { searchErrorCodeOf } from '../../src/services/search-face.js'

/**
 * 错误分类学表测试（扩四类目）：
 * 「类 → 类目 → 两投影（HTTP 状态 / wire 错误码）」的完整映射钉在一张表上——
 * 加一个错误类或改一条映射，这张表先红，而不是靠两个 destination 模块各自的记忆。
 * LocalImportError 不再自带 status（错误体携带 HTTP 码是被删过的模式），
 * JobRunningError 的 409 特判包装、本地书面的路由侧 catch 全部收进这张表。
 */

const L = { facet: 'toc' as const, segmentIndex: 0, segmentRaw: 'r' }

const RUNNING_JOB: JobState = {
  id: 'j', kind: 'import', phase: 'running', total: 0, done: 0,
  counts: { ok: 0, failed: 0, dupSkipped: 0, replaced: 0 },
  issues: [], fileErrors: [], startedAt: 0,
}

/** 表：实例 → 类目 → (HTTP 状态, HTTP code, ProbeErrorCode) */
const TABLE: Array<[unknown, ErrorCategory, number, string, string]> = [
  [new UnsupportedRuleError('x', L), 'rule-eval', 422, 'UnsupportedRuleError', 'UnsupportedRuleError'],
  [new RuleEvalError('x', { ...L, hits: 0 }), 'rule-eval', 422, 'RuleEvalError', 'RuleEvalError'],
  [new JsSandboxError('x', { ...L, script: 's' }), 'rule-eval', 422, 'JsSandboxError', 'JsSandboxError'],
  [new RuleMissingError('content', 'ruleContent', '缺正文规则'), 'rule-missing', 422, 'RuleMissing', 'RuleMissing'],
  [new FetchError('boom', { url: 'https://a' }), 'fetch', 502, 'FetchError', 'FetchError'],
  [new DecodeError('bad', { url: 'https://a', charset: 'gbk-x' }), 'fetch', 502, 'DecodeError', 'DecodeError'],
  [new SourceNotFoundError('s1'), 'not-found', 404, 'NotFound', 'Error'],
  [new ChapterNotFoundError(9, 42), 'not-found', 404, 'NotFound', 'Error'],
  // 值域错（非空 / 非负整数 / 比例在 [0,1]）：门住门面动词，两个调用面（HTTP、agent 工具）共用
  [new InvalidRequestError('加书需带非空 sourceId'), 'bad-request', 400, 'BadRequest', 'Error'],
  // 新收三类目（此前：LocalImportError 自带 status / JobRunningError 409 特判包装 / 本地未挂载靠路由 catch）
  [new LocalImportError('文件为空'), 'local-import', 400, 'BadRequest', 'Error'],
  [new LocalFileTooLargeError('文件超限'), 'local-too-large', 413, 'PayloadTooLarge', 'Error'],
  [new LocalNotMountedError(), 'unavailable', 503, 'Unavailable', 'Error'],
  [new JobRunningError(RUNNING_JOB), 'job-running', 409, 'JobRunning', 'Error'],
  // EPUB 导入失败并入既有 local-import 类目（不新增类目）：解析失败与 TXT 导入失败同一出口
  [new EpubImportError('EPUB 归档缺 mimetype 条目'), 'local-import', 400, 'BadRequest', 'Error'],
  // 本地产物缺席（书/文档/资源查不到）归既有 not-found 类目 → 404：与 ChapterNotFoundError 同一读数
  [new LocalArtifactNotFoundError('本地书不存在: local:x'), 'not-found', 404, 'NotFound', 'Error'],
  [new Error('惊喜'), 'other', 500, 'InternalError', 'Error'],
  // 分类权在类型上不在文案上：裸 Error 写同样的中文句子不改类目
  [new Error('源不存在: s1'), 'other', 500, 'InternalError', 'Error'],
]

describe('错误分类学表（classify → 双投影）', () => {
  it('每个错误类：类目 + HTTP 状态/code + ProbeErrorCode 三投影逐一钉死', () => {
    for (const [e, category, status, httpCode, probeCode] of TABLE) {
      const label = e instanceof Error ? e.constructor.name : String(e)
      expect(classify(e), `${label} 类目`).toBe(category)
      const { status: s, body } = errorStatusOf(e)
      expect(s, `${label} HTTP 状态`).toBe(status)
      expect(body.code, `${label} HTTP code`).toBe(httpCode)
      expect(searchErrorCodeOf(e), `${label} ProbeErrorCode`).toBe(probeCode)
    }
  })

  it('引擎错误的 segment 只在 HTTP 投影出现（probe 面不带段定位——wire code 就是段级定位的替代）', () => {
    const e = new RuleEvalError('x', { facet: 'content', segmentIndex: 3, segmentRaw: '@css:#c', hits: 0 })
    expect(errorStatusOf(e).body.segment).toEqual({ facet: 'content', segmentIndex: 3, segmentRaw: '@css:#c' })
    expect(searchErrorCodeOf(e)).toBe('RuleEvalError')   // 无 segment 概念
  })

  it('表覆盖全部 ErrorCategory 成员（新类目忘了进表 → 这条红）', () => {
    const covered = new Set(TABLE.map(([, c]) => c))
    // satisfies Record<ErrorCategory, true>：给 ErrorCategory 加成员而不在此列出 → **编译期**报错
    // （此前是手写字面量数组，新类目加了它还是 9 项、用例照绿）
    const all = {
      'rule-eval': true, 'rule-missing': true, fetch: true, 'not-found': true, 'bad-request': true,
      'local-import': true, 'local-too-large': true, unavailable: true, 'job-running': true, other: true,
    } satisfies Record<ErrorCategory, true>
    expect([...covered].sort()).toEqual(Object.keys(all).sort())
  })
})
