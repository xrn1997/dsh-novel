import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  ANCHOR_FREE_TEXT, CODE_ANCHORS, attributeError, classifyAudits, isEngineKind,
} from './content-audit-classify.js'

/**
 * 归因器的两条钉子：
 *  1. 每种成因各判各的（消息取自真机审计报告原文）；
 *  2. 凡是**本仓自己写下的**抛错锚点，必须在 src/ 里真实存在——锚点失配会让归因静默跑偏，
 *     把本仓缺口读成站点侧，等于给自己放水。
 */

const realMessages = {
  hostGapMissingMethod: {
    name: 'JsSandboxError',
    message: '[content#段0] 脚本编译/同步执行失败：result.select(...).remove is not a function（第2行）',
  },
  hostGapSegment: {
    name: 'UnsupportedRuleError',
    message: '[toc#段2] 无法识别的段类型（default 段白名单之外）（规则片段: "text下一页"）',
  },
  guardTocFallback: {
    name: 'RuleEvalError',
    message: "[toc#段0] 目录 URL 规则未取到任何章节地址（段 ruleChapterUrl: href；1 条全部回退目录页 https://x.com/a）",
  },
  guardAndroid: {
    name: 'JsSandboxError',
    message: '[detail#段2] 脚本编译/同步执行失败：java.webView 不支持：需要安卓宿主环境（第297行）',
  },
  siteSideNullMatch: {
    name: 'JsSandboxError',
    message: "[toc#段0] 脚本编译/同步执行失败：Cannot read properties of null (reading '1')（第2行）",
  },
  siteSideZeroHit: {
    name: 'RuleEvalError',
    message: '[content#段0] 正文规则没取到内容（命中 0 个）（规则片段: ".reader-contents@html"）',
  },
  networkInScript: {
    name: 'JsSandboxError',
    message: '[search#段-1] 脚本执行抛错：网络错误: https://x.com（TypeError: fetch failed）（第25行）',
  },
  plainFetch: { name: 'FetchError', message: '请求失败 400: https://x.com/api' },
  unclassified: { name: 'RuleEvalError', message: '[toc#段1] 从来没见过的措辞形态' },
}

describe('审计失败归因', () => {
  it('本仓宿主面/语法缺口 → host-gap', () => {
    expect(attributeError(realMessages.hostGapMissingMethod)).toBe('host-gap')
    expect(attributeError(realMessages.hostGapSegment)).toBe('host-gap')
  })

  it('刻意闸口（对面静默、我们明确失败）→ guard', () => {
    expect(attributeError(realMessages.guardTocFallback)).toBe('guard')
    expect(attributeError(realMessages.guardAndroid)).toBe('guard')
  })

  it('站点与脚本侧 → site-side', () => {
    expect(attributeError(realMessages.siteSideNullMatch)).toBe('site-side')
    expect(attributeError(realMessages.siteSideZeroHit)).toBe('site-side')
  })

  it('网络侧优先于脚本错（java.ajax 打不通不是本仓缺口）→ network', () => {
    expect(attributeError(realMessages.networkInScript)).toBe('network')
    expect(attributeError(realMessages.plainFetch)).toBe('network')
  })

  it('对不上任何锚点 → unattributed（不许静默归到轻松的那栏）', () => {
    expect(attributeError(realMessages.unclassified)).toBe('unattributed')
    // 没有错误对象可判也走这一栏：此前默认 site-side，等于把「没东西可归因」静默算成站点侧
    expect(attributeError(undefined)).toBe('unattributed')
  })

  it('residual 只算 host-gap + unattributed，且只统计引擎类 error name', () => {
    const r = classifyAudits([
      { name: 'A', stage: 'content-error', error: realMessages.hostGapMissingMethod },
      { name: 'B', stage: 'toc', error: realMessages.guardAndroid },
      { name: 'C', stage: 'toc', error: realMessages.siteSideZeroHit },
      { name: 'D', stage: 'toc', error: realMessages.plainFetch },
      { name: 'E', stage: 'ok' },
    ])
    expect(r.byAttribution).toEqual({
      'host-gap': 1, guard: 1, 'site-side': 1, network: 0, unattributed: 0,
    })
    expect(r.residual).toBe(1)
    // 明细只收引擎类：非引擎类（这里是 FetchError）不进清单，否则「目录 0 章」这类会混进 residual 视图
    expect(r.items.map((i) => i.name)).toEqual(['A', 'B', 'C'])
    expect(isEngineKind(realMessages.plainFetch)).toBe(false)
    expect(isEngineKind(realMessages.hostGapSegment)).toBe(true)
  })

  it('本仓抛错锚点逐条在 src/ 里真实存在（锚点失配＝归因静默跑偏）', () => {
    const root = path.resolve(process.cwd(), 'src')
    const texts: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name)
        if (entry.isDirectory()) { walk(p); continue }
        if (p.endsWith('.ts')) texts.push(fs.readFileSync(p, 'utf8'))
      }
    }
    walk(root)
    const all = texts.join('\n')
    const dead: string[] = []
    for (const anchors of Object.values(CODE_ANCHORS)) {
      for (const a of anchors) {
        if (ANCHOR_FREE_TEXT.some((skip) => a.startsWith(skip))) continue
        if (!all.includes(a)) dead.push(a)
      }
    }
    expect(dead, `这些锚点在 src/ 里找不到，归因会把对应失败读成别的成因：${dead.join(' / ')}`).toEqual([])
  })
})
