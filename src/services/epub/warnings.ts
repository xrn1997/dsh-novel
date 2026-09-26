import type { LocalImportWarning } from '../../shared/wire.js'

/**
 * 告警层：与「XHTML 转换」「资源验证」都不相干的一层，只放两样——同类告警的**合并器**与**码表**。
 *
 * 为什么单独一层（2026 评审记的耦合）：`EpubWarningLog` 原先住在 `documents.ts`，只做资源验证的
 * `resources.ts` 就得按类型回头看转换模块取日志形状；更糟的是三个码字面量在两个模块各抄了一份
 * （`epub-removed-active-content` / `epub-active-attribute` / `epub-css-attribute`）。码是**稳定
 * 标识**（服务层原样持久化、UI 按它分流、文档按它记账），抄两份等于让同一件事有两个名字。
 * 只收共享的这几个：各模块自用的码（导航降级、链接不可追、加密资源……）留在自己模块里，
 * 它们没有第二个消费者，搬来只是把 5 个文件绑进一次改动。
 */

/**
 * 每个键最多留几条**细节例子**：`list()` 只展示前三，留更多既没人读，也把 `add` 拖成 O(n²)——
 * 实测一部含三万条互不相同外链的正文（79 KB，远在各项字节预算内）会在这里同步阻塞 13 秒，
 * 而那期间宿主线程什么都不干。
 */
const MAX_DETAILS = 3

/**
 * 同类告警合并器：**同码 + 同资源 + 同动作**合并计数，细节（元素名/href/属性名）只留前三个当例子。
 *
 * 为什么必须合并：一部真实书的正文里 `style`/`on*` 属性可能成百上千处，一条一告警等于把告警面
 * 变成噪声（用户会学会忽略它）。合并后每类一条，处数写在开头——「我丢了什么」仍然看得见。
 *
 * 计数与例子**分开有界**：处数（`count`）按发生次数如实累加、不设上限；例子到 `MAX_DETAILS` 就不再
 * 收集（既不追加也不去重查找）。于是「有多少处」永远准确，而内存与耗时与内容规模无关。
 */
export class EpubWarningLog {
  private readonly entries = new Map<string, { code: string; resource: string | null; action: string; count: number; details: string[] }>()

  add(code: string, resource: string | null, action: string, detail?: string): void {
    const key = `${code}\u0000${resource ?? ''}\u0000${action}`
    const hit = this.entries.get(key)
    if (hit === undefined) {
      this.entries.set(key, { code, resource, action, count: 1, details: detail === undefined ? [] : [detail] })
      return
    }
    hit.count += 1
    if (detail === undefined || hit.details.length >= MAX_DETAILS) return
    if (!hit.details.includes(detail)) hit.details.push(detail)
  }

  list(): LocalImportWarning[] {
    return [...this.entries.values()].map((e) => ({
      code: e.code,
      resource: e.resource,
      message: e.count === 1
        ? (e.details.length === 0 ? e.action : `${e.action}：${e.details[0]}`)
        : `${e.count} 处：${e.action}${e.details.length === 0 ? '' : `（例：${e.details.slice(0, 3).join('、')}）`}`,
    }))
  }
}

/** 告警码（稳定标识，服务层原样持久化并展示）：用户看到 message，程序按 code 分流 */
export const WARN_REMOVED = 'epub-removed-active-content'
export const WARN_ACTIVE_ATTR = 'epub-active-attribute'
export const WARN_CSS_ATTR = 'epub-css-attribute'
export const WARN_INLINE_SVG = 'epub-removed-inline-svg'
